//! Wavetable oscillator with unison and warp modes.

use crate::util::{pan_gains, semitones_to_ratio, Rng, BLOCK, PI, TAU};
use crate::wavetable::{hermite, mip_for, Wavetable, TABLE_SIZE};

pub const MAX_UNISON: usize = 16;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Warp {
    Off,
    Sync,
    SyncWin,
    BendPlus,
    BendMinus,
    Pwm,
    AsymPlus,
    AsymMinus,
    Flip,
    Mirror,
    Quantize,
    Fm,
    Am,
    Rm,
}

impl Warp {
    pub fn from_index(i: usize) -> Warp {
        use Warp::*;
        const ALL: [Warp; 14] = [
            Off, Sync, SyncWin, BendPlus, BendMinus, Pwm, AsymPlus, AsymMinus, Flip, Mirror,
            Quantize, Fm, Am, Rm,
        ];
        ALL[i.min(ALL.len() - 1)]
    }

    /// True when the mode needs the other oscillator's signal.
    pub fn needs_modulator(self) -> bool {
        matches!(self, Warp::Fm | Warp::Am | Warp::Rm)
    }

    /// How much the warp raises the highest frequency present, used to pick a
    /// more conservative mip level so the warped wave aliases less.
    fn bandwidth(self, a: f32) -> f32 {
        match self {
            Warp::Off | Warp::Flip | Warp::Quantize => 1.0,
            Warp::Sync | Warp::SyncWin => sync_ratio(a),
            Warp::BendPlus | Warp::BendMinus => bend_exp(a),
            Warp::Pwm => (1.0 / (1.0 - 0.98 * a)).min(8.0),
            Warp::AsymPlus | Warp::AsymMinus => (0.5 / (0.5 - 0.49 * a)).min(8.0),
            Warp::Mirror => (1.0 / (0.5 - 0.45 * a)).min(8.0),
            Warp::Fm => 1.0 + fm_depth(a) * 4.0,
            Warp::Am | Warp::Rm => 1.0 + a,
        }
    }
}

#[inline]
fn sync_ratio(a: f32) -> f32 {
    (2.0f32).powf(a * 4.0)
}
#[inline]
fn bend_exp(a: f32) -> f32 {
    (2.0f32).powf(a * 2.5)
}
#[inline]
fn fm_depth(a: f32) -> f32 {
    a * a * 2.0
}

/// Applies a phase-shaping warp. Returns (table phase 0..=1, amplitude).
/// Shared with the UI preview so the picture matches the sound.
#[inline(always)]
pub fn warp_phase(warp: Warp, a: f32, ph: f32, modulator: f32) -> (f32, f32) {
    match warp {
        Warp::Off => (ph, 1.0),
        Warp::Sync => {
            let x = ph * sync_ratio(a);
            (x - x.floor(), 1.0)
        }
        Warp::SyncWin => {
            let x = ph * sync_ratio(a);
            (x - x.floor(), 0.5 - 0.5 * (TAU * ph).cos())
        }
        Warp::BendPlus => (ph.powf(bend_exp(a)), 1.0),
        Warp::BendMinus => (1.0 - (1.0 - ph).powf(bend_exp(a)), 1.0),
        Warp::Pwm => ((ph / (1.0 - 0.98 * a)).min(1.0), 1.0),
        Warp::AsymPlus => (asym(ph, 0.5 + 0.49 * a), 1.0),
        Warp::AsymMinus => (asym(ph, 0.5 - 0.49 * a), 1.0),
        Warp::Flip => (ph, if ph >= 1.0 - a { -1.0 } else { 1.0 }),
        Warp::Mirror => {
            let m = 0.5 + 0.45 * a;
            (if ph < m { ph / m } else { (1.0 - ph) / (1.0 - m) }, 1.0)
        }
        Warp::Quantize => {
            let steps = (2.0f32).powf(8.0 - 7.0 * a).round();
            // Sample the middle of each step so even two steps give a square.
            ((((ph * steps).floor() + 0.5) / steps).min(1.0), 1.0)
        }
        Warp::Fm => {
            let x = ph + fm_depth(a) * modulator;
            (x - x.floor(), 1.0)
        }
        Warp::Am => (ph, 1.0 - a + a * (0.5 + 0.5 * modulator)),
        Warp::Rm => (ph, 1.0 - a + a * modulator),
    }
}

