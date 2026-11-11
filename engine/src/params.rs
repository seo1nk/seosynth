//! The parameter table: every knob, switch and menu of the synth.
//!
//! Parameters are addressed by a dense index (fast, used by the DSP code) and
//! also carry a *stable id* (`sid`) plus a string key. Indices may change
//! between versions; `sid` and `key` never do, so shared URLs and preset files
//! keep working. Rule: never renumber a `sid`, only append new ones.
//!
//! All values are stored normalised (0..1). Modulation happens in that
//! normalised space and is converted to real units (`to_plain`) where used.

use std::sync::OnceLock;

pub const NUM_OSC: usize = 2;
pub const NUM_ENV: usize = 3;
pub const NUM_LFO: usize = 4;
pub const NUM_MACRO: usize = 4;
pub const NUM_SLOTS: usize = 32;
/// Kinds of effect.
pub const NUM_FX: usize = 10;
/// Copies of each kind, so the same effect can be stacked.
pub const FX_COPIES: usize = 3;
/// Effect units: every copy of every kind. Unit `u` is copy `u / NUM_FX` of
/// kind `u % NUM_FX`, so the first `NUM_FX` units are the first copies.
pub const NUM_UNITS: usize = NUM_FX * FX_COPIES;

/// Modulatable from the mod matrix.
pub const F_MOD: u8 = 1;
/// One value for the whole synth (not per voice). Modulation of such a
/// parameter follows the most recently played voice.
pub const F_GLOBAL: u8 = 2;
/// Continuous value that is smoothed to avoid zipper noise.
pub const F_SMOOTH: u8 = 4;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Curve {
    /// plain = min + (max - min) * n
    Lin,
    /// plain = min + (max - min) * n^k  (more resolution near the minimum)
    Pow(f32),
    /// plain = min * (max / min)^n  (frequencies, times; needs min > 0)
    Log,
    /// Integer steps between min and max.
    Int,
    /// Off / on.
    Bool,
    /// One of `options`.
    Enum,
}

pub struct ParamDef {
    pub sid: u16,
    pub key: String,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub curve: Curve,
    pub unit: &'static str,
    pub flags: u8,
    pub options: &'static [&'static str],
}

