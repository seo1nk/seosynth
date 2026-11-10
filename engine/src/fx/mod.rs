//! Master effects: building blocks and the reorderable chain.

mod delay;
mod dist;
mod dynamics;
mod eq;
mod modulation;
mod reverb;

pub use delay::Delay;
pub use dist::Distortion;
pub use dynamics::Compressor;
pub use eq::Eq;
pub use modulation::{Chorus, Flanger, Hyper, Phaser};
pub use reverb::Reverb;

use crate::filter::{Filter, FilterParams, FilterType};
use crate::params::{self, fxfilter, ParamDef, FXFILTER_BASE, FX_BASES, NUM_FX};
use crate::util::{BLOCK, PI, TAU};

/// Effect ids, matching `params::FX_KEYS`.
pub mod id {
    pub const HYPER: usize = 0;
    pub const DIST: usize = 1;
    pub const FLANGER: usize = 2;
    pub const PHASER: usize = 3;
    pub const CHORUS: usize = 4;
    pub const DELAY: usize = 5;
    pub const COMP: usize = 6;
    pub const REVERB: usize = 7;
    pub const EQ: usize = 8;
    pub const FILTER: usize = 9;
}

/// Parameter access for one block of effect processing.
pub struct Ctx<'a> {
    /// Modulated, normalised parameter values.
    pub m: &'a [f32],
    pub defs: &'static [ParamDef],
    pub sr: f32,
    pub bpm: f32,
}

impl<'a> Ctx<'a> {
    /// Parameter value in real units.
    #[inline]
    pub fn v(&self, idx: usize) -> f32 {
        self.defs[idx].to_plain(self.m[idx])
    }
    #[inline]
    pub fn on(&self, idx: usize) -> bool {
        self.m[idx] >= 0.5
    }
    /// Length in seconds of a tempo division.
    pub fn division_seconds(&self, idx: usize) -> f32 {
        let d = (self.v(idx) as usize).min(params::DIVISION_BEATS.len() - 1);
        params::DIVISION_BEATS[d] * 60.0 / self.bpm.max(1.0)
    }
}

/// Wet/dry law for time-based effects: both signals are at full level at
/// 50%, so adding an echo or reverb does not duck the dry sound.
#[inline]
pub fn balance(mix: f32) -> (f32, f32) {
    let mix = mix.max(0.0).min(1.0);
    ((2.0 * (1.0 - mix)).min(1.0), (2.0 * mix).min(1.0))
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/// Circular delay buffer with a power-of-two length.
#[derive(Clone)]
pub struct DelayLine {
    buf: Vec<f32>,
    mask: usize,
    pos: usize,
}

impl DelayLine {
    pub fn new(min_len: usize) -> Self {
        let len = min_len.max(4).next_power_of_two();
        DelayLine { buf: vec![0.0; len], mask: len - 1, pos: 0 }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    pub fn clear(&mut self) {
        self.buf.iter_mut().for_each(|v| *v = 0.0);
    }

    #[inline]
    pub fn push(&mut self, x: f32) {
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) & self.mask;
    }

    /// Sample pushed `d` samples ago (`d >= 1`), linearly interpolated.
    #[inline]
    pub fn read(&self, d: f32) -> f32 {
        let d = d.max(1.0).min((self.mask - 1) as f32);
        let di = d as usize;
        let fr = d - di as f32;
        let i = self.pos + self.buf.len() - di;
        let a = self.buf[i & self.mask];
        let b = self.buf[(i - 1) & self.mask];
        a + (b - a) * fr
    }

    /// Sample pushed `d` samples ago, no interpolation.
    #[inline]
    pub fn read_int(&self, d: usize) -> f32 {
        let d = d.max(1).min(self.mask);
        self.buf[(self.pos + self.buf.len() - d) & self.mask]
    }
}

/// Second-order filter section (RBJ cookbook designs).
#[derive(Clone, Copy, Default)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn set(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        let inv = 1.0 / a0;
        self.b0 = b0 * inv;
        self.b1 = b1 * inv;
        self.b2 = b2 * inv;
        self.a1 = a1 * inv;
        self.a2 = a2 * inv;
    }

    fn omega(freq: f32, sr: f32) -> (f32, f32) {
        let w = TAU * freq.max(10.0).min(sr * 0.45) / sr;
        (w.sin(), w.cos())
    }

    pub fn lowpass(&mut self, freq: f32, q: f32, sr: f32) {
        let (s, c) = Self::omega(freq, sr);
        let al = s / (2.0 * q);
        self.set((1.0 - c) * 0.5, 1.0 - c, (1.0 - c) * 0.5, 1.0 + al, -2.0 * c, 1.0 - al);
    }

    pub fn highpass(&mut self, freq: f32, q: f32, sr: f32) {
        let (s, c) = Self::omega(freq, sr);
        let al = s / (2.0 * q);
        self.set((1.0 + c) * 0.5, -(1.0 + c), (1.0 + c) * 0.5, 1.0 + al, -2.0 * c, 1.0 - al);
    }

    pub fn bandpass(&mut self, freq: f32, q: f32, sr: f32) {
        let (s, c) = Self::omega(freq, sr);
        let al = s / (2.0 * q);
        self.set(al, 0.0, -al, 1.0 + al, -2.0 * c, 1.0 - al);
    }

    pub fn peak(&mut self, freq: f32, q: f32, gain_db: f32, sr: f32) {
        let (s, c) = Self::omega(freq, sr);
        let a = (10.0f32).powf(gain_db / 40.0);
        let al = s / (2.0 * q);
        self.set(1.0 + al * a, -2.0 * c, 1.0 - al * a, 1.0 + al / a, -2.0 * c, 1.0 - al / a);
    }

    pub fn low_shelf(&mut self, freq: f32, q: f32, gain_db: f32, sr: f32) {
        let (s, c) = Self::omega(freq, sr);
        let a = (10.0f32).powf(gain_db / 40.0);
        let al = s / (2.0 * q);
        let k = 2.0 * a.sqrt() * al;
        self.set(
            a * ((a + 1.0) - (a - 1.0) * c + k),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - k),
            (a + 1.0) + (a - 1.0) * c + k,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - k,
        );
    }

    pub fn high_shelf(&mut self, freq: f32, q: f32, gain_db: f32, sr: f32) {
        let (s, c) = Self::omega(freq, sr);
        let a = (10.0f32).powf(gain_db / 40.0);
        let al = s / (2.0 * q);
        let k = 2.0 * a.sqrt() * al;
        self.set(
            a * ((a + 1.0) + (a - 1.0) * c + k),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - k),
            (a + 1.0) - (a - 1.0) * c + k,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - k,
        );
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn clear(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    pub fn flush(&mut self) {
        self.z1 = crate::util::sanitize(self.z1);
        self.z2 = crate::util::sanitize(self.z2);
    }
}

