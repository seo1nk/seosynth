//! A patch is the complete, shareable state of the synth: parameter values,
//! modulation routings, custom LFO shapes and the layout of the effect chain.
//!
//! The binary format is what ends up (base64url-encoded) in share URLs, so it
//! is compact and forward compatible:
//!
//! ```text
//! 'S' version                      2 bytes
//! then sections: tag, varint length, payload
//!   1 name      UTF-8
//!   2 params    repeated: varint (sid << 1 | discrete),
//!               discrete: zigzag varint of the plain value
//!               continuous: u16 LE of the normalised value
//!   3 mods      repeated: src u8, varint dst sid, i16 LE amount, flags u8
//!   4 lfo shape lfo index u8, count u8, points (x u16, y u16, curve i8)
//!   5 fx order  10 bytes: order of the first copy of each effect (old patches)
//!   6 fx chain  one byte per unit, in processing order: unit | lane << 6.
//!               Only a prefix is written; units that are left out follow in
//!               ascending order on the main lane. Units are numbered as
//!               when there were 10 kinds of effect (read only)
//!  11 fx chain  the same, numbered with today's kinds (`params::NUM_FX`)
//!   7 user table  slot u8, then its frames: 128 signed bytes each (old
//!               patches; read only)
//!   8 user table  the same, but each point is stored as its difference to
//!               the point before it (wrapping, the first from 0). Drawn and
//!               recorded waves change smoothly, so the differences are small
//!               and a share link compresses well (see web share.ts)
//!   9 clip      varint length in ticks, then per note (in order of start):
//!               varint start (as the difference to the note before),
//!               pitch u8, varint length, velocity u8
//!  10 mod shape  repeated: position u8 of the routing in section 3,
//!               curve i8 (-127..127), aux source u8. Kept apart from
//!               section 3 so that older builds still read the routings.
//! ```
//!
//! Only values that differ from the defaults are written. Unknown sections
//! and unknown parameter ids are skipped, so old builds can open newer
//! patches and vice versa.

use crate::clip::{Clip, ClipNote};
use crate::lfo::{default_points, sanitize_points, LfoPoint};
use crate::params::{self, defs, osc, osc_idx, unit_from_old, unit_on, NUM_LFO, NUM_OSC, NUM_PARAMS, NUM_SLOTS, NUM_UNITS, OLD_NUM_FX};
use crate::wavetable::{UserTable, FACTORY_TABLES, USER_TABLES};

pub const NO_DEST: u16 = 0xFFFF;
pub const FORMAT_VERSION: u8 = 1;
const MAGIC: u8 = b'S';

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ModSlot {
    /// Source id (`params::src`), 0 = empty.
    pub src: u8,
    /// Destination parameter index, `NO_DEST` = empty.
    pub dst: u16,
    /// -1..1 in normalised parameter range.
    pub amount: f32,
    /// Swing both ways around the knob position instead of one way from it.
    pub bipolar: bool,
    /// Bends the source before it is used: -1..1, 0 = straight. Above 0 the
    /// response rises early, below 0 it rises late (mirrored when bipolar).
    pub curve: f32,
    /// A second source that scales this routing (`params::src`), 0 = none.
    pub aux: u8,
}

impl ModSlot {
    pub const EMPTY: ModSlot = ModSlot { src: 0, dst: NO_DEST, amount: 0.0, bipolar: false, curve: 0.0, aux: 0 };

    pub fn is_set(&self) -> bool {
        self.src != 0 && (self.src as usize) < params::src::N && (self.dst as usize) < NUM_PARAMS
    }

    /// The aux source, if it names a real source.
    pub fn aux_src(&self) -> usize {
        if (self.aux as usize) < params::src::N { self.aux as usize } else { 0 }
    }

