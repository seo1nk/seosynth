//! Export to Xfer Serum 2's `.SerumPreset` format.
//!
//! The format is not published. This writer follows what the community has
//! worked out (see README, "Serum export"): a small header, a JSON metadata
//! block, and a Zstandard frame holding a CBOR map of modules, each listing
//! the parameters that differ from Serum's defaults in real units.
//!
//! The two synths are different instruments, so this is a best-effort
//! translation of the patch, not a clone of the sound. Everything that could
//! not be carried over is reported back as a note so the UI can tell the user.
//! Serum loads wavetables from its own folder by path, so the tables a patch
//! uses are exported separately as WAV files (`table_wav`).

pub mod codec;
pub mod value;

use crate::lfo::{LfoKind, LfoPoint};
use crate::params::{self, defs, unit_key, DIVISIONS, FX_KEYS, NUM_ENV, NUM_FX, NUM_LFO, NUM_MACRO, NUM_OSC};
use crate::patch::Patch;
use crate::tables::TABLE_NAMES;
use crate::wavetable::{Bank, FACTORY_TABLES, TABLE_SIZE, USER_TABLES};
use value::{empty, map, Value};

/// Folder (inside Serum's Tables folder) the exported wavetables belong in.
pub const TABLE_DIR: &str = "seosynth";
/// Exported tables are pre-morphed to this many frames so they glide
/// smoothly in Serum regardless of its interpolation setting.
pub const TABLE_FRAMES: usize = 256;

const PRODUCT_VERSION: &str = "2.0.24";
const FORMAT_VERSION: f64 = 9.0;

pub struct Export {
    /// The complete `.SerumPreset` file.
    pub bytes: Vec<u8>,
    /// What could not be translated exactly: `code` or `code\tdetail`.
    pub notes: Vec<String>,
    /// The wavetables the preset refers to, as indices into the bank.
    pub tables: Vec<usize>,
}

/// File name of a table of the bank. A user table is named after what is in
/// it, so tables from different presets do not overwrite each other in
/// Serum's folder.
pub fn table_file_name(patch: &Patch, index: usize) -> String {
    if index < FACTORY_TABLES {
        return format!("{}.wav", TABLE_NAMES[index]);
    }
    let table = &patch.user_tables[(index - FACTORY_TABLES).min(USER_TABLES - 1)];
    // FNV-1a over the points.
    let hash = table.points().iter().fold(0x811c_9dc5u32, |h, p| (h ^ *p as u8 as u32).wrapping_mul(0x0100_0193));
    format!("User {hash:08x}.wav")
}

/// A wavetable of the bank as a WAV file Serum can load.
pub fn table_wav(bank: &mut Bank, index: usize) -> Vec<u8> {
    let table = bank.get(index);
    let mut samples = vec![0.0f32; TABLE_FRAMES * TABLE_SIZE];
    for (f, frame) in samples.chunks_mut(TABLE_SIZE).enumerate() {
        table.render_cycle(f as f32 / (TABLE_FRAMES - 1) as f32, frame);
    }
    codec::wavetable_wav(&samples, TABLE_SIZE, 44_100)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    patch: &'a Patch,
    notes: Vec<String>,
}

impl<'a> Ctx<'a> {
    /// Parameter value in real units, by key.
    fn v(&self, key: &str) -> f32 {
        match params::index_of_key(key) {
            Some(i) => self.patch.plain(i),
            None => 0.0,
        }
    }
    fn on(&self, key: &str) -> bool {
        self.v(key) >= 0.5
    }
    fn option(&self, key: &str) -> &'static str {
        match params::index_of_key(key) {
            Some(i) => {
                let d = &defs()[i];
                d.options.get(self.patch.plain(i) as usize).copied().unwrap_or("")
            }
            None => "",
        }
    }
    fn note(&mut self, code: &str, detail: &str) {
        let line = if detail.is_empty() { code.to_string() } else { format!("{code}\t{detail}") };
        if !self.notes.contains(&line) {
            self.notes.push(line);
        }
    }
}

fn num(v: f32) -> Value {
    Value::from(v)
}

fn flag(on: bool) -> Value {
    Value::Num(if on { 1.0 } else { 0.0 })
}

/// A module's `plainParams`: Serum writes the string "default" when nothing
/// differs from its defaults.
fn plain(pairs: Vec<(&str, Value)>) -> Value {
    if pairs.is_empty() {
        Value::from("default")
    } else {
        map(pairs)
    }
}

fn module(pairs: Vec<(&str, Value)>) -> Value {
    map(vec![("plainParams", plain(pairs))])
}

fn default_module() -> Value {
    module(vec![])
}

fn floats(values: &[f64]) -> Value {
    Value::List(values.iter().map(|v| Value::Num(*v)).collect())
}

/// Serum's 0..1 cutoff knob covers 8 Hz .. 22.05 kHz logarithmically.
fn cutoff_knob(hz: f32) -> f32 {
    ((hz.max(8.0) / 8.0).ln() / (22_050.0f32 / 8.0).ln()).max(0.0).min(1.0)
}

fn hz_to_note(hz: f32) -> f32 {
    69.0 + 12.0 * (hz.max(1.0) / 440.0).log2()
}

/// Bandwidth in octaves of a filter with the given Q.
fn q_to_octaves(q: f32) -> f32 {
    2.0 / core::f32::consts::LN_2 * (1.0 / (2.0 * q.max(0.05))).asinh()
}

fn filter_type(c: &mut Ctx, name: &str, context: &str) -> &'static str {
    let (serum, exact) = match name {
        "LP6" => ("L6", true),
        "LP12" => ("L12", true),
        "LP24" => ("L24", true),
        "Ladder12" => ("MgL12", true),
        "Ladder24" => ("MgL24", true),
        "HP6" => ("H6", true),
        "HP12" => ("H12", true),
        "HP24" => ("H24", true),
        "BP12" => ("B12", true),
        "BP24" => ("B24", true),
        "Notch" => ("N12", true),
        "Peak" => ("P12", true),
        "Morph" => ("LBH12", true),
        "Comb+" => ("CombP", true),
        "Comb-" => ("CombN", true),
        "Phaser" => ("Phase12P", false),
        "Formant" => ("FormantI", false),
        "Reduce" => ("SampHold", false),
        _ => ("RM", false),
    };
    if !exact {
        c.note("filterType", &format!("{context}: {name}"));
    }
    serum
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

