//! Multi-mode stereo filter. Used once per voice and once more as a master
//! effect.

use crate::fft::Fft;
use crate::util::{fast_tanh, sanitize, PI, TAU};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum FilterType {
    Lp6,
    Lp12,
    Lp24,
    Ladder12,
    Ladder24,
    Hp6,
    Hp12,
    Hp24,
    Bp12,
    Bp24,
    Notch,
    Peak,
    Morph,
    CombPlus,
    CombMinus,
    Phaser,
    Formant,
    Reduce,
    Ring,
}

impl FilterType {
    pub fn from_index(i: usize) -> FilterType {
        use FilterType::*;
        const ALL: [FilterType; 19] = [
            Lp6, Lp12, Lp24, Ladder12, Ladder24, Hp6, Hp12, Hp24, Bp12, Bp24, Notch, Peak, Morph,
            CombPlus, CombMinus, Phaser, Formant, Reduce, Ring,
        ];
        ALL[i.min(ALL.len() - 1)]
    }

    /// False for the types that are not linear filters, where a frequency
    /// response curve would be meaningless.
    pub fn has_response(self) -> bool {
        !matches!(self, FilterType::Reduce | FilterType::Ring)
    }
}

pub struct FilterParams {
    pub ty: FilterType,
    pub cutoff: f32,
    pub res: f32,
    pub drive: f32,
    pub var: f32,
    pub mix: f32,
    /// -1..1: detunes the cutoff of the two channels in opposite directions.
    pub stereo: f32,
    pub sr: f32,
}

/// Trapezoidal state-variable filter (Cytomic / Zavalishin form).
#[derive(Clone, Copy, Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    /// Returns (low, band, high) for input `v0`, with `g = tan(pi fc / sr)`
    /// and damping `k = 1 / Q`.
    #[inline(always)]
    fn tick(&mut self, v0: f32, g: f32, k: f32) -> (f32, f32, f32) {
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let v3 = v0 - self.ic2;
        let v1 = a1 * self.ic1 + a2 * v3;
        let v2 = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v1, v0 - k * v1 - v2)
    }
}

const COMB_LEN: usize = 4096;
const PHASER_STAGES: usize = 6;

#[derive(Clone)]
struct Channel {
    svf: [Svf; 3],
    ladder: [f32; 4],
    one_pole: f32,
    ap: [f32; PHASER_STAGES],
    ap_last: f32,
    comb: Vec<f32>,
    comb_pos: usize,
    comb_lp: f32,
    comb_delay: f32,
    hold: f32,
    hold_phase: f32,
    ring_phase: f32,
    g: f32,
}

impl Default for Channel {
    fn default() -> Self {
        Channel {
            svf: [Svf::default(); 3],
            ladder: [0.0; 4],
            one_pole: 0.0,
            ap: [0.0; PHASER_STAGES],
            ap_last: 0.0,
            comb: Vec::new(),
            comb_pos: 0,
            comb_lp: 0.0,
            comb_delay: 0.0,
            hold: 0.0,
            hold_phase: 1.0,
            ring_phase: 0.0,
            g: 0.0,
        }
    }
}

impl Channel {
    fn clear(&mut self) {
        self.svf = [Svf::default(); 3];
        self.ladder = [0.0; 4];
        self.one_pole = 0.0;
        self.ap = [0.0; PHASER_STAGES];
        self.ap_last = 0.0;
        self.comb.iter_mut().for_each(|v| *v = 0.0);
        self.comb_lp = 0.0;
        self.hold = 0.0;
        self.hold_phase = 1.0;
        self.ring_phase = 0.0;
    }

    fn flush(&mut self) {
        for s in self.svf.iter_mut() {
            s.ic1 = sanitize(s.ic1);
            s.ic2 = sanitize(s.ic2);
        }
        for v in self.ladder.iter_mut() {
            *v = sanitize(*v);
        }
        for v in self.ap.iter_mut() {
            *v = sanitize(*v);
        }
        self.one_pole = sanitize(self.one_pole);
        self.ap_last = sanitize(self.ap_last);
        self.comb_lp = sanitize(self.comb_lp);
    }
}

#[derive(Clone, Default)]
pub struct Filter {
    ch: [Channel; 2],
    started: bool,
    last_ty: Option<FilterType>,
}

