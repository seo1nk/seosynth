// Colours for canvas drawing and inline styles, read from the CSS tokens so
// the stylesheet stays the single source of truth for both themes.

let cache = null;

function read() {
  const style = getComputedStyle(document.documentElement);
  const v = (name) => style.getPropertyValue(name).trim();
  return {
    paper: v('--paper'),
    map: v('--map'),
    well: v('--well'),
    ink: v('--ink'),
    muted: v('--muted'),
    faint: v('--faint'),
    rule: v('--rule'),
    sound: v('--sound'),
    mods: {},
    style,
  };
}

/** Current theme colours (hex strings). */
export function colors() {
  if (!cache) cache = read();
  return cache;
}

/** Line colour of a modulation source, by its key (lfo1, env2, macro3...). */
export function modColor(sourceKey) {
  const c = colors();
  if (!c.mods[sourceKey]) {
    const token = /^macro/.test(sourceKey)
      ? '--mod-macro'
      : /^(env|lfo)\d$/.test(sourceKey)
        ? `--mod-${sourceKey}`
        : '--mod-play';
    c.mods[sourceKey] = c.style.getPropertyValue(token).trim() || c.muted;
  }
  return c.mods[sourceKey];
}

export function alpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? [...h].map((ch) => ch + ch).join('') : h, 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

const KEY = 'seosynth.theme';

export function savedTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

/** 'auto' follows the system setting. Returns true if colours changed. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage may be unavailable */
  }
  cache = null;
}

/** Calls `fn` when the effective colours change with the system setting. */
export function onSystemThemeChange(fn) {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', () => {
    cache = null;
    fn();
  });
}
