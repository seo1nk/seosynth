//! The clip sequencer: a short pattern of notes, drawn in a piano roll, that
//! plays in a loop while a key is held.
//!
//! Like the arpeggiator it sits between the keys and the voices. The first
//! key starts the clip from its beginning; the clip plays transposed by how
//! far the last key pressed is from the root note (pressing the root plays
//! it as drawn). Pressing other keys while it runs only changes the
//! transposition, so the pattern keeps its place in the bar. Letting go of
//! every key stops it.
//!
//! Time is counted in ticks, `PPQ` to a quarter note. Notes start on block
//! boundaries (`util::BLOCK` samples), while the clock keeps the exact time.

/// Ticks per quarter note.
pub const PPQ: u32 = 96;
/// Longest clip: 8 bars of 4/4.
pub const MAX_LENGTH: u32 = 8 * 4 * PPQ;
/// Shortest clip: one beat.
pub const MIN_LENGTH: u32 = PPQ;
/// Most notes in a clip.
pub const MAX_NOTES: usize = 256;
/// Clips a patch holds (as in Serum 2); one plays at a time.
pub const NUM_CLIPS: usize = 12;
/// With key switching on, these keys (C1 to B1) pick clip 1 to 12
/// instead of playing.
pub const SWITCH_KEYS: core::ops::Range<u8> = 24..24 + NUM_CLIPS as u8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ClipNote {
    pub pitch: u8,
    /// Ticks from the start of the clip.
    pub start: u32,
    /// Ticks.
    pub length: u32,
    /// 1..=127, as in MIDI.
    pub velocity: u8,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Clip {
    /// Ticks; the clip loops after this.
    pub length: u32,
    /// Sorted by start, then pitch.
    pub notes: Vec<ClipNote>,
}

impl Default for Clip {
    /// One bar to start from: the root and its octave in eighths, with a
    /// fifth and a minor third, so switching the clip on plays something.
    fn default() -> Self {
        let eighth = PPQ / 2;
        let steps: [i32; 8] = [0, 12, 0, 7, 0, 12, 3, 10];
        Clip {
            length: 4 * PPQ,
            notes: steps
                .iter()
                .enumerate()
                .map(|(k, &o)| ClipNote { pitch: (60 + o) as u8, start: k as u32 * eighth, length: PPQ / 4, velocity: if k % 2 == 0 { 110 } else { 90 } })
                .collect(),
        }
    }
}

impl Clip {
    /// One empty bar: what clips 2 to 12 start as.
    pub fn empty() -> Clip {
        Clip { length: 4 * PPQ, notes: Vec::new() }
    }

    /// What clip `slot` holds in a new patch.
    pub fn initial(slot: usize) -> Clip {
        if slot == 0 {
            Clip::default()
        } else {
            Clip::empty()
        }
    }

    /// A clip with every value in range and the notes in order, or None if
    /// the length is out of range. Notes outside the clip are dropped and
    /// notes running past its end are cut there.
    pub fn new(length: u32, notes: &[ClipNote]) -> Option<Clip> {
        if !(MIN_LENGTH..=MAX_LENGTH).contains(&length) {
            return None;
        }
        let mut out: Vec<ClipNote> = notes
            .iter()
            .filter(|n| n.start < length && n.length > 0 && n.pitch <= 127)
            .map(|n| ClipNote { length: n.length.min(length - n.start), velocity: n.velocity.max(1).min(127), ..*n })
            .take(MAX_NOTES)
            .collect();
        out.sort_by_key(|n| (n.start, n.pitch));
        out.dedup_by_key(|n| (n.start, n.pitch));
        Some(Clip { length, notes: out })
    }

    /// Plain form for the WebAssembly interface: length u32, count u16, then
    /// per note pitch u8, start u32, length u32, velocity u8 (little endian).
    pub fn to_raw(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(6 + self.notes.len() * 10);
        out.extend_from_slice(&self.length.to_le_bytes());
        out.extend_from_slice(&(self.notes.len() as u16).to_le_bytes());
        for n in &self.notes {
            out.push(n.pitch);
            out.extend_from_slice(&n.start.to_le_bytes());
            out.extend_from_slice(&n.length.to_le_bytes());
            out.push(n.velocity);
        }
        out
    }

    pub fn from_raw(b: &[u8]) -> Option<Clip> {
        let u32_at = |i: usize| b.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]));
        let length = u32_at(0)?;
        let count = u16::from_le_bytes([*b.get(4)?, *b.get(5)?]) as usize;
        let mut notes = Vec::with_capacity(count.min(MAX_NOTES));
        for k in 0..count {
            let at = 6 + k * 10;
            notes.push(ClipNote { pitch: *b.get(at)?, start: u32_at(at + 1)?, length: u32_at(at + 5)?, velocity: *b.get(at + 9)? });
        }
        Clip::new(length, &notes)
    }
}

