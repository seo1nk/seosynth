//! One synth voice: sources -> filters -> amplifier, plus its own envelopes
//! and LFOs.
//!
//! Each source either bypasses the filters or goes through them. Filter 2
//! runs after filter 1 (series) or beside it (parallel); in parallel every
//! source picks filter 1, filter 2 or both.

use crate::env::{Env, EnvParams};
use crate::filter::{Filter, FilterParams, FilterType};
use crate::lfo::{LfoKind, LfoMode, LfoParams, LfoState, LFO_TABLE};
use crate::osc::{OscParams, OscState, Warp};
use crate::params::{
    self, env, env_idx, filter, filter2, lfo, lfo_idx, master, noise, osc, osc_idx, src, sub, ParamDef,
    FILTER2_BASE, FILTER_BASE, NOISE_BASE, NUM_ENV, NUM_LFO, NUM_OSC, NUM_PARAMS, OSC_MODULATOR, SUB_BASE,
};
use crate::sources::{NoiseState, NoiseType, SubShape, SubState};
use crate::util::{midi_to_hz, Rng, BLOCK};
use crate::wavetable::Wavetable;

/// Headroom per voice so chords do not clip the master bus.
pub const VOICE_GAIN: f32 = 0.3;

/// Signal taps of the most recent voice, shown as little scopes in the UI.
pub mod tap {
    /// Oscillator `o` is tap `OSC_A + o`.
    pub const OSC_A: usize = 0;
    pub const OSC_B: usize = 1;
    pub const OSC_C: usize = 2;
    pub const SUB: usize = 3;
    pub const NOISE: usize = 4;
    /// What goes into and comes out of each filter.
    pub const FILTER_IN: usize = 5;
    pub const FILTER_OUT: usize = 6;
    pub const FILTER2_IN: usize = 7;
    pub const FILTER2_OUT: usize = 8;
    /// Everything that reaches the amplifier (filtered and bypassing).
    pub const PRE_AMP: usize = 9;
    pub const AMP: usize = 10;
    pub const N: usize = 11;
}

/// Where a source's sound goes.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Dest {
    Direct,
    Filter1,
    Filter2,
    /// Half into each filter (parallel only), so flat filters keep the level.
    Both,
}

/// How the filters are connected for one block.
#[derive(Clone, Copy)]
pub struct FilterRouting {
    pub f1: bool,
    pub f2: bool,
    pub parallel: bool,
}

impl FilterRouting {
    pub fn from_params(m: &[f32]) -> Self {
        let f1 = m[FILTER_BASE + filter::ON] >= 0.5;
        let f2 = m[FILTER2_BASE + filter::ON] >= 0.5;
        let mode = params::defs()[FILTER2_BASE + filter2::MODE].to_plain(m[FILTER2_BASE + filter2::MODE]);
        FilterRouting { f1, f2, parallel: f2 && mode >= 0.5 }
    }

    /// Where a source goes, from its "through the filters" switch and its
    /// choice of filter (`select`: 0 filter 1, 1 filter 2, 2 both). A
    /// source sent to a filter that is off goes on as if it were not there.
    pub fn dest(&self, through: bool, select: usize) -> Dest {
        if !through {
            return Dest::Direct;
        }
        if !self.parallel {
            return if self.f1 { Dest::Filter1 } else if self.f2 { Dest::Filter2 } else { Dest::Direct };
        }
        match (select, self.f1) {
            (0, true) => Dest::Filter1,
            (0, false) => Dest::Direct,
            (1, _) => Dest::Filter2,
            (_, true) => Dest::Both,
            (_, false) => Dest::Filter2,
        }
    }
}

/// The three buses sources are mixed into before the filters.
struct Buses {
    f1: [[f32; BLOCK]; 2],
    f2: [[f32; BLOCK]; 2],
    direct: [[f32; BLOCK]; 2],
}