impl ParamDef {
    #[inline]
    pub fn to_plain(&self, n: f32) -> f32 {
        let n = n.max(0.0).min(1.0);
        match self.curve {
            Curve::Lin => self.min + (self.max - self.min) * n,
            Curve::Pow(k) => self.min + (self.max - self.min) * n.powf(k),
            Curve::Log => self.min * (self.max / self.min).powf(n),
            Curve::Int | Curve::Enum => (self.min + (self.max - self.min) * n).round(),
            Curve::Bool => {
                if n >= 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }

    pub fn to_norm(&self, p: f32) -> f32 {
        let p = p.max(self.min).min(self.max);
        let span = self.max - self.min;
        let n = match self.curve {
            Curve::Lin | Curve::Int | Curve::Enum => {
                if span == 0.0 {
                    0.0
                } else {
                    (p - self.min) / span
                }
            }
            Curve::Pow(k) => ((p - self.min) / span).powf(1.0 / k),
            Curve::Log => (p / self.min).ln() / (self.max / self.min).ln(),
            Curve::Bool => {
                if p >= 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
        };
        n.max(0.0).min(1.0)
    }

    pub fn default_norm(&self) -> f32 {
        self.to_norm(self.default)
    }

    pub fn is_discrete(&self) -> bool {
        matches!(self.curve, Curve::Int | Curve::Bool | Curve::Enum)
    }

    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

// ---------------------------------------------------------------------------
// Index layout
// ---------------------------------------------------------------------------

pub mod master {
    pub const VOLUME: usize = 0;
    pub const PITCH: usize = 1;
    pub const VOICES: usize = 2;
    pub const MONO: usize = 3;
    pub const LEGATO: usize = 4;
    pub const PORTA: usize = 5;
    pub const PORTA_ALWAYS: usize = 6;
    pub const BEND: usize = 7;
    pub const BPM: usize = 8;
    pub const VEL_SENS: usize = 9;
    pub const MACRO1: usize = 10;
    pub const N: usize = 14;
}

pub mod osc {
    pub const ON: usize = 0;
    pub const WT: usize = 1;
    pub const POS: usize = 2;
    pub const LEVEL: usize = 3;
    pub const PAN: usize = 4;
    pub const OCT: usize = 5;
    pub const SEMI: usize = 6;
    pub const FINE: usize = 7;
    pub const COARSE: usize = 8;
    pub const UNISON: usize = 9;
    pub const DETUNE: usize = 10;
    pub const BLEND: usize = 11;
    pub const WIDTH: usize = 12;
    pub const PHASE: usize = 13;
    pub const RAND: usize = 14;
    pub const WARP: usize = 15;
    pub const WARP_AMT: usize = 16;
    pub const TO_FILTER: usize = 17;
    pub const N: usize = 18;
}

pub mod sub {
    pub const ON: usize = 0;
    pub const SHAPE: usize = 1;
    pub const OCT: usize = 2;
    pub const LEVEL: usize = 3;
    pub const PAN: usize = 4;
    pub const TO_FILTER: usize = 5;
    pub const N: usize = 6;
}

pub mod noise {
    pub const ON: usize = 0;
    pub const TYPE: usize = 1;
    pub const LEVEL: usize = 2;
    pub const PAN: usize = 3;
    pub const TONE: usize = 4;
    pub const TO_FILTER: usize = 5;
    pub const N: usize = 6;
}

pub mod filter {
    pub const ON: usize = 0;
    pub const TYPE: usize = 1;
    pub const CUTOFF: usize = 2;
    pub const RES: usize = 3;
    pub const DRIVE: usize = 4;
    pub const VAR: usize = 5;
    pub const MIX: usize = 6;
    pub const KEYTRACK: usize = 7;
    pub const STEREO: usize = 8;
    pub const N: usize = 9;
}

pub mod env {
    pub const ATTACK: usize = 0;
    pub const HOLD: usize = 1;
    pub const DECAY: usize = 2;
    pub const SUSTAIN: usize = 3;
    pub const RELEASE: usize = 4;
    pub const ATK_CURVE: usize = 5;
    pub const DEC_CURVE: usize = 6;
    pub const REL_CURVE: usize = 7;
    pub const N: usize = 8;
}

pub mod lfo {
    pub const SHAPE: usize = 0;
    pub const RATE: usize = 1;
    pub const SYNC: usize = 2;
    pub const DIV: usize = 3;
    pub const MODE: usize = 4;
    pub const RISE: usize = 5;
    pub const DELAY: usize = 6;
    pub const SMOOTH: usize = 7;
    pub const PHASE: usize = 8;
    pub const N: usize = 9;
}

pub mod hyper {
    pub const ON: usize = 0;
    pub const RATE: usize = 1;
    pub const DETUNE: usize = 2;
    pub const VOICES: usize = 3;
    pub const MIX: usize = 4;
    pub const DIM_SIZE: usize = 5;
    pub const DIM_MIX: usize = 6;
    pub const N: usize = 7;
}

pub mod dist {
    pub const ON: usize = 0;
    pub const MODE: usize = 1;
    pub const DRIVE: usize = 2;
    pub const MIX: usize = 3;
    pub const FILTER_MODE: usize = 4;
    pub const FILTER_TYPE: usize = 5;
    pub const FILTER_FREQ: usize = 6;
    pub const FILTER_Q: usize = 7;
    pub const N: usize = 8;
}

pub mod flanger {
    pub const ON: usize = 0;
    pub const RATE: usize = 1;
    pub const DEPTH: usize = 2;
    pub const FEEDBACK: usize = 3;
    pub const PHASE: usize = 4;
    pub const MIX: usize = 5;
    pub const N: usize = 6;
}

pub mod phaser {
    pub const ON: usize = 0;
    pub const RATE: usize = 1;
    pub const DEPTH: usize = 2;
    pub const FREQ: usize = 3;
    pub const FEEDBACK: usize = 4;
    pub const PHASE: usize = 5;
    pub const MIX: usize = 6;
    pub const N: usize = 7;
}

pub mod chorus {
    pub const ON: usize = 0;
    pub const RATE: usize = 1;
    pub const DELAY1: usize = 2;
    pub const DELAY2: usize = 3;
    pub const DEPTH: usize = 4;
    pub const FEEDBACK: usize = 5;
    pub const LPF: usize = 6;
    pub const MIX: usize = 7;
    pub const N: usize = 8;
}

pub mod delay {
    pub const ON: usize = 0;
    pub const SYNC: usize = 1;
    pub const TIME_L: usize = 2;
    pub const TIME_R: usize = 3;
    pub const DIV_L: usize = 4;
    pub const DIV_R: usize = 5;
    pub const LINK: usize = 6;
    pub const FEEDBACK: usize = 7;
    pub const MODE: usize = 8;
    pub const FILTER_FREQ: usize = 9;
    pub const FILTER_Q: usize = 10;
    pub const MIX: usize = 11;
    pub const N: usize = 12;
}

pub mod comp {
    pub const ON: usize = 0;
    pub const THRESHOLD: usize = 1;
    pub const RATIO: usize = 2;
    pub const ATTACK: usize = 3;
    pub const RELEASE: usize = 4;
    pub const GAIN: usize = 5;
    pub const MULTIBAND: usize = 6;
    pub const MIX: usize = 7;
    pub const N: usize = 8;
}

pub mod reverb {
    pub const ON: usize = 0;
    pub const MODE: usize = 1;
    pub const SIZE: usize = 2;
    pub const DECAY: usize = 3;
    pub const PREDELAY: usize = 4;
    pub const LOWCUT: usize = 5;
    pub const HIGHCUT: usize = 6;
    pub const DAMP: usize = 7;
    pub const WIDTH: usize = 8;
    pub const MIX: usize = 9;
    pub const N: usize = 10;
}

pub mod eq {
    pub const ON: usize = 0;
    pub const LOW_TYPE: usize = 1;
    pub const LOW_FREQ: usize = 2;
    pub const LOW_Q: usize = 3;
    pub const LOW_GAIN: usize = 4;
    pub const HIGH_TYPE: usize = 5;
    pub const HIGH_FREQ: usize = 6;
    pub const HIGH_Q: usize = 7;
    pub const HIGH_GAIN: usize = 8;
    pub const N: usize = 9;
}

pub mod fxfilter {
    pub const ON: usize = 0;
    pub const TYPE: usize = 1;
    pub const CUTOFF: usize = 2;
    pub const RES: usize = 3;
    pub const DRIVE: usize = 4;
    pub const VAR: usize = 5;
    pub const MIX: usize = 6;
    pub const N: usize = 7;
}

/// The fork in the effect chain: how the sound is divided between the two
/// lanes and how they are mixed again.
pub mod split {
    pub const MODE: usize = 0;
    pub const FREQ: usize = 1;
    pub const BALANCE: usize = 2;
    pub const N: usize = 3;
}

pub const OSC_BASE: usize = master::N;
pub const SUB_BASE: usize = OSC_BASE + NUM_OSC * osc::N;
pub const NOISE_BASE: usize = SUB_BASE + sub::N;
pub const FILTER_BASE: usize = NOISE_BASE + noise::N;
pub const ENV_BASE: usize = FILTER_BASE + filter::N;
pub const LFO_BASE: usize = ENV_BASE + NUM_ENV * env::N;
pub const HYPER_BASE: usize = LFO_BASE + NUM_LFO * lfo::N;
pub const DIST_BASE: usize = HYPER_BASE + hyper::N;
pub const FLANGER_BASE: usize = DIST_BASE + dist::N;
pub const PHASER_BASE: usize = FLANGER_BASE + flanger::N;
pub const CHORUS_BASE: usize = PHASER_BASE + phaser::N;
pub const DELAY_BASE: usize = CHORUS_BASE + chorus::N;
pub const COMP_BASE: usize = DELAY_BASE + delay::N;
pub const REVERB_BASE: usize = COMP_BASE + comp::N;
pub const EQ_BASE: usize = REVERB_BASE + reverb::N;
pub const FXFILTER_BASE: usize = EQ_BASE + eq::N;
/// Parameters of one copy of all the effects. Copy `c` of an effect lives
/// `c * FX_BLOCK` after the first copy.
pub const FX_BLOCK: usize = FXFILTER_BASE + fxfilter::N - HYPER_BASE;
pub const SPLIT_BASE: usize = HYPER_BASE + FX_COPIES * FX_BLOCK;
pub const NUM_PARAMS: usize = SPLIT_BASE + split::N;

#[inline]
pub const fn osc_idx(o: usize, p: usize) -> usize {
    OSC_BASE + o * osc::N + p
}
#[inline]
pub const fn env_idx(e: usize, p: usize) -> usize {
    ENV_BASE + e * env::N + p
}
#[inline]
pub const fn lfo_idx(l: usize, p: usize) -> usize {
    LFO_BASE + l * lfo::N + p
}

/// Offset from a first-copy parameter to the same parameter of `unit`.
#[inline]
pub const fn unit_shift(unit: usize) -> usize {
    (unit / NUM_FX) * FX_BLOCK
}

/// Index of the on/off switch of an effect unit.
#[inline]
pub const fn unit_on(unit: usize) -> usize {
    FX_BASES[unit % NUM_FX] + unit_shift(unit)
}

/// Key prefix of an effect unit: "dist", "dist2", "dist3".
pub fn unit_key(unit: usize) -> String {
    let kind = FX_KEYS[unit % NUM_FX];
    match unit / NUM_FX {
        0 => kind.to_string(),
        copy => format!("{kind}{}", copy + 1),
    }
}

/// The kinds of effect in their fixed id order. The processing order of the
/// units is a separate, user-editable permutation stored in the patch.
pub const FX_KEYS: [&str; NUM_FX] = [
    "hyper", "dist", "flanger", "phaser", "chorus", "delay", "comp", "reverb", "eq", "fxfilter",
];
pub const FX_BASES: [usize; NUM_FX] = [
    HYPER_BASE,
    DIST_BASE,
    FLANGER_BASE,
    PHASER_BASE,
    CHORUS_BASE,
    DELAY_BASE,
    COMP_BASE,
    REVERB_BASE,
    EQ_BASE,
    FXFILTER_BASE,
];

// ---------------------------------------------------------------------------
// Option lists
// ---------------------------------------------------------------------------

pub const WARP_MODES: &[&str] = &[
    "Off", "Sync", "SyncWin", "Bend+", "Bend-", "PWM", "Asym+", "Asym-", "Flip", "Mirror",
    "Quantize", "FM", "AM", "RM",
];
pub const SUB_SHAPES: &[&str] = &["Sine", "Round", "Triangle", "Saw", "Square", "Pulse"];
pub const NOISE_TYPES: &[&str] = &["White", "Pink", "Brown", "Digital", "Crackle"];
pub const FILTER_TYPES: &[&str] = &[
    "LP6", "LP12", "LP24", "Ladder12", "Ladder24", "HP6", "HP12", "HP24", "BP12", "BP24", "Notch",
    "Peak", "Morph", "Comb+", "Comb-", "Phaser", "Formant", "Reduce", "Ring",
];
pub const LFO_SHAPES: &[&str] = &[
    "Sine", "Triangle", "SawUp", "SawDown", "Square", "S&H", "Smooth", "Custom",
];
pub const LFO_MODES: &[&str] = &["Trig", "Env", "Free"];
pub const DIVISIONS: &[&str] = &[
    "8/1", "4/1", "2/1", "1/1", "1/2.", "1/2", "1/2T", "1/4.", "1/4", "1/4T", "1/8.", "1/8",
    "1/8T", "1/16.", "1/16", "1/16T", "1/32.", "1/32", "1/32T", "1/64",
];
/// Length of each entry of `DIVISIONS` in quarter-note beats.
pub const DIVISION_BEATS: [f32; 20] = [
    32.0,
    16.0,
    8.0,
    4.0,
    3.0,
    2.0,
    4.0 / 3.0,
    1.5,
    1.0,
    2.0 / 3.0,
    0.75,
    0.5,
    1.0 / 3.0,
    0.375,
    0.25,
    1.0 / 6.0,
    0.1875,
    0.125,
    1.0 / 12.0,
    0.0625,
];
pub const DIST_MODES: &[&str] = &[
    "Tube", "Soft", "Hard", "Diode", "Fold", "SineFold", "Asym", "Rectify", "Bitcrush",
    "Downsample",
];
pub const DIST_FILTER_MODES: &[&str] = &["Off", "Pre", "Post"];
pub const DIST_FILTER_TYPES: &[&str] = &["LP", "BP", "HP"];
pub const DELAY_MODES: &[&str] = &["Normal", "PingPong", "Tap"];
pub const REVERB_MODES: &[&str] = &["Plate", "Hall"];
pub const EQ_LOW_TYPES: &[&str] = &["Shelf", "Peak", "HP"];
pub const EQ_HIGH_TYPES: &[&str] = &["Shelf", "Peak", "LP"];
pub const SPLIT_MODES: &[&str] = &["Copy", "Bands", "MidSide", "LeftRight"];

// ---------------------------------------------------------------------------
// Table construction
// ---------------------------------------------------------------------------

struct Builder {
    defs: Vec<ParamDef>,
}

const MS: u8 = F_MOD | F_SMOOTH;
const GS: u8 = F_GLOBAL | F_SMOOTH;
const GMS: u8 = F_GLOBAL | F_MOD | F_SMOOTH;

impl Builder {
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        idx: usize,
        sid: u16,
        key: String,
        min: f32,
        max: f32,
        default: f32,
        curve: Curve,
        unit: &'static str,
        flags: u8,
        options: &'static [&'static str],
    ) {
        assert_eq!(self.defs.len(), idx, "parameter index mismatch for {key}");
        assert!(
            !self.defs.iter().any(|d| d.sid == sid),
            "duplicate stable id {sid} for {key}"
        );
        self.defs.push(ParamDef { sid, key, min, max, default, curve, unit, flags, options });
    }

    #[allow(clippy::too_many_arguments)]
    fn num(
        &mut self,
        idx: usize,
        sid: u16,
        key: impl Into<String>,
        min: f32,
        max: f32,
        default: f32,
        curve: Curve,
        unit: &'static str,
        flags: u8,
    ) {
        self.add(idx, sid, key.into(), min, max, default, curve, unit, flags, &[]);
    }

    fn int(&mut self, idx: usize, sid: u16, key: impl Into<String>, min: i32, max: i32, default: i32, unit: &'static str, flags: u8) {
        self.add(idx, sid, key.into(), min as f32, max as f32, default as f32, Curve::Int, unit, flags, &[]);
    }

    fn flag(&mut self, idx: usize, sid: u16, key: impl Into<String>, default: bool, flags: u8) {
        self.add(idx, sid, key.into(), 0.0, 1.0, if default { 1.0 } else { 0.0 }, Curve::Bool, "", flags, &[]);
    }

    fn choice(&mut self, idx: usize, sid: u16, key: impl Into<String>, options: &'static [&'static str], default: usize, flags: u8) {
        self.add(idx, sid, key.into(), 0.0, (options.len() - 1) as f32, default as f32, Curve::Enum, "", flags, options);
    }
}

fn build() -> Vec<ParamDef> {
    use Curve::*;
    let mut b = Builder { defs: Vec::with_capacity(NUM_PARAMS) };

    // --- master -----------------------------------------------------------
    b.num(master::VOLUME, 1, "master.volume", 0.0, 1.0, 0.7, Lin, "%", GMS);
    b.num(master::PITCH, 2, "master.pitch", -24.0, 24.0, 0.0, Lin, "st", MS);
    b.int(master::VOICES, 3, "master.voices", 1, 16, 8, "", F_GLOBAL);
    b.flag(master::MONO, 4, "master.mono", false, F_GLOBAL);
    b.flag(master::LEGATO, 5, "master.legato", false, F_GLOBAL);
    b.num(master::PORTA, 6, "master.porta", 0.0, 5.0, 0.0, Pow(3.0), "s", F_GLOBAL);
    b.flag(master::PORTA_ALWAYS, 7, "master.portaAlways", true, F_GLOBAL);
    b.int(master::BEND, 8, "master.bendRange", 0, 24, 2, "st", F_GLOBAL);
    b.num(master::BPM, 9, "master.bpm", 40.0, 240.0, 120.0, Lin, "bpm", F_GLOBAL);
    b.num(master::VEL_SENS, 10, "master.velSens", 0.0, 1.0, 0.5, Lin, "%", F_GLOBAL);
    for m in 0..NUM_MACRO {
        b.num(master::MACRO1 + m, 11 + m as u16, format!("macro{}", m + 1), 0.0, 1.0, 0.0, Lin, "%", GS);
    }

    // --- oscillators ------------------------------------------------------
    for o in 0..NUM_OSC {
        let name = if o == 0 { "oscA" } else { "oscB" };
        let s = 100 + 50 * o as u16;
        let k = |p: &str| format!("{name}.{p}");
        let i = |p: usize| osc_idx(o, p);
        b.flag(i(osc::ON), s, k("on"), o == 0, 0);
        b.choice(i(osc::WT), s + 1, k("wt"), crate::tables::TABLE_NAMES, 0, 0);
        // 0.5 on the default table is a saw: a bright start that the filter can shape.
        b.num(i(osc::POS), s + 2, k("pos"), 0.0, 1.0, 0.5, Lin, "%", MS);
        b.num(i(osc::LEVEL), s + 3, k("level"), 0.0, 1.0, 0.75, Lin, "%", MS);
        b.num(i(osc::PAN), s + 4, k("pan"), -1.0, 1.0, 0.0, Lin, "pan", MS);
        b.int(i(osc::OCT), s + 5, k("oct"), -4, 4, 0, "oct", 0);
        b.int(i(osc::SEMI), s + 6, k("semi"), -12, 12, 0, "st", 0);
        b.num(i(osc::FINE), s + 7, k("fine"), -100.0, 100.0, 0.0, Lin, "ct", MS);
        b.num(i(osc::COARSE), s + 8, k("coarse"), -64.0, 64.0, 0.0, Lin, "st", MS);
        b.int(i(osc::UNISON), s + 9, k("unison"), 1, 16, 1, "", 0);
        b.num(i(osc::DETUNE), s + 10, k("detune"), 0.0, 1.0, 0.25, Lin, "%", MS);
        b.num(i(osc::BLEND), s + 11, k("blend"), 0.0, 1.0, 0.75, Lin, "%", MS);
        b.num(i(osc::WIDTH), s + 12, k("width"), 0.0, 1.0, 1.0, Lin, "%", MS);
        b.num(i(osc::PHASE), s + 13, k("phase"), 0.0, 1.0, 0.0, Lin, "%", 0);
        b.num(i(osc::RAND), s + 14, k("rand"), 0.0, 1.0, 1.0, Lin, "%", 0);
        b.choice(i(osc::WARP), s + 15, k("warp"), WARP_MODES, 0, 0);
        b.num(i(osc::WARP_AMT), s + 16, k("warpAmt"), 0.0, 1.0, 0.0, Lin, "%", MS);
        b.flag(i(osc::TO_FILTER), s + 17, k("toFilter"), true, 0);
    }

    // --- sub / noise ------------------------------------------------------
    let i = |p: usize| SUB_BASE + p;
    b.flag(i(sub::ON), 200, "sub.on", false, 0);
    b.choice(i(sub::SHAPE), 201, "sub.shape", SUB_SHAPES, 0, 0);
    b.int(i(sub::OCT), 202, "sub.oct", -4, 4, -1, "oct", 0);
    b.num(i(sub::LEVEL), 203, "sub.level", 0.0, 1.0, 0.75, Lin, "%", MS);
    b.num(i(sub::PAN), 204, "sub.pan", -1.0, 1.0, 0.0, Lin, "pan", MS);
    b.flag(i(sub::TO_FILTER), 205, "sub.toFilter", true, 0);

    let i = |p: usize| NOISE_BASE + p;
    b.flag(i(noise::ON), 220, "noise.on", false, 0);
    b.choice(i(noise::TYPE), 221, "noise.type", NOISE_TYPES, 0, 0);
    b.num(i(noise::LEVEL), 222, "noise.level", 0.0, 1.0, 0.4, Lin, "%", MS);
    b.num(i(noise::PAN), 223, "noise.pan", -1.0, 1.0, 0.0, Lin, "pan", MS);
    b.num(i(noise::TONE), 224, "noise.tone", 0.0, 1.0, 1.0, Lin, "%", MS);
    b.flag(i(noise::TO_FILTER), 225, "noise.toFilter", true, 0);

    // --- filter -----------------------------------------------------------
    let i = |p: usize| FILTER_BASE + p;
    b.flag(i(filter::ON), 240, "filter.on", true, 0);
    b.choice(i(filter::TYPE), 241, "filter.type", FILTER_TYPES, 2, 0);
    b.num(i(filter::CUTOFF), 242, "filter.cutoff", 20.0, 20000.0, 20000.0, Log, "Hz", MS);
    b.num(i(filter::RES), 243, "filter.res", 0.0, 1.0, 0.1, Lin, "%", MS);
    b.num(i(filter::DRIVE), 244, "filter.drive", 0.0, 1.0, 0.0, Lin, "%", MS);
    b.num(i(filter::VAR), 245, "filter.var", 0.0, 1.0, 0.0, Lin, "%", MS);
    b.num(i(filter::MIX), 246, "filter.mix", 0.0, 1.0, 1.0, Lin, "%", MS);
    b.num(i(filter::KEYTRACK), 247, "filter.keytrack", 0.0, 1.0, 0.0, Lin, "%", 0);
    b.num(i(filter::STEREO), 248, "filter.stereo", -1.0, 1.0, 0.0, Lin, "pan", MS);

    // --- envelopes --------------------------------------------------------
    for e in 0..NUM_ENV {
        let s = 300 + 20 * e as u16;
        let k = |p: &str| format!("env{}.{p}", e + 1);
        let i = |p: usize| env_idx(e, p);
        b.num(i(env::ATTACK), s, k("attack"), 0.0, 20.0, 0.001, Pow(4.0), "s", MS);
        b.num(i(env::HOLD), s + 1, k("hold"), 0.0, 20.0, 0.0, Pow(4.0), "s", MS);
        b.num(i(env::DECAY), s + 2, k("decay"), 0.0, 20.0, 1.0, Pow(4.0), "s", MS);
        b.num(i(env::SUSTAIN), s + 3, k("sustain"), 0.0, 1.0, 1.0, Lin, "%", MS);
        b.num(i(env::RELEASE), s + 4, k("release"), 0.0, 20.0, 0.015, Pow(4.0), "s", MS);
        b.num(i(env::ATK_CURVE), s + 5, k("atkCurve"), -1.0, 1.0, 0.0, Lin, "curve", 0);
        b.num(i(env::DEC_CURVE), s + 6, k("decCurve"), -1.0, 1.0, 0.33, Lin, "curve", 0);
        b.num(i(env::REL_CURVE), s + 7, k("relCurve"), -1.0, 1.0, 0.33, Lin, "curve", 0);
    }

    // --- LFOs -------------------------------------------------------------
    for l in 0..NUM_LFO {
        let s = 400 + 20 * l as u16;
        let k = |p: &str| format!("lfo{}.{p}", l + 1);
        let i = |p: usize| lfo_idx(l, p);
        b.choice(i(lfo::SHAPE), s, k("shape"), LFO_SHAPES, 1, 0);
        b.num(i(lfo::RATE), s + 1, k("rate"), 0.02, 50.0, 2.0, Log, "Hz", MS);
        b.flag(i(lfo::SYNC), s + 2, k("sync"), true, 0);
        b.choice(i(lfo::DIV), s + 3, k("div"), DIVISIONS, 8, 0);
        b.choice(i(lfo::MODE), s + 4, k("mode"), LFO_MODES, 0, 0);
        b.num(i(lfo::RISE), s + 5, k("rise"), 0.0, 10.0, 0.0, Pow(3.0), "s", 0);
        b.num(i(lfo::DELAY), s + 6, k("delay"), 0.0, 10.0, 0.0, Pow(3.0), "s", 0);
        b.num(i(lfo::SMOOTH), s + 7, k("smooth"), 0.0, 1.0, 0.0, Lin, "%", 0);
        b.num(i(lfo::PHASE), s + 8, k("phase"), 0.0, 1.0, 0.0, Lin, "%", 0);
    }

    // --- effects ----------------------------------------------------------
    // Every copy has the same parameters. The first copy keeps the original
    // keys and ids; copy 2 is "dist2.drive" with id 1522, copy 3 "dist3.drive"
    // with id 2522.
    for copy in 0..FX_COPIES {
        let shift = copy * FX_BLOCK;
        let sid = 1000 * copy as u16;
        let k = |kind: &str, p: &str| if copy == 0 { format!("{kind}.{p}") } else { format!("{kind}{}.{p}", copy + 1) };

        let i = |p: usize| HYPER_BASE + shift + p;
        b.flag(i(hyper::ON), sid + 500, k("hyper", "on"), false, F_GLOBAL);
        b.num(i(hyper::RATE), sid + 501, k("hyper", "rate"), 0.0, 1.0, 0.4, Lin, "%", GMS);
        b.num(i(hyper::DETUNE), sid + 502, k("hyper", "detune"), 0.0, 1.0, 0.3, Lin, "%", GMS);
        b.int(i(hyper::VOICES), sid + 503, k("hyper", "voices"), 1, 7, 4, "", F_GLOBAL);
        b.num(i(hyper::MIX), sid + 504, k("hyper", "mix"), 0.0, 1.0, 0.5, Lin, "%", GMS);
        b.num(i(hyper::DIM_SIZE), sid + 505, k("hyper", "dimSize"), 0.0, 1.0, 0.5, Lin, "%", GMS);
        b.num(i(hyper::DIM_MIX), sid + 506, k("hyper", "dimMix"), 0.0, 1.0, 0.0, Lin, "%", GMS);

        let i = |p: usize| DIST_BASE + shift + p;
        b.flag(i(dist::ON), sid + 520, k("dist", "on"), false, F_GLOBAL);
        b.choice(i(dist::MODE), sid + 521, k("dist", "mode"), DIST_MODES, 0, F_GLOBAL);
        b.num(i(dist::DRIVE), sid + 522, k("dist", "drive"), 0.0, 1.0, 0.3, Lin, "%", GMS);
        b.num(i(dist::MIX), sid + 523, k("dist", "mix"), 0.0, 1.0, 1.0, Lin, "%", GMS);
        b.choice(i(dist::FILTER_MODE), sid + 524, k("dist", "filterMode"), DIST_FILTER_MODES, 0, F_GLOBAL);
        b.choice(i(dist::FILTER_TYPE), sid + 525, k("dist", "filterType"), DIST_FILTER_TYPES, 0, F_GLOBAL);
        b.num(i(dist::FILTER_FREQ), sid + 526, k("dist", "filterFreq"), 20.0, 20000.0, 2000.0, Log, "Hz", GMS);
        b.num(i(dist::FILTER_Q), sid + 527, k("dist", "filterQ"), 0.0, 1.0, 0.2, Lin, "%", GMS);

        let i = |p: usize| FLANGER_BASE + shift + p;
        b.flag(i(flanger::ON), sid + 540, k("flanger", "on"), false, F_GLOBAL);
        b.num(i(flanger::RATE), sid + 541, k("flanger", "rate"), 0.02, 10.0, 0.3, Log, "Hz", GMS);
        b.num(i(flanger::DEPTH), sid + 542, k("flanger", "depth"), 0.0, 1.0, 0.6, Lin, "%", GMS);
        b.num(i(flanger::FEEDBACK), sid + 543, k("flanger", "feedback"), 0.0, 0.95, 0.5, Lin, "%", GMS);
        b.num(i(flanger::PHASE), sid + 544, k("flanger", "phase"), 0.0, 1.0, 0.25, Lin, "%", GS);
        b.num(i(flanger::MIX), sid + 545, k("flanger", "mix"), 0.0, 1.0, 0.5, Lin, "%", GMS);

        let i = |p: usize| PHASER_BASE + shift + p;
        b.flag(i(phaser::ON), sid + 560, k("phaser", "on"), false, F_GLOBAL);
        b.num(i(phaser::RATE), sid + 561, k("phaser", "rate"), 0.02, 10.0, 0.3, Log, "Hz", GMS);
        b.num(i(phaser::DEPTH), sid + 562, k("phaser", "depth"), 0.0, 1.0, 0.6, Lin, "%", GMS);
        b.num(i(phaser::FREQ), sid + 563, k("phaser", "freq"), 50.0, 8000.0, 600.0, Log, "Hz", GMS);
        b.num(i(phaser::FEEDBACK), sid + 564, k("phaser", "feedback"), 0.0, 0.95, 0.5, Lin, "%", GMS);
        b.num(i(phaser::PHASE), sid + 565, k("phaser", "phase"), 0.0, 1.0, 0.25, Lin, "%", GS);
        b.num(i(phaser::MIX), sid + 566, k("phaser", "mix"), 0.0, 1.0, 0.5, Lin, "%", GMS);

        let i = |p: usize| CHORUS_BASE + shift + p;
        b.flag(i(chorus::ON), sid + 580, k("chorus", "on"), false, F_GLOBAL);
        b.num(i(chorus::RATE), sid + 581, k("chorus", "rate"), 0.02, 10.0, 0.5, Log, "Hz", GMS);
        b.num(i(chorus::DELAY1), sid + 582, k("chorus", "delay1"), 0.5, 20.0, 5.0, Lin, "ms", GS);
        b.num(i(chorus::DELAY2), sid + 583, k("chorus", "delay2"), 0.5, 20.0, 9.0, Lin, "ms", GS);
        b.num(i(chorus::DEPTH), sid + 584, k("chorus", "depth"), 0.0, 1.0, 0.4, Lin, "%", GMS);
        b.num(i(chorus::FEEDBACK), sid + 585, k("chorus", "feedback"), 0.0, 0.95, 0.1, Lin, "%", GMS);
        b.num(i(chorus::LPF), sid + 586, k("chorus", "lpf"), 200.0, 20000.0, 8000.0, Log, "Hz", GMS);
        b.num(i(chorus::MIX), sid + 587, k("chorus", "mix"), 0.0, 1.0, 0.5, Lin, "%", GMS);

        let i = |p: usize| DELAY_BASE + shift + p;
        b.flag(i(delay::ON), sid + 600, k("delay", "on"), false, F_GLOBAL);
        b.flag(i(delay::SYNC), sid + 601, k("delay", "sync"), true, F_GLOBAL);
        b.num(i(delay::TIME_L), sid + 602, k("delay", "timeL"), 0.001, 2.0, 0.25, Log, "s", GMS);
        b.num(i(delay::TIME_R), sid + 603, k("delay", "timeR"), 0.001, 2.0, 0.25, Log, "s", GMS);
        b.choice(i(delay::DIV_L), sid + 604, k("delay", "divL"), DIVISIONS, 11, F_GLOBAL);
        b.choice(i(delay::DIV_R), sid + 605, k("delay", "divR"), DIVISIONS, 11, F_GLOBAL);
        b.flag(i(delay::LINK), sid + 606, k("delay", "link"), true, F_GLOBAL);
        b.num(i(delay::FEEDBACK), sid + 607, k("delay", "feedback"), 0.0, 0.95, 0.4, Lin, "%", GMS);
        b.choice(i(delay::MODE), sid + 608, k("delay", "mode"), DELAY_MODES, 0, F_GLOBAL);
        b.num(i(delay::FILTER_FREQ), sid + 609, k("delay", "filterFreq"), 40.0, 18000.0, 1200.0, Log, "Hz", GMS);
        b.num(i(delay::FILTER_Q), sid + 610, k("delay", "filterQ"), 0.0, 1.0, 0.0, Lin, "%", GMS);
        b.num(i(delay::MIX), sid + 611, k("delay", "mix"), 0.0, 1.0, 0.3, Lin, "%", GMS);

        let i = |p: usize| COMP_BASE + shift + p;
        b.flag(i(comp::ON), sid + 620, k("comp", "on"), false, F_GLOBAL);
        b.num(i(comp::THRESHOLD), sid + 621, k("comp", "threshold"), -60.0, 0.0, -18.0, Lin, "dB", GMS);
        b.num(i(comp::RATIO), sid + 622, k("comp", "ratio"), 1.0, 20.0, 4.0, Log, "x", GMS);
        b.num(i(comp::ATTACK), sid + 623, k("comp", "attack"), 0.1, 500.0, 10.0, Log, "ms", GS);
        b.num(i(comp::RELEASE), sid + 624, k("comp", "release"), 5.0, 2000.0, 150.0, Log, "ms", GS);
        b.num(i(comp::GAIN), sid + 625, k("comp", "gain"), 0.0, 24.0, 0.0, Lin, "dB", GMS);
        b.flag(i(comp::MULTIBAND), sid + 626, k("comp", "multiband"), false, F_GLOBAL);
        b.num(i(comp::MIX), sid + 627, k("comp", "mix"), 0.0, 1.0, 1.0, Lin, "%", GMS);

        let i = |p: usize| REVERB_BASE + shift + p;
        b.flag(i(reverb::ON), sid + 640, k("reverb", "on"), false, F_GLOBAL);
        b.choice(i(reverb::MODE), sid + 641, k("reverb", "mode"), REVERB_MODES, 0, F_GLOBAL);
        b.num(i(reverb::SIZE), sid + 642, k("reverb", "size"), 0.0, 1.0, 0.5, Lin, "%", GMS);
        b.num(i(reverb::DECAY), sid + 643, k("reverb", "decay"), 0.0, 1.0, 0.5, Lin, "%", GMS);
        b.num(i(reverb::PREDELAY), sid + 644, k("reverb", "predelay"), 0.0, 0.25, 0.01, Pow(2.0), "s", GS);
        b.num(i(reverb::LOWCUT), sid + 645, k("reverb", "lowcut"), 0.0, 1.0, 0.1, Lin, "%", GMS);
        b.num(i(reverb::HIGHCUT), sid + 646, k("reverb", "highcut"), 0.0, 1.0, 0.3, Lin, "%", GMS);
        b.num(i(reverb::DAMP), sid + 647, k("reverb", "damp"), 0.0, 1.0, 0.4, Lin, "%", GMS);
        b.num(i(reverb::WIDTH), sid + 648, k("reverb", "width"), 0.0, 1.0, 1.0, Lin, "%", GMS);
        b.num(i(reverb::MIX), sid + 649, k("reverb", "mix"), 0.0, 1.0, 0.25, Lin, "%", GMS);

        let i = |p: usize| EQ_BASE + shift + p;
        b.flag(i(eq::ON), sid + 660, k("eq", "on"), false, F_GLOBAL);
        b.choice(i(eq::LOW_TYPE), sid + 661, k("eq", "lowType"), EQ_LOW_TYPES, 0, F_GLOBAL);
        b.num(i(eq::LOW_FREQ), sid + 662, k("eq", "lowFreq"), 20.0, 20000.0, 120.0, Log, "Hz", GMS);
        b.num(i(eq::LOW_Q), sid + 663, k("eq", "lowQ"), 0.0, 1.0, 0.3, Lin, "%", GMS);
        b.num(i(eq::LOW_GAIN), sid + 664, k("eq", "lowGain"), -18.0, 18.0, 0.0, Lin, "dB", GMS);
        b.choice(i(eq::HIGH_TYPE), sid + 665, k("eq", "highType"), EQ_HIGH_TYPES, 0, F_GLOBAL);
        b.num(i(eq::HIGH_FREQ), sid + 666, k("eq", "highFreq"), 20.0, 20000.0, 6000.0, Log, "Hz", GMS);
        b.num(i(eq::HIGH_Q), sid + 667, k("eq", "highQ"), 0.0, 1.0, 0.3, Lin, "%", GMS);
        b.num(i(eq::HIGH_GAIN), sid + 668, k("eq", "highGain"), -18.0, 18.0, 0.0, Lin, "dB", GMS);

        let i = |p: usize| FXFILTER_BASE + shift + p;
        b.flag(i(fxfilter::ON), sid + 680, k("fxfilter", "on"), false, F_GLOBAL);
        b.choice(i(fxfilter::TYPE), sid + 681, k("fxfilter", "type"), FILTER_TYPES, 2, F_GLOBAL);
        b.num(i(fxfilter::CUTOFF), sid + 682, k("fxfilter", "cutoff"), 20.0, 20000.0, 2000.0, Log, "Hz", GMS);
        b.num(i(fxfilter::RES), sid + 683, k("fxfilter", "res"), 0.0, 1.0, 0.1, Lin, "%", GMS);
        b.num(i(fxfilter::DRIVE), sid + 684, k("fxfilter", "drive"), 0.0, 1.0, 0.0, Lin, "%", GMS);
        b.num(i(fxfilter::VAR), sid + 685, k("fxfilter", "var"), 0.0, 1.0, 0.0, Lin, "%", GMS);
        b.num(i(fxfilter::MIX), sid + 686, k("fxfilter", "mix"), 0.0, 1.0, 1.0, Lin, "%", GMS);
    }

    // --- the fork in the effect chain -------------------------------------
    let i = |p: usize| SPLIT_BASE + p;
    b.choice(i(split::MODE), 700, "split.mode", SPLIT_MODES, 0, F_GLOBAL);
    b.num(i(split::FREQ), 701, "split.freq", 40.0, 12000.0, 400.0, Log, "Hz", GMS);
    b.num(i(split::BALANCE), 702, "split.balance", 0.0, 1.0, 0.5, Lin, "ab", GMS);

    assert_eq!(b.defs.len(), NUM_PARAMS);
    b.defs
}

static DEFS: OnceLock<Vec<ParamDef>> = OnceLock::new();

pub fn defs() -> &'static [ParamDef] {
    DEFS.get_or_init(build)
}

