//! The complete instrument: voice allocation, global modulation, effects,
//! and the signal taps / telemetry the UI draws from.

use crate::arp::{Arp, ArpEvent, ArpMode, ArpSettings};
use crate::clip::{ClipEvent, ClipPlayer, ClipSettings};
use crate::fx::{self, Ctx, FxChain};
use crate::lfo::{self, sanitize_points, Chaos, LfoMode, LfoPoint, LFO_TABLE};
use crate::osc::{warp2_phase, Warp};
use crate::params::{
    self, arp, clip, defs, master, osc, osc_idx, src, ARP_BASE, CLIP_BASE, F_GLOBAL, F_MOD, F_SMOOTH, NUM_ENV, NUM_LFO,
    NUM_OSC, NUM_PARAMS, NUM_SLOTS,
};
use crate::patch::{ModSlot, Patch};
use crate::util::{fast_tanh, BLOCK};
use crate::voice::{self, lfo_params, ActiveSlot, Shared, Voice, VoiceTaps};
use crate::tablejobs::{TableJobs, FRAMES_PER_CALL};
use crate::wavetable::{Bank, UserTable, Wavetable, FACTORY_TABLES, USER_TABLES};
use std::rc::Rc;

pub const MAX_VOICES: usize = 16;
/// Largest number of frames a single `process` call may render.
pub const MAX_FRAMES: usize = 1024;

/// Signal taps: ring buffers of the mono signal at each point of the chain.
pub mod tap {
    use crate::fx;
    use crate::voice;
    /// 0..voice::tap::N are the per-voice taps of the newest voice.
    pub const MIX: usize = voice::tap::N;
    /// The taps of the effect chain (`fx::tap`): one after each unit, then
    /// the two lanes of the fork and what leaves it.
    pub const FX: usize = MIX + 1;
    pub const SPLIT_A: usize = FX + fx::tap::SPLIT_A;
    pub const SPLIT_B: usize = FX + fx::tap::SPLIT_B;
    pub const SPLIT_OUT: usize = FX + fx::tap::SPLIT_OUT;
    pub const OUT: usize = FX + fx::tap::N;
    pub const N: usize = OUT + 1;
    pub const LEN: usize = 2048;
}

/// Layout of the telemetry array handed to the UI.
pub mod tele {
    use crate::params::{src, NUM_ENV, NUM_LFO, NUM_PARAMS};
    pub const VOICES: usize = 0;
    pub const PEAK_L: usize = 1;
    pub const PEAK_R: usize = 2;
    pub const NOTE: usize = 3;
    pub const PITCH: usize = 4;
    pub const TAP_POS: usize = 5;
    pub const GATE: usize = 6;
    pub const COMP_REDUCTION: usize = 7;
    /// Where the clip sequencer is, in ticks (-1 while it is not playing).
    pub const CLIP_POS: usize = 8;
    /// The clip that plays (0-based); key switching can change it.
    pub const CLIP_SLOT: usize = 9;
    pub const ENV_POS: usize = 10;
    pub const ENV_VAL: usize = ENV_POS + NUM_ENV;
    pub const LFO_PHASE: usize = ENV_VAL + NUM_ENV;
    pub const LFO_VAL: usize = LFO_PHASE + NUM_LFO;
    pub const SOURCES: usize = LFO_VAL + NUM_LFO;
    pub const PARAMS: usize = SOURCES + src::N;
    pub const LEN: usize = PARAMS + NUM_PARAMS;
}

pub struct Synth {
    sr: f32,
    pub patch: Patch,
    smoothed: Vec<f32>,
    global_m: Vec<f32>,
    voices: Vec<Voice>,
    bank: Bank,
    tables: [Rc<Wavetable>; NUM_OSC],
    /// The bank index of the table each oscillator is playing.
    table_idx: [usize; NUM_OSC],
    /// On the audio thread, tables are built a little at a time (see
    /// `tablejobs`) and factory tables are requested from the main thread.
    /// Elsewhere (previews, tests) they are built on the spot.
    realtime: bool,
    jobs: TableJobs,
    lfo_tables: [[f32; LFO_TABLE + 1]; NUM_LFO],
    lfo_free: [f32; NUM_LFO],
    /// Free-running chaotic LFOs, shared by all voices, and their values.
    lfo_chaos: [Chaos; NUM_LFO],
    lfo_chaos_val: [f32; NUM_LFO],
    voice_slots: Vec<ActiveSlot>,
    global_slots: Vec<ActiveSlot>,
    fx: FxChain,
    arp: Arp,
    clip: ClipPlayer,
    /// The clip that plays, and the `clip.slot` setting last seen (a new
    /// setting wins over a key switch).
    clip_slot: usize,
    clip_slot_setting: usize,
    /// Oversampling of the voices (1, 2 or 4) and the filters that bring
    /// them back to the output rate.
    oversample: usize,
    decimator: crate::oversample::Decimator,
    /// What turned the keys into notes during the last block.
    player: Player,
    /// Notes the voices are playing and have not been told to stop: the
    /// keys, or the arpeggiator's notes while it is on.
    held: Vec<u8>,
    age: u64,
    last_pitch: Option<f32>,
    mod_wheel: f32,
    aftertouch: f32,
    pitch_bend: f32,
    g_uni: [f32; src::N],
    g_bi: [f32; src::N],
    master_gain: f32,
    pub out_l: Vec<f32>,
    pub out_r: Vec<f32>,
    pub taps: Vec<f32>,
    tap_pos: usize,
    pub telemetry: Vec<f32>,
}

/// What turns the keys into notes.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Player {
    /// The keys play the voices directly.
    Keys,
    Arp,
    Clip,
}

#[inline]
fn plain(m: &[f32], i: usize) -> f32 {
    defs()[i].to_plain(m[i])
}

/// Gentle limiter on the master bus: transparent below 0.8, never above 1.
#[inline]
fn soft_clip(x: f32) -> f32 {
    let a = x.abs();
    if a <= 0.8 {
        x
    } else {
        (0.8 + 0.2 * fast_tanh((a - 0.8) / 0.2)).copysign(x)
    }
}