fn oscillator(c: &mut Ctx, o: usize, tables: &mut Vec<usize>) -> Value {
    let name = if o == 0 { "oscA" } else { "oscB" };
    let label = if o == 0 { "OSC A" } else { "OSC B" };
    let k = |p: &str| format!("{name}.{p}");
    let table = c.patch.table_index(o);
    if c.on(&k("on")) && !tables.contains(&table) {
        tables.push(table);
    }

    let mut wt = vec![
        ("kParamTablePos", num(1.0 + c.v(&k("pos")) * 255.0)),
        ("kParamInitialPhase", num(c.v(&k("phase")) * 360.0)),
        ("kParamRandomPhase", num(c.v(&k("rand")) * 100.0)),
    ];
    let warp = c.option(&k("warp"));
    let menu = match warp {
        "Sync" => Some("kSync"),
        "SyncWin" => {
            c.note("warpApprox", &format!("{label}: SyncWin"));
            Some("kSync")
        }
        "Bend+" => Some("kBendPos"),
        "Bend-" => Some("kBendNeg"),
        "PWM" => Some("kPWM"),
        "Asym+" => Some("kASYMPos"),
        "Asym-" => Some("kASYMNeg"),
        "Quantize" => Some("kQuantize"),
        "FM" => Some("kFM_OSC"),
        "AM" => Some("kAM_OSC"),
        "RM" => Some("kRM_OSC"),
        "Flip" | "Mirror" => {
            c.note("warpDropped", &format!("{label}: {warp}"));
            None
        }
        _ => None,
    };
    if let Some(m) = menu {
        wt.push(("kParamWarpMenu", Value::from(m)));
        wt.push(("kParamWarp", num(c.v(&k("warpAmt")))));
    }

    let wt_key = format!("WTOsc{o}");
    let params = vec![
        ("kParamEnable", flag(c.on(&k("on")))),
        ("kParamVolume", num(c.v(&k("level")))),
        ("kParamPan", num(c.v(&k("pan")) * 50.0)),
        ("kParamOctave", num(c.v(&k("oct")))),
        ("kParamPitch", num(c.v(&k("semi")))),
        ("kParamFine", num(c.v(&k("fine")))),
        ("kParamCoarsePit", num(c.v(&k("coarse")))),
        ("kParamUnison", num(c.v(&k("unison")))),
        ("kParamDetune", num(c.v(&k("detune")))),
        ("kParamDetuneWid", num(c.v(&k("width")) * 100.0)),
    ];
    let mut m = empty();
    for engine in ["GranularOsc", "MultiSampleOsc", "SampleOsc", "SpectralOsc"] {
        m.set(&format!("{engine}{o}"), default_module());
    }
    m.set(
        &wt_key,
        map(vec![
            ("flex", empty()),
            ("numChannels", Value::Int(1)),
            ("numFrames", Value::Int((TABLE_FRAMES * TABLE_SIZE) as i64)),
            ("plainParams", plain(wt)),
            ("relativePathToWT", Value::from(format!("{TABLE_DIR}/{}", table_file_name(c.patch, table)))),
            ("sampleRate", Value::Int(44_100)),
        ]),
    );
    m.set("plainParams", plain(params));
    m
}

/// Serum's third oscillator, which this synth does not have: left at init.
fn unused_oscillator(o: usize) -> Value {
    let mut m = empty();
    for engine in ["GranularOsc", "MultiSampleOsc", "SampleOsc", "SpectralOsc"] {
        m.set(&format!("{engine}{o}"), default_module());
    }
    m.set(
        &format!("WTOsc{o}"),
        map(vec![
            ("flex", empty()),
            ("numChannels", Value::Int(1)),
            ("numFrames", Value::Int(18_432)),
            ("plainParams", Value::from("default")),
            ("relativePathToWT", Value::from("S2 Tables/Default Shapes.wav")),
            ("sampleRate", Value::Int(44_100)),
        ]),
    );
    m.set("plainParams", Value::from("default"));
    m
}

fn noise(c: &mut Ctx) -> Value {
    let on = c.on("noise.on");
    if on {
        // Serum's noise oscillator plays samples from its library; the
        // closest stock sample is chosen and the user is told to check it.
        let kind = c.option("noise.type");
        c.note("noise", kind);
    }
    let params = if on {
        vec![
            ("kParamEnable", flag(true)),
            ("kParamVolume", num(c.v("noise.level"))),
            ("kParamPan", num(c.v("noise.pan") * 50.0)),
        ]
    } else {
        vec![]
    };
    map(vec![
        (
            "NoiseOsc3",
            map(vec![
                ("detuneFactor", Value::Num(0.475_821_847_841_306_8)),
                ("numChannels", Value::Int(1)),
                ("numFrames", Value::Int(78_241)),
                ("plainParams", Value::from("default")),
                ("relativePathToNoiseSample", Value::from(if on { "Analog/BrightWhite.wav" } else { "Organics/AC hum1.wav" })),
                ("sampleRate", Value::Int(44_100)),
            ]),
        ),
        ("plainParams", plain(params)),
    ])
}

fn sub(c: &mut Ctx) -> Value {
    let shape = match c.option("sub.shape") {
        "Round" => "kRoundRect",
        "Triangle" => "kTriangle",
        "Saw" => "kSaw",
        "Square" => "kSquare",
        "Pulse" => "kPulse",
        _ => "kSine",
    };
    let params = vec![
        ("kParamEnable", flag(c.on("sub.on"))),
        ("kParamVolume", num(c.v("sub.level"))),
        ("kParamPan", num(c.v("sub.pan") * 50.0)),
        ("kParamOctave", num(c.v("sub.oct"))),
    ];
    map(vec![
        ("SubOsc4", module(vec![("kParamShape", Value::from(shape))])),
        ("plainParams", plain(params)),
    ])
}

fn voice_filter(c: &mut Ctx) -> Value {
    let ty = c.option("filter.type");
    let serum = filter_type(c, ty, "FILTER");
    module(vec![
        ("kParamEnable", flag(c.on("filter.on"))),
        ("kParamType", Value::from(serum)),
        ("kParamFreq", num(cutoff_knob(c.v("filter.cutoff")))),
        ("kParamReso", num(c.v("filter.res") * 100.0)),
        ("kParamDrive", num(c.v("filter.drive") * 100.0)),
        ("kParamVar", num(c.v("filter.var") * 100.0)),
        ("kParamWet", num(c.v("filter.mix") * 100.0)),
        ("kParamStereo", num(50.0 + c.v("filter.stereo") * 50.0)),
        ("kParamKeyTrack", num(c.v("filter.keytrack") * 100.0)),
    ])
}

fn envelope(c: &Ctx, e: usize) -> Value {
    let k = |p: &str| format!("env{}.{p}", e + 1);
    // Curves: Serum uses 0..100 with 50 straight; ours are -1..1 with 0 straight.
    let curve = |p: &str| num(50.0 + 50.0 * c.v(&k(p)));
    module(vec![
        ("kParamAttack", num(c.v(&k("attack")))),
        ("kParamHold", num(c.v(&k("hold")))),
        ("kParamDecay", num(c.v(&k("decay")))),
        ("kParamSustain", num(c.v(&k("sustain")))),
        ("kParamRelease", num(c.v(&k("release")))),
        ("kParamCurve1", curve("atkCurve")),
        ("kParamCurve2", curve("decCurve")),
        ("kParamCurve3", curve("relCurve")),
    ])
}

/// Position of a note division on Serum's synced rate knob, plus the dotted
/// and triplet switches. Entries follow `params::DIVISIONS`.
fn division(index: usize) -> (f32, bool, bool) {
    let name = DIVISIONS[index.min(DIVISIONS.len() - 1)];
    let dotted = name.ends_with('.');
    let triplet = name.ends_with('T');
    let base = name.trim_end_matches(|ch| ch == '.' || ch == 'T');
    let step = match base {
        "8/1" => 2.0,
        "4/1" => 3.0,
        "2/1" => 4.0,
        "1/1" => 5.0,
        "1/2" => 6.0,
        "1/4" => 7.0,
        "1/8" => 8.0,
        "1/16" => 9.0,
        "1/32" => 10.0,
        _ => 11.0,
    };
    (step, dotted, triplet)
}

