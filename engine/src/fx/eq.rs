//! Two-band equaliser.

use super::{Biquad, Ctx};
use crate::params::{eq, EQ_BASE};

pub struct Eq {
    low: [Biquad; 2],
    high: [Biquad; 2],
}

/// Knob position (0..1) to filter Q.
#[inline]
fn knob_to_q(v: f32) -> f32 {
    0.3 * (20.0f32).powf(v)
}

impl Eq {
    pub fn new() -> Self {
        Eq { low: [Biquad::default(); 2], high: [Biquad::default(); 2] }
    }

    pub fn clear(&mut self) {
        self.low.iter_mut().for_each(|f| f.clear());
        self.high.iter_mut().for_each(|f| f.clear());
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| EQ_BASE + p;
        let (lf, lq, lg) = (c.v(i(eq::LOW_FREQ)), knob_to_q(c.v(i(eq::LOW_Q))), c.v(i(eq::LOW_GAIN)));
        let (hf, hq, hg) = (c.v(i(eq::HIGH_FREQ)), knob_to_q(c.v(i(eq::HIGH_Q))), c.v(i(eq::HIGH_GAIN)));
        let low_type = c.v(i(eq::LOW_TYPE)) as usize;
        let high_type = c.v(i(eq::HIGH_TYPE)) as usize;
        for ch in 0..2 {
            match low_type {
                0 => self.low[ch].low_shelf(lf, lq.min(1.0), lg, c.sr),
                1 => self.low[ch].peak(lf, lq, lg, c.sr),
                _ => self.low[ch].highpass(lf, lq, c.sr),
            }
            match high_type {
                0 => self.high[ch].high_shelf(hf, hq.min(1.0), hg, c.sr),
                1 => self.high[ch].peak(hf, hq, hg, c.sr),
                _ => self.high[ch].lowpass(hf, hq, c.sr),
            }
        }
        for s in 0..l.len() {
            l[s] = self.high[0].tick(self.low[0].tick(l[s]));
            r[s] = self.high[1].tick(self.low[1].tick(r[s]));
        }
        self.low.iter_mut().for_each(|f| f.flush());
        self.high.iter_mut().for_each(|f| f.flush());
    }
}

impl Default for Eq {
    fn default() -> Self {
        Self::new()
    }
}