impl Synth {
    pub fn new(sample_rate: f32) -> Synth {
        let sr = if sample_rate.is_finite() && sample_rate >= 8000.0 { sample_rate } else { 48_000.0 };
        let patch = Patch::init();
        let mut bank = Bank::new();
        let t0 = bank.get(0);
        let mut s = Synth {
            sr,
            smoothed: patch.values.clone(),
            global_m: patch.values.clone(),
            patch,
            voices: (0..MAX_VOICES).map(|i| Voice::new(0x1234_5678 ^ (i as u32 + 1).wrapping_mul(0x9E37_79B9))).collect(),
            tables: [t0.clone(), t0.clone(), t0],
            bank,
            table_idx: [0; NUM_OSC],
            realtime: false,
            jobs: TableJobs::default(),
            lfo_tables: [[0.0; LFO_TABLE + 1]; NUM_LFO],
            lfo_free: [0.0; NUM_LFO],
            lfo_chaos: [Chaos::default(); NUM_LFO],
            lfo_chaos_val: [0.5; NUM_LFO],
            voice_slots: Vec::with_capacity(NUM_SLOTS),
            global_slots: Vec::with_capacity(NUM_SLOTS),
            fx: FxChain::new(sr),
            arp: Arp::new(),
            clip: ClipPlayer::new(),
            clip_slot: 0,
            clip_slot_setting: 0,
            oversample: 1,
            decimator: crate::oversample::Decimator::new(),
            player: Player::Keys,
            held: Vec::with_capacity(32),
            age: 0,
            last_pitch: None,
            mod_wheel: 0.0,
            aftertouch: 0.0,
            pitch_bend: 0.0,
            g_uni: [0.0; src::N],
            g_bi: [0.0; src::N],
            master_gain: 0.0,
            out_l: vec![0.0; MAX_FRAMES],
            out_r: vec![0.0; MAX_FRAMES],
            taps: vec![0.0; tap::N * tap::LEN],
            tap_pos: 0,
            telemetry: vec![0.0; tele::LEN],
        };
        s.refresh();
        s.telemetry[tele::NOTE] = -1.0;
        s
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// Build tables a little at a time and ask for factory tables instead of
    /// generating them (for the audio thread).
    pub fn set_realtime(&mut self, on: bool) {
        self.realtime = on;
    }

    /// A factory table the patch uses that is neither built nor on its way,
    /// for the audio thread to request from the main thread.
    pub fn wanted_table(&self) -> Option<usize> {
        (0..NUM_OSC)
            .map(|o| self.patch.table_index(o))
            .find(|&idx| idx < FACTORY_TABLES && self.bank.peek(idx).is_none() && !self.jobs.is_pending(idx))
    }

    /// Room for the raw frames of factory table `index` (see `tablejobs`).
    pub fn offer_table(&mut self, index: usize, frames: usize) -> &mut [f32] {
        self.jobs.offer(index, frames)
    }

    pub fn offered_table_ready(&mut self) {
        self.jobs.start_offered(&self.bank);
    }

    /// Points the oscillators at the tables the patch asks for.
    fn update_tables(&mut self) {
        for slot in 0..USER_TABLES {
            if self.bank.user(slot) == &self.patch.user_tables[slot] && !self.jobs.is_pending(FACTORY_TABLES + slot) {
                continue;
            }
            if self.realtime {
                self.jobs.start_user(&self.bank, slot, &self.patch.user_tables[slot]);
                continue;
            }
            // Let go of the table first, so the bank can rebuild just the
            // frames that changed in place.
            for o in 0..NUM_OSC {
                if self.table_idx[o] == FACTORY_TABLES + slot {
                    self.tables[o] = self.bank.get(0);
                    self.table_idx[o] = usize::MAX;
                }
            }
            self.bank.set_user(slot, &self.patch.user_tables[slot]);
        }
        for o in 0..NUM_OSC {
            let idx = self.patch.table_index(o);
            if idx == self.table_idx[o] {
                continue;
            }
            match self.bank.peek(idx) {
                Some(table) => {
                    self.tables[o] = table;
                    self.table_idx[o] = idx;
                }
                // Not built yet: keep playing the current table until it is.
                // A user table is built from the patch; a factory table
                // comes from the main thread (`wanted_table`).
                None if self.realtime => {
                    if let Some(slot) = idx.checked_sub(FACTORY_TABLES) {
                        if !self.jobs.is_pending(idx) {
                            self.jobs.start_user(&self.bank, slot, &self.patch.user_tables[slot]);
                        }
                    }
                }
                None => {
                    self.tables[o] = self.bank.get(idx);
                    self.table_idx[o] = idx;
                }
            }
        }
    }

    /// Re-derives everything that depends on the patch.
    fn refresh(&mut self) {
        self.update_tables();
        for l in 0..NUM_LFO {
            lfo::render_points(&self.patch.lfo_shapes[l], &mut self.lfo_tables[l]);
        }
        self.voice_slots.clear();
        self.global_slots.clear();
        let d = defs();
        for s in self.patch.slots.iter() {
            if !s.is_set() || s.amount == 0.0 {
                continue;
            }
            let def = &d[s.dst as usize];
            if !def.has(F_MOD) {
                continue;
            }
            let a = ActiveSlot { src: s.src as usize, dst: s.dst as usize, amount: s.amount, bipolar: s.bipolar, curve: s.curve, aux: s.aux_src() };
            if def.has(F_GLOBAL) {
                self.global_slots.push(a);
            } else {
                self.voice_slots.push(a);
            }
        }
    }

    // --- patch editing -------------------------------------------------------

    pub fn set_param(&mut self, idx: usize, norm: f32) {
        if idx >= NUM_PARAMS || !norm.is_finite() {
            return;
        }
        self.patch.values[idx] = norm.max(0.0).min(1.0);
        if (0..NUM_OSC).any(|o| idx == osc_idx(o, osc::WT) || idx == osc_idx(o, osc::USER)) {
            self.refresh();
        }
    }

    pub fn get_param(&self, idx: usize) -> f32 {
        self.patch.values.get(idx).copied().unwrap_or(0.0)
    }

    pub fn set_slot(&mut self, i: usize, slot: ModSlot) {
        if i < NUM_SLOTS {
            self.patch.slots[i] = slot;
            self.refresh();
        }
    }

    pub fn set_lfo_shape(&mut self, l: usize, mut points: Vec<LfoPoint>) {
        if l < NUM_LFO {
            sanitize_points(&mut points);
            self.patch.lfo_shapes[l] = points;
            self.refresh();
        }
    }

    pub fn set_user_table(&mut self, slot: usize, table: UserTable) {
        if slot < USER_TABLES {
            self.patch.user_tables[slot] = table;
            self.refresh();
        }
    }

    pub fn set_clip(&mut self, slot: usize, clip: crate::clip::Clip) {
        if let Some(c) = self.patch.clips.get_mut(slot) {
            *c = clip;
        }
    }

    /// Plays clip `slot` from its start from now on.
    fn switch_clip(&mut self, slot: usize) {
        if slot != self.clip_slot {
            self.clip_slot = slot;
            self.clip.stop();
            self.carry_out_clip();
        }
    }

    pub fn set_fx_chain(&mut self, order: &[u8], lanes: &[u8]) -> bool {
        self.patch.set_fx_chain(order, lanes)
    }

    /// Replaces the whole patch. Sounding notes keep playing with the new
    /// settings; values jump rather than glide.
    pub fn load_patch(&mut self, patch: Patch) {
        self.patch = patch;
        self.snap();
    }

    /// Applies all pending parameter changes at once, skipping the smoothing.
    pub fn snap(&mut self) {
        self.smoothed.copy_from_slice(&self.patch.values);
        self.refresh();
    }

    // --- performance input ---------------------------------------------------

    /// What the patch asks to turn the keys into notes: the clip sequencer
    /// if it is on, else the arpeggiator if that is on, else the keys alone.
    fn wanted_player(&self) -> Player {
        if self.patch.values[CLIP_BASE + clip::ON] >= 0.5 {
            Player::Clip
        } else if self.patch.values[ARP_BASE + arp::ON] >= 0.5 {
            Player::Arp
        } else {
            Player::Keys
        }
    }

    /// A key goes down. With the arpeggiator or the clip on, it only tells
    /// them which keys are held; they play the notes.
    pub fn note_on(&mut self, note: u8, velocity: f32) {
        let note = note.min(127);
        let velocity = velocity.max(0.0).min(1.0);
        if velocity <= 0.0 {
            self.note_off(note);
            return;
        }
        if self.is_switch_key(note) {
            self.switch_clip((note - crate::clip::SWITCH_KEYS.start) as usize);
            return;
        }
        // Both always know the keys, so either can take over at any time.
        self.arp.press(note, velocity);
        self.clip.press(note);
        if self.player == Player::Keys && self.wanted_player() == Player::Keys {
            self.voice_on(note, velocity);
        }
    }

    /// With key switching on, the lowest octave picks the clip.
    fn is_switch_key(&self, note: u8) -> bool {
        self.wanted_player() == Player::Clip && self.patch.values[CLIP_BASE + clip::KEY_SWITCH] >= 0.5 && crate::clip::SWITCH_KEYS.contains(&note)
    }

    /// A key comes up.
    pub fn note_off(&mut self, note: u8) {
        if self.is_switch_key(note) {
            return;
        }
        self.arp.release(note);
        self.clip.release(note);
        if self.player == Player::Keys {
            self.voice_off(note);
        }
    }

    /// Plays a note straight on the voices, past the arpeggiator and the
    /// clip (to hear a note while editing them).
    pub fn audition_on(&mut self, note: u8, velocity: f32) {
        self.voice_on(note.min(127), velocity.max(0.01).min(1.0));
    }

    pub fn audition_off(&mut self, note: u8) {
        self.voice_off(note.min(127));
    }

    fn voice_on(&mut self, note: u8, velocity: f32) {
        self.age += 1;
        self.held.retain(|n| *n != note);
        self.held.push(note);
        let base = &self.smoothed;
        let porta = plain(base, master::PORTA) > 0.001;
        let always = base[master::PORTA_ALWAYS] >= 0.5;
        let overlapping = self.held.len() > 1;

        if base[master::MONO] >= 0.5 {
            let legato = base[master::LEGATO] >= 0.5;
            let v = &mut self.voices[0];
            let was_active = v.active;
            let tied = overlapping && v.gate && was_active;
            let glide = if porta && was_active && (always || tied) { Some(v.current_pitch()) } else { None };
            v.note_on(note, velocity, self.age, glide, !was_active, !(legato && tied), base);
        } else {
            let limit = (plain(base, master::VOICES) as usize).max(1).min(MAX_VOICES);
            // Prefer: the same note still ringing out, then a free voice,
            // then the oldest released voice, then the oldest voice.
            let mut pick = None;
            let mut fresh = true;
            if let Some(i) = self.voices[..limit].iter().position(|v| v.active && !v.gate && v.note == note) {
                pick = Some(i);
                fresh = false;
            }
            if pick.is_none() {
                pick = self.voices[..limit].iter().position(|v| !v.active);
            }
            if pick.is_none() {
                fresh = false;
                pick = self.voices[..limit]
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| (v.gate, v.age))
                    .map(|(i, _)| i);
            }
            let glide = match self.last_pitch {
                Some(p) if porta && (always || overlapping) => Some(p),
                _ => None,
            };
            self.voices[pick.unwrap_or(0)].note_on(note, velocity, self.age, glide, fresh, true, base);
        }
        self.last_pitch = Some(note as f32);
    }

    fn voice_off(&mut self, note: u8) {
        self.held.retain(|n| *n != note);
        if self.smoothed[master::MONO] >= 0.5 {
            let v = &mut self.voices[0];
            if v.active && v.gate && v.note == note {
                match self.held.last() {
                    // Another key is still down: fall back to it.
                    Some(&prev) => {
                        v.retarget(prev);
                        self.last_pitch = Some(prev as f32);
                    }
                    None => v.note_off(),
                }
            }
            // Voices left over from poly mode.
            for v in self.voices[1..].iter_mut() {
                if v.active && v.gate && v.note == note {
                    v.note_off();
                }
            }
        } else {
            for v in self.voices.iter_mut() {
                if v.active && v.gate && v.note == note {
                    v.note_off();
                }
            }
        }
    }

