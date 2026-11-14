//! The arpeggiator: plays the keys that are held one after another, in time
//! with the tempo.
//!
//! It sits between the keys and the voices. While it is on, pressing a key
//! only adds the note to the pattern; the arpeggiator then starts and stops
//! the notes itself. It always keeps track of the held keys, so switching it
//! on while a chord is held starts the pattern at once, and switching it off
//! lets the chord sound as played.
//!
//! Steps fall on block boundaries (`util::BLOCK` samples, under a
//! millisecond), but the clock itself keeps the exact time, so the timing
//! does not drift.

use crate::params::{ARP_MODES, DIVISION_BEATS};

/// Most keys the pattern follows at once.
const MAX_KEYS: usize = 32;
/// Shortest note an arpeggio plays, in seconds.
const MIN_GATE: f64 = 0.003;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ArpMode {
    Up,
    Down,
    UpDown,
    /// In the order the keys were pressed.
    Played,
    Random,
    /// Every held key together, once per step.
    Chord,
}

impl ArpMode {
    pub fn from_index(i: usize) -> ArpMode {
        match ARP_MODES.get(i).copied().unwrap_or("Up") {
            "Down" => ArpMode::Down,
            "UpDown" => ArpMode::UpDown,
            "Played" => ArpMode::Played,
            "Random" => ArpMode::Random,
            "Chord" => ArpMode::Chord,
            _ => ArpMode::Up,
        }
    }
}

/// The settings the arpeggiator plays with, in real units.
#[derive(Clone, Copy, Debug)]
pub struct ArpSettings {
    pub mode: ArpMode,
    /// Index into `DIVISIONS`: how long one step is.
    pub div: usize,
    /// How many octaves the pattern climbs (1 = only the keys held).
    pub octaves: u8,
    /// How long each note sounds, as a part of its step (0..1).
    pub gate: f32,
    /// How late every second step comes (0 = straight, 1 = as late as a
    /// dotted rhythm: three quarters of the pair, then one quarter).
    pub swing: f32,
    pub bpm: f32,
    pub sr: f32,
}

/// What the arpeggiator asks the voices to do.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ArpEvent {
    On(u8, f32),
    Off(u8),
}

pub struct Arp {
    /// The keys held, in the order they were pressed, with their velocity.
    keys: Vec<(u8, f32)>,
    /// The notes the arpeggiator has started and not yet released.
    sounding: Vec<u8>,
    /// Steps played since the pattern started.
    step: u64,
    /// Samples until the next step.
    to_next: f64,
    /// Samples until the sounding notes are released.
    to_release: f64,
    running: bool,
    last_random: Option<usize>,
    rng: u32,
    /// Events produced by the last `advance`, for the caller to carry out.
    pub events: Vec<ArpEvent>,
    /// Scratch space for the notes of a step (no allocation while playing).
    scratch: Vec<(u8, f32)>,
}

impl Default for Arp {
    fn default() -> Self {
        Arp::new()
    }
}

impl Arp {
    pub fn new() -> Arp {
        Arp {
            keys: Vec::with_capacity(MAX_KEYS),
            sounding: Vec::with_capacity(MAX_KEYS * 4),
            step: 0,
            to_next: 0.0,
            to_release: f64::INFINITY,
            running: false,
            last_random: None,
            rng: 0x2545_F491,
            events: Vec::with_capacity(MAX_KEYS * 8),
            scratch: Vec::with_capacity(MAX_KEYS * 4),
        }
    }

    /// The keys held, in the order they were pressed.
    pub fn keys(&self) -> impl Iterator<Item = (u8, f32)> + '_ {
        self.keys.iter().copied()
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn press(&mut self, note: u8, velocity: f32) {
        self.keys.retain(|k| k.0 != note);
        if self.keys.len() >= MAX_KEYS {
            self.keys.remove(0);
        }
        self.keys.push((note, velocity));
    }

    pub fn release(&mut self, note: u8) {
        self.keys.retain(|k| k.0 != note);
    }

    /// Forgets the held keys (the notes sounding are released by `stop`).
    pub fn clear_keys(&mut self) {
        self.keys.clear();
    }

