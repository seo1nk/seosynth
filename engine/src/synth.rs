//! The complete instrument: voice allocation, global modulation, effects,
//! and the signal taps / telemetry the UI draws from.

use crate::fx::{Ctx, FxChain};
use crate::lfo::{self, sanitize_points, LfoMode, LfoPoint, LFO_TABLE};
use crate::osc::{warp_phase, Warp};
use crate::params::{
    self, defs, master, osc, osc_idx, src, F_GLOBAL, F_MOD, F_SMOOTH, NUM_ENV, NUM_FX, NUM_LFO,
    NUM_OSC, NUM_PARAMS, NUM_SLOTS,
};
use crate::patch::{ModSlot, Patch};
use crate::util::{fast_tanh, BLOCK};
use crate::voice::{self, lfo_params, ActiveSlot, Shared, Voice, VoiceTaps};
use crate::wavetable::{Bank, Wavetable};
use std::rc::Rc;

pub const MAX_VOICES: usize = 16;
/// Largest number of frames a single `process` call may render.
pub const MAX_FRAMES: usize = 1024;

/// Signal taps: ring buffers of the mono signal at each point of the chain.
pub mod tap {
    use crate::params::NUM_FX;
    use crate::voice;
    /// 0..voice::tap::N are the per-voice taps of the newest voice.
    pub const MIX: usize = voice::tap::N;
    /// One tap after each effect unit, indexed by effect id.
    pub const FX: usize = MIX + 1;
    pub const OUT: usize = FX + NUM_FX;
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
    pub const ENV_POS: usize = 8;
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
    table_idx: [usize; NUM_OSC],
    lfo_tables: [[f32; LFO_TABLE + 1]; NUM_LFO],
    lfo_free: [f32; NUM_LFO],
    voice_slots: Vec<ActiveSlot>,
    global_slots: Vec<ActiveSlot>,
    fx: FxChain,
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
            tables: [t0.clone(), t0],
            bank,
            table_idx: [0; NUM_OSC],
            lfo_tables: [[0.0; LFO_TABLE + 1]; NUM_LFO],
            lfo_free: [0.0; NUM_LFO],
            voice_slots: Vec::with_capacity(NUM_SLOTS),
            global_slots: Vec::with_capacity(NUM_SLOTS),
            fx: FxChain::new(sr),
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

