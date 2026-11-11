// Controls bound to engine parameters: slider, stepper, switch, menu.

import { h, clamp, drag } from './dom.js';
import { formatValue } from '../format.js';
import { modColor } from '../theme.js';

/** Number of discrete positions of a parameter, or 0 if continuous. */
function steps(p) {
  if (p.curve === 'int' || p.curve === 'enum') return Math.round(p.max - p.min);
  return p.curve === 'bool' ? 1 : 0;
}

const pct = (v) => `${(clamp(v) * 100).toFixed(2)}%`;

/**
 * Horizontal slider for a continuous or integer parameter.
 *
 * Left is less, right is more. Click the track to jump, drag to adjust,
 * arrow keys step, double-click resets, Shift is fine. When something
 * modulates the parameter, a coloured bar under the track shows how far it
 * is moved and a dot shows where the value is right now.
 */
export function Slider(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const p = store.def(i);
  const n = steps(p);
  const quant = (v) => (n ? Math.round(clamp(v) * n) / n : clamp(v));
  // Parameters centred on zero fill from the middle.
  const origin = p.min < 0 && p.max > 0 ? store.core.toNorm(i, 0) : 0;
  const label = opts.label ?? i18n.paramLabel(key);
  const sub = opts.sub ?? i18n.paramSub(key);

  const fill = h('div', { class: 'track-fill' });
  const ranges = h('div', { class: 'track-ranges' });
  const live = h('div', { class: 'track-live', hidden: true });
  const thumb = h('div', { class: 'thumb' });
  const track = h('div', { class: 'track' }, h('div', { class: 'track-rail' }, fill), ranges, live, thumb);
  const valueEl = h('button', { type: 'button', class: 'ctl-value', tabindex: -1, title: i18n.t('menu.enter') });
  const slot = h('div', { class: 'mod-slot' });
  const el = h(
    'div',
    {
      class: `ctl slider ${opts.class ?? ''}`,
      tabindex: 0,
      role: 'slider',
      'aria-label': i18n.paramTitle(key),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      dataset: { param: i, key, ...(p.mod && !opts.noMod ? { mod: '1' } : {}) },
    },
    opts.bare ? null : h('div', { class: 'ctl-head' }, h('span', { class: 'ctl-label' }, label, sub ? h('small', {}, sub) : null), valueEl),
    h('div', { class: 'ctl-row' }, track, p.mod && !opts.noMod ? slot : null),
  );

  let mods = [];
  const drawRanges = (norm) => {
    ranges.replaceChildren(
      ...mods.slice(0, 3).map((m) => {
        const a = clamp(m.bipolar ? norm - Math.abs(m.amount) : Math.min(norm, norm + m.amount));
        const b = clamp(m.bipolar ? norm + Math.abs(m.amount) : Math.max(norm, norm + m.amount));
        return h('span', { style: { left: pct(a), width: pct(b - a), background: modColor(store.info.sources[m.src]) } });
      }),
    );
  };

  const render = (norm) => {
    const a = Math.min(origin, norm);
    const b = Math.max(origin, norm);
    fill.style.left = pct(a);
    fill.style.width = pct(b - a);
    thumb.style.left = pct(norm);
    const text = formatValue(p, store.core.toPlain(i, norm), i18n.option);
    valueEl.textContent = text;
    el.setAttribute('aria-valuenow', Math.round(norm * 100));
    el.setAttribute('aria-valuetext', text);
    drawRanges(norm);
  };
  app.watch(i, render);
  render(store.get(i));

  if (p.mod && !opts.noMod) {
    const add = h(
      'button',
      { type: 'button', class: 'mod-add', title: i18n.t('mod.add'), 'aria-label': `${i18n.paramTitle(key)}: ${i18n.t('mod.add')}`, onclick: () => app.mods.controlMenu(i, add) },
      '＋',
    );
    let signature = null;
    const renderMods = () => {
      mods = store.modsFor(i);
      el.classList.toggle('has-mod', mods.length > 0);
      live.hidden = mods.length === 0;
      // Rebuild the badges only when the set of routings changes.
      const sig = mods.map((m) => `${m.index}:${m.src}`).join();
      if (sig !== signature) {
        signature = sig;
        slot.replaceChildren(...mods.map((m) => app.mods.badge(m.index)), add);
        if (mods.length) live.style.background = modColor(store.info.sources[mods[0].src]);
      }
      drawRanges(store.get(i));
    };
    app.on('slots', renderMods);
    renderMods();
    let shown = -1;
    app.onFrame((liveState) => {
      if (!mods.length) return;
      const v = clamp(liveState.param(i));
      if (Math.abs(v - shown) > 0.002) {
        shown = v;
        live.style.left = pct(v);
      }
    });
  }

  // Dragging is relative, so grabbing the thumb never makes the value jump;
  // a plain click on the track moves the value there.
  drag(track, {
    onStart: (e) => {
      el.focus({ preventScroll: true });
      el.classList.add('dragging');
      const r = track.getBoundingClientRect();
      const at = clamp((e.clientX - r.left) / r.width);
      const onThumb = Math.abs(at - store.get(i)) * r.width < 12;
      if (!onThumb) store.set(i, quant(at));
      return { start: store.get(i), width: r.width };
    },
    onMove: (dx, _dy, e, st) => store.set(i, quant(st.start + dx / (st.width * (e.shiftKey ? 8 : 1)))),
    onEnd: () => {
      el.classList.remove('dragging');
      store.commit();
    },
  });
  track.addEventListener('dblclick', () => {
    store.reset(i);
    store.commit();
  });
  valueEl.addEventListener('click', () => app.mods.enterValue(i));
  el.addEventListener('keydown', (e) => {
    const step = n ? 1 / n : e.shiftKey ? 0.002 : 0.02;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') store.set(i, quant(store.get(i) + step));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') store.set(i, quant(store.get(i) - step));
    else if (e.key === 'Delete' || e.key === 'Backspace') store.reset(i);
    else return;
    e.preventDefault();
    app.commitSoon();
  });
  el.addEventListener('contextmenu', (e) => {
    if (!p.mod || opts.noMod) return;
    e.preventDefault();
    app.mods.controlMenu(i, slot);
  });
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.paramHelp(key), value: valueEl.textContent }));
  return el;
}

