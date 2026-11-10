// The module cards: everything between the header and the keyboard.

import { h, drag } from './dom.js';
import { Knob, Toggle, Select, Segmented, SOURCE_COLORS } from './controls.js';
import { WavetableDisplay, FilterDisplay, EnvDisplay, LfoDisplay, LFO_SHAPE_POINTS, SpectrumDisplay, Meter } from './displays.js';

export const COLORS = {
  oscA: '#38bdf8',
  oscB: '#a78bfa',
  sub: '#34d399',
  noise: '#cbd5e1',
  filter: '#fbbf24',
  amp: '#fb7185',
  fx: '#c084fc',
  out: '#e2e8f0',
};

/** Shows `el` only while `predicate()` holds; re-checked when any of the
 * given parameters changes. */
function when(app, keys, predicate, el) {
  const update = () => {
    el.hidden = !predicate();
    app.cables?.schedule();
  };
  for (const k of keys) app.store.watch(app.store.idx(k), update);
  update();
  return el;
}

function Card(app, { id, title, role, about, color, power, chip, headExtra, body, tapOut, portIn = true, className = '' }) {
  const { i18n } = app;
  const inPort = portIn ? h('div', { class: 'port in' }) : null;
  let outPort = null;
  if (tapOut != null) {
    outPort = h('div', { class: 'port out' }, app.scopes.add(tapOut, color));
    app.help.attach(outPort, () => ({ title, body: i18n.t('hint.scope', { name: title }) }));
  }
  const aboutBtn = about
    ? h(
        'button',
        {
          type: 'button',
          class: 'icon-btn about',
          'aria-label': '?',
          onclick: () => app.popover(aboutBtn, h('div', { class: 'about-pop' }, h('strong', {}, title), h('p', {}, about))),
        },
        '?',
      )
    : null;
  const head = h(
    'header',
    { class: 'card-head' },
    power ? Toggle(app, power, { power: true }) : null,
    chip ?? null,
    h('div', { class: 'card-title' }, h('h3', {}, title), role ? h('span', { class: 'card-role' }, role) : null),
    h('div', { class: 'card-head-extra' }, headExtra ?? null, aboutBtn),
  );
  const el = h(
    'section',
    { class: `card ${className}`, dataset: { module: id }, style: { '--accent': color } },
    inPort,
    head,
    h('div', { class: 'card-body' }, body),
    outPort,
  );
  if (power) {
    const i = app.store.idx(power);
    const update = (v) => {
      el.classList.toggle('off', v < 0.5);
      app.cables?.schedule();
    };
    app.store.watch(i, update);
    update(app.store.get(i));
  }
  if (role) app.help.attach(head, () => ({ title, body: about ?? role }));
  return { el, inPort, outPort };
}

/** A fold-out section for the less essential controls. */
function More(app, ...children) {
  const { i18n } = app;
  const panel = h('div', { class: 'more-panel', hidden: true }, children);
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'more-btn',
      'aria-expanded': 'false',
      onclick: () => {
        panel.hidden = !panel.hidden;
        btn.textContent = panel.hidden ? `${i18n.t('btn.more')} ▾` : `${i18n.t('btn.less')} ▴`;
        btn.setAttribute('aria-expanded', String(!panel.hidden));
        app.cables?.schedule();
      },
    },
    `${i18n.t('btn.more')} ▾`,
  );
  return [btn, panel];
}

