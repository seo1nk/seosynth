//! Sub oscillator and noise generator.

use crate::util::{pan_gains, Rng, BLOCK, TAU};

// ---------------------------------------------------------------------------
// Sub oscillator
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SubShape {
    Sine,
    Round,
    Triangle,
    Saw,
    Square,
    Pulse,
}

impl SubShape {
    pub fn from_index(i: usize) -> SubShape {
        use SubShape::*;
        [Sine, Round, Triangle, Saw, Square, Pulse][i.min(5)]
    }
}

/// Polynomial band-limited step: smooths the discontinuity of naive
/// saw/square waves so they alias far less.
#[inline]
fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        2.0 * x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + 2.0 * x + 1.0
    } else {
        0.0
    }
}

#[inline]
pub fn sub_sample(shape: SubShape, t: f32, dt: f32) -> f32 {
    match shape {
        SubShape::Sine => (TAU * t).sin(),
        SubShape::Round => ((TAU * t).sin() * 2.5).tanh() * 1.0136,
        SubShape::Triangle => {
            let x = t + 0.25;
            let x = x - x.floor();
            1.0 - 4.0 * (x - 0.5).abs()
        }
        SubShape::Saw => {
            // Rising ramp through zero at phase 0 (jump at phase 0.5).
            let x = t + 0.5;
            let x = x - x.floor();
            2.0 * x - 1.0 - poly_blep(x, dt)
        }
        SubShape::Square => {
            let x2 = t + 0.5;
            let x2 = x2 - x2.floor();
            (if t < 0.5 { 1.0 } else { -1.0 }) + poly_blep(t, dt) - poly_blep(x2, dt)
        }
        SubShape::Pulse => {
            let d = 0.25;
            let x2 = t + 1.0 - d;
            let x2 = x2 - x2.floor();
            // Shifted to remove DC, then scaled back to a comparable peak.
            ((if t < d { 1.0 } else { -1.0 }) + poly_blep(t, dt) - poly_blep(x2, dt) + (1.0 - 2.0 * d)) * 0.8
        }
    }
}

#[derive(Clone, Default)]
pub struct SubState {
    phase: f32,
    inc: f32,
    gain_l: f32,
    gain_r: f32,
    started: bool,
}

impl SubState {
    pub fn reset(&mut self) {
        self.phase = 0.0;
        self.started = false;
    }

    pub fn process(&mut self, shape: SubShape, freq: f32, level: f32, pan: f32, sr: f32, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        let inv_n = 1.0 / n as f32;
        let inc_end = (freq / sr).min(0.45);
        let mut inc = if self.started { self.inc } else { inc_end };
        let dinc = (inc_end - inc) * inv_n;
        let (pl, pr) = pan_gains(pan);
        let (gl_end, gr_end) = (pl * level, pr * level);
        let (mut gl, mut gr) = if self.started { (self.gain_l, self.gain_r) } else { (gl_end, gr_end) };
        let dgl = (gl_end - gl) * inv_n;
        let dgr = (gr_end - gr) * inv_n;
        let mut ph = self.phase;
        for s in 0..n {
            let y = sub_sample(shape, ph, inc);
            out_l[s] = y * gl;
            out_r[s] = y * gr;
            ph += inc;
            if ph >= 1.0 {
                ph -= 1.0;
            }
            inc += dinc;
            gl += dgl;
            gr += dgr;
        }
        self.phase = ph;
        self.inc = inc_end;
        self.gain_l = gl_end;
        self.gain_r = gr_end;
        self.started = true;
    }
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum NoiseType {
    White,
    Pink,
    Brown,
    Digital,
    Crackle,
}

impl NoiseType {
    pub fn from_index(i: usize) -> NoiseType {
        use NoiseType::*;
        [White, Pink, Brown, Digital, Crackle][i.min(4)]
    }
}

#[derive(Clone)]
pub struct NoiseState {
    rng: Rng,
    pink: [[f32; 3]; 2],
    brown: [f32; 2],
    hold: [f32; 2],
    hold_phase: f32,
    crackle: [f32; 2],
    lp: [f32; 2],
    gain_l: f32,
    gain_r: f32,
    started: bool,
}

impl NoiseState {
    pub fn new(seed: u32) -> Self {
        NoiseState {
            rng: Rng::new(seed),
            pink: [[0.0; 3]; 2],
            brown: [0.0; 2],
            hold: [0.0; 2],
            hold_phase: 1.0,
            crackle: [0.0; 2],
            lp: [0.0; 2],
            gain_l: 0.0,
            gain_r: 0.0,
            started: false,
        }
    }

    pub fn reset(&mut self) {
        self.started = false;
        self.hold_phase = 1.0;
    }