impl Buses {
    fn add(&mut self, dest: Dest, l: &[f32], r: &[f32]) {
        let put = |bus: &mut [[f32; BLOCK]; 2], g: f32| {
            for s in 0..l.len() {
                bus[0][s] += l[s] * g;
                bus[1][s] += r[s] * g;
            }
        };
        match dest {
            Dest::Direct => put(&mut self.direct, 1.0),
            Dest::Filter1 => put(&mut self.f1, 1.0),
            Dest::Filter2 => put(&mut self.f2, 1.0),
            Dest::Both => {
                put(&mut self.f1, 0.5);
                put(&mut self.f2, 0.5);
            }
        }
    }
}

pub type VoiceTaps = [[f32; BLOCK]; tap::N];

/// A modulation routing prepared for the audio loop.
#[derive(Clone, Copy)]
pub struct ActiveSlot {
    pub src: usize,
    pub dst: usize,
    pub amount: f32,
    pub bipolar: bool,
}

/// Everything a voice needs from the synth for one block.
pub struct Shared<'a> {
    pub sr: f32,
    /// Smoothed, unmodulated parameter values (normalised).
    pub base: &'a [f32],
    pub slots: &'a [ActiveSlot],
    pub tables: [&'a Wavetable; NUM_OSC],
    pub lfo_tables: &'a [[f32; LFO_TABLE + 1]; NUM_LFO],
    pub lfo_free: [f32; NUM_LFO],
    pub mod_wheel: f32,
    pub aftertouch: f32,
    pub pitch_bend: f32,
}

pub struct Voice {
    pub active: bool,
    pub gate: bool,
    pub note: u8,
    pub velocity: f32,
    /// Trigger order; larger is newer.
    pub age: u64,
    pitch: f32,
    target: f32,
    osc: [OscState; NUM_OSC],
    sub: SubState,
    noise: NoiseState,
    filter: Filter,
    filter2: Filter,
    pub envs: [Env; NUM_ENV],
    pub lfos: [LfoState; NUM_LFO],
    rng: Rng,
    random: f32,
    /// Modulation source values, one-way (0..1) and two-way (-1..1).
    pub uni: [f32; src::N],
    pub bi: [f32; src::N],
    /// Modulated parameter values of the last block (normalised).
    pub m: Vec<f32>,
    raw_prev: [[f32; BLOCK]; NUM_OSC],
    amp_prev: f32,
}

#[inline]
fn plain(defs: &[ParamDef], m: &[f32], i: usize) -> f32 {
    defs[i].to_plain(m[i])
}

#[inline]
fn is_on(m: &[f32], i: usize) -> bool {
    m[i] >= 0.5
}

impl Voice {
    pub fn new(seed: u32) -> Voice {
        Voice {
            active: false,
            gate: false,
            note: 60,
            velocity: 0.0,
            age: 0,
            pitch: 60.0,
            target: 60.0,
            osc: [OscState::default(), OscState::default(), OscState::default()],
            sub: SubState::default(),
            noise: NoiseState::new(seed ^ 0xA5A5_5A5A),
            filter: Filter::default(),
            filter2: Filter::default(),
            envs: [Env::default(); NUM_ENV],
            lfos: [LfoState::default(); NUM_LFO],
            rng: Rng::new(seed),
            random: 0.0,
            uni: [0.0; src::N],
            bi: [0.0; src::N],
            m: vec![0.0; NUM_PARAMS],
            raw_prev: [[0.0; BLOCK]; NUM_OSC],
            amp_prev: 0.0,
        }
    }

    pub fn current_pitch(&self) -> f32 {
        self.pitch
    }

