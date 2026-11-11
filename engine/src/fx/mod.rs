//! Master effects: building blocks, and the chain that runs them: units in
//! any order, with one optional fork into two parallel lanes.

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
use crate::params::{self, fxfilter, split, unit_on, unit_shift, ParamDef, FXFILTER_BASE, NUM_FX, NUM_UNITS, SPLIT_BASE};
use crate::patch::lane;
use crate::util::{BLOCK, PI, TAU};

/// Kinds of effect, matching `params::FX_KEYS`.
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
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    /// Modulated, normalised parameter values.
    pub m: &'a [f32],
    pub defs: &'static [ParamDef],
    pub sr: f32,
    pub bpm: f32,
    /// Added to every index: effects address the parameters of the first
    /// copy, and this moves them to the copy that is being processed.
    pub shift: usize,
}

impl<'a> Ctx<'a> {
    /// Parameter value in real units.
    #[inline]
    pub fn v(&self, idx: usize) -> f32 {
        self.defs[idx + self.shift].to_plain(self.m[idx + self.shift])
    }
    #[inline]
    pub fn on(&self, idx: usize) -> bool {
        self.m[idx + self.shift] >= 0.5
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

/// Signal taps written by the chain: one after each unit, then the two lane
/// inputs and the output of the fork.
pub mod tap {
    use crate::params::NUM_UNITS;
    pub const SPLIT_A: usize = NUM_UNITS;
    pub const SPLIT_B: usize = NUM_UNITS + 1;
    pub const SPLIT_OUT: usize = NUM_UNITS + 2;
    pub const N: usize = NUM_UNITS + 3;
}

pub type Taps = [[f32; BLOCK]; tap::N];

enum Unit {
    Hyper(Hyper),
    Dist(Distortion),
    Flanger(Flanger),
    Phaser(Phaser),
    Chorus(Chorus),
    Delay(Delay),
    Comp(Compressor),
    Reverb(Reverb),
    Eq(Eq),
    Filter(Filter),
}

impl Unit {
    fn new(kind: usize, sr: f32) -> Unit {
        match kind {
            id::HYPER => Unit::Hyper(Hyper::new(sr)),
            id::DIST => Unit::Dist(Distortion::new()),
            id::FLANGER => Unit::Flanger(Flanger::new(sr)),
            id::PHASER => Unit::Phaser(Phaser::new()),
            id::CHORUS => Unit::Chorus(Chorus::new(sr)),
            id::DELAY => Unit::Delay(Delay::new(sr)),
            id::COMP => Unit::Comp(Compressor::new()),
            id::REVERB => Unit::Reverb(Reverb::new(sr)),
            id::EQ => Unit::Eq(Eq::new()),
            _ => Unit::Filter(Filter::default()),
        }
    }

    fn clear(&mut self) {
        match self {
            Unit::Hyper(u) => u.clear(),
            Unit::Dist(u) => u.clear(),
            Unit::Flanger(u) => u.clear(),
            Unit::Phaser(u) => u.clear(),
            Unit::Chorus(u) => u.clear(),
            Unit::Delay(u) => u.clear(),
            Unit::Comp(u) => u.clear(),
            Unit::Reverb(u) => u.clear(),
            Unit::Eq(u) => u.clear(),
            Unit::Filter(u) => u.reset(),
        }
    }

    fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        match self {
            Unit::Hyper(u) => u.process(c, l, r),
            Unit::Dist(u) => u.process(c, l, r),
            Unit::Flanger(u) => u.process(c, l, r),
            Unit::Phaser(u) => u.process(c, l, r),
            Unit::Chorus(u) => u.process(c, l, r),
            Unit::Delay(u) => u.process(c, l, r),
            Unit::Comp(u) => u.process(c, l, r),
            Unit::Reverb(u) => u.process(c, l, r),
            Unit::Eq(u) => u.process(c, l, r),
            Unit::Filter(u) => {
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
                u.process(&p, l, r);
            }
        }
    }
}

/// How the fork divides the sound between its two lanes.
#[derive(Clone, Copy, PartialEq)]
enum SplitMode {
    /// The same sound on both lanes.
    Copy,
    /// Lows on A, highs on B.
    Bands,
    /// The centre on A, the stereo difference on B.
    MidSide,
    /// The left channel on A, the right on B.
    LeftRight,
}

/// Fourth-order Linkwitz-Riley crossover for one channel. Its two outputs
/// add up to the input with a flat level (only the phase is shifted).
#[derive(Clone, Copy, Default)]
struct Crossover {
    low: [Biquad; 2],
    high: [Biquad; 2],
}

impl Crossover {
    fn set(&mut self, freq: f32, sr: f32) {
        const BUTTERWORTH: f32 = 0.707_106_77;
        for b in self.low.iter_mut() {
            b.lowpass(freq, BUTTERWORTH, sr);
        }
        for b in self.high.iter_mut() {
            b.highpass(freq, BUTTERWORTH, sr);
        }
    }