/// What the clip asks the voices to do.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ClipEvent {
    On(u8, f32),
    Off(u8),
}

/// How the clip is played, in real units.
#[derive(Clone, Copy, Debug)]
pub struct ClipSettings {
    /// The key that plays the clip as drawn.
    pub root: u8,
    /// Start again at the end, or stop.
    pub looped: bool,
    pub bpm: f32,
    pub sr: f32,
}

pub struct ClipPlayer {
    /// Keys held, in the order they were pressed.
    keys: Vec<u8>,
    playing: bool,
    /// Ticks since the clip started (within the clip).
    pos: f64,
    /// The clip ran to its end without looping: silent until the keys are
    /// let go and pressed again.
    finished: bool,
    /// Notes started and not yet stopped: (note played, ticks left).
    sounding: Vec<(u8, f64)>,
    pub events: Vec<ClipEvent>,
}

impl Default for ClipPlayer {
    fn default() -> Self {
        ClipPlayer::new()
    }
}

impl ClipPlayer {
    pub fn new() -> ClipPlayer {
        ClipPlayer { keys: Vec::with_capacity(32), playing: false, pos: 0.0, finished: false, sounding: Vec::with_capacity(64), events: Vec::with_capacity(MAX_NOTES * 2) }
    }

    pub fn press(&mut self, note: u8) {
        self.keys.retain(|k| *k != note);
        if self.keys.len() >= 32 {
            self.keys.remove(0);
        }
        self.keys.push(note);
    }

    pub fn release(&mut self, note: u8) {
        self.keys.retain(|k| *k != note);
    }

    pub fn clear_keys(&mut self) {
        self.keys.clear();
    }

    /// Where the clip is, in ticks, or None while it is not playing.
    pub fn position(&self) -> Option<f64> {
        (self.playing && !self.finished).then_some(self.pos)
    }

    /// Stops every note and rewinds.
    pub fn stop(&mut self) {
        for &(n, _) in self.sounding.iter() {
            self.events.push(ClipEvent::Off(n));
        }
        self.sounding.clear();
        self.playing = false;
        self.finished = false;
        self.pos = 0.0;
    }

    fn start_note(&mut self, note: &ClipNote, transpose: i32) {
        let pitch = note.pitch as i32 + transpose;
        if !(0..=127).contains(&pitch) {
            return;
        }
        let pitch = pitch as u8;
        // The same note again is played afresh, not stacked on itself.
        if let Some(at) = self.sounding.iter().position(|s| s.0 == pitch) {
            self.events.push(ClipEvent::Off(pitch));
            self.sounding.swap_remove(at);
        }
        self.events.push(ClipEvent::On(pitch, note.velocity as f32 / 127.0));
        self.sounding.push((pitch, note.length as f64));
    }

    /// Starts the notes that begin in [from, to) (ticks within the clip).
    fn start_between(&mut self, clip: &Clip, from: f64, to: f64, transpose: i32) {
        for n in clip.notes.iter() {
            let t = n.start as f64;
            if t >= from && t < to {
                self.start_note(n, transpose);
            }
        }
    }

