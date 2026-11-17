// The settings panel: one node of the board opened up.
//
// Every panel reads top to bottom the same way: what the node is, a picture
// of what it does (with the sound going in and coming out), the few controls
// that matter most, the rest behind "more settings", and what is connected.
// On a wide screen it sits beside the board; on a phone it is a sheet that
// slides up from the bottom.

import { h, s, setupCanvas } from './dom.ts';
import { Slider, Stepper, Switch, Select, Segmented } from './controls.ts';
import { WavetableDisplay, FilterDisplay, EnvDisplay, LfoDisplay, LFO_SHAPE_POINTS, SpectrumDisplay, Meter } from './displays.ts';
import { colors, modColor } from '../theme.ts';
import { openTableEditor, userTableName } from './table-editor.ts';
import type { App } from '../app.ts';
import type { EngineCore } from '../engine/core.ts';
import type { I18n } from '../i18n.ts';
import type { Lane } from './nodes.ts';
import { SPLIT, LANE, filtersParallel, isFx, isMover, isOn, hasSwitch, moverKind, fxKind, fxCopies, fxGroups, fxPeers, laneOf, taps, nodeOfParam, setOn, shiftFx, setLane, unsplit, duplicateFx } from './nodes.ts';

/** What a kind of node puts in its panel. */
interface Parts {
  /** Pictures at the top. */
  visual: HTMLElement[];
  /** The few controls that matter most. */
  main: HTMLElement[];
  /** The rest, behind "more settings". */
  more: HTMLElement[];
  /** Anything at the very end. */
  foot?: HTMLElement[];
}

/** Shows `el` only while `predicate()` holds; re-checked when any of the
 * given parameters changes. */
function when<E extends HTMLElement>(app: App, keys: string[], predicate: () => boolean, el: E): E {
  const update = () => {
    el.hidden = !predicate();
  };
  for (const k of keys) app.watch(app.store.idx(k), update);
  update();
  return el;
}

/** The sound entering and leaving a node, side by side. */
function Io(app: App, id: string): HTMLElement {
  const { i18n, store } = app;
  const t = taps(store, id);
  const scopes = { in: t.in == null ? null : app.scopes.add(t.in, 'io-scope'), out: app.scopes.add(t.out, 'io-scope') };
  const cell = (label: string, scope: HTMLElement) => h('figure', { class: 'io-cell' }, scope, h('figcaption', {}, label));
  // What enters a node of the effect chain depends on what is in front of it.
  const scopeIn = scopes.in;
  if (scopeIn && !['filter', 'filter2', 'amp'].includes(id)) {
    onChain(app, () => {
      const now = taps(store, id);
      if (now.in !== null) app.scopes.point(scopeIn, now.in);
      app.scopes.point(scopes.out, now.out);
    });
  }
  return h(
    'div',
    { class: 'io' },
    scopes.in ? cell(i18n.t('io.in'), scopes.in) : null,
    scopes.in ? h('span', { class: 'io-arrow', 'aria-hidden': 'true' }, s('svg', { viewBox: '0 0 24 12' }, s('path', { d: 'M1 6h20M16 1l5 5-5 5' }))) : null,
    cell(i18n.t(scopes.in ? 'io.out' : 'io.outOnly'), scopes.out),
  );
}

function section(title: string | null, ...children: HTMLElement[]): HTMLElement {
  return h('section', { class: 'panel-section' }, title ? h('h3', {}, title) : null, children);
}

/** What one source is connected to, with the form to connect it further. */
function Reach(app: App, sourceKey: string, title?: string): HTMLElement {
  const { store, i18n } = app;
  const src = store.info.sources.indexOf(sourceKey);
  const routes = app.mods.routeList({ filter: (slot) => slot.src === src, show: 'target', empty: i18n.t('reach.empty') });
  app.on('slots', routes.render);
  return section(title ?? i18n.t('reach.title'), routes.el, app.mods.linkForm(sourceKey));
}