    pub fn all_notes_off(&mut self) {
        self.arp.clear_keys();
        self.arp.stop();
        self.arp.events.clear();
        self.clip.clear_keys();
        self.clip.stop();
        self.clip.events.clear();
        self.held.clear();
        for v in self.voices.iter_mut() {
            if v.active && v.gate {
                v.note_off();
            }
        }
    }

    /// Silence everything immediately.
    pub fn panic(&mut self) {
        self.arp.clear_keys();
        self.arp.stop();
        self.arp.events.clear();
        self.clip.clear_keys();
        self.clip.stop();
        self.clip.events.clear();
        self.held.clear();
        for v in self.voices.iter_mut() {
            v.kill();
        }
        self.fx = FxChain::new(self.sr);
    }

    pub fn set_pitch_bend(&mut self, v: f32) {
        self.pitch_bend = if v.is_finite() { v.max(-1.0).min(1.0) } else { 0.0 };
    }

    pub fn set_mod_wheel(&mut self, v: f32) {
        self.mod_wheel = if v.is_finite() { v.max(0.0).min(1.0) } else { 0.0 };
    }

    pub fn set_aftertouch(&mut self, v: f32) {
        self.aftertouch = if v.is_finite() { v.max(0.0).min(1.0) } else { 0.0 };
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    // --- audio ---------------------------------------------------------------

    /// Renders `frames` samples into `out_l` / `out_r`.
    pub fn process(&mut self, frames: usize) {
        if !self.jobs.run(&mut self.bank, FRAMES_PER_CALL).is_empty() {
            // A table finished: an edited user table replaces the one that
            // is playing, a new one is switched to.
            for o in 0..NUM_OSC {
                if self.bank.peek(self.table_idx[o]).is_some_and(|t| !Rc::ptr_eq(&t, &self.tables[o])) {
                    self.table_idx[o] = usize::MAX;
                }
            }
            self.update_tables();
        }
        let frames = frames.min(MAX_FRAMES);
        let mut peak = (0.0f32, 0.0f32);
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(BLOCK);
            let p = self.block(done, n);
            peak = (peak.0.max(p.0), peak.1.max(p.1));
            done += n;
        }
        self.update_telemetry(peak);
    }

    fn block(&mut self, offset: usize, n: usize) -> (f32, f32) {
        let d = defs();
        let dt = n as f32 / self.sr;

        // Parameter smoothing.
        let coeff = 1.0 - (-(n as f32) / (0.012 * self.sr)).exp();
        for i in 0..NUM_PARAMS {
            let target = self.patch.values[i];
            if d[i].has(F_SMOOTH) {
                self.smoothed[i] += (target - self.smoothed[i]) * coeff;
            } else {
                self.smoothed[i] = target;
            }
        }
        let bpm = plain(&self.smoothed, master::BPM);
        self.run_players(n, bpm);

        // Free-running LFO clocks.
        let mut free_params = [None; NUM_LFO];
        for l in 0..NUM_LFO {
            let p = lfo_params(d, &self.smoothed, l, bpm);
            let ph = self.lfo_free[l] + p.rate_hz * dt;
            self.lfo_free[l] = ph - ph.floor();
            if p.kind.is_chaos() && p.mode == LfoMode::Free {
                self.lfo_chaos[l].advance(p.kind, p.rate_hz * dt);
                self.lfo_chaos_val[l] = self.lfo_chaos[l].value(p.kind);
            }
            free_params[l] = Some(p);
        }

        // Voices.
        let mut bus_l = [0.0f32; BLOCK];
        let mut bus_r = [0.0f32; BLOCK];
        let mut vtaps: VoiceTaps = [[0.0; BLOCK]; voice::tap::N];
        let newest = self
            .voices
            .iter()
            .enumerate()
            .filter(|(_, v)| v.active)
            .max_by_key(|(_, v)| v.age)
            .map(|(i, _)| i);
        let os = [1usize, 2, 4][(plain(&self.smoothed, master::QUALITY) as usize).min(2)];
        if os != self.oversample {
            self.oversample = os;
            self.decimator.clear();
        }
        {
            let shared = Shared {
                sr: self.sr * os as f32,
                base: &self.smoothed,
                slots: &self.voice_slots,
                tables: core::array::from_fn(|o| &*self.tables[o]),
                lfo_tables: &self.lfo_tables,
                lfo_free: self.lfo_free,
                lfo_chaos: self.lfo_chaos_val,
                mod_wheel: self.mod_wheel,
                aftertouch: self.aftertouch,
                pitch_bend: self.pitch_bend,
            };
            if os == 1 {
                for (i, v) in self.voices.iter_mut().enumerate() {
                    if !v.active {
                        continue;
                    }
                    let taps = if Some(i) == newest { Some(&mut vtaps) } else { None };
                    v.process(&shared, &mut bus_l[..n], &mut bus_r[..n], taps);
                }
            } else {
                // The voices run `os` short blocks at the higher rate, one
                // after the other, then the sound comes back down.
                let mut big_l = [0.0f32; BLOCK * 4];
                let mut big_r = [0.0f32; BLOCK * 4];
                let mut sub_taps: VoiceTaps = [[0.0; BLOCK]; voice::tap::N];
                for k in 0..os {
                    let range = k * n..(k + 1) * n;
                    for (i, v) in self.voices.iter_mut().enumerate() {
                        if !v.active {
                            continue;
                        }
                        let taps = if Some(i) == newest { Some(&mut sub_taps) } else { None };
                        v.process(&shared, &mut big_l[range.clone()], &mut big_r[range.clone()], taps);
                    }
                    // The displays get every `os`-th sample.
                    if newest.is_some() {
                        for (out, sub) in vtaps.iter_mut().zip(sub_taps.iter()) {
                            for j in 0..n {
                                let at = k * n + j;
                                if at % os == 0 {
                                    out[at / os] = sub[j];
                                }
                            }
                        }
                    }
                }
                self.decimator.process(0, os, &mut big_l, n);
                self.decimator.process(1, os, &mut big_r, n);
                bus_l[..n].copy_from_slice(&big_l[..n]);
                bus_r[..n].copy_from_slice(&big_r[..n]);
            }
        }

        // Global modulation follows the newest voice.
        match newest {
            Some(i) => {
                self.g_uni = self.voices[i].uni;
                self.g_bi = self.voices[i].bi;
            }
            None => {
                for e in 0..NUM_ENV {
                    self.g_uni[src::env(e)] = 0.0;
                    self.g_bi[src::env(e)] = -1.0;
                }
                for l in 0..NUM_LFO {
                    // With no note playing only free-running LFOs keep moving.
                    if let Some(p) = free_params[l] {
                        if p.mode == LfoMode::Free {
                            let ph = self.lfo_free[l] + p.phase;
                            let v = if p.kind.is_chaos() { self.lfo_chaos_val[l] } else { lfo::eval(p.kind, ph - ph.floor(), &self.lfo_tables[l], 0.5, 0.5) };
                            self.g_uni[src::lfo(l)] = v;
                            self.g_bi[src::lfo(l)] = 2.0 * v - 1.0;
                        }
                    }
                }
                let mut set = |s: usize, v: f32| {
                    self.g_uni[s] = v;
                    self.g_bi[s] = 2.0 * v - 1.0;
                };
                set(src::MOD_WHEEL, self.mod_wheel);
                set(src::AFTERTOUCH, self.aftertouch);
                for k in 0..params::NUM_MACRO {
                    set(src::macro_(k), self.smoothed[master::MACRO1 + k]);
                }
                self.g_uni[src::PITCH_BEND] = (self.pitch_bend + 1.0) * 0.5;
                self.g_bi[src::PITCH_BEND] = self.pitch_bend;
            }
        }
        self.global_m.copy_from_slice(&self.smoothed);
        for s in self.global_slots.iter() {
            self.global_m[s.dst] += s.offset(&self.g_uni, &self.g_bi);
        }

        // Effects.
        let mut mix_tap = [0.0f32; BLOCK];
        for s in 0..n {
            mix_tap[s] = (bus_l[s] + bus_r[s]) * 0.5;
        }
        let mut fx_taps = [[0.0f32; BLOCK]; fx::tap::N];
        {
            let ctx = Ctx { m: &self.global_m, defs: d, sr: self.sr, bpm, shift: 0 };
            self.fx.process(&self.patch.fx_order, &self.patch.fx_lane, &ctx, &mut bus_l[..n], &mut bus_r[..n], &mut fx_taps);
        }

        // Master.
        let vol = plain(&self.global_m, master::VOLUME);
        let gain_end = vol * vol * 2.0;
        let mut gain = self.master_gain;
        let dgain = (gain_end - gain) / n as f32;
        let mut peak = (0.0f32, 0.0f32);
        let mut out_tap = [0.0f32; BLOCK];
        for s in 0..n {
            let l = soft_clip(bus_l[s] * gain);
            let r = soft_clip(bus_r[s] * gain);
            let (l, r) = (if l.is_finite() { l } else { 0.0 }, if r.is_finite() { r } else { 0.0 });
            self.out_l[offset + s] = l;
            self.out_r[offset + s] = r;
            out_tap[s] = (l + r) * 0.5;
            peak = (peak.0.max(l.abs()), peak.1.max(r.abs()));
            gain += dgain;
        }
        self.master_gain = gain_end;

        // Taps.
        let mut write = |t: usize, data: &[f32], pos: usize| {
            let base = t * tap::LEN;
            for (s, v) in data.iter().enumerate() {
                self.taps[base + ((pos + s) & (tap::LEN - 1))] = *v;
            }
        };
        let pos = self.tap_pos;
        for t in 0..voice::tap::N {
            write(t, &vtaps[t][..n], pos);
        }
        write(tap::MIX, &mix_tap[..n], pos);
        for f in 0..fx::tap::N {
            write(tap::FX + f, &fx_taps[f][..n], pos);
        }
        write(tap::OUT, &out_tap[..n], pos);
        self.tap_pos = (pos + n) & (tap::LEN - 1);
        peak
    }

