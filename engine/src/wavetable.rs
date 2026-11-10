//! Wavetable storage with band-limited mip levels.
//!
//! A wavetable is a stack of single-cycle frames (2048 samples each). Playing
//! a frame at a high pitch would push its upper harmonics past Nyquist and
//! alias, so every frame is stored at 11 mip levels, each keeping half as many
//! harmonics as the previous one. The oscillator picks the level that fits
//! under Nyquist for the pitch being played.

use crate::fft::Fft;
use std::rc::Rc;

pub const TABLE_SIZE: usize = 2048;
pub const NUM_MIPS: usize = 11;
/// Each stored frame is padded with wrap-around samples so the 4-point
/// interpolator can read `i..i+4` without bounds or wrap logic:
/// `[s[N-1], s[0], ..., s[N-1], s[0], s[1], s[2]]`.
pub const STRIDE: usize = TABLE_SIZE + 4;

pub struct Wavetable {
    pub frames: usize,
    data: Vec<f32>,
}

/// Highest harmonic kept at a mip level.
#[inline]
pub fn mip_harmonics(mip: usize) -> usize {
    if mip == 0 {
        TABLE_SIZE / 2 - 1
    } else {
        (TABLE_SIZE / 2) >> mip
    }
}

/// Mip level to use for a partial-free playback of `freq_hz`.
/// Above 40 kHz sample rates we let harmonics reach `sr - 20 kHz`: anything
/// that folds back lands above 20 kHz where it cannot be heard, and in return
/// the top octave keeps more of its brightness.
#[inline]
pub fn mip_for(freq_hz: f32, sr: f32) -> usize {
    let allowed = if sr > 40_000.0 { sr - 20_000.0 } else { sr * 0.5 };
    let ratio = (TABLE_SIZE / 2) as f32 * freq_hz.max(1.0) / allowed;
    if ratio <= 1.0 {
        0
    } else {
        (ratio.log2().ceil() as usize).min(NUM_MIPS - 1)
    }
}

impl Wavetable {
    /// Build from `frames` consecutive single-cycle waves of `TABLE_SIZE`
    /// samples. Removes DC, normalises every frame to peak 1 and generates
    /// the mip levels.
    pub fn from_frames(src: &[f32], frames: usize) -> Self {
        assert!(frames >= 1 && src.len() == frames * TABLE_SIZE);
        let fft = Fft::new(TABLE_SIZE);
        let mut data = vec![0.0f32; NUM_MIPS * frames * STRIDE];
        let mut re = vec![0.0f32; TABLE_SIZE];
        let mut im = vec![0.0f32; TABLE_SIZE];
        let mut sre = vec![0.0f32; TABLE_SIZE];
        let mut sim = vec![0.0f32; TABLE_SIZE];

        for f in 0..frames {
            sre.copy_from_slice(&src[f * TABLE_SIZE..(f + 1) * TABLE_SIZE]);
            sim.iter_mut().for_each(|v| *v = 0.0);
            fft.forward(&mut sre, &mut sim);
            sre[0] = 0.0;
            sim[0] = 0.0;
            sre[TABLE_SIZE / 2] = 0.0;
            sim[TABLE_SIZE / 2] = 0.0;

            let mut scale = 1.0;
            for mip in 0..NUM_MIPS {
                let h = mip_harmonics(mip);
                re.iter_mut().for_each(|v| *v = 0.0);
                im.iter_mut().for_each(|v| *v = 0.0);
                for k in 1..=h {
                    re[k] = sre[k];
                    im[k] = sim[k];
                    re[TABLE_SIZE - k] = sre[TABLE_SIZE - k];
                    im[TABLE_SIZE - k] = sim[TABLE_SIZE - k];
                }
                fft.inverse(&mut re, &mut im);
                if mip == 0 {
                    let peak = re.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                    scale = if peak > 1e-6 { 1.0 / peak } else { 1.0 };
                }
                let base = (mip * frames + f) * STRIDE;
                let dst = &mut data[base..base + STRIDE];
                dst[0] = re[TABLE_SIZE - 1] * scale;
                for i in 0..TABLE_SIZE {
                    dst[i + 1] = re[i] * scale;
                }
                dst[TABLE_SIZE + 1] = re[0] * scale;
                dst[TABLE_SIZE + 2] = re[1] * scale;
                dst[TABLE_SIZE + 3] = re[2] * scale;
            }
        }
        Wavetable { frames, data }
    }

    /// Padded frame (`STRIDE` samples) at a mip level.
    #[inline]
    pub fn frame(&self, mip: usize, frame: usize) -> &[f32] {
        let base = (mip * self.frames + frame) * STRIDE;
        &self.data[base..base + STRIDE]
    }

    /// Splits a 0..1 table position into (frame a, frame b, mix).
    #[inline]
    pub fn locate(&self, pos: f32) -> (usize, usize, f32) {
        if self.frames <= 1 {
            return (0, 0, 0.0);
        }
        let p = pos.max(0.0).min(1.0) * (self.frames - 1) as f32;
        let a = (p as usize).min(self.frames - 2);
        (a, a + 1, p - a as f32)
    }

