//! Small math helpers shared by the DSP modules.

pub const PI: f32 = core::f32::consts::PI;
pub const TAU: f32 = core::f32::consts::TAU;

/// Number of samples processed between modulation updates.
pub const BLOCK: usize = 32;

#[inline]
pub fn midi_to_hz(note: f32) -> f32 {
    440.0 * (2.0f32).powf((note - 69.0) / 12.0)
}

#[inline]
pub fn semitones_to_ratio(st: f32) -> f32 {
    (2.0f32).powf(st / 12.0)
}

#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    (10.0f32).powf(db / 20.0)
}

#[inline]
pub fn gain_to_db(g: f32) -> f32 {
    20.0 * g.max(1e-9).log10()
}

#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
pub fn clamp01(x: f32) -> f32 {
    x.max(0.0).min(1.0)
}

/// Cheap tanh approximation, accurate to ~2% and exactly bounded to ±1.
#[inline]
pub fn fast_tanh(x: f32) -> f32 {
    let x = x.max(-3.0).min(3.0);
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

/// Coefficient for a one-pole smoother reaching ~63% after `time_s`,
/// when called once every `step` samples.
#[inline]
pub fn smooth_coeff(time_s: f32, sr: f32, step: f32) -> f32 {
    if time_s <= 0.0 {
        1.0
    } else {
        1.0 - (-step / (time_s * sr)).exp()
    }
}

/// Equal-power pan. `pan` in -1..1, returns (left, right) gains whose
/// centre value is 1.0 (so a centred signal is not attenuated).
#[inline]
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let p = (pan.max(-1.0).min(1.0) + 1.0) * 0.25 * PI;
    (p.cos() * core::f32::consts::SQRT_2, p.sin() * core::f32::consts::SQRT_2)
}

/// Shaping curve shared by envelopes and LFO segments.
/// `t` in 0..1, `c` in -1..1. c > 0 moves fast first then settles
/// (like a natural decay), c < 0 starts slowly, c == 0 is a straight line.
#[inline]
pub fn curve_shape(t: f32, c: f32) -> f32 {
    let t = clamp01(t);
    let k = c * 10.0;
    if k.abs() < 1e-3 {
        t
    } else {
        (1.0 - (-k * t).exp()) / (1.0 - (-k).exp())
    }
}

/// xorshift32 random generator: tiny, fast and deterministic.
#[derive(Clone, Copy)]
pub struct Rng(pub u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(if seed == 0 { 0x9E37_79B9 } else { seed })
    }
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    #[inline]
    pub fn unipolar(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    /// Uniform in [-1, 1).
    #[inline]
    pub fn bipolar(&mut self) -> f32 {
        self.unipolar() * 2.0 - 1.0
    }
}

/// Flush denormals / NaN to zero so feedback paths cannot get stuck.
#[inline]
pub fn sanitize(x: f32) -> f32 {
    if x.is_finite() && x.abs() > 1e-20 {
        x
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midi_reference_pitch() {
        assert!((midi_to_hz(69.0) - 440.0).abs() < 1e-3);
        assert!((midi_to_hz(57.0) - 220.0).abs() < 1e-3);
    }

    #[test]
    fn curve_endpoints() {
        for c in [-1.0, -0.3, 0.0, 0.4, 1.0] {
            assert!(curve_shape(0.0, c).abs() < 1e-5);
            assert!((curve_shape(1.0, c) - 1.0).abs() < 1e-5);
        }
        assert!(curve_shape(0.5, 0.5) > 0.5);
        assert!(curve_shape(0.5, -0.5) < 0.5);
    }

    #[test]
    fn tanh_is_bounded() {
        assert!(fast_tanh(100.0) <= 1.0);
        assert!(fast_tanh(-100.0) >= -1.0);
        assert!((fast_tanh(0.5) - 0.5f32.tanh()).abs() < 0.02);
    }
}