pub fn index_of_key(key: &str) -> Option<usize> {
    defs().iter().position(|d| d.key == key)
}

pub fn index_of_sid(sid: u16) -> Option<usize> {
    defs().iter().position(|d| d.sid == sid)
}

// ---------------------------------------------------------------------------
// Modulation sources
// ---------------------------------------------------------------------------

pub mod src {
    pub const NONE: usize = 0;
    pub const ENV1: usize = 1;
    pub const ENV2: usize = 2;
    pub const ENV3: usize = 3;
    pub const LFO1: usize = 4;
    pub const LFO2: usize = 5;
    pub const LFO3: usize = 6;
    pub const LFO4: usize = 7;
    pub const VELOCITY: usize = 8;
    pub const NOTE: usize = 9;
    pub const MOD_WHEEL: usize = 10;
    pub const AFTERTOUCH: usize = 11;
    pub const PITCH_BEND: usize = 12;
    pub const MACRO1: usize = 13;
    pub const MACRO2: usize = 14;
    pub const MACRO3: usize = 15;
    pub const MACRO4: usize = 16;
    pub const RANDOM: usize = 17;
    pub const N: usize = 18;
}

pub const SOURCE_KEYS: [&str; src::N] = [
    "none", "env1", "env2", "env3", "lfo1", "lfo2", "lfo3", "lfo4", "velocity", "note",
    "modWheel", "aftertouch", "pitchBend", "macro1", "macro2", "macro3", "macro4", "random",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_consistent() {
        let d = defs();
        assert_eq!(d.len(), NUM_PARAMS);
        let mut sids: Vec<u16> = d.iter().map(|p| p.sid).collect();
        sids.sort_unstable();
        sids.dedup();
        assert_eq!(sids.len(), NUM_PARAMS, "stable ids must be unique");
        let mut keys: Vec<&str> = d.iter().map(|p| p.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), NUM_PARAMS, "keys must be unique");
    }

    #[test]
    fn plain_norm_roundtrip() {
        for p in defs() {
            assert!(p.default >= p.min && p.default <= p.max, "{} default out of range", p.key);
            for step in 0..=20 {
                let n = step as f32 / 20.0;
                let plain = p.to_plain(n);
                assert!(plain >= p.min - 1e-3 && plain <= p.max + 1e-3, "{} out of range", p.key);
                if !p.is_discrete() {
                    let back = p.to_norm(plain);
                    assert!((back - n).abs() < 1e-3, "{}: {n} -> {plain} -> {back}", p.key);
                }
            }
            let dn = p.default_norm();
            let dp = p.to_plain(dn);
            let tol = (p.max - p.min).abs() * 1e-4 + 1e-5;
            assert!((dp - p.default).abs() <= tol, "{} default roundtrip {dp} vs {}", p.key, p.default);
        }
    }

    #[test]
    fn effect_copies_share_one_layout() {
        let d = defs();
        for unit in 0..NUM_UNITS {
            let first = FX_BASES[unit % NUM_FX];
            let on = unit_on(unit);
            assert_eq!(d[on].key, format!("{}.on", unit_key(unit)));
            assert_eq!(d[on].sid, d[first].sid + 1000 * (unit / NUM_FX) as u16);
            assert_eq!(d[on].curve, Curve::Bool);
        }
        // The last parameter of the last copy sits right before the fork.
        assert_eq!(d[SPLIT_BASE - 1].key, "fxfilter3.mix");
        assert_eq!(unit_key(1), "dist");
        assert_eq!(unit_key(NUM_FX + 1), "dist2");
    }

    #[test]
    fn stable_ids_are_frozen() {
        // Guards against accidental renumbering: shared URLs depend on these.
        let expect = [
            ("master.volume", 1u16),
            ("oscA.pos", 102),
            ("oscB.pos", 152),
            ("filter.cutoff", 242),
            ("env1.attack", 300),
            ("env3.release", 344),
            ("lfo1.rate", 401),
            ("lfo4.phase", 468),
            ("reverb.mix", 649),
            ("fxfilter.mix", 686),
            ("dist2.drive", 1522),
            ("fxfilter3.mix", 2686),
            ("split.balance", 702),
        ];
        for (key, sid) in expect {
            let i = index_of_key(key).expect(key);
            assert_eq!(defs()[i].sid, sid, "{key}");
        }
    }
}
