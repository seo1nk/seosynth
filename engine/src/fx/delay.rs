//! Stereo delay with tempo sync, ping-pong and a filter in the feedback loop.

use super::{balance, one_pole, Ctx, DelayLine};
use crate::params::{delay, DELAY_BASE};
use crate::util::sanitize;

const MAX_SECONDS: f32 = 2.0;

pub struct Delay {
    lines: [DelayLine; 2],
    /// Current (smoothed) delay length in samples.
    cur: [f32; 2],
    lp: [f32; 2],
    hp: [f32; 2],
    primed: bool,
}

impl Delay {
    pub fn new(sr: f32) -> Self {
        let len = (sr * (MAX_SECONDS + 0.05)) as usize;
        Delay { lines: [DelayLine::new(len), DelayLine::new(len)], cur: [0.0; 2], lp: [0.0; 2], hp: [0.0; 2], primed: false }
    }

    pub fn clear(&mut self) {
        self.lines.iter_mut().for_each(|l| l.clear());
        self.lp = [0.0; 2];
        self.hp = [0.0; 2];
        self.primed = false;
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| DELAY_BASE + p;
        let sync = c.on(i(delay::SYNC));
        let link = c.on(i(delay::LINK));
        let time_l = if sync { c.division_seconds(i(delay::DIV_L)) } else { c.v(i(delay::TIME_L)) };
        let time_r = if link {
            time_l
        } else if sync {
            c.division_seconds(i(delay::DIV_R))
        } else {
            c.v(i(delay::TIME_R))
        };
        let limit = (self.lines[0].capacity() - 4) as f32;
        let target = [
            (time_l.min(MAX_SECONDS) * c.sr).max(2.0).min(limit),
            (time_r.min(MAX_SECONDS) * c.sr).max(2.0).min(limit),
        ];
        if !self.primed {
            self.cur = target;
            self.primed = true;
        }
        let slew = 1.0 - (-1.0 / (0.08 * c.sr)).exp();
        let fb = c.v(i(delay::FEEDBACK));
        let mode = c.v(i(delay::MODE)) as usize;
        let (dry_g, wet_g) = balance(c.v(i(delay::MIX)));

        // Band-pass in the loop: each repeat gets a little thinner.
        let freq = c.v(i(delay::FILTER_FREQ));
        let width = 0.5 + (1.0 - c.v(i(delay::FILTER_Q))) * 4.5;
        let lp_c = one_pole(freq * (2.0f32).powf(width), c.sr);
        let hp_c = one_pole(freq * (2.0f32).powf(-width), c.sr);

        for s in 0..l.len() {
            let x = [l[s], r[s]];
            let mut wet = [0.0f32; 2];
            for ch in 0..2 {
                self.cur[ch] += (target[ch] - self.cur[ch]) * slew;
                let d = self.lines[ch].read(self.cur[ch]);
                self.lp[ch] += lp_c * (d - self.lp[ch]);
                self.hp[ch] += hp_c * (self.lp[ch] - self.hp[ch]);
                wet[ch] = self.lp[ch] - self.hp[ch];
            }
            match mode {
                1 => {
                    // Ping-pong: echoes bounce left, right, left...
                    self.lines[0].push((x[0] + x[1]) * 0.5 + fb * wet[1]);
                    self.lines[1].push(fb * wet[0]);
                }
                2 => {
                    // Tap: a single echo on the left, repeats on the right.
                    self.lines[0].push(x[0]);
                    self.lines[1].push(x[1] + fb * wet[1]);
                }
                _ => {
                    self.lines[0].push(x[0] + fb * wet[0]);
                    self.lines[1].push(x[1] + fb * wet[1]);
                }
            }
            l[s] = x[0] * dry_g + wet[0] * wet_g;
            r[s] = x[1] * dry_g + wet[1] * wet_g;
        }
        for ch in 0..2 {
            self.lp[ch] = sanitize(self.lp[ch]);
            self.hp[ch] = sanitize(self.hp[ch]);
        }
    }
}
