// The settings panel: one node of the board opened up.
//
// Every panel reads top to bottom the same way: what the node is, a picture
// of what it does (with the sound going in and coming out), the few controls
// that matter most, the rest behind "more settings", and what is connected.
// On a wide screen it sits beside the board; on a phone it is a sheet that
// slides up from the bottom.

import { h, s, setupCanvas } from './dom.js';
import { Slider, Stepper, Switch, Select, Segmented } from './controls.js';
import { WavetableDisplay, FilterDisplay, EnvDisplay, LfoDisplay, LFO_SHAPE_POINTS, SpectrumDisplay, Meter } from './displays.js';
import { colors, modColor } from '../theme.js';
import { isFx, isMover, isOn, hasSwitch, moverKind, fxChain, taps, nodeOfParam, setOn, shiftFx } from './nodes.js';

/** Shows `el` only while `predicate()` holds; re-checked when any of the
 * given parameters changes. */
function when(app, keys, predicate, el) {
  const update = () => {
    el.hidden = !predicate();
  };
  for (const k of keys) app.watch(app.store.idx(k), update);
  update();
  return el;
}

/** The sound entering and leaving a node, side by side. */
function Io(app, id) {
  const { i18n, store } = app;
  const t = taps(store, id);
  const cell = (label, tap) => h('figure', { class: 'io-cell' }, app.scopes.add(tap, 'io-scope'), h('figcaption', {}, label));
  return h(
    'div',
    { class: 'io' },
    t.in == null ? null : cell(i18n.t('io.in'), t.in),
    t.in == null ? null : h('span', { class: 'io-arrow', 'aria-hidden': 'true' }, s('svg', { viewBox: '0 0 24 12' }, s('path', { d: 'M1 6h20M16 1l5 5-5 5' }))),
    cell(i18n.t(t.in == null ? 'io.outOnly' : 'io.out'), t.out),
  );
}

function section(title, ...children) {
  return h('section', { class: 'panel-section' }, title ? h('h3', {}, title) : null, children);
}

/** What one source is connected to, with the form to connect it further. */
function Reach(app, sourceKey, title) {
  const { store, i18n } = app;
  const src = store.info.sources.indexOf(sourceKey);
  const routes = app.mods.routeList({ filter: (slot) => slot.src === src, show: 'target', empty: i18n.t('reach.empty') });
  app.on('slots', routes.render);
  return section(title ?? i18n.t('reach.title'), routes.el, app.mods.linkForm(sourceKey));
}

/** What is moving the sliders of this node. */
function MovedBy(app, id) {
  const { store, i18n } = app;
  const mine = (slot) => nodeOfParam(store.def(slot.dst).key) === id;
  const routes = app.mods.routeList({ filter: mine, show: 'both' });
  const box = section(i18n.t('moved.title'), routes.el);
  const update = () => {
    routes.render();
    box.hidden = !store.activeSlots().some(mine);
  };
  app.on('slots', update);
  update();
  return box;
}

function filterGroups(i18n) {
  return [
    [i18n.t('filter.group.low'), ['LP6', 'LP12', 'LP24', 'Ladder12', 'Ladder24']],
    [i18n.t('filter.group.high'), ['HP6', 'HP12', 'HP24']],
    [i18n.t('filter.group.band'), ['BP12', 'BP24', 'Notch', 'Peak', 'Morph']],
    [i18n.t('filter.group.special'), ['Comb+', 'Comb-', 'Phaser', 'Formant', 'Reduce', 'Ring']],
  ];
}