fn lfo_points(kind: LfoKind, custom: &[LfoPoint]) -> Vec<LfoPoint> {
    let p = |x: f32, y: f32| LfoPoint { x, y, curve: 0.0 };
    match kind {
        LfoKind::Sine => (0..=32)
            .map(|i| {
                let x = i as f32 / 32.0;
                p(x, 0.5 + 0.5 * (core::f32::consts::TAU * x).sin())
            })
            .collect(),
        LfoKind::Triangle => vec![p(0.0, 0.0), p(0.5, 1.0), p(1.0, 0.0)],
        LfoKind::SawUp => vec![p(0.0, 0.0), p(1.0, 1.0)],
        LfoKind::SawDown => vec![p(0.0, 1.0), p(1.0, 0.0)],
        LfoKind::Square => vec![p(0.0, 1.0), p(0.5, 1.0), p(0.5, 0.0), p(1.0, 0.0)],
        LfoKind::SampleHold => vec![
            p(0.0, 0.35), p(0.25, 0.35), p(0.25, 0.8), p(0.5, 0.8), p(0.5, 0.15), p(0.75, 0.15), p(0.75, 0.6), p(1.0, 0.6),
        ],
        LfoKind::Smooth => vec![p(0.0, 0.35), p(0.25, 0.8), p(0.5, 0.15), p(0.75, 0.6), p(1.0, 0.35)],
        LfoKind::Custom => {
            let mut pts = custom.to_vec();
            if pts.is_empty() {
                return vec![p(0.0, 0.0), p(0.5, 1.0), p(1.0, 0.0)];
            }
            // Serum shapes span the whole cycle.
            if pts[0].x > 0.0 {
                pts.insert(0, p(0.0, pts[0].y));
            }
            let last = pts[pts.len() - 1];
            if last.x < 1.0 {
                pts.push(p(1.0, last.y));
            }
            pts
        }
    }
}

fn lfo(c: &mut Ctx, l: usize) -> Value {
    let k = |p: &str| format!("lfo{}.{p}", l + 1);
    let kind = LfoKind::from_index(c.v(&k("shape")) as usize);
    if matches!(kind, LfoKind::SampleHold | LfoKind::Smooth) {
        c.note("lfoRandom", &format!("LFO {}", l + 1));
    }
    let pts = lfo_points(kind, &c.patch.lfo_shapes[l]);
    let curve_data = map(vec![
        ("numPoints", Value::Int(pts.len() as i64 - 1)),
        ("xVals", Value::List(pts.iter().map(|p| num(p.x)).collect())),
        // Serum stores y with 0 at the top of its display.
        ("yVals", Value::List(pts.iter().map(|p| num(1.0 - p.y)).collect())),
        ("curveVals", Value::List(pts.iter().map(|p| num(0.5 + 0.5 * p.curve)).collect())),
    ]);

    let mut params = Vec::new();
    if c.on(&k("sync")) {
        let (step, dotted, triplet) = division(c.v(&k("div")) as usize);
        params.push(("kParamRate", num(100.0 * (step / 14.0).powi(4))));
        if dotted {
            params.push(("kParamDotted", flag(true)));
        }
        if triplet {
            params.push(("kParamTriplets", flag(true)));
        }
    } else {
        params.push(("kParamBeatSync", flag(false)));
        params.push(("kParamRate", num(c.v(&k("rate")))));
    }
    match c.option(&k("mode")) {
        "Env" => {
            params.push(("kParamDefaultMode", flag(false)));
            params.push(("kParamMode", Value::from("Envelope")));
        }
        "Free" => {
            params.push(("kParamDefaultMode", flag(false)));
            params.push(("kParamMode", Value::from("Free")));
        }
        _ => {}
    }
    if c.v(&k("rise")) > 0.0 {
        params.push(("kParamRise", num(c.v(&k("rise")))));
    }
    if c.v(&k("delay")) > 0.0 {
        params.push(("kParamDelay", num(c.v(&k("delay")))));
    }
    if c.v(&k("phase")) > 0.0 {
        params.push(("kParamPhase", num(c.v(&k("phase")) * 360.0)));
    }
    if c.v(&k("smooth")) > 0.01 {
        c.note("lfoSmooth", &format!("LFO {}", l + 1));
    }
    map(vec![
        ("curveData", curve_data),
        ("curveDisplayName", Value::from("Custom")),
        ("pathData", empty()),
        ("plainParams", plain(params)),
    ])
}

fn unused_lfo() -> Value {
    map(vec![("curveData", empty()), ("pathData", empty()), ("plainParams", Value::from("default"))])
}

// --- modulation ---------------------------------------------------------------

/// Serum source id for one of our modulation sources.
fn source_id(src: usize) -> Option<i64> {
    use params::src::*;
    Some(match src {
        ENV1 => 2,
        ENV2 => 3,
        ENV3 => 4,
        LFO1 => 6,
        LFO2 => 7,
        LFO3 => 8,
        LFO4 => 9,
        VELOCITY => 16,
        NOTE => 17,
        MOD_WHEEL => 1,
        AFTERTOUCH => 18,
        PITCH_BEND => 33,
        MACRO1 => 25,
        MACRO2 => 26,
        MACRO3 => 27,
        MACRO4 => 28,
        RANDOM => 21,
        _ => return None,
    })
}

struct Dest {
    module: &'static str,
    id: i64,
    name: &'static str,
    param: i64,
    /// Ratio between our parameter range and Serum's, applied to the amount.
    scale: f32,
}

/// Where one of our parameters lives in Serum's modulation matrix. Only
/// destinations whose numeric ids are known are listed.
fn destination(key: &str) -> Option<Dest> {
    let (module_key, param) = key.split_once('.')?;
    let d = |module, id, name, param, scale| Some(Dest { module, id, name, param, scale });
    match module_key {
        "oscA" | "oscB" => {
            let id = if module_key == "oscA" { 0 } else { 1 };
            match param {
                "level" => d("Oscillator", id, "kParamVolume", 1, 1.0),
                "pan" => d("Oscillator", id, "kParamPan", 2, 1.0),
                "fine" => d("Oscillator", id, "kParamFine", 5, 1.0),
                "coarse" => d("Oscillator", id, "kParamCoarsePit", 6, 1.0),
                "detune" => d("Oscillator", id, "kParamDetune", 26, 1.0),
                "width" => d("Oscillator", id, "kParamDetuneWid", 27, 1.0),
                "pos" => d("WTOsc", id, "kParamTablePos", 6, 1.0),
                "warpAmt" => d("WTOsc", id, "kParamWarp", 0, 1.0),
                _ => None,
            }
        }
        "sub" | "noise" => {
            let id = if module_key == "noise" { 3 } else { 4 };
            match param {
                "level" => d("Oscillator", id, "kParamVolume", 1, 1.0),
                "pan" => d("Oscillator", id, "kParamPan", 2, 1.0),
                _ => None,
            }
        }
        "filter" => match param {
            // Our cutoff spans 20 Hz..20 kHz, Serum's 8 Hz..22.05 kHz.
            "cutoff" => d("VoiceFilter", 0, "kParamFreq", 3, (1000.0f32).ln() / (22_050.0f32 / 8.0).ln()),
            "res" => d("VoiceFilter", 0, "kParamReso", 4, 1.0),
            "drive" => d("VoiceFilter", 0, "kParamDrive", 5, 1.0),
            "var" => d("VoiceFilter", 0, "kParamVar", 6, 1.0),
            "mix" => d("VoiceFilter", 0, "kParamWet", 1, 1.0),
            "stereo" => d("VoiceFilter", 0, "kParamStereo", 7, 1.0),
            _ => None,
        },
        _ => None,
    }
}