    /// Start a note.
    ///
    /// * `glide_from`: pitch to slide from (portamento), if any.
    /// * `fresh`: the voice was silent, so oscillators, filter and LFOs
    ///   restart. A stolen or legato voice keeps running to avoid clicks.
    /// * `retrigger`: restart the envelopes (false for legato).
    pub fn note_on(&mut self, note: u8, velocity: f32, age: u64, glide_from: Option<f32>, fresh: bool, retrigger: bool, base: &[f32]) {
        let defs = params::defs();
        self.note = note;
        self.velocity = velocity;
        self.age = age;
        self.gate = true;
        self.target = note as f32;
        self.pitch = glide_from.unwrap_or(self.target);
        if fresh {
            self.m.copy_from_slice(base);
            for o in 0..NUM_OSC {
                let phase = plain(defs, base, osc_idx(o, osc::PHASE));
                let rand = plain(defs, base, osc_idx(o, osc::RAND));
                self.osc[o].reset(phase, rand, &mut self.rng);
            }
            self.sub.reset();
            self.noise.reset();
            self.filter.reset();
            self.filter2.reset();
            for e in self.envs.iter_mut() {
                e.kill();
            }
            self.raw_prev = [[0.0; BLOCK]; NUM_OSC];
            self.amp_prev = 0.0;
        }
        if fresh || retrigger {
            self.random = self.rng.unipolar();
            for l in 0..NUM_LFO {
                let phase = plain(defs, base, lfo_idx(l, lfo::PHASE));
                self.lfos[l].trigger(phase, &mut self.rng);
            }
            for e in self.envs.iter_mut() {
                e.gate_on();
            }
        }
        self.active = true;
    }

    /// Glide to a new note without restarting anything (mono mode returning
    /// to a key that is still held).
    pub fn retarget(&mut self, note: u8) {
        self.note = note;
        self.target = note as f32;
    }

    pub fn note_off(&mut self) {
        self.gate = false;
        for e in self.envs.iter_mut() {
            e.gate_off();
        }
    }

    pub fn kill(&mut self) {
        self.active = false;
        self.gate = false;
        for e in self.envs.iter_mut() {
            e.kill();
        }
        self.amp_prev = 0.0;
    }

