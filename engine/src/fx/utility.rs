//! Frequency shifter and utility (gain, pan, width, mono bass).

use super::{Biquad, Ctx};
use crate::params::{freqshift, utility, FREQSHIFT_BASE, UTILITY_BASE};
use crate::util::{sanitize, TAU};

/// Second-order all-pass in the form y[n] = c (x[n] + y[n-2]) - x[n-2].
#[derive(Clone, Copy, Default)]
struct Allpass {
    c: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Allpass {
    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let y = self.c * (x + self.y2) - self.x2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }

    fn flush(&mut self) {
        self.y1 = sanitize(self.y1);
        self.y2 = sanitize(self.y2);
    }
}

/// Two all-pass chains whose outputs stay 90 degrees apart from about
/// 20 Hz to 20 kHz at 44.1 kHz (Olli Niemitalo's design): the real and
/// imaginary parts of the analytic signal.
#[derive(Clone, Copy)]
struct Hilbert {
    a: [Allpass; 4],
    b: [Allpass; 4],
    /// Chain A runs one sample late.
    a_last: f32,
}

impl Hilbert {
    fn new() -> Self {
        const A: [f32; 4] = [0.692_387_8, 0.936_065_43, 0.988_229_5, 0.998_748_8];
        const B: [f32; 4] = [0.402_192_1, 0.856_171_1, 0.972_290_95, 0.995_288_5];
        let chain = |k: [f32; 4]| k.map(|v| Allpass { c: v * v, ..Allpass::default() });
        Hilbert { a: chain(A), b: chain(B), a_last: 0.0 }
    }

    #[inline]
    fn tick(&mut self, x: f32) -> (f32, f32) {
        let a = self.a.iter_mut().fold(x, |v, f| f.tick(v));
        let b = self.b.iter_mut().fold(x, |v, f| f.tick(v));
        let re = self.a_last;
        self.a_last = a;
        (re, b)
    }

    fn flush(&mut self) {
        self.a.iter_mut().chain(self.b.iter_mut()).for_each(|f| f.flush());
        self.a_last = sanitize(self.a_last);
    }
}

/// Moves every frequency of the sound up or down by the same number of
/// hertz, which makes harmonic sounds clangy and slightly detuned ones
/// beat. The right channel can shift the other way for width.
pub struct FreqShifter {
    hilbert: [Hilbert; 2],
    /// Rotating oscillator (cos, sin) per channel.
    osc: [(f32, f32); 2],
    last: [f32; 2],
}

impl FreqShifter {
    pub fn new() -> Self {
        FreqShifter { hilbert: [Hilbert::new(); 2], osc: [(1.0, 0.0); 2], last: [0.0; 2] }
    }

    pub fn clear(&mut self) {
        *self = FreqShifter::new();
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| FREQSHIFT_BASE + p;
        let shift = c.v(i(freqshift::SHIFT));
        let stereo = c.v(i(freqshift::STEREO));
        let fb = c.v(i(freqshift::FEEDBACK));
        let mix = c.v(i(freqshift::MIX));
        let shifts = [shift, shift * (1.0 - 2.0 * stereo)];
        for (ch, buf) in [l, r].into_iter().enumerate() {
            let w = TAU * shifts[ch] / c.sr;
            let (rc, rs) = (w.cos(), w.sin());
            let (mut oc, mut os) = self.osc[ch];
            let h = &mut self.hilbert[ch];
            let mut last = self.last[ch];
            for x in buf.iter_mut() {
                let (re, im) = h.tick(*x + fb * last);
                // Chain B leads chain A by 90 degrees, so this sum moves up.
                let wet = re * oc + im * os;
                last = wet;
                *x += (wet - *x) * mix;
                let n = oc * rc - os * rs;
                os = oc * rs + os * rc;
                oc = n;
            }
            // Keep the oscillator on the unit circle.
            let g = 1.0 / (oc * oc + os * os).sqrt();
            self.osc[ch] = if g.is_finite() { (oc * g, os * g) } else { (1.0, 0.0) };
            self.last[ch] = sanitize(last);
            h.flush();
        }
    }
}

impl Default for FreqShifter {
    fn default() -> Self {
        Self::new()
    }
}

/// Level, balance and stereo width, and keeping the lows in the centre.
pub struct Utility {
    /// High-passes the side signal when the bass is kept mono.
    side_hp: [Biquad; 2],
}

impl Utility {
    pub fn new() -> Self {
        Utility { side_hp: [Biquad::default(); 2] }
    }

    pub fn clear(&mut self) {
        self.side_hp.iter_mut().for_each(|f| f.clear());
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| UTILITY_BASE + p;
        let gain = (10.0f32).powf(c.v(i(utility::GAIN)) / 20.0);
        let pan = c.v(i(utility::PAN));
        let width = c.v(i(utility::WIDTH));
        let mono_bass = c.on(i(utility::MONO_BASS));
        if mono_bass {
            let f = c.v(i(utility::MONO_FREQ));
            self.side_hp.iter_mut().for_each(|b| b.highpass(f, 0.707_106_77, c.sr));
        }
        // Balance: the centre stays at full level, the far side fades out.
        let gl = gain * (1.0 - pan).min(1.0);
        let gr = gain * (1.0 + pan).min(1.0);
        for s in 0..l.len() {
            let mid = 0.5 * (l[s] + r[s]);
            let mut side = 0.5 * (l[s] - r[s]);
            if mono_bass {
                let [a, b] = &mut self.side_hp;
                side = b.tick(a.tick(side));
            }
            side *= width;
            l[s] = (mid + side) * gl;
            r[s] = (mid - side) * gr;
        }
        self.side_hp.iter_mut().for_each(|f| f.flush());
    }
}

