//! Byte-level pieces of the preset container: a zstd frame writer that
//! stores data uncompressed, and MD5.

/// Wraps `data` in a valid Zstandard frame made of raw (uncompressed)
/// blocks. Any zstd decoder reads it. Without embedded wavetables a preset
/// is a few kilobytes; each embedded table adds about 2.6 MB, which real
/// compression would only partly win back (the samples are floats).
pub fn zstd_store(data: &[u8]) -> Vec<u8> {
    const MAX_BLOCK: usize = 1 << 17;
    let mut out = Vec::with_capacity(data.len() + 16 + data.len() / MAX_BLOCK * 3);
    out.extend_from_slice(&[0x28, 0xb5, 0x2f, 0xfd]);
    // Single-segment frame with the content size stated up front.
    let n = data.len() as u64;
    if n < 256 {
        out.push(0x20);
        out.push(n as u8);
    } else if n < 65_536 + 256 {
        out.push(0x60);
        out.extend_from_slice(&((n - 256) as u16).to_le_bytes());
    } else if n <= u32::MAX as u64 {
        out.push(0xa0);
        out.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        out.push(0xe0);
        out.extend_from_slice(&n.to_le_bytes());
    }
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00]); // one empty last block
        return out;
    }
    let mut chunks = data.chunks(MAX_BLOCK).peekable();
    while let Some(chunk) = chunks.next() {
        let last = chunks.peek().is_none() as u32;
        let header = ((chunk.len() as u32) << 3) | last; // block type 0 = raw
        out.extend_from_slice(&header.to_le_bytes()[..3]);
        out.extend_from_slice(chunk);
    }
    out
}

/// MD5 digest as lowercase hex (the preset header carries one).
pub fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
        11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4_294_967_296.0) as u32).collect();
    let mut state: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_le_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 16];
        for (i, word) in w.iter_mut().enumerate() {
            *word = u32::from_le_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        let [mut a, mut b, mut c, mut d] = state;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let x = a.wrapping_add(f).wrapping_add(k[i]).wrapping_add(w[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(x.rotate_left(S[i]));
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
    }
    state.iter().flat_map(|v| v.to_le_bytes()).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_known_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(md5_hex(b"The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
        // Crosses the one-block padding boundary.
        assert_eq!(
            md5_hex(b"12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
            "57edf4a22be3c955ac49da2e2107b67a"
        );
    }

    /// Minimal reader for frames made by `zstd_store`, to check the layout.
    fn unstore(frame: &[u8]) -> Vec<u8> {
        assert_eq!(&frame[..4], &[0x28, 0xb5, 0x2f, 0xfd]);
        let desc = frame[4];
        assert_eq!(desc & 0x20, 0x20, "single segment");
        let (size, mut i) = match desc >> 6 {
            0 => (frame[5] as usize, 6),
            1 => (u16::from_le_bytes([frame[5], frame[6]]) as usize + 256, 7),
            2 => (u32::from_le_bytes([frame[5], frame[6], frame[7], frame[8]]) as usize, 9),
            _ => panic!("unexpected size field"),
        };
        let mut out = Vec::new();
        loop {
            let h = u32::from_le_bytes([frame[i], frame[i + 1], frame[i + 2], 0]);
            i += 3;
            assert_eq!((h >> 1) & 3, 0, "raw block");
            let len = (h >> 3) as usize;
            out.extend_from_slice(&frame[i..i + len]);
            i += len;
            if h & 1 == 1 {
                break;
            }
        }
        assert_eq!(i, frame.len());
        assert_eq!(out.len(), size);
        out
    }

    #[test]
    fn zstd_store_roundtrip_at_size_boundaries() {
        for len in [0usize, 1, 255, 256, 257, 65_791, 65_792, 131_072, 131_073, 300_000] {
            let data: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
            assert_eq!(unstore(&zstd_store(&data)), data, "len {len}");
        }
    }
}
