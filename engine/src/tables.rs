//! Factory wavetables, generated procedurally so the app ships no audio
//! assets. Each generator returns a stack of single-cycle frames; band
//! limiting and normalisation happen in `Wavetable::from_frames`.
//!
//! The list is append-only: presets refer to tables by name (files) or by
//! index (share URLs), so existing entries must keep their position.

use crate::fft::Fft;
use crate::util::{Rng, PI, TAU};
use crate::wavetable::TABLE_SIZE;

pub const TABLE_NAMES: &[&str] = &[
    "Basic Shapes",
    "Harmonic Rise",
    "Acid Sweep",
    "PWM",
    "Harmonic Series",
    "Organ",
    "Vowels",
    "FM Basic",
    "FM Triple",
    "FM Metal",
    "Sync Sweep",
    "Wavefold",
    "Bitcrush",
    "Spectral Clouds",
    "Hollow",
    "Damped String",
    "8-Bit",
    "Overdrive",
    "Glass",
    "Growl",
    "Dual Saw",
    "Octaves",
];

const MAX_H: usize = TABLE_SIZE / 2 - 1;

struct Gen {
    fft: Fft,
    re: Vec<f32>,
    im: Vec<f32>,
    out: Vec<f32>,
}

impl Gen {
    fn new() -> Self {
        Gen {
            fft: Fft::new(TABLE_SIZE),
            re: vec![0.0; TABLE_SIZE],
            im: vec![0.0; TABLE_SIZE],
            out: Vec::new(),
        }
    }

    /// Appends a frame built from harmonics: `f(h)` returns (amplitude, phase)
    /// for harmonic `h`, meaning `amplitude * sin(2 pi h t + phase)`.
    fn additive(&mut self, max_h: usize, f: impl Fn(usize) -> (f32, f32)) {
        self.re.iter_mut().for_each(|v| *v = 0.0);
        self.im.iter_mut().for_each(|v| *v = 0.0);
        let n = TABLE_SIZE as f32;
        for h in 1..=max_h.min(MAX_H) {
            let (a, ph) = f(h);
            if a == 0.0 {
                continue;
            }
            let re = 0.5 * a * ph.sin() * n;
            let im = -0.5 * a * ph.cos() * n;
            self.re[h] = re;
            self.im[h] = im;
            self.re[TABLE_SIZE - h] = re;
            self.im[TABLE_SIZE - h] = -im;
        }
        self.fft.inverse(&mut self.re, &mut self.im);
        self.out.extend_from_slice(&self.re);
    }

    /// Appends a frame sampled from a function of phase (0..1).
    fn time(&mut self, f: impl Fn(f32) -> f32) {
        for i in 0..TABLE_SIZE {
            self.out.push(f(i as f32 / TABLE_SIZE as f32));
        }
    }
}

#[inline]
fn saw_h(h: usize) -> f32 {
    let sign = if h % 2 == 1 { 1.0 } else { -1.0 };
    sign * 2.0 / (PI * h as f32)
}

#[inline]
fn square_h(h: usize) -> f32 {
    if h % 2 == 1 {
        4.0 / (PI * h as f32)
    } else {
        0.0
    }
}

#[inline]
fn tri_h(h: usize) -> f32 {
    if h % 2 == 1 {
        let sign = if (h / 2) % 2 == 0 { 1.0 } else { -1.0 };
        sign * 8.0 / (PI * PI * (h * h) as f32)
    } else {
        0.0
    }
}

/// Pulse wave with duty cycle `d`: (amplitude, phase) of harmonic `h`.
#[inline]
fn pulse_h(h: usize, d: f32) -> (f32, f32) {
    let hf = h as f32;
    (4.0 / (PI * hf) * (PI * hf * d).sin(), PI * 0.5 - PI * hf * d)
}

fn frames_t(frames: usize, i: usize) -> f32 {
    if frames <= 1 {
        0.0
    } else {
        i as f32 / (frames - 1) as f32
    }
}

pub fn generate(index: usize) -> (usize, Vec<f32>) {
    let mut g = Gen::new();
    match index {
        0 => basic_shapes(&mut g),
        1 => harmonic_rise(&mut g),
        2 => acid_sweep(&mut g),
        3 => pwm(&mut g),
        4 => harmonic_series(&mut g),
        5 => organ(&mut g),
        6 => vowels(&mut g),
        7 => fm(&mut g, 1.0, 6.0),
        8 => fm(&mut g, 3.0, 5.0),
        9 => fm_metal(&mut g),
        10 => sync_sweep(&mut g),
        11 => wavefold(&mut g),
        12 => bitcrush(&mut g),
        13 => spectral_clouds(&mut g),
        14 => hollow(&mut g),
        15 => damped_string(&mut g),
        16 => eight_bit(&mut g),
        17 => overdrive(&mut g),
        18 => glass(&mut g),
        19 => growl(&mut g),
        20 => dual_saw(&mut g),
        _ => octaves(&mut g),
    }
    (g.out.len() / TABLE_SIZE, g.out)
}

