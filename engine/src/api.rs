//! The WebAssembly interface.
//!
//! Plain `extern "C"` functions with numeric arguments, so the module can be
//! instantiated inside an AudioWorklet without any JS glue. Bulk data
//! (strings, patch bytes, curves) travels through one shared buffer: the
//! caller reads/writes at `io_ptr()` and passes or receives a length.
//!
//! The browser runs two instances of this module: one in the audio thread
//! that makes sound, and one on the main thread that the UI uses as the
//! source of truth for the patch and for drawing previews.

use crate::filter::{Filter, FilterType};
use crate::lfo::LfoPoint;
use crate::params::{self, defs, Curve, NUM_LFO, NUM_PARAMS, NUM_SLOTS, NUM_UNITS};
use crate::patch::{ModSlot, Patch, NO_DEST};
use crate::synth::{tap, tele, Synth, MAX_VOICES};
use crate::wavetable::{UserTable, USER_MAX_FRAMES, USER_POINTS, USER_TABLES};
use crate::util::BLOCK;
use core::ptr::addr_of_mut;

const IO_CAP: usize = 256 * 1024;

static mut SYNTH: Option<Synth> = None;
static mut IO: Vec<u8> = Vec::new();

fn synth() -> &'static mut Synth {
    // The module is single-threaded: each wasm instance has exactly one
    // caller, so handing out a mutable reference is sound.
    unsafe { (*addr_of_mut!(SYNTH)).get_or_insert_with(|| Synth::new(48_000.0)) }
}

fn io() -> &'static mut Vec<u8> {
    unsafe {
        let io = &mut *addr_of_mut!(IO);
        if io.len() != IO_CAP {
            *io = vec![0u8; IO_CAP];
        }
        io
    }
}

fn write_bytes(bytes: &[u8]) -> usize {
    let n = bytes.len().min(IO_CAP);
    io()[..n].copy_from_slice(&bytes[..n]);
    n
}

fn write_f32s(values: &[f32]) -> usize {
    let buf = io();
    let n = values.len().min(IO_CAP / 4);
    for (i, v) in values[..n].iter().enumerate() {
        buf[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    n
}

fn read_f32(i: usize) -> f32 {
    let b = io();
    f32::from_le_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]])
}

// --- lifecycle ----------------------------------------------------------------

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe {
        *addr_of_mut!(SYNTH) = Some(Synth::new(sample_rate));
    }
    io();
}

#[no_mangle]
pub extern "C" fn io_ptr() -> *mut u8 {
    io().as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn io_cap() -> usize {
    IO_CAP
}

// --- audio --------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn process(frames: usize) {
    synth().process(frames);
}

#[no_mangle]
pub extern "C" fn out_l_ptr() -> *const f32 {
    synth().out_l.as_ptr()
}

#[no_mangle]
pub extern "C" fn out_r_ptr() -> *const f32 {
    synth().out_r.as_ptr()
}

#[no_mangle]
pub extern "C" fn taps_ptr() -> *const f32 {
    synth().taps.as_ptr()
}

#[no_mangle]
pub extern "C" fn telemetry_ptr() -> *const f32 {
    synth().telemetry.as_ptr()
}

// --- performance --------------------------------------------------------------

#[no_mangle]
pub extern "C" fn note_on(note: u32, velocity: f32) {
    synth().note_on(note.min(127) as u8, velocity);
}

#[no_mangle]
pub extern "C" fn note_off(note: u32) {
    synth().note_off(note.min(127) as u8);
}

#[no_mangle]
pub extern "C" fn all_notes_off() {
    synth().all_notes_off();
}

#[no_mangle]
pub extern "C" fn panic_stop() {
    synth().panic();
}

#[no_mangle]
pub extern "C" fn pitch_bend(v: f32) {
    synth().set_pitch_bend(v);
}

#[no_mangle]
pub extern "C" fn mod_wheel(v: f32) {
    synth().set_mod_wheel(v);
}

#[no_mangle]
pub extern "C" fn aftertouch(v: f32) {
    synth().set_aftertouch(v);
}

// --- parameters ---------------------------------------------------------------

#[no_mangle]
pub extern "C" fn param_count() -> usize {
    NUM_PARAMS
}

