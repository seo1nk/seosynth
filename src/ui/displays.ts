// Canvas displays: wavetable view, filter curve, envelope and LFO editors,
// and the small oscilloscopes that show the signal along the chain.

import { h, clamp, drag, setupCanvas } from './dom.ts';
import { colors, alpha, modColor } from '../theme.ts';
import { TAP_WINDOW } from '../engine/audio.ts';
import type { App, Live } from '../app.ts';
import type { EngineCore } from '../engine/core.ts';
import type { LfoPoint } from '../engine/types.ts';

type Draw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

export interface AutoCanvas {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  redraw: () => void;
  size: () => [number, number];
}

// Colours come from the theme at draw time so both themes work.
const ink = () => colors().ink;
const grid = () => alpha(colors().ink, 0.09);
const handleFill = () => colors().paper;

/**
 * A canvas that fills its container and redraws when asked or resized.
 * `draw(ctx, width, height)` works in CSS pixels.
 */
function autoCanvas(className: string, draw: Draw): AutoCanvas {
  const canvas = h('canvas', {});
  const el = h('div', { class: `display ${className}` }, canvas);
  let w = 0;
  let hgt = 0;
  let ctx: CanvasRenderingContext2D | null = null;
  const redraw = () => {
    if (!ctx || w < 4 || hgt < 4) return;
    ctx.clearRect(0, 0, w, hgt);
    draw(ctx, w, hgt);
  };
  new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    // Layout size, unaffected by any CSS zoom on an ancestor.
    w = Math.max(1, Math.round(el.clientWidth || r.width));
    hgt = Math.max(1, Math.round(el.clientHeight || r.height));
    ctx = setupCanvas(canvas, w, hgt);
    redraw();
  }).observe(el);
  return { el, canvas, redraw, size: () => [w, hgt] as [number, number] };
}

// ---------------------------------------------------------------------------
// Wavetable view
// ---------------------------------------------------------------------------

const WT_FRAMES = 14;
const WT_POINTS = 56;
const tableCache = new Map<number, Float32Array[]>();

function tableFrames(core: EngineCore, table: number): Float32Array[] {
  if (!tableCache.has(table)) {
    tableCache.set(
      table,
      Array.from({ length: WT_FRAMES }, (_, k) => core.previewTable(table, k / (WT_FRAMES - 1), WT_POINTS)),
    );
  }
  return tableCache.get(table) ?? [];
}

