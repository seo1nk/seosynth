// Share URLs: the whole patch travels in the URL fragment, so nothing is
// stored on a server and a link keeps working as long as the page exists.
//
//   https://example.com/seosynth/#p=<base64url of the binary patch>
//   https://example.com/seosynth/#z=<base64url of the patch, deflated>
//
// The compressed form is used when it is shorter: sounds with a wavetable of
// their own shrink to about half, while small patches stay as they are.
// Links of either form open.

/** Patches are far smaller than this; anything that inflates past it is junk. */
const MAX_PATCH = 256 * 1024;

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates, giving up (null) on broken data or beyond `MAX_PATCH` bytes. */
async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PATCH) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  } catch {
    return null;
  }
}

/** The plain form of a patch for a URL fragment. */
export function patchToHash(bytes: Uint8Array): string {
  return '#p=' + toBase64Url(bytes);
}

/** The shortest form of a patch for a URL fragment: plain or compressed. */
export async function encodeHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const plain = patchToHash(bytes);
  if (!canCompress()) return plain;
  const compressed = '#z=' + toBase64Url(await deflate(bytes));
  return compressed.length < plain.length ? compressed : plain;
}

/** The patch in a URL fragment of either form, or null if there is none. */
export async function decodeHash(hash: string | null | undefined): Promise<Uint8Array | null> {
  const m = /^#?(?:.*&)?([pz])=([^&]*)/.exec(hash || '');
  if (!m) return null;
  const bytes = fromBase64Url(m[2]);
  if (!bytes || m[1] === 'p') return bytes;
  return canCompress() ? inflate(bytes as Uint8Array<ArrayBuffer>) : null;
}

export async function shareUrl(bytes: Uint8Array<ArrayBuffer>, base: string = location.href): Promise<string> {
  const url = new URL(base);
  url.hash = await encodeHash(bytes);
  return url.toString();
}
