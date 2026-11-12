//! Wavetable storage with band-limited mip levels.
//!
//! A wavetable is a stack of single-cycle frames (2048 samples each). Playing
//! a frame at a high pitch would push its upper harmonics past Nyquist and
//! alias, so every frame is stored at 11 mip levels, each keeping half as many
//! harmonics as the previous one. The oscillator picks the level that fits
//! under Nyquist for the pitch being played.
//!
//! Besides the factory tables there are a few *user tables*: wavetables the
//! user draws or imports. They are part of the patch (and so of a share URL),
//! which is why they are stored small: a few frames of 128 eight-bit points.

use crate::fft::Fft;
use std::rc::Rc;

pub const TABLE_SIZE: usize = 2048;
pub const NUM_MIPS: usize = 11;
/// Each stored frame is padded with wrap-around samples so the 4-point
/// interpolator can read `i..i+4` without bounds or wrap logic:
/// `[s[N-1], s[0], ..., s[N-1], s[0], s[1], s[2]]`.
pub const STRIDE: usize = TABLE_SIZE + 4;

#[derive(Clone)]
pub struct Wavetable {
    pub frames: usize,
    data: Vec<f32>,
}

/// Scratch space for turning single-cycle waves into band-limited frames.
pub struct FrameBuilder {
    fft: Fft,
    re: Vec<f32>,
    im: Vec<f32>,
    sre: Vec<f32>,
    sim: Vec<f32>,
}

impl Default for FrameBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameBuilder {
    pub fn new() -> Self {
        let zeros = || vec![0.0f32; TABLE_SIZE];
        FrameBuilder { fft: Fft::new(TABLE_SIZE), re: zeros(), im: zeros(), sre: zeros(), sim: zeros() }
    }
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
    /// A table of `frames` silent frames, to be filled with `set_frame`.
    pub fn empty(frames: usize) -> Self {
        assert!(frames >= 1);
        Wavetable { frames, data: vec![0.0f32; NUM_MIPS * frames * STRIDE] }
    }

    pub fn from_frames(src: &[f32], frames: usize) -> Self {
        assert!(frames >= 1 && src.len() == frames * TABLE_SIZE);
        let mut table = Wavetable { frames, data: vec![0.0f32; NUM_MIPS * frames * STRIDE] };
        let mut work = FrameBuilder::new();
        for f in 0..frames {
            table.set_frame(&mut work, f, &src[f * TABLE_SIZE..(f + 1) * TABLE_SIZE]);
        }
        table
    }

    /// Replaces frame `f` with the single-cycle wave `src` (`TABLE_SIZE`
    /// samples): removes DC, normalises to peak 1, generates the mip levels.
    pub fn set_frame(&mut self, work: &mut FrameBuilder, f: usize, src: &[f32]) {
        assert!(f < self.frames && src.len() == TABLE_SIZE);
        let FrameBuilder { fft, re, im, sre, sim } = work;
        sre.copy_from_slice(src);
        sim.iter_mut().for_each(|v| *v = 0.0);
        fft.forward(sre, sim);
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
            fft.inverse(re, im);
            if mip == 0 {
                let peak = re.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                scale = if peak > 1e-6 { 1.0 / peak } else { 1.0 };
            }
            let base = (mip * self.frames + f) * STRIDE;
            let dst = &mut self.data[base..base + STRIDE];
            dst[0] = re[TABLE_SIZE - 1] * scale;
            for i in 0..TABLE_SIZE {
                dst[i + 1] = re[i] * scale;
            }
            dst[TABLE_SIZE + 1] = re[0] * scale;
            dst[TABLE_SIZE + 2] = re[1] * scale;
            dst[TABLE_SIZE + 3] = re[2] * scale;
        }
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

// ---------------------------------------------------------------------------
// User tables
// ---------------------------------------------------------------------------

/// How many wavetables of their own a patch can carry.
pub const USER_TABLES: usize = 2;
/// Points per frame of a user table.
pub const USER_POINTS: usize = 128;
pub const USER_MAX_FRAMES: usize = 16;

/// A wavetable drawn or imported by the user: 1 to `USER_MAX_FRAMES` frames
/// of `USER_POINTS` points each, one signed byte per point. A frame is one
/// cycle; the points are joined by straight lines, as the editor draws them.
#[derive(Clone, PartialEq, Debug)]
pub struct UserTable {
    points: Vec<i8>,
}

impl Default for UserTable {
    /// One frame holding a sine.
    fn default() -> Self {
        let sine = |i: usize| (127.0 * (crate::util::TAU * i as f32 / USER_POINTS as f32).sin()).round() as i8;
        UserTable { points: (0..USER_POINTS).map(sine).collect() }
    }
}

impl UserTable {
    /// `points` holds whole frames, one after the other. Returns `None` if
    /// it is not 1 to `USER_MAX_FRAMES` frames long.
    pub fn new(points: &[i8]) -> Option<UserTable> {
        let frames = points.len() / USER_POINTS;
        let whole = points.len() % USER_POINTS == 0;
        (whole && (1..=USER_MAX_FRAMES).contains(&frames)).then(|| UserTable { points: points.to_vec() })
    }