fn mod_slots(c: &mut Ctx, data: &mut Value) {
    let mut slot = 0;
    for s in c.patch.slots.iter().filter(|s| s.is_set() && s.amount != 0.0) {
        let key = defs()[s.dst as usize].key.clone();
        let source_key = params::SOURCE_KEYS[s.src as usize];
        let (Some(source), Some(dest)) = (source_id(s.src as usize), destination(&key)) else {
            c.note("modDropped", &format!("{source_key} > {key}"));
            continue;
        };
        if slot >= 64 {
            break;
        }
        let amount = (s.amount * 100.0 * dest.scale).max(-100.0).min(100.0);
        let mut params = vec![("kParamAmount", num(amount))];
        if s.bipolar {
            params.push(("kParamBipolar", flag(true)));
        }
        data.set(
            &format!("ModSlot{slot}"),
            map(vec![
                ("destModuleID", Value::Int(dest.id)),
                ("destModuleParamID", Value::Int(dest.param)),
                ("destModuleParamName", Value::from(dest.name)),
                ("destModuleTypeString", Value::from(dest.module)),
                ("plainParams", plain(params)),
                ("source", Value::List(vec![Value::Int(source), Value::Int(0)])),
            ]),
        );
        slot += 1;
    }
}

// --- effects --------------------------------------------------------------------

/// Stored time (seconds) that Serum's synced delay knob quantises to each
/// division, and the scale for dotted / triplet variants.
fn delay_sync(index: usize) -> (f32, f32) {
    let name = DIVISIONS[index.min(DIVISIONS.len() - 1)];
    let dotted = name.ends_with('.');
    let triplet = name.ends_with('T');
    let base = name.trim_end_matches(|ch| ch == '.' || ch == 'T');
    let ladder = ["1/64", "1/32", "1/16", "1/8", "1/4", "1/2", "1/1", "2/1", "4/1"];
    let seconds = [0.005, 0.0105, 0.0218, 0.0387, 0.0832, 0.145, 0.225, 0.34, 0.5];
    let mut i = ladder.iter().position(|d| *d == base).unwrap_or(ladder.len() - 1);
    // A triplet is 4/3 of the next shorter division.
    if triplet && i > 0 {
        i -= 1;
    }
    (seconds[i], if dotted { 1.5 } else if triplet { 4.0 / 3.0 } else { 1.0 })
}

/// Serum's compressor threshold knob (0..1) for a level in dB, from the
/// measured knob law.
fn comp_threshold_knob(db: f32) -> f32 {
    const TABLE: [(f32, f32); 22] = [
        (0.000, 0.0), (0.048, -1.3), (0.096, -2.6), (0.145, -4.1), (0.193, -5.6), (0.241, -7.2), (0.289, -8.9),
        (0.338, -10.7), (0.386, -12.7), (0.434, -14.8), (0.482, -17.2), (0.531, -19.7), (0.579, -22.5),
        (0.627, -25.7), (0.675, -29.3), (0.724, -33.5), (0.772, -38.5), (0.820, -44.7), (0.868, -52.8),
        (0.917, -64.7), (0.965, -87.1), (1.000, -120.0),
    ];
    for w in TABLE.windows(2) {
        let ((x0, y0), (x1, y1)) = (w[0], w[1]);
        if db >= y1 {
            return x0 + (x1 - x0) * (db - y0) / (y1 - y0);
        }
    }
    1.0
}

