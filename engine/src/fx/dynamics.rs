//! Compressor, single band or three bands.

use super::{Biquad, Ctx};
use crate::params::{comp, COMP_BASE};
use crate::util::db_to_gain;

const KNEE_DB: f32 = 6.0;
const LOW_SPLIT: f32 = 120.0;
const HIGH_SPLIT: f32 = 2500.0;

#[derive(Clone, Copy, Default)]
struct Detector {
    env: f32,
}

impl Detector {
    /// Returns the gain to apply for the given peak level.
    #[inline]
    fn gain(&mut self, peak: f32, att: f32, rel: f32, threshold: f32, ratio: f32) -> f32 {
        let c = if peak > self.env { att } else { rel };
        self.env += (peak - self.env) * c;
        if self.env < 1e-6 {
            self.env = self.env.max(0.0);
            return 1.0;
        }
        let over = 20.0 * self.env.log10() - threshold;
        let slope = 1.0 - 1.0 / ratio;
        let reduction = if over <= -KNEE_DB * 0.5 {
            0.0
        } else if over >= KNEE_DB * 0.5 {
            over * slope
        } else {
            let t = over + KNEE_DB * 0.5;
            slope * t * t / (2.0 * KNEE_DB)
        };
        db_to_gain(-reduction)
    }
}

pub struct Compressor {
    det: [Detector; 3],
    low: [Biquad; 2],
    high: [Biquad; 2],
    /// Gain reduction of the last block in dB (for a meter).
    pub reduction_db: f32,
}

impl Compressor {
    pub fn new() -> Self {
        Compressor { det: [Detector::default(); 3], low: [Biquad::default(); 2], high: [Biquad::default(); 2], reduction_db: 0.0 }
    }

    pub fn clear(&mut self) {
        self.det = [Detector::default(); 3];
        self.low.iter_mut().for_each(|f| f.clear());
        self.high.iter_mut().for_each(|f| f.clear());
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| COMP_BASE + p;
        let threshold = c.v(i(comp::THRESHOLD));
        let ratio = c.v(i(comp::RATIO));
        let att = 1.0 - (-1.0 / (c.v(i(comp::ATTACK)) * 0.001 * c.sr)).exp();
        let rel = 1.0 - (-1.0 / (c.v(i(comp::RELEASE)) * 0.001 * c.sr)).exp();
        let makeup = db_to_gain(c.v(i(comp::GAIN)));
        let mix = c.v(i(comp::MIX));
        let multiband = c.on(i(comp::MULTIBAND));
        let mut min_gain = 1.0f32;

        if multiband {
            for ch in 0..2 {
                self.low[ch].lowpass(LOW_SPLIT, 0.707, c.sr);
                self.high[ch].highpass(HIGH_SPLIT, 0.707, c.sr);
            }
        }

        for s in 0..l.len() {
            let dry = [l[s], r[s]];
            let out = if multiband {
                // Low and high are filtered out; whatever is left is the mid
                // band, so the three always add back up to the input.
                let lo = [self.low[0].tick(dry[0]), self.low[1].tick(dry[1])];
                let hi = [self.high[0].tick(dry[0]), self.high[1].tick(dry[1])];
                let mid = [dry[0] - lo[0] - hi[0], dry[1] - lo[1] - hi[1]];
                let mut sum = [0.0f32; 2];
                for (b, band) in [lo, mid, hi].iter().enumerate() {
                    let g = self.det[b].gain(band[0].abs().max(band[1].abs()), att, rel, threshold, ratio);
                    min_gain = min_gain.min(g);
                    sum[0] += band[0] * g;
                    sum[1] += band[1] * g;
                }
                sum
            } else {
                let g = self.det[0].gain(dry[0].abs().max(dry[1].abs()), att, rel, threshold, ratio);
                min_gain = min_gain.min(g);
                [dry[0] * g, dry[1] * g]
            };
            l[s] = dry[0] + (out[0] * makeup - dry[0]) * mix;
            r[s] = dry[1] + (out[1] * makeup - dry[1]) * mix;
        }
        self.reduction_db = -20.0 * min_gain.max(1e-6).log10();
        self.low.iter_mut().for_each(|f| f.flush());
        self.high.iter_mut().for_each(|f| f.flush());
    }
}

impl Default for Compressor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_curve_matches_ratio() {
        // A steady signal 12 dB over the threshold at 4:1 comes out 9 dB lower.
        let mut d = Detector::default();
        let level = db_to_gain(-6.0);
        let mut g = 1.0;
        for _ in 0..20_000 {
            g = d.gain(level, 0.01, 0.001, -18.0, 4.0);
        }
        let reduction = -20.0 * g.log10();
        assert!((reduction - 9.0).abs() < 0.1, "reduction {reduction}");
        // Well below the threshold nothing happens.
        let mut d = Detector::default();
        for _ in 0..20_000 {
            g = d.gain(db_to_gain(-40.0), 0.01, 0.001, -18.0, 4.0);
        }
        assert!((g - 1.0).abs() < 1e-4);
    }
}