    #[inline]
    fn tick(&mut self, x: f32) -> (f32, f32) {
        let low = self.low[0].tick(x);
        let high = self.high[0].tick(x);
        (self.low[1].tick(low), self.high[1].tick(high))
    }

    fn clear(&mut self) {
        self.low.iter_mut().chain(self.high.iter_mut()).for_each(|b| b.clear());
    }

    fn flush(&mut self) {
        self.low.iter_mut().chain(self.high.iter_mut()).for_each(|b| b.flush());
    }
}

pub struct FxChain {
    units: Vec<Unit>,
    was_on: [bool; NUM_UNITS],
    crossover: [Crossover; 2],
    was_split: bool,
}

impl FxChain {
    pub fn new(sr: f32) -> Self {
        FxChain {
            units: (0..NUM_UNITS).map(|u| Unit::new(u % NUM_FX, sr)).collect(),
            was_on: [false; NUM_UNITS],
            crossover: [Crossover::default(); 2],
            was_split: false,
        }
    }

    /// Runs one unit and records what leaves it.
    fn run(&mut self, unit: usize, c: &Ctx, l: &mut [f32], r: &mut [f32], taps: &mut Taps) {
        let c = Ctx { shift: unit_shift(unit), ..*c };
        self.units[unit].process(&c, l, r);
        write_tap(&mut taps[unit], l, r);
    }

    /// Runs the enabled units. Units on the main lane run one after the
    /// other in `order`; where the first unit of lane A or B comes up, the
    /// sound forks, each lane runs its own units, and the lanes are mixed
    /// again (see `patch::FxGroups`). The taps of units that are off stay
    /// silent.
    pub fn process(&mut self, order: &[u8; NUM_UNITS], lanes: &[u8; NUM_UNITS], c: &Ctx, l: &mut [f32], r: &mut [f32], taps: &mut Taps) {
        let on: [bool; NUM_UNITS] = core::array::from_fn(|u| c.on(unit_on(u)));
        for u in 0..NUM_UNITS {
            if on[u] && !self.was_on[u] {
                // Switched on: start from silence, not from a stale tail.
                self.units[u].clear();
            }
        }
        self.was_on = on;

        let mut forked = false;
        for &u in order.iter() {
            let u = (u as usize).min(NUM_UNITS - 1);
            if !on[u] {
                continue;
            }
            if lanes[u] == lane::MAIN {
                self.run(u, c, l, r, taps);
            } else if !forked {
                forked = true;
                self.fork(order, lanes, &on, c, l, r, taps);
            }
        }
        if !forked {
            self.was_split = false;
        }
    }