/// One module of the effect rack for effect unit `unit`.
fn effect(c: &mut Ctx, unit: usize) -> Option<Value> {
    let key = FX_KEYS[unit % NUM_FX];
    let prefix = unit_key(unit);
    let k = |p: &str| format!("{prefix}.{p}");
    let pct = |c: &Ctx, p: &str| num(c.v(&k(p)) * 100.0);
    let (ty, name, params): (i64, &str, Vec<(&str, Value)>) = match key {
        "hyper" => (
            9,
            "FXHyperD",
            vec![
                ("kParamRate", pct(c, "rate")),
                ("kParamDetune", pct(c, "detune")),
                ("kParamUnison", num(c.v(&k("voices")))),
                ("kParamWet", pct(c, "mix")),
                ("kParamDimESize", pct(c, "dimSize")),
                ("kParamDimEWet", pct(c, "dimMix")),
            ],
        ),
        "dist" => {
            let mode = match c.option(&k("mode")) {
                "Soft" => "kSoftClip",
                "Hard" => "kHardClip",
                "Diode" => "kDiode1",
                "Fold" => "kLinFold",
                "SineFold" => "kSinFold",
                "Asym" => "kAsym",
                "Rectify" => "kRectify",
                "Bitcrush" => {
                    c.note("distApprox", "Bitcrush");
                    "kDownsample"
                }
                "Downsample" => "kDownsample",
                _ => "kTube",
            };
            let q = 0.5 * (16.0f32).powf(c.v(&k("filterQ")));
            (
                0,
                "FXDistortion",
                vec![
                    ("kParamMode", Value::from(mode)),
                    ("kParamDrive", pct(c, "drive")),
                    ("kParamWet", pct(c, "mix")),
                    ("kParamPrePost", num(c.v(&k("filterMode")))),
                    ("kParamFreq", num((hz_to_note(c.v(&k("filterFreq"))) / 128.0).max(0.0).min(1.0))),
                    ("kParamLPHP", num(c.v(&k("filterType")) * 50.0)),
                    ("kParamBW", num(q_to_octaves(q).max(0.075).min(7.6))),
                ],
            )
        }
        "flanger" => (
            1,
            "FXFlanger",
            vec![
                ("kParamRate", num(c.v(&k("rate")))),
                ("kParamDepth", pct(c, "depth")),
                ("kParamFeedback", pct(c, "feedback")),
                ("kParamWidth", num(c.v(&k("phase")) * 180.0)),
                ("kParamWet", pct(c, "mix")),
            ],
        ),
        "phaser" => (
            2,
            "FXPhaser",
            vec![
                ("kParamRate", num(c.v(&k("rate")))),
                ("kParamDepth", pct(c, "depth")),
                ("kParamFreq", num(c.v(&k("freq")))),
                ("kParamFeedback", pct(c, "feedback")),
                ("kParamWidth", num(c.v(&k("phase")) * 180.0)),
                ("kParamWet", pct(c, "mix")),
            ],
        ),
        "chorus" => (
            3,
            "FXChorus",
            vec![
                ("kParamRate", num(c.v(&k("rate")))),
                ("kParamDelay", num(c.v(&k("delay1")))),
                ("kParamDelay2", num(c.v(&k("delay2")))),
                ("kParamDepth", num(c.v(&k("depth")) * 2.5)),
                ("kParamFeedback", pct(c, "feedback")),
                ("kParamFilt", num(c.v(&k("lpf")))),
                ("kParamWet", pct(c, "mix")),
            ],
        ),
        "delay" => {
            let sync = c.on(&k("sync"));
            let link = c.on(&k("link"));
            let side = |c: &Ctx, time: &str, div: &str| -> (f32, f32) {
                if sync {
                    delay_sync(c.v(&k(div)) as usize)
                } else {
                    (c.v(&k(time)), 1.0)
                }
            };
            let (tl, ol) = side(c, "timeL", "divL");
            let (tr, or) = if link { (tl, ol) } else { side(c, "timeR", "divR") };
            if sync && [c.option(&k("divL")), c.option(&k("divR"))].contains(&"8/1") {
                c.note("delayLong", "");
            }
            (
                4,
                "FXDelay",
                vec![
                    ("kParamBeatSync", flag(sync)),
                    ("kParamMode", num(c.v(&k("mode")))),
                    ("kParamTimeL", num(tl)),
                    ("kParamTimeR", num(tr)),
                    ("kParamOffsetL", num(ol)),
                    ("kParamOffsetR", num(or)),
                    ("kParamLink", flag(link)),
                    ("kParamFeedback", pct(c, "feedback")),
                    ("kParamFreq", num(c.v(&k("filterFreq")))),
                    ("kParamBW", num(0.75 + (1.0 - c.v(&k("filterQ"))) * 7.5)),
                    ("kParamWet", pct(c, "mix")),
                ],
            )
        }
        "comp" => (
            5,
            "FXComp",
            vec![
                ("kParamThresh", num(comp_threshold_knob(c.v(&k("threshold"))))),
                ("kParamRatio", num(c.v(&k("ratio")))),
                ("kParamAttack", num(c.v(&k("attack")))),
                ("kParamRelease", num(c.v(&k("release")).min(1000.0))),
                ("kParamMakeup", num(crate::util::db_to_gain(c.v(&k("gain"))))),
                ("kParamMultiband", flag(c.on(&k("multiband")))),
                ("kParamWet", pct(c, "mix")),
            ],
        ),
        "reverb" => {
            let hall = c.option(&k("mode")) == "Hall";
            let mut p = vec![
                ("kParamType", Value::from(if hall { "kHall" } else { "kPlate" })),
                ("kParamSize", pct(c, "size")),
                ("kParamPreDelay", num(c.v(&k("predelay")))),
                ("kParamFreq", pct(c, "lowcut")),
                ("kParamFreqB", pct(c, "highcut")),
                ("kParamFreqC", pct(c, "damp")),
                ("kParamWidth", pct(c, "width")),
                ("kParamWet", pct(c, "mix")),
            ];
            if hall {
                // Serum's hall decay control: roughly 3 s at 30 and 7 s at 60.
                let rt60 = 0.5 * (40.0f32).powf(c.v(&k("decay")));
                p.push(("kParamDelay", num((4.0 + 8.6 * rt60).min(250.0))));
            } else {
                c.note("reverbDecay", "");
            }
            (6, "FXReverb", p)
        }
        "eq" => (
            7,
            "FXEQ",
            vec![
                ("kParamType1", num(c.v(&k("lowType")))),
                ("kParamFreq1", num(c.v(&k("lowFreq")))),
                ("kParamReso1", pct(c, "lowQ")),
                ("kParamGain1", num(c.v(&k("lowGain")))),
                ("kParamType2", num(c.v(&k("highType")))),
                ("kParamFreq2", num(c.v(&k("highFreq")))),
                ("kParamReso2", pct(c, "highQ")),
                ("kParamGain2", num(c.v(&k("highGain")))),
            ],
        ),
        "fxfilter" => {
            let ty = c.option(&k("type"));
            let serum = filter_type(c, ty, "FX FILTER");
            (
                8,
                "FXFilter",
                vec![
                    ("kParamType", Value::from(serum)),
                    ("kParamFreq", num(cutoff_knob(c.v(&k("cutoff"))))),
                    ("kParamReso", pct(c, "res")),
                    ("kParamDrive", pct(c, "drive")),
                    ("kParamVar", pct(c, "var")),
                    ("kParamWet", pct(c, "mix")),
                ],
            )
        }
        _ => return None,
    };
    let mut entry = map(vec![("type", Value::Int(ty)), (name, module(params))]);
    match key {
        // The distortion carries its (unused here) drawable shaper curves.
        "dist" => {
            let curve = || {
                map(vec![
                    ("curveVals", floats(&[0.5, 0.5])),
                    ("numPoints", Value::Int(1)),
                    ("xVals", floats(&[0.0, 1.0])),
                    ("yVals", floats(&[1.0, 0.0])),
                ])
            };
            entry.set("flex", Value::List(vec![curve(), curve()]));
        }
        _ => {}
    }
    Some(entry)
}

// ---------------------------------------------------------------------------
// The whole preset
// ---------------------------------------------------------------------------

fn ui_list(count: usize, keys: &[&str]) -> Value {
    Value::List((0..count).map(|_| map(keys.iter().map(|k| (*k, Value::Num(0.0))).collect())).collect())
}