    pub fn frames(&self) -> usize {
        self.points.len() / USER_POINTS
    }

    pub fn points(&self) -> &[i8] {
        &self.points
    }

    pub fn frame(&self, f: usize) -> &[i8] {
        &self.points[f * USER_POINTS..(f + 1) * USER_POINTS]
    }

    /// Renders frame `f` as a full-resolution cycle of `TABLE_SIZE` samples.
    pub fn render(&self, f: usize, out: &mut [f32]) {
        let pts = self.frame(f);
        let step = USER_POINTS as f32 / out.len() as f32;
        for (i, o) in out.iter_mut().enumerate() {
            let x = i as f32 * step;
            let k = (x as usize).min(USER_POINTS - 1);
            let (a, b) = (pts[k] as f32, pts[(k + 1) % USER_POINTS] as f32);
            *o = (a + (b - a) * (x - k as f32)) / 127.0;
        }
    }
}

/// The wavetables a synth can play: the factory tables, generated on first
/// use, followed by the patch's user tables.
pub struct Bank {
    tables: Vec<Option<Rc<Wavetable>>>,
    /// What the user tables were built from.
    user: [UserTable; USER_TABLES],
    work: Option<FrameBuilder>,
}

/// Number of factory tables. User table `slot` is table `FACTORY_TABLES + slot`.
pub const FACTORY_TABLES: usize = crate::tables::TABLE_NAMES.len();

impl Default for Bank {
    fn default() -> Self {
        Self::new()
    }
}

impl Bank {
    pub fn new() -> Self {
        Bank { tables: (0..FACTORY_TABLES + USER_TABLES).map(|_| None).collect(), user: Default::default(), work: None }
    }

    pub fn count(&self) -> usize {
        self.tables.len()
    }

    /// Returns the table, generating it on first use.
    pub fn get(&mut self, index: usize) -> Rc<Wavetable> {
        let index = index.min(self.tables.len() - 1);
        if self.tables[index].is_none() {
            let (frames, data) = if index < FACTORY_TABLES {
                crate::tables::generate(index)
            } else {
                let user = &self.user[index - FACTORY_TABLES];
                let mut data = vec![0.0f32; user.frames() * TABLE_SIZE];
                for (f, frame) in data.chunks_mut(TABLE_SIZE).enumerate() {
                    user.render(f, frame);
                }
                (user.frames(), data)
            };
            self.tables[index] = Some(Rc::new(Wavetable::from_frames(&data, frames)));
        }
        self.tables[index].as_ref().unwrap().clone()
    }

    pub fn user(&self, slot: usize) -> &UserTable {
        &self.user[slot]
    }

    /// The table if it has been built, without building it.
    pub fn peek(&self, index: usize) -> Option<Rc<Wavetable>> {
        self.tables.get(index).and_then(|t| t.clone())
    }

    /// Puts in a table that was built elsewhere (see `TableJobs`). For a
    /// user table, `source` is what it was built from.
    pub fn install(&mut self, index: usize, table: Rc<Wavetable>, source: Option<&UserTable>) {
        if index >= self.tables.len() {
            return;
        }
        self.tables[index] = Some(table);
        if let (Some(src), Some(slot)) = (source, index.checked_sub(FACTORY_TABLES)) {
            self.user[slot] = src.clone();
        }
    }