#[no_mangle]
pub extern "C" fn get_param(idx: usize) -> f32 {
    synth().get_param(idx)
}

#[no_mangle]
pub extern "C" fn set_param(idx: usize, norm: f32) {
    synth().set_param(idx, norm);
}

#[no_mangle]
pub extern "C" fn param_plain(idx: usize, norm: f32) -> f32 {
    defs().get(idx).map(|d| d.to_plain(norm)).unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn param_norm(idx: usize, plain: f32) -> f32 {
    defs().get(idx).map(|d| d.to_norm(plain)).unwrap_or(0.0)
}

// --- modulation matrix --------------------------------------------------------

/// `dst` is a parameter index, or negative for "none".
#[no_mangle]
pub extern "C" fn slot_set(i: usize, src: u32, dst: i32, amount: f32, bipolar: u32) {
    let slot = if src == 0 || dst < 0 || dst as usize >= NUM_PARAMS || src as usize >= params::src::N {
        ModSlot::EMPTY
    } else {
        ModSlot {
            src: src as u8,
            dst: dst as u16,
            amount: if amount.is_finite() { amount.max(-1.0).min(1.0) } else { 0.0 },
            bipolar: bipolar != 0,
        }
    };
    synth().set_slot(i, slot);
}

/// Writes [src, dst (-1 = none), amount, bipolar] as four f32.
#[no_mangle]
pub extern "C" fn slot_get(i: usize) -> usize {
    let s = synth().patch.slots.get(i).copied().unwrap_or(ModSlot::EMPTY);
    let dst = if s.dst == NO_DEST { -1.0 } else { s.dst as f32 };
    write_f32s(&[s.src as f32, dst, s.amount, if s.bipolar { 1.0 } else { 0.0 }])
}

// --- LFO shapes ---------------------------------------------------------------

/// Reads `count` points (x, y, curve as f32 triples) from the IO buffer.
#[no_mangle]
pub extern "C" fn lfo_shape_set(l: usize, count: usize) {
    let count = count.min(crate::lfo::MAX_POINTS);
    let points = (0..count)
        .map(|k| LfoPoint { x: read_f32(k * 3), y: read_f32(k * 3 + 1), curve: read_f32(k * 3 + 2) })
        .collect();
    synth().set_lfo_shape(l, points);
}

/// Writes the points as f32 triples and returns their count.
#[no_mangle]
pub extern "C" fn lfo_shape_get(l: usize) -> usize {
    let s = synth();
    let Some(shape) = s.patch.lfo_shapes.get(l) else { return 0 };
    let flat: Vec<f32> = shape.iter().flat_map(|p| [p.x, p.y, p.curve]).collect();
    write_f32s(&flat);
    shape.len()
}

// --- building tables off the audio callback --------------------------------------

/// Called by the audio thread: build tables a little at a time, and ask the
/// main thread for factory tables (see `tablejobs`).
#[no_mangle]
pub extern "C" fn set_realtime(on: u32) {
    synth().set_realtime(on != 0);
}

/// A factory table the patch needs that is not built yet, or -1.
#[no_mangle]
pub extern "C" fn table_wanted() -> i32 {
    synth().wanted_table().map_or(-1, |i| i as i32)
}

/// Generates factory table `index` without band-limiting it and puts the
/// frames (`TABLE_SIZE` floats each) at `blob_ptr()`. Returns the number of
/// frames. For the main thread, to hand to the audio thread.
#[no_mangle]
pub extern "C" fn table_raw(index: usize) -> usize {
    let (frames, data) = crate::tables::generate(index.min(crate::wavetable::FACTORY_TABLES - 1));
    set_blob(data.iter().flat_map(|v| v.to_le_bytes()).collect());
    frames
}

/// Room in wasm memory for the raw frames of factory table `index`. Fill
/// `frames * TABLE_SIZE` floats there, then call `table_offer_ready`.
#[no_mangle]
pub extern "C" fn table_offer(index: usize, frames: usize) -> *mut f32 {
    synth().offer_table(index, frames).as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn table_offer_ready() {
    synth().offered_table_ready();
}

// --- user wavetables ----------------------------------------------------------

/// Replaces user table `slot` with `frames` frames of `USER_POINTS` signed
/// bytes each, read from the IO buffer. Returns 1 if that was a valid table.
#[no_mangle]
pub extern "C" fn user_table_set(slot: usize, frames: usize) -> u32 {
    let len = frames.min(USER_MAX_FRAMES + 1) * USER_POINTS;
    let points: Vec<i8> = io()[..len].iter().map(|b| *b as i8).collect();
    match UserTable::new(&points) {
        Some(table) if slot < USER_TABLES => {
            synth().set_user_table(slot, table);
            1
        }
        _ => 0,
    }
}

/// Writes the points of user table `slot` to the IO buffer and returns how
/// many there are (its frame count times `USER_POINTS`).
#[no_mangle]
pub extern "C" fn user_table_get(slot: usize) -> usize {
    let bytes: Vec<u8> = synth().patch.user_tables[slot.min(USER_TABLES - 1)].points().iter().map(|p| *p as u8).collect();
    write_bytes(&bytes)
}

// --- effect chain -------------------------------------------------------------

/// Reads the processing order of the effect units (`NUM_UNITS` bytes) and
/// then the lane of each unit (`NUM_UNITS` bytes, indexed by unit) from the
/// IO buffer. Returns 1 if they were valid.
#[no_mangle]
pub extern "C" fn fx_chain_set() -> u32 {
    let bytes: Vec<u8> = io()[..NUM_UNITS * 2].to_vec();
    synth().set_fx_chain(&bytes[..NUM_UNITS], &bytes[NUM_UNITS..]) as u32
}

/// Writes the order and the lanes in the layout `fx_chain_set` reads.
#[no_mangle]
pub extern "C" fn fx_chain_get() -> usize {
    let patch = &synth().patch;
    let bytes: Vec<u8> = patch.fx_order.iter().chain(patch.fx_lane.iter()).copied().collect();
    write_bytes(&bytes)
}

// --- whole patch --------------------------------------------------------------

#[no_mangle]
pub extern "C" fn name_set(len: usize) {
    let bytes = io()[..len.min(256)].to_vec();
    synth().patch.name = String::from_utf8_lossy(&bytes).chars().take(64).collect();
}

#[no_mangle]
pub extern "C" fn name_get() -> usize {
    let name = synth().patch.name.clone();
    write_bytes(name.as_bytes())
}

/// Serialises the patch into the IO buffer and returns its length.
#[no_mangle]
pub extern "C" fn patch_save() -> usize {
    let bytes = synth().patch.to_bytes();
    write_bytes(&bytes)
}

/// Loads a patch from the first `len` bytes of the IO buffer.
/// Returns 1 on success, 0 if the data was not a valid patch.
#[no_mangle]
pub extern "C" fn patch_load(len: usize) -> u32 {
    let bytes = io()[..len.min(IO_CAP)].to_vec();
    match Patch::from_bytes(&bytes) {
        Ok(p) => {
            synth().load_patch(p);
            1
        }
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn patch_init() {
    synth().load_patch(Patch::init());
}

// --- previews -----------------------------------------------------------------

#[no_mangle]
pub extern "C" fn preview_osc(osc: usize, pos: f32, warp_amt: f32, n: usize) -> usize {
    let mut buf = vec![0.0f32; n.max(2).min(4096)];
    synth().preview_osc(osc, pos, warp_amt, &mut buf);
    write_f32s(&buf)
}

#[no_mangle]
pub extern "C" fn preview_table(table: usize, pos: f32, n: usize) -> usize {
    let mut buf = vec![0.0f32; n.max(2).min(4096)];
    synth().preview_table(table, pos, &mut buf);
    write_f32s(&buf)
}

#[no_mangle]
pub extern "C" fn table_frames(table: usize) -> usize {
    synth().table_frames(table)
}

#[no_mangle]
pub extern "C" fn preview_lfo(l: usize, n: usize) -> usize {
    let mut buf = vec![0.0f32; n.max(2).min(4096)];
    synth().preview_lfo(l.min(NUM_LFO - 1), &mut buf);
    write_f32s(&buf)
}

/// Magnitude response in dB at `n` log-spaced points from 20 Hz to 20 kHz.
/// Returns 0 for filter types that have no meaningful response curve.
#[no_mangle]
pub extern "C" fn filter_response(ty: usize, cutoff_hz: f32, res: f32, var: f32, n: usize) -> usize {
    let ty = FilterType::from_index(ty);
    if !ty.has_response() {
        return 0;
    }
    let mut buf = vec![0.0f32; n.max(2).min(1024)];
    Filter::response(ty, cutoff_hz, res, var, 48_000.0, &mut buf);
    write_f32s(&buf)
}

/// The bend used by envelope stages and LFO segments.
#[no_mangle]
pub extern "C" fn curve(t: f32, c: f32) -> f32 {
    crate::util::curve_shape(t, c)
}

// --- Serum export ---------------------------------------------------------------

static mut BLOB: Vec<u8> = Vec::new();

fn set_blob(bytes: Vec<u8>) -> usize {
    unsafe {
        let blob = &mut *addr_of_mut!(BLOB);
        *blob = bytes;
        blob.len()
    }
}

/// Start of the buffer holding the result of the last `serum_export` or
/// `serum_table_wav` call (these can be larger than the IO buffer).
#[no_mangle]
pub extern "C" fn blob_ptr() -> *const u8 {
    unsafe { (*addr_of_mut!(BLOB)).as_ptr() }
}

/// Builds a Serum 2 `.SerumPreset` from the current patch. Returns its
/// length; the bytes are at `blob_ptr()`.
#[no_mangle]
pub extern "C" fn serum_export() -> usize {
    set_blob(crate::serum::pack(&synth().patch).bytes)
}

/// Notes about what the Serum export could not translate exactly, one per
/// line as `code` or `code<TAB>detail`. Written to the IO buffer.
#[no_mangle]
pub extern "C" fn serum_notes() -> usize {
    write_bytes(crate::serum::pack(&synth().patch).notes.join("\n").as_bytes())
}

/// Indices of the wavetables the exported preset refers to, one byte each,
/// written to the IO buffer. Returns how many.
#[no_mangle]
pub extern "C" fn serum_tables() -> usize {
    let tables: Vec<u8> = crate::serum::pack(&synth().patch).tables.iter().map(|t| *t as u8).collect();
    write_bytes(&tables)
}

/// A wavetable (factory or user) as a WAV file for Serum. Returns its
/// length; the bytes are at `blob_ptr()`.
#[no_mangle]
pub extern "C" fn serum_table_wav(table: usize) -> usize {
    set_blob(crate::serum::table_wav(synth().bank_mut(), table))
}

/// Path of that file relative to Serum's Tables folder, in the IO buffer.
#[no_mangle]
pub extern "C" fn serum_table_path(table: usize) -> usize {
    write_bytes(format!("{}/{}", crate::serum::TABLE_DIR, crate::serum::table_file_name(&synth().patch, table)).as_bytes())
}

// --- self description ---------------------------------------------------------

fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_list(out: &mut String, items: &[&str]) {
    out.push('[');
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_str(out, s);
    }
    out.push(']');
}

pub fn describe_json() -> String {
    let mut o = String::with_capacity(48 * 1024);
    o.push_str("{\"params\":[");
    for (i, d) in defs().iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        let (curve, k) = match d.curve {
            Curve::Lin => ("lin", 0.0),
            Curve::Pow(k) => ("pow", k),
            Curve::Log => ("log", 0.0),
            Curve::Int => ("int", 0.0),
            Curve::Bool => ("bool", 0.0),
            Curve::Enum => ("enum", 0.0),
        };
        o.push_str(&format!("{{\"i\":{},\"sid\":{},\"key\":", i, d.sid));
        json_str(&mut o, &d.key);
        o.push_str(&format!(
            ",\"min\":{},\"max\":{},\"def\":{},\"defNorm\":{},\"curve\":\"{}\",\"k\":{},\"unit\":\"{}\",\"mod\":{},\"global\":{},\"options\":",
            d.min,
            d.max,
            d.default,
            d.default_norm(),
            curve,
            k,
            d.unit,
            d.has(params::F_MOD),
            d.has(params::F_GLOBAL),
        ));
        json_list(&mut o, d.options);
        o.push('}');
    }
    o.push_str("],\"sources\":");
    json_list(&mut o, &params::SOURCE_KEYS);
    // "fx" lists the effect units ("dist", "dist2", ...), "fxKinds" the
    // kinds of effect they are copies of.
    let units: Vec<String> = (0..NUM_UNITS).map(params::unit_key).collect();
    let units: Vec<&str> = units.iter().map(|k| k.as_str()).collect();
    o.push_str(",\"fx\":");
    json_list(&mut o, &units);
    o.push_str(",\"fxKinds\":");
    json_list(&mut o, &params::FX_KEYS);
    // The factory wavetables. In calls that take a table index, the user
    // tables follow them: user table `slot` is table `tables.length + slot`.
    o.push_str(",\"tables\":");
    json_list(&mut o, crate::tables::TABLE_NAMES);
    o.push_str(&format!(",\"userTables\":{USER_TABLES},\"userPoints\":{USER_POINTS},\"userMaxFrames\":{USER_MAX_FRAMES}"));
    o.push_str(",\"divisionBeats\":[");
    for (i, b) in params::DIVISION_BEATS.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&format!("{b}"));
    }
    o.push_str(&format!(
        "],\"numSlots\":{},\"numVoices\":{},\"block\":{},\"maxLfoPoints\":{}",
        NUM_SLOTS,
        MAX_VOICES,
        BLOCK,
        crate::lfo::MAX_POINTS
    ));
    o.push_str(&format!(
        ",\"tap\":{{\"count\":{},\"len\":{},\"oscA\":0,\"oscB\":1,\"sub\":2,\"noise\":3,\"filterIn\":4,\"filterOut\":5,\"amp\":6,\"mix\":{},\"fx\":{},\"splitA\":{},\"splitB\":{},\"splitOut\":{},\"out\":{}}}",
        tap::N,
        tap::LEN,
        tap::MIX,
        tap::FX,
        tap::SPLIT_A,
        tap::SPLIT_B,
        tap::SPLIT_OUT,
        tap::OUT
    ));
    o.push_str(&format!(
        ",\"tele\":{{\"len\":{},\"voices\":{},\"peakL\":{},\"peakR\":{},\"note\":{},\"pitch\":{},\"tapPos\":{},\"gate\":{},\"compReduction\":{},\"envPos\":{},\"envVal\":{},\"lfoPhase\":{},\"lfoVal\":{},\"sources\":{},\"params\":{}}}",
        tele::LEN,
        tele::VOICES,
        tele::PEAK_L,
        tele::PEAK_R,
        tele::NOTE,
        tele::PITCH,
        tele::TAP_POS,
        tele::GATE,
        tele::COMP_REDUCTION,
        tele::ENV_POS,
        tele::ENV_VAL,
        tele::LFO_PHASE,
        tele::LFO_VAL,
        tele::SOURCES,
        tele::PARAMS
    ));
    o.push('}');
    o
}

/// Writes a JSON description of the engine (parameter table, option lists,
/// buffer layouts) into the IO buffer, so the UI never hard-codes them.
#[no_mangle]
pub extern "C" fn describe() -> usize {
    write_bytes(describe_json().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_is_valid_looking_json_and_fits() {
        let j = describe_json();
        assert!(j.len() < IO_CAP, "description is {} bytes", j.len());
        assert!(j.starts_with('{') && j.ends_with('}'));
        // Balanced brackets outside strings.
        let (mut depth, mut in_str, mut esc) = (0i32, false, false);
        for c in j.chars() {
            if in_str {
                if esc {
                    esc = false;
                } else if c == '\\' {
                    esc = true;
                } else if c == '"' {
                    in_str = false;
                }
                continue;
            }
            match c {
                '"' => in_str = true,
                '{' | '[' => depth += 1,
                '}' | ']' => depth -= 1,
                _ => {}
            }
            assert!(depth >= 0);
        }
        assert_eq!(depth, 0);
        assert!(!j.contains("NaN") && !j.contains("inf"));
        assert!(j.contains("\"key\":\"filter.cutoff\""));
    }
}