const VOWELS: [[f32; 3]; 5] = [
    [800.0, 1150.0, 2900.0],
    [400.0, 2000.0, 2600.0],
    [270.0, 2300.0, 3000.0],
    [450.0, 800.0, 2830.0],
    [325.0, 700.0, 2700.0],
];

/// Resonance (0..1) to Q for a single 2-pole section.
#[inline]
fn res_to_q(res: f32) -> f32 {
    0.5 * (60.0f32).powf(res.max(0.0).min(1.0))
}

impl Filter {
    pub fn reset(&mut self) {
        for c in self.ch.iter_mut() {
            c.clear();
        }
        self.started = false;
    }

    pub fn process(&mut self, p: &FilterParams, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        if n == 0 {
            return;
        }
        if self.last_ty != Some(p.ty) {
            // Different topology: old state would be meaningless (or loud).
            for c in self.ch.iter_mut() {
                c.clear();
            }
            self.last_ty = Some(p.ty);
            self.started = false;
        }
        let started = self.started;
        let res = p.res.max(0.0).min(1.0);
        let var = p.var.max(0.0).min(1.0);
        let mix = p.mix.max(0.0).min(1.0);
        let drive = p.drive.max(0.0).min(1.0);
        let max_fc = (p.sr * 0.46).min(21_000.0);

        for (ci, buf) in [left, right].into_iter().enumerate() {
            let ch = &mut self.ch[ci];
            let spread = if ci == 0 { -p.stereo } else { p.stereo };
            let fc = (p.cutoff * (2.0f32).powf(spread * 2.0)).max(16.0).min(max_fc);
            let g_end = (PI * fc / p.sr).tan();
            let mut g = if started { ch.g } else { g_end };
            let dg = (g_end - g) / n as f32;
            ch.g = g_end;

            let mut dry = [0.0f32; crate::util::BLOCK];
            let keep_dry = mix < 0.999 && n <= dry.len();
            if keep_dry {
                dry[..n].copy_from_slice(buf);
            }

            if drive > 0.001 && !matches!(p.ty, FilterType::Ladder12 | FilterType::Ladder24) {
                let d = 1.0 + drive * 7.0;
                let comp = 1.0 / d.sqrt();
                let amt = (drive * 8.0).min(1.0);
                for v in buf.iter_mut() {
                    let sat = fast_tanh(*v * d) * comp;
                    *v += (sat - *v) * amt;
                }
            }

            match p.ty {
                FilterType::Lp6 | FilterType::Hp6 => {
                    let hp = p.ty == FilterType::Hp6;
                    for v in buf.iter_mut() {
                        let gg = g / (1.0 + g);
                        let d = (*v - ch.one_pole) * gg;
                        let lp = d + ch.one_pole;
                        ch.one_pole = lp + d;
                        *v = if hp { *v - lp } else { lp };
                        g += dg;
                    }
                }
                FilterType::Lp12 | FilterType::Hp12 | FilterType::Bp12 | FilterType::Notch => {
                    let k = 1.0 / res_to_q(res);
                    let bp_gain = k * (1.0 + res * 1.5);
                    for v in buf.iter_mut() {
                        let (lo, bd, hi) = ch.svf[0].tick(*v, g, k);
                        *v = match p.ty {
                            FilterType::Lp12 => lo,
                            FilterType::Hp12 => hi,
                            FilterType::Bp12 => bd * bp_gain,
                            _ => lo + hi,
                        };
                        g += dg;
                    }
                }
                FilterType::Lp24 | FilterType::Hp24 | FilterType::Bp24 => {
                    // Two cascaded sections. At zero resonance they form a
                    // 4th-order Butterworth; resonance sharpens the second.
                    let k1 = 1.0 / (0.541 * (1.0 + res));
                    let k2 = 1.0 / (1.307 * (40.0f32).powf(res));
                    let bp_gain = k1 * k2 * (1.0 + res * 3.0) * 2.0;
                    for v in buf.iter_mut() {
                        let (l1, b1, h1) = ch.svf[0].tick(*v, g, k1);
                        *v = match p.ty {
                            FilterType::Lp24 => ch.svf[1].tick(l1, g, k2).0,
                            FilterType::Hp24 => ch.svf[1].tick(h1, g, k2).2,
                            _ => ch.svf[1].tick(b1, g, k2).1 * bp_gain,
                        };
                        g += dg;
                    }
                }
                FilterType::Peak => {
                    let k = 0.5;
                    let gain = (10.0f32).powf(res * 24.0 / 20.0) - 1.0;
                    for v in buf.iter_mut() {
                        let (_, bd, _) = ch.svf[0].tick(*v, g, k);
                        *v += gain * k * bd;
                        g += dg;
                    }
                }
                FilterType::Morph => {
                    let k = 1.0 / res_to_q(res);
                    let bp_gain = k * (1.0 + res * 1.5);
                    for v in buf.iter_mut() {
                        let (lo, bd, hi) = ch.svf[0].tick(*v, g, k);
                        let bd = bd * bp_gain;
                        *v = if var < 0.5 {
                            lo + (bd - lo) * (var * 2.0)
                        } else {
                            bd + (hi - bd) * ((var - 0.5) * 2.0)
                        };
                        g += dg;
                    }
                }
                FilterType::Ladder12 | FilterType::Ladder24 => {
                    let k = res * 3.9;
                    let pre = 0.6 * (1.0 + drive * 6.0);
                    let post = (1.0 + 0.5 * k) / (0.6 * (1.0 + drive * 6.0).sqrt());
                    let two_pole = p.ty == FilterType::Ladder12;
                    let s = &mut ch.ladder;
                    for v in buf.iter_mut() {
                        let beta = 1.0 / (1.0 + g);
                        let gg = g * beta;
                        let fb = beta * (gg * gg * gg * s[0] + gg * gg * s[1] + gg * s[2] + s[3]);
                        let u = fast_tanh((*v * pre - k * fb) / (1.0 + k * gg * gg * gg * gg));
                        let d1 = (u - s[0]) * gg;
                        let y1 = d1 + s[0];
                        s[0] = y1 + d1;
                        let d2 = (y1 - s[1]) * gg;
                        let y2 = d2 + s[1];
                        s[1] = y2 + d2;
                        let d3 = (y2 - s[2]) * gg;
                        let y3 = d3 + s[2];
                        s[2] = y3 + d3;
                        let d4 = (y3 - s[3]) * gg;
                        let y4 = d4 + s[3];
                        s[3] = y4 + d4;
                        *v = (if two_pole { y2 } else { y4 }) * post;
                        g += dg;
                    }
                }
                FilterType::CombPlus | FilterType::CombMinus => {
                    if ch.comb.len() != COMB_LEN {
                        ch.comb = vec![0.0; COMB_LEN];
                        ch.comb_pos = 0;
                    }
                    let sign = if p.ty == FilterType::CombPlus { 1.0 } else { -1.0 };
                    let fb = sign * res * 0.97;
                    let d_end = (p.sr / fc).max(2.0).min((COMB_LEN - 4) as f32);
                    let mut d = if started && ch.comb_delay > 0.0 { ch.comb_delay } else { d_end };
                    let dd = (d_end - d) / n as f32;
                    ch.comb_delay = d_end;
                    let damp = 1.0 - var * 0.9;
                    let out_gain = 1.0 - 0.5 * fb.abs();
                    for v in buf.iter_mut() {
                        let rp = ch.comb_pos as f32 + COMB_LEN as f32 - d;
                        let i = rp as usize;
                        let fr = rp - i as f32;
                        let a = ch.comb[i & (COMB_LEN - 1)];
                        let b = ch.comb[(i + 1) & (COMB_LEN - 1)];
                        let delayed = a + (b - a) * fr;
                        ch.comb_lp += damp * (delayed - ch.comb_lp);
                        let y = *v + fb * ch.comb_lp;
                        ch.comb[ch.comb_pos] = y;
                        ch.comb_pos = (ch.comb_pos + 1) & (COMB_LEN - 1);
                        *v = y * out_gain;
                        d += dd;
                    }
                }
                FilterType::Phaser => {
                    let fb = res * 0.9;
                    let mut coef = [0.0f32; PHASER_STAGES];
                    for (j, c) in coef.iter_mut().enumerate() {
                        let m = (2.0f32).powf((j as f32 - 2.5) * var * 0.8);
                        let gj = (g_end * m).min(20.0);
                        *c = (gj - 1.0) / (gj + 1.0);
                    }
                    for v in buf.iter_mut() {
                        let x = *v + fb * ch.ap_last;
                        let mut y = x;
                        for j in 0..PHASER_STAGES {
                            let o = coef[j] * y + ch.ap[j];
                            ch.ap[j] = y - coef[j] * o;
                            y = o;
                        }
                        ch.ap_last = y;
                        *v = 0.5 * (*v + y);
                    }
                }
                FilterType::Formant => {
                    let pos = var * 4.0;
                    let a = (pos as usize).min(3);
                    let m = pos - a as f32;
                    let shift = (fc / 1000.0).sqrt();
                    let k = 1.0 / (4.0 + res * 20.0);
                    let gains = [1.0f32, 0.5, 0.25];
                    let mut gs = [0.0f32; 3];
                    for j in 0..3 {
                        let f = (VOWELS[a][j] + (VOWELS[a + 1][j] - VOWELS[a][j]) * m) * shift;
                        gs[j] = (PI * f.min(max_fc) / p.sr).tan();
                    }
                    let makeup = 2.5 * k * (4.0 + res * 20.0).sqrt();
                    for v in buf.iter_mut() {
                        let x = *v;
                        let mut y = 0.0;
                        for j in 0..3 {
                            y += ch.svf[j].tick(x, gs[j], k).1 * gains[j];
                        }
                        *v = y * makeup;
                    }
                }
                FilterType::Reduce => {
                    let inc = (fc * 2.0 / p.sr).min(1.0);
                    let q = (2.0f32).powf(15.0 - res * 13.0);
                    for v in buf.iter_mut() {
                        ch.hold_phase += inc;
                        if ch.hold_phase >= 1.0 {
                            ch.hold_phase -= 1.0;
                            ch.hold = (*v * q).round() / q;
                        }
                        *v = ch.hold;
                    }
                }
                FilterType::Ring => {
                    let inc = fc / p.sr;
                    for v in buf.iter_mut() {
                        *v *= (TAU * ch.ring_phase).sin();
                        ch.ring_phase += inc;
                        if ch.ring_phase >= 1.0 {
                            ch.ring_phase -= 1.0;
                        }
                    }
                }
            }

            if keep_dry {
                for (v, d) in buf.iter_mut().zip(dry.iter()) {
                    *v = *d + (*v - *d) * mix;
                }
            }
            ch.flush();
        }
        self.started = true;
    }