    /// The fork: divides the sound, runs both lanes, mixes them again.
    #[allow(clippy::too_many_arguments)]
    fn fork(&mut self, order: &[u8; NUM_UNITS], lanes: &[u8; NUM_UNITS], on: &[bool; NUM_UNITS], c: &Ctx, l: &mut [f32], r: &mut [f32], taps: &mut Taps) {
        let n = l.len();
        let mode = match c.v(SPLIT_BASE + split::MODE) as usize {
            1 => SplitMode::Bands,
            2 => SplitMode::MidSide,
            3 => SplitMode::LeftRight,
            _ => SplitMode::Copy,
        };
        if !self.was_split {
            self.crossover.iter_mut().for_each(|x| x.clear());
            self.was_split = true;
        }

        // Divide. In every mode A + B is the sound that came in (for the
        // copies: twice it, which the mix below takes back).
        let (mut al, mut ar, mut bl, mut br) = ([0.0f32; BLOCK], [0.0f32; BLOCK], [0.0f32; BLOCK], [0.0f32; BLOCK]);
        match mode {
            SplitMode::Copy => {
                al[..n].copy_from_slice(l);
                ar[..n].copy_from_slice(r);
                bl[..n].copy_from_slice(l);
                br[..n].copy_from_slice(r);
            }
            SplitMode::Bands => {
                let freq = c.v(SPLIT_BASE + split::FREQ);
                self.crossover.iter_mut().for_each(|x| x.set(freq, c.sr));
                for s in 0..n {
                    (al[s], bl[s]) = self.crossover[0].tick(l[s]);
                    (ar[s], br[s]) = self.crossover[1].tick(r[s]);
                }
                self.crossover.iter_mut().for_each(|x| x.flush());
            }
            SplitMode::MidSide => {
                for s in 0..n {
                    let (mid, side) = ((l[s] + r[s]) * 0.5, (l[s] - r[s]) * 0.5);
                    (al[s], ar[s]) = (mid, mid);
                    (bl[s], br[s]) = (side, -side);
                }
            }
            SplitMode::LeftRight => {
                al[..n].copy_from_slice(l);
                br[..n].copy_from_slice(r);
            }
        }
        write_tap(&mut taps[tap::SPLIT_A], &al[..n], &ar[..n]);
        write_tap(&mut taps[tap::SPLIT_B], &bl[..n], &br[..n]);

        for &u in order.iter() {
            let u = (u as usize).min(NUM_UNITS - 1);
            if !on[u] {
                continue;
            }
            match lanes[u] {
                lane::MAIN => {}
                lane::A => self.run(u, c, &mut al[..n], &mut ar[..n], taps),
                _ => self.run(u, c, &mut bl[..n], &mut br[..n], taps),
            }
        }

        // Mix. At the centre an empty fork leaves the sound as it was: two
        // copies come back at half level each, complementary parts at full.
        let bal = c.v(SPLIT_BASE + split::BALANCE);
        let (ga, gb) = if mode == SplitMode::Copy { (1.0 - bal, bal) } else { balance(bal) };
        for s in 0..n {
            l[s] = al[s] * ga + bl[s] * gb;
            r[s] = ar[s] * ga + br[s] * gb;
        }
        write_tap(&mut taps[tap::SPLIT_OUT], l, r);
    }
}

#[inline]
fn write_tap(tap: &mut [f32; BLOCK], l: &[f32], r: &[f32]) {
    for s in 0..l.len() {
        tap[s] = (l[s] + r[s]) * 0.5;
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

    use crate::params::{dist, DIST_BASE};
    use crate::patch::DEFAULT_FX_ORDER;

    const SR: f32 = 48_000.0;

    fn defaults() -> Vec<f32> {
        let m: Vec<f32> = defs().iter().map(|p| p.default_norm()).collect();
        assert_eq!(m.len(), NUM_PARAMS);
        m
    }

    fn set(m: &mut [f32], idx: usize, plain: f32) {
        m[idx] = defs()[idx].to_norm(plain);
    }

    fn order_starting(start: &[u8]) -> [u8; NUM_UNITS] {
        let mut order = [0u8; NUM_UNITS];
        let rest = (0..NUM_UNITS as u8).filter(|u| !start.contains(u));
        for (slot, u) in order.iter_mut().zip(start.iter().copied().chain(rest)) {
            *slot = u;
        }
        order
    }

    /// Runs noise bursts (different left and right) through a chain and
    /// returns the interleaved output.
    fn render(m: &[f32], order: &[u8; NUM_UNITS], lanes: &[u8; NUM_UNITS], blocks: usize) -> Vec<f32> {
        let mut chain = FxChain::new(SR);
        let mut rng = Rng::new(11);
        let mut out = Vec::with_capacity(blocks * BLOCK * 2);
        let mut taps = [[0.0f32; BLOCK]; tap::N];
        for b in 0..blocks {
            let mut l = [0.0f32; BLOCK];
            let mut r = [0.0f32; BLOCK];
            if b % 300 < 100 {
                for s in 0..BLOCK {
                    l[s] = rng.bipolar() * 0.5;
                    r[s] = rng.bipolar() * 0.5;
                }
            }
            let c = Ctx { m, defs: defs(), sr: SR, bpm: 120.0, shift: 0 };
            chain.process(order, lanes, &c, &mut l, &mut r, &mut taps);
            for s in 0..BLOCK {
                out.push(l[s]);
                out.push(r[s]);
            }
        }
        out
    }

    fn energy(x: &[f32]) -> f64 {
        x.iter().map(|v| (*v as f64).powi(2)).sum()
    }

    fn max_diff(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()))
    }

    const MAIN: [u8; NUM_UNITS] = [lane::MAIN; NUM_UNITS];

