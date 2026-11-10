//! Reverb: input diffusion into an 8-line feedback delay network.

use super::{balance, one_pole, Ctx, DelayLine};
use crate::params::{reverb, REVERB_BASE};
use crate::util::{sanitize, TAU};

const LINES: usize = 8;
const DIFFUSERS: usize = 4;
/// Delay lengths in milliseconds at scale 1; mutually prime-ish so echoes
/// do not pile up on the same instants.
const LINE_MS: [f32; LINES] = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.1, 73.3];
const DIFF_MS: [f32; DIFFUSERS] = [4.77, 3.61, 12.73, 9.31];
const DIFF_GAIN: f32 = 0.625;
const MAX_SCALE: f32 = 2.0;

pub struct Reverb {
    pre: [DelayLine; 2],
    diff: [[DelayLine; DIFFUSERS]; 2],
    lines: [DelayLine; LINES],
    damp: [f32; LINES],
    hp: [f32; 2],
    lp: [f32; 2],
    mod_phase: f32,
}

impl Reverb {
    pub fn new(sr: f32) -> Self {
        let ms = sr * 0.001;
        Reverb {
            pre: [DelayLine::new((sr * 0.26) as usize), DelayLine::new((sr * 0.26) as usize)],
            diff: core::array::from_fn(|_| core::array::from_fn(|i| DelayLine::new((DIFF_MS[i] * ms * 1.2) as usize + 8))),
            lines: core::array::from_fn(|i| DelayLine::new((LINE_MS[i] * MAX_SCALE * ms) as usize + 32)),
            damp: [0.0; LINES],
            hp: [0.0; 2],
            lp: [0.0; 2],
            mod_phase: 0.0,
        }
    }

    pub fn clear(&mut self) {
        self.pre.iter_mut().for_each(|l| l.clear());
        self.diff.iter_mut().flatten().for_each(|l| l.clear());
        self.lines.iter_mut().for_each(|l| l.clear());
        self.damp = [0.0; LINES];
        self.hp = [0.0; 2];
        self.lp = [0.0; 2];
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| REVERB_BASE + p;
        let hall = c.v(i(reverb::MODE)) as usize == 1;
        let size = c.v(i(reverb::SIZE));
        let decay = c.v(i(reverb::DECAY));
        let ms = c.sr * 0.001;
        let scale = if hall { 0.6 + size * 1.4 } else { 0.25 + size * 0.75 };
        let rt60 = (if hall { 0.5 } else { 0.3 }) * (40.0f32).powf(decay);

        let mut len = [0.0f32; LINES];
        let mut gain = [0.0f32; LINES];
        for k in 0..LINES {
            len[k] = LINE_MS[k] * scale * ms;
            gain[k] = (10.0f32).powf(-3.0 * (len[k] / c.sr) / rt60);
        }
        let diff_scale = 0.5 + size * 0.5;
        let mut diff_len = [[0usize; DIFFUSERS]; 2];
        for ch in 0..2 {
            for k in 0..DIFFUSERS {
                diff_len[ch][k] = ((DIFF_MS[k] + 0.31 * ch as f32) * diff_scale * ms) as usize;
            }
        }

        let predelay = (c.v(i(reverb::PREDELAY)) * c.sr).max(1.0);
        let hp_c = one_pole(20.0 * (50.0f32).powf(c.v(i(reverb::LOWCUT))), c.sr);
        let lp_c = one_pole(20_000.0 * (0.05f32).powf(c.v(i(reverb::HIGHCUT))), c.sr);
        let damp_c = 1.0 - c.v(i(reverb::DAMP)) * 0.85;
        let width = c.v(i(reverb::WIDTH));
        let (dry_g, wet_g) = balance(c.v(i(reverb::MIX)));
        let mod_inc = 0.5 / c.sr;
        let mod_depth = 6.0;

        for s in 0..l.len() {
            let dry = [l[s], r[s]];

            // Pre-delay, tone shaping and diffusion per channel.
            let mut input = [0.0f32; 2];
            for ch in 0..2 {
                let mut x = self.pre[ch].read(predelay);
                self.pre[ch].push(dry[ch]);
                self.hp[ch] += hp_c * (x - self.hp[ch]);
                x -= self.hp[ch];
                self.lp[ch] += lp_c * (x - self.lp[ch]);
                x = self.lp[ch];
                for k in 0..DIFFUSERS {
                    let d = self.diff[ch][k].read_int(diff_len[ch][k]);
                    let y = d - DIFF_GAIN * x;
                    self.diff[ch][k].push(x + DIFF_GAIN * y);
                    x = y;
                }
                input[ch] = x;
            }

            // Feedback delay network with a Householder mixing matrix.
            let lfo = (TAU * self.mod_phase).sin() * mod_depth;
            let mut o = [0.0f32; LINES];
            let mut f = [0.0f32; LINES];
            let mut sum = 0.0;
            for k in 0..LINES {
                let d = match k {
                    0 => len[k] + lfo,
                    4 => len[k] - lfo,
                    _ => len[k],
                };
                o[k] = self.lines[k].read(d);
                self.damp[k] += damp_c * (o[k] - self.damp[k]);
                f[k] = self.damp[k] * gain[k];
                sum += f[k];
            }
            let mix_back = sum * (2.0 / LINES as f32);
            for k in 0..LINES {
                self.lines[k].push(f[k] - mix_back + input[k % 2]);
            }
            self.mod_phase += mod_inc;
            if self.mod_phase >= 1.0 {
                self.mod_phase -= 1.0;
            }

            let wl = (o[0] - o[2] + o[4] - o[6]) * 0.35;
            let wr = (o[1] - o[3] + o[5] - o[7]) * 0.35;
            let mid = (wl + wr) * 0.5;
            let side = (wl - wr) * 0.5 * width;
            l[s] = dry[0] * dry_g + (mid + side) * wet_g;
            r[s] = dry[1] * dry_g + (mid - side) * wet_g;
        }
        for k in 0..LINES {
            self.damp[k] = sanitize(self.damp[k]);
        }
        for ch in 0..2 {
            self.hp[ch] = sanitize(self.hp[ch]);
            self.lp[ch] = sanitize(self.lp[ch]);
        }
    }
}