/** Button that opens a gallery of the wavetables, drawn as small waves. */
function TablePicker(app, name) {
  const { store, core, i18n } = app;
  const i = store.idx(`${name}.wt`);
  const tables = store.info.tables;
  const label = h('span', { class: 'table-pick-name' });
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'table-pick',
      'aria-haspopup': 'true',
      onclick: () => {
        const current = Math.round(store.getPlain(i));
        const c = colors();
        const close = app.popover(
          btn,
          h(
            'div',
            { class: 'table-gallery' },
            tables.map((tableName, k) => {
              const canvas = h('canvas', {});
              const ctx = setupCanvas(canvas, 104, 40);
              // Two frames give a feel for how the table changes.
              for (const [pos, opacity] of [[0.85, 0.3], [0.2, 1]]) {
                const wave = core.previewTable(k, pos, 52);
                ctx.beginPath();
                wave.forEach((v, j) => {
                  const x = 2 + (j / 51) * 100;
                  const y = 20 - v * 15;
                  if (j) ctx.lineTo(x, y);
                  else ctx.moveTo(x, y);
                });
                ctx.globalAlpha = opacity;
                ctx.strokeStyle = c.sound;
                ctx.lineWidth = 1.6;
                ctx.lineJoin = 'round';
                ctx.stroke();
              }
              return h(
                'button',
                {
                  type: 'button',
                  class: 'table-card',
                  'aria-pressed': String(k === current),
                  onclick: () => {
                    store.setPlain(i, k);
                    store.commit();
                    close();
                  },
                },
                canvas,
                h('span', {}, tableName),
              );
            }),
          ),
        );
      },
    },
    h('span', { class: 'ctl-label' }, i18n.paramLabel(`${name}.wt`)),
    label,
    h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
  );
  const render = () => {
    label.textContent = tables[Math.round(store.getPlain(i))];
  };
  app.watch(i, render);
  render();
  app.help.attach(btn, () => ({ title: i18n.paramTitle(`${name}.wt`), body: i18n.paramHelp(`${name}.wt`), value: label.textContent }));
  return btn;
}

const ICON = (d) => () => s('svg', { viewBox: '0 0 28 14', class: 'shape-icon' }, s('path', { d }));
const LFO_ICONS = {
  Sine: ICON('M1 7C5-3 10-3 14 7S23 17 27 7'),
  Triangle: ICON('M1 13L14 1L27 13'),
  SawUp: ICON('M1 13L26 1V13'),
  SawDown: ICON('M2 13V1L27 13'),
  Square: ICON('M1 13V1H14V13H27'),
  'S&H': ICON('M1 9H7V3H13V11H20V5H27'),
  Smooth: ICON('M1 9C4 9 5 3 9 3S13 11 17 11S22 5 27 6'),
  // A hand-drawn line: draw your own.
  Custom: ICON('M2 11L7 4L12 9L17 3L21 8M21 8l4 4M23 12h3v-3'),
};

// Which controls each effect shows first; the rest go under "more settings".
// Entries: [kind, parameter, showIf].
const FX_LAYOUT = {
  hyper: { main: [['slider', 'mix'], ['slider', 'detune'], ['stepper', 'voices']], more: [['slider', 'rate'], ['slider', 'dimMix'], ['slider', 'dimSize']] },
  dist: {
    main: [['select', 'mode'], ['slider', 'drive'], ['slider', 'mix']],
    more: [
      ['seg', 'filterMode'],
      ['seg', 'filterType', (v) => v('filterMode') > 0],
      ['slider', 'filterFreq', (v) => v('filterMode') > 0],
      ['slider', 'filterQ', (v) => v('filterMode') > 0],
    ],
  },
  flanger: { main: [['slider', 'mix'], ['slider', 'rate'], ['slider', 'depth']], more: [['slider', 'feedback'], ['slider', 'phase']] },
  phaser: { main: [['slider', 'mix'], ['slider', 'rate'], ['slider', 'depth']], more: [['slider', 'freq'], ['slider', 'feedback'], ['slider', 'phase']] },
  chorus: { main: [['slider', 'mix'], ['slider', 'rate'], ['slider', 'depth']], more: [['slider', 'delay1'], ['slider', 'delay2'], ['slider', 'feedback'], ['slider', 'lpf']] },
  delay: {
    main: [
      ['slider', 'mix'],
      ['switch', 'sync'],
      ['select', 'divL', (v) => v('sync') > 0],
      ['slider', 'timeL', (v) => v('sync') === 0],
      ['slider', 'feedback'],
    ],
    more: [
      ['seg', 'mode'],
      ['switch', 'link'],
      ['select', 'divR', (v) => v('sync') > 0 && v('link') === 0],
      ['slider', 'timeR', (v) => v('sync') === 0 && v('link') === 0],
      ['slider', 'filterFreq'],
      ['slider', 'filterQ'],
    ],
  },
  comp: { main: [['slider', 'threshold'], ['slider', 'ratio'], ['slider', 'gain']], more: [['slider', 'attack'], ['slider', 'release'], ['switch', 'multiband'], ['slider', 'mix']] },
  reverb: { main: [['slider', 'mix'], ['slider', 'size'], ['slider', 'decay']], more: [['seg', 'mode'], ['slider', 'predelay'], ['slider', 'lowcut'], ['slider', 'highcut'], ['slider', 'damp'], ['slider', 'width']] },
  eq: {
    main: [['slider', 'lowGain'], ['slider', 'highGain']],
    more: [['select', 'lowType'], ['slider', 'lowFreq'], ['slider', 'lowQ'], ['select', 'highType'], ['slider', 'highFreq'], ['slider', 'highQ']],
  },
  fxfilter: { main: [['select', 'type'], ['slider', 'cutoff'], ['slider', 'res']], more: [['slider', 'drive'], ['slider', 'var'], ['slider', 'mix']] },
};

