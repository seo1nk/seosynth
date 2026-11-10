//! Modulated-delay effects: Hyper/Dimension, chorus, flanger, phaser.

use super::{allpass_coeff, one_pole, Ctx, DelayLine};
use crate::params::{chorus, flanger, hyper, phaser, CHORUS_BASE, FLANGER_BASE, HYPER_BASE, PHASER_BASE};
use crate::util::{sanitize, TAU};

const HYPER_VOICES: usize = 7;

/// Hyper: a cloud of slightly detuned copies (like extra unison voices added
/// after the fact). Dimension: a subtle stereo widener.
pub struct Hyper {
    lines: [DelayLine; 2],
    phase: [f32; HYPER_VOICES],
    dim: [DelayLine; 2],
    dim_phase: f32,
}

impl Hyper {
    pub fn new(sr: f32) -> Self {
        let len = (sr * 0.05) as usize;
        let mut phase = [0.0; HYPER_VOICES];
        for (v, p) in phase.iter_mut().enumerate() {
            *p = (v as f32 * 0.37) % 1.0;
        }
        Hyper {
            lines: [DelayLine::new(len), DelayLine::new(len)],
            phase,
            dim: [DelayLine::new(len), DelayLine::new(len)],
            dim_phase: 0.0,
        }
    }

    pub fn clear(&mut self) {
        self.lines.iter_mut().for_each(|l| l.clear());
        self.dim.iter_mut().for_each(|l| l.clear());
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| HYPER_BASE + p;
        let rate = c.v(i(hyper::RATE));
        let rate_hz = 0.1 + rate * rate * 6.0;
        // Depth is tied to the rate so "detune" sets a pitch offset that does
        // not change when the rate does.
        let depth = (c.v(i(hyper::DETUNE)) * 0.012 / (4.0 * rate_hz)).min(0.008) * c.sr;
        let voices = (c.v(i(hyper::VOICES)) as usize).max(1).min(HYPER_VOICES);
        let mix = c.v(i(hyper::MIX));
        let norm = 1.0 / (voices as f32).sqrt();
        let dim_mix = c.v(i(hyper::DIM_MIX));
        let dim_size = c.v(i(hyper::DIM_SIZE));
        let dim_base = (0.007 + dim_size * 0.012) * c.sr;
        let dim_inc = 0.3 / c.sr;

        for s in 0..l.len() {
            let dry = [l[s], r[s]];
            self.lines[0].push(dry[0]);
            self.lines[1].push(dry[1]);
            let mut wet = [0.0f32; 2];
            for v in 0..voices {
                let ph = self.phase[v];
                for ch in 0..2 {
                    let p = ph + 0.25 * ch as f32;
                    let p = p - p.floor();
                    let tri = 1.0 - (2.0 * p - 1.0).abs();
                    let d = (0.004 + 0.0015 * v as f32) * c.sr + depth * tri;
                    wet[ch] += self.lines[ch].read(d);
                }
                let np = ph + rate_hz * (1.0 + 0.11 * v as f32) / c.sr;
                self.phase[v] = np - np.floor();
            }
            let mut out = [
                dry[0] * (1.0 - mix * 0.3) + wet[0] * norm * mix,
                dry[1] * (1.0 - mix * 0.3) + wet[1] * norm * mix,
            ];

            if dim_mix > 0.001 {
                self.dim[0].push(out[0]);
                self.dim[1].push(out[1]);
                let lfo = (TAU * self.dim_phase).sin();
                let a = self.dim[0].read(dim_base * (1.0 + 0.15 * lfo));
                let b = self.dim[1].read(dim_base * (1.0 - 0.15 * lfo));
                out[0] += dim_mix * (a - 0.5 * b);
                out[1] += dim_mix * (b - 0.5 * a);
                self.dim_phase += dim_inc;
                if self.dim_phase >= 1.0 {
                    self.dim_phase -= 1.0;
                }
            }
            l[s] = out[0];
            r[s] = out[1];
        }
    }
}

/// Two modulated delay taps per channel.
pub struct Chorus {
    lines: [DelayLine; 2],
    phase: f32,
    lp: [f32; 2],
}

impl Chorus {
    pub fn new(sr: f32) -> Self {
        let len = (sr * 0.06) as usize;
        Chorus { lines: [DelayLine::new(len), DelayLine::new(len)], phase: 0.0, lp: [0.0; 2] }
    }