    /// Releases every note the arpeggiator started and rewinds the pattern.
    pub fn stop(&mut self) {
        for &n in self.sounding.iter() {
            self.events.push(ArpEvent::Off(n));
        }
        self.sounding.clear();
        self.running = false;
        self.step = 0;
        self.to_release = f64::INFINITY;
    }

    fn random(&mut self) -> u32 {
        // xorshift32
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    /// Length of step `step` in samples, swing included.
    fn step_len(s: &ArpSettings, step: u64) -> f64 {
        let beats = DIVISION_BEATS[s.div.min(DIVISION_BEATS.len() - 1)] as f64;
        let len = beats * 60.0 / s.bpm.max(1.0) as f64 * s.sr as f64;
        let swing = s.swing.max(0.0).min(1.0) as f64 * 0.5;
        if step % 2 == 0 {
            len * (1.0 + swing)
        } else {
            len * (1.0 - swing)
        }
    }

    /// The notes of step `step` (into `scratch`).
    fn notes_of_step(&mut self, s: &ArpSettings, step: u64) {
        self.scratch.clear();
        if self.keys.is_empty() {
            return;
        }
        let octaves = s.octaves.max(1) as usize;
        let mut base: [(u8, f32); MAX_KEYS] = [(0, 0.0); MAX_KEYS];
        let n = self.keys.len();
        base[..n].copy_from_slice(&self.keys);
        if s.mode != ArpMode::Played {
            base[..n].sort_by_key(|k| k.0);
        }
        let shifted = |k: (u8, f32), o: usize| -> Option<(u8, f32)> {
            let note = k.0 as usize + 12 * o;
            (note <= 127).then_some((note as u8, k.1))
        };
        if s.mode == ArpMode::Chord {
            let o = (step % octaves as u64) as usize;
            for &k in base[..n].iter() {
                if let Some(k) = shifted(k, o) {
                    self.scratch.push(k);
                }
            }
            return;
        }
        // The whole run, every octave, low to high (or in the played order).
        let mut run: [(u8, f32); MAX_KEYS * 4] = [(0, 0.0); MAX_KEYS * 4];
        let mut len = 0;
        for o in 0..octaves.min(4) {
            for &k in base[..n].iter() {
                if let Some(k) = shifted(k, o) {
                    run[len] = k;
                    len += 1;
                }
            }
        }
        if len == 0 {
            return;
        }
        let pick = match s.mode {
            ArpMode::Up | ArpMode::Played => (step % len as u64) as usize,
            ArpMode::Down => len - 1 - (step % len as u64) as usize,
            ArpMode::UpDown => {
                // Up and back down without playing the top and bottom twice.
                let cycle = if len > 1 { 2 * len - 2 } else { 1 };
                let at = (step % cycle as u64) as usize;
                if at < len {
                    at
                } else {
                    cycle - at
                }
            }
            ArpMode::Random => {
                let mut at = (self.random() % len as u32) as usize;
                if len > 1 && Some(at) == self.last_random {
                    at = (at + 1 + (self.random() % (len as u32 - 1)) as usize) % len;
                }
                self.last_random = Some(at);
                at
            }
            ArpMode::Chord => unreachable!(),
        };
        self.scratch.push(run[pick]);
    }

    /// Plays one step: what was sounding stops, the step's notes start.
    fn play_step(&mut self, s: &ArpSettings) {
        let step = self.step;
        self.notes_of_step(s, step);
        let len = Arp::step_len(s, step);
        let gate = (s.gate.max(0.0).min(1.0) as f64 * len).max(MIN_GATE * s.sr as f64);
        // A full gate ties the notes: the next one starts before the last
        // stops, so a mono sound with legato glides between them.
        let tie = s.gate >= 0.999;
        // The step was due a little before this block: keep the clock exact.
        let late = self.to_next.min(0.0);
        if !tie {
            self.release_sounding();
        }
        for i in 0..self.scratch.len() {
            let (note, vel) = self.scratch[i];
            // The same note again is played afresh, not stacked on itself.
            if let Some(at) = self.sounding.iter().position(|n| *n == note) {
                self.events.push(ArpEvent::Off(note));
                self.sounding.swap_remove(at);
            }
            self.events.push(ArpEvent::On(note, vel));
            self.sounding.push(note);
        }
        if tie {
            let scratch = &self.scratch;
            let events = &mut self.events;
            self.sounding.retain(|n| {
                let keep = scratch.iter().any(|k| k.0 == *n);
                if !keep {
                    events.push(ArpEvent::Off(*n));
                }
                keep
            });
        }
        self.to_release = if tie || self.scratch.is_empty() { f64::INFINITY } else { late + gate };
        self.to_next = late + len;
        self.step += 1;
    }

    fn release_sounding(&mut self) {
        for &n in self.sounding.iter() {
            self.events.push(ArpEvent::Off(n));
        }
        self.sounding.clear();
        self.to_release = f64::INFINITY;
    }

    /// Moves the clock on by `frames` samples, collecting what happens
    /// right now into `events` (cleared first).
    pub fn advance(&mut self, frames: usize, s: &ArpSettings) {
        self.events.clear();
        if !self.running {
            if self.keys.is_empty() {
                // Let the last note finish its gate.
                self.tick_release(frames);
                return;
            }
            // The first key starts the pattern at once.
            self.running = true;
            self.step = 0;
            self.to_next = 0.0;
            self.last_random = None;
            self.release_sounding();
            self.play_step(s);
        } else if self.to_next <= 0.0 {
            if self.keys.is_empty() {
                self.running = false;
                self.step = 0;
                // A tied note has no gate of its own: it ends with the pattern.
                if self.to_release.is_infinite() {
                    self.release_sounding();
                }
            } else {
                self.play_step(s);
            }
        }
        self.tick_release(frames);
        if self.running {
            self.to_next -= frames as f64;
        }
    }

    fn tick_release(&mut self, frames: usize) {
        if self.to_release.is_finite() {
            self.to_release -= frames as f64;
            if self.to_release <= 0.0 {
                self.release_sounding();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(mode: ArpMode) -> ArpSettings {
        // 1/16 at 120 bpm and 48 kHz: 6000 samples a step.
        ArpSettings { mode, div: 14, octaves: 1, gate: 0.5, swing: 0.0, bpm: 120.0, sr: 48_000.0 }
    }

    /// Notes started over `steps` steps, run block by block.
    fn run(arp: &mut Arp, s: &ArpSettings, samples: usize) -> Vec<(usize, ArpEvent)> {
        let mut out = Vec::new();
        let mut t = 0;
        while t < samples {
            arp.advance(32, s);
            for e in arp.events.iter() {
                out.push((t, *e));
            }
            t += 32;
        }
        out
    }

    fn ons(events: &[(usize, ArpEvent)]) -> Vec<u8> {
        events.iter().filter_map(|(_, e)| if let ArpEvent::On(n, _) = e { Some(*n) } else { None }).collect()
    }

    fn pattern(mode: ArpMode, keys: &[u8], octaves: u8, steps: usize) -> Vec<u8> {
        let mut arp = Arp::new();
        for &k in keys {
            arp.press(k, 0.8);
        }
        let s = ArpSettings { octaves, ..settings(mode) };
        ons(&run(&mut arp, &s, steps * 6000 - 100))
    }

    #[test]
    fn orders() {
        let keys = [64, 60, 67]; // E, C, G pressed in that order
        assert_eq!(pattern(ArpMode::Up, &keys, 1, 6), [60, 64, 67, 60, 64, 67]);
        assert_eq!(pattern(ArpMode::Down, &keys, 1, 6), [67, 64, 60, 67, 64, 60]);
        assert_eq!(pattern(ArpMode::UpDown, &keys, 1, 8), [60, 64, 67, 64, 60, 64, 67, 64]);
        assert_eq!(pattern(ArpMode::Played, &keys, 1, 4), [64, 60, 67, 64]);
        assert_eq!(pattern(ArpMode::Up, &keys, 2, 7), [60, 64, 67, 72, 76, 79, 60]);
        assert_eq!(pattern(ArpMode::UpDown, &[60], 1, 3), [60, 60, 60]);
        assert_eq!(pattern(ArpMode::Chord, &keys, 2, 2), [60, 64, 67, 72, 76, 79]);
    }

    #[test]
    fn random_uses_held_notes_and_does_not_repeat() {
        let notes = pattern(ArpMode::Random, &[60, 62, 64], 1, 40);
        assert_eq!(notes.len(), 40);
        assert!(notes.iter().all(|n| [60, 62, 64].contains(n)));
        assert!(notes.windows(2).all(|w| w[0] != w[1]));
    }

    #[test]
    fn steps_follow_the_tempo_and_the_gate() {
        let mut arp = Arp::new();
        arp.press(60, 0.8);
        let s = settings(ArpMode::Up);
        let events = run(&mut arp, &s, 4 * 6000);
        let on_times: Vec<usize> = events.iter().filter(|(_, e)| matches!(e, ArpEvent::On(..))).map(|(t, _)| *t).collect();
        // Steps come every 6000 samples, give or take one block, without drift.
        for (k, t) in on_times.iter().enumerate() {
            assert!((*t as i64 - 6000 * k as i64).abs() <= 32, "step {k} at {t}");
        }
        // Each note is released after half a step.
        let off = events.iter().find(|(_, e)| matches!(e, ArpEvent::Off(_))).unwrap().0;
        assert!((off as i64 - 3000).abs() <= 32, "released at {off}");
    }

    #[test]
    fn swing_delays_every_second_step() {
        let mut arp = Arp::new();
        arp.press(60, 0.8);
        let s = ArpSettings { swing: 1.0, ..settings(ArpMode::Up) };
        let events = run(&mut arp, &s, 3 * 6000);
        let on_times: Vec<usize> = events.iter().filter(|(_, e)| matches!(e, ArpEvent::On(..))).map(|(t, _)| *t).collect();
        assert!((on_times[1] as i64 - 9000).abs() <= 32, "{on_times:?}");
        assert!((on_times[2] as i64 - 12000).abs() <= 32, "{on_times:?}");
    }

    #[test]
    fn letting_go_finishes_the_note_then_stops() {
        let mut arp = Arp::new();
        arp.press(60, 0.8);
        let s = settings(ArpMode::Up);
        run(&mut arp, &s, 1000);
        arp.release(60);
        let events = run(&mut arp, &s, 20_000);
        assert_eq!(ons(&events), Vec::<u8>::new());
        assert_eq!(events.iter().filter(|(_, e)| *e == ArpEvent::Off(60)).count(), 1);
        assert!(!arp.is_running());
        // Pressing again starts over from the first step at once.
        arp.press(62, 0.8);
        arp.press(60, 0.8);
        arp.advance(32, &s);
        assert_eq!(arp.events, [ArpEvent::On(60, 0.8)]);
    }

    #[test]
    fn a_full_gate_ties_the_notes() {
        let mut arp = Arp::new();
        arp.press(60, 0.8);
        arp.press(64, 0.8);
        let s = ArpSettings { gate: 1.0, ..settings(ArpMode::Up) };
        let events = run(&mut arp, &s, 6000 + 100);
        let e: Vec<ArpEvent> = events.iter().map(|(_, e)| *e).collect();
        // The next note starts before the previous one stops.
        assert_eq!(e, [ArpEvent::On(60, 0.8), ArpEvent::On(64, 0.8), ArpEvent::Off(60)]);
        arp.clear_keys();
        let after = run(&mut arp, &s, 7000);
        assert!(after.iter().any(|(_, e)| *e == ArpEvent::Off(64)));
    }

    #[test]
    fn stop_releases_everything() {
        let mut arp = Arp::new();
        arp.press(60, 0.8);
        let s = ArpSettings { mode: ArpMode::Chord, ..settings(ArpMode::Chord) };
        arp.press(67, 0.8);
        run(&mut arp, &s, 100);
        arp.events.clear();
        arp.stop();
        assert_eq!(arp.events, [ArpEvent::Off(60), ArpEvent::Off(67)]);
        assert!(!arp.is_running());
    }

    #[test]
    fn notes_above_the_top_are_left_out() {
        assert_eq!(pattern(ArpMode::Up, &[120], 2, 2), [120, 120]);
    }
}