    /// Every kind of effect, alone and all together, in several orders and
    /// across the fork: output must stay finite and reasonably bounded.
    #[test]
    fn effects_are_stable() {
        let orders = [DEFAULT_FX_ORDER, order_starting(&[9, 7, 5, 6, 1, 0, 3, 2, 4, 8])];
        let mut forked = MAIN;
        for u in 0..NUM_FX {
            forked[u] = [lane::MAIN, lane::A, lane::B][u % 3];
        }
        for case in 0..=NUM_FX {
            for order in orders.iter() {
                for lanes in [MAIN, forked] {
                    let mut m = defaults();
                    for fx in 0..NUM_FX {
                        if case == NUM_FX || case == fx {
                            m[unit_on(fx)] = 1.0;
                        }
                    }
                    let out = render(&m, order, &lanes, 1500);
                    assert!(out.iter().all(|v| v.is_finite()), "case {case}");
                    let peak = out.iter().fold(0.0f32, |p, v| p.max(v.abs()));
                    assert!(peak < 8.0, "case {case} peak {peak}");
                    assert!(energy(&out) > 1.0, "case {case} went silent");
                }
            }
        }
    }

    #[test]
    fn every_copy_of_an_effect_sounds_the_same() {
        // Long enough for the first echo of the delay to come back.
        for kind in 0..NUM_FX {
            let mut outs = Vec::new();
            for copy in 0..crate::params::FX_COPIES {
                let unit = kind + copy * NUM_FX;
                let mut m = defaults();
                m[unit_on(unit)] = 1.0;
                // The EQ is flat until a band is moved.
                set(&mut m, crate::params::EQ_BASE + unit_shift(unit) + crate::params::eq::LOW_GAIN, 6.0);
                outs.push(render(&m, &DEFAULT_FX_ORDER, &MAIN, 600));
            }
            let dry = render(&defaults(), &DEFAULT_FX_ORDER, &MAIN, 600);
            assert!(max_diff(&outs[0], &dry) > 1e-3, "kind {kind} does nothing");
            assert!(max_diff(&outs[0], &outs[1]) < 1e-6, "kind {kind} copy 2");
            assert!(max_diff(&outs[0], &outs[2]) < 1e-6, "kind {kind} copy 3");
        }
    }

    #[test]
    fn stacked_copies_run_one_after_the_other() {
        // Two distortions in a row distort more than one.
        let mut m = defaults();
        m[unit_on(id::DIST)] = 1.0;
        let once = render(&m, &DEFAULT_FX_ORDER, &MAIN, 200);
        m[unit_on(id::DIST + NUM_FX)] = 1.0;
        let twice = render(&m, &DEFAULT_FX_ORDER, &MAIN, 200);
        assert!(max_diff(&once, &twice) > 0.05);
        // And each copy has its own settings.
        set(&mut m, DIST_BASE + unit_shift(id::DIST + NUM_FX) + dist::MIX, 0.0);
        assert!(max_diff(&once, &render(&m, &DEFAULT_FX_ORDER, &MAIN, 200)) < 1e-6);
    }

    /// A fork whose lanes do nothing must not change the sound.
    #[test]
    fn an_empty_fork_is_transparent() {
        let dry = render(&defaults(), &DEFAULT_FX_ORDER, &MAIN, 300);
        for mode in 0..4 {
            let mut m = defaults();
            // A distortion at 0% mix passes its input: a lane with nothing in it.
            m[unit_on(id::DIST)] = 1.0;
            set(&mut m, DIST_BASE + dist::MIX, 0.0);
            set(&mut m, SPLIT_BASE + split::MODE, mode as f32);
            let mut lanes = MAIN;
            lanes[id::DIST] = lane::A;
            let out = render(&m, &DEFAULT_FX_ORDER, &lanes, 300);
            if mode == 1 {
                // The crossover shifts the phase but keeps the level.
                let ratio = energy(&out) / energy(&dry);
                assert!((ratio - 1.0).abs() < 0.02, "bands: energy ratio {ratio}");
            } else {
                assert!(max_diff(&out, &dry) < 1e-5, "mode {mode}");
            }
        }
    }

    #[test]
    fn a_lane_only_affects_its_part_of_the_sound() {
        let mut m = defaults();
        m[unit_on(id::DIST)] = 1.0;
        set(&mut m, DIST_BASE + dist::MIX, 0.0);
        let mut lanes = MAIN;
        lanes[id::DIST] = lane::A;
        let left = |x: &[f32]| x.iter().step_by(2).copied().collect::<Vec<f32>>();
        let right = |x: &[f32]| x.iter().skip(1).step_by(2).copied().collect::<Vec<f32>>();
        let dry = render(&defaults(), &DEFAULT_FX_ORDER, &MAIN, 300);

        // Left / right, balance fully on A: only the left channel is left.
        set(&mut m, SPLIT_BASE + split::MODE, 3.0);
        set(&mut m, SPLIT_BASE + split::BALANCE, 0.0);
        let out = render(&m, &DEFAULT_FX_ORDER, &lanes, 300);
        assert!(max_diff(&left(&out), &left(&dry)) < 1e-5);
        assert_eq!(energy(&right(&out)), 0.0);

        // Mid / side, balance fully on A: both channels carry the centre.
        set(&mut m, SPLIT_BASE + split::MODE, 2.0);
        let out = render(&m, &DEFAULT_FX_ORDER, &lanes, 300);
        assert!(max_diff(&left(&out), &right(&out)) < 1e-6);
        assert!(energy(&out) > 1.0);

        // Copies, balance fully on B: lane A (with the distortion now at
        // full) is not heard at all.
        set(&mut m, SPLIT_BASE + split::MODE, 0.0);
        set(&mut m, SPLIT_BASE + split::BALANCE, 1.0);
        set(&mut m, DIST_BASE + dist::MIX, 1.0);
        assert!(max_diff(&render(&m, &DEFAULT_FX_ORDER, &lanes, 300), &dry) < 1e-5);
    }