/** What is moving the sliders of this node. */
function MovedBy(app: App, id: string): HTMLElement {
  const { store, i18n } = app;
  const mine = (slot: { dst: number }) => nodeOfParam(store.def(slot.dst).key) === id;
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

function filterGroups(i18n: I18n): [string, string[]][] {
  return [
    [i18n.t('filter.group.low'), ['LP6', 'LP12', 'LP24', 'Ladder12', 'Ladder24']],
    [i18n.t('filter.group.high'), ['HP6', 'HP12', 'HP24']],
    [i18n.t('filter.group.band'), ['BP12', 'BP24', 'Notch', 'Peak', 'Morph']],
    [i18n.t('filter.group.special'), ['Comb+', 'Comb-', 'Phaser', 'Formant', 'Reduce', 'Ring']],
  ];
}

/** Two frames of a table as a small picture: a feel for how it changes. */
function tableThumb(core: EngineCore, table: number): HTMLCanvasElement {
  const canvas = h('canvas', {});
  const ctx = setupCanvas(canvas, 104, 40);
  const c = colors();
  const frames = core.tableFrames(table) > 1 ? [[0.85, 0.3], [0.2, 1]] : [[0, 1]];
  for (const [pos, opacity] of frames) {
    const wave = core.previewTable(table, pos, 52);
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
  return canvas;
}

/**
 * Chooses the wavetable of an oscillator: a button that opens a gallery of
 * the built-in tables, drawn as small waves, followed by the tables the
 * user can make. While one of those is chosen, a second button opens the
 * editor for it.
 */
function TablePicker(app: App, name: string): HTMLElement {
  const { store, core, i18n } = app;
  const iWt = store.idx(`${name}.wt`);
  const iUser = store.idx(`${name}.userTable`);
  const tables = store.info.tables;
  const userSlot = () => Math.round(store.getPlain(iUser)) - 1; // -1: a built-in table
  const label = h('span', { class: 'table-pick-name' });
  const pick = h(
    'button',
    {
      type: 'button',
      class: 'table-pick',
      onclick: () => {
        const builtIn = userSlot() < 0 ? Math.round(store.getPlain(iWt)) : -1;
        const card = (table: number, text: string, pressed: boolean, choose: () => void) =>
          h(
            'button',
            {
              type: 'button',
              class: 'table-card',
              'aria-pressed': String(pressed),
              onclick: () => {
                close();
                choose();
              },
            },
            tableThumb(core, table),
            h('span', {}, text),
          );
        const close = app.popover(
          pick,
          h(
            'div',
            { class: 'table-menu' },
            h(
              'div',
              { class: 'table-gallery' },
              tables.map((tableName, k) =>
                card(k, tableName, k === builtIn, () => {
                  store.setPlain(iWt, k);
                  store.setPlain(iUser, 0);
                  store.commit();
                }),
              ),
            ),
            h('div', { class: 'menu-sub' }, i18n.t('table.mine')),
            h(
              'div',
              { class: 'table-gallery' },
              Array.from({ length: store.info.userTables }, (_, slot) =>
                // Choosing one of your own opens it for drawing straight away.
                card(tables.length + slot, userTableName(i18n, slot), slot === userSlot(), () => {
                  store.setPlain(iUser, slot + 1);
                  store.commit();
                  openTableEditor(app, name, slot);
                }),
              ),
            ),
          ),
        );
      },
    },
    h('span', { class: 'ctl-label' }, i18n.paramLabel(`${name}.wt`)),
    label,
    h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
  );
  const edit = h('button', { type: 'button', class: 'btn small table-edit', onclick: () => openTableEditor(app, name, userSlot()) }, i18n.t('table.edit'));
  const render = () => {
    const slot = userSlot();
    label.textContent = slot < 0 ? tables[Math.round(store.getPlain(iWt))] : userTableName(i18n, slot);
    edit.hidden = slot < 0;
  };
  app.watch(iWt, render);
  app.watch(iUser, render);
  render();
  app.help.attach(pick, () => ({ title: i18n.paramTitle(`${name}.wt`), body: i18n.paramHelp(`${name}.wt`), value: label.textContent }));
  app.help.attach(edit, () => ({ title: i18n.t('table.edit'), body: i18n.t('table.edit.help') }));
  return h('div', { class: 'table-picker' }, pick, edit);
}

const ICON = (d: string) => () => s('svg', { viewBox: '0 0 28 14', class: 'shape-icon' }, s('path', { d }));
const LFO_ICONS: Record<string, () => SVGElement> = {
  Sine: ICON('M1 7C5-3 10-3 14 7S23 17 27 7'),
  Triangle: ICON('M1 13L14 1L27 13'),
  SawUp: ICON('M1 13L26 1V13'),
  SawDown: ICON('M2 13V1L27 13'),
  Square: ICON('M1 13V1H14V13H27'),
  'S&H': ICON('M1 9H7V3H13V11H20V5H27'),
  Smooth: ICON('M1 9C4 9 5 3 9 3S13 11 17 11S22 5 27 6'),
  // A hand-drawn line: draw your own.
  Custom: ICON('M2 11L7 4L12 9L17 3L21 8M21 8l4 4M23 12h3v-3'),
  // Two lobes, like the Lorenz "butterfly".
  Lorenz: ICON('M14 7C11 2 3 1 3 7S11 12 14 7S25 2 25 7S17 12 14 7'),
  // A widening spiral, like the Rössler band.
  Rossler: ICON('M14 7c0-2 3-2 3 0s-2 3-5 2-3-6 1-6 8 1 8 5-5 6-9 5'),
};

// Which controls each effect shows first; the rest go under "more settings".
// Entries: [kind of control, parameter, showIf].
type ControlKind = 'slider' | 'stepper' | 'switch' | 'seg' | 'select';
type FxEntry = [ControlKind, string, ((value: (p: string) => number) => boolean)?];
const FX_LAYOUT: Record<string, { main: FxEntry[]; more: FxEntry[] }> = {
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
  freqshift: { main: [['slider', 'shift'], ['slider', 'mix']], more: [['slider', 'stereo'], ['slider', 'feedback']] },
  utility: {
    main: [['slider', 'gain'], ['slider', 'pan'], ['slider', 'width']],
    more: [['switch', 'monoBass'], ['slider', 'monoFreq', (v) => v('monoBass') > 0]],
  },
};

/** The controls of effect unit `id`, laid out as for its kind of effect. */
function fxControls(app: App, id: string, part: 'main' | 'more'): HTMLElement[] {
  const { store, i18n } = app;
  const kind = fxKind(store, id);
  const layout = FX_LAYOUT[kind];
  const value = (p: string) => Math.round(store.plain(`${id}.${p}`));
  const deps = [...layout.main, ...layout.more].filter(([control]) => control !== 'slider').map(([, p]) => `${id}.${p}`);
  return layout[part].map(([control, p, showIf]) => {
    const full = `${id}.${p}`;
    let el: HTMLElement;
    if (control === 'slider') el = Slider(app, full);
    else if (control === 'stepper') el = Stepper(app, full);
    else if (control === 'switch') el = Switch(app, full);
    else if (control === 'seg') el = Segmented(app, full);
    else el = Select(app, full, kind === 'fxfilter' && p === 'type' ? { groups: filterGroups(i18n), arrows: true } : { arrows: true });
    return showIf ? when(app, deps, () => showIf(value), el) : el;
  });
}

/** Re-runs `render` whenever the effect chain may have changed. */
function onChain(app: App, render: () => void): void {
  const { store } = app;
  app.on('fx', render);
  for (const id of store.info.fx) app.watch(store.idx(`${id}.on`), render);
  app.watch(store.idx('split.mode'), render);
  render();
}

/** The names of the fork's two lanes, which depend on how it divides the sound. */
function laneNames(app: App, form: 'short' | 'only' = 'short'): string[] {
  const { store, i18n } = app;
  const mode = store.def(store.idx('split.mode')).options[Math.round(store.plain('split.mode'))];
  return ['a', 'b'].map((l) => i18n.t(form === 'short' ? `lane.${mode}.${l}` : `lane.${mode}.${l}.only`));
}

/** Earlier / later buttons for an effect in the chain, or for the fork. */
function Order(app: App, id: string): HTMLElement {
  const { store, i18n } = app;
  const place = h('output', {});
  const move = (delta: number) => () => {
    shiftFx(store, id, delta);
    store.commit();
  };
  const earlier = h('button', { type: 'button', class: 'btn small', onclick: move(-1) }, i18n.t('order.earlier'));
  const later = h('button', { type: 'button', class: 'btn small', onclick: move(1) }, i18n.t('order.later'));
  const title = i18n.t(id === SPLIT ? 'order.title.split' : 'order.title');
  const el = h('div', { class: 'order' }, h('span', { class: 'ctl-label' }, title), earlier, place, later);
  onChain(app, () => {
    const row = fxPeers(store, id);
    const at = row.indexOf(id);
    el.hidden = at < 0 || row.length < 2;
    place.textContent = i18n.t('order.place', { n: at + 1, total: row.length });
    earlier.disabled = at <= 0;
    later.disabled = at >= row.length - 1;
  });
  app.help.attach(el, () => ({ title, body: i18n.t(id === SPLIT ? 'order.help.split' : 'order.help') }));
  return el;
}

/** Which way an effect goes at the fork: the main line, or one of the two lanes. */
function LanePicker(app: App, id: string): HTMLElement {
  const { store, i18n } = app;
  const buttons = ([LANE.main, LANE.a, LANE.b] as Lane[]).map((lane) =>
    h('button', {
      type: 'button',
      onclick: () => {
        setLane(store, id, lane);
        store.commit();
      },
    }),
  );
  const el = h('div', { class: 'ctl lane-pick' }, h('span', { class: 'ctl-label' }, i18n.t('lane.title')), h('div', { class: 'segmented', role: 'group', 'aria-label': i18n.t('lane.title') }, buttons));
  onChain(app, () => {
    el.hidden = !isOn(store, id);
    const current = laneOf(store, id);
    const names = [i18n.t('lane.main'), ...laneNames(app, 'only')];
    buttons.forEach((btn, lane) => {
      btn.textContent = names[lane];
      btn.setAttribute('aria-pressed', String(lane === current));
    });
  });
  app.help.attach(el, () => ({ title: i18n.t('lane.title'), body: i18n.t('lane.help') }));
  return el;
}

/** Button that stacks another copy of an effect right behind it. */
function Stack(app: App, id: string): HTMLElement {
  const { store, i18n } = app;
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn small',
      onclick: () => {
        const added = duplicateFx(store, id);
        if (!added) return;
        store.commit();
        app.select(added);
      },
    },
    i18n.t('stack.add'),
  );
  const note = h('span', { class: 'stack-note' });
  const el = h('div', { class: 'stack' }, btn, note);
  onChain(app, () => {
    const copies = fxCopies(store, id);
    const used = copies.filter((other) => isOn(store, other)).length;
    el.hidden = !isOn(store, id);
    btn.disabled = used >= copies.length;
    note.textContent = i18n.t('stack.count', { n: used, total: copies.length });
  });
  app.help.attach(el, () => ({ title: i18n.t('stack.add'), body: i18n.t('stack.help') }));
  return el;
}