#[inline(always)]
fn asym(ph: f32, m: f32) -> f32 {
    if ph < m {
        0.5 * ph / m
    } else {
        0.5 + 0.5 * (ph - m) / (1.0 - m)
    }
}

/// The warp actually applied: modulator modes need a modulator.
#[inline]
fn effective(warp: Warp, modulator: Option<&[f32]>) -> Warp {
    if warp.needs_modulator() && modulator.is_none() {
        Warp::Off
    } else {
        warp
    }
}

/// Both warps in turn: the second bends the phase the first produced, and
/// their amplitudes multiply. Shared with the UI preview.
#[inline(always)]
pub fn warp2_phase(w1: Warp, a1: f32, w2: Warp, a2: f32, ph: f32, modulator: f32) -> (f32, f32) {
    let (p1, g1) = warp_phase(w1, a1, ph, modulator);
    let (p2, g2) = warp_phase(w2, a2, p1.max(0.0).min(1.0), modulator);
    (p2, g1 * g2)
}

pub struct OscParams<'a> {
    pub table: &'a Wavetable,
    /// Table position 0..1.
    pub pos: f32,
    /// Centre frequency in Hz.
    pub freq: f32,
    pub unison: usize,
    pub detune: f32,
    pub blend: f32,
    pub width: f32,
    /// Linear output gain.
    pub level: f32,
    pub pan: f32,
    pub warp: Warp,
    pub warp_amt: f32,
    /// The second warp, applied after the first.
    pub warp2: Warp,
    pub warp2_amt: f32,
    pub sr: f32,
}

#[derive(Clone)]
pub struct OscState {
    phase: [f32; MAX_UNISON],
    inc: [f32; MAX_UNISON],
    gain_l: f32,
    gain_r: f32,
    pos: f32,
    started: bool,
}

impl Default for OscState {
    fn default() -> Self {
        OscState {
            phase: [0.0; MAX_UNISON],
            inc: [0.0; MAX_UNISON],
            gain_l: 0.0,
            gain_r: 0.0,
            pos: 0.0,
            started: false,
        }
    }
}

/// Detune offset (-1..1), stereo position (-1..1) and gain of each unison
/// voice. Gains are normalised so the total power stays constant.
pub fn unison_layout(n: usize, blend: f32, width: f32, out: &mut [(f32, f32, f32); MAX_UNISON]) {
    let n = n.max(1).min(MAX_UNISON);
    if n == 1 {
        out[0] = (0.0, 0.0, 1.0);
        return;
    }
    let (centre, side) = if blend <= 0.75 {
        (1.0, blend / 0.75)
    } else {
        (1.0 - (blend - 0.75) / 0.25, 1.0)
    };
    let mut power = 0.0;
    for i in 0..n {
        let x = 2.0 * i as f32 / (n - 1) as f32 - 1.0;
        let pair = i.min(n - 1 - i);
        let is_centre = if n % 2 == 1 { i == n / 2 } else { i == n / 2 - 1 || i == n / 2 };
        let g = if is_centre { centre } else { side };
        // Alternate which side gets the flat voice so the stereo image stays
        // balanced instead of "low left, high right".
        let sign = if pair % 2 == 0 { 1.0 } else { -1.0 };
        out[i] = (x, sign * x * width, g);
        power += g * g;
    }
    let norm = if power > 1e-9 { 1.0 / power.sqrt() } else { 0.0 };
    for v in out.iter_mut().take(n) {
        v.2 *= norm;
    }
}

impl OscState {
    /// Restart the oscillator for a new note.
    pub fn reset(&mut self, phase: f32, rand: f32, rng: &mut Rng) {
        for p in self.phase.iter_mut() {
            let x = phase + rand * rng.unipolar();
            *p = x - x.floor();
        }
        self.started = false;
    }