    /// Hands the keys to whatever should play them now (the keys alone,
    /// the arpeggiator or the clip) and lets it play this block.
    fn run_players(&mut self, n: usize, bpm: f32) {
        let want = self.wanted_player();
        if want != self.player {
            // The keys held (the arpeggiator keeps them with their velocity).
            let mut keys = [(0u8, 0.0f32); 32];
            let mut count = 0;
            for k in self.arp.keys().take(keys.len()) {
                keys[count] = k;
                count += 1;
            }
            // What played so far lets go...
            match self.player {
                Player::Keys => {
                    for &(note, _) in keys[..count].iter() {
                        self.voice_off(note);
                    }
                }
                Player::Arp => {
                    self.arp.stop();
                    self.carry_out_arp();
                }
                Player::Clip => {
                    self.clip.stop();
                    self.carry_out_clip();
                }
            }
            // ...and without a player, the keys still held sound as played.
            if want == Player::Keys {
                for &(note, vel) in keys[..count].iter() {
                    self.voice_on(note, vel);
                }
            }
            self.player = want;
        }
        match self.player {
            Player::Keys => {}
            Player::Arp => {
                let p = |k: usize| plain(&self.smoothed, ARP_BASE + k);
                // Gate and swing can be modulated: they are read as modulated
                // in the last block (global modulation runs after the voices).
                let moved = |k: usize| plain(&self.global_m, ARP_BASE + k);
                let settings = ArpSettings {
                    mode: ArpMode::from_index(p(arp::MODE) as usize),
                    div: p(arp::DIV) as usize,
                    octaves: p(arp::OCTAVES) as u8,
                    gate: moved(arp::GATE),
                    swing: moved(arp::SWING),
                    bpm,
                    sr: self.sr,
                };
                self.arp.advance(n, &settings);
                self.carry_out_arp();
            }
            Player::Clip => {
                let setting = (plain(&self.smoothed, CLIP_BASE + clip::SLOT) as usize).max(1).min(crate::clip::NUM_CLIPS) - 1;
                if setting != self.clip_slot_setting {
                    self.clip_slot_setting = setting;
                    self.switch_clip(setting);
                }
                let p = |k: usize| plain(&self.smoothed, CLIP_BASE + k);
                let settings = ClipSettings { root: p(clip::ROOT) as u8, looped: p(clip::LOOP) >= 0.5, bpm, sr: self.sr };
                self.clip.advance(n, &self.patch.clips[self.clip_slot], &settings);
                self.carry_out_clip();
            }
        }
    }

    fn carry_out_clip(&mut self) {
        let events = std::mem::take(&mut self.clip.events);
        for e in events.iter() {
            match *e {
                ClipEvent::On(note, vel) => self.voice_on(note, vel),
                ClipEvent::Off(note) => self.voice_off(note),
            }
        }
        self.clip.events = events;
        self.clip.events.clear();
    }

    fn carry_out_arp(&mut self) {
        let events = std::mem::take(&mut self.arp.events);
        for e in events.iter() {
            match *e {
                ArpEvent::On(note, vel) => self.voice_on(note, vel),
                ArpEvent::Off(note) => self.voice_off(note),
            }
        }
        self.arp.events = events;
        self.arp.events.clear();
    }

    fn update_telemetry(&mut self, peak: (f32, f32)) {
        let d = defs();
        let newest = self.voices.iter().filter(|v| v.active).max_by_key(|v| v.age);
        let t = &mut self.telemetry;
        t[tele::VOICES] = self.voices.iter().filter(|v| v.active).count() as f32;
        t[tele::PEAK_L] = peak.0;
        t[tele::PEAK_R] = peak.1;
        t[tele::TAP_POS] = self.tap_pos as f32;
        t[tele::CLIP_POS] = match (self.player, self.clip.position()) {
            (Player::Clip, Some(pos)) => pos as f32,
            _ => -1.0,
        };
        t[tele::CLIP_SLOT] = self.clip_slot as f32;
        match newest {
            Some(v) => {
                t[tele::NOTE] = v.note as f32;
                t[tele::PITCH] = v.current_pitch();
                t[tele::GATE] = if v.gate { 1.0 } else { 0.0 };
                for e in 0..NUM_ENV {
                    t[tele::ENV_POS + e] = v.envs[e].position();
                    t[tele::ENV_VAL + e] = v.envs[e].value;
                }
                for l in 0..NUM_LFO {
                    t[tele::LFO_PHASE + l] = v.lfos[l].phase;
                    t[tele::LFO_VAL + l] = v.uni[src::lfo(l)];
                }
                t[tele::SOURCES..tele::SOURCES + src::N].copy_from_slice(&v.uni);
                for i in 0..NUM_PARAMS {
                    let m = if d[i].has(F_GLOBAL) { self.global_m[i] } else { v.m[i] };
                    t[tele::PARAMS + i] = m.max(0.0).min(1.0);
                }
            }
            None => {
                t[tele::NOTE] = -1.0;
                t[tele::GATE] = 0.0;
                for e in 0..NUM_ENV {
                    t[tele::ENV_POS + e] = 0.0;
                    t[tele::ENV_VAL + e] = 0.0;
                }
                for l in 0..NUM_LFO {
                    t[tele::LFO_PHASE + l] = self.lfo_free[l];
                    t[tele::LFO_VAL + l] = self.g_uni[src::lfo(l)];
                }
                t[tele::SOURCES..tele::SOURCES + src::N].copy_from_slice(&self.g_uni);
                for i in 0..NUM_PARAMS {
                    let m = if d[i].has(F_GLOBAL) { self.global_m[i] } else { self.smoothed[i] };
                    t[tele::PARAMS + i] = m.max(0.0).min(1.0);
                }
            }
        }
    }

    // --- previews for the UI -------------------------------------------------

    /// One cycle of an oscillator as it currently sounds: table position and
    /// both warps applied. `pos` and the warp amounts are passed in so the UI
    /// can animate them with the live modulated values.
    pub fn preview_osc(&mut self, o: usize, pos: f32, warp_amt: f32, warp2_amt: f32, out: &mut [f32]) {
        let o = o.min(NUM_OSC - 1);
        let other = params::OSC_MODULATOR[o];
        let p = &self.patch;
        let table = self.bank.get(p.table_index(o));
        let other_table = self.bank.get(p.table_index(other));
        let warp = Warp::from_index(p.plain(osc_idx(o, osc::WARP)) as usize);
        let warp2 = Warp::from_index(p.plain(osc_idx(o, osc::WARP2)) as usize);
        let pitch = |x: usize| p.plain(osc_idx(x, osc::OCT)) * 12.0 + p.plain(osc_idx(x, osc::SEMI)) + p.plain(osc_idx(x, osc::COARSE));
        let ratio = (2.0f32).powf((pitch(other) - pitch(o)) / 12.0);
        let other_pos = p.plain(osc_idx(other, osc::POS));
        let other_on = p.values[osc_idx(other, osc::ON)] >= 0.5;
        let n = out.len();
        for (i, v) in out.iter_mut().enumerate() {
            let ph = i as f32 / n as f32;
            let modulator = if (warp.needs_modulator() || warp2.needs_modulator()) && other_on {
                let mp = ph * ratio;
                other_table.sample(0, other_pos, mp - mp.floor())
            } else {
                0.0
            };
            // A modulator mode with nothing to listen to plays the plain wave, as in the voice.
            let usable = |w: Warp| if w.needs_modulator() && !other_on { Warp::Off } else { w };
            let (wp, amp) = warp2_phase(usable(warp), warp_amt.max(0.0).min(1.0), usable(warp2), warp2_amt.max(0.0).min(1.0), ph, modulator);
            *v = table.sample(0, pos, wp.min(0.999_999)) * amp;
        }
    }

    /// One frame of a table of the bank (factory tables, then the user
    /// tables), for the 3D table view.
    pub fn preview_table(&mut self, table: usize, pos: f32, out: &mut [f32]) {
        self.bank.get(table).render_cycle(pos, out);
    }

    /// The patch as a Serum 2 preset, with its wavetables embedded.
    pub fn serum_export(&mut self) -> crate::serum::Export {
        crate::serum::pack(&self.patch, &mut self.bank)
    }

    pub fn table_frames(&mut self, table: usize) -> usize {
        self.bank.get(table).frames
    }

