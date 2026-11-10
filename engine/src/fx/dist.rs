//! Distortion with an optional filter before or after the shaper.

use super::{Biquad, Ctx};
use crate::params::{dist, DIST_BASE};
use crate::util::{fast_tanh, PI};

pub struct Distortion {
    filt: [Biquad; 2],
    dc_x: [f32; 2],
    dc_y: [f32; 2],
    hold: [f32; 2],
    hold_phase: f32,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Tube,
    Soft,
    Hard,
    Diode,
    Fold,
    SineFold,
    Asym,
    Rectify,
    Bitcrush,
    Downsample,
}

impl Mode {
    fn from_index(i: usize) -> Mode {
        use Mode::*;
        [Tube, Soft, Hard, Diode, Fold, SineFold, Asym, Rectify, Bitcrush, Downsample][i.min(9)]
    }
}

#[inline]
fn shape(mode: Mode, x: f32) -> f32 {
    match mode {
        Mode::Tube => {
            if x >= 0.0 {
                fast_tanh(x)
            } else {
                fast_tanh(x * 0.6) / 0.6 * 0.8
            }
        }
        Mode::Soft => fast_tanh(x),
        Mode::Hard => x.max(-1.0).min(1.0),
        Mode::Diode => {
            if x >= 0.0 {
                fast_tanh(x)
            } else {
                fast_tanh(x * 0.15)
            }
        }
        Mode::Fold => {
            let t = x * 0.25 + 0.25;
            let t = t - t.floor();
            1.0 - 4.0 * (t - 0.5).abs()
        }
        Mode::SineFold => (x * PI * 0.5).sin(),
        Mode::Asym => {
            let t = fast_tanh(x);
            t + 0.4 * t * t
        }
        Mode::Rectify => fast_tanh(x).abs() * 2.0 - 1.0,
        Mode::Bitcrush | Mode::Downsample => x,
    }
}

impl Distortion {
    pub fn new() -> Self {
        Distortion { filt: [Biquad::default(); 2], dc_x: [0.0; 2], dc_y: [0.0; 2], hold: [0.0; 2], hold_phase: 1.0 }
    }

    pub fn clear(&mut self) {
        self.filt.iter_mut().for_each(|f| f.clear());
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
        self.hold = [0.0; 2];
        self.hold_phase = 1.0;
    }

    pub fn process(&mut self, c: &Ctx, l: &mut [f32], r: &mut [f32]) {
        let i = |p: usize| DIST_BASE + p;
        let mode = Mode::from_index(c.v(i(dist::MODE)) as usize);
        let drive = c.v(i(dist::DRIVE));
        let mix = c.v(i(dist::MIX));
        let filter_mode = c.v(i(dist::FILTER_MODE)) as usize;

        if filter_mode != 0 {
            let freq = c.v(i(dist::FILTER_FREQ));
            let q = 0.5 * (16.0f32).powf(c.v(i(dist::FILTER_Q)));
            for f in self.filt.iter_mut() {
                match c.v(i(dist::FILTER_TYPE)) as usize {
                    0 => f.lowpass(freq, q, c.sr),
                    1 => f.bandpass(freq, q, c.sr),
                    _ => f.highpass(freq, q, c.sr),
                }
            }
        }

        let (gain, comp) = match mode {
            Mode::Fold | Mode::SineFold => (1.0 + drive * 15.0, 0.8),
            Mode::Bitcrush | Mode::Downsample => (1.0, 1.0),
            _ => {
                let g = (10.0f32).powf(drive * 1.8);
                (g, 1.0 / g.powf(0.3))
            }
        };
        let levels = (2.0f32).powf(13.0 - drive * 12.0);
        let hold_inc = ((1.0 - drive).powi(3)).max(0.002);

        for s in 0..l.len() {
            let dry = [l[s], r[s]];
            let mut x = dry;
            if filter_mode == 1 {
                x[0] = self.filt[0].tick(x[0]);
                x[1] = self.filt[1].tick(x[1]);
            }
            match mode {
                Mode::Bitcrush => {
                    x[0] = (x[0] * levels).round() / levels;
                    x[1] = (x[1] * levels).round() / levels;
                }
                Mode::Downsample => {
                    self.hold_phase += hold_inc;
                    if self.hold_phase >= 1.0 {
                        self.hold_phase -= 1.0;
                        self.hold = x;
                    }
                    x = self.hold;
                }
                _ => {
                    for ch in 0..2 {
                        let y = shape(mode, x[ch] * gain) * comp;
                        // DC blocker: asymmetric shapers add an offset.
                        let out = y - self.dc_x[ch] + 0.9995 * self.dc_y[ch];
                        self.dc_x[ch] = y;
                        self.dc_y[ch] = out;
                        x[ch] = out;
                    }
                }
            }
            if filter_mode == 2 {
                x[0] = self.filt[0].tick(x[0]);
                x[1] = self.filt[1].tick(x[1]);
            }
            l[s] = dry[0] + (x[0] - dry[0]) * mix;
            r[s] = dry[1] + (x[1] - dry[1]) * mix;
        }
        self.filt.iter_mut().for_each(|f| f.flush());
        for ch in 0..2 {
            self.dc_y[ch] = crate::util::sanitize(self.dc_y[ch]);
        }
    }
}

impl Default for Distortion {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapers_are_bounded() {
        for m in 0..8 {
            let mode = Mode::from_index(m);
            for i in -400..=400 {
                let y = shape(mode, i as f32 * 0.25);
                assert!(y.is_finite() && y.abs() <= 1.5, "mode {m} x {} y {y}", i as f32 * 0.25);
            }
        }
    }

    #[test]
    fn fold_is_continuous_and_identity_near_zero() {
        assert!((shape(Mode::Fold, 0.3) - 0.3).abs() < 1e-5);
        assert!((shape(Mode::Fold, 1.5) - 0.5).abs() < 1e-5);
        assert!((shape(Mode::Fold, -1.5) + 0.5).abs() < 1e-5);
    }
}