/** Minus / plus buttons around a value, for small whole-number ranges. */
export function Stepper(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const p = store.def(i);
  const valueEl = h('output', { class: 'stepper-value' });
  const bump = (d) => {
    store.setPlain(i, clamp(Math.round(store.getPlain(i)) + d, p.min, p.max));
    store.commit();
  };
  const minus = h('button', { type: 'button', 'aria-label': '−', onclick: () => bump(-1) }, '−');
  const plus = h('button', { type: 'button', 'aria-label': '+', onclick: () => bump(1) }, '＋');
  const el = h(
    'div',
    { class: `ctl stepper ${opts.class ?? ''}`, dataset: { param: i, key } },
    h('span', { class: 'ctl-label' }, opts.label ?? i18n.paramLabel(key)),
    h('div', { class: 'stepper-row', role: 'group', 'aria-label': i18n.paramTitle(key) }, minus, valueEl, plus),
  );
  const render = () => {
    const v = Math.round(store.getPlain(i));
    valueEl.textContent = formatValue(p, v, i18n.option);
    minus.disabled = v <= p.min;
    plus.disabled = v >= p.max;
  };
  app.watch(i, render);
  render();
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.paramHelp(key), value: valueEl.textContent }));
  return el;
}

/** On/off switch with its label. */
export function Switch(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const label = opts.label ?? i18n.paramLabel(key);
  const el = h(
    'button',
    {
      type: 'button',
      class: `switch ${opts.class ?? ''}`,
      role: 'switch',
      dataset: { param: i, key },
      onclick: () => {
        const on = store.get(i) < 0.5;
        // `onToggle` lets a caller do more than flip the value.
        if (opts.onToggle) opts.onToggle(on);
        else store.set(i, on ? 1 : 0);
        store.commit();
      },
    },
    h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })),
    opts.hideLabel ? null : h('span', { class: 'switch-label' }, label),
  );
  if (opts.hideLabel) el.setAttribute('aria-label', label);
  const render = (v) => el.setAttribute('aria-checked', String(v >= 0.5));
  app.watch(i, render);
  render(store.get(i));
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.paramHelp(key) }));
  return el;
}