/// Sine -> triangle -> saw -> square -> pulse. The classic starting point.
fn basic_shapes(g: &mut Gen) {
    g.additive(1, |_| (1.0, 0.0));
    g.additive(MAX_H, |h| (tri_h(h), 0.0));
    g.additive(MAX_H, |h| (saw_h(h), 0.0));
    g.additive(MAX_H, |h| (square_h(h), 0.0));
    g.additive(MAX_H, |h| pulse_h(h, 0.25));
}

/// A saw whose harmonics are added one octave at a time: position works like
/// a built-in low-pass filter opening up.
fn harmonic_rise(g: &mut Gen) {
    let frames = 32;
    for i in 0..frames {
        let t = frames_t(frames, i);
        let cutoff = (2.0f32).powf(t * 9.0);
        g.additive(MAX_H, |h| {
            let r = h as f32 / cutoff;
            let gain = 1.0 / (1.0 + r.powi(6)).sqrt();
            (saw_h(h) * gain, 0.0)
        });
    }
}

/// Saw through a resonant low-pass sweep (the "acid" squelch).
fn acid_sweep(g: &mut Gen) {
    let frames = 48;
    let q = 7.0;
    for i in 0..frames {
        let t = frames_t(frames, i);
        let cutoff = 1.5 * (2.0f32).powf(t * 6.5);
        g.additive(MAX_H, |h| {
            let r = h as f32 / cutoff;
            let mag = 1.0 / ((1.0 - r * r).powi(2) + (r / q).powi(2)).sqrt();
            (saw_h(h) * mag, 0.0)
        });
    }
}

/// Pulse width from 50% (square) down to a thin 3% pulse.
fn pwm(g: &mut Gen) {
    let frames = 32;
    for i in 0..frames {
        let d = 0.5 - 0.47 * frames_t(frames, i);
        g.additive(MAX_H, |h| pulse_h(h, d));
    }
}

/// One pure harmonic per frame, 1st to 16th.
fn harmonic_series(g: &mut Gen) {
    for n in 1..=16 {
        g.additive(n, |h| (if h == n { 1.0 } else { 0.0 }, 0.0));
    }
}