/// Builds the CBOR payload. Returns it with the notes and wavetables used.
pub fn build(patch: &Patch) -> (Value, Vec<String>, Vec<usize>) {
    let mut c = Ctx { patch, notes: Vec::new() };
    let mut tables = Vec::new();
    let mut d = empty();

    // Parts of Serum this synth has no counterpart for stay at their defaults.
    d.set("Arp0", map(vec![("activeClip", Value::Int(-1)), ("plainParams", Value::from("default"))]));
    for i in 0..12 {
        let clip = || map(vec![("clip", empty()), ("plainParams", Value::from("default"))]);
        d.set(&format!("ArpClip{i}"), clip());
        d.set(&format!("MidiClip{i}"), clip());
    }
    d.set(
        "ClipPlayer",
        map(vec![
            ("kUIParamPianoRollNotePreview", Value::Num(1.0)),
            ("kUIParamPreviewClip", Value::Num(0.0)),
            ("kUIParamSelectedClip", Value::Num(0.0)),
        ]),
    );
    d.set("ClipPlayer0", default_module());
    d.set("Filter", map(vec![("kUIParamMixOrGain", Value::Num(0.0))]));
    d.set("GranularOsc", ui_list(3, &["kUIParamDisplayXYInput"]));
    d.set("MultiSampleOsc", ui_list(3, &["kUIParamMultiSampleOverviewMouseTag"]));
    d.set("Osc", ui_list(5, &["kUIParamAutoSyncSlicing", "kUIParamShowMarkerAnimations", "kUIParamZoomToStartEnd"]));
    d.set("SpectralOsc", ui_list(3, &["kUIParamDisplayXYInput", "kUIParamShowWaveformDisplay"]));
    d.set("WTOsc", ui_list(3, &["kUIParamWTOverviewMouseTag"]));
    d.set("SerumGUI", map(vec![("kUIParamShowKeyboard", Value::Num(1.0)), ("kUIParamShowMidiOut", Value::Num(0.0))]));
    for i in 0..16 {
        d.set(&format!("LFOPointModBus{i}"), default_module());
    }
    for i in 0..64 {
        d.set(&format!("ModSlot{i}"), default_module());
    }
    d.set(
        "PitchQuantizer0",
        map(vec![
            ("plainParams", Value::from("default")),
            ("scale", Value::List([0, 2, 0, 2, 0, 0, 2, 0, 2, 0, 2, 0].iter().map(|v| Value::Int(*v)).collect())),
            ("scaleName", Value::from("Major")),
        ]),
    );
    d.set("RetriggerState0", default_module());
    d.set("VoiceFilter1", default_module());
    d.set("VoicePanel0", map(vec![("displayName", Value::from("")), ("plainParams", Value::from("default"))]));
    for i in 1..3 {
        d.set(&format!("FXRack{i}"), map(vec![("FX", Value::List(vec![])), ("displayName", Value::from("")), ("plainParams", Value::from("default"))]));
    }

    // Sources.
    for o in 0..NUM_OSC {
        let osc = oscillator(&mut c, o, &mut tables);
        d.set(&format!("Oscillator{o}"), osc);
    }
    d.set("Oscillator2", unused_oscillator(2));
    let noise_module = noise(&mut c);
    d.set("Oscillator3", noise_module);
    let sub_module = sub(&mut c);
    d.set("Oscillator4", sub_module);

    // Routing: slots 0-2 are the oscillators, 3 noise, 4 sub.
    let filter_on = c.on("filter.on");
    let route = |c: &Ctx, key: &str| {
        let through = filter_on && c.on(key);
        module(vec![("kParamRoutingDest", Value::from(if through { "kRoutingDestFilter" } else { "kRoutingDestDirect" }))])
    };
    d.set("RoutingSlot0", route(&c, "oscA.toFilter"));
    d.set("RoutingSlot1", route(&c, "oscB.toFilter"));
    d.set("RoutingSlot2", default_module());
    d.set("RoutingSlot3", route(&c, "noise.toFilter"));
    d.set("RoutingSlot4", route(&c, "sub.toFilter"));
    d.set("RoutingSlot5", default_module());
    d.set("RoutingSlot6", default_module());

    let filter = voice_filter(&mut c);
    d.set("VoiceFilter0", filter);

    for e in 0..NUM_ENV {
        d.set(&format!("Env{e}"), envelope(&c, e));
    }
    d.set(
        "Env3",
        module(vec![("kParamCurve1", Value::Num(50.0)), ("kParamCurve2", Value::Num(66.6)), ("kParamCurve3", Value::Num(66.6))]),
    );
    for l in 0..10 {
        let m = if l < NUM_LFO { lfo(&mut c, l) } else { unused_lfo() };
        d.set(&format!("LFO{l}"), m);
    }
    for m in 0..8 {
        let value = if m < NUM_MACRO { c.v(&format!("macro{}", m + 1)) } else { 0.0 };
        d.set(&format!("Macro{m}"), if value > 0.0 { module(vec![("kParamValue", num(value * 100.0))]) } else { default_module() });
    }

    // Global.
    let mono = c.on("master.mono");
    let mut global = vec![
        ("kParamMasterVolume", num(c.v("master.volume"))),
        ("kParamPolyCount", num(c.v("master.voices"))),
    ];
    if mono {
        global.push(("kParamMonoToggle", flag(true)));
        if c.on("master.legato") {
            global.push(("kParamLegato", flag(true)));
        }
    }
    if c.v("master.porta") > 0.0 {
        global.push(("kParamPortamentoTime", num(c.v("master.porta"))));
        c.note("portamento", "");
    }
    if c.v("master.bendRange") != 2.0 {
        global.push(("kParamBendRangeUp", num(c.v("master.bendRange"))));
        c.note("bendRange", "");
    }
    if c.v("master.pitch") != 0.0 {
        c.note("masterPitch", "");
    }
    d.set("Global0", module(global));

    mod_slots(&mut c, &mut d);

    // Effects: only the enabled units, in the order the sound meets them.
    // Stacked copies become several modules of the same type. How Serum
    // stores the routing between its racks is not known, so a fork is laid
    // out as one row (lane A, then lane B) and reported.
    let groups = patch.fx_groups();
    if groups.has_split() {
        c.note("split", "");
    }
    let mut rack = Vec::new();
    for &unit in groups.pre.iter().chain(&groups.a).chain(&groups.b).chain(&groups.post) {
        if let Some(entry) = effect(&mut c, unit) {
            rack.push(entry);
        }
    }
    d.set("FXRack0", map(vec![("FX", Value::List(rack)), ("displayName", Value::from("")), ("plainParams", Value::from("default"))]));

    // Preset-level fields (repeated in the file header).
    d.set("arpBankDisplayName", Value::from(""));
    d.set("clipBankDisplayName", Value::from(""));
    d.set("lockOversampling", Value::Bool(false));
    d.set("lockTuning", Value::Bool(false));
    d.set("mpeConfig", Value::Int(0));
    d.set("mpeEnabled", Value::Bool(false));
    d.set("mpePitchBendRange", Value::Int(48));
    d.set("scalars", map(vec![("note", empty()), ("velo", empty())]));
    for (k, v) in header_fields(patch) {
        d.set(k, v);
    }
    // Wavetables always have to be installed, so that note comes first.
    c.notes.insert(0, "tables".to_string());
    (d, c.notes, tables)
}

fn header_fields(patch: &Patch) -> Vec<(&'static str, Value)> {
    let mono = patch.plain(params::master::MONO) >= 0.5;
    let name = if patch.name.trim().is_empty() { "seosynth" } else { patch.name.trim() };
    vec![
        ("fileType", Value::from("SerumPreset")),
        ("presetAuthor", Value::from("seosynth")),
        ("presetDescription", Value::from("Exported from seosynth, a browser wavetable synth.")),
        ("presetName", Value::from(name)),
        ("product", Value::from("Serum2")),
        ("productVersion", Value::from(PRODUCT_VERSION)),
        ("tags", Value::List(vec![Value::from("Wavetable"), Value::from(if mono { "Mono" } else { "Poly" })])),
        ("url", Value::from("https://xferrecords.com/")),
        ("vendor", Value::from("Xfer Records")),
        ("version", Value::Num(FORMAT_VERSION)),
    ]
}