function fxControls(app, key, entries) {
  const { store, i18n } = app;
  const value = (p) => Math.round(store.plain(`${key}.${p}`));
  const deps = [...FX_LAYOUT[key].main, ...FX_LAYOUT[key].more].filter(([kind]) => kind !== 'slider').map(([, p]) => `${key}.${p}`);
  return entries.map(([kind, p, showIf]) => {
    const full = `${key}.${p}`;
    let el;
    if (kind === 'slider') el = Slider(app, full);
    else if (kind === 'stepper') el = Stepper(app, full);
    else if (kind === 'switch') el = Switch(app, full);
    else if (kind === 'seg') el = Segmented(app, full);
    else el = Select(app, full, key === 'fxfilter' && p === 'type' ? { groups: filterGroups(i18n), arrows: true } : { arrows: true });
    return showIf ? when(app, deps, () => showIf(value), el) : el;
  });
}

/** Earlier / later buttons for an effect that is in the chain. */
function Order(app, key) {
  const { store, i18n } = app;
  const place = h('output', {});
  const earlier = h('button', { type: 'button', class: 'btn small', onclick: () => { shiftFx(store, key, -1); store.commit(); } }, i18n.t('order.earlier'));
  const later = h('button', { type: 'button', class: 'btn small', onclick: () => { shiftFx(store, key, 1); store.commit(); } }, i18n.t('order.later'));
  const el = h('div', { class: 'order' }, h('span', { class: 'ctl-label' }, i18n.t('order.title')), earlier, place, later);
  const render = () => {
    const chain = fxChain(store);
    const at = chain.indexOf(key);
    el.hidden = at < 0 || chain.length < 2;
    place.textContent = i18n.t('order.place', { n: at + 1, total: chain.length });
    earlier.disabled = at <= 0;
    later.disabled = at >= chain.length - 1;
  };
  app.on('fx', render);
  app.watch(store.idx(`${key}.on`), render);
  for (const other of store.info.fx) if (other !== key) app.watch(store.idx(`${other}.on`), render);
  render();
  app.help.attach(el, () => ({ title: i18n.t('order.title'), body: i18n.t('order.help') }));
  return el;
}

// ---------------------------------------------------------------------------
// One builder per kind of node. Each returns { visual, main, more, extra }.
// ---------------------------------------------------------------------------