/** Button on a source that sends it into the filter or around it. */
function RouteButton(app, key) {
  const { store, i18n } = app;
  const i = store.idx(key);
  const iFilter = store.idx('filter.on');
  const el = h('button', {
    type: 'button',
    class: 'route-btn',
    onclick: () => {
      store.set(i, store.get(i) >= 0.5 ? 0 : 1);
      store.commit();
    },
  });
  const update = () => {
    const through = store.get(i) >= 0.5 && store.get(iFilter) >= 0.5;
    el.classList.toggle('bypass', !through);
    el.textContent = through ? `→ ${i18n.t('mod.filter')}` : `⤳ ${i18n.t('port.bypass')}`;
    el.disabled = store.get(iFilter) < 0.5;
    app.cables?.schedule();
  };
  store.watch(i, update);
  store.watch(iFilter, update);
  update();
  app.help.attach(el, () => ({ title: i18n.paramTitle(key), body: i18n.t('port.route.help') }));
  return el;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function OscCard(app, name) {
  const { i18n, core } = app;
  const color = COLORS[name];
  const k = (p) => `${name}.${p}`;
  const tapIndex = core.info.tap[name];
  const [moreBtn, more] = More(
    app,
    h(
      'div',
      { class: 'knob-row' },
      Knob(app, k('pan')),
      Knob(app, k('semi')),
      Knob(app, k('fine')),
      Knob(app, k('coarse')),
      Knob(app, k('blend')),
      Knob(app, k('width')),
      Knob(app, k('phase')),
      Knob(app, k('rand')),
    ),
  );
  return Card(app, {
    id: name,
    title: i18n.t(`mod.${name}`),
    role: i18n.t(`role.${name}`),
    about: i18n.t('about.oscA'),
    color,
    power: k('on'),
    headExtra: RouteButton(app, k('toFilter')),
    tapOut: tapIndex,
    portIn: false,
    className: 'osc',
    body: [
      h(
        'div',
        { class: 'osc-main' },
        h('div', { class: 'osc-table' }, WavetableDisplay(app, name, color), Select(app, k('wt'), { label: false, arrows: true, optionLabel: (n) => n })),
        h(
          'div',
          { class: 'osc-knobs' },
          h('div', { class: 'knob-row' }, Knob(app, k('pos')), Knob(app, k('level')), Knob(app, k('oct')), Knob(app, k('unison')), Knob(app, k('detune'))),
          h('div', { class: 'knob-row warp-row' }, Select(app, k('warp')), Knob(app, k('warpAmt')), moreBtn),
        ),
      ),
      more,
    ],
  });
}

function SubCard(app) {
  const { i18n, core } = app;
  return Card(app, {
    id: 'sub',
    title: i18n.t('mod.sub'),
    role: i18n.t('role.sub'),
    about: i18n.t('about.sub'),
    color: COLORS.sub,
    power: 'sub.on',
    tapOut: core.info.tap.sub,
    portIn: false,
    className: 'small-source',
    body: h(
      'div',
      { class: 'knob-row' },
      h('div', { class: 'src-col' }, Select(app, 'sub.shape', { label: false }), RouteButton(app, 'sub.toFilter')),
      Knob(app, 'sub.oct', { label: 'OCT' }),
      Knob(app, 'sub.level'),
      Knob(app, 'sub.pan'),
    ),
  });
}

function NoiseCard(app) {
  const { i18n, core } = app;
  return Card(app, {
    id: 'noise',
    title: i18n.t('mod.noise'),
    role: i18n.t('role.noise'),
    about: i18n.t('about.noise'),
    color: COLORS.noise,
    power: 'noise.on',
    tapOut: core.info.tap.noise,
    portIn: false,
    className: 'small-source',
    body: h(
      'div',
      { class: 'knob-row' },
      h('div', { class: 'src-col' }, Select(app, 'noise.type', { label: false }), RouteButton(app, 'noise.toFilter')),
      Knob(app, 'noise.tone'),
      Knob(app, 'noise.level'),
      Knob(app, 'noise.pan'),
    ),
  });
}

// ---------------------------------------------------------------------------
// Filter, amp, output
// ---------------------------------------------------------------------------

function filterGroups(i18n) {
  const ja = i18n.lang === 'ja';
  return [
    [ja ? 'ローパス（高音を削る）' : 'Low-pass (removes highs)', ['LP6', 'LP12', 'LP24', 'Ladder12', 'Ladder24']],
    [ja ? 'ハイパス（低音を削る）' : 'High-pass (removes lows)', ['HP6', 'HP12', 'HP24']],
    [ja ? 'バンド系' : 'Band', ['BP12', 'BP24', 'Notch', 'Peak', 'Morph']],
    [ja ? '特殊' : 'Special', ['Comb+', 'Comb-', 'Phaser', 'Formant', 'Reduce', 'Ring']],
  ];
}

function FilterCard(app) {
  const { i18n, core } = app;
  return Card(app, {
    id: 'filter',
    title: i18n.t('mod.filter'),
    role: i18n.t('role.filter'),
    about: i18n.t('about.filter'),
    color: COLORS.filter,
    power: 'filter.on',
    tapOut: core.info.tap.filterOut,
    className: 'filter no-role',
    body: [
      FilterDisplay(app, 'filter', COLORS.filter),
      Select(app, 'filter.type', { groups: filterGroups(i18n), arrows: true, label: false }),
      h('div', { class: 'knob-row' }, Knob(app, 'filter.cutoff', { class: 'big' }), Knob(app, 'filter.res', { class: 'big' })),
      h('div', { class: 'knob-row' }, Knob(app, 'filter.drive'), Knob(app, 'filter.var'), Knob(app, 'filter.mix')),
      h('div', { class: 'knob-row' }, Knob(app, 'filter.keytrack'), Knob(app, 'filter.stereo')),
    ],
  });
}

function AmpCard(app) {
  const { i18n, core } = app;
  const [moreBtn, more] = More(
    app,
    h('div', { class: 'knob-row' }, Knob(app, 'env1.hold'), Knob(app, 'env1.atkCurve'), Knob(app, 'env1.decCurve'), Knob(app, 'env1.relCurve')),
    h('div', { class: 'section-label' }, i18n.t('mod.voice')),
    h('div', { class: 'knob-row' }, Knob(app, 'master.voices'), Knob(app, 'master.porta'), Knob(app, 'master.bendRange'), Knob(app, 'master.pitch')),
    h('div', { class: 'toggle-row' }, Toggle(app, 'master.mono'), Toggle(app, 'master.legato'), Toggle(app, 'master.portaAlways')),
  );
  return Card(app, {
    id: 'amp',
    title: i18n.t('mod.amp'),
    role: i18n.t('role.amp'),
    about: i18n.t('about.amp'),
    color: COLORS.amp,
    chip: app.mods.sourceChip('env1'),
    tapOut: core.info.tap.amp,
    className: 'amp no-role',
    body: [
      h('div', { class: 'section-label' }, 'ENV 1'),
      EnvDisplay(app, 0, COLORS.amp),
      h('div', { class: 'knob-row' }, Knob(app, 'env1.attack'), Knob(app, 'env1.decay'), Knob(app, 'env1.sustain'), Knob(app, 'env1.release')),
      h('div', { class: 'knob-row' }, Knob(app, 'master.velSens'), moreBtn),
      more,
    ],
  });
}

function OutCard(app) {
  const { i18n, core } = app;
  const voices = h('span', { class: 'readout' }, '0');
  app.onFrame((live) => {
    const v = String(live.voices);
    if (voices.textContent !== v) voices.textContent = v;
  });
  const color = COLORS.out;
  return Card(app, {
    id: 'out',
    title: i18n.t('mod.out'),
    role: i18n.t('role.out'),
    about: i18n.t('about.out'),
    color,
    className: 'out no-role',
    body: [
      h('div', { class: 'out-row' }, Knob(app, 'master.volume', { class: 'big' }), Meter(app)),
      h('div', { class: 'section-label' }, i18n.t('out.scope')),
      app.scopes.add(core.info.tap.out, color, 'out-scope'),
      h('div', { class: 'section-label' }, i18n.t('out.spectrum')),
      SpectrumDisplay(app, COLORS.fx),
      h('div', { class: 'out-row' }, Knob(app, 'master.bpm'), h('div', { class: 'readout-box' }, voices, h('span', { class: 'knob-label' }, i18n.t('out.voices')))),
    ],
  });
}

// ---------------------------------------------------------------------------
// Effects rack
// ---------------------------------------------------------------------------

/** Controls of each effect unit. Entries: [kind, param, showIf]. */
const FX_LAYOUT = {
  hyper: [['knob', 'rate'], ['knob', 'detune'], ['knob', 'voices'], ['knob', 'mix'], ['knob', 'dimSize'], ['knob', 'dimMix']],
  dist: [
    ['select', 'mode'], ['knob', 'drive'], ['knob', 'mix'], ['seg', 'filterMode'],
    ['seg', 'filterType', (v) => v('filterMode') > 0], ['knob', 'filterFreq', (v) => v('filterMode') > 0], ['knob', 'filterQ', (v) => v('filterMode') > 0],
  ],
  flanger: [['knob', 'rate'], ['knob', 'depth'], ['knob', 'feedback'], ['knob', 'phase'], ['knob', 'mix']],
  phaser: [['knob', 'rate'], ['knob', 'depth'], ['knob', 'freq'], ['knob', 'feedback'], ['knob', 'phase'], ['knob', 'mix']],
  chorus: [['knob', 'rate'], ['knob', 'delay1'], ['knob', 'delay2'], ['knob', 'depth'], ['knob', 'feedback'], ['knob', 'lpf'], ['knob', 'mix']],
  delay: [
    ['toggle', 'sync'], ['toggle', 'link'], ['seg', 'mode'],
    ['select', 'divL', (v) => v('sync') > 0], ['knob', 'timeL', (v) => v('sync') === 0],
    ['select', 'divR', (v) => v('sync') > 0 && v('link') === 0], ['knob', 'timeR', (v) => v('sync') === 0 && v('link') === 0],
    ['knob', 'feedback'], ['knob', 'filterFreq'], ['knob', 'filterQ'], ['knob', 'mix'],
  ],
  comp: [['knob', 'threshold'], ['knob', 'ratio'], ['knob', 'attack'], ['knob', 'release'], ['knob', 'gain'], ['knob', 'mix'], ['toggle', 'multiband']],
  reverb: [['seg', 'mode'], ['knob', 'size'], ['knob', 'decay'], ['knob', 'predelay'], ['knob', 'lowcut'], ['knob', 'highcut'], ['knob', 'damp'], ['knob', 'width'], ['knob', 'mix']],
  eq: [['select', 'lowType'], ['knob', 'lowFreq'], ['knob', 'lowQ'], ['knob', 'lowGain'], ['select', 'highType'], ['knob', 'highFreq'], ['knob', 'highQ'], ['knob', 'highGain']],
  fxfilter: [['select', 'type'], ['knob', 'cutoff'], ['knob', 'res'], ['knob', 'drive'], ['knob', 'var'], ['knob', 'mix']],
};

function FxUnit(app, key, rack) {
  const { store, i18n, core } = app;
  const fxId = core.info.fx.indexOf(key);
  const iOn = store.idx(`${key}.on`);
  const value = (p) => Math.round(store.getPlain(store.idx(`${key}.${p}`)));
  const controls = FX_LAYOUT[key].map(([kind, p, showIf]) => {
    const full = `${key}.${p}`;
    let el;
    if (kind === 'knob') el = Knob(app, full);
    else if (kind === 'toggle') el = Toggle(app, full);
    else if (kind === 'seg') el = Segmented(app, full);
    else el = Select(app, full, key === 'fxfilter' && p === 'type' ? { groups: filterGroups(i18n) } : {});
    if (showIf) {
      const deps = FX_LAYOUT[key].filter(([k]) => k !== 'knob').map(([, q]) => `${key}.${q}`);
      when(app, deps, () => showIf(value), el);
    }
    return el;
  });
  const body = h('div', { class: 'fx-body', hidden: true }, controls);
  const chevron = h('span', { class: 'chevron' }, '▸');
  const grip = h('span', { class: 'fx-grip', 'aria-hidden': 'true' }, '⠿');
  const head = h(
    'div',
    { class: 'fx-head' },
    grip,
    Toggle(app, `${key}.on`, { power: true }),
    h(
      'button',
      { type: 'button', class: 'fx-name', 'aria-expanded': 'false', onclick: () => rack.toggleOpen(key) },
      h('strong', {}, i18n.fxName(key)),
      h('span', { class: 'card-role' }, i18n.fxRole(key)),
    ),
    app.scopes.add(core.info.tap.fx + fxId, COLORS.fx, 'mini-scope fx-scope'),
    chevron,
  );
  const el = h('div', { class: 'fx-unit', dataset: { fx: key } }, head, body);
  const update = (v) => el.classList.toggle('on', v >= 0.5);
  store.watch(iOn, update);
  update(store.get(iOn));
  app.help.attach(grip, () => ({ title: i18n.fxName(key), body: i18n.t('hint.fxDrag') }));
  app.help.attach(head, () => ({ title: i18n.fxName(key), body: i18n.fxRole(key) }));
  return {
    el,
    grip,
    key,
    fxId,
    setOpen(open) {
      body.hidden = !open;
      el.classList.toggle('open', open);
      chevron.textContent = open ? '▾' : '▸';
      head.querySelector('.fx-name').setAttribute('aria-expanded', String(open));
    },
  };
}

function FxCard(app) {
  const { store, i18n, core } = app;
  const list = h('div', { class: 'fx-list' });
  const rack = {
    open: null,
    toggleOpen(key) {
      this.setOpen(this.open === key ? null : key);
    },
    setOpen(key) {
      this.open = key;
      for (const u of units) u.setOpen(u.key === key);
      app.cables?.schedule();
    },
  };
  const units = core.info.fx.map((key) => FxUnit(app, key, rack));
  const byId = new Map(units.map((u) => [u.fxId, u]));
  const arrange = () => {
    list.replaceChildren(...store.getFxOrder().map((id) => byId.get(id).el));
    app.cables?.schedule();
  };
  store.on('fx', arrange);
  arrange();

  for (const u of units) {
    // Switching an effect on opens it so its knobs are at hand.
    let was = store.get(store.idx(`${u.key}.on`)) >= 0.5;
    store.watch(store.idx(`${u.key}.on`), (v) => {
      const on = v >= 0.5;
      if (on && !was && !app.loading) rack.setOpen(u.key);
      was = on;
    });

    // Drag the grip to move the unit in the chain.
    drag(u.grip, {
      cursor: 'grabbing',
      onStart: () => {
        const rows = [...list.children];
        return { rows, from: rows.indexOf(u.el), mids: rows.map((r) => r.getBoundingClientRect()).map((r) => r.top + r.height / 2), to: -1 };
      },
      onMove: (_dx, dy, e, st) => {
        u.el.classList.add('dragging');
        u.el.style.transform = `translateY(${dy}px)`;
        let to = st.mids.findIndex((m) => e.clientY < m);
        if (to < 0) to = st.rows.length;
        st.to = to;
        st.rows.forEach((r, k) => r.classList.toggle('drop-before', k === to && r !== u.el));
        list.classList.toggle('drop-end', to === st.rows.length);
      },
      onEnd: (_e, st) => {
        u.el.classList.remove('dragging');
        u.el.style.transform = '';
        st.rows.forEach((r) => r.classList.remove('drop-before'));
        list.classList.remove('drop-end');
        if (st.to < 0) return;
        const order = store.getFxOrder();
        const [moved] = order.splice(st.from, 1);
        order.splice(st.to > st.from ? st.to - 1 : st.to, 0, moved);
        store.setFxOrder(order);
        store.commit();
      },
    });
  }
  const firstOn = units.find((u) => store.get(store.idx(`${u.key}.on`)) >= 0.5);
  if (firstOn) rack.setOpen(firstOn.key);
  store.on('patch', () => {
    const order = store.getFxOrder();
    const on = order.map((id) => byId.get(id)).find((u) => store.get(store.idx(`${u.key}.on`)) >= 0.5);
    rack.setOpen(on ? on.key : null);
  });

  return Card(app, {
    id: 'fx',
    title: i18n.t('mod.fx'),
    role: i18n.t('role.fx'),
    about: i18n.t('about.fx'),
    color: COLORS.fx,
    tapOut: core.info.tap.out,
    className: 'fx no-role',
    body: list,
  });
}

// ---------------------------------------------------------------------------
// Modulation sources
// ---------------------------------------------------------------------------

function EnvCard(app, e) {
  const { i18n } = app;
  const k = (p) => `env${e + 1}.${p}`;
  const color = SOURCE_COLORS[1 + e];
  const [moreBtn, more] = More(app, h('div', { class: 'knob-row' }, Knob(app, k('hold')), Knob(app, k('atkCurve')), Knob(app, k('decCurve')), Knob(app, k('relCurve'))));
  return Card(app, {
    id: `env${e + 1}`,
    title: `ENV ${e + 1}`,
    role: i18n.t('role.env'),
    about: i18n.t('about.env'),
    color,
    chip: app.mods.sourceChip(`env${e + 1}`),
    portIn: false,
    className: 'modsrc env',
    headExtra: moreBtn,
    body: [
      EnvDisplay(app, e, color),
      h(
        'div',
        { class: 'knob-row' },
        Knob(app, k('attack')),
        Knob(app, k('decay')),
        // The full word does not fit under these small knobs in Japanese.
        Knob(app, k('sustain'), i18n.lang === 'ja' ? { label: 'サス' } : {}),
        Knob(app, k('release')),
      ),
      more,
    ],
  });
}

function LfoCard(app, l) {
  const { i18n, store } = app;
  const k = (p) => `lfo${l + 1}.${p}`;
  const color = SOURCE_COLORS[4 + l];
  const shape = store.def(store.idx(k('shape')));
  const custom = shape.options.indexOf('Custom');
  const [moreBtn, more] = More(app, h('div', { class: 'knob-row' }, Knob(app, k('rise')), Knob(app, k('delay')), Knob(app, k('smooth')), Knob(app, k('phase'))));
  return Card(app, {
    id: `lfo${l + 1}`,
    title: `LFO ${l + 1}`,
    role: i18n.t('role.lfo'),
    about: i18n.t('about.lfo'),
    color,
    chip: app.mods.sourceChip(`lfo${l + 1}`),
    portIn: false,
    className: 'modsrc lfo',
    headExtra: moreBtn,
    body: [
      LfoDisplay(app, l),
      h(
        'div',
        { class: 'lfo-row' },
        Select(app, k('shape'), {
          label: false,
          // Switching to Custom starts from the shape that was playing.
          onUserChange: (prev, next) => {
            const pts = LFO_SHAPE_POINTS[shape.options[prev]];
            if (next === custom && pts) store.setLfoShape(l, pts.map(([x, y, curve]) => ({ x, y, curve })));
          },
        }),
        Select(app, k('mode'), { label: false }),
      ),
      h(
        'div',
        { class: 'lfo-row' },
        Toggle(app, k('sync')),
        when(app, [k('sync')], () => store.plain(k('sync')) >= 0.5, Select(app, k('div'), { label: false, arrows: true })),
        when(app, [k('sync')], () => store.plain(k('sync')) < 0.5, Knob(app, k('rate'), { class: 'inline' })),
      ),
      more,
    ],
  });
}

function MacroCard(app) {
  const { i18n } = app;
  return Card(app, {
    id: 'macros',
    title: i18n.t('mod.macro'),
    role: i18n.t('role.macro'),
    about: i18n.t('about.macro'),
    color: SOURCE_COLORS[13],
    portIn: false,
    className: 'modsrc macros',
    body: h(
      'div',
      { class: 'macro-grid' },
      [1, 2, 3, 4].map((n) => h('div', { class: 'macro' }, app.mods.sourceChip(`macro${n}`), Knob(app, `macro${n}`, { label: `M${n}` }))),
    ),
  });
}

function PerfCard(app) {
  const { i18n } = app;
  const wheel = h('input', {
    type: 'range',
    min: 0,
    max: 100,
    value: 0,
    class: 'wheel',
    'aria-label': i18n.sourceName('modWheel'),
    oninput: () => app.audio.post(['wheel', Number(wheel.value) / 100]),
  });
  app.help.attach(wheel, () => ({ title: i18n.sourceName('modWheel'), body: i18n.sourceHelp('modWheel') }));
  return Card(app, {
    id: 'perf',
    title: i18n.t('mod.perf'),
    role: i18n.t('role.perf'),
    about: i18n.t('about.perf'),
    color: '#cbd5e1',
    portIn: false,
    className: 'modsrc perf',
    body: h(
      'div',
      { class: 'perf-list' },
      ['velocity', 'note', 'random', 'pitchBend', 'aftertouch'].map((s) => app.mods.sourceChip(s, { label: true })),
      h('div', { class: 'wheel-row' }, app.mods.sourceChip('modWheel', { label: true }), wheel),
    ),
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Builds both lanes and wires the audio cables. Returns the stage element. */
export function buildStage(app) {
  const { i18n, store, core } = app;
  const tap = core.info.tap;

  const oscA = OscCard(app, 'oscA');
  const oscB = OscCard(app, 'oscB');
  const sub = SubCard(app);
  const noise = NoiseCard(app);
  const filter = FilterCard(app);
  const amp = AmpCard(app);
  const fx = FxCard(app);
  const out = OutCard(app);

  const colLabel = (n, id) =>
    h(
      'div',
      { class: 'col-label' },
      h('b', {}, String(n)),
      i18n.t(`mod.${id}`),
      id === 'sources' ? null : h('span', {}, i18n.t(`role.${id}`)),
    );
  const laneTitle = (key) =>
    h('div', { class: 'lane-title' }, h('h2', {}, i18n.t(key)), h('span', {}, i18n.t(`${key}.hint`)));

  const flow = h(
    'section',
    { class: 'lane flow' },
    laneTitle('lane.flow'),
    h(
      'div',
      { class: 'flow-grid' },
      h('div', { class: 'col sources' }, colLabel(1, 'sources'), oscA.el, oscB.el, h('div', { class: 'small-sources' }, sub.el, noise.el)),
      h('div', { class: 'col' }, colLabel(2, 'filter'), filter.el, h('div', { class: 'bypass-rail' }, h('span', {}, i18n.t('cable.bypass')))),
      h('div', { class: 'col' }, colLabel(3, 'amp'), amp.el),
      h('div', { class: 'col' }, colLabel(4, 'fx'), fx.el),
      h('div', { class: 'col' }, colLabel(5, 'out'), out.el),
    ),
  );

  const mods = h(
    'section',
    { class: 'lane mods' },
    laneTitle('lane.mod'),
    h(
      'div',
      { class: 'mod-grid' },
      EnvCard(app, 1).el,
      EnvCard(app, 2).el,
      [0, 1, 2, 3].map((l) => LfoCard(app, l).el),
      MacroCard(app).el,
      PerfCard(app).el,
    ),
  );

  const stage = h('main', { class: 'stage' }, flow, mods);

  // --- audio cables -----------------------------------------------------------
  const on = (key) => store.plain(key) >= 0.5;
  const rail = flow.querySelector('.bypass-rail');
  const railY = () => {
    const r = rail.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const zoom = sr.width / stage.offsetWidth || 1;
    return (r.top + r.height / 2 - sr.top) / zoom;
  };
  const connections = [];
  for (const [name, card] of [['oscA', oscA], ['oscB', oscB], ['sub', sub], ['noise', noise]]) {
    const through = () => on('filter.on') && on(`${name}.toFilter`);
    connections.push(
      { from: () => (on(`${name}.on`) && through() ? card.outPort : null), to: () => filter.inPort, tap: tap[name], color: COLORS[name] },
      { from: () => (on(`${name}.on`) && !through() ? card.outPort : null), to: () => amp.inPort, tap: tap[name], color: COLORS[name], via: railY },
    );
  }
  connections.push(
    { from: () => (on('filter.on') ? filter.outPort : null), to: () => amp.inPort, tap: tap.filterOut, color: COLORS.filter },
    { from: () => amp.outPort, to: () => fx.inPort, tap: tap.mix, color: COLORS.amp },
    { from: () => fx.outPort, to: () => out.inPort, tap: tap.out, color: COLORS.fx },
  );
  app.afterMount(() => {
    app.cables.setAudio(connections);
    const sync = () => {
      const anyBypass = ['oscA', 'oscB', 'sub', 'noise'].some((n) => on(`${n}.on`) && !(on('filter.on') && on(`${n}.toFilter`)));
      rail.classList.toggle('active', anyBypass);
    };
    for (const p of store.params) if (/\.(on|toFilter)$/.test(p.key)) store.watch(p.i, sync);
    sync();
  });
  return stage;
}