    /// Replaces a user table. Returns true if it changed. Only the frames
    /// that differ are rebuilt when nobody else holds the table (callers
    /// should let go of their `Rc` first); drawing changes one frame at a
    /// time, and this keeps it cheap enough for the audio thread.
    pub fn set_user(&mut self, slot: usize, table: &UserTable) -> bool {
        if self.user[slot] == *table {
            return false;
        }
        let index = FACTORY_TABLES + slot;
        let old = std::mem::replace(&mut self.user[slot], table.clone());
        let built = self.tables[index].as_mut().and_then(Rc::get_mut).filter(|_| old.frames() == table.frames());
        match built {
            Some(built) => {
                let work = self.work.get_or_insert_with(FrameBuilder::new);
                let mut cycle = vec![0.0f32; TABLE_SIZE];
                for f in 0..table.frames() {
                    if old.frame(f) != table.frame(f) {
                        table.render(f, &mut cycle);
                        built.set_frame(work, f, &cycle);
                    }
                }
            }
            None => self.tables[index] = None,
        }
        true
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
    fn user_table_default_is_a_sine_and_frames_are_validated() {
        let t = UserTable::default();
        assert_eq!(t.frames(), 1);
        let mut cycle = vec![0.0f32; TABLE_SIZE];
        t.render(0, &mut cycle);
        for (i, v) in cycle.iter().enumerate() {
            let sine = (TAU * i as f32 / TABLE_SIZE as f32).sin();
            assert!((v - sine).abs() < 0.01, "sample {i}: {v} vs {sine}");
        }
        assert!(UserTable::new(&[]).is_none());
        assert!(UserTable::new(&[0; USER_POINTS + 1]).is_none());
        assert!(UserTable::new(&[0; USER_POINTS * (USER_MAX_FRAMES + 1)]).is_none());
        assert_eq!(UserTable::new(&[0; USER_POINTS * 3]).unwrap().frames(), 3);
    }

    #[test]
    fn user_tables_join_their_points_with_straight_lines() {
        // A square drawn point by point keeps its steep edges.
        let pts: Vec<i8> = (0..USER_POINTS).map(|i| if i < USER_POINTS / 2 { 127 } else { -127 }).collect();
        let t = UserTable::new(&pts).unwrap();
        let mut cycle = vec![0.0f32; TABLE_SIZE];
        t.render(0, &mut cycle);
        assert_eq!(cycle[0], 1.0);
        assert_eq!(cycle[TABLE_SIZE / 4], 1.0);
        assert_eq!(cycle[3 * TABLE_SIZE / 4], -1.0);
        // The edge takes one point (16 samples); half way down it crosses zero.
        let edge = TABLE_SIZE / 2 - TABLE_SIZE / USER_POINTS;
        assert_eq!(cycle[edge], 1.0);
        assert!(cycle[edge + 8].abs() < 1e-6);
        // The last point leads back to the first.
        assert!(cycle[TABLE_SIZE - 8].abs() < 1e-6);
    }

    #[test]
    fn bank_serves_user_tables_and_rebuilds_only_what_changed() {
        let mut bank = Bank::new();
        assert_eq!(bank.count(), FACTORY_TABLES + USER_TABLES);
        let index = FACTORY_TABLES + 1;
        assert_eq!(bank.get(index).frames, 1);
        assert!((bank.get(index).sample(0, 0.0, 0.25) - 1.0).abs() < 0.01, "a sine by default");

        // Two frames: a sine and a square.
        let mut pts = UserTable::default().points().to_vec();
        pts.extend((0..USER_POINTS).map(|i| if i < USER_POINTS / 2 { 127i8 } else { -127 }));
        let two = UserTable::new(&pts).unwrap();
        assert!(bank.set_user(1, &two));
        assert!(!bank.set_user(1, &two), "setting the same table again changes nothing");
        let table = bank.get(index);
        assert_eq!(table.frames, 2);
        assert!(table.sample(0, 1.0, 0.75) < -0.8, "the square is the last frame");
        drop(table);

        // Changing one frame in place gives the same result as building anew.
        pts[..USER_POINTS].iter_mut().for_each(|p| *p = 0);
        pts[10] = 127;
        let edited = UserTable::new(&pts).unwrap();
        assert!(bank.set_user(1, &edited));
        let mut fresh = Bank::new();
        fresh.set_user(1, &edited);
        let (a, b) = (bank.get(index), fresh.get(index));
        for mip in [0, 5, NUM_MIPS - 1] {
            for f in 0..2 {
                assert_eq!(a.frame(mip, f), b.frame(mip, f), "mip {mip} frame {f}");
            }
        }
        // The other user table is untouched.
        assert_eq!(bank.get(FACTORY_TABLES).frames, 1);
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