    #[test]
    fn the_crossover_separates_lows_from_highs() {
        let mut bands = Crossover::default();
        bands.set(1000.0, SR);
        let mut measure = |freq: f32| {
            bands.clear();
            let (mut low, mut high, mut sum) = (0.0f64, 0.0f64, 0.0f64);
            for i in 0..9600 {
                let x = (TAU * freq * i as f32 / SR).sin();
                let (lo, hi) = bands.tick(x);
                if i >= 4800 {
                    low += (lo as f64).powi(2);
                    high += (hi as f64).powi(2);
                    sum += ((lo + hi) as f64).powi(2);
                }
            }
            // A full-scale sine has a mean square of one half.
            (low / 2400.0, high / 2400.0, sum / 2400.0)
        };
        let (low, high, sum) = measure(100.0);
        assert!(low > 0.95 && high < 1e-6, "100 Hz: low {low} high {high}");
        assert!((sum - 1.0).abs() < 0.02);
        let (low, high, sum) = measure(8000.0);
        assert!(high > 0.95 && low < 1e-6, "8 kHz: low {low} high {high}");
        assert!((sum - 1.0).abs() < 0.02);
        // At the crossover both are 6 dB down and add up to the full level.
        let (low, high, sum) = measure(1000.0);
        assert!((low - 0.25).abs() < 0.02 && (high - 0.25).abs() < 0.02, "1 kHz: low {low} high {high}");
        assert!((sum - 1.0).abs() < 0.02);
    }

    #[test]
    fn lanes_run_side_by_side_not_in_series() {
        // Reverb and delay on separate lanes: the delay's echoes are not
        // reverberated, so the result differs from running them in a row.
        let mut m = defaults();
        m[unit_on(id::DELAY)] = 1.0;
        m[unit_on(id::REVERB)] = 1.0;
        let series = render(&m, &DEFAULT_FX_ORDER, &MAIN, 600);
        let mut lanes = MAIN;
        lanes[id::DELAY] = lane::A;
        lanes[id::REVERB] = lane::B;
        let parallel = render(&m, &DEFAULT_FX_ORDER, &lanes, 600);
        assert!(max_diff(&series, &parallel) > 0.01);
        // With everything on lane A and the balance on A, it is a plain series again.
        lanes[id::REVERB] = lane::A;
        set(&mut m, SPLIT_BASE + split::BALANCE, 0.0);
        assert!(max_diff(&series, &render(&m, &DEFAULT_FX_ORDER, &lanes, 600)) < 1e-5);
    }

    #[test]
    fn taps_follow_the_units_and_the_fork() {
        let mut m = defaults();
        m[unit_on(id::DIST)] = 1.0;
        m[unit_on(id::EQ)] = 1.0;
        let mut lanes = MAIN;
        lanes[id::EQ] = lane::B;
        let mut chain = FxChain::new(SR);
        let mut taps = [[0.0f32; BLOCK]; tap::N];
        let mut l = [0.25f32; BLOCK];
        let mut r = [0.25f32; BLOCK];
        let c = Ctx { m: &m, defs: defs(), sr: SR, bpm: 120.0, shift: 0 };
        chain.process(&DEFAULT_FX_ORDER, &lanes, &c, &mut l, &mut r, &mut taps);
        let level = |t: usize| taps[t].iter().fold(0.0f32, |p, v| p.max(v.abs()));
        assert!(level(id::DIST) > 0.0 && level(id::EQ) > 0.0);
        assert!(level(tap::SPLIT_A) > 0.0 && level(tap::SPLIT_B) > 0.0 && level(tap::SPLIT_OUT) > 0.0);
        assert_eq!(level(id::REVERB), 0.0, "a unit that is off stays silent");
        assert_eq!(level(id::DIST + NUM_FX), 0.0);
    }
}