/** The fork: how it divides the sound, what each lane carries, how they mix. */
function split(app: App): Parts {
  const { store, i18n } = app;
  const t = store.info.tap;
  const captions = [h('figcaption', {}), h('figcaption', {})];
  const lanes = h(
    'div',
    { class: 'io lanes' },
    h('figure', { class: 'io-cell' }, app.scopes.add(t.splitA, 'io-scope'), captions[0]),
    h('figure', { class: 'io-cell' }, app.scopes.add(t.splitB, 'io-scope'), captions[1]),
  );
  const list = h('p', { class: 'lane-list' });
  onChain(app, () => {
    const g = fxGroups(store);
    const names = laneNames(app);
    captions.forEach((el, k) => {
      el.textContent = i18n.t('lane.carries', { name: names[k] });
    });
    const row = (ids: string[]) => (ids.length ? ids.map((id) => i18n.nodeName(id)).join(' → ') : i18n.t('lane.empty'));
    list.replaceChildren(h('span', {}, `${names[0]}：${row(g.a)}`), h('span', {}, `${names[1]}：${row(g.b)}`));
  });
  const remove = h(
    'button',
    {
      type: 'button',
      class: 'btn quiet danger',
      onclick: () => {
        unsplit(store);
        store.commit();
        app.select(null);
      },
    },
    i18n.t('split.remove'),
  );
  return {
    visual: [Io(app, SPLIT), lanes, list],
    main: [
      Select(app, 'split.mode', { arrows: true }),
      when(app, ['split.mode'], () => Math.round(store.plain('split.mode')) === 1, Slider(app, 'split.freq')),
      Slider(app, 'split.balance'),
      Order(app, SPLIT),
    ],
    more: [],
    foot: [remove],
  };
}