impl Default for Utility {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{defs, unit_on, NUM_PARAMS};

    const SR: f32 = 48_000.0;

    fn ctx(m: &[f32]) -> Ctx<'_> {
        Ctx { m, defs: defs(), sr: SR, bpm: 120.0, shift: 0 }
    }

    fn set(m: &mut [f32], idx: usize, plain: f32) {
        m[idx] = defs()[idx].to_norm(plain);
    }

    /// Level of `freq` in `x` (Goertzel).
    fn level(x: &[f32], freq: f32) -> f32 {
        let w = TAU * freq / SR;
        let k = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &v in x {
            let s = v + k * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        (s1 * s1 + s2 * s2 - k * s1 * s2).sqrt() * 2.0 / x.len() as f32
    }

    fn shifted(shift: f32, stereo: f32) -> (Vec<f32>, Vec<f32>) {
        let mut m: Vec<f32> = defs().iter().map(|d| d.default_norm()).collect();
        assert_eq!(m.len(), NUM_PARAMS);
        m[unit_on(crate::fx::id::FREQSHIFT)] = 1.0;
        set(&mut m, FREQSHIFT_BASE + freqshift::SHIFT, shift);
        set(&mut m, FREQSHIFT_BASE + freqshift::STEREO, stereo);
        let mut fx = FreqShifter::new();
        let (mut outl, mut outr) = (Vec::new(), Vec::new());
        let mut n = 0usize;
        for _ in 0..600 {
            let mut l: Vec<f32> = (0..32).map(|k| (TAU * 1000.0 * (n + k) as f32 / SR).sin() * 0.5).collect();
            let mut r = l.clone();
            n += 32;
            fx.process(&ctx(&m), &mut l, &mut r);
            outl.extend(l);
            outr.extend(r);
        }
        (outl[4800..].to_vec(), outr[4800..].to_vec())
    }

    #[test]
    fn the_shifter_moves_a_tone_by_hertz() {
        let (l, r) = shifted(200.0, 0.0);
        assert!(level(&l, 1200.0) > 0.45, "up: {}", level(&l, 1200.0));
        assert!(level(&l, 800.0) < 0.02, "mirror image: {}", level(&l, 800.0));
        assert!(level(&l, 1000.0) < 0.02, "original: {}", level(&l, 1000.0));
        assert!(level(&r, 1200.0) > 0.45);
        let (l, r) = shifted(-300.0, 1.0);
        assert!(level(&l, 700.0) > 0.45, "down: {}", level(&l, 700.0));
        assert!(level(&r, 1300.0) > 0.45, "right goes the other way: {}", level(&r, 1300.0));
    }

    #[test]
    fn the_shift_scale_is_fine_near_zero() {
        let d = &defs()[FREQSHIFT_BASE + freqshift::SHIFT];
        assert_eq!(d.to_plain(0.5), 0.0);
        assert!((d.to_plain(0.75) - 250.0).abs() < 1e-2);
        assert!((d.to_plain(0.0) + 2000.0).abs() < 1e-2);
        for p in [-1500.0, -3.0, 0.0, 7.5, 640.0] {
            assert!((d.to_plain(d.to_norm(p)) - p).abs() < 1e-2 * (1.0 + p.abs()), "{p}");
        }
    }

    #[test]
    fn utility_pans_narrows_and_keeps_bass_mono() {
        let mut m: Vec<f32> = defs().iter().map(|d| d.default_norm()).collect();
        let run = |m: &[f32], f: f32| {
            let mut u = Utility::new();
            let mut out = (Vec::new(), Vec::new());
            for b in 0..300 {
                // Fully one-sided: all of it in the left channel.
                let mut l: Vec<f32> = (0..32).map(|k| (TAU * f * (b * 32 + k) as f32 / SR).sin()).collect();
                let mut r = vec![0.0; 32];
                u.process(&ctx(m), &mut l, &mut r);
                out.0.extend(l);
                out.1.extend(r);
            }
            (level(&out.0[4800..], f), level(&out.1[4800..], f))
        };
        let (l, r) = run(&m, 1000.0);
        assert!((l - 1.0).abs() < 0.01 && r < 0.01, "untouched: {l} {r}");
        set(&mut m, UTILITY_BASE + utility::WIDTH, 0.0);
        let (l, r) = run(&m, 1000.0);
        assert!((l - 0.5).abs() < 0.01 && (r - 0.5).abs() < 0.01, "mono: {l} {r}");
        set(&mut m, UTILITY_BASE + utility::WIDTH, 1.0);
        set(&mut m, UTILITY_BASE + utility::MONO_BASS, 1.0);
        set(&mut m, UTILITY_BASE + utility::MONO_FREQ, 200.0);
        let (l, r) = run(&m, 50.0);
        assert!((l - r).abs() < 0.05, "bass in the middle: {l} {r}");
        let (l, r) = run(&m, 3000.0);
        assert!(l > 0.9 && r < 0.1, "highs keep their place: {l} {r}");
        set(&mut m, UTILITY_BASE + utility::PAN, 1.0);
        set(&mut m, UTILITY_BASE + utility::GAIN, 6.0);
        let (l, _) = run(&m, 3000.0);
        assert!(l < 0.01, "panned right: {l}");
    }
}