/// One-pole low-pass coefficient for a cutoff frequency.
#[inline]
pub fn one_pole(freq: f32, sr: f32) -> f32 {
    1.0 - (-TAU * freq.max(1.0).min(sr * 0.49) / sr).exp()
}

/// First-order all-pass coefficient for a centre frequency.
#[inline]
pub fn allpass_coeff(freq: f32, sr: f32) -> f32 {
    let g = (PI * freq.max(10.0).min(sr * 0.45) / sr).tan();
    (g - 1.0) / (g + 1.0)
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

pub struct FxChain {
    hyper: Hyper,
    dist: Distortion,
    flanger: Flanger,
    phaser: Phaser,
    chorus: Chorus,
    delay: Delay,
    comp: Compressor,
    reverb: Reverb,
    eq: Eq,
    filter: Filter,
    was_on: [bool; NUM_FX],
}

impl FxChain {
    pub fn new(sr: f32) -> Self {
        FxChain {
            hyper: Hyper::new(sr),
            dist: Distortion::new(),
            flanger: Flanger::new(sr),
            phaser: Phaser::new(),
            chorus: Chorus::new(sr),
            delay: Delay::new(sr),
            comp: Compressor::new(),
            reverb: Reverb::new(sr),
            eq: Eq::new(),
            filter: Filter::default(),
            was_on: [false; NUM_FX],
        }
    }

    fn clear(&mut self, fx: usize) {
        match fx {
            id::HYPER => self.hyper.clear(),
            id::DIST => self.dist.clear(),
            id::FLANGER => self.flanger.clear(),
            id::PHASER => self.phaser.clear(),
            id::CHORUS => self.chorus.clear(),
            id::DELAY => self.delay.clear(),
            id::COMP => self.comp.clear(),
            id::REVERB => self.reverb.clear(),
            id::EQ => self.eq.clear(),
            _ => self.filter.reset(),
        }
    }

    /// Runs the enabled effects in `order`. After each unit (enabled or
    /// not) the mono signal is copied to `taps[unit]` for the UI meters.
    pub fn process(&mut self, order: &[u8; NUM_FX], c: &Ctx, l: &mut [f32], r: &mut [f32], taps: &mut [[f32; BLOCK]; NUM_FX]) {
        let n = l.len();
        for &fx in order.iter() {
            let fx = (fx as usize).min(NUM_FX - 1);
            let on = c.on(FX_BASES[fx]);
            if on && !self.was_on[fx] {
                // Switched on: start from silence, not from a stale tail.
                self.clear(fx);
            }
            self.was_on[fx] = on;
            if on {
                match fx {
                    id::HYPER => self.hyper.process(c, l, r),
                    id::DIST => self.dist.process(c, l, r),
                    id::FLANGER => self.flanger.process(c, l, r),
                    id::PHASER => self.phaser.process(c, l, r),
                    id::CHORUS => self.chorus.process(c, l, r),
                    id::DELAY => self.delay.process(c, l, r),
                    id::COMP => self.comp.process(c, l, r),
                    id::REVERB => self.reverb.process(c, l, r),
                    id::EQ => self.eq.process(c, l, r),
                    _ => {
                        let i = |p: usize| FXFILTER_BASE + p;
                        let p = FilterParams {
                            ty: FilterType::from_index(c.v(i(fxfilter::TYPE)) as usize),
                            cutoff: c.v(i(fxfilter::CUTOFF)),
                            res: c.v(i(fxfilter::RES)),
                            drive: c.v(i(fxfilter::DRIVE)),
                            var: c.v(i(fxfilter::VAR)),
                            mix: c.v(i(fxfilter::MIX)),
                            stereo: 0.0,
                            sr: c.sr,
                        };
                        self.filter.process(&p, l, r);
                    }
                }
            }
            for s in 0..n {
                taps[fx][s] = (l[s] + r[s]) * 0.5;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{defs, NUM_PARAMS};
    use crate::util::Rng;

    #[test]
    fn delay_line_reads_back_exact_and_interpolated() {
        let mut d = DelayLine::new(16);
        for i in 0..10 {
            d.push(i as f32);
        }
        assert_eq!(d.read(1.0), 9.0);
        assert_eq!(d.read(4.0), 6.0);
        assert!((d.read(2.5) - 7.5).abs() < 1e-6);
        assert_eq!(d.read_int(3), 7.0);
    }

    #[test]
    fn biquad_lowpass_passes_dc_and_blocks_highs() {
        let mut b = Biquad::default();
        b.lowpass(1000.0, 0.707, 48_000.0);
        let mut y = 0.0;
        for _ in 0..2000 {
            y = b.tick(1.0);
        }
        assert!((y - 1.0).abs() < 1e-3);
        b.clear();
        let mut peak = 0.0f32;
        for i in 0..2000 {
            let x = if i % 2 == 0 { 1.0 } else { -1.0 }; // Nyquist
            let y = b.tick(x);
            if i > 200 {
                peak = peak.max(y.abs());
            }
        }
        assert!(peak < 1e-3);
    }

    /// Every effect, alone and all together, in several orders, fed with
    /// noise bursts: output must stay finite and reasonably bounded.
    #[test]
    fn effects_are_stable() {
        let d = defs();
        let sr = 48_000.0;
        let mut rng = Rng::new(11);
        let orders: [[u8; NUM_FX]; 2] = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [9, 7, 5, 6, 1, 0, 3, 2, 4, 8]];
        for case in 0..=NUM_FX {
            for order in orders.iter() {
                let mut m: Vec<f32> = d.iter().map(|p| p.default_norm()).collect();
                assert_eq!(m.len(), NUM_PARAMS);
                for fx in 0..NUM_FX {
                    if case == NUM_FX || case == fx {
                        m[FX_BASES[fx]] = 1.0;
                    }
                }
                let mut chain = FxChain::new(sr);
                let mut taps = [[0.0f32; BLOCK]; NUM_FX];
                let mut peak = 0.0f32;
                let mut energy = 0.0f64;
                for b in 0..1500 {
                    let mut l = [0.0f32; BLOCK];
                    let mut r = [0.0f32; BLOCK];
                    if b % 300 < 100 {
                        for s in 0..BLOCK {
                            l[s] = rng.bipolar() * 0.5;
                            r[s] = rng.bipolar() * 0.5;
                        }
                    }
                    let c = Ctx { m: &m, defs: d, sr, bpm: 120.0 };
                    chain.process(order, &c, &mut l, &mut r, &mut taps);
                    for v in l.iter().chain(r.iter()) {
                        assert!(v.is_finite(), "case {case}");
                        peak = peak.max(v.abs());
                        energy += (*v as f64).powi(2);
                    }
                }
                assert!(peak < 8.0, "case {case} peak {peak}");
                assert!(energy > 1.0, "case {case} went silent");
            }
        }
    }
}