    /// Re-derives everything that depends on the patch.
    fn refresh(&mut self) {
        for o in 0..NUM_OSC {
            let idx = self.patch.plain(osc_idx(o, osc::WT)) as usize;
            if idx != self.table_idx[o] || self.table_idx[o] >= self.bank.count() {
                self.tables[o] = self.bank.get(idx);
                self.table_idx[o] = idx;
            }
        }
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
            let a = ActiveSlot { src: s.src as usize, dst: s.dst as usize, amount: s.amount, bipolar: s.bipolar };
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
        if idx == osc_idx(0, osc::WT) || idx == osc_idx(1, osc::WT) {
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

    pub fn set_fx_order(&mut self, order: &[u8]) -> bool {
        self.patch.set_fx_order(order)
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

    pub fn note_on(&mut self, note: u8, velocity: f32) {
        let note = note.min(127);
        let velocity = velocity.max(0.0).min(1.0);
        if velocity <= 0.0 {
            self.note_off(note);
            return;
        }
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

    pub fn note_off(&mut self, note: u8) {
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
        self.held.clear();
        for v in self.voices.iter_mut() {
            if v.active && v.gate {
                v.note_off();
            }
        }
    }

    /// Silence everything immediately.
    pub fn panic(&mut self) {
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

        // Free-running LFO clocks.
        let mut free_params = [None; NUM_LFO];
        for l in 0..NUM_LFO {
            let p = lfo_params(d, &self.smoothed, l, bpm);
            let ph = self.lfo_free[l] + p.rate_hz * dt;
            self.lfo_free[l] = ph - ph.floor();
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
        {
            let shared = Shared {
                sr: self.sr,
                base: &self.smoothed,
                slots: &self.voice_slots,
                tables: [&*self.tables[0], &*self.tables[1]],
                lfo_tables: &self.lfo_tables,
                lfo_free: self.lfo_free,
                mod_wheel: self.mod_wheel,
                aftertouch: self.aftertouch,
                pitch_bend: self.pitch_bend,
            };
            for (i, v) in self.voices.iter_mut().enumerate() {
                if !v.active {
                    continue;
                }
                let taps = if Some(i) == newest { Some(&mut vtaps) } else { None };
                v.process(&shared, &mut bus_l[..n], &mut bus_r[..n], taps);
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
                    self.g_uni[src::ENV1 + e] = 0.0;
                    self.g_bi[src::ENV1 + e] = -1.0;
                }
                for l in 0..NUM_LFO {
                    // With no note playing only free-running LFOs keep moving.
                    if let Some(p) = free_params[l] {
                        if p.mode == LfoMode::Free {
                            let ph = self.lfo_free[l] + p.phase;
                            let v = lfo::eval(p.kind, ph - ph.floor(), &self.lfo_tables[l], 0.5, 0.5);
                            self.g_uni[src::LFO1 + l] = v;
                            self.g_bi[src::LFO1 + l] = 2.0 * v - 1.0;
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
                    set(src::MACRO1 + k, self.smoothed[master::MACRO1 + k]);
                }
                self.g_uni[src::PITCH_BEND] = (self.pitch_bend + 1.0) * 0.5;
                self.g_bi[src::PITCH_BEND] = self.pitch_bend;
            }
        }
        self.global_m.copy_from_slice(&self.smoothed);
        for s in self.global_slots.iter() {
            let v = if s.bipolar { self.g_bi[s.src] } else { self.g_uni[s.src] };
            self.global_m[s.dst] += s.amount * v;
        }

        // Effects.
        let mut mix_tap = [0.0f32; BLOCK];
        for s in 0..n {
            mix_tap[s] = (bus_l[s] + bus_r[s]) * 0.5;
        }
        let mut fx_taps = [[0.0f32; BLOCK]; NUM_FX];
        {
            let ctx = Ctx { m: &self.global_m, defs: d, sr: self.sr, bpm };
            self.fx.process(&self.patch.fx_order, &ctx, &mut bus_l[..n], &mut bus_r[..n], &mut fx_taps);
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
        for f in 0..NUM_FX {
            write(tap::FX + f, &fx_taps[f][..n], pos);
        }
        write(tap::OUT, &out_tap[..n], pos);
        self.tap_pos = (pos + n) & (tap::LEN - 1);
        peak
    }

    fn update_telemetry(&mut self, peak: (f32, f32)) {
        let d = defs();
        let newest = self.voices.iter().filter(|v| v.active).max_by_key(|v| v.age);
        let t = &mut self.telemetry;
        t[tele::VOICES] = self.voices.iter().filter(|v| v.active).count() as f32;
        t[tele::PEAK_L] = peak.0;
        t[tele::PEAK_R] = peak.1;
        t[tele::TAP_POS] = self.tap_pos as f32;
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
                    t[tele::LFO_VAL + l] = v.uni[src::LFO1 + l];
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
                    t[tele::LFO_VAL + l] = self.g_uni[src::LFO1 + l];
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
    /// warp applied. `pos` and `warp_amt` are passed in so the UI can animate
    /// them with the live modulated values.
    pub fn preview_osc(&mut self, o: usize, pos: f32, warp_amt: f32, out: &mut [f32]) {
        let o = o.min(NUM_OSC - 1);
        let other = 1 - o;
        let p = &self.patch;
        let table = self.bank.get(p.plain(osc_idx(o, osc::WT)) as usize);
        let other_table = self.bank.get(p.plain(osc_idx(other, osc::WT)) as usize);
        let warp = Warp::from_index(p.plain(osc_idx(o, osc::WARP)) as usize);
        let pitch = |x: usize| p.plain(osc_idx(x, osc::OCT)) * 12.0 + p.plain(osc_idx(x, osc::SEMI)) + p.plain(osc_idx(x, osc::COARSE));
        let ratio = (2.0f32).powf((pitch(other) - pitch(o)) / 12.0);
        let other_pos = p.plain(osc_idx(other, osc::POS));
        let other_on = p.values[osc_idx(other, osc::ON)] >= 0.5;
        let n = out.len();
        for (i, v) in out.iter_mut().enumerate() {
            let ph = i as f32 / n as f32;
            let modulator = if warp.needs_modulator() && other_on {
                let mp = ph * ratio;
                other_table.sample(0, other_pos, mp - mp.floor())
            } else {
                0.0
            };
            let (wp, amp) = warp_phase(warp, warp_amt.max(0.0).min(1.0), ph, modulator);
            *v = table.sample(0, pos, wp.min(0.999_999)) * amp;
        }
    }

    /// One frame of a factory table, for the 3D table view.
    pub fn preview_table(&mut self, table: usize, pos: f32, out: &mut [f32]) {
        self.bank.get(table).render_cycle(pos, out);
    }

    pub fn table_frames(&mut self, table: usize) -> usize {
        self.bank.get(table).frames
    }

    /// The shape of an LFO over one cycle (random shapes show a fixed
    /// example pattern).
    pub fn preview_lfo(&self, l: usize, out: &mut [f32]) {
        let l = l.min(NUM_LFO - 1);
        let kind = lfo::LfoKind::from_index(self.patch.plain(params::lfo_idx(l, params::lfo::SHAPE)) as usize);
        let n = out.len();
        // Fixed "random" steps so the picture does not jitter.
        const STEPS: [f32; 9] = [0.35, 0.8, 0.15, 0.6, 0.95, 0.4, 0.05, 0.7, 0.35];
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
    use crate::params::{env, env_idx, filter, lfo_idx, FILTER_BASE, FX_BASES};
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
    fn modulation_reaches_voice_and_global_destinations() {
        let mut s = Synth::new(48_000.0);
        let cutoff = FILTER_BASE + filter::CUTOFF;
        s.patch.set_plain(cutoff, 200.0);
        s.patch.set_plain(lfo_idx(0, params::lfo::SYNC), 0.0);
        s.patch.set_plain(lfo_idx(0, params::lfo::RATE), 5.0);
        s.snap();
        s.set_slot(0, ModSlot { src: src::LFO1 as u8, dst: cutoff as u16, amount: 0.4, bipolar: false });
        s.set_slot(1, ModSlot { src: src::LFO1 as u8, dst: master::VOLUME as u16, amount: -0.3, bipolar: false });
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
        for fx in 0..NUM_FX {
            s.patch.set_plain(FX_BASES[fx], 1.0);
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
        assert_eq!(s.telemetry[tele::NOTE], 57.0);
        assert_eq!(s.telemetry[tele::VOICES], 1.0);
        assert!(s.telemetry[tele::PEAK_L] > 0.0);
        assert!(s.telemetry[tele::ENV_VAL] > 0.9);
    }

    #[test]
    fn previews_produce_waveforms() {
        let mut s = Synth::new(48_000.0);
        let mut buf = [0.0f32; 256];
        s.preview_osc(0, 0.5, 0.0, &mut buf);
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
}