/// Assembles the file: magic, metadata JSON, then the compressed payload.
pub fn pack(patch: &Patch) -> Export {
    let (data, notes, tables) = build(patch);
    let cbor = data.to_cbor();
    let frame = codec::zstd_store(&cbor);

    let mut meta = map(header_fields(patch));
    meta.set("hash", Value::from(codec::md5_hex(&frame)));
    let json = meta.to_json();

    let mut bytes = Vec::with_capacity(json.len() + frame.len() + 32);
    bytes.extend_from_slice(b"XferJson\0");
    bytes.extend_from_slice(&(json.len() as u64).to_le_bytes());
    bytes.extend_from_slice(json.as_bytes());
    bytes.extend_from_slice(&(cbor.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&2u32.to_le_bytes()); // payload encoding: zstd
    bytes.extend_from_slice(&frame);
    Export { bytes, notes, tables }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{filter, index_of_key, lfo_idx, osc, osc_idx, src, FILTER_BASE};
    use crate::patch::ModSlot;

    fn plain_of<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
        path.iter().fold(v, |acc, k| acc.get(k).unwrap_or_else(|| panic!("missing {k} in path {path:?}")))
    }

    fn number(v: &Value) -> f64 {
        match v {
            Value::Num(f) => *f,
            Value::Int(i) => *i as f64,
            other => panic!("not a number: {other:?}"),
        }
    }

    fn set(p: &mut Patch, key: &str, plain: f32) {
        p.set_plain(index_of_key(key).unwrap(), plain);
    }

    #[test]
    fn container_layout() {
        let e = pack(&Patch::init());
        let b = &e.bytes;
        assert_eq!(&b[..9], b"XferJson\0");
        let json_len = u64::from_le_bytes(b[9..17].try_into().unwrap()) as usize;
        let json = std::str::from_utf8(&b[17..17 + json_len]).unwrap();
        assert!(json.starts_with("{\"fileType\":\"SerumPreset\",\"hash\":\""), "{json}");
        assert!(json.contains("\"product\":\"Serum2\""));
        assert!(json.ends_with("\"version\":9.0}"), "{json}");
        let at = 17 + json_len;
        let cbor_len = u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as usize;
        assert_eq!(u32::from_le_bytes(b[at + 4..at + 8].try_into().unwrap()), 2);
        let frame = &b[at + 8..];
        assert_eq!(&frame[..4], &[0x28, 0xb5, 0x2f, 0xfd]);
        assert!(json.contains(&codec::md5_hex(frame)));
        let (data, _, _) = build(&Patch::init());
        assert_eq!(data.to_cbor().len(), cbor_len);
    }

    #[test]
    fn has_every_module_serum_expects() {
        let (data, _, _) = build(&Patch::init());
        let Value::Map(pairs) = &data else { panic!() };
        // A Serum 2 init preset has exactly these 175 top-level entries.
        assert_eq!(pairs.len(), 175);
        for key in ["Arp0", "ArpClip11", "Env3", "FXRack2", "Global0", "LFO9", "LFOPointModBus15", "Macro7", "MidiClip11", "ModSlot63", "Oscillator4", "RoutingSlot6", "VoiceFilter1", "scalars", "version"] {
            assert!(data.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn values_use_serum_units() {
        let mut p = Patch::init();
        p.name = "Unit Test".into();
        p.set_plain(FILTER_BASE + filter::CUTOFF, 1000.0);
        p.set_plain(FILTER_BASE + filter::RES, 0.4);
        p.set_plain(FILTER_BASE + filter::TYPE, 4.0); // Ladder24
        p.set_plain(osc_idx(0, osc::POS), 1.0);
        p.set_plain(osc_idx(0, osc::PAN), -1.0);
        p.set_plain(osc_idx(0, osc::UNISON), 7.0);
        p.set_plain(osc_idx(0, osc::WARP), 1.0); // Sync
        p.set_plain(osc_idx(0, osc::WARP_AMT), 0.25);
        p.set_plain(osc_idx(0, osc::WT), 3.0); // PWM
        set(&mut p, "env1.attack", 0.25);
        set(&mut p, "env1.decCurve", 0.332);
        set(&mut p, "lfo1.div", 5.0); // 1/2
        set(&mut p, "lfo2.sync", 0.0);
        set(&mut p, "lfo2.rate", 3.0);
        set(&mut p, "lfo2.mode", 2.0);
        set(&mut p, "sub.on", 1.0);
        set(&mut p, "sub.shape", 3.0);
        set(&mut p, "master.mono", 1.0);
        let (d, _, tables) = build(&p);
        let near = |v: &Value, want: f64| assert!((number(v) - want).abs() < 1e-3 * want.abs().max(1.0), "{v:?} vs {want}");

        near(plain_of(&d, &["VoiceFilter0", "plainParams", "kParamFreq"]), (1000.0f64 / 8.0).ln() / (22050.0f64 / 8.0).ln());
        near(plain_of(&d, &["VoiceFilter0", "plainParams", "kParamReso"]), 40.0);
        assert_eq!(plain_of(&d, &["VoiceFilter0", "plainParams", "kParamType"]), &Value::from("MgL24"));
        near(plain_of(&d, &["Oscillator0", "WTOsc0", "plainParams", "kParamTablePos"]), 256.0);
        near(plain_of(&d, &["Oscillator0", "plainParams", "kParamPan"]), -50.0);
        near(plain_of(&d, &["Oscillator0", "plainParams", "kParamUnison"]), 7.0);
        assert_eq!(plain_of(&d, &["Oscillator0", "WTOsc0", "plainParams", "kParamWarpMenu"]), &Value::from("kSync"));
        near(plain_of(&d, &["Oscillator0", "WTOsc0", "plainParams", "kParamWarp"]), 0.25);
        assert_eq!(plain_of(&d, &["Oscillator0", "WTOsc0", "relativePathToWT"]), &Value::from("seosynth/PWM.wav"));
        assert_eq!(plain_of(&d, &["Oscillator0", "WTOsc0", "numFrames"]), &Value::Int(524_288));
        assert_eq!(tables, vec![3]);
        near(plain_of(&d, &["Env0", "plainParams", "kParamAttack"]), 0.25);
        near(plain_of(&d, &["Env0", "plainParams", "kParamCurve2"]), 66.6);
        // 1/2 note: step 6 of 14 on the synced rate knob.
        near(plain_of(&d, &["LFO0", "plainParams", "kParamRate"]), 100.0 * (6.0f64 / 14.0).powi(4));
        near(plain_of(&d, &["LFO1", "plainParams", "kParamRate"]), 3.0);
        near(plain_of(&d, &["LFO1", "plainParams", "kParamBeatSync"]), 0.0);
        assert_eq!(plain_of(&d, &["LFO1", "plainParams", "kParamMode"]), &Value::from("Free"));
        assert_eq!(plain_of(&d, &["Oscillator4", "SubOsc4", "plainParams", "kParamShape"]), &Value::from("kSaw"));
        near(plain_of(&d, &["Global0", "plainParams", "kParamMonoToggle"]), 1.0);
        assert_eq!(plain_of(&d, &["tags"]), &Value::List(vec!["Wavetable".into(), "Mono".into()]));
        assert_eq!(plain_of(&d, &["presetName"]), &Value::from("Unit Test"));
    }

    #[test]
    fn default_lfo_shape_is_a_triangle_with_serum_orientation() {
        let (d, _, _) = build(&Patch::init());
        // Serum stores y top-down: a triangle is 1, 0, 1.
        assert_eq!(plain_of(&d, &["LFO0", "curveData", "yVals"]), &floats(&[1.0, 0.0, 1.0]));
        assert_eq!(plain_of(&d, &["LFO0", "curveData", "xVals"]), &floats(&[0.0, 0.5, 1.0]));
        assert_eq!(plain_of(&d, &["LFO0", "curveData", "numPoints"]), &Value::Int(2));
    }

    #[test]
    fn modulation_routings_are_translated_or_reported() {
        let mut p = Patch::init();
        let cutoff = (FILTER_BASE + filter::CUTOFF) as u16;
        p.slots[0] = ModSlot { src: src::LFO1 as u8, dst: cutoff, amount: 0.5, bipolar: true };
        p.slots[1] = ModSlot { src: src::ENV2 as u8, dst: osc_idx(1, osc::POS) as u16, amount: -1.0, bipolar: false };
        p.slots[2] = ModSlot { src: src::MACRO1 as u8, dst: lfo_idx(0, crate::params::lfo::RATE) as u16, amount: 0.3, bipolar: false };
        let (d, notes, _) = build(&p);
        let s0 = d.get("ModSlot0").unwrap();
        assert_eq!(s0.get("source"), Some(&Value::List(vec![Value::Int(6), Value::Int(0)])));
        assert_eq!(s0.get("destModuleTypeString"), Some(&Value::from("VoiceFilter")));
        assert_eq!(s0.get("destModuleParamName"), Some(&Value::from("kParamFreq")));
        assert_eq!(s0.get("destModuleParamID"), Some(&Value::Int(3)));
        let amount = number(plain_of(s0, &["plainParams", "kParamAmount"]));
        assert!((amount - 43.6).abs() < 0.2, "amount scaled to Serum's wider cutoff range: {amount}");
        assert_eq!(plain_of(s0, &["plainParams", "kParamBipolar"]), &Value::Num(1.0));
        let s1 = d.get("ModSlot1").unwrap();
        assert_eq!(s1.get("destModuleTypeString"), Some(&Value::from("WTOsc")));
        assert_eq!(s1.get("destModuleID"), Some(&Value::Int(1)));
        assert_eq!(plain_of(s1, &["plainParams", "kParamAmount"]), &Value::Num(-100.0));
        // The third has no known Serum destination id: dropped and reported.
        assert_eq!(d.get("ModSlot2").unwrap().get("plainParams"), Some(&Value::from("default")));
        assert!(notes.iter().any(|n| n == "modDropped\tmacro1 > lfo1.rate"), "{notes:?}");
    }

    #[test]
    fn effects_follow_the_patch_order_and_only_enabled_ones_are_written() {
        let mut p = Patch::init();
        set(&mut p, "reverb.on", 1.0);
        set(&mut p, "reverb.mode", 1.0);
        set(&mut p, "dist.on", 1.0);
        set(&mut p, "delay.on", 1.0);
        set(&mut p, "delay.divL", 10.0); // 1/8.
        let mut order = crate::patch::DEFAULT_FX_ORDER;
        order[..8].copy_from_slice(&[7, 1, 0, 2, 3, 4, 5, 6]);
        p.fx_order = order;
        let (d, _, _) = build(&p);
        let Some(Value::List(rack)) = d.get("FXRack0").and_then(|r| r.get("FX")) else { panic!() };
        let kinds: Vec<i64> = rack.iter().map(|e| number(e.get("type").unwrap()) as i64).collect();
        assert_eq!(kinds, vec![6, 0, 4], "reverb, distortion, delay");
        assert_eq!(plain_of(&rack[0], &["FXReverb", "plainParams", "kParamType"]), &Value::from("kHall"));
        assert!(rack[1].get("flex").is_some());
        let delay = plain_of(&rack[2], &["FXDelay", "plainParams"]);
        assert_eq!(delay.get("kParamOffsetL"), Some(&Value::Num(1.5)));
        assert!((number(delay.get("kParamTimeL").unwrap()) - 0.0387).abs() < 1e-6);
    }

    #[test]
    fn stacked_effects_and_a_fork_become_one_rack() {
        let mut p = Patch::init();
        set(&mut p, "dist.on", 1.0);
        set(&mut p, "dist2.on", 1.0);
        set(&mut p, "dist2.drive", 0.9);
        set(&mut p, "reverb.on", 1.0);
        set(&mut p, "delay.on", 1.0);
        let (d, notes, _) = build(&p);
        assert!(!notes.iter().any(|n| n.starts_with("split")));
        let kinds = |d: &Value| -> Vec<i64> {
            let Some(Value::List(rack)) = d.get("FXRack0").and_then(|r| r.get("FX")) else { panic!() };
            rack.iter().map(|e| number(e.get("type").unwrap()) as i64).collect()
        };
        assert_eq!(kinds(&d), vec![0, 4, 6, 0], "distortion, delay, reverb, second distortion");
        let Some(Value::List(rack)) = d.get("FXRack0").and_then(|r| r.get("FX")) else { panic!() };
        assert_eq!(plain_of(&rack[3], &["FXDistortion", "plainParams"]).get("kParamDrive"), Some(&Value::Num(90.0)));

        // Reverb on lane A, the second distortion on lane B: the fork sits
        // where the reverb was, and the delay follows it.
        p.fx_lane[7] = crate::patch::lane::A;
        p.fx_lane[11] = crate::patch::lane::B;
        let (d, notes, _) = build(&p);
        assert!(notes.iter().any(|n| n.starts_with("split")));
        assert_eq!(kinds(&d), vec![0, 4, 6, 0]);
        p.fx_lane[1] = crate::patch::lane::B;
        assert_eq!(kinds(&build(&p).0), vec![6, 0, 0, 4], "reverb | both distortions, then the delay");
    }

    #[test]
    fn user_tables_are_exported_under_a_name_of_their_own() {
        let mut p = Patch::init();
        set(&mut p, "oscA.userTable", 2.0);
        let saw: Vec<i8> = (0..crate::wavetable::USER_POINTS).map(|i| (i as i32 * 2 - 127) as i8).collect();
        p.user_tables[1] = crate::wavetable::UserTable::new(&saw).unwrap();
        let (d, _, tables) = build(&p);
        assert_eq!(tables, vec![FACTORY_TABLES + 1]);
        let name = table_file_name(&p, FACTORY_TABLES + 1);
        assert!(name.starts_with("User ") && name.ends_with(".wav") && name.len() == 17, "{name}");
        assert_eq!(plain_of(&d, &["Oscillator0", "WTOsc0", "relativePathToWT"]), &Value::from(format!("seosynth/{name}")));
        // Another drawing gets another name.
        assert_ne!(table_file_name(&Patch::init(), FACTORY_TABLES + 1), name);
        // The WAV carries the drawn shape: a rising saw.
        let mut bank = Bank::new();
        bank.set_user(1, &p.user_tables[1]);
        let wav = table_wav(&mut bank, FACTORY_TABLES + 1);
        let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let sample = |i: usize| f32::from_le_bytes(wav[data + i * 4..data + i * 4 + 4].try_into().unwrap());
        assert!(sample(TABLE_SIZE / 4) < -0.3 && sample(3 * TABLE_SIZE / 4) > 0.3);
    }

    #[test]
    fn helper_laws() {
        assert!((comp_threshold_knob(0.0) - 0.0).abs() < 1e-6);
        assert!((comp_threshold_knob(-17.2) - 0.482).abs() < 1e-3);
        assert!((comp_threshold_knob(-200.0) - 1.0).abs() < 1e-6);
        assert!((cutoff_knob(8.0)).abs() < 1e-6);
        assert!((cutoff_knob(22_050.0) - 1.0).abs() < 1e-6);
        assert_eq!(delay_sync(8), (0.0832, 1.0)); // 1/4
        assert_eq!(delay_sync(9).0, 0.0387); // 1/4T = 4/3 of 1/8
        assert!((q_to_octaves(1.414) - 1.0).abs() < 0.01);
        assert_eq!(division(8), (7.0, false, false));
        assert_eq!(division(7), (7.0, true, false));
        assert_eq!(division(12), (8.0, false, true));
    }

    #[test]
    fn table_wav_has_256_cycles() {
        let mut bank = Bank::new();
        let wav = table_wav(&mut bank, 0);
        let data = wav.windows(4).position(|w| w == b"data").unwrap();
        let len = u32::from_le_bytes(wav[data + 4..data + 8].try_into().unwrap()) as usize;
        assert_eq!(len, TABLE_FRAMES * TABLE_SIZE * 4);
        assert_eq!(table_file_name(&Patch::init(), 0), "Basic Shapes.wav");
    }
}