/// Drawbar-organ registrations.
fn organ(g: &mut Gen) {
    const HARM: [usize; 7] = [1, 2, 3, 4, 5, 6, 8];
    const REG: [[f32; 7]; 6] = [
        [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [1.0, 0.5, 0.0, 0.2, 0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0],
        [1.0, 0.8, 0.6, 0.8, 0.0, 0.3, 0.2],
        [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        [0.4, 0.3, 0.6, 1.0, 0.8, 1.0, 1.0],
    ];
    for reg in REG.iter() {
        g.additive(8, |h| match HARM.iter().position(|&x| x == h) {
            Some(k) => (reg[k], 0.0),
            None => (0.0, 0.0),
        });
    }
}

const VOWELS: [[(f32, f32, f32); 3]; 5] = [
    [(700.0, 1.0, 110.0), (1220.0, 0.5, 130.0), (2600.0, 0.3, 170.0)], // A
    [(400.0, 1.0, 100.0), (2000.0, 0.4, 150.0), (2600.0, 0.3, 170.0)], // E
    [(270.0, 1.0, 90.0), (2300.0, 0.35, 150.0), (3000.0, 0.25, 170.0)], // I
    [(450.0, 1.0, 100.0), (800.0, 0.5, 120.0), (2830.0, 0.15, 150.0)], // O
    [(325.0, 1.0, 80.0), (700.0, 0.4, 100.0), (2530.0, 0.1, 150.0)],   // U
];

fn formant_gain(freq: f32, formants: &[(f32, f32, f32); 3]) -> f32 {
    formants
        .iter()
        .map(|&(f, a, bw)| {
            let d = (freq - f) / bw;
            a / (1.0 + d * d)
        })
        .sum()
}

/// A - E - I - O - U, gliding the formants between vowels.
fn vowels(g: &mut Gen) {
    let frames = 33;
    let f0 = 110.0;
    for i in 0..frames {
        let p = frames_t(frames, i) * 4.0;
        let a = (p as usize).min(3);
        let m = p - a as f32;
        let mut fm = [(0.0, 0.0, 0.0); 3];
        for k in 0..3 {
            let (x, y) = (VOWELS[a][k], VOWELS[a + 1][k]);
            fm[k] = (x.0 + (y.0 - x.0) * m, x.1 + (y.1 - x.1) * m, x.2 + (y.2 - x.2) * m);
        }
        g.additive(160, |h| {
            let src = 1.0 / (h as f32).powf(0.7);
            let sign = if h % 2 == 1 { 1.0 } else { -1.0 };
            (sign * src * (0.02 + formant_gain(h as f32 * f0, &fm)), 0.0)
        });
    }
}

/// Two-operator FM: a sine carrier modulated by a sine at `ratio`, the
/// modulation index rising with table position.
fn fm(g: &mut Gen, ratio: f32, max_index: f32) {
    let frames = 32;
    for i in 0..frames {
        let index = max_index * frames_t(frames, i);
        g.time(|p| (TAU * p + index * (TAU * ratio * p).sin()).sin());
    }
}

fn fm_metal(g: &mut Gen) {
    let frames = 32;
    for i in 0..frames {
        let t = frames_t(frames, i);
        g.time(|p| {
            let m2 = (TAU * 2.0 * p).sin() * t * 1.5;
            let m1 = (TAU * 7.0 * p + m2).sin() * (0.3 + t * 3.5);
            (TAU * p + m1).sin()
        });
    }
}

/// Hard-sync style sweep: a faster sine restarted every cycle, faded out
/// towards the end of the cycle so the restart does not click.
fn sync_sweep(g: &mut Gen) {
    let frames = 48;
    for i in 0..frames {
        let ratio = 1.0 + 11.0 * frames_t(frames, i);
        g.time(|p| {
            let w = (PI * 0.5 * p).cos();
            (TAU * ratio * p).sin() * w * w
        });
    }
}

/// A sine pushed through a wavefolder with rising drive.
fn wavefold(g: &mut Gen) {
    let frames = 32;
    for i in 0..frames {
        let drive = 1.0 + 7.0 * frames_t(frames, i);
        g.time(|p| (drive * (TAU * p).sin() * PI * 0.5).sin());
    }
}

/// A sine with fewer and fewer amplitude and time steps.
fn bitcrush(g: &mut Gen) {
    let frames = 16;
    for i in 0..frames {
        let t = frames_t(frames, i);
        let levels = (2.0f32).powf(6.0 - 5.0 * t).round().max(2.0);
        let steps = (2.0f32).powf(8.0 - 6.0 * t).round().max(4.0);
        g.time(|p| {
            let ps = ((p * steps).floor() + 0.5) / steps;
            let s = (TAU * ps).sin();
            ((s * 0.5 + 0.5) * (levels - 1.0)).round() / (levels - 1.0) * 2.0 - 1.0
        });
    }
}

/// Random spectra that drift from frame to frame.
fn spectral_clouds(g: &mut Gen) {
    let frames = 16;
    let harmonics = 64;
    let mut rng = Rng::new(0x5EED_1234);
    let phases: Vec<f32> = (0..=harmonics).map(|_| rng.unipolar() * TAU).collect();
    for i in 0..frames {
        let tilt = 0.6 + 0.5 * frames_t(frames, frames - 1 - i);
        let amps: Vec<f32> = (0..=harmonics)
            .map(|h| {
                let r = rng.unipolar();
                if h == 0 {
                    0.0
                } else {
                    r * r * r / (h as f32).powf(tilt)
                }
            })
            .collect();
        g.additive(harmonics, |h| (amps[h] + if h == 1 { 0.4 } else { 0.0 }, phases[h]));
    }
}

/// Odd harmonics only (hollow, clarinet-like) -> all -> even-heavy.
fn hollow(g: &mut Gen) {
    let frames = 24;
    for i in 0..frames {
        let t = frames_t(frames, i);
        g.additive(MAX_H, |h| {
            let base = saw_h(h);
            let even = h % 2 == 0;
            let gain = if t < 0.5 {
                if even {
                    t * 2.0
                } else {
                    1.0
                }
            } else if even || h == 1 {
                1.0
            } else {
                1.0 - (t - 0.5) * 2.0
            };
            (base * gain, 0.0)
        });
    }
}

/// Like a plucked string ringing out, played backwards: position 0 is the
/// mellow tail, position 1 the bright attack.
fn damped_string(g: &mut Gen) {
    let frames = 32;
    for i in 0..frames {
        let damp = (1.0 - frames_t(frames, i)).powi(2) * 0.9;
        g.additive(MAX_H, |h| {
            let hf = h as f32;
            (saw_h(h).abs() * (-damp * (hf - 1.0)).exp(), 0.13 * hf)
        });
    }
}

/// Game-console pulses and a stepped triangle.
fn eight_bit(g: &mut Gen) {
    for d in [0.125f32, 0.25, 0.5] {
        g.time(|p| if p < d { 1.0 } else { -1.0 });
    }
    g.time(|p| {
        let tri = if p < 0.5 { p * 4.0 - 1.0 } else { 3.0 - p * 4.0 };
        (tri * 7.5).round() / 7.5
    });
}

/// A sine driven harder and harder into saturation.
fn overdrive(g: &mut Gen) {
    let frames = 24;
    for i in 0..frames {
        let t = frames_t(frames, i);
        let drive = 0.5 + 30.0 * t * t;
        g.time(|p| {
            let s = (TAU * p).sin() + 0.25 * t * (TAU * 2.0 * p).sin();
            (drive * s).tanh()
        });
    }
}

/// Sparse, widely spaced partials with a moving emphasis.
fn glass(g: &mut Gen) {
    const PARTIALS: [usize; 9] = [1, 3, 6, 10, 15, 21, 28, 36, 45];
    let frames = 24;
    for i in 0..frames {
        let centre = frames_t(frames, i) * (PARTIALS.len() - 1) as f32;
        g.additive(48, |h| match PARTIALS.iter().position(|&x| x == h) {
            Some(k) => {
                let d = k as f32 - centre;
                let bump = (-d * d * 0.35).exp();
                let base = if k == 0 { 0.5 } else { 0.08 };
                (base + bump, k as f32 * 1.7)
            }
            None => (0.0, 0.0),
        });
    }
}

/// Two narrow formants sweeping against each other over a strong fundamental.
fn growl(g: &mut Gen) {
    let frames = 32;
    let f0 = 55.0;
    for i in 0..frames {
        let t = frames_t(frames, i);
        let f1 = 280.0 + 700.0 * (PI * t).sin();
        let f2 = 2300.0 - 1400.0 * t;
        let fm = [(f1, 1.0, 70.0), (f2, 0.6, 110.0), (3200.0, 0.15, 200.0)];
        g.additive(200, |h| {
            let src = 1.0 / (h as f32).powf(0.5);
            let fund = if h <= 2 { 0.6 } else { 0.0 };
            let sign = if h % 2 == 1 { 1.0 } else { -1.0 };
            (sign * (src * formant_gain(h as f32 * f0, &fm) + fund), 0.0)
        });
    }
}

/// Two saws sliding against each other in phase.
fn dual_saw(g: &mut Gen) {
    let frames = 32;
    for i in 0..frames {
        let offset = 0.5 * frames_t(frames, i);
        g.additive(MAX_H, |h| {
            // Sum of two equal sinusoids with a phase offset.
            let d = TAU * h as f32 * offset;
            (saw_h(h) * 2.0 * (d * 0.5).cos(), d * 0.5)
        });
    }
}

/// Stacks octaves on top of the fundamental one at a time.
fn octaves(g: &mut Gen) {
    for top in 0..6 {
        g.additive(32, |h| {
            if h.is_power_of_two() && h.trailing_zeros() <= top {
                (1.0 / (h as f32).sqrt(), 0.0)
            } else {
                (0.0, 0.0)
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_generates_valid_frames() {
        for (i, name) in TABLE_NAMES.iter().enumerate() {
            let (frames, data) = generate(i);
            assert!(frames >= 1, "{name}");
            assert_eq!(data.len(), frames * TABLE_SIZE, "{name}");
            assert!(data.iter().all(|v| v.is_finite()), "{name} has non-finite samples");
            for f in 0..frames {
                let peak = data[f * TABLE_SIZE..(f + 1) * TABLE_SIZE]
                    .iter()
                    .fold(0.0f32, |m, v| m.max(v.abs()));
                assert!(peak > 1e-3, "{name} frame {f} is silent");
            }
        }
    }

    #[test]
    fn additive_saw_matches_ramp() {
        let mut g = Gen::new();
        g.additive(MAX_H, |h| (saw_h(h), 0.0));
        // Rising ramp through zero at phase 0, jump at phase 0.5.
        let at = |p: f32| g.out[(p * TABLE_SIZE as f32) as usize];
        assert!((at(0.25) - 0.5).abs() < 0.02);
        assert!((at(0.75) + 0.5).abs() < 0.02);
        assert!(at(0.0).abs() < 0.02);
    }

    #[test]
    fn additive_pulse_has_requested_duty() {
        let mut g = Gen::new();
        g.additive(MAX_H, |h| pulse_h(h, 0.25));
        let high = g.out.iter().filter(|v| **v > 0.0).count() as f32 / TABLE_SIZE as f32;
        assert!((high - 0.25).abs() < 0.01, "duty {high}");
    }
}
