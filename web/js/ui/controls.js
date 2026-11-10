// Basic controls bound to engine parameters: knob, switch, menu.

import { h, s, clamp, drag } from './dom.js';
import { formatValue } from '../format.js';

/** Colour of each modulation source, indexed like `info.sources`. */
export const SOURCE_COLORS = [
  '#888888', // none
  '#fb7185', '#fb923c', '#facc15', // env 1-3
  '#4ade80', '#2dd4bf', '#60a5fa', '#e879f9', // lfo 1-4
  '#cbd5e1', '#cbd5e1', '#cbd5e1', '#cbd5e1', '#cbd5e1', // velocity, note, wheel, aftertouch, bend
  '#f472b6', '#f472b6', '#f472b6', '#f472b6', // macros
  '#cbd5e1', // random
];

const START = 135; // degrees, knob minimum (7:30 on a clock face)
const SWEEP = 270;

function polar(cx, cy, r, norm) {
  const a = ((START + SWEEP * norm) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx, cy, r, from, to) {
  const a = clamp(Math.min(from, to));
  const b = clamp(Math.max(from, to));
  if (b - a < 0.002) return '';
  const [x0, y0] = polar(cx, cy, r, a);
  const [x1, y1] = polar(cx, cy, r, b);
  const large = (b - a) * SWEEP > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Number of discrete positions of a parameter, or 0 if continuous. */
function steps(p) {
  if (p.curve === 'int' || p.curve === 'enum') return Math.round(p.max - p.min);
  return p.curve === 'bool' ? 1 : 0;
}

/**
 * Rotary knob for a continuous or integer parameter.
 * Drag up/down, wheel, arrow keys; double-click resets; Shift is fine.
 * Shows modulation: a coloured arc per routing and a dot at the live value.
 */
export function Knob(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const p = store.def(i);
  const n = steps(p);
  const quant = (v) => (n ? Math.round(clamp(v) * n) / n : clamp(v));
  const C = 22;
  const R = 15;
  // Parameters that are centred on zero fill from the middle.
  const origin = p.min < 0 && p.max > 0 ? store.core.toNorm(i, 0) : 0;

  const valueArc = s('path', { class: 'knob-value' });
  const modArcs = s('g', {});
  const pointer = s('line', { class: 'knob-pointer' });
  const liveDot = s('circle', { class: 'knob-live', r: 2.2, visibility: 'hidden' });
  const svg = s(
    'svg',
    { viewBox: '0 0 44 44', class: 'knob-dial' },
    s('path', { class: 'knob-track', d: arc(C, C, R, 0, 1) }),
    valueArc,
    modArcs,
    s('circle', { class: 'knob-cap', cx: C, cy: C, r: 10.5 }),
    pointer,
    liveDot,
  );
  const valueEl = h('div', { class: 'knob-val' });
  const badges = h('div', { class: 'knob-mods' });
  const el = h(
    'div',
    {
      class: `knob ${opts.class ?? ''}`,
      tabindex: 0,
      role: 'slider',
      'aria-label': i18n.paramTitle(key),
      dataset: { param: i, key, ...(p.mod ? { mod: '1' } : {}) },
    },
    h('div', { class: 'knob-wrap' }, svg, badges),
    h('div', { class: 'knob-label' }, opts.label ?? i18n.paramLabel(key)),
    valueEl,
  );
  if (opts.color) el.style.setProperty('--accent', opts.color);

  let mods = [];

  function drawMods(norm) {
    modArcs.replaceChildren(
      ...mods.slice(0, 3).map((m, k) => {
        const r = R + 3.5 + k * 2.6;
        const from = m.bipolar ? norm - Math.abs(m.amount) : norm;
        const to = m.bipolar ? norm + Math.abs(m.amount) : norm + m.amount;
        return s('path', { class: 'knob-mod', d: arc(C, C, r, from, to), stroke: SOURCE_COLORS[m.src] });
      }),
    );
  }

  function render(norm) {
    valueArc.setAttribute('d', arc(C, C, R, origin, norm));
    const [x0, y0] = polar(C, C, 4, norm);
    const [x1, y1] = polar(C, C, 10, norm);
    pointer.setAttribute('x1', x0);
    pointer.setAttribute('y1', y0);
    pointer.setAttribute('x2', x1);
    pointer.setAttribute('y2', y1);
    const text = formatValue(p, store.core.toPlain(i, norm), i18n.option);
    valueEl.textContent = text;
    el.setAttribute('aria-valuetext', text);
    drawMods(norm);
  }

  let signature = '';
  function renderMods() {
    mods = store.modsFor(i);
    el.classList.toggle('has-mod', mods.length > 0);
    liveDot.setAttribute('visibility', mods.length ? 'visible' : 'hidden');
    // Rebuild the badges only when the set of routings changes: an amount
    // change must not replace a badge that is being dragged.
    const sig = mods.map((m) => `${m.index}:${m.src}`).join();
    if (sig !== signature) {
      signature = sig;
      badges.replaceChildren(...mods.map((m) => app.mods.badge(m.index)));
    }
    drawMods(store.get(i));
  }

  store.watch(i, render);
  render(store.get(i));
  if (p.mod) {
    app.onSlots(renderMods);
    renderMods();
    // Live value from the audio thread, drawn only while modulated.
    app.onFrame((live) => {
      if (!mods.length || !live) return;
      const [x, y] = polar(C, C, R + 3.5, clamp(live.param(i)));
      liveDot.setAttribute('cx', x);
      liveDot.setAttribute('cy', y);
    });
  }

  let startNorm = 0;
  drag(svg, {
    cursor: 'ns-resize',
    onStart: () => {
      startNorm = store.get(i);
      el.classList.add('dragging');
      el.focus({ preventScroll: true });
    },
    onMove: (_dx, dy, e) => {
      const range = e.shiftKey ? 1600 : 180;
      store.set(i, quant(startNorm - dy / range));
    },
    onEnd: () => {
      el.classList.remove('dragging');
      store.commit();
    },
  });
  svg.addEventListener('dblclick', () => {
    store.reset(i);
    store.commit();
  });
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const step = n ? 1 / n : e.shiftKey ? 0.002 : 0.02;
      store.set(i, quant(store.get(i) - Math.sign(e.deltaY) * step));
      app.commitSoon();
    },
    { passive: false },
  );
  el.addEventListener('keydown', (e) => {
    const step = n ? 1 / n : e.shiftKey ? 0.002 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') store.set(i, quant(store.get(i) + step));
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') store.set(i, quant(store.get(i) - step));
    else if (e.key === 'Delete' || e.key === 'Backspace') store.reset(i);
    else return;
    e.preventDefault();
    app.commitSoon();
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    app.mods.knobMenu(i, el);
  });
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.paramHelp(key), value: valueEl.textContent }));
  return el;
}