function oscillator(app, id) {
  const k = (p) => `${id}.${p}`;
  return {
    visual: [WavetableDisplay(app, id, colors().sound), TablePicker(app, id), Io(app, id)],
    main: [Slider(app, k('pos')), Slider(app, k('level')), Stepper(app, k('oct')), Slider(app, k('unison')), Slider(app, k('detune'))],
    more: [
      Select(app, k('warp'), { arrows: true }),
      when(app, [k('warp')], () => app.store.plain(k('warp')) > 0, Slider(app, k('warpAmt'))),
      Stepper(app, k('semi')),
      Slider(app, k('fine')),
      Slider(app, k('coarse')),
      Slider(app, k('pan')),
      Slider(app, k('blend')),
      Slider(app, k('width')),
      Slider(app, k('phase')),
      Slider(app, k('rand')),
      Switch(app, k('toFilter')),
    ],
  };
}

function envelope(app, n) {
  const k = (p) => `env${n}.${p}`;
  return {
    visual: [EnvDisplay(app, n - 1, modColor(`env${n}`))],
    main: [Slider(app, k('attack')), Slider(app, k('decay')), Slider(app, k('sustain')), Slider(app, k('release'))],
    more: [Slider(app, k('hold')), Slider(app, k('atkCurve')), Slider(app, k('decCurve')), Slider(app, k('relCurve'))],
  };
}

function lfo(app, n) {
  const { store } = app;
  const k = (p) => `lfo${n}.${p}`;
  const shape = store.def(store.idx(k('shape')));
  const custom = shape.options.indexOf('Custom');
  return {
    visual: [
      LfoDisplay(app, n - 1),
      Segmented(app, k('shape'), {
        label: false,
        icons: LFO_ICONS,
        class: 'shape-picker',
        // Switching to "draw" starts from the shape that was playing.
        onUserChange: (prev, next) => {
          const pts = LFO_SHAPE_POINTS[shape.options[prev]];
          if (next === custom && pts) store.setLfoShape(n - 1, pts.map(([x, y, curve]) => ({ x, y, curve })));
        },
      }),
    ],
    main: [
      Switch(app, k('sync')),
      when(app, [k('sync')], () => store.plain(k('sync')) >= 0.5, Select(app, k('div'), { arrows: true })),
      when(app, [k('sync')], () => store.plain(k('sync')) < 0.5, Slider(app, k('rate'))),
      Segmented(app, k('mode')),
    ],
    more: [Slider(app, k('rise')), Slider(app, k('delay')), Slider(app, k('smooth')), Slider(app, k('phase'))],
  };
}

function parts(app, id) {
  const { store, i18n } = app;
  const kind = isMover(id) ? moverKind(id) : null;
  if (kind === 'lfo') return lfo(app, Number(id.slice(3)));
  if (kind === 'env') return envelope(app, Number(id.slice(3)));
  if (kind === 'macro') return { visual: [], main: [Slider(app, id, { noMod: true })], more: [] };
  if (kind === 'play') {
    // The mod wheel has no hardware here unless a MIDI keyboard is connected.
    const wheel = h('input', { type: 'range', min: 0, max: 100, value: 0, 'aria-label': i18n.sourceName(id), oninput: () => app.audio.post(['wheel', Number(wheel.value) / 100]) });
    return { visual: [], main: id === 'modWheel' ? [h('label', { class: 'ctl plain-range' }, h('span', { class: 'ctl-label' }, i18n.sourceName(id)), wheel)] : [], more: [] };
  }
  if (isFx(store, id)) {
    const visual = [Io(app, id)];
    if (id === 'fxfilter') visual.unshift(FilterDisplay(app, 'fxfilter', colors().sound));
    return { visual, main: [...fxControls(app, id, FX_LAYOUT[id].main), Order(app, id)], more: fxControls(app, id, FX_LAYOUT[id].more) };
  }
  switch (id) {
    case 'oscA':
    case 'oscB':
      return oscillator(app, id);
    case 'sub':
      return { visual: [Io(app, id)], main: [Select(app, 'sub.shape', { arrows: true }), Stepper(app, 'sub.oct'), Slider(app, 'sub.level')], more: [Slider(app, 'sub.pan'), Switch(app, 'sub.toFilter')] };
    case 'noise':
      return { visual: [Io(app, id)], main: [Select(app, 'noise.type', { arrows: true }), Slider(app, 'noise.level'), Slider(app, 'noise.tone')], more: [Slider(app, 'noise.pan'), Switch(app, 'noise.toFilter')] };
    case 'filter':
      return {
        visual: [FilterDisplay(app, 'filter', colors().sound), Io(app, id)],
        main: [Select(app, 'filter.type', { groups: filterGroups(i18n), arrows: true }), Slider(app, 'filter.cutoff'), Slider(app, 'filter.res')],
        more: [Slider(app, 'filter.drive'), Slider(app, 'filter.var'), Slider(app, 'filter.mix'), Slider(app, 'filter.keytrack'), Slider(app, 'filter.stereo')],
      };
    case 'amp': {
      const env = envelope(app, 1);
      return { visual: [...env.visual, Io(app, id)], main: env.main, more: [...env.more, Slider(app, 'master.velSens')] };
    }
    default:
      return {
        visual: [app.scopes.add(store.info.tap.out, 'big-scope'), SpectrumDisplay(app), h('div', { class: 'out-meter' }, h('span', { class: 'ctl-label' }, i18n.t('out.level')), Meter(app))],
        main: [Slider(app, 'master.volume'), Slider(app, 'master.bpm'), Slider(app, 'master.pitch')],
        more: [],
      };
  }
}