/** The wavetable as a stack of frames with the playing waveform on top. */
export function WavetableDisplay(app: App, name: string, color: string): HTMLElement {
  const { store, core, i18n } = app;
  const osc = Math.max(0, ['oscA', 'oscB', 'oscC'].indexOf(name));
  const iPos = store.idx(`${name}.pos`);
  const iAmt = store.idx(`${name}.warpAmt`);
  let dirty = true;
  let shown = [-1, -1];

  const view = autoCanvas('wt-display', (ctx, w, hgt) => {
    const pos = shown[0];
    const frames = tableFrames(core, store.tableOf(name));
    const depthX = w * 0.2;
    const depthY = hgt * 0.42;
    const fw = w - depthX - 10;
    const amp = (hgt - depthY) * 0.34;
    const origin = (t: number): [number, number] => [5 + depthX * t, hgt - 6 - amp - depthY * t];
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1;
    for (let k = WT_FRAMES - 1; k >= 0; k--) {
      const t = k / (WT_FRAMES - 1);
      const [ox, oy] = origin(t);
      const f = frames[k];
      ctx.beginPath();
      for (let j = 0; j < WT_POINTS; j++) {
        const x = ox + (fw * j) / (WT_POINTS - 1);
        const y = oy - f[j] * amp;
        if (j) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.strokeStyle = alpha(color, 0.16 + 0.22 * (1 - Math.abs(t - pos)));
      ctx.stroke();
    }
    // The waveform that is actually playing, including warp.
    const wave = core.previewOsc(osc, pos, shown[1], 160);
    const [ox, oy] = origin(pos);
    ctx.beginPath();
    for (let j = 0; j < wave.length; j++) {
      const x = ox + (fw * j) / (wave.length - 1);
      const y = oy - wave[j] * amp;
      if (j) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineTo(ox + fw, oy);
    ctx.lineTo(ox, oy);
    ctx.closePath();
    ctx.fillStyle = alpha(color, 0.12);
    ctx.fill();
  });

  // Anything that changes the picture: this oscillator's shape parameters,
  // and the other oscillator when it is used as an FM/AM/RM source.
  for (const p of store.params) {
    if (/^osc[AB]\.(wt|userTable|pos|warp|warpAmt|oct|semi|coarse|on)$/.test(p.key)) app.watch(p.i, () => (dirty = true));
  }
  app.on('patch', () => (dirty = true));
  // A user table that was drawn on: its picture is out of date.
  app.on('table', (slot) => {
    tableCache.delete(store.info.tables.length + slot);
    dirty = true;
  });
  app.onFrame((live) => {
    const pos = live.param(iPos);
    const amt = live.param(iAmt);
    if (dirty || Math.abs(pos - shown[0]) > 0.002 || Math.abs(amt - shown[1]) > 0.004) {
      shown = [pos, amt];
      dirty = false;
      view.redraw();
    }
  });

  let start = 0;
  drag(view.el, {
    cursor: 'ns-resize',
    onStart: () => {
      start = store.get(iPos);
    },
    onMove: (_dx, dy, e) => store.set(iPos, start - dy / (e.shiftKey ? 900 : 110)),
    onEnd: () => store.commit(),
  });
  app.help.attach(view.el, () => ({ title: i18n.paramTitle(`${name}.pos`), body: i18n.t('hint.wt') }));
  return view.el;
}

// ---------------------------------------------------------------------------
// Filter response
// ---------------------------------------------------------------------------

const F_MIN = 20;
const F_MAX = 20000;
const DB_TOP = 20;
const DB_BOTTOM = -44;

export function FilterDisplay(app: App, prefix: string, color: string): HTMLElement {
  const { store, core, i18n } = app;
  const iType = store.idx(`${prefix}.type`);
  const iCut = store.idx(`${prefix}.cutoff`);
  const iRes = store.idx(`${prefix}.res`);
  const iVar = store.idx(`${prefix}.var`);
  let dirty = true;
  let shown = [-1, -1, -1];

  const fx = (f: number, w: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
  const dy = (db: number, hgt: number) => ((DB_TOP - db) / (DB_TOP - DB_BOTTOM)) * hgt;

  const view = autoCanvas('filter-display', (ctx, w, hgt) => {
    ctx.strokeStyle = grid();
    ctx.lineWidth = 1;
    ctx.fillStyle = alpha(colors().muted, 0.9);
    ctx.font = '10px sans-serif';
    for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']] as const) {
      const x = Math.round(fx(f, w)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hgt);
      ctx.stroke();
      ctx.fillText(label, x + 3, hgt - 3);
    }
    const zero = Math.round(dy(0, hgt)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, zero);
    ctx.lineTo(w, zero);
    ctx.stroke();

    const type = Math.round(store.getPlain(iType));
    const cutoff = core.toPlain(iCut, shown[0]);
    const n = Math.max(32, Math.min(256, Math.round(w / 1.5)));
    const resp = core.filterResponse(type, cutoff, shown[1], shown[2], n);
    const hx = fx(cutoff, w);
    if (!resp) {
      // Not a classic filter: no curve to show, just mark the frequency.
      ctx.fillStyle = alpha(color, 0.7);
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(i18n.option(store.def(iType).options[type]), w / 2, hgt / 2 - 4);
      ctx.textAlign = 'left';
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(hx, hgt * 0.62);
      ctx.lineTo(hx, hgt);
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    let hy = zero;
    for (let k = 0; k < n; k++) {
      const x = (k / (n - 1)) * w;
      const y = clamp(dy(resp[k], hgt), -4, hgt + 4);
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      if (Math.abs(x - hx) <= w / n) hy = y;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineTo(w, hgt);
    ctx.lineTo(0, hgt);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, hgt);
    grad.addColorStop(0, alpha(color, 0.3));
    grad.addColorStop(1, alpha(color, 0.02));
    ctx.fillStyle = grad;
    ctx.fill();
    // Handle on the curve at the cutoff.
    ctx.beginPath();
    ctx.arc(clamp(hx, 5, w - 5), clamp(hy, 5, hgt - 5), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = handleFill();
    ctx.fill();
    ctx.strokeStyle = ink();
    ctx.lineWidth = 1.6;
    ctx.stroke();
  });

  for (const i of [iType, iCut, iRes, iVar]) app.watch(i, () => (dirty = true));
  app.on('patch', () => (dirty = true));
  let skip = false;
  app.onFrame((live) => {
    const now = [live.param(iCut), live.param(iRes), live.param(iVar)];
    const moved = now.some((v, k) => Math.abs(v - shown[k]) > 0.003);
    if (!dirty && !moved) return;
    // The curve is measured by the engine; half the frame rate is plenty.
    skip = !skip;
    if (skip && !dirty) return;
    shown = now;
    dirty = false;
    view.redraw();
  });

  let start = [0, 0];
  drag(view.el, {
    cursor: 'move',
    onStart: () => {
      start = [store.get(iCut), store.get(iRes)];
    },
    onMove: (dx, ddy) => {
      const [w, hgt] = view.size();
      store.set(iCut, start[0] + dx / w);
      store.set(iRes, start[1] - ddy / hgt);
    },
    onEnd: () => store.commit(),
  });
  app.help.attach(view.el, () => ({ title: i18n.paramTitle(`${prefix}.cutoff`), body: i18n.t('hint.filterDisplay') }));
  return view.el;
}

// ---------------------------------------------------------------------------
// Envelope editor
// ---------------------------------------------------------------------------

// Time is drawn compressed (t^0.4) so that a 5 ms attack and a 5 s release
// are both visible and draggable.
const tw = (t: number) => Math.pow(Math.max(t, 0), 0.4);
const twInv = (u: number) => Math.pow(Math.max(u, 0), 2.5);
const ENV_SUSTAIN_W = 0.55;
const ENV_MIN_TOTAL = 3.3;

/** Where the parts of the envelope are drawn, for a given size. */
export interface EnvGeometry {
  v: Record<string, number>;
  scale: number;
  y: (level: number) => number;
  x0: number;
  xA: number;
  xH: number;
  xD: number;
  xS: number;
  xR: number;
  top: number;
  bottom: number;
}

/** How long the playhead takes to cross the sustain plateau, in ms. */
const SUSTAIN_GLIDE_MS = 180;

/**
 * Where the playhead goes on the drawn envelope.
 *
 * `pos` is the engine's position: the stage (1 attack, 2 hold, 3 decay,
 * 4 sustain, 5 release) plus the progress through it. How far into a stage
 * the note is always comes from the engine; the height is read off the
 * drawn line at that point, so the dot stays on the line even when the
 * real level started elsewhere (a voice retriggered while still sounding,
 * or a key let go before the sustain was reached).
 *
 * While the key is held (sustain) the dot moves along the plateau to the
 * dashed line, `sustain` (0..1) of the way, and waits there: that is where
 * the release starts when the key is let go.
 */
export function envPlayhead(g: EnvGeometry, pos: number, sustain: number, curve: (t: number, c: number) => number): [number, number] | null {
  if (!(pos > 0)) return null;
  const stage = Math.floor(pos);
  const t = clamp(pos - stage);
  const { v } = g;
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  switch (stage) {
    case 1:
      return [lerp(g.x0, g.xA, t), g.y(curve(t, v.atkCurve))];
    case 2:
      return [lerp(g.xA, g.xH, t), g.top];
    case 3:
      return [lerp(g.xH, g.xD, t), g.y(1 + (v.sustain - 1) * curve(t, v.decCurve))];
    case 4:
      return [lerp(g.xD, g.xS, clamp(sustain)), g.y(v.sustain)];
    case 5:
      return [lerp(g.xS, g.xR, t), g.y(v.sustain * (1 - curve(t, v.relCurve)))];
    default:
      return null;
  }
}

export function EnvDisplay(app: App, e: number, color: string): HTMLElement {
  const { store, core, i18n } = app;
  const key = (p: string) => `env${e + 1}.${p}`;
  const idx = Object.fromEntries(
    ['attack', 'hold', 'decay', 'sustain', 'release', 'atkCurve', 'decCurve', 'relCurve'].map((p) => [p, store.idx(key(p))]),
  );
  const PAD = 7;
  let geo: EnvGeometry | null = null;
  let dirty = true;
  let playhead: [number, number] | null = null;

  function layout(w: number, hgt: number): EnvGeometry {
    const v = Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, store.getPlain(i)]));
    const u = { a: tw(v.attack), h: tw(v.hold), d: tw(v.decay), s: ENV_SUSTAIN_W, r: tw(v.release) };
    const total = u.a + u.h + u.d + u.s + u.r;
    const scale = (w - PAD * 2) / Math.max(total, ENV_MIN_TOTAL);
    const top = PAD;
    const bottom = hgt - PAD;
    const y = (level: number) => bottom - level * (bottom - top);
    const xA = PAD + u.a * scale;
    const xH = xA + u.h * scale;
    const xD = xH + u.d * scale;
    const xS = xD + u.s * scale;
    const xR = xS + u.r * scale;
    return { v, scale, y, x0: PAD, xA, xH, xD, xS, xR, top, bottom };
  }

  function segment(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, curve: number) {
    const n = Math.max(2, Math.round((x1 - x0) / 3));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      ctx.lineTo(x0 + (x1 - x0) * t, y0 + (y1 - y0) * core.curve(t, curve));
    }
  }

  const view = autoCanvas('env-display', (ctx, w, hgt) => {
    const g = (geo = layout(w, hgt));
    const { v } = g;
    ctx.beginPath();
    ctx.moveTo(g.x0, g.bottom);
    segment(ctx, g.x0, g.bottom, g.xA, g.top, v.atkCurve);
    ctx.lineTo(g.xH, g.top);
    segment(ctx, g.xH, g.top, g.xD, g.y(v.sustain), v.decCurve);
    ctx.lineTo(g.xS, g.y(v.sustain));
    segment(ctx, g.xS, g.y(v.sustain), g.xR, g.bottom, v.relCurve);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(g.x0, g.bottom);
    ctx.closePath();
    ctx.fillStyle = alpha(color, 0.13);
    ctx.fill();
    // "Key held" region marker.
    ctx.strokeStyle = grid();
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(g.xS + 0.5, g.top);
    ctx.lineTo(g.xS + 0.5, g.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of handles(g)) {
      ctx.beginPath();
      ctx.arc(x, y, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = handleFill();
      ctx.fill();
      ctx.strokeStyle = ink();
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    if (playhead) {
      ctx.beginPath();
      ctx.arc(playhead[0], playhead[1], 3.2, 0, Math.PI * 2);
      ctx.fillStyle = ink();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  });

  const handles = (g: EnvGeometry): [number, number][] => [
    [g.xA, g.top],
    [g.xD, g.y(g.v.sustain)],
    [g.xR, g.bottom],
  ];

  for (const i of Object.values(idx)) app.watch(i, () => (dirty = true));
  app.on('patch', () => (dirty = true));

  // When the current note reached its sustain, for the glide along the plateau.
  let sustainSince = 0;
  let lastStage = 0;
  app.onFrame((live) => {
    const pos = live.envPos(e);
    const stage = Math.floor(pos);
    const now = performance.now();
    if (stage === 4 && lastStage !== 4) sustainSince = now;
    lastStage = stage;
    const next = geo ? envPlayhead(geo, pos, (now - sustainSince) / SUSTAIN_GLIDE_MS, (t, c) => core.curve(t, c)) : null;
    const moved = next === null || playhead === null ? next !== playhead : Math.abs(next[0] - playhead[0]) > 0.3 || Math.abs(next[1] - playhead[1]) > 0.3;
    if (dirty || moved) {
      playhead = next;
      dirty = false;
      view.redraw();
    }
  });

  drag(view.el, {
    cursor: 'grabbing',
    onStart: (ev) => {
      if (!geo) return false;
      const r = view.el.getBoundingClientRect();
      const [w] = view.size();
      const zoom = r.width / w || 1;
      const px = (ev.clientX - r.left) / zoom;
      const py = (ev.clientY - r.top) / zoom;
      const hs = handles(geo);
      let best = -1;
      let bestD = 18;
      hs.forEach(([x, y], k) => {
        const d = Math.hypot(px - x, py - y);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      if (best < 0) return false;
      return { which: best, zoom, v: { ...geo.v }, scale: geo.scale, span: geo.bottom - geo.top };
    },
    onMove: (dx, ddy, _e, st) => {
      const du = dx / st.zoom / st.scale;
      if (st.which === 0) store.setPlain(idx.attack, twInv(tw(st.v.attack) + du));
      else if (st.which === 1) {
        store.setPlain(idx.decay, twInv(tw(st.v.decay) + du));
        store.setPlain(idx.sustain, clamp(st.v.sustain - ddy / st.zoom / st.span));
      } else store.setPlain(idx.release, twInv(tw(st.v.release) + du));
    },
    onEnd: () => store.commit(),
  });
  app.help.attach(view.el, () => ({ title: `ENV ${e + 1}`, body: i18n.t('hint.envDisplay') }));
  return view.el;
}

// ---------------------------------------------------------------------------
// LFO editor
// ---------------------------------------------------------------------------

/** Breakpoints approximating each preset shape, used when the user switches
 * to Custom so they start from what they were hearing. */
/** The built-in LFO shapes as drawable points: [x, y, curve]. */
export const LFO_SHAPE_POINTS: Record<string, [number, number, number][]> = {
  Sine: [[0, 0.5, 0.35], [0.25, 1, -0.35], [0.5, 0.5, 0.35], [0.75, 0, -0.35], [1, 0.5, 0]],
  Triangle: [[0, 0, 0], [0.5, 1, 0], [1, 0, 0]],
  SawUp: [[0, 0, 0], [1, 1, 0]],
  SawDown: [[0, 1, 0], [1, 0, 0]],
  Square: [[0, 1, 0], [0.5, 1, 0], [0.5, 0, 0], [1, 0, 0]],
  'S&H': [[0, 0.35, 0], [0.25, 0.35, 0], [0.25, 0.8, 0], [0.5, 0.8, 0], [0.5, 0.15, 0], [0.75, 0.15, 0], [0.75, 0.6, 0], [1, 0.6, 0]],
  Smooth: [[0, 0.35, 0], [0.25, 0.8, 0], [0.5, 0.15, 0], [0.75, 0.6, 0], [1, 0.35, 0]],
};

export function LfoDisplay(app: App, l: number): HTMLElement {
  const { store, core, i18n } = app;
  const color = modColor(`lfo${l + 1}`);
  const iShape = store.idx(`lfo${l + 1}.shape`);
  const shapeDef = store.def(iShape);
  const CUSTOM = shapeDef.options.indexOf('Custom');
  const PAD = 6;
  let dirty = true;
  let head: [number, number] | null = null;
  let points: LfoPoint[] = store.getLfoShape(l);

  const isCustom = () => Math.round(store.getPlain(iShape)) === CUSTOM;
  const px = (x: number, w: number) => PAD + x * (w - PAD * 2);
  const py = (y: number, hgt: number) => hgt - PAD - y * (hgt - PAD * 2);

  const view = autoCanvas('lfo-display', (ctx, w, hgt) => {
    ctx.strokeStyle = grid();
    ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      const x = Math.round(px(k / 4, w)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD);
      ctx.lineTo(x, hgt - PAD);
      ctx.stroke();
    }
    const n = Math.max(32, Math.round(w - PAD * 2));
    const shape = core.previewLfo(l, n);
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const x = px(k / (n - 1), w);
      const y = py(shape[k], hgt);
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(px(1, w), hgt - PAD);
    ctx.lineTo(px(0, w), hgt - PAD);
    ctx.closePath();
    ctx.fillStyle = alpha(color, 0.12);
    ctx.fill();
    if (isCustom()) {
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(px(p.x, w), py(p.y, hgt), 3.6, 0, Math.PI * 2);
        ctx.fillStyle = handleFill();
        ctx.fill();
        ctx.strokeStyle = ink();
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
    if (head) {
      const x = px(head[0], w);
      ctx.strokeStyle = alpha(color, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD);
      ctx.lineTo(x, hgt - PAD);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, py(head[1], hgt), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = ink();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  });

  const refresh = () => {
    points = store.getLfoShape(l);
    dirty = true;
  };
  app.watch(iShape, () => (dirty = true));
  app.on('lfo', (which) => which === l && refresh());
  app.on('patch', refresh);

  app.onFrame((live) => {
    const next: [number, number] | null = live.active ? [live.lfoPhase(l), live.lfoVal(l)] : null;
    const moved = next === null || head === null ? next !== head : Math.abs(next[0] - head[0]) > 0.002 || Math.abs(next[1] - head[1]) > 0.004;
    if (dirty || moved) {
      head = next;
      dirty = false;
      view.redraw();
    }
  });

  // --- drawing your own shape ------------------------------------------------
  const local = (ev: MouseEvent) => {
    const r = view.el.getBoundingClientRect();
    const [w, hgt] = view.size();
    const zoom = r.width / w || 1;
    const mx = (ev.clientX - r.left) / zoom;
    const my = (ev.clientY - r.top) / zoom;
    return { mx, my, w, hgt, x: clamp((mx - PAD) / (w - PAD * 2)), y: clamp((hgt - PAD - my) / (hgt - PAD * 2)) };
  };
  const hitPoint = (m: { mx: number; my: number; w: number; hgt: number }) => {
    let best = -1;
    let bestD = 12;
    points.forEach((p, k) => {
      const d = Math.hypot(m.mx - px(p.x, m.w), m.my - py(p.y, m.hgt));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  };
  const snap = (v: number, e: MouseEvent, div: number) => (e.shiftKey ? v : Math.round(v * div) / div);

  type LfoDrag = { mode: 'point'; k: number } | { mode: 'curve'; k: number; start: number; rising: boolean };
  drag<LfoDrag>(view.el, {
    cursor: 'grabbing',
    onStart: (ev) => {
      if (!isCustom()) return false;
      const m = local(ev);
      const k = hitPoint(m);
      if (k >= 0) return { mode: 'point', k };
      // Otherwise bend the segment under the pointer.
      const seg = points.findIndex((p, j) => j < points.length - 1 && m.x >= p.x && m.x <= points[j + 1].x);
      return seg >= 0 ? { mode: 'curve', k: seg, start: points[seg].curve, rising: points[seg + 1].y >= points[seg].y } : false;
    },
    onMove: (_dx, ddy, ev, st) => {
      const m = local(ev);
      const pts = points.map((p) => ({ ...p }));
      if (st.mode === 'point') {
        const first = st.k === 0;
        const last = st.k === pts.length - 1;
        const lo = first ? 0 : pts[st.k - 1].x;
        const hi = last ? 1 : pts[st.k + 1].x;
        pts[st.k].x = first ? 0 : last ? 1 : clamp(snap(m.x, ev, 16), lo, hi);
        pts[st.k].y = snap(m.y, ev, 8);
      } else {
        const dir = st.rising ? -1 : 1;
        pts[st.k].curve = clamp(st.start + (dir * ddy) / 60, -1, 1);
      }
      points = pts;
      store.setLfoShape(l, pts);
    },
    onEnd: () => store.commit(),
  });
  view.el.addEventListener('dblclick', (ev) => {
    if (!isCustom()) return;
    const m = local(ev);
    const k = hitPoint(m);
    const pts = points.map((p) => ({ ...p }));
    if (k > 0 && k < pts.length - 1) pts.splice(k, 1);
    else if (k < 0 && pts.length < store.info.maxLfoPoints) {
      const at = pts.findIndex((p) => p.x > m.x);
      pts.splice(at < 0 ? pts.length : at, 0, { x: snap(m.x, ev, 16), y: snap(m.y, ev, 8), curve: 0 });
    } else return;
    store.setLfoShape(l, pts);
    store.commit();
  });
  app.help.attach(view.el, () => ({ title: `LFO ${l + 1}`, body: i18n.t('hint.lfoDisplay') }));
  return view.el;
}

// ---------------------------------------------------------------------------
// Oscilloscopes along the signal chain
// ---------------------------------------------------------------------------

/**
 * All the little scopes share one time window per frame, locked to the pitch
 * of the newest note, so you can compare the same instant before and after
 * each module.
 */
interface Scope {
  index: number;
  color: string | null;
  view: AutoCanvas;
}

export class ScopeBank {
  readonly app: App;
  scopes: Scope[];
  readonly levels: Float32Array;
  pitch: number;
  readonly lp: Float32Array;
  /** [first sample, length] of the time window all scopes show. */
  window: [number, number];
  taps: Float32Array | null = null;

  constructor(app: App) {
    this.app = app;
    this.scopes = [];
    this.levels = new Float32Array(app.core.info.tap.count);
    this.pitch = 60;
    this.lp = new Float32Array(TAP_WINDOW);
    this.window = [TAP_WINDOW - 256, 256];
  }

  /** Adds a scope for tap `index`. Returns its element. The scope is
   * dropped again when the part of the UI that created it is disposed. */
  add(index: number, className = 'mini-scope', color: string | null = null): HTMLElement {
    const view: AutoCanvas = autoCanvas(className, (ctx, w, hgt) => this.#draw(ctx, w, hgt, scope));
    const scope: Scope = { index, color, view };
    this.scopes.push(scope);
    this.app.onDispose(() => {
      this.scopes = this.scopes.filter((sc) => sc !== scope);
    });
    return view.el;
  }

  /** Makes the scope shown in `el` follow another tap. */
  point(el: HTMLElement, index: number): void {
    const scope = this.scopes.find((sc) => sc.view.el === el);
    if (scope) scope.index = index;
  }

  /** Signal level (0..1) at a tap, for cable brightness. */
  level(index: number): number {
    return this.levels[index];
  }

  update(live: Live, taps: Float32Array | null): void {
    if (!taps) return;
    this.taps = taps;
    const info = this.app.core.info.tap;
    if (live.note >= 0) this.pitch = live.pitch;
    const sr = this.app.audio.sampleRate;
    const period = sr / (440 * Math.pow(2, (this.pitch - 69) / 12));
    const span = Math.round(clamp(period * 2, 96, 720));
    let start = TAP_WINDOW - span;

    // Find a stable trigger: low-pass the reference down to roughly its
    // fundamental so there is one upward zero crossing per cycle.
    // Everything the sources make, whichever way it goes.
    const refIndex = info.preAmp;
    const ref = taps.subarray(refIndex * TAP_WINDOW, (refIndex + 1) * TAP_WINDOW);
    const a = Math.min(1, (2 * Math.PI) / period);
    let z1 = 0;
    let z2 = 0;
    for (let k = 0; k < TAP_WINDOW; k++) {
      z1 += a * (ref[k] - z1);
      z2 += a * (z1 - z2);
      this.lp[k] = z2;
    }
    const hi = TAP_WINDOW - span - 1;
    const lo = Math.max(1, Math.floor(hi - period - 2));
    for (let k = hi; k >= lo; k--) {
      if (this.lp[k - 1] < 0 && this.lp[k] >= 0) {
        start = k;
        break;
      }
    }
    this.window = [start, span];

    for (let t = 0; t < info.count; t++) {
      let peak = 0;
      const base = t * TAP_WINDOW;
      for (let k = TAP_WINDOW - 256; k < TAP_WINDOW; k += 2) peak = Math.max(peak, Math.abs(taps[base + k]));
      // Fast attack, slow decay so the glow does not flicker.
      this.levels[t] = Math.max(peak, this.levels[t] * 0.9);
    }
    for (const sc of this.scopes) sc.view.redraw();
  }

  #draw(ctx: CanvasRenderingContext2D, w: number, hgt: number, scope: Scope) {
    const mid = hgt / 2;
    ctx.strokeStyle = alpha(colors().ink, 0.14);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();
    if (!this.taps) return;
    const [start, span] = this.window;
    const base = scope.index * TAP_WINDOW + start;
    // Auto-gain per scope: the shape matters here, loudness is shown by the
    // cable glow and the meters.
    let peak = 0.02;
    for (let k = 0; k < span; k++) peak = Math.max(peak, Math.abs(this.taps[base + k]));
    const gain = (mid - 2) / Math.max(peak, 0.05);
    if (this.levels[scope.index] < 0.003) return;
    ctx.beginPath();
    const n = Math.min(span, Math.round(w * 1.5));
    for (let j = 0; j < n; j++) {
      const k = Math.min(span - 1, Math.round((j / (n - 1)) * (span - 1)));
      const x = (j / (n - 1)) * w;
      const y = mid - this.taps[base + k] * gain;
      if (j) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = scope.color ?? colors().sound;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** Spectrum of the final output (log frequency axis). */
export function SpectrumDisplay(app: App): HTMLElement {
  let data: Uint8Array<ArrayBuffer> | null = null;
  const view = autoCanvas('spectrum', (ctx, w, hgt) => {
    const analyser = app.audio.analyser;
    if (!analyser) return;
    if (!data || data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const nyquist = app.audio.sampleRate / 2;
    const bars = Math.max(16, Math.floor(w / 3));
    ctx.fillStyle = alpha(colors().sound, 0.8);
    for (let b = 0; b < bars; b++) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, b / bars);
      const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / bars);
      const k0 = Math.floor((f0 / nyquist) * data.length);
      const k1 = Math.max(k0 + 1, Math.ceil((f1 / nyquist) * data.length));
      let peak = 0;
      for (let k = k0; k < k1 && k < data.length; k++) peak = Math.max(peak, data[k]);
      const bh = (peak / 255) * hgt;
      ctx.fillRect((b / bars) * w, hgt - bh, Math.max(1, w / bars - 1), bh);
    }
  });
  let tick = 0;
  app.onFrame(() => {
    // 30 fps is enough for a spectrum.
    if (++tick % 2 === 0 && app.audio.running) view.redraw();
  });
  return view.el;
}

/** Stereo peak meter. */
export function Meter(app: App): HTMLElement {
  const bars = [h('div', { class: 'meter-bar' }), h('div', { class: 'meter-bar' })];
  const el = h('div', { class: 'meter', role: 'img', 'aria-label': 'Level' }, bars.map((b) => h('div', { class: 'meter-track' }, b)));
  const held = [0, 0];
  app.onFrame((live) => {
    [live.peakL, live.peakR].forEach((p, k) => {
      held[k] = Math.max(p, held[k] * 0.93);
      // -48 dB .. 0 dB across the bar.
      const db = 20 * Math.log10(Math.max(held[k], 1e-4));
      bars[k].style.transform = `scaleX(${clamp((db + 48) / 48)})`;
      bars[k].classList.toggle('hot', held[k] > 0.92);
    });
  });
  return el;
}
