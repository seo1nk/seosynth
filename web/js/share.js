// Share URLs: the whole patch travels in the URL fragment, so nothing is
// stored on a server and a link keeps working as long as the page exists.
//
//   https://example.com/seosynth/#p=<base64url of the binary patch>

export function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function patchToHash(bytes) {
  return '#p=' + toBase64Url(bytes);
}

/** Extracts patch bytes from a URL fragment, or null if there are none. */
export function hashToPatch(hash) {
  const m = /^#?(?:.*&)?p=([^&]*)/.exec(hash || '');
  return m ? fromBase64Url(m[1]) : null;
}

export function shareUrl(bytes, base = location.href) {
  const url = new URL(base);
  url.hash = patchToHash(bytes);
  return url.toString();
}
