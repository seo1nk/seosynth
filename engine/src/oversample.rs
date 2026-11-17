//! Bringing oversampled voices back to the output rate.
//!
//! At 2x or 4x the voices run at a multiple of the output rate, so the
//! harmonics that warps, unison detune and filter drive push past the
//! output's Nyquist frequency are kept out of the audible band instead of
//! folding back into it. Each halving of the rate is a half-band low-pass
//! (a windowed sinc whose every other tap is zero) followed by keeping every
//! second sample.

use crate::util::PI;

/// Taps of the half-band filter: odd, so it has a centre tap.
const TAPS: usize = 63;
const CENTRE: usize = TAPS / 2;

/// The non-zero side taps (every other one is zero), from the centre out.
fn halfband() -> [f32; CENTRE / 2 + 1] {
    // Kaiser window: beta 8 keeps the stopband about 80 dB down.
    fn bessel_i0(x: f64) -> f64 {
        let (mut sum, mut term) = (1.0, 1.0);
        for k in 1..50 {
            term *= (x / 2.0 / k as f64) * (x / 2.0 / k as f64);
            sum += term;
        }
        sum
    }
    let beta = 8.0;
    let mut out = [0.0f32; CENTRE / 2 + 1];
    for (j, c) in out.iter_mut().enumerate() {
        // Odd distances from the centre: 1, 3, 5...
        let k = 2 * j + 1;
        let x = k as f64;
        let sinc = (PI as f64 * x / 2.0).sin() / (PI as f64 * x);
        let r = x / CENTRE as f64;
        let w = bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / bessel_i0(beta);
        *c = (sinc * w) as f32;
    }
    out
}

/// One halving of the rate for one channel.
#[derive(Clone)]
struct Halver {
    coeffs: [f32; CENTRE / 2 + 1],
    /// The last `TAPS` input samples, twice over so a window is always one
    /// contiguous slice.
    hist: [f32; 2 * TAPS],
    pos: usize,
}

impl Halver {
    fn new() -> Self {
        Halver { coeffs: halfband(), hist: [0.0; 2 * TAPS], pos: 0 }
    }

    #[inline]
    fn push(&mut self, x: f32) {
        self.hist[self.pos] = x;
        self.hist[self.pos + TAPS] = x;
        self.pos = (self.pos + 1) % TAPS;
    }

    /// Takes two input samples and gives one output sample.
    #[inline]
    fn tick(&mut self, a: f32, b: f32) -> f32 {
        self.push(a);
        self.push(b);
        // The window, oldest first, ending at the newest sample.
        let w = &self.hist[self.pos..self.pos + TAPS];
        let mut y = 0.5 * w[CENTRE];
        for (j, c) in self.coeffs.iter().enumerate() {
            let d = 2 * j + 1;
            y += c * (w[CENTRE - d] + w[CENTRE + d]);
        }
        y
    }

    fn clear(&mut self) {
        self.hist = [0.0; 2 * TAPS];
        self.pos = 0;
    }
}

/// Stereo decimation by 1, 2 or 4.
pub struct Decimator {
    stages: [[Halver; 2]; 2],
}

impl Default for Decimator {
    fn default() -> Self {
        Self::new()
    }
}

impl Decimator {
    pub fn new() -> Self {
        Decimator { stages: core::array::from_fn(|_| [Halver::new(), Halver::new()]) }
    }

    pub fn clear(&mut self) {
        self.stages.iter_mut().flatten().for_each(|h| h.clear());
    }

    /// Reduces `input` (`factor` times as long as `out`) to `out`, in place
    /// of the first `out.len()` samples of `input`. `ch` is 0 or 1.
    pub fn process(&mut self, ch: usize, factor: usize, input: &mut [f32], out_len: usize) {
        let mut len = out_len * factor;
        let mut stage = 0;
        let mut f = factor;
        while f > 1 {
            let h = &mut self.stages[stage][ch];
            for i in 0..len / 2 {
                input[i] = h.tick(input[2 * i], input[2 * i + 1]);
            }
            len /= 2;
            f /= 2;
            stage += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::TAU;

    fn level(x: &[f32], freq: f32, sr: f32) -> f32 {
        let w = TAU * freq / sr;
        let k = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &v in x {
            let s = v + k * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        (s1 * s1 + s2 * s2 - k * s1 * s2).sqrt() * 2.0 / x.len() as f32
    }

    /// A tone at `freq` through decimation by `factor` from 48 kHz * factor.
    fn through(factor: usize, freq: f32) -> Vec<f32> {
        let sr = 48_000.0 * factor as f32;
        let mut d = Decimator::new();
        let mut out = Vec::new();
        let mut n = 0usize;
        for _ in 0..400 {
            let mut buf: Vec<f32> = (0..32 * factor).map(|k| (TAU * freq * (n + k) as f32 / sr).sin()).collect();
            n += 32 * factor;
            d.process(0, factor, &mut buf, 32);
            out.extend_from_slice(&buf[..32]);
        }
        out.split_off(2000)
    }

    #[test]
    fn audible_tones_pass_and_ultrasonic_ones_are_removed() {
        for factor in [2, 4] {
            for f in [100.0, 1000.0, 15_000.0] {
                let l = level(&through(factor, f), f, 48_000.0);
                assert!((l - 1.0).abs() < 0.01, "{factor}x {f} Hz: {l}");
            }
            // Would fold back to 48000 - 30000 = 18 kHz without the filter.
            let x = through(factor, 30_000.0);
            let folded = level(&x, 18_000.0, 48_000.0);
            assert!(folded < 1e-3, "{factor}x: {folded}");
        }
    }

    #[test]
    fn the_filter_has_unity_gain_at_dc() {
        let c = halfband();
        let sum = 0.5 + 2.0 * c.iter().sum::<f32>();
        assert!((sum - 1.0).abs() < 1e-3, "{sum}");
    }
}