    /// `tone` 0..1: brightness (low-pass) for the analogue colours, step rate
    /// for Digital, density for Crackle.
    pub fn process(&mut self, ty: NoiseType, level: f32, pan: f32, tone: f32, sr: f32, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        debug_assert!(n <= BLOCK);
        let tone = tone.max(0.0).min(1.0);
        let mut buf = [[0.0f32; BLOCK]; 2];

        match ty {
            NoiseType::White => {
                for s in 0..n {
                    buf[0][s] = self.rng.bipolar();
                    buf[1][s] = self.rng.bipolar();
                }
            }
            NoiseType::Pink => {
                for s in 0..n {
                    for c in 0..2 {
                        let w = self.rng.bipolar();
                        let b = &mut self.pink[c];
                        b[0] = 0.99765 * b[0] + w * 0.0990460;
                        b[1] = 0.96300 * b[1] + w * 0.2965164;
                        b[2] = 0.57000 * b[2] + w * 1.0526913;
                        buf[c][s] = (b[0] + b[1] + b[2] + w * 0.1848) * 0.25;
                    }
                }
            }
            NoiseType::Brown => {
                for s in 0..n {
                    for c in 0..2 {
                        let w = self.rng.bipolar();
                        self.brown[c] = (self.brown[c] + 0.02 * w) / 1.02;
                        buf[c][s] = self.brown[c] * 3.5;
                    }
                }
            }
            NoiseType::Digital => {
                let rate = 100.0 * (200.0f32).powf(tone);
                let inc = (rate / sr).min(1.0);
                for s in 0..n {
                    self.hold_phase += inc;
                    if self.hold_phase >= 1.0 {
                        self.hold_phase -= 1.0;
                        self.hold[0] = self.rng.bipolar();
                        self.hold[1] = self.rng.bipolar();
                    }
                    buf[0][s] = self.hold[0];
                    buf[1][s] = self.hold[1];
                }
            }
            NoiseType::Crackle => {
                let prob = 5.0 * (400.0f32).powf(tone) / sr;
                for s in 0..n {
                    for c in 0..2 {
                        let imp = if self.rng.unipolar() < prob { self.rng.bipolar() * 1.5 } else { 0.0 };
                        self.crackle[c] = self.crackle[c] * 0.55 + imp;
                        buf[c][s] = self.crackle[c];
                    }
                }
            }
        }

        // Brightness filter for the analogue colours.
        if matches!(ty, NoiseType::White | NoiseType::Pink | NoiseType::Brown) && tone < 0.999 {
            let fc = 80.0 * (250.0f32).powf(tone);
            let a = 1.0 - (-TAU * fc / sr).exp();
            for c in 0..2 {
                let mut z = self.lp[c];
                for v in buf[c][..n].iter_mut() {
                    z += a * (*v - z);
                    *v = z;
                }
                self.lp[c] = if z.abs() < 1e-20 { 0.0 } else { z };
            }
        }

        let inv_n = 1.0 / n as f32;
        let (pl, pr) = pan_gains(pan);
        let (gl_end, gr_end) = (pl * level, pr * level);
        let (mut gl, mut gr) = if self.started { (self.gain_l, self.gain_r) } else { (gl_end, gr_end) };
        let dgl = (gl_end - gl) * inv_n;
        let dgr = (gr_end - gr) * inv_n;
        for s in 0..n {
            out_l[s] = buf[0][s] * gl;
            out_r[s] = buf[1][s] * gr;
            gl += dgl;
            gr += dgr;
        }
        self.gain_l = gl_end;
        self.gain_r = gr_end;
        self.started = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_shapes_are_bounded_and_dc_free() {
        for i in 0..6 {
            let shape = SubShape::from_index(i);
            let mut st = SubState::default();
            let mut sum = 0.0f64;
            let mut peak = 0.0f32;
            let (mut l, mut r) = ([0.0; BLOCK], [0.0; BLOCK]);
            let blocks = 48_000 / BLOCK;
            for _ in 0..blocks {
                st.process(shape, 100.0, 1.0, 0.0, 48_000.0, &mut l, &mut r);
                for v in l.iter() {
                    sum += *v as f64;
                    peak = peak.max(v.abs());
                }
            }
            let mean = sum / (blocks * BLOCK) as f64;
            assert!(mean.abs() < 0.01, "{shape:?} dc {mean}");
            assert!(peak > 0.9 && peak < 1.3, "{shape:?} peak {peak}");
        }
    }

    #[test]
    fn noise_types_make_sound_without_blowing_up() {
        for i in 0..5 {
            let ty = NoiseType::from_index(i);
            let mut st = NoiseState::new(7);
            let mut energy = 0.0f64;
            let mut peak = 0.0f32;
            let (mut l, mut r) = ([0.0; BLOCK], [0.0; BLOCK]);
            for _ in 0..3000 {
                st.process(ty, 1.0, 0.0, 0.8, 48_000.0, &mut l, &mut r);
                for (a, b) in l.iter().zip(r.iter()) {
                    assert!(a.is_finite() && b.is_finite());
                    energy += (*a as f64).powi(2);
                    peak = peak.max(a.abs());
                }
            }
            assert!(energy > 1.0, "{ty:?} silent");
            assert!(peak < 3.0, "{ty:?} peak {peak}");
        }
    }
}
