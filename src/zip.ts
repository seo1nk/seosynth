// Minimal ZIP writer (stored, no compression) for bundling an export.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  name: string;
  data: Uint8Array | string;
}

interface Entry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** Packs `files` into a ZIP archive. */
export function zip(files: ZipFile[], date = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const entries: Entry[] = files.map((f) => {
    const data = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
    return { name: encoder.encode(f.name), data, crc: crc32(data), offset: 0 };
  });

  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  // Shared part of the local and central headers: version, flags (UTF-8
  // names), method 0 = stored, time, date, crc, sizes, name length.
  const common = (e: Entry) => {
    const b = new DataView(new ArrayBuffer(26));
    b.setUint16(0, 20, true);
    b.setUint16(2, 0x0800, true);
    b.setUint16(4, 0, true);
    b.setUint16(6, time, true);
    b.setUint16(8, day, true);
    b.setUint32(10, e.crc, true);
    b.setUint32(14, e.data.length, true);
    b.setUint32(18, e.data.length, true);
    b.setUint16(22, e.name.length, true);
    b.setUint16(24, 0, true);
    return new Uint8Array(b.buffer);
  };
  for (const e of entries) {
    e.offset = offset;
    push(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    push(common(e));
    push(e.name);
    push(e.data);
  }
  const directoryStart = offset;
  for (const e of entries) {
    push(Uint8Array.from([0x50, 0x4b, 0x01, 0x02, 20, 0]));
    push(common(e));
    const tail = new DataView(new ArrayBuffer(14));
    tail.setUint32(10, e.offset, true);
    push(new Uint8Array(tail.buffer));
    push(e.name);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - directoryStart, true);
  end.setUint32(16, directoryStart, true);
  push(new Uint8Array(end.buffer));

  const out = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