    /// Renders one block and adds it to `out_l` / `out_r`.
    pub fn process(&mut self, sh: &Shared, out_l: &mut [f32], out_r: &mut [f32], mut taps: Option<&mut VoiceTaps>) {
        let n = out_l.len();
        debug_assert!(n <= BLOCK);
        let defs = params::defs();
        let dt = n as f32 / sh.sr;
        let bpm = plain(defs, sh.base, master::BPM);

        // --- modulation sources (driven by last block's modulated values) ---
        for e in 0..NUM_ENV {
            let p = EnvParams {
                attack: plain(defs, &self.m, env_idx(e, env::ATTACK)),
                hold: plain(defs, &self.m, env_idx(e, env::HOLD)),
                decay: plain(defs, &self.m, env_idx(e, env::DECAY)),
                sustain: plain(defs, &self.m, env_idx(e, env::SUSTAIN)),
                release: plain(defs, &self.m, env_idx(e, env::RELEASE)),
                atk_curve: plain(defs, &self.m, env_idx(e, env::ATK_CURVE)),
                dec_curve: plain(defs, &self.m, env_idx(e, env::DEC_CURVE)),
                rel_curve: plain(defs, &self.m, env_idx(e, env::REL_CURVE)),
            };
            let v = self.envs[e].advance(&p, dt);
            self.uni[src::env(e)] = v;
            self.bi[src::env(e)] = 2.0 * v - 1.0;
        }
        for l in 0..NUM_LFO {
            let p = lfo_params(defs, &self.m, l, bpm);
            let (v, fade) = self.lfos[l].advance(&p, dt, sh.lfo_free[l], &sh.lfo_tables[l], &mut self.rng);
            self.uni[src::lfo(l)] = v * fade;
            self.bi[src::lfo(l)] = (2.0 * v - 1.0) * fade;
        }
        let set = |uni: &mut [f32; src::N], bi: &mut [f32; src::N], s: usize, v: f32| {
            uni[s] = v;
            bi[s] = 2.0 * v - 1.0;
        };
        set(&mut self.uni, &mut self.bi, src::VELOCITY, self.velocity);
        set(&mut self.uni, &mut self.bi, src::MOD_WHEEL, sh.mod_wheel);
        set(&mut self.uni, &mut self.bi, src::AFTERTOUCH, sh.aftertouch);
        set(&mut self.uni, &mut self.bi, src::RANDOM, self.random);
        for k in 0..params::NUM_MACRO {
            set(&mut self.uni, &mut self.bi, src::macro_(k), sh.base[master::MACRO1 + k]);
        }
        self.uni[src::NOTE] = self.note as f32 / 127.0;
        self.bi[src::NOTE] = ((self.note as f32 - 60.0) / 60.0).max(-1.0).min(1.0);
        self.uni[src::PITCH_BEND] = (sh.pitch_bend + 1.0) * 0.5;
        self.bi[src::PITCH_BEND] = sh.pitch_bend;

        // --- apply the mod matrix ------------------------------------------
        self.m.copy_from_slice(sh.base);
        for s in sh.slots {
            let v = if s.bipolar { self.bi[s.src] } else { self.uni[s.src] };
            self.m[s.dst] += s.amount * v;
        }
        let m = &self.m;

        // --- pitch -----------------------------------------------------------
        let porta = plain(defs, sh.base, master::PORTA);
        if porta > 0.001 && (self.pitch - self.target).abs() > 1e-3 {
            self.pitch += (self.target - self.pitch) * (1.0 - (-dt * 4.0 / porta).exp());
        } else {
            self.pitch = self.target;
        }
        let bend = sh.pitch_bend * plain(defs, sh.base, master::BEND);
        let pitch = self.pitch + bend + plain(defs, m, master::PITCH);

        // --- sources ---------------------------------------------------------
        let routing = FilterRouting::from_params(m);
        let select = |idx: usize| plain(defs, m, idx) as usize;
        let mut buses = Buses { f1: [[0.0; BLOCK]; 2], f2: [[0.0; BLOCK]; 2], direct: [[0.0; BLOCK]; 2] };
        let mut tl = [0.0f32; BLOCK];
        let mut tr = [0.0f32; BLOCK];
        let mut raw = [[0.0f32; BLOCK]; NUM_OSC];

        let osc_on: [bool; NUM_OSC] = core::array::from_fn(|o| is_on(m, osc_idx(o, osc::ON)));
        let warps: [Warp; NUM_OSC] = core::array::from_fn(|o| Warp::from_index(plain(defs, m, osc_idx(o, osc::WARP)) as usize));
        let warps2: [Warp; NUM_OSC] = core::array::from_fn(|o| Warp::from_index(plain(defs, m, osc_idx(o, osc::WARP2)) as usize));
        let listens: [bool; NUM_OSC] = core::array::from_fn(|o| warps[o].needs_modulator() || warps2[o].needs_modulator());
        // Render an oscillator after the one it listens to (FM, AM, RM), so
        // it hears it without delay. A and B listening to each other is a
        // loop: one of them hears the other's previous block.
        let mut done = [false; NUM_OSC];
        let mut order = [0usize; NUM_OSC];
        let mut count = 0;
        while count < NUM_OSC {
            let ready = (0..NUM_OSC).find(|&o| {
                let src = OSC_MODULATOR[o];
                !done[o] && (!listens[o] || !osc_on[src] || done[src])
            });
            let o = ready.unwrap_or_else(|| (0..NUM_OSC).find(|&o| !done[o]).unwrap());
            done[o] = true;
            order[count] = o;
            count += 1;
        }
        let mut done = [false; NUM_OSC];
        for &o in order.iter() {
            if !osc_on[o] {
                done[o] = true;
                continue;
            }
            let other = OSC_MODULATOR[o];
            let i = |p: usize| osc_idx(o, p);
            let note = pitch
                + plain(defs, m, i(osc::OCT)) * 12.0
                + plain(defs, m, i(osc::SEMI))
                + plain(defs, m, i(osc::FINE)) * 0.01
                + plain(defs, m, i(osc::COARSE));
            let level = plain(defs, m, i(osc::LEVEL));
            let p = OscParams {
                table: sh.tables[o],
                pos: plain(defs, m, i(osc::POS)),
                freq: midi_to_hz(note).min(sh.sr * 0.45),
                unison: plain(defs, m, i(osc::UNISON)) as usize,
                detune: plain(defs, m, i(osc::DETUNE)),
                blend: plain(defs, m, i(osc::BLEND)),
                width: plain(defs, m, i(osc::WIDTH)),
                level: level * level,
                pan: plain(defs, m, i(osc::PAN)),
                warp: warps[o],
                warp_amt: plain(defs, m, i(osc::WARP_AMT)),
                warp2: warps2[o],
                warp2_amt: plain(defs, m, i(osc::WARP2_AMT)),
                sr: sh.sr,
            };
            let modulator: Option<&[f32]> = if listens[o] && osc_on[other] {
                Some(if done[other] { &raw[other][..n] } else { &self.raw_prev[other][..n] })
            } else {
                None
            };
            // `raw[o]` is written while `raw[other]` may be read: split borrow.
            let mut raw_o = [0.0f32; BLOCK];
            self.osc[o].process(&p, modulator, &mut tl[..n], &mut tr[..n], &mut raw_o[..n]);
            raw[o] = raw_o;
            done[o] = true;
            buses.add(routing.dest(is_on(m, i(osc::TO_FILTER)), select(i(osc::FILTER_SEL))), &tl[..n], &tr[..n]);
            if let Some(t) = taps.as_deref_mut() {
                for s in 0..n {
                    t[tap::OSC_A + o][s] = (tl[s] + tr[s]) * 0.5;
                }
            }
        }
        self.raw_prev = raw;

        if is_on(m, SUB_BASE + sub::ON) {
            let i = |p: usize| SUB_BASE + p;
            let level = plain(defs, m, i(sub::LEVEL));
            let freq = midi_to_hz(pitch + plain(defs, m, i(sub::OCT)) * 12.0);
            let shape = SubShape::from_index(plain(defs, m, i(sub::SHAPE)) as usize);
            self.sub.process(shape, freq, level * level, plain(defs, m, i(sub::PAN)), sh.sr, &mut tl[..n], &mut tr[..n]);
            buses.add(routing.dest(is_on(m, i(sub::TO_FILTER)), select(i(sub::FILTER_SEL))), &tl[..n], &tr[..n]);
            if let Some(t) = taps.as_deref_mut() {
                for s in 0..n {
                    t[tap::SUB][s] = (tl[s] + tr[s]) * 0.5;
                }
            }
        }

        if is_on(m, NOISE_BASE + noise::ON) {
            let i = |p: usize| NOISE_BASE + p;
            let level = plain(defs, m, i(noise::LEVEL));
            let ty = NoiseType::from_index(plain(defs, m, i(noise::TYPE)) as usize);
            self.noise.process(ty, level * level, plain(defs, m, i(noise::PAN)), plain(defs, m, i(noise::TONE)), sh.sr, &mut tl[..n], &mut tr[..n]);
            buses.add(routing.dest(is_on(m, i(noise::TO_FILTER)), select(i(noise::FILTER_SEL))), &tl[..n], &tr[..n]);
            if let Some(t) = taps.as_deref_mut() {
                for s in 0..n {
                    t[tap::NOISE][s] = (tl[s] + tr[s]) * 0.5;
                }
            }
        }

        // --- filters ---------------------------------------------------------
        let filter_params = |base: usize| {
            let i = |p: usize| base + p;
            let track = plain(defs, m, i(filter::KEYTRACK));
            FilterParams {
                ty: FilterType::from_index(plain(defs, m, i(filter::TYPE)) as usize),
                cutoff: plain(defs, m, i(filter::CUTOFF)) * (2.0f32).powf(track * (pitch - 60.0) / 12.0),
                res: plain(defs, m, i(filter::RES)),
                drive: plain(defs, m, i(filter::DRIVE)),
                var: plain(defs, m, i(filter::VAR)),
                mix: plain(defs, m, i(filter::MIX)),
                stereo: plain(defs, m, i(filter::STEREO)),
                sr: sh.sr,
            }
        };
        let tap_of = |t: &mut [f32; BLOCK], bus: &[[f32; BLOCK]; 2]| {
            for s in 0..n {
                t[s] = (bus[0][s] + bus[1][s]) * 0.5;
            }
        };
        if let Some(t) = taps.as_deref_mut() {
            tap_of(&mut t[tap::FILTER_IN], &buses.f1);
        }
        if routing.f1 {
            let (l, r) = buses.f1.split_at_mut(1);
            self.filter.process(&filter_params(FILTER_BASE), &mut l[0][..n], &mut r[0][..n]);
        }
        if let Some(t) = taps.as_deref_mut() {
            tap_of(&mut t[tap::FILTER_OUT], &buses.f1);
        }
        if routing.f2 && !routing.parallel {
            // In series, what leaves filter 1 goes on into filter 2.
            for c in 0..2 {
                for s in 0..n {
                    buses.f2[c][s] += buses.f1[c][s];
                    buses.f1[c][s] = 0.0;
                }
            }
        }
        if let Some(t) = taps.as_deref_mut() {
            tap_of(&mut t[tap::FILTER2_IN], &buses.f2);
        }
        if routing.f2 {
            let (l, r) = buses.f2.split_at_mut(1);
            self.filter2.process(&filter_params(FILTER2_BASE), &mut l[0][..n], &mut r[0][..n]);
        }
        if let Some(t) = taps.as_deref_mut() {
            tap_of(&mut t[tap::FILTER2_OUT], &buses.f2);
        }

        // --- amplifier -------------------------------------------------------
        let sens = plain(defs, sh.base, master::VEL_SENS);
        let amp_end = self.uni[src::ENV1] * (1.0 - sens + sens * self.velocity) * VOICE_GAIN;
        let mut amp = self.amp_prev;
        let damp = (amp_end - amp) / n as f32;
        for s in 0..n {
            let l = buses.f1[0][s] + buses.f2[0][s] + buses.direct[0][s];
            let r = buses.f1[1][s] + buses.f2[1][s] + buses.direct[1][s];
            if let Some(t) = taps.as_deref_mut() {
                t[tap::PRE_AMP][s] = (l + r) * 0.5;
                t[tap::AMP][s] = (l + r) * 0.5 * amp / VOICE_GAIN;
            }
            out_l[s] += l * amp;
            out_r[s] += r * amp;
            amp += damp;
        }
        self.amp_prev = amp_end;

        if self.envs[0].is_idle() {
            self.active = false;
        }
    }
}