    pub fn clear(&mut self) {
        self.lines.iter_mut().for_each(|l| l.clear());
        self.lp = [0.0; 2];
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| CHORUS_BASE + p;
        let inc = c.v(i(chorus::RATE)) / c.sr;
        let ms = c.sr * 0.001;
        let d1 = c.v(i(chorus::DELAY1)) * ms;
        let d2 = c.v(i(chorus::DELAY2)) * ms;
        let depth = c.v(i(chorus::DEPTH)) * 2.5 * ms;
        let fb = c.v(i(chorus::FEEDBACK));
        let lp = one_pole(c.v(i(chorus::LPF)), c.sr);
        let mix = c.v(i(chorus::MIX));

        for s in 0..l.len() {
            let a = TAU * self.phase;
            let lfo = [a.sin(), a.cos()];
            let x = [l[s], r[s]];
            let mut out = [0.0f32; 2];
            for ch in 0..2 {
                let t1 = self.lines[ch].read((d1 + depth * lfo[ch]).max(2.0));
                let t2 = self.lines[ch].read((d2 - depth * lfo[ch]).max(2.0));
                let wet = 0.5 * (t1 + t2);
                self.lp[ch] += lp * (wet - self.lp[ch]);
                let wet = self.lp[ch];
                self.lines[ch].push(x[ch] + fb * wet);
                out[ch] = x[ch] + (wet - x[ch]) * mix;
            }
            l[s] = out[0];
            r[s] = out[1];
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
        }
        self.lp = [sanitize(self.lp[0]), sanitize(self.lp[1])];
    }
}

/// Very short modulated delay with feedback: the "jet plane" sweep.
pub struct Flanger {
    lines: [DelayLine; 2],
    phase: f32,
}

impl Flanger {
    pub fn new(sr: f32) -> Self {
        let len = (sr * 0.02) as usize;
        Flanger { lines: [DelayLine::new(len), DelayLine::new(len)], phase: 0.0 }
    }

    pub fn clear(&mut self) {
        self.lines.iter_mut().for_each(|l| l.clear());
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| FLANGER_BASE + p;
        let inc = c.v(i(flanger::RATE)) / c.sr;
        let ms = c.sr * 0.001;
        let depth = c.v(i(flanger::DEPTH)) * 5.0 * ms;
        let fb = c.v(i(flanger::FEEDBACK));
        let offset = c.v(i(flanger::PHASE)) * 0.5;
        let mix = c.v(i(flanger::MIX));

        for s in 0..l.len() {
            let x = [l[s], r[s]];
            let mut out = [0.0f32; 2];
            for ch in 0..2 {
                let lfo = 0.5 + 0.5 * (TAU * (self.phase + offset * ch as f32)).sin();
                let wet = self.lines[ch].read(0.3 * ms + 1.0 + depth * lfo);
                self.lines[ch].push(x[ch] + fb * wet);
                out[ch] = x[ch] + (wet - x[ch]) * mix;
            }
            l[s] = out[0];
            r[s] = out[1];
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
        }
    }
}

const PHASER_STAGES: usize = 6;

/// Swept all-pass chain: moving notches.
pub struct Phaser {
    z: [[f32; PHASER_STAGES]; 2],
    last: [f32; 2],
    phase: f32,
}

impl Phaser {
    pub fn new() -> Self {
        Phaser { z: [[0.0; PHASER_STAGES]; 2], last: [0.0; 2], phase: 0.0 }
    }

    pub fn clear(&mut self) {
        self.z = [[0.0; PHASER_STAGES]; 2];
        self.last = [0.0; 2];
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| PHASER_BASE + p;
        let inc = c.v(i(phaser::RATE)) / c.sr;
        let depth = c.v(i(phaser::DEPTH)) * 2.0;
        let freq = c.v(i(phaser::FREQ));
        let fb = c.v(i(phaser::FEEDBACK));
        let offset = c.v(i(phaser::PHASE)) * 0.5;
        let mix = c.v(i(phaser::MIX));

        for s in 0..l.len() {
            let x = [l[s], r[s]];
            let mut out = [0.0f32; 2];
            for ch in 0..2 {
                let lfo = (TAU * (self.phase + offset * ch as f32)).sin();
                let a = allpass_coeff(freq * (2.0f32).powf(depth * lfo), c.sr);
                let mut y = x[ch] + fb * self.last[ch];
                for st in self.z[ch].iter_mut() {
                    let o = a * y + *st;
                    *st = y - a * o;
                    y = o;
                }
                self.last[ch] = y;
                out[ch] = x[ch] + (y - x[ch]) * mix;
            }
            l[s] = out[0];
            r[s] = out[1];
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
        }
        for ch in 0..2 {
            self.last[ch] = sanitize(self.last[ch]);
            for st in self.z[ch].iter_mut() {
                *st = sanitize(*st);
            }
        }
    }
}

impl Default for Phaser {
    fn default() -> Self {
        Self::new()
    }
}