    /// Magnitude response in dB at `out.len()` log-spaced frequencies from
    /// 20 Hz to 20 kHz, measured by running an impulse through a fresh filter
    /// (so the picture always matches what the audio path does).
    pub fn response(ty: FilterType, cutoff: f32, res: f32, var: f32, sr: f32, out: &mut [f32]) {
        const N: usize = 8192;
        let mut f = Filter::default();
        let p = FilterParams { ty, cutoff, res, drive: 0.0, var, mix: 1.0, stereo: 0.0, sr };
        let mut re = vec![0.0f32; N];
        let mut im = vec![0.0f32; N];
        let mut scratch = vec![0.0f32; N];
        // Small impulse keeps the saturating types in their linear range.
        let amp = 0.001;
        re[0] = amp;
        for (a, b) in re.chunks_mut(crate::util::BLOCK).zip(scratch.chunks_mut(crate::util::BLOCK)) {
            f.process(&p, a, b);
        }
        // Fade the tail so a still-ringing resonance does not smear.
        for (i, v) in re.iter_mut().enumerate() {
            let t = i as f32 / N as f32;
            if t > 0.5 {
                let w = 0.5 + 0.5 * (PI * (t - 0.5) * 2.0).cos();
                *v *= w;
            }
        }
        Fft::new(N).forward(&mut re, &mut im);
        let count = out.len();
        for (i, o) in out.iter_mut().enumerate() {
            let t = if count > 1 { i as f32 / (count - 1) as f32 } else { 0.0 };
            let freq = 20.0 * (1000.0f32).powf(t);
            let x = (freq * N as f32 / sr).min((N / 2 - 2) as f32);
            let k = x as usize;
            let fr = x - k as f32;
            let m0 = (re[k] * re[k] + im[k] * im[k]).sqrt();
            let m1 = (re[k + 1] * re[k + 1] + im[k + 1] * im[k + 1]).sqrt();
            let mag = (m0 + (m1 - m0) * fr) / amp;
            *o = 20.0 * mag.max(1e-6).log10();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::BLOCK;

    fn response_at(ty: FilterType, cutoff: f32, res: f32, freq: f32) -> f32 {
        let mut out = [0.0f32; 256];
        Filter::response(ty, cutoff, res, 0.0, 48_000.0, &mut out);
        let t = (freq / 20.0).ln() / (1000.0f32).ln();
        out[(t * 255.0).round() as usize]
    }

    #[test]
    fn lowpass_slopes() {
        // One octave above cutoff a 12 dB filter is ~12 dB down, 24 dB ~24.
        let lp12 = response_at(FilterType::Lp12, 1000.0, 0.1, 4000.0);
        let lp24 = response_at(FilterType::Lp24, 1000.0, 0.0, 4000.0);
        assert!((lp12 + 24.0).abs() < 3.0, "lp12 two octaves up: {lp12}");
        assert!((lp24 + 48.0).abs() < 4.0, "lp24 two octaves up: {lp24}");
        let pass = response_at(FilterType::Lp24, 1000.0, 0.0, 100.0);
        assert!(pass.abs() < 0.5, "passband {pass}");
    }

    #[test]
    fn highpass_and_bandpass_shapes() {
        assert!(response_at(FilterType::Hp12, 1000.0, 0.1, 100.0) < -30.0);
        assert!(response_at(FilterType::Hp24, 1000.0, 0.0, 8000.0).abs() < 1.0);
        let centre = response_at(FilterType::Bp12, 1000.0, 0.3, 1000.0);
        let side = response_at(FilterType::Bp12, 1000.0, 0.3, 100.0);
        assert!(centre > side + 10.0, "bp centre {centre} side {side}");
        let notch = response_at(FilterType::Notch, 1000.0, 0.3, 1000.0);
        assert!(notch < -15.0, "notch depth {notch}");
    }

    #[test]
    fn resonance_boosts_cutoff() {
        let flat = response_at(FilterType::Lp12, 1000.0, 0.0, 1000.0);
        let peaky = response_at(FilterType::Lp12, 1000.0, 0.8, 1000.0);
        assert!(peaky > flat + 15.0, "flat {flat} peaky {peaky}");
    }

    #[test]
    fn all_types_stay_stable_under_noise() {
        let mut rng = crate::util::Rng::new(3);
        for i in 0..19 {
            let ty = FilterType::from_index(i);
            for &(cutoff, res) in &[(30.0, 1.0), (1000.0, 1.0), (19_000.0, 1.0), (500.0, 0.0)] {
                let mut f = Filter::default();
                let mut peak = 0.0f32;
                for b in 0..400 {
                    let mut l = [0.0f32; BLOCK];
                    let mut r = [0.0f32; BLOCK];
                    for s in 0..BLOCK {
                        l[s] = rng.bipolar();
                        r[s] = rng.bipolar();
                    }
                    // Sweep the cutoff a little to exercise coefficient ramps.
                    let fc = cutoff * (1.0 + 0.3 * ((b % 20) as f32 / 20.0));
                    let p = FilterParams { ty, cutoff: fc, res, drive: 0.5, var: 0.5, mix: 1.0, stereo: 0.3, sr: 48_000.0 };
                    f.process(&p, &mut l, &mut r);
                    for v in l.iter().chain(r.iter()) {
                        assert!(v.is_finite(), "{ty:?} cutoff {cutoff} res {res}");
                        peak = peak.max(v.abs());
                    }
                }
                assert!(peak < 60.0, "{ty:?} cutoff {cutoff} res {res} peak {peak}");
            }
        }
    }

    #[test]
    fn mix_zero_is_dry() {
        let mut f = Filter::default();
        let mut l = [0.5f32; BLOCK];
        let mut r = [-0.25f32; BLOCK];
        let p = FilterParams { ty: FilterType::Lp24, cutoff: 200.0, res: 0.5, drive: 0.0, var: 0.0, mix: 0.0, stereo: 0.0, sr: 48_000.0 };
        f.process(&p, &mut l, &mut r);
        assert!(l.iter().all(|v| (*v - 0.5).abs() < 1e-6));
        assert!(r.iter().all(|v| (*v + 0.25).abs() < 1e-6));
    }
}