/** On/off switch. `power: true` draws a round power button. */
export function Toggle(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const label = opts.label ?? i18n.paramLabel(key);
  const el = h(
    'button',
    {
      class: `toggle ${opts.power ? 'power' : ''} ${opts.class ?? ''}`,
      type: 'button',
      title: opts.power ? label : null,
      'aria-label': i18n.paramTitle(key),
      dataset: { param: i, key },
      onclick: () => {
        store.set(i, store.get(i) >= 0.5 ? 0 : 1);
        store.commit();
      },
    },
    opts.power ? s('svg', { viewBox: '0 0 16 16' }, s('path', { d: 'M8 2v6M4.6 4.4a5 5 0 1 0 6.8 0' })) : label,
  );
  const render = (v) => {
    el.classList.toggle('on', v >= 0.5);
    el.setAttribute('aria-pressed', v >= 0.5);
  };
  store.watch(i, render);
  render(store.get(i));
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.paramHelp(key), value: store.get(i) >= 0.5 ? 'ON' : 'OFF' }));
  return el;
}

/** Drop-down for an enum parameter. `groups` optionally organises the
 * options: [[groupLabel, [optionName, ...]], ...]. */
export function Select(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const p = store.def(i);
  const option = (name) => h('option', { value: p.options.indexOf(name) }, (opts.optionLabel ?? i18n.option)(name));
  const select = h(
    'select',
    {
      'aria-label': i18n.paramTitle(key),
      onchange: () => {
        const prev = Math.round(store.getPlain(i));
        const next = Number(select.value);
        store.setPlain(i, next);
        opts.onUserChange?.(prev, next);
        store.commit();
      },
    },
    opts.groups
      ? opts.groups.map(([label, names]) => h('optgroup', { label }, names.map(option)))
      : p.options.map(option),
  );
  const step = (d) => {
    const count = p.options.length;
    const prev = Math.round(store.getPlain(i));
    const next = (prev + d + count) % count;
    store.setPlain(i, next);
    opts.onUserChange?.(prev, next);
    store.commit();
  };
  const el = h(
    'div',
    { class: `select ${opts.class ?? ''}`, dataset: { param: i, key } },
    opts.label === false ? null : h('span', { class: 'select-label' }, opts.label ?? i18n.paramLabel(key)),
    h(
      'div',
      { class: 'select-row' },
      opts.arrows ? h('button', { type: 'button', class: 'step', 'aria-label': '◀', onclick: () => step(-1) }, '‹') : null,
      select,
      opts.arrows ? h('button', { type: 'button', class: 'step', 'aria-label': '▶', onclick: () => step(1) }, '›') : null,
    ),
  );
  const render = () => {
    select.value = String(Math.round(store.getPlain(i)));
  };
  store.watch(i, render);
  render();
  app.help.attach(el, () => ({
    title: i18n.paramTitle(key),
    body: i18n.paramHelp(key),
    value: i18n.option(p.options[Math.round(store.getPlain(i))]),
  }));
  return el;
}

/** Row of buttons for an enum with few options. */
export function Segmented(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const p = store.def(i);
  const buttons = p.options.map((name, k) =>
    h(
      'button',
      {
        type: 'button',
        onclick: () => {
          store.setPlain(i, k);
          store.commit();
        },
      },
      (opts.optionLabel ?? i18n.option)(name),
    ),
  );
  const el = h('div', { class: `segmented ${opts.class ?? ''}`, role: 'group', 'aria-label': i18n.paramTitle(key), dataset: { param: i, key } }, buttons);
  const render = () => {
    const cur = Math.round(store.getPlain(i));
    buttons.forEach((b, k) => b.classList.toggle('on', k === cur));
  };
  store.watch(i, render);
  render();
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.paramHelp(key) }));
  return el;
}