/** Builds the settings panel for node `id`. */
export function buildPanel(app, id) {
  const { store, i18n } = app;
  const mover = isMover(id);
  const name = mover ? i18n.sourceName(id) : i18n.nodeName(id);
  const p = parts(app, id);

  const actions = [];
  if (hasSwitch(store, id)) {
    actions.push(Switch(app, `${id}.on`, { label: i18n.t('panel.on'), onToggle: (on) => setOn(store, id, on) }));
  }
  actions.push(h('button', { type: 'button', class: 'icon-btn', 'aria-label': i18n.t('btn.close'), title: i18n.t('btn.close'), onclick: () => app.select(null) }, '×'));

  const body = [
    h('p', { class: 'panel-about' }, mover ? i18n.moverAbout(id) : i18n.nodeAbout(id)),
    p.visual.length ? h('div', { class: 'panel-visual' }, p.visual) : null,
    p.main.length ? h('div', { class: 'control-list' }, p.main) : null,
    p.more.length ? h('details', { class: 'more' }, h('summary', {}, i18n.t('panel.more')), h('div', { class: 'control-list' }, p.more)) : null,
  ];
  if (mover) {
    body.push(Reach(app, id));
    body.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn quiet danger',
          onclick: () => {
            app.movers.delete(id);
            app.mods.disconnectAll(store.info.sources.indexOf(id));
            app.select(null);
            app.board.layout(true);
          },
        },
        i18n.t('panel.removeMover', { name }),
      ),
    );
  } else {
    body.push(MovedBy(app, id));
    // The amp's envelope can also move other sliders.
    if (id === 'amp') body.push(Reach(app, 'env1', i18n.t('reach.env1')));
  }

  const el = h(
    'aside',
    { class: `panel ${mover ? 'is-mover' : ''}`, dataset: { panel: id }, 'aria-label': name, style: mover ? { '--c': modColor(id) } : {} },
    h('div', { class: 'panel-grip', 'aria-hidden': 'true' }),
    h(
      'header',
      { class: 'panel-head' },
      h('div', { class: 'panel-title' }, h('h2', {}, mover ? h('span', { class: 'mod-dot' }) : null, name), h('p', {}, mover ? i18n.sourceHelp(id) : i18n.nodeRole(id))),
      h('div', { class: 'panel-actions' }, actions),
    ),
    h('div', { class: 'panel-scroll' }, body),
    app.help.el,
  );
  if (hasSwitch(store, id)) {
    const dim = () => el.classList.toggle('off', !isOn(store, id));
    app.watch(store.idx(`${id}.on`), dim);
    dim();
  }
  return el;
}