    /// Sample at `phase` (0..1) and table position `pos` (0..1) from one mip
    /// level. Convenience path for displays and tests, not the audio loop.
    pub fn sample(&self, mip: usize, pos: f32, phase: f32) -> f32 {
        let (a, b, mix) = self.locate(pos);
        let fa = self.frame(mip, a);
        let fb = self.frame(mip, b);
        let x = (phase - phase.floor()) * TABLE_SIZE as f32;
        let i = (x as usize).min(TABLE_SIZE - 1);
        let fr = x - i as f32;
        let va = hermite(fa[i], fa[i + 1], fa[i + 2], fa[i + 3], fr);
        let vb = hermite(fb[i], fb[i + 1], fb[i + 2], fb[i + 3], fr);
        va + (vb - va) * mix
    }

    /// Renders one cycle at table position `pos` into `out` (any length).
    pub fn render_cycle(&self, pos: f32, out: &mut [f32]) {
        let n = out.len();
        for (i, o) in out.iter_mut().enumerate() {
            *o = self.sample(0, pos, i as f32 / n as f32);
        }
    }
}

/// 4-point, 3rd-order Hermite interpolation between `y0` and `y1`.
#[inline(always)]
pub fn hermite(ym1: f32, y0: f32, y1: f32, y2: f32, x: f32) -> f32 {
    let c1 = 0.5 * (y1 - ym1);
    let c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    let c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
    ((c3 * x + c2) * x + c1) * x + y0
}

/// Lazily generated set of factory wavetables.
pub struct Bank {
    tables: Vec<Option<Rc<Wavetable>>>,
}

impl Default for Bank {
    fn default() -> Self {
        Self::new()
    }
}

impl Bank {
    pub fn new() -> Self {
        Bank { tables: (0..crate::tables::TABLE_NAMES.len()).map(|_| None).collect() }
    }

    pub fn count(&self) -> usize {
        self.tables.len()
    }

    /// Returns the table, generating it on first use.
    pub fn get(&mut self, index: usize) -> Rc<Wavetable> {
        let index = index.min(self.tables.len() - 1);
        if self.tables[index].is_none() {
            let (frames, data) = crate::tables::generate(index);
            self.tables[index] = Some(Rc::new(Wavetable::from_frames(&data, frames)));
        }
        self.tables[index].as_ref().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::TAU;

    fn saw_frames() -> Vec<f32> {
        (0..TABLE_SIZE).map(|i| 2.0 * i as f32 / TABLE_SIZE as f32 - 1.0).collect()
    }

    #[test]
    fn mip_selection_is_monotonic() {
        let sr = 48_000.0;
        let mut last = 0;
        for note in 0..128 {
            let m = mip_for(crate::util::midi_to_hz(note as f32), sr);
            assert!(m >= last);
            last = m;
            // The chosen level never puts a harmonic where it would fold
            // back below 20 kHz.
            let top = mip_harmonics(m) as f32 * crate::util::midi_to_hz(note as f32);
            assert!(top <= sr - 20_000.0 + 1.0 || m == NUM_MIPS - 1, "note {note} top {top}");
        }
        assert_eq!(mip_for(20.0, sr), 0);
    }

    #[test]
    fn top_mip_is_a_sine() {
        let wt = Wavetable::from_frames(&saw_frames(), 1);
        let f = wt.frame(NUM_MIPS - 1, 0);
        // A single harmonic: compare against a fitted sine.
        let (mut s, mut c) = (0.0f32, 0.0f32);
        for i in 0..TABLE_SIZE {
            let a = TAU * i as f32 / TABLE_SIZE as f32;
            s += f[i + 1] * a.sin();
            c += f[i + 1] * a.cos();
        }
        s *= 2.0 / TABLE_SIZE as f32;
        c *= 2.0 / TABLE_SIZE as f32;
        for i in 0..TABLE_SIZE {
            let a = TAU * i as f32 / TABLE_SIZE as f32;
            assert!((f[i + 1] - (s * a.sin() + c * a.cos())).abs() < 1e-3);
        }
    }

    #[test]
    fn frames_are_normalised_and_padded() {
        let wt = Wavetable::from_frames(&saw_frames(), 1);
        let f = wt.frame(0, 0);
        let peak = f[1..=TABLE_SIZE].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 1.0).abs() < 1e-4);
        assert_eq!(f[0], f[TABLE_SIZE]);
        assert_eq!(f[TABLE_SIZE + 1], f[1]);
        assert_eq!(f[TABLE_SIZE + 3], f[3]);
    }

    #[test]
    fn locate_covers_the_range() {
        let two: Vec<f32> = saw_frames().into_iter().chain(saw_frames()).collect();
        let wt = Wavetable::from_frames(&two, 2);
        assert_eq!(wt.locate(0.0), (0, 1, 0.0));
        let (a, b, m) = wt.locate(1.0);
        assert_eq!((a, b), (0, 1));
        assert!((m - 1.0).abs() < 1e-6);
    }
}