// ---------------------------------------------------------------------------
// One builder per kind of node. Each returns { visual, main, more, extra }.
// ---------------------------------------------------------------------------

/**
 * Which filter a source goes into. Only shown while the two filters run in
 * parallel (in series everything goes through both) and the source goes
 * through the filters at all.
 */
function FilterChoice(app: App, id: string): HTMLElement {
  const { store } = app;
  return when(
    app,
    ['filter2.on', 'filter2.mode', `${id}.toFilter`],
    () => filtersParallel(store) && store.plain(`${id}.toFilter`) >= 0.5,
    Segmented(app, `${id}.filterSel`),
  );
}

function oscillator(app: App, id: string): Parts {
  const k = (p: string) => `${id}.${p}`;
  return {
    visual: [WavetableDisplay(app, id, colors().sound), TablePicker(app, id), Io(app, id)],
    main: [Slider(app, k('pos')), Slider(app, k('level')), Stepper(app, k('oct')), Slider(app, k('unison')), Slider(app, k('detune')), FilterChoice(app, id)],
    more: [
      Select(app, k('warp'), { arrows: true }),
      when(app, [k('warp')], () => app.store.plain(k('warp')) > 0, Slider(app, k('warpAmt'))),
      // The second warp appears once the first is in use (or it is set already).
      when(app, [k('warp'), k('warp2')], () => app.store.plain(k('warp')) > 0 || app.store.plain(k('warp2')) > 0, Select(app, k('warp2'), { arrows: true })),
      when(app, [k('warp2')], () => app.store.plain(k('warp2')) > 0, Slider(app, k('warp2Amt'))),
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

function envelope(app: App, n: number): Parts {
  const k = (p: string) => `env${n}.${p}`;
  return {
    visual: [EnvDisplay(app, n - 1, modColor(`env${n}`))],
    main: [Slider(app, k('attack')), Slider(app, k('decay')), Slider(app, k('sustain')), Slider(app, k('release'))],
    more: [Slider(app, k('hold')), Slider(app, k('atkCurve')), Slider(app, k('decCurve')), Slider(app, k('relCurve'))],
  };
}

function lfo(app: App, n: number): Parts {
  const { store } = app;
  const k = (p: string) => `lfo${n}.${p}`;
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

function parts(app: App, id: string): Parts {
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
    const visual: HTMLElement[] = [Io(app, id)];
    if (fxKind(store, id) === 'fxfilter') visual.unshift(FilterDisplay(app, id, colors().sound));
    return {
      visual,
      main: [...fxControls(app, id, 'main'), section(i18n.t('place.title'), Order(app, id), LanePicker(app, id), Stack(app, id))],
      more: fxControls(app, id, 'more'),
    };
  }
  switch (id) {
    case SPLIT:
      return split(app);
    case 'oscA':
    case 'oscB':
    case 'oscC':
      return oscillator(app, id);
    case 'sub':
      return {
        visual: [Io(app, id)],
        main: [Select(app, 'sub.shape', { arrows: true }), Stepper(app, 'sub.oct'), Slider(app, 'sub.level'), FilterChoice(app, id)],
        more: [Slider(app, 'sub.pan'), Switch(app, 'sub.toFilter')],
      };
    case 'noise':
      return {
        visual: [Io(app, id)],
        main: [Select(app, 'noise.type', { arrows: true }), Slider(app, 'noise.level'), Slider(app, 'noise.tone'), FilterChoice(app, id)],
        more: [Slider(app, 'noise.pan'), Switch(app, 'noise.toFilter')],
      };
    case 'filter':
    case 'filter2': {
      const k = (p: string) => `${id}.${p}`;
      return {
        visual: [FilterDisplay(app, id, colors().sound), Io(app, id)],
        main: [
          // How the second filter is connected comes first: it changes what it does.
          ...(id === 'filter2' ? [Segmented(app, 'filter2.mode')] : []),
          Select(app, k('type'), { groups: filterGroups(i18n), arrows: true }),
          Slider(app, k('cutoff')),
          Slider(app, k('res')),
        ],
        more: [Slider(app, k('drive')), Slider(app, k('var')), Slider(app, k('mix')), Slider(app, k('keytrack')), Slider(app, k('stereo'))],
      };
    }
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
export function buildPanel(app: App, id: string): HTMLElement {
  const { store, i18n } = app;
  const mover = isMover(id);
  const name = mover ? i18n.sourceName(id) : i18n.nodeName(id);
  const p = parts(app, id);

  const actions: HTMLElement[] = [];
  if (hasSwitch(store, id)) {
    actions.push(Switch(app, `${id}.on`, { label: i18n.t('panel.on'), onToggle: (on) => setOn(store, id, on) }));
  }
  actions.push(h('button', { type: 'button', class: 'icon-btn', 'aria-label': i18n.t('btn.close'), title: i18n.t('btn.close'), onclick: () => app.select(null) }, '×'));

  const body: (HTMLElement | null)[] = [
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
    body.push(...(p.foot ?? []));
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