    /// Moves the clock on by `frames` samples, collecting what happens now
    /// into `events` (cleared first).
    pub fn advance(&mut self, frames: usize, clip: &Clip, s: &ClipSettings) {
        self.events.clear();
        if self.keys.is_empty() {
            if self.playing {
                self.stop();
            }
            return;
        }
        if !self.playing {
            self.playing = true;
            self.finished = false;
            self.pos = 0.0;
        }
        let transpose = *self.keys.last().unwrap() as i32 - s.root as i32;
        let ticks = frames as f64 * s.bpm.max(1.0) as f64 / 60.0 * PPQ as f64 / s.sr as f64;

        // Notes that end now.
        let events = &mut self.events;
        self.sounding.retain_mut(|(n, left)| {
            *left -= ticks;
            if *left <= 0.0 {
                events.push(ClipEvent::Off(*n));
                false
            } else {
                true
            }
        });
        if self.finished {
            return;
        }

        // Notes that start in this block, then on around the loop.
        let len = clip.length.max(MIN_LENGTH) as f64;
        self.pos = self.pos.min(len);
        let end = self.pos + ticks;
        self.start_between(clip, self.pos, end.min(len), transpose);
        if end >= len {
            if s.looped {
                self.pos = end - len;
                self.start_between(clip, 0.0, self.pos, transpose);
            } else {
                self.finished = true;
                self.pos = len;
            }
        } else {
            self.pos = end;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(pitch: u8, start: u32, length: u32) -> ClipNote {
        ClipNote { pitch, start, length, velocity: 100 }
    }

    /// 120 bpm at 48 kHz: a quarter note is 24000 samples, a tick 250.
    fn settings() -> ClipSettings {
        ClipSettings { root: 60, looped: true, bpm: 120.0, sr: 48_000.0 }
    }

    fn run(p: &mut ClipPlayer, clip: &Clip, s: &ClipSettings, samples: usize) -> Vec<(usize, ClipEvent)> {
        let mut out = Vec::new();
        let mut t = 0;
        while t < samples {
            p.advance(32, clip, s);
            out.extend(p.events.iter().map(|e| (t, *e)));
            t += 32;
        }
        out
    }

    #[test]
    fn clips_are_cleaned_up() {
        assert!(Clip::new(10, &[]).is_none());
        assert!(Clip::new(MAX_LENGTH + 1, &[]).is_none());
        let c = Clip::new(PPQ * 4, &[note(64, 96, 48), note(60, 0, 1000), note(60, 0, 10), note(61, 400, 10), note(62, 0, 0)]).unwrap();
        assert_eq!(c.notes, [note(60, 0, 384), note(64, 96, 48)]);
        assert_eq!(Clip::from_raw(&c.to_raw()), Some(c));
        assert_eq!(Clip::from_raw(&[1, 2, 3]), None);
        let d = Clip::default();
        assert_eq!(Clip::new(d.length, &d.notes), Some(d));
    }

    #[test]
    fn plays_in_time_and_loops() {
        let clip = Clip::new(PPQ * 2, &[note(60, 0, 48), note(67, PPQ, 48)]).unwrap();
        let mut p = ClipPlayer::new();
        p.press(60);
        let ev = run(&mut p, &clip, &settings(), 48_000 * 2);
        let ons: Vec<(usize, u8)> = ev.iter().filter_map(|(t, e)| if let ClipEvent::On(n, _) = e { Some((*t, *n)) } else { None }).collect();
        // A beat is 24000 samples; the clip is two beats long.
        let expect = [(0, 60), (24_000, 67), (48_000, 60), (72_000, 67)];
        assert_eq!(ons.len(), expect.len(), "{ons:?}");
        for ((t, n), (et, en)) in ons.iter().zip(expect) {
            assert_eq!(*n, en);
            assert!((*t as i64 - et as i64).abs() <= 32, "{ons:?}");
        }
        // Each note stops after its eighth (12000 samples).
        let off = ev.iter().find(|(_, e)| *e == ClipEvent::Off(60)).unwrap().0;
        assert!((off as i64 - 12_000).abs() <= 32, "{off}");
    }

    #[test]
    fn transposes_by_the_last_key_and_keeps_its_place() {
        let clip = Clip::new(PPQ * 2, &[note(60, 0, 24), note(64, PPQ, 24)]).unwrap();
        let mut p = ClipPlayer::new();
        p.press(62);
        let first = run(&mut p, &clip, &settings(), 30_000);
        assert!(first.iter().any(|(_, e)| *e == ClipEvent::On(62, 100.0 / 127.0)));
        assert!(first.iter().any(|(_, e)| *e == ClipEvent::On(66, 100.0 / 127.0)));
        // Another key: the next note follows it, without starting over.
        p.press(55);
        let next = run(&mut p, &clip, &settings(), 20_000);
        assert!(next.iter().any(|(_, e)| *e == ClipEvent::On(55, 100.0 / 127.0)), "{next:?}");
        assert!(p.position().unwrap() > 0.0);
    }

    #[test]
    fn letting_go_stops_and_pressing_again_starts_over() {
        let clip = Clip::default();
        let mut p = ClipPlayer::new();
        p.press(60);
        run(&mut p, &clip, &settings(), 5000);
        p.release(60);
        p.advance(32, &clip, &settings());
        assert!(p.events.iter().all(|e| matches!(e, ClipEvent::Off(_))));
        assert_eq!(p.position(), None);
        p.press(60);
        p.advance(32, &clip, &settings());
        assert_eq!(p.events[0], ClipEvent::On(60, 110.0 / 127.0));
    }

    #[test]
    fn without_loop_it_plays_once() {
        let clip = Clip::new(PPQ, &[note(60, 0, 24)]).unwrap();
        let mut p = ClipPlayer::new();
        p.press(60);
        let s = ClipSettings { looped: false, ..settings() };
        let ev = run(&mut p, &clip, &s, 24_000 * 3);
        assert_eq!(ev.iter().filter(|(_, e)| matches!(e, ClipEvent::On(..))).count(), 1);
        assert_eq!(p.position(), None);
    }

    #[test]
    fn notes_out_of_range_are_skipped() {
        let clip = Clip::new(PPQ, &[note(120, 0, 24), note(60, 24, 24)]).unwrap();
        let mut p = ClipPlayer::new();
        p.press(80);
        let ev = run(&mut p, &clip, &settings(), 12_000);
        let ons: Vec<u8> = ev.iter().filter_map(|(_, e)| if let ClipEvent::On(n, _) = e { Some(*n) } else { None }).collect();
        assert_eq!(ons, [80]);
    }
}