    /// The shape of an LFO over one cycle (random shapes show a fixed
    /// example pattern; chaotic ones their first cycle from the start
    /// position).
    pub fn preview_lfo(&self, l: usize, out: &mut [f32]) {
        let l = l.min(NUM_LFO - 1);
        let kind = lfo::LfoKind::from_index(self.patch.plain(params::lfo_idx(l, params::lfo::SHAPE)) as usize);
        let n = out.len();
        // Fixed "random" steps so the picture does not jitter.
        const STEPS: [f32; 9] = [0.35, 0.8, 0.15, 0.6, 0.95, 0.4, 0.05, 0.7, 0.35];
        if kind.is_chaos() {
            let start = self.patch.plain(params::lfo_idx(l, params::lfo::PHASE));
            let mut c = Chaos::start(kind, start - start.floor());
            let step = 1.0 / (n - 1).max(1) as f32;
            for (i, v) in out.iter_mut().enumerate() {
                if i > 0 {
                    c.advance(kind, step);
                }
                *v = c.value(kind);
            }
            return;
        }
        for (i, v) in out.iter_mut().enumerate() {
            let ph = i as f32 / (n - 1).max(1) as f32;
            *v = match kind {
                lfo::LfoKind::SampleHold | lfo::LfoKind::Smooth => {
                    let x = (ph * 8.0).min(7.999);
                    let k = x as usize;
                    lfo::eval(kind, x - k as f32, &self.lfo_tables[l], STEPS[k], STEPS[k + 1])
                }
                _ => lfo::eval(kind, ph, &self.lfo_tables[l], 0.5, 0.5),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{env, env_idx, filter, lfo_idx, unit_on, FILTER_BASE, NUM_UNITS};
    use crate::wavetable::Bank;
    use crate::patch::ModSlot;

    fn render(s: &mut Synth, seconds: f32) -> Vec<f32> {
        let total = (s.sample_rate() * seconds) as usize;
        let mut out = Vec::with_capacity(total);
        while out.len() < total {
            s.process(128);
            out.extend_from_slice(&s.out_l[..128]);
        }
        out
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn silent_until_played_then_sounds_then_stops() {
        let mut s = Synth::new(48_000.0);
        assert_eq!(rms(&render(&mut s, 0.1)), 0.0);
        s.note_on(60, 0.8);
        let on = render(&mut s, 0.3);
        assert!(rms(&on) > 0.02, "rms {}", rms(&on));
        assert!(on.iter().all(|v| v.is_finite() && v.abs() <= 1.0));
        assert_eq!(s.active_voices(), 1);
        s.note_off(60);
        render(&mut s, 0.3);
        assert_eq!(s.active_voices(), 0);
        assert_eq!(rms(&render(&mut s, 0.1)), 0.0);
    }

    #[test]
    fn polyphony_limit_and_stealing() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(master::VOICES, 4.0);
        s.snap();
        for n in 0..10 {
            s.note_on(48 + n, 0.7);
            s.process(128);
        }
        assert_eq!(s.active_voices(), 4);
        s.all_notes_off();
        render(&mut s, 0.3);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn mono_legato_keeps_one_voice_and_returns_to_held_note() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(master::MONO, 1.0);
        s.patch.set_plain(master::LEGATO, 1.0);
        s.snap();
        s.note_on(60, 0.8);
        s.process(128);
        s.note_on(67, 0.8);
        s.process(128);
        assert_eq!(s.active_voices(), 1);
        assert_eq!(s.telemetry[tele::NOTE], 67.0);
        s.note_off(67);
        s.process(128);
        assert_eq!(s.active_voices(), 1);
        assert_eq!(s.telemetry[tele::NOTE], 60.0);
        s.note_off(60);
        render(&mut s, 0.3);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn the_newer_destinations_change_the_sound() {
        let key = |k: &str| params::index_of_key(k).unwrap_or_else(|| panic!("no {k}"));
        // (destination, settings that make it audible); macro 1 at full moves it.
        let cases: &[(&str, &[(&str, f32)])] = &[
            ("filter.keytrack", &[("filter.cutoff", 300.0)]),
            ("filter2.keytrack", &[("filter2.on", 1.0), ("filter2.cutoff", 300.0)]),
            ("env1.decCurve", &[("env1.decay", 0.3), ("env1.sustain", 0.1)]),
            ("lfo1.rise", &[]),
            ("lfo1.delay", &[]),
            ("lfo1.smooth", &[("lfo1.shape", 4.0)]),
            ("phaser.phase", &[("phaser.on", 1.0), ("phaser.mix", 1.0)]),
            ("comp.attack", &[("comp.on", 1.0), ("comp.threshold", -40.0)]),
            ("comp.release", &[("comp.on", 1.0), ("comp.threshold", -40.0)]),
            ("flanger.phase", &[("flanger.on", 1.0), ("flanger.mix", 1.0)]),
            ("arp.gate", &[("arp.on", 1.0), ("arp.gate", 0.2)]),
            ("arp.swing", &[("arp.on", 1.0), ("arp.div", 10.0)]),
        ];
        for &(dst, setup) in cases {
            let run = |connect: bool| {
                let mut s = Synth::new(48_000.0);
                s.patch.set_plain(FILTER_BASE + filter::CUTOFF, 2000.0);
                for &(k, v) in setup {
                    s.patch.set_plain(key(k), v);
                }
                s.patch.set_plain(master::MACRO1, 1.0);
                s.snap();
                // LFO 1 moves the cutoff, so its own settings are heard.
                s.set_slot(0, ModSlot { src: src::LFO1 as u8, dst: (FILTER_BASE + filter::CUTOFF) as u16, amount: 0.4, bipolar: false, ..ModSlot::EMPTY });
                if connect {
                    let amount = if s.patch.values[key(dst)] > 0.5 { -0.6 } else { 0.6 };
                    s.set_slot(1, ModSlot { src: src::MACRO1 as u8, dst: key(dst) as u16, amount, bipolar: false, ..ModSlot::EMPTY });
                }
                s.note_on(48, 0.8);
                // Both channels: some destinations (the phase offsets) only move the right.
                let mut out = Vec::new();
                for _ in 0..(0.6 * 48_000.0 / 128.0) as usize {
                    s.process(128);
                    out.extend_from_slice(&s.out_l[..128]);
                    out.extend_from_slice(&s.out_r[..128]);
                }
                out
            };
            let (plain, moved) = (run(false), run(true));
            let diff = plain.iter().zip(&moved).fold(0.0f32, |m, (a, b)| m.max((a - b).abs()));
            assert!(diff > 1e-3, "{dst}: connecting it changed nothing");
            assert!(moved.iter().all(|v| v.is_finite()), "{dst}");
        }
    }

    #[test]
    fn modulation_reaches_voice_and_global_destinations() {
        let mut s = Synth::new(48_000.0);
        let cutoff = FILTER_BASE + filter::CUTOFF;
        s.patch.set_plain(cutoff, 200.0);
        s.patch.set_plain(lfo_idx(0, params::lfo::SYNC), 0.0);
        s.patch.set_plain(lfo_idx(0, params::lfo::RATE), 5.0);
        s.snap();
        s.set_slot(0, ModSlot { src: src::LFO1 as u8, dst: cutoff as u16, amount: 0.4, bipolar: false, ..ModSlot::EMPTY });
        s.set_slot(1, ModSlot { src: src::LFO1 as u8, dst: master::VOLUME as u16, amount: -0.3, bipolar: false, ..ModSlot::EMPTY });
        s.note_on(60, 0.8);
        let base = s.patch.values[cutoff];
        let (mut lo, mut hi) = (1.0f32, 0.0f32);
        let (mut vlo, mut vhi) = (1.0f32, 0.0f32);
        for _ in 0..200 {
            s.process(128);
            let m = s.telemetry[tele::PARAMS + cutoff];
            lo = lo.min(m);
            hi = hi.max(m);
            let v = s.telemetry[tele::PARAMS + master::VOLUME];
            vlo = vlo.min(v);
            vhi = vhi.max(v);
        }
        assert!((lo - base).abs() < 0.03, "lo {lo} base {base}");
        assert!((hi - (base + 0.4)).abs() < 0.03, "hi {hi}");
        assert!(vhi - vlo > 0.25, "volume swing {}", vhi - vlo);
    }

    #[test]
    fn chaos_lfos_move_targets_in_every_mode() {
        let cutoff = FILTER_BASE + filter::CUTOFF;
        for shape in [8.0, 9.0] {
            for mode in [0.0, 1.0, 2.0] {
                let mut s = Synth::new(48_000.0);
                s.patch.set_plain(cutoff, 500.0);
                s.patch.set_plain(lfo_idx(0, params::lfo::SHAPE), shape);
                s.patch.set_plain(lfo_idx(0, params::lfo::MODE), mode);
                s.patch.set_plain(lfo_idx(0, params::lfo::SYNC), 0.0);
                s.patch.set_plain(lfo_idx(0, params::lfo::RATE), 0.5);
                s.snap();
                s.set_slot(0, ModSlot { src: src::LFO1 as u8, dst: cutoff as u16, amount: 0.5, ..ModSlot::EMPTY });
                s.note_on(60, 0.8);
                let (mut lo, mut hi) = (1.0f32, 0.0f32);
                for _ in 0..375 {
                    s.process(128);
                    let m = s.telemetry[tele::PARAMS + cutoff];
                    lo = lo.min(m);
                    hi = hi.max(m);
                }
                assert!(hi - lo > 0.15, "shape {shape} mode {mode}: {lo}..{hi}");
                assert!(render(&mut s, 0.05).iter().all(|v| v.is_finite()));
            }
        }
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(lfo_idx(0, params::lfo::SHAPE), 8.0);
        let mut buf = [0.0f32; 64];
        s.preview_lfo(0, &mut buf);
        assert!(buf.iter().all(|v| (0.0..=1.0).contains(v)));
        assert!(buf.iter().fold(0.0f32, |m, v| m.max(*v)) - buf.iter().fold(1.0f32, |m, v| m.min(*v)) > 0.5);
    }

    #[test]
    fn mod_curve_and_aux_shape_a_routing() {
        let cutoff = FILTER_BASE + filter::CUTOFF;
        // Macro 1 at half way moves both a voice and a global target; read
        // back how far each one moved.
        let moved = |curve: f32, aux: u8, wheel: f32| {
            let mut s = Synth::new(48_000.0);
            s.patch.set_plain(cutoff, 200.0);
            s.patch.set_plain(master::MACRO1, 0.5);
            s.snap();
            let slot = ModSlot { src: src::MACRO1 as u8, amount: 0.4, curve, aux, ..ModSlot::EMPTY };
            s.set_slot(0, ModSlot { dst: cutoff as u16, ..slot });
            s.set_slot(1, ModSlot { dst: master::VOLUME as u16, amount: -0.4, ..slot });
            s.set_mod_wheel(wheel);
            s.note_on(60, 0.8);
            for _ in 0..40 {
                s.process(128);
            }
            let t = |i: usize| s.telemetry[tele::PARAMS + i] - s.patch.values[i];
            (t(cutoff), t(master::VOLUME))
        };
        let (c, v) = moved(0.0, 0, 0.0);
        assert!((c - 0.2).abs() < 0.01 && (v + 0.2).abs() < 0.01, "straight: {c} {v}");
        // Bent up, half way already goes most of the way.
        let up = crate::util::curve_shape(0.5, 0.5) * 0.4;
        let (c, v) = moved(0.5, 0, 0.0);
        assert!((c - up).abs() < 0.01 && (v + up).abs() < 0.01, "bent up: {c} {v}");
        let (c, _) = moved(-0.5, 0, 0.0);
        assert!(c < 0.1, "bent down: {c}");
        // The mod wheel as aux: closed, the routing does nothing.
        let (c, v) = moved(0.0, src::MOD_WHEEL as u8, 0.0);
        assert!(c.abs() < 0.01 && v.abs() < 0.01, "aux closed: {c} {v}");
        let (c, v) = moved(0.0, src::MOD_WHEEL as u8, 1.0);
        assert!((c - 0.2).abs() < 0.01 && (v + 0.2).abs() < 0.01, "aux open: {c} {v}");
    }

    #[test]
    fn envelope_shapes_loudness() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(env_idx(0, env::ATTACK), 0.2);
        s.patch.set_plain(env_idx(0, env::RELEASE), 0.2);
        s.snap();
        s.note_on(60, 1.0);
        let early = rms(&render(&mut s, 0.02));
        render(&mut s, 0.3);
        let late = rms(&render(&mut s, 0.05));
        assert!(late > early * 4.0, "early {early} late {late}");
        s.note_off(60);
        render(&mut s, 0.1);
        assert_eq!(s.active_voices(), 1, "still releasing");
        render(&mut s, 0.3);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn worst_case_patch_stays_finite_and_bounded() {
        let mut s = Synth::new(44_100.0);
        for o in 0..2 {
            s.patch.set_plain(osc_idx(o, osc::ON), 1.0);
            s.patch.set_plain(osc_idx(o, osc::UNISON), 16.0);
            s.patch.set_plain(osc_idx(o, osc::LEVEL), 1.0);
            s.patch.set_plain(osc_idx(o, osc::WARP), 11.0);
            s.patch.set_plain(osc_idx(o, osc::WARP_AMT), 1.0);
        }
        s.patch.set_plain(params::SUB_BASE + params::sub::ON, 1.0);
        s.patch.set_plain(params::NOISE_BASE + params::noise::ON, 1.0);
        s.patch.set_plain(FILTER_BASE + filter::RES, 1.0);
        s.patch.set_plain(FILTER_BASE + filter::CUTOFF, 800.0);
        s.patch.set_plain(master::VOLUME, 1.0);
        // Every copy of every effect, a third of them on each lane.
        for unit in 0..NUM_UNITS {
            s.patch.set_plain(unit_on(unit), 1.0);
            s.patch.fx_lane[unit] = (unit % 3) as u8;
        }
        s.snap();
        for n in 0..16 {
            s.note_on(36 + n * 3, 1.0);
        }
        let out = render(&mut s, 1.0);
        assert!(out.iter().all(|v| v.is_finite() && v.abs() <= 1.0));
        assert!(rms(&out) > 0.05);
    }

    #[test]
    fn taps_and_telemetry_are_filled() {
        let mut s = Synth::new(48_000.0);
        s.note_on(57, 0.9);
        render(&mut s, 0.1);
        let tap_rms = |t: usize| rms(&s.taps[t * tap::LEN..(t + 1) * tap::LEN]);
        assert!(tap_rms(voice::tap::OSC_A) > 0.1);
        assert_eq!(tap_rms(voice::tap::OSC_B), 0.0);
        assert!(tap_rms(voice::tap::FILTER_OUT) > 0.1);
        assert!(tap_rms(tap::MIX) > 0.01);
        assert!(tap_rms(tap::OUT) > 0.01);
        assert_eq!(tap_rms(tap::FX), 0.0, "effects are off");
        assert_eq!(tap_rms(tap::SPLIT_OUT), 0.0, "no fork");
        assert_eq!(s.telemetry[tele::NOTE], 57.0);
        assert_eq!(s.telemetry[tele::VOICES], 1.0);
        assert!(s.telemetry[tele::PEAK_L] > 0.0);
        assert!(s.telemetry[tele::ENV_VAL] > 0.9);
    }

    #[test]
    fn an_oscillator_plays_a_user_table_and_hears_edits() {
        use crate::wavetable::{UserTable, FACTORY_TABLES, USER_POINTS};
        let play = |user: f32, table: Option<UserTable>| {
            let mut s = Synth::new(48_000.0);
            s.patch.set_plain(osc_idx(0, osc::RAND), 0.0);
            s.patch.set_plain(osc_idx(0, osc::USER), user);
            s.snap();
            if let Some(table) = table {
                s.set_user_table(0, table);
            }
            s.note_on(48, 0.9);
            render(&mut s, 0.1)
        };
        let diff = |a: &[f32], b: &[f32]| a.iter().zip(b).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
        let factory = play(0.0, None);
        let sine = play(1.0, None);
        assert!(rms(&sine) > 0.02);
        assert!(diff(&factory, &sine) > 0.05, "the user table is heard instead of the factory one");
        let square: Vec<i8> = (0..USER_POINTS).map(|i| if i < USER_POINTS / 2 { 127 } else { -127 }).collect();
        let drawn = play(1.0, UserTable::new(&square));
        assert!(diff(&sine, &drawn) > 0.05, "an edit changes the sound");
        assert!(drawn.iter().all(|v| v.is_finite() && v.abs() <= 1.0));

        // Editing while a note sounds, switching back and forth, and the
        // preview all follow the table.
        let mut s = Synth::new(48_000.0);
        s.set_param(osc_idx(0, osc::USER), 0.5);
        assert_eq!(s.patch.table_index(0), FACTORY_TABLES);
        s.note_on(60, 0.9);
        render(&mut s, 0.02);
        s.set_user_table(0, UserTable::new(&square).unwrap());
        assert!(render(&mut s, 0.05).iter().all(|v| v.is_finite()));
        let mut buf = [0.0f32; 64];
        s.preview_osc(0, 0.0, 0.0, 0.0, &mut buf);
        assert!(buf[4] > 0.8 && buf[60] < -0.8, "the preview shows the square, flat right after its edge");
        s.set_param(osc_idx(0, osc::USER), 0.0);
        s.preview_osc(0, 0.0, 0.0, 0.0, &mut buf);
        assert!(buf[4] < 0.8, "back on the factory table");
        assert_eq!(s.table_frames(FACTORY_TABLES), 1);
    }

    /// Renders `blocks` audio callbacks of 128 frames.
    fn callbacks(s: &mut Synth, blocks: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for _ in 0..blocks {
            s.process(128);
            out.extend_from_slice(&s.out_l[..128]);
        }
        out
    }

    #[test]
    fn on_the_audio_thread_factory_tables_arrive_from_outside_and_build_gradually() {
        let mut s = Synth::new(48_000.0);
        s.set_realtime(true);
        assert_eq!(s.wanted_table(), None, "the default table is built at start");
        s.set_param(osc_idx(0, osc::WT), defs()[osc_idx(0, osc::WT)].to_norm(2.0)); // Acid Sweep, 48 frames
        s.note_on(48, 0.9);
        callbacks(&mut s, 3);
        assert_eq!(s.table_idx[0], 0, "still playing the old table");
        assert_eq!(s.wanted_table(), Some(2));
        let (frames, raw) = crate::tables::generate(2);
        s.offer_table(2, frames).copy_from_slice(&raw);
        s.offered_table_ready();
        assert_eq!(s.wanted_table(), None, "on its way");
        let calls = frames.div_ceil(FRAMES_PER_CALL);
        callbacks(&mut s, calls - 1);
        assert_eq!(s.table_idx[0], 0, "not finished yet");
        let out = callbacks(&mut s, 1);
        assert_eq!(s.table_idx[0], 2, "switched once complete");
        assert_eq!(s.tables[0].frames, frames);
        assert!(out.iter().all(|v| v.is_finite()));

        // The result is the same table the main thread builds in one go.
        let mut direct = Bank::new();
        let whole = direct.get(2);
        for f in [0, 17, frames - 1] {
            assert_eq!(s.tables[0].frame(5, f), whole.frame(5, f), "frame {f}");
        }
    }

    #[test]
    fn on_the_audio_thread_user_tables_build_gradually_and_sound_the_same() {
        use crate::wavetable::USER_POINTS;
        let frames = 16;
        let points: Vec<i8> = (0..frames * USER_POINTS).map(|i| ((i * 37 % 255) as i32 - 127) as i8).collect();
        let table = UserTable::new(&points).unwrap();
        let setup = |realtime: bool| {
            let mut s = Synth::new(48_000.0);
            s.set_realtime(realtime);
            s.patch.set_plain(osc_idx(0, osc::RAND), 0.0);
            s.patch.set_plain(osc_idx(0, osc::USER), 1.0);
            s.patch.set_plain(osc_idx(0, osc::POS), 0.6);
            s.patch.user_tables[0] = table.clone();
            s.snap();
            s
        };
        let mut rt = setup(true);
        assert_eq!(rt.table_idx[0], 0, "nothing built yet, the old table plays");
        callbacks(&mut rt, frames.div_ceil(FRAMES_PER_CALL));
        assert_eq!(rt.table_idx[0], FACTORY_TABLES, "built within a few callbacks");
        // The same number of callbacks on both, so the master gain has
        // ramped up the same way.
        let mut direct = setup(false);
        callbacks(&mut direct, frames.div_ceil(FRAMES_PER_CALL));
        rt.note_on(55, 0.9);
        direct.note_on(55, 0.9);
        let (a, b) = (callbacks(&mut rt, 40), callbacks(&mut direct, 40));
        let diff = a.iter().zip(&b).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
        assert!(diff < 1e-5, "differs by {diff}");

        // Editing one frame rebuilds just that frame, in the next callback.
        let mut edited = points.clone();
        edited[3 * USER_POINTS] = 127;
        rt.set_user_table(0, UserTable::new(&edited).unwrap());
        callbacks(&mut rt, 1);
        assert_eq!(rt.bank.user(0).points(), &edited[..], "installed after one callback");
    }

    /// One note through a patch set up by `setup`, as samples.
    fn note_through(setup: impl Fn(&mut Patch)) -> Vec<f32> {
        let mut s = Synth::new(48_000.0);
        for o in 0..NUM_OSC {
            s.patch.set_plain(osc_idx(o, osc::RAND), 0.0);
        }
        setup(&mut s.patch);
        s.snap();
        s.note_on(45, 0.9);
        render(&mut s, 0.15)
    }

    #[test]
    fn oscillator_c_sounds_and_can_listen_to_a() {
        let only_a = note_through(|_| {});
        let with_c = note_through(|p| p.set_plain(osc_idx(2, osc::ON), 1.0));
        assert!(rms(&with_c) > rms(&only_a) * 1.2, "C adds to the sound");
        let c_alone = note_through(|p| {
            p.set_plain(osc_idx(0, osc::ON), 0.0);
            p.set_plain(osc_idx(2, osc::ON), 1.0);
        });
        assert!(rms(&c_alone) > 0.02);
        // C's FM listens to A: with A on it changes the sound, with A off it cannot.
        let fm = |a_on: bool| {
            note_through(move |p| {
                p.set_plain(osc_idx(0, osc::ON), if a_on { 1.0 } else { 0.0 });
                p.set_plain(osc_idx(0, osc::LEVEL), 0.0);
                p.set_plain(osc_idx(2, osc::ON), 1.0);
                p.set_plain(osc_idx(2, osc::WARP), 11.0); // FM
                p.set_plain(osc_idx(2, osc::WARP_AMT), 0.8);
            })
        };
        let diff = |a: &[f32], b: &[f32]| a.iter().zip(b).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
        assert!(diff(&fm(true), &c_alone) > 0.05, "FM from A");
        assert!(diff(&fm(false), &c_alone) < 1e-4, "no A, no FM");
    }

    #[test]
    fn filter_2_in_series_and_in_parallel() {
        use crate::params::{filter2, FILTER2_BASE};
        let lp = |p: &mut Patch, base: usize, hz: f32| {
            p.set_plain(base + filter::ON, 1.0);
            p.set_plain(base + filter::TYPE, 2.0); // LP24
            p.set_plain(base + filter::CUTOFF, hz);
            p.set_plain(base + filter::RES, 0.0);
        };
        let open = note_through(|p| p.set_plain(FILTER_BASE + filter::ON, 0.0));
        let one = note_through(|p| lp(p, FILTER_BASE, 400.0));
        // Off, filter 2 changes nothing.
        let off = note_through(|p| {
            lp(p, FILTER_BASE, 400.0);
            p.set_plain(FILTER2_BASE + filter::CUTOFF, 100.0);
        });
        assert_eq!(off, one);
        // In series a second low-pass darkens further: compare the highs
        // (the sample-to-sample differences), not the overall level.
        let series = note_through(|p| {
            lp(p, FILTER_BASE, 400.0);
            lp(p, FILTER2_BASE, 150.0);
        });
        let highs = |x: &[f32]| rms(&x.windows(2).map(|w| w[1] - w[0]).collect::<Vec<f32>>());
        assert!(highs(&series) < highs(&one) * 0.7, "series: {} vs {}", highs(&series), highs(&one));
        // Swapping which filter does what gives the same sound in series.
        let swapped = note_through(|p| {
            lp(p, FILTER_BASE, 150.0);
            lp(p, FILTER2_BASE, 400.0);
        });
        assert!(rms(&swapped.iter().zip(&series).map(|(a, b)| a - b).collect::<Vec<f32>>()) < rms(&series) * 0.05);
        // In parallel the source picks: filter 1 only is like a single filter.
        let parallel = |sel: f32| {
            note_through(move |p| {
                lp(p, FILTER_BASE, 400.0);
                lp(p, FILTER2_BASE, 400.0);
                p.set_plain(FILTER2_BASE + filter2::MODE, 1.0);
                p.set_plain(osc_idx(0, osc::FILTER_SEL), sel);
            })
        };
        let diff = |a: &[f32], b: &[f32]| a.iter().zip(b).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
        assert!(diff(&parallel(0.0), &one) < 1e-5, "filter 1 only");
        assert!(diff(&parallel(1.0), &one) < 1e-5, "filter 2 only, set the same");
        // Both: half into each, so two identical filters sound like one.
        assert!(diff(&parallel(2.0), &one) < 1e-4, "both");
        // And two open filters in parallel leave the sound as it is.
        let both_open = note_through(|p| {
            p.set_plain(FILTER2_BASE + filter::ON, 1.0);
            p.set_plain(FILTER2_BASE + filter2::MODE, 1.0);
            p.set_plain(osc_idx(0, osc::FILTER_SEL), 2.0);
        });
        let one_open = note_through(|_| {});
        assert!(diff(&both_open, &one_open) < 1e-3, "level kept: {}", diff(&both_open, &one_open));
        assert!(rms(&open) > rms(&one));
    }

    #[test]
    fn previews_produce_waveforms() {
        let mut s = Synth::new(48_000.0);
        let mut buf = [0.0f32; 256];
        s.preview_osc(0, 0.5, 0.0, 0.0, &mut buf);
        assert!(rms(&buf) > 0.3);
        s.preview_table(3, 0.5, &mut buf);
        assert!(rms(&buf) > 0.3);
        s.preview_lfo(0, &mut buf);
        assert!(buf.iter().all(|v| (0.0..=1.0).contains(v)));
        assert!((buf[128] - 1.0).abs() < 0.02, "triangle peak in the middle");
    }

    #[test]
    fn load_patch_roundtrip_through_bytes_keeps_sound_identical() {
        let mut a = Synth::new(48_000.0);
        a.patch.set_plain(FILTER_BASE + filter::CUTOFF, 1200.0);
        a.patch.set_plain(osc_idx(0, osc::POS), 0.5);
        a.patch.set_plain(osc_idx(0, osc::RAND), 0.0);
        let bytes = a.patch.to_bytes();
        a.snap();
        let mut b = Synth::new(48_000.0);
        b.load_patch(Patch::from_bytes(&bytes).unwrap());
        a.note_on(60, 0.8);
        b.note_on(60, 0.8);
        let (ra, rb) = (render(&mut a, 0.1), render(&mut b, 0.1));
        let diff = ra.iter().zip(rb.iter()).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
        assert!(diff < 1e-3, "max difference {diff}");
    }

    /// The note the newest voice plays, every 1/16 at 120 bpm (6000 samples
    /// at 48 kHz), sampled in the middle of each step while the gate is open.
    fn arp_notes(s: &mut Synth, steps: usize) -> Vec<f32> {
        let mut notes = Vec::new();
        for _ in 0..steps {
            // 1500 samples in, then on to the next step.
            for _ in 0..12 {
                s.process(125);
            }
            notes.push(s.telemetry[tele::NOTE]);
            for _ in 0..36 {
                s.process(125);
            }
        }
        notes
    }

    #[test]
    fn the_arpeggiator_plays_the_held_keys_in_turn() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(ARP_BASE + arp::ON, 1.0);
        s.patch.set_plain(ARP_BASE + arp::OCTAVES, 2.0);
        s.snap();
        s.note_on(64, 0.8);
        s.note_on(60, 0.8);
        assert_eq!(arp_notes(&mut s, 5), [60.0, 64.0, 72.0, 76.0, 60.0]);
        // Only one note sounds at a time (the last one ringing out aside).
        assert!(s.active_voices() <= 2, "{}", s.active_voices());
        s.note_off(60);
        s.note_off(64);
        render(&mut s, 0.5);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn switching_the_arpeggiator_while_keys_are_held() {
        let mut s = Synth::new(48_000.0);
        s.note_on(60, 0.8);
        s.note_on(67, 0.8);
        s.process(128);
        assert_eq!(s.active_voices(), 2);
        // On: the chord becomes the pattern.
        s.set_param(ARP_BASE + arp::ON, 1.0);
        assert_eq!(arp_notes(&mut s, 3), [60.0, 67.0, 60.0]);
        // Off: the keys still held sound together again.
        s.set_param(ARP_BASE + arp::ON, 0.0);
        render(&mut s, 0.5);
        assert_eq!(s.active_voices(), 2);
        assert!(s.voices.iter().filter(|v| v.active).all(|v| v.gate));
        s.all_notes_off();
        s.set_param(ARP_BASE + arp::ON, 1.0);
        render(&mut s, 0.5);
        assert_eq!(s.active_voices(), 0, "all notes off also stops the pattern");
    }

    #[test]
    fn a_tied_arpeggio_glides_in_mono_legato() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(master::MONO, 1.0);
        s.patch.set_plain(master::LEGATO, 1.0);
        s.patch.set_plain(ARP_BASE + arp::ON, 1.0);
        s.patch.set_plain(ARP_BASE + arp::GATE, 1.0);
        s.snap();
        s.note_on(60, 0.8);
        s.note_on(63, 0.8);
        assert_eq!(arp_notes(&mut s, 4), [60.0, 63.0, 60.0, 63.0]);
        assert!(s.voices[0].gate, "the note is held across the steps");
    }

    #[test]
    fn a_tied_repeated_note_does_not_pile_up_voices() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(ARP_BASE + arp::ON, 1.0);
        s.patch.set_plain(ARP_BASE + arp::GATE, 1.0);
        s.snap();
        s.note_on(60, 0.8);
        arp_notes(&mut s, 6);
        let gated = s.voices.iter().filter(|v| v.active && v.gate).count();
        assert_eq!(gated, 1);
    }

    #[test]
    fn the_clip_plays_while_a_key_is_held_transposed_by_it() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(CLIP_BASE + clip::ON, 1.0);
        s.snap();
        // The default clip: root, octave, root, fifth in eighths (12000
        // samples at 120 bpm); `arp_notes` looks every 6000 samples.
        s.note_on(62, 0.8);
        let notes = arp_notes(&mut s, 8);
        assert_eq!(notes[0], 62.0);
        assert_eq!(notes[2], 74.0);
        assert_eq!(notes[6], 69.0);
        assert!(s.telemetry[tele::CLIP_POS] > 0.0);
        s.note_off(62);
        render(&mut s, 0.5);
        assert_eq!(s.active_voices(), 0);
        assert_eq!(s.telemetry[tele::CLIP_POS], -1.0);
    }

    #[test]
    fn oversampling_keeps_the_sound_and_cuts_what_folds_back() {
        // A high note with hard sync makes harmonics far past Nyquist.
        let note = 96u8;
        let f0 = 440.0 * (2.0f32).powf((note as f32 - 69.0) / 12.0);
        let run = |quality: f32, warp: f32| {
            let mut s = Synth::new(48_000.0);
            s.patch.set_plain(master::QUALITY, quality);
            s.patch.set_plain(osc_idx(0, osc::WARP), warp);
            s.patch.set_plain(osc_idx(0, osc::WARP_AMT), 0.8);
            s.patch.set_plain(FILTER_BASE + filter::CUTOFF, 20_000.0);
            s.snap();
            s.note_on(note, 0.9);
            render(&mut s, 0.2);
            render(&mut s, 0.5)
        };
        // How much of the sound is not a harmonic of the note.
        let folded = |x: &[f32]| {
            let total: f32 = x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32;
            let mut harmonic = 0.0;
            let mut k = 1.0;
            while k * f0 < 24_000.0 {
                let w = crate::util::TAU * k * f0 / 48_000.0;
                let c = 2.0 * w.cos();
                let (mut s1, mut s2) = (0.0f32, 0.0f32);
                for &v in x {
                    let s0 = v + c * s1 - s2;
                    s2 = s1;
                    s1 = s0;
                }
                let amp = (s1 * s1 + s2 * s2 - c * s1 * s2).sqrt() * 2.0 / x.len() as f32;
                harmonic += amp * amp / 2.0;
                k += 1.0;
            }
            ((total - harmonic).max(0.0) / total).sqrt()
        };
        // Plain: about the same sound at every setting.
        let (a, b, c) = (run(0.0, 0.0), run(1.0, 0.0), run(2.0, 0.0));
        assert!((rms(&b) / rms(&a) - 1.0).abs() < 0.05, "2x level {} vs {}", rms(&b), rms(&a));
        assert!((rms(&c) / rms(&a) - 1.0).abs() < 0.05, "4x level {} vs {}", rms(&c), rms(&a));
        // Hard sync: far less folds back. (Around 3% is what this simple
        // measurement leaks anyway, so 2x and 4x look alike here.)
        let sync = 1.0;
        let (x1, x2, x4) = (folded(&run(0.0, sync)), folded(&run(1.0, sync)), folded(&run(2.0, sync)));
        assert!(x2 < x1 * 0.5 && x4 < x1 * 0.5, "folded back: 1x {x1}, 2x {x2}, 4x {x4}");
    }

    #[test]
    fn clips_are_picked_by_the_setting_or_by_the_lowest_keys() {
        use crate::clip::{Clip, ClipNote, PPQ};
        let one = |pitch: u8| Clip::new(PPQ, &[ClipNote { pitch, start: 0, length: PPQ / 2, velocity: 100 }]).unwrap();
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(CLIP_BASE + clip::ON, 1.0);
        s.set_clip(2, one(40));
        s.set_clip(5, one(45));
        s.set_param(CLIP_BASE + clip::SLOT, defs()[CLIP_BASE + clip::SLOT].to_norm(3.0));
        s.snap();
        s.note_on(60, 0.8);
        assert_eq!(arp_notes(&mut s, 1), [40.0], "clip 3 plays as drawn on the root");
        assert_eq!(s.telemetry[tele::CLIP_SLOT], 2.0);
        // Without key switching, the lowest keys just play (transpose).
        s.note_on(29, 0.8);
        assert_eq!(s.telemetry[tele::CLIP_SLOT], 2.0);
        s.note_off(29);
        // With it, F1 picks clip 6 and starts it over; the key is not held.
        s.set_param(CLIP_BASE + clip::KEY_SWITCH, 1.0);
        s.note_on(29, 0.8);
        render(&mut s, 0.01);
        assert_eq!(s.telemetry[tele::CLIP_SLOT], 5.0);
        assert_eq!(arp_notes(&mut s, 1), [45.0], "clip 6, still transposed by the held 60");
        // Changing the setting takes over again.
        s.set_param(CLIP_BASE + clip::SLOT, defs()[CLIP_BASE + clip::SLOT].to_norm(1.0));
        render(&mut s, 0.01);
        assert_eq!(s.telemetry[tele::CLIP_SLOT], 0.0);
        s.note_off(29);
        s.note_off(60);
        render(&mut s, 0.5);
        assert_eq!(s.active_voices(), 0, "switching left nothing hanging");
    }

    #[test]
    fn the_clip_takes_over_from_the_arpeggiator_and_hands_back() {
        let mut s = Synth::new(48_000.0);
        s.patch.set_plain(ARP_BASE + arp::ON, 1.0);
        s.snap();
        s.note_on(60, 0.8);
        s.note_on(64, 0.8);
        assert_eq!(arp_notes(&mut s, 2), [60.0, 64.0]);
        s.set_param(CLIP_BASE + clip::ON, 1.0);
        // The clip follows the last key pressed: 64 plays it a third up.
        assert_eq!(arp_notes(&mut s, 1), [64.0]);
        s.set_param(CLIP_BASE + clip::ON, 0.0);
        s.set_param(ARP_BASE + arp::ON, 0.0);
        render(&mut s, 0.5);
        // Back to the keys alone: the chord held sounds.
        assert_eq!(s.voices.iter().filter(|v| v.active && v.gate).count(), 2);
    }
}