    /// Curve as stored in a patch.
    fn curve_byte(&self) -> i8 {
        (self.curve.max(-1.0).min(1.0) * 127.0).round() as i8
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Patch {
    pub name: String,
    /// Normalised values, indexed like `params::defs()`.
    pub values: Vec<f32>,
    pub slots: [ModSlot; NUM_SLOTS],
    pub lfo_shapes: [Vec<LfoPoint>; NUM_LFO],
    /// Processing order of the effect units (a permutation of 0..NUM_UNITS).
    /// Units that are switched off keep their place but do nothing.
    pub fx_order: [u8; NUM_UNITS],
    /// Lane of each unit, indexed by unit: `lane::MAIN`, `lane::A` or `lane::B`.
    pub fx_lane: [u8; NUM_UNITS],
    /// Wavetables drawn or imported by the user.
    pub user_tables: [UserTable; USER_TABLES],
    /// The pattern the clip sequencer plays.
    pub clip: Clip,
}

/// Where a unit sits relative to the fork in the effect chain.
pub mod lane {
    pub const MAIN: u8 = 0;
    pub const A: u8 = 1;
    pub const B: u8 = 2;
}

pub const DEFAULT_FX_ORDER: [u8; NUM_UNITS] = {
    let mut order = [0u8; NUM_UNITS];
    let mut i = 0;
    while i < NUM_UNITS {
        order[i] = i as u8;
        i += 1;
    }
    order
};

/// The enabled effect units in the order the sound meets them.
///
/// The chain has one fork at most: `pre -> [a | b] -> post`. The fork sits
/// where the first enabled unit of lane A or B is found in the order; every
/// other unit of those lanes joins it there. So any order and any choice of
/// lanes gives exactly one well-defined chain.
#[derive(Debug, Default, PartialEq)]
pub struct FxGroups {
    pub pre: Vec<usize>,
    pub a: Vec<usize>,
    pub b: Vec<usize>,
    pub post: Vec<usize>,
}

impl FxGroups {
    pub fn has_split(&self) -> bool {
        !self.a.is_empty() || !self.b.is_empty()
    }
}

impl Default for Patch {
    fn default() -> Self {
        Patch::init()
    }
}

/// True if `order` contains each of 0..count exactly once.
fn is_permutation(order: &[u8], count: usize) -> bool {
    let mut seen = [false; NUM_UNITS];
    order.len() == count
        && order.iter().all(|&o| {
            let ok = (o as usize) < count && !seen[o as usize];
            if ok {
                seen[o as usize] = true;
            }
            ok
        })
}

/// `start` followed by every unit it does not contain, in ascending order.
/// Entries that are out of range or repeated are dropped.
fn complete_order(start: &[u8]) -> [u8; NUM_UNITS] {
    let mut seen = [false; NUM_UNITS];
    let mut order = [0u8; NUM_UNITS];
    let mut n = 0;
    for &u in start {
        if (u as usize) < NUM_UNITS && !seen[u as usize] {
            seen[u as usize] = true;
            order[n] = u;
            n += 1;
        }
    }
    for u in 0..NUM_UNITS {
        if !seen[u] {
            order[n] = u as u8;
            n += 1;
        }
    }
    order
}

impl Patch {
    /// The initial patch: every parameter at its default.
    pub fn init() -> Patch {
        Patch {
            name: String::from("Init"),
            values: defs().iter().map(|d| d.default_norm()).collect(),
            slots: [ModSlot::EMPTY; NUM_SLOTS],
            lfo_shapes: core::array::from_fn(|_| default_points()),
            fx_order: DEFAULT_FX_ORDER,
            fx_lane: [lane::MAIN; NUM_UNITS],
            user_tables: Default::default(),
            clip: Clip::default(),
        }
    }

    pub fn plain(&self, idx: usize) -> f32 {
        defs()[idx].to_plain(self.values[idx])
    }

    pub fn set_plain(&mut self, idx: usize, plain: f32) {
        self.values[idx] = defs()[idx].to_norm(plain);
    }

    /// Sets the order of all units and the lane of each (indexed by unit).
    /// Returns false, changing nothing, unless `order` is a permutation of
    /// all units and every lane is valid.
    pub fn set_fx_chain(&mut self, order: &[u8], lanes: &[u8]) -> bool {
        if is_permutation(order, NUM_UNITS) && lanes.len() == NUM_UNITS && lanes.iter().all(|&l| l <= lane::B) {
            self.fx_order.copy_from_slice(order);
            self.fx_lane.copy_from_slice(lanes);
            true
        } else {
            false
        }
    }

    /// The table oscillator `o` plays, as an index into the wavetable bank:
    /// a factory table, or a user table (which follow the factory ones).
    pub fn table_index(&self, o: usize) -> usize {
        let o = o.min(NUM_OSC - 1);
        match self.plain(osc_idx(o, osc::USER)) as usize {
            0 => (self.plain(osc_idx(o, osc::WT)) as usize).min(FACTORY_TABLES - 1),
            user => FACTORY_TABLES + (user - 1).min(USER_TABLES - 1),
        }
    }

    pub fn fx_on(&self, unit: usize) -> bool {
        self.values[unit_on(unit)] >= 0.5
    }

    pub fn fx_groups(&self) -> FxGroups {
        let mut g = FxGroups::default();
        let mut forked = false;
        for &u in self.fx_order.iter() {
            let u = u as usize;
            if !self.fx_on(u) {
                continue;
            }
            match self.fx_lane[u] {
                lane::A => {
                    forked = true;
                    g.a.push(u);
                }
                lane::B => {
                    forked = true;
                    g.b.push(u);
                }
                _ if forked => g.post.push(u),
                _ => g.pre.push(u),
            }
        }
        g
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let d = defs();
        let mut out = vec![MAGIC, FORMAT_VERSION];

        if !self.name.is_empty() {
            let name = truncate_utf8(&self.name, 64);
            section(&mut out, 1, name.as_bytes());
        }

        let mut buf = Vec::new();
        for (i, def) in d.iter().enumerate() {
            if def.is_discrete() {
                let plain = def.to_plain(self.values[i]) as i32;
                if plain != def.default as i32 {
                    varint(&mut buf, (def.sid as u32) << 1 | 1);
                    varint(&mut buf, zigzag(plain));
                }
            } else {
                let q = quantize(self.values[i]);
                if q != quantize(def.default_norm()) {
                    varint(&mut buf, (def.sid as u32) << 1);
                    buf.extend_from_slice(&q.to_le_bytes());
                }
            }
        }
        if !buf.is_empty() {
            section(&mut out, 2, &buf);
        }

        buf.clear();
        for s in self.slots.iter().filter(|s| s.is_set()) {
            buf.push(s.src);
            varint(&mut buf, d[s.dst as usize].sid as u32);
            let a = (s.amount.max(-1.0).min(1.0) * 32767.0).round() as i16;
            buf.extend_from_slice(&a.to_le_bytes());
            buf.push(s.bipolar as u8);
        }
        if !buf.is_empty() {
            section(&mut out, 3, &buf);
        }

        buf.clear();
        for (k, s) in self.slots.iter().filter(|s| s.is_set()).enumerate() {
            if s.curve_byte() != 0 || s.aux_src() != 0 {
                buf.extend_from_slice(&[k as u8, s.curve_byte() as u8, s.aux_src() as u8]);
            }
        }
        if !buf.is_empty() {
            section(&mut out, 10, &buf);
        }

        let default_shape = default_points();
        for (l, shape) in self.lfo_shapes.iter().enumerate() {
            if *shape == default_shape {
                continue;
            }
            buf.clear();
            buf.push(l as u8);
            buf.push(shape.len() as u8);
            for p in shape {
                buf.extend_from_slice(&quantize(p.x).to_le_bytes());
                buf.extend_from_slice(&quantize(p.y).to_le_bytes());
                buf.push((p.curve.max(-1.0).min(1.0) * 127.0).round() as i8 as u8);
            }
            section(&mut out, 4, &buf);
        }

        // The chain: everything up to the point from where the rest is in
        // its default place.
        let default_from = |k: usize| {
            self.fx_order[k..].windows(2).all(|w| w[0] < w[1]) && self.fx_order[k..].iter().all(|&u| self.fx_lane[u as usize] == lane::MAIN)
        };
        let keep = (0..=NUM_UNITS).find(|&k| default_from(k)).unwrap_or(NUM_UNITS);
        if keep > 0 {
            buf.clear();
            buf.extend(self.fx_order[..keep].iter().map(|&u| u | self.fx_lane[u as usize] << 6));
            section(&mut out, 11, &buf);
        }

        let untouched = UserTable::default();
        for (slot, table) in self.user_tables.iter().enumerate() {
            if *table == untouched {
                continue;
            }
            buf.clear();
            buf.push(slot as u8);
            let mut prev = 0i8;
            for &p in table.points() {
                buf.push(p.wrapping_sub(prev) as u8);
                prev = p;
            }
            section(&mut out, 8, &buf);
        }

        if self.clip != Clip::default() {
            buf.clear();
            varint(&mut buf, self.clip.length);
            let mut prev = 0;
            for n in &self.clip.notes {
                varint(&mut buf, n.start - prev);
                prev = n.start;
                buf.push(n.pitch);
                varint(&mut buf, n.length);
                buf.push(n.velocity);
            }
            section(&mut out, 9, &buf);
        }
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Patch, &'static str> {
        if bytes.len() < 2 || bytes[0] != MAGIC {
            return Err("not a patch");
        }
        if bytes[1] == 0 || bytes[1] > FORMAT_VERSION {
            return Err("unsupported patch version");
        }
        let d = defs();
        let mut patch = Patch::init();
        patch.name.clear();
        let mut r = Reader { b: bytes, i: 2 };
        let mut slot = 0;
        // Where each routing of section 3, in written order, ended up.
        let mut placed: Vec<Option<usize>> = Vec::new();
        while !r.done() {
            let tag = r.u8()?;
            let len = r.varint()? as usize;
            let mut s = Reader { b: r.take(len)?, i: 0 };
            match tag {
                1 => patch.name = String::from_utf8_lossy(s.b).chars().take(64).collect(),
                2 => {
                    while !s.done() {
                        let key = s.varint()?;
                        let sid = (key >> 1) as u16;
                        let idx = params::index_of_sid(sid);
                        if key & 1 == 1 {
                            let plain = unzigzag(s.varint()?);
                            if let Some(i) = idx {
                                patch.values[i] = d[i].to_norm(plain as f32);
                            }
                        } else {
                            let q = s.u16()?;
                            if let Some(i) = idx {
                                patch.values[i] = q as f32 / 65535.0;
                            }
                        }
                    }
                }
                3 => {
                    while !s.done() {
                        let src = s.u8()?;
                        let dst = params::index_of_sid(s.varint()? as u16);
                        let amount = s.u16()? as i16 as f32 / 32767.0;
                        let flags = s.u8()?;
                        let mut at = None;
                        if let Some(dst) = dst {
                            if slot < NUM_SLOTS && src != 0 && (src as usize) < params::src::N {
                                patch.slots[slot] = ModSlot { src, dst: dst as u16, amount, bipolar: flags & 1 == 1, ..ModSlot::EMPTY };
                                at = Some(slot);
                                slot += 1;
                            }
                        }
                        placed.push(at);
                    }
                }
                10 => {
                    while !s.done() {
                        let k = s.u8()? as usize;
                        let curve = s.u8()? as i8 as f32 / 127.0;
                        let aux = s.u8()?;
                        if let Some(Some(i)) = placed.get(k) {
                            patch.slots[*i].curve = curve;
                            patch.slots[*i].aux = if (aux as usize) < params::src::N { aux } else { 0 };
                        }
                    }
                }
                4 => {
                    let l = s.u8()? as usize;
                    let count = s.u8()? as usize;
                    let mut pts = Vec::with_capacity(count.min(64));
                    for _ in 0..count {
                        let x = s.u16()? as f32 / 65535.0;
                        let y = s.u16()? as f32 / 65535.0;
                        let curve = s.u8()? as i8 as f32 / 127.0;
                        pts.push(LfoPoint { x, y, curve });
                    }
                    sanitize_points(&mut pts);
                    if l < NUM_LFO {
                        patch.lfo_shapes[l] = pts;
                    }
                }
                5 => {
                    // An old patch: the order of the ten original units.
                    if is_permutation(s.b, OLD_NUM_FX) {
                        patch.fx_order = complete_order(s.b);
                    }
                }
                6 | 11 => {
                    // Old chains count units with fewer kinds of effect.
                    let unit = |b: u8| {
                        let u = (b & 0x3F) as usize;
                        if tag == 11 {
                            u
                        } else if u < OLD_NUM_FX * params::FX_COPIES {
                            unit_from_old(u)
                        } else {
                            usize::MAX
                        }
                    };
                    let units: Vec<u8> = s.b.iter().map(|&b| unit(b).min(255) as u8).collect();
                    patch.fx_order = complete_order(&units);
                    patch.fx_lane = [lane::MAIN; NUM_UNITS];
                    for &b in s.b {
                        let (u, l) = (unit(b), b >> 6);
                        if u < NUM_UNITS && l <= lane::B {
                            patch.fx_lane[u] = l;
                        }
                    }
                }
                7 | 8 => {
                    let slot = s.u8()? as usize;
                    let mut prev = 0i8;
                    let points: Vec<i8> = s.b[1..]
                        .iter()
                        .map(|&b| {
                            if tag == 8 {
                                prev = prev.wrapping_add(b as i8);
                                prev
                            } else {
                                b as i8
                            }
                        })
                        .collect();
                    if let (true, Some(table)) = (slot < USER_TABLES, UserTable::new(&points)) {
                        patch.user_tables[slot] = table;
                    }
                }
                9 => {
                    let length = s.varint()?;
                    let mut notes = Vec::new();
                    let mut start = 0u32;
                    while !s.done() && notes.len() < crate::clip::MAX_NOTES {
                        start = start.saturating_add(s.varint()?);
                        let pitch = s.u8()?;
                        let len = s.varint()?;
                        let velocity = s.u8()?;
                        notes.push(ClipNote { pitch, start, length: len, velocity });
                    }
                    if let Some(clip) = Clip::new(length, &notes) {
                        patch.clip = clip;
                    }
                }
                _ => {} // unknown section from a newer version: skip
            }
        }
        Ok(patch)
    }
}

fn truncate_utf8(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

#[inline]
fn quantize(n: f32) -> u16 {
    (n.max(0.0).min(1.0) * 65535.0).round() as u16
}

fn zigzag(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

fn unzigzag(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

fn varint(out: &mut Vec<u8>, mut v: u32) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7F) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn section(out: &mut Vec<u8>, tag: u8, payload: &[u8]) {
    out.push(tag);
    varint(out, payload.len() as u32);
    out.extend_from_slice(payload);
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn done(&self) -> bool {
        self.i >= self.b.len()
    }
    fn u8(&mut self) -> Result<u8, &'static str> {
        let v = *self.b.get(self.i).ok_or("truncated patch")?;
        self.i += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16, &'static str> {
        Ok(self.u8()? as u16 | (self.u8()? as u16) << 8)
    }
    fn varint(&mut self) -> Result<u32, &'static str> {
        let mut v = 0u32;
        for shift in (0..35).step_by(7) {
            let b = self.u8()?;
            v |= ((b & 0x7F) as u32) << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err("bad varint")
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8], &'static str> {
        let end = self.i.checked_add(len).ok_or("truncated patch")?;
        let s = self.b.get(self.i..end).ok_or("truncated patch")?;
        self.i = end;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{filter, lfo_idx, src, FILTER_BASE};

    fn sample_patch() -> Patch {
        let mut p = Patch::init();
        p.name = "テスト Lead".into();
        p.set_plain(FILTER_BASE + filter::CUTOFF, 880.0);
        p.set_plain(FILTER_BASE + filter::TYPE, 4.0);
        p.set_plain(osc_idx(0, osc::UNISON), 7.0);
        p.set_plain(osc_idx(1, osc::ON), 1.0);
        p.set_plain(osc_idx(1, osc::OCT), -2.0);
        p.set_plain(lfo_idx(2, crate::params::lfo::RATE), 7.5);
        p.slots[0] = ModSlot { src: src::LFO1 as u8, dst: (FILTER_BASE + filter::CUTOFF) as u16, amount: 0.35, bipolar: true, curve: 0.5, aux: src::MOD_WHEEL as u8 };
        p.slots[1] = ModSlot { src: src::ENV2 as u8, dst: osc_idx(0, osc::POS) as u16, amount: -0.8, bipolar: false, ..ModSlot::EMPTY };
        p.lfo_shapes[1] = vec![
            LfoPoint { x: 0.0, y: 1.0, curve: 0.5 },
            LfoPoint { x: 0.3, y: 0.25, curve: -0.25 },
            LfoPoint { x: 1.0, y: 0.0, curve: 0.0 },
        ];
        p.fx_order = complete_order(&[7, 1, 2, 3, 4, 5, 6, 0, 8, 9]);
        p.fx_lane[11] = lane::B;
        p.set_plain(osc_idx(1, osc::USER), 2.0);
        let ramp: Vec<i8> = (0..2 * crate::wavetable::USER_POINTS).map(|i| (i as i32 - 128) as i8).collect();
        p.user_tables[1] = UserTable::new(&ramp).unwrap();
        p.clip = Clip::new(
            crate::clip::PPQ * 8,
            &[
                ClipNote { pitch: 48, start: 0, length: 90, velocity: 127 },
                ClipNote { pitch: 55, start: 0, length: 40, velocity: 1 },
                ClipNote { pitch: 72, start: 700, length: 68, velocity: 64 },
            ],
        )
        .unwrap();
        p
    }

    #[test]
    fn init_patch_is_tiny() {
        let bytes = Patch::init().to_bytes();
        assert!(bytes.len() < 12, "init patch is {} bytes", bytes.len());
        assert_eq!(Patch::from_bytes(&bytes).unwrap(), Patch::init());
    }

    #[test]
    fn roundtrip_preserves_everything() {
        let p = sample_patch();
        let bytes = p.to_bytes();
        let q = Patch::from_bytes(&bytes).unwrap();
        assert_eq!(q.name, p.name);
        assert_eq!(q.fx_order, p.fx_order);
        assert_eq!(q.fx_lane, p.fx_lane);
        assert_eq!(q.user_tables, p.user_tables);
        assert_eq!(q.user_tables[1].frames(), 2);
        assert_eq!(q.user_tables[0], UserTable::default());
        assert_eq!(q.clip, p.clip);
        assert_eq!(Patch::from_bytes(&Patch::init().to_bytes()).unwrap().clip, Clip::default());
        assert_eq!(q.table_index(0), 0);
        assert_eq!(q.table_index(1), FACTORY_TABLES + 1);
        for i in 0..NUM_PARAMS {
            let d = &defs()[i];
            if d.is_discrete() {
                assert_eq!(q.plain(i), p.plain(i), "{}", d.key);
            } else {
                assert!((q.values[i] - p.values[i]).abs() < 1e-4, "{}", d.key);
            }
        }
        assert_eq!(q.slots[0].src, p.slots[0].src);
        assert_eq!(q.slots[0].dst, p.slots[0].dst);
        assert!(q.slots[0].bipolar);
        assert!((q.slots[0].curve - 0.5).abs() < 0.01);
        assert_eq!(q.slots[0].aux, src::MOD_WHEEL as u8);
        assert_eq!((q.slots[1].curve, q.slots[1].aux), (0.0, 0));
        assert!((q.slots[0].amount - 0.35).abs() < 1e-4);
        assert!((q.slots[1].amount + 0.8).abs() < 1e-4);
        assert!(!q.slots[2].is_set());
        assert_eq!(q.lfo_shapes[1].len(), 3);
        assert!((q.lfo_shapes[1][1].x - 0.3).abs() < 1e-4);
        assert!((q.lfo_shapes[1][0].curve - 0.5).abs() < 0.01);
        assert_eq!(q.lfo_shapes[0], default_points());
        // Saving again gives identical bytes: the encoding is stable.
        assert_eq!(q.to_bytes(), bytes);
    }

    #[test]
    fn garbage_is_rejected_not_crashed_on() {
        assert!(Patch::from_bytes(&[]).is_err());
        assert!(Patch::from_bytes(b"hello world").is_err());
        let good = sample_patch().to_bytes();
        // Truncating at any point must never panic.
        for cut in 0..good.len() {
            let _ = Patch::from_bytes(&good[..cut]);
        }
        // Flipping any byte must never panic either.
        for i in 2..good.len() {
            let mut bad = good.clone();
            bad[i] ^= 0xFF;
            let _ = Patch::from_bytes(&bad);
        }
    }

    #[test]
    fn unknown_sections_and_params_are_skipped() {
        let mut bytes = vec![MAGIC, FORMAT_VERSION];
        section(&mut bytes, 99, &[1, 2, 3, 4]);
        let mut params = Vec::new();
        varint(&mut params, 9999 << 1); // unknown continuous
        params.extend_from_slice(&1234u16.to_le_bytes());
        varint(&mut params, 9998 << 1 | 1); // unknown discrete
        varint(&mut params, zigzag(-3));
        varint(&mut params, (242 << 1) as u32); // filter.cutoff
        params.extend_from_slice(&32768u16.to_le_bytes());
        section(&mut bytes, 2, &params);
        let p = Patch::from_bytes(&bytes).unwrap();
        assert!((p.values[FILTER_BASE + filter::CUTOFF] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn invalid_fx_chain_is_ignored() {
        let mut p = Patch::init();
        let lanes = [lane::MAIN; NUM_UNITS];
        let mut twice = DEFAULT_FX_ORDER;
        twice[1] = 0;
        assert!(!p.set_fx_chain(&twice, &lanes));
        assert!(!p.set_fx_chain(&[0, 1, 2], &lanes));
        assert!(!p.set_fx_chain(&DEFAULT_FX_ORDER, &[3; NUM_UNITS]));
        assert_eq!(p.fx_order, DEFAULT_FX_ORDER);
        let mut reversed = DEFAULT_FX_ORDER;
        reversed.reverse();
        assert!(p.set_fx_chain(&reversed, &[lane::A; NUM_UNITS]));
        assert_eq!(p.fx_order[0] as usize, NUM_UNITS - 1);
    }

    #[test]
    fn fx_chain_is_written_as_a_short_prefix() {
        let size = |p: &Patch| p.to_bytes().len();
        let base = size(&Patch::init());
        // Reverb first: one byte for the chain plus the section header.
        let mut p = Patch::init();
        p.fx_order = complete_order(&[7]);
        assert_eq!(size(&p), base + 3);
        assert_eq!(Patch::from_bytes(&p.to_bytes()).unwrap().fx_order, p.fx_order);
        // A lane on an early unit, order untouched.
        let mut p = Patch::init();
        p.fx_lane[1] = lane::A;
        assert_eq!(size(&p), base + 4);
        let q = Patch::from_bytes(&p.to_bytes()).unwrap();
        assert_eq!(q.fx_lane, p.fx_lane);
        assert_eq!(q.fx_order, DEFAULT_FX_ORDER);
    }

    #[test]
    fn chains_saved_with_ten_kinds_of_effect_keep_their_units() {
        // Before the frequency shifter and utility: unit 11 was the second
        // distortion and 27 the third reverb.
        let mut bytes = vec![MAGIC, FORMAT_VERSION];
        section(&mut bytes, 6, &[27, 11 | lane::B << 6, 3]);
        let p = Patch::from_bytes(&bytes).unwrap();
        let dist2 = params::NUM_FX + 1;
        let reverb3 = 2 * params::NUM_FX + 7;
        assert_eq!(&p.fx_order[..3], &[reverb3 as u8, dist2 as u8, 3]);
        assert_eq!(params::unit_key(dist2), "dist2");
        assert_eq!(params::unit_key(reverb3), "reverb3");
        assert_eq!(p.fx_lane[dist2], lane::B);
        // Saved again, it is written in today's numbering and reads back.
        let q = Patch::from_bytes(&p.to_bytes()).unwrap();
        assert_eq!((q.fx_order, q.fx_lane), (p.fx_order, p.fx_lane));
        // Out of range in the old numbering: dropped.
        let mut bytes = vec![MAGIC, FORMAT_VERSION];
        section(&mut bytes, 6, &[30, 31]);
        assert_eq!(Patch::from_bytes(&bytes).unwrap().fx_order, DEFAULT_FX_ORDER);
    }

    #[test]
    fn old_fx_order_section_still_loads() {
        let mut bytes = vec![MAGIC, FORMAT_VERSION];
        section(&mut bytes, 5, &[7, 1, 2, 3, 4, 5, 6, 0, 8, 9]);
        let p = Patch::from_bytes(&bytes).unwrap();
        assert_eq!(&p.fx_order[..10], &[7, 1, 2, 3, 4, 5, 6, 0, 8, 9]);
        assert_eq!(&p.fx_order[10..13], &[10, 11, 12]);
        assert_eq!(p.fx_lane, [lane::MAIN; NUM_UNITS]);
        // A broken one is ignored.
        let mut bytes = vec![MAGIC, FORMAT_VERSION];
        section(&mut bytes, 5, &[0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(Patch::from_bytes(&bytes).unwrap().fx_order, DEFAULT_FX_ORDER);
    }

    #[test]
    fn groups_gather_the_lanes_at_the_first_fork() {
        let mut p = Patch::init();
        for u in [0, 1, 4, 5, 7, 11] {
            p.values[unit_on(u)] = 1.0;
        }
        assert_eq!(p.fx_groups(), FxGroups { pre: vec![0, 1, 4, 5, 7, 11], ..Default::default() });
        assert!(!p.fx_groups().has_split());
        p.fx_lane[4] = lane::A;
        p.fx_lane[11] = lane::B;
        p.fx_lane[7] = lane::A;
        p.fx_lane[2] = lane::A; // switched off: not part of anything
        let g = p.fx_groups();
        assert_eq!(g, FxGroups { pre: vec![0, 1], a: vec![4, 7], b: vec![11], post: vec![5] });
        assert!(g.has_split());
    }

    #[test]
    fn user_tables_are_written_as_differences_and_old_ones_still_load() {
        // Extremes on purpose: differences of +-254 wrap around.
        let pts: Vec<i8> = (0..crate::wavetable::USER_POINTS).map(|i| if i % 2 == 0 { 127 } else { -127 }).collect();
        let mut p = Patch::init();
        p.user_tables[0] = UserTable::new(&pts).unwrap();
        let bytes = p.to_bytes();
        assert_eq!(Patch::from_bytes(&bytes).unwrap().user_tables[0].points(), &pts[..]);
        // Tag 8, length 129 as a two-byte varint, the slot, then the points.
        let at = bytes.windows(4).position(|w| w == [8, 0x81, 0x01, 0]).expect("section 8 holding slot 0 + 128 points");
        assert_eq!(bytes[at + 4] as i8, 127, "the first point counts from zero");
        assert_eq!(bytes[at + 5] as i8, 2, "-127 - 127 wraps to 2");

        // A link from before: section 7, points as they are.
        let mut old = vec![MAGIC, FORMAT_VERSION];
        let mut payload = vec![1u8];
        payload.extend(pts.iter().map(|v| *v as u8));
        section(&mut old, 7, &payload);
        assert_eq!(Patch::from_bytes(&old).unwrap().user_tables[1].points(), &pts[..]);
    }

    #[test]
    fn broken_user_tables_are_ignored() {
        for tag in [7, 8] {
            for payload in [vec![0u8; 1], vec![0u8; 100], vec![9u8; 129], vec![0u8; 1 + 128 * 17]] {
                let mut bytes = vec![MAGIC, FORMAT_VERSION];
                section(&mut bytes, tag, &payload);
                assert_eq!(Patch::from_bytes(&bytes).unwrap().user_tables, Patch::init().user_tables);
            }
        }
        let mut bytes = vec![MAGIC, FORMAT_VERSION];
        section(&mut bytes, 7, &[]);
        assert!(Patch::from_bytes(&bytes).is_err(), "a section cut short is an error, not a crash");
    }

    #[test]
    fn mod_shapes_follow_the_routings_they_belong_to() {
        // The first routing names a parameter this build does not know, so
        // the second one lands in slot 0 and its shape must go with it.
        let mut bytes = vec![MAGIC, FORMAT_VERSION];
        let mut mods = vec![src::LFO1 as u8];
        varint(&mut mods, 9999);
        mods.extend_from_slice(&[0, 0x40, 0]);
        mods.push(src::ENV2 as u8);
        varint(&mut mods, defs()[FILTER_BASE + filter::CUTOFF].sid as u32);
        mods.extend_from_slice(&[0, 0x40, 0]);
        section(&mut bytes, 3, &mods);
        section(&mut bytes, 10, &[0, 100, src::LFO2 as u8, 1, (-64i8) as u8, 250]);
        let p = Patch::from_bytes(&bytes).unwrap();
        assert_eq!(p.slots[0].src, src::ENV2 as u8);
        assert!((p.slots[0].curve + 64.0 / 127.0).abs() < 1e-6);
        assert_eq!(p.slots[0].aux, 0, "an unknown aux source is dropped");
        assert!(!p.slots[1].is_set());
        // A routing without a shape writes no section 10.
        let mut q = Patch::init();
        q.slots[0] = ModSlot { src: src::LFO1 as u8, dst: (FILTER_BASE + filter::CUTOFF) as u16, amount: 0.5, ..ModSlot::EMPTY };
        let plain = q.to_bytes();
        q.slots[0].curve = 0.25;
        assert_eq!(q.to_bytes().len(), plain.len() + 5);
    }

    #[test]
    fn zigzag_roundtrip() {
        for v in [-64, -1, 0, 1, 2, 63, 1000, -1000] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
    }
}