    /// Renders `out_l.len()` samples (at most `BLOCK`).
    ///
    /// `out_l`/`out_r` receive the levelled, panned signal. `raw` receives the
    /// mono signal before level and pan, which the other oscillator may use
    /// as an FM/AM/RM source.
    pub fn process(
        &mut self,
        p: &OscParams,
        modulator: Option<&[f32]>,
        out_l: &mut [f32],
        out_r: &mut [f32],
        raw: &mut [f32],
    ) {
        let n = out_l.len();
        debug_assert!(n <= BLOCK && out_r.len() == n && raw.len() == n);
        let inv_n = 1.0 / n as f32;

        let unison = p.unison.max(1).min(MAX_UNISON);
        let mut layout = [(0.0f32, 0.0f32, 0.0f32); MAX_UNISON];
        unison_layout(unison, p.blend, p.width, &mut layout);

        // Table position: ramp the frame mix across the block.
        let pos_prev = if self.started { self.pos } else { p.pos };
        let (fa_i, fb_i, mix_end) = p.table.locate(p.pos);
        let (pa, _, mix_prev) = p.table.locate(pos_prev);
        let mix_start = if pa == fa_i {
            mix_prev
        } else if pa < fa_i {
            0.0
        } else {
            1.0
        };
        let dmix = (mix_end - mix_start) * inv_n;

        let detune_st = p.detune.max(0.0);
        let warp = effective(p.warp, modulator);
        let warp2 = effective(p.warp2, modulator);
        let amt = p.warp_amt.max(0.0).min(1.0);
        let amt2 = p.warp2_amt.max(0.0).min(1.0);
        // Two warps in a row stretch the spectrum about as much as both together.
        let bandwidth = (warp.bandwidth(amt) * warp2.bandwidth(amt2)).min(16.0);
        let top_freq = p.freq * semitones_to_ratio(detune_st) * bandwidth;
        let mip = mip_for(top_freq, p.sr);
        let fa = p.table.frame(mip, fa_i);
        let fb = p.table.frame(mip, fb_i);

        let zero = [0.0f32; BLOCK];
        let modu = match modulator {
            Some(m) if m.len() >= n => m,
            _ => &zero[..n],
        };

        let mut tl = [0.0f32; BLOCK];
        let mut tr = [0.0f32; BLOCK];
        // FM/AM/RM without a running partner would only mute or do nothing,
        // so they fall back to the plain wave (see `effective`).

        for v in 0..unison {
            let (dx, vpan, vgain) = layout[v];
            let inc_end = (p.freq * semitones_to_ratio(dx * detune_st) / p.sr).min(0.49);
            let mut inc = if self.started { self.inc[v] } else { inc_end };
            let dinc = (inc_end - inc) * inv_n;
            let (gl, gr) = if unison == 1 {
                (1.0, 1.0)
            } else {
                let a = (vpan + 1.0) * 0.25 * PI;
                (a.cos() * core::f32::consts::SQRT_2 * vgain, a.sin() * core::f32::consts::SQRT_2 * vgain)
            };
            let mut ph = self.phase[v];
            let mut mix = mix_start;

            macro_rules! run {
                ($warp_fn:expr) => {
                    for s in 0..n {
                        let (wp, amp): (f32, f32) = $warp_fn(ph, modu[s]);
                        let x = wp * TABLE_SIZE as f32;
                        let i = (x as usize).min(TABLE_SIZE);
                        let fr = x - i as f32;
                        let a = &fa[i..i + 4];
                        let b = &fb[i..i + 4];
                        let y = hermite(
                            a[0] + (b[0] - a[0]) * mix,
                            a[1] + (b[1] - a[1]) * mix,
                            a[2] + (b[2] - a[2]) * mix,
                            a[3] + (b[3] - a[3]) * mix,
                            fr,
                        ) * amp;
                        tl[s] += y * gl;
                        tr[s] += y * gr;
                        ph += inc;
                        inc += dinc;
                        mix += dmix;
                        if ph >= 1.0 {
                            ph -= 1.0;
                        }
                    }
                };
            }

            // The match is hoisted out of the sample loop so each mode gets
            // its own tight loop.
            match (warp, warp2) {
                (Warp::Off, Warp::Off) => run!(|ph: f32, _m: f32| (ph, 1.0)),
                (_, Warp::Off) => run!(|ph: f32, m: f32| warp_phase(warp, amt, ph, m)),
                (Warp::Off, _) => run!(|ph: f32, m: f32| warp_phase(warp2, amt2, ph, m)),
                _ => run!(|ph: f32, m: f32| warp2_phase(warp, amt, warp2, amt2, ph, m)),
            }

            self.phase[v] = ph;
            self.inc[v] = inc_end;
        }

        let (pl, pr) = pan_gains(p.pan);
        let (gl_end, gr_end) = (pl * p.level, pr * p.level);
        let (mut gl, mut gr) = if self.started { (self.gain_l, self.gain_r) } else { (gl_end, gr_end) };
        let dgl = (gl_end - gl) * inv_n;
        let dgr = (gr_end - gr) * inv_n;
        for s in 0..n {
            raw[s] = (tl[s] + tr[s]) * 0.5;
            out_l[s] = tl[s] * gl;
            out_r[s] = tr[s] * gr;
            gl += dgl;
            gr += dgr;
        }
        self.gain_l = gl_end;
        self.gain_r = gr_end;
        self.pos = p.pos;
        self.started = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wavetable::Bank;

    fn render(freq: f32, unison: usize, warp: Warp, amt: f32, seconds: f32) -> Vec<f32> {
        render2(freq, unison, warp, amt, Warp::Off, 0.0, seconds)
    }

    fn render2(freq: f32, unison: usize, warp: Warp, amt: f32, warp2: Warp, amt2: f32, seconds: f32) -> Vec<f32> {
        let mut bank = Bank::new();
        let table = bank.get(0);
        let sr = 48_000.0;
        let mut osc = OscState::default();
        let mut rng = Rng::new(1);
        osc.reset(0.0, 0.0, &mut rng);
        let total = (sr * seconds) as usize;
        let mut out = Vec::with_capacity(total);
        let (mut l, mut r, mut raw) = ([0.0; BLOCK], [0.0; BLOCK], [0.0; BLOCK]);
        while out.len() < total {
            let p = OscParams {
                table: &table,
                pos: 0.5, // saw
                freq,
                unison,
                detune: 0.25,
                blend: 0.75,
                width: 1.0,
                level: 1.0,
                pan: 0.0,
                warp,
                warp_amt: amt,
                warp2,
                warp2_amt: amt2,
                sr,
            };
            osc.process(&p, None, &mut l, &mut r, &mut raw);
            out.extend_from_slice(&l);
        }
        out
    }

    fn zero_crossings_up(x: &[f32]) -> usize {
        x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count()
    }

    #[test]
    fn pitch_is_accurate() {
        // Position 0 of Basic Shapes is a sine: count cycles in one second.
        let mut bank = Bank::new();
        let table = bank.get(0);
        let sr = 48_000.0;
        let mut osc = OscState::default();
        osc.reset(0.0, 0.0, &mut Rng::new(1));
        let mut out = Vec::new();
        let (mut l, mut r, mut raw) = ([0.0; BLOCK], [0.0; BLOCK], [0.0; BLOCK]);
        for _ in 0..(48_000 / BLOCK) {
            let p = OscParams {
                table: &table, pos: 0.0, freq: 440.0, unison: 1, detune: 0.0, blend: 0.75,
                width: 1.0, level: 1.0, pan: 0.0, warp: Warp::Off, warp_amt: 0.0, warp2: Warp::Off, warp2_amt: 0.0, sr,
            };
            osc.process(&p, None, &mut l, &mut r, &mut raw);
            out.extend_from_slice(&l);
        }
        let z = zero_crossings_up(&out) as i32;
        assert!((z - 440).abs() <= 1, "counted {z} cycles");
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 1.0).abs() < 0.01, "peak {peak}");
    }

    #[test]
    fn output_is_finite_and_bounded_for_all_warps() {
        for w in 0..14 {
            for amt in [0.0, 0.3, 1.0] {
                let out = render(220.0, 3, Warp::from_index(w), amt, 0.1);
                assert!(out.iter().all(|v| v.is_finite()), "warp {w} amt {amt}");
                let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                assert!(peak < 4.0, "warp {w} amt {amt} peak {peak}");
                assert!(peak > 0.01, "warp {w} amt {amt} silent");
            }
        }
    }

    #[test]
    fn two_warps_stay_bounded_and_the_second_acts_on_the_first() {
        for w1 in 0..14 {
            for w2 in 0..14 {
                let out = render2(220.0, 1, Warp::from_index(w1), 0.6, Warp::from_index(w2), 0.6, 0.03);
                assert!(out.iter().all(|v| v.is_finite()), "warps {w1} + {w2}");
                let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                assert!(peak < 4.0 && peak > 0.01, "warps {w1} + {w2} peak {peak}");
            }
        }
        // A second warp that is off changes nothing; one that is on changes the sound.
        let single = render(220.0, 1, Warp::BendPlus, 0.5, 0.05);
        assert_eq!(render2(220.0, 1, Warp::BendPlus, 0.5, Warp::Off, 0.7, 0.05), single);
        let both = render2(220.0, 1, Warp::BendPlus, 0.5, Warp::Sync, 0.5, 0.05);
        assert!(both.iter().zip(&single).any(|(a, b)| (a - b).abs() > 0.1));
        // Only the second one set sounds like that warp alone.
        assert_eq!(render2(220.0, 1, Warp::Off, 0.0, Warp::Sync, 0.5, 0.05), render(220.0, 1, Warp::Sync, 0.5, 0.05));
        // The order matters: Sync then Bend is not Bend then Sync.
        let other = render2(220.0, 1, Warp::Sync, 0.5, Warp::BendPlus, 0.5, 0.05);
        assert!(both.iter().zip(&other).any(|(a, b)| (a - b).abs() > 0.1));
    }

    #[test]
    fn unison_layout_is_power_normalised_and_balanced() {
        for n in 1..=MAX_UNISON {
            let mut lay = [(0.0, 0.0, 0.0); MAX_UNISON];
            unison_layout(n, 0.75, 1.0, &mut lay);
            let power: f32 = lay[..n].iter().map(|v| v.2 * v.2).sum();
            assert!((power - 1.0).abs() < 1e-4, "n {n} power {power}");
            let pan_sum: f32 = lay[..n].iter().map(|v| v.1).sum();
            assert!(pan_sum.abs() < 1e-4, "n {n} pan sum {pan_sum}");
            let det_sum: f32 = lay[..n].iter().map(|v| v.0).sum();
            assert!(det_sum.abs() < 1e-4, "n {n} detune sum {det_sum}");
        }
    }

    #[test]
    fn high_notes_do_not_alias_audibly() {
        // A saw near 4 kHz: energy between harmonics would be aliasing. The
        // pitch sits exactly on an FFT bin so window leakage does not count.
        let n = 8192;
        let f0 = 683.0 * 48_000.0 / n as f32;
        let out = render(f0, 1, Warp::Off, 0.0, 0.2);
        let fft = crate::fft::Fft::new(n);
        let mut re: Vec<f32> = out[1000..1000 + n]
            .iter()
            .enumerate()
            .map(|(i, v)| v * (0.5 - 0.5 * (TAU * i as f32 / n as f32).cos()))
            .collect();
        let mut im = vec![0.0; n];
        fft.forward(&mut re, &mut im);
        let bin_hz = 48_000.0 / n as f32;
        let mut harmonic = 0.0f32;
        let mut other = 0.0f32;
        for k in 4..n / 2 {
            let f = k as f32 * bin_hz;
            if f > 19_000.0 {
                break;
            }
            let nearest = (f / f0).round() * f0;
            let p = re[k] * re[k] + im[k] * im[k];
            if (f - nearest).abs() < 3.5 * bin_hz && nearest > 0.0 {
                harmonic += p;
            } else {
                other += p;
            }
        }
        let ratio_db = 10.0 * (other / harmonic).log10();
        assert!(ratio_db < -60.0, "aliasing at {ratio_db} dB");
    }
}
