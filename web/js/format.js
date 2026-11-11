// Turns parameter values into the text shown under knobs.

const trim = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/**
 * @param {object} p      parameter description from the engine
 * @param {number} plain  value in real units
 * @param {(key: string) => string} [label]  translator for option names
 */
export function formatValue(p, plain, label = (k) => k) {
  switch (p.curve) {
    case 'bool':
      return plain >= 0.5 ? 'ON' : 'OFF';
    case 'enum':
      return label(p.options[Math.round(plain)] ?? '');
    default:
  }
  const v = plain;
  switch (p.unit) {
    case '%':
      return `${Math.round(v * 100)}%`;
    case 'Hz':
      if (v >= 1000) return `${trim((v / 1000).toFixed(v >= 10000 ? 1 : 2))} kHz`;
      return `${trim(v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0))} Hz`;
    case 's':
      if (v < 0.0005) return '0 ms';
      if (v < 1) return `${trim((v * 1000).toFixed(v < 0.01 ? 1 : 0))} ms`;
      return `${trim(v.toFixed(2))} s`;
    case 'ms':
      return `${trim(v.toFixed(v < 10 ? 1 : 0))} ms`;
    case 'dB':
      return `${v > 0 ? '+' : ''}${trim(v.toFixed(1))} dB`;
    case 'st':
      return `${v > 0 ? '+' : ''}${p.curve === 'int' ? Math.round(v) : trim(v.toFixed(1))} st`;
    case 'ct':
      return `${v > 0 ? '+' : ''}${Math.round(v)} ct`;
    case 'oct':
      return `${v > 0 ? '+' : ''}${Math.round(v)}`;
    case 'pan': {
      const n = Math.round(v * 100);
      return n === 0 ? 'C' : n < 0 ? `L${-n}` : `R${n}`;
    }
    case 'ab': {
      // Balance between the two lanes of the fork: which way the slider
      // leans, since the lanes have different names in each mode.
      const n = Math.round((v - 0.5) * 200);
      return n === 0 ? '0' : n < 0 ? `← ${-n}` : `${n} →`;
    }
    case 'curve':
      return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
    case 'x':
      return `${trim(v.toFixed(1))}:1`;
    case 'bpm':
      return `${Math.round(v)}`;
    default:
      return p.curve === 'int' ? String(Math.round(v)) : trim(v.toFixed(2));
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(note) {
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}
