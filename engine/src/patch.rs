//! A patch is the complete, shareable state of the synth: parameter values,
//! modulation routings, custom LFO shapes and the effect order.
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
//!   5 fx order  NUM_FX bytes
//! ```
//!
//! Only values that differ from the defaults are written. Unknown sections
//! and unknown parameter ids are skipped, so old builds can open newer
//! patches and vice versa.

use crate::lfo::{default_points, sanitize_points, LfoPoint};
use crate::params::{self, defs, NUM_FX, NUM_LFO, NUM_PARAMS, NUM_SLOTS};

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
}

impl ModSlot {
    pub const EMPTY: ModSlot = ModSlot { src: 0, dst: NO_DEST, amount: 0.0, bipolar: false };

    pub fn is_set(&self) -> bool {
        self.src != 0 && (self.src as usize) < params::src::N && (self.dst as usize) < NUM_PARAMS
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Patch {
    pub name: String,
    /// Normalised values, indexed like `params::defs()`.
    pub values: Vec<f32>,
    pub slots: [ModSlot; NUM_SLOTS],
    pub lfo_shapes: [Vec<LfoPoint>; NUM_LFO],
    /// Processing order of the effect units (a permutation of 0..NUM_FX).
    pub fx_order: [u8; NUM_FX],
}

pub const DEFAULT_FX_ORDER: [u8; NUM_FX] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

impl Default for Patch {
    fn default() -> Self {
        Patch::init()
    }
}

fn valid_order(order: &[u8]) -> bool {
    let mut seen = [false; NUM_FX];
    order.len() == NUM_FX
        && order.iter().all(|&o| {
            let ok = (o as usize) < NUM_FX && !seen[o as usize];
            if ok {
                seen[o as usize] = true;
            }
            ok
        })
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
        }
    }

    pub fn plain(&self, idx: usize) -> f32 {
        defs()[idx].to_plain(self.values[idx])
    }

    pub fn set_plain(&mut self, idx: usize, plain: f32) {
        self.values[idx] = defs()[idx].to_norm(plain);
    }

    pub fn set_fx_order(&mut self, order: &[u8]) -> bool {
        if valid_order(order) {
            self.fx_order.copy_from_slice(order);
            true
        } else {
            false
        }
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

        if self.fx_order != DEFAULT_FX_ORDER {
            section(&mut out, 5, &self.fx_order);
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
                        if let Some(dst) = dst {
                            if slot < NUM_SLOTS && src != 0 && (src as usize) < params::src::N {
                                patch.slots[slot] = ModSlot { src, dst: dst as u16, amount, bipolar: flags & 1 == 1 };
                                slot += 1;
                            }
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
                    patch.set_fx_order(s.b);
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
    use crate::params::{filter, lfo_idx, osc, osc_idx, src, FILTER_BASE};

    fn sample_patch() -> Patch {
        let mut p = Patch::init();
        p.name = "テスト Lead".into();
        p.set_plain(FILTER_BASE + filter::CUTOFF, 880.0);
        p.set_plain(FILTER_BASE + filter::TYPE, 4.0);
        p.set_plain(osc_idx(0, osc::UNISON), 7.0);
        p.set_plain(osc_idx(1, osc::ON), 1.0);
        p.set_plain(osc_idx(1, osc::OCT), -2.0);
        p.set_plain(lfo_idx(2, crate::params::lfo::RATE), 7.5);
        p.slots[0] = ModSlot { src: src::LFO1 as u8, dst: (FILTER_BASE + filter::CUTOFF) as u16, amount: 0.35, bipolar: true };
        p.slots[1] = ModSlot { src: src::ENV2 as u8, dst: osc_idx(0, osc::POS) as u16, amount: -0.8, bipolar: false };
        p.lfo_shapes[1] = vec![
            LfoPoint { x: 0.0, y: 1.0, curve: 0.5 },
            LfoPoint { x: 0.3, y: 0.25, curve: -0.25 },
            LfoPoint { x: 1.0, y: 0.0, curve: 0.0 },
        ];
        p.fx_order = [7, 1, 2, 3, 4, 5, 6, 0, 8, 9];
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
    fn invalid_fx_order_is_ignored() {
        let mut p = Patch::init();
        assert!(!p.set_fx_order(&[0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(!p.set_fx_order(&[0, 1, 2]));
        assert_eq!(p.fx_order, DEFAULT_FX_ORDER);
    }

    #[test]
    fn zigzag_roundtrip() {
        for v in [-64, -1, 0, 1, 2, 63, 1000, -1000] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
    }
}