/** Drop-down for an enum parameter. `groups` optionally organises the
 * options: [[groupLabel, [optionName, ...]], ...]. */
export function Select(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const p = store.def(i);
  const option = (name) => h('option', { value: p.options.indexOf(name) }, (opts.optionLabel ?? i18n.option)(name));
  const change = (next) => {
    const prev = Math.round(store.getPlain(i));
    store.setPlain(i, next);
    opts.onUserChange?.(prev, next);
    store.commit();
  };
  const select = h(
    'select',
    { 'aria-label': i18n.paramTitle(key), onchange: () => change(Number(select.value)) },
    opts.groups ? opts.groups.map(([label, names]) => h('optgroup', { label }, names.map(option))) : p.options.map(option),
  );
  const step = (d) => change((Math.round(store.getPlain(i)) + d + p.options.length) % p.options.length);
  const el = h(
    'div',
    { class: `ctl select ${opts.class ?? ''}`, dataset: { param: i, key } },
    opts.label === false ? null : h('span', { class: 'ctl-label' }, opts.label ?? i18n.paramLabel(key)),
    h(
      'div',
      { class: 'select-row' },
      opts.arrows ? h('button', { type: 'button', class: 'step', 'aria-label': i18n.t('btn.prevOption'), onclick: () => step(-1) }, '‹') : null,
      select,
      opts.arrows ? h('button', { type: 'button', class: 'step', 'aria-label': i18n.t('btn.nextOption'), onclick: () => step(1) }, '›') : null,
    ),
  );
  const render = () => {
    select.value = String(Math.round(store.getPlain(i)));
  };
  app.watch(i, render);
  render();
  app.help.attach(el, () => ({
    title: i18n.paramTitle(key),
    body: i18n.paramHelp(key),
    value: i18n.option(p.options[Math.round(store.getPlain(i))]),
  }));
  return el;
}

/** Row of buttons for an enum with few options. `icons` maps option names
 * to SVG path data drawn in a 24x16 box. */
export function Segmented(app, key, opts = {}) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const p = store.def(i);
  const text = opts.optionLabel ?? i18n.option;
  const buttons = p.options.map((name, k) => {
    const icon = opts.icons?.[name];
    return h(
      'button',
      {
        type: 'button',
        title: icon ? text(name) : null,
        'aria-label': icon ? text(name) : null,
        onclick: () => {
          const prev = Math.round(store.getPlain(i));
          store.setPlain(i, k);
          opts.onUserChange?.(prev, k);
          store.commit();
        },
      },
      icon ? icon() : text(name),
    );
  });
  const el = h(
    'div',
    { class: `ctl segmented-ctl ${opts.class ?? ''}`, dataset: { param: i, key } },
    opts.label === false ? null : h('span', { class: 'ctl-label' }, opts.label ?? i18n.paramLabel(key)),
    h('div', { class: 'segmented', role: 'group', 'aria-label': i18n.paramTitle(key) }, buttons),
  );
  const render = () => {
    const cur = Math.round(store.getPlain(i));
    buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === cur)));
  };
  app.watch(i, render);
  render();
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.paramHelp(key), value: text(p.options[Math.round(store.getPlain(i))]) }));
  return el;
}