/// Reads one LFO's settings. Shared with the synth's free-running clock.
pub fn lfo_params(defs: &[ParamDef], m: &[f32], l: usize, bpm: f32) -> LfoParams {
    let i = |p: usize| lfo_idx(l, p);
    let rate_hz = if is_on(m, i(lfo::SYNC)) {
        let div = plain(defs, m, i(lfo::DIV)) as usize;
        bpm / 60.0 / params::DIVISION_BEATS[div.min(params::DIVISION_BEATS.len() - 1)]
    } else {
        plain(defs, m, i(lfo::RATE))
    };
    LfoParams {
        kind: LfoKind::from_index(plain(defs, m, i(lfo::SHAPE)) as usize),
        rate_hz,
        mode: LfoMode::from_index(plain(defs, m, i(lfo::MODE)) as usize),
        rise: plain(defs, m, i(lfo::RISE)),
        delay: plain(defs, m, i(lfo::DELAY)),
        smooth: plain(defs, m, i(lfo::SMOOTH)),
        phase: plain(defs, m, i(lfo::PHASE)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_follows_the_switches_and_the_choice_of_filter() {
        let r = |f1, f2, parallel| FilterRouting { f1, f2, parallel };
        // Bypassing the filters always goes straight on.
        for routing in [r(true, true, true), r(true, false, false), r(false, false, false)] {
            assert_eq!(routing.dest(false, 0), Dest::Direct);
        }
        // One filter, or two in series: everything into the first that is on.
        assert_eq!(r(true, false, false).dest(true, 1), Dest::Filter1, "the choice only matters in parallel");
        assert_eq!(r(true, true, false).dest(true, 2), Dest::Filter1);
        assert_eq!(r(false, true, false).dest(true, 0), Dest::Filter2);
        assert_eq!(r(false, false, false).dest(true, 0), Dest::Direct);
        // In parallel each source picks; a filter that is off is passed by.
        let par = r(true, true, true);
        assert_eq!((par.dest(true, 0), par.dest(true, 1), par.dest(true, 2)), (Dest::Filter1, Dest::Filter2, Dest::Both));
        let only2 = r(false, true, true);
        assert_eq!((only2.dest(true, 0), only2.dest(true, 1), only2.dest(true, 2)), (Dest::Direct, Dest::Filter2, Dest::Filter2));
    }
}
