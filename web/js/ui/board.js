// The board: the whole sound as a graph on a whiteboard.
//
// Nodes on the signal path have an on/off switch. The sound line runs from
// the sources through every node that is switched on and ends at the output;
// sources run in parallel, and a source that skips the filter gets its own
// line around it. The effect chain can fork into two lanes that run side by
// side and join again. Effects that are not in use wait in a tray below the
// path: one of each kind, and switching it on brings out the next copy.
//
// Things that move sliders (LFOs, envelopes, macros, how you play) are not
// part of the path. They float on their own plane and reach down to the
// nodes they act on, where a coloured tag shows the node is being moved.
//
// The board can be dragged and pinch-zoomed like a whiteboard; pressing a
// node opens its settings.

import { h, s, clamp } from './dom.js';
import { modColor } from '../theme.js';
import { SOURCES, MOVERS, SPLIT, isOn, hasSwitch, fxGroups, fxSpares, throughFilter, taps, tapOf, nodeOfParam, nodeOfSource, moverKind, setOn } from './nodes.js';
import { Switch } from './controls.js';

const NW = 172; // path node
const NH = 78;
const MW = 150; // mover node
const MH = 44;
const GAP_X = 46;
const GAP_Y = 26;
const ROW_GAP = 50; // between rows when a long chain wraps
const LANE = (NH + GAP_Y) / 2; // how far each lane of the fork sits from the main line
const LANE_GAP_V = 34; // phone: between the fork and its lanes
const NARROW = 640; // below this the path runs top to bottom

const ease = (t) => 1 - Math.pow(1 - t, 3);

/** SVG path through `pts` with rounded corners. */
function rounded(pts, r = 16) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const [px, py] = pts[k - 1];
    const [x, y] = pts[k];
    const [nx, ny] = pts[k + 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    d += `L${x - ((x - px) / inLen) * rr} ${y - ((y - py) / inLen) * rr}Q${x} ${y} ${x + ((nx - x) / outLen) * rr} ${y + ((ny - y) / outLen) * rr}`;
  }
  const [lx, ly] = pts.at(-1);
  return `${d}L${lx} ${ly}`;
}

export class Board {
  constructor(app) {
    this.app = app;
    this.view = { x: 0, y: 0, k: 1 };
    this.userMoved = false;
    this.selected = null;
    this.pos = new Map();
    this.nodes = new Map();
    this.moverScopes = new Map();
    this.fxScopes = new Map();
    this.edges = [];
    this.tethers = [];
    this.vertical = false;
    const { store, i18n } = app;

    this.svg = s('svg', { class: 'edges', 'aria-hidden': 'true' });
    this.plane = h('div', { class: 'mover-plane' }, h('span', {}, i18n.t('board.movers')));
    this.trayLabel = h('div', { class: 'tray-label' }, i18n.t('board.tray'));
    this.addBtn = h('button', { type: 'button', class: 'mover add', onclick: () => this.#addMenu() }, h('span', { 'aria-hidden': 'true' }, '＋'), i18n.t('board.addMover'));
    // Name tags on the two lanes of the fork.
    this.laneTags = [h('span', { class: 'lane-tag' }), h('span', { class: 'lane-tag' })];
    this.content = h('div', { class: 'board-content' }, this.plane, this.trayLabel, this.svg, this.addBtn, this.laneTags);
    this.hint = h('p', { class: 'board-hint' }, i18n.t('board.hint'));
    this.el = h(
      'section',
      { class: 'board', 'aria-label': i18n.t('board.title') },
      this.content,
      this.hint,
      h(
        'div',
        { class: 'board-tools' },
        h('button', { type: 'button', class: 'tool', 'aria-label': i18n.t('board.zoomOut'), title: i18n.t('board.zoomOut'), onclick: () => this.#zoomBy(1 / 1.25) }, '−'),
        h('button', { type: 'button', class: 'tool wide', onclick: () => this.fit(true) }, i18n.t('board.fit')),
        h('button', { type: 'button', class: 'tool', 'aria-label': i18n.t('board.zoomIn'), title: i18n.t('board.zoomIn'), onclick: () => this.#zoomBy(1.25) }, '＋'),
      ),
    );

    // The fixed part of the path. Effects and the fork come and go: see layout().
    this.fixedIds = [...SOURCES, 'filter', 'amp', 'out'];
    this.pathIds = this.fixedIds;
    for (const id of this.fixedIds) {
      const el = this.#pathNode(id);
      this.nodes.set(id, el);
      this.content.append(el);
    }

    // Anything that changes which nodes are on the path redraws the graph.
    for (const p of store.params) {
      if (/\.(on|toFilter)$/.test(p.key) || p.key === 'split.mode') app.watch(p.i, () => this.schedule());
    }
    app.on('fx', () => this.schedule());
    app.on('patch', () => this.schedule());
    app.on('slots', () => this.schedule());
    const ro = new ResizeObserver(() => this.#resized());
    ro.observe(this.el);
    app.onDispose(() => {
      ro.disconnect();
      for (const scope of [...this.moverScopes.values(), ...this.fxScopes.values()]) scope.dispose();
      cancelAnimationFrame(this.tween);
    });
    app.onFrame((live) => this.#frame(live));
    this.#bindGestures();
    this.layout(false);
  }

  // --- nodes --------------------------------------------------------------------

  #activate(el, id) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) return;
      this.app.select(id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      this.app.select(id);
    });
  }

  #pathNode(id) {
    const { app } = this;
    const { store, i18n } = app;
    const el = h(
      'div',
      { class: `node ${id === SPLIT ? 'fork' : ''}`, role: 'button', tabindex: 0, 'aria-pressed': 'false', dataset: { node: id } },
      h('div', { class: 'buffs' }),
      h(
        'div',
        { class: 'node-head' },
        h('span', { class: 'node-name' }, i18n.nodeName(id)),
        hasSwitch(store, id)
          ? Switch(app, `${id}.on`, {
              hideLabel: true,
              class: 'small',
              // Effects join the end of the chain when switched on.
              onToggle: (on) => setOn(store, id, on),
            })
          : null,
        id === SPLIT ? s('svg', { class: 'fork-icon', viewBox: '0 0 24 16', 'aria-hidden': 'true' }, s('path', { d: 'M1 8h6c4 0 4-6 8-6h8M7 8c4 0 4 6 8 6h8' })) : null,
      ),
      app.scopes.add(taps(store, id).out, 'node-scope'),
    );
    this.#activate(el, id);
    app.help.attach(el, () => ({ title: i18n.nodeName(id), body: i18n.nodeRole(id) }));
    return el;
  }

  #moverNode(id) {
    const { app } = this;
    const { i18n } = app;
    const el = h(
      'button',
      { type: 'button', class: `mover ${moverKind(id)}`, 'aria-pressed': 'false', dataset: { node: id }, style: { '--c': modColor(id) } },
      h('span', { class: 'mover-pulse' }),
      h('span', { class: 'mover-name' }, i18n.sourceName(id)),
    );
    el.addEventListener('click', () => app.select(id));
    app.help.attach(el, () => ({ title: i18n.sourceName(id), body: i18n.sourceHelp(id) }));
    return el;
  }

  /** Movers on the board: the ones the user added plus any that are connected. */
  visibleMovers() {
    const { store } = this.app;
    const used = new Set(store.activeSlots().map((sl) => store.info.sources[sl.src]));
    return MOVERS.filter((id) => used.has(id) || this.app.movers.has(id));
  }

  #addMenu() {
    const { app } = this;
    const { i18n } = app;
    const shown = new Set(this.visibleMovers());
    const kinds = [
      ['lfo', MOVERS.filter((id) => moverKind(id) === 'lfo')],
      ['env', MOVERS.filter((id) => moverKind(id) === 'env')],
      ['macro', MOVERS.filter((id) => moverKind(id) === 'macro')],
    ];
    const add = (id) => {
      close();
      app.movers.add(id);
      this.layout(true);
      app.select(id);
    };
    const close = app.popover(
      this.addBtn,
      h(
        'div',
        { class: 'menu pick-menu' },
        h('div', { class: 'menu-title' }, i18n.t('board.addMover')),
        kinds.map(([kind, ids]) => {
          const next = ids.find((id) => !shown.has(id));
          return h(
            'button',
            { type: 'button', class: 'menu-item pick', disabled: !next, style: { '--c': modColor(next ?? ids[0]) }, onclick: () => add(next) },
            h('strong', {}, h('span', { class: 'mod-dot' }), i18n.t(`mover.${kind}`)),
            h('span', {}, i18n.t(`mover.${kind}.what`)),
          );
        }),
        h('div', { class: 'menu-sub' }, i18n.t('mover.play')),
        MOVERS.filter((id) => moverKind(id) === 'play' && !shown.has(id)).map((id) =>
          h(
            'button',
            { type: 'button', class: 'menu-item pick', style: { '--c': modColor(id) }, onclick: () => add(id) },
            h('strong', {}, h('span', { class: 'mod-dot' }), i18n.sourceName(id)),
            h('span', {}, i18n.sourceHelp(id)),
          ),
        ),
      ),
    );
  }

  setSelected(id) {
    this.selected = id;
    for (const el of this.content.querySelectorAll('[data-node]')) el.setAttribute('aria-pressed', String(el.dataset.node === id));
    // Opening a mover brings its own lines forward and fades the others.
    this.svg.classList.toggle('focus', this.tethers.some((t) => t.from === id));
    for (const t of this.tethers) t.path.classList.toggle('hot', t.from === id);
    if (id) this.hint.hidden = true;
    this.#reveal(id);
  }

  /**
   * On a phone the settings sheet covers the lower part of the board, so the
   * node that was opened is brought into the part that stays visible. Closing
   * the sheet goes back to the overview.
   */
  #reveal(id) {
    if (!this.vertical) return;
    const p = id && this.target?.get(id);
    if (!p) {
      if (this.revealed) this.fit(true);
      this.revealed = false;
      return;
    }
    const k = Math.max(this.view.k, 0.8);
    const visible = this.el.clientHeight * 0.34;
    this.view = { k, x: this.el.clientWidth / 2 - (p.x + p.w / 2) * k, y: visible / 2 - (p.y + p.h / 2) * k };
    this.revealed = true;
    this.userMoved = true;
    this.#applyView(true);
  }

  // --- layout -------------------------------------------------------------------

  schedule() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.layout(true);
    });
  }

  /** How many path nodes fit on one row at a readable size. */
  #perRow() {
    return Math.max(3, Math.floor((this.el.clientWidth / 0.92 - NW - 60) / (NW + GAP_X)));
  }

  #resized() {
    const vertical = this.el.clientWidth < NARROW;
    // Opening or closing the panel changes the room: re-wrap the chain if needed.
    if (vertical !== this.vertical || (!vertical && this.#perRow() !== this.perRow)) this.layout(!!this.pos.size);
    else if (!this.userMoved) this.fit(false);
  }

  /** Works out where every node goes and which lines connect them. */
  layout(animate) {
    const { app } = this;
    const { store, i18n } = app;
    const info = store.info;
    this.vertical = this.el.clientWidth > 0 && this.el.clientWidth < NARROW;
    const V = this.vertical;
    const target = new Map();
    const g = fxGroups(store);
    const idle = fxSpares(store);
    const stepX = NW + GAP_X;
    const stepY = NH + GAP_Y;
    const laneLen = Math.max(g.a.length, g.b.length, 1);

    // Effects and the fork exist as nodes only while they are on the board.
    const shown = [...g.pre, ...(g.split ? [SPLIT] : []), ...g.a, ...g.b, ...g.post, ...idle];
    for (const id of [...this.fxScopes.keys()]) {
      if (shown.includes(id)) continue;
      this.fxScopes.get(id).dispose();
      this.fxScopes.delete(id);
      this.nodes.get(id).remove();
      this.nodes.delete(id);
      this.pos.delete(id);
    }
    for (const id of shown) {
      if (this.fxScopes.has(id)) continue;
      const [el, scope] = app.inScope(() => this.#pathNode(id));
      this.fxScopes.set(id, scope);
      this.nodes.set(id, el);
      this.content.append(el);
    }
    this.pathIds = [...this.fixedIds, ...shown];

    // --- the signal path ---
    const before = ['filter', 'amp', ...g.pre];
    const behind = [...g.post, 'out'];
    if (!V) {
      SOURCES.forEach((id, i) => target.set(id, { x: 0, y: i * stepY }));
      // A long chain wraps onto further rows so the nodes stay readable.
      const perRow = (this.perRow = this.#perRow());
      const cells = [];
      let [col, row, forkRow] = [0, 0, -1];
      const put = (id) => {
        cells.push({ id, col, row, dy: 0 });
        if (++col >= perRow) [col, row] = [0, row + 1];
      };
      before.forEach(put);
      if (g.split) {
        // The fork, its lanes and the node they join in stay on one row.
        if (col > 0 && col + laneLen + 2 > perRow) [col, row] = [0, row + 1];
        forkRow = row;
        cells.push({ id: SPLIT, col, row, dy: 0 });
        g.a.forEach((id, i) => cells.push({ id, col: col + 1 + i, row, dy: -LANE }));
        g.b.forEach((id, i) => cells.push({ id, col: col + 1 + i, row, dy: LANE }));
        col += laneLen + 1;
      }
      behind.forEach(put);
      const rows = cells.at(-1).row + 1;
      // A row with the fork needs room above and below for the lanes.
      const rowY = [1.5 * stepY];
      for (let r = 1; r <= rows; r++) rowY[r] = rowY[r - 1] + NH + ROW_GAP + (r - 1 === forkRow ? LANE : 0) + (r === forkRow ? LANE : 0);
      for (const c of cells) target.set(c.id, { x: (c.col + 1) * stepX, y: rowY[c.row] + c.dy });
      // The line into the first node of a further row comes down the gap above that row.
      for (const c of cells) if (c.row > 0 && c.col === 0) target.get(c.id).wrapDy = -(NH / 2 + ROW_GAP / 2 + (c.row === forkRow ? LANE : 0));
      // Effects that are not in use wait below the path, five to a row.
      const trayY = rowY[rows] + 30;
      const perTray = Math.min(5, perRow);
      idle.forEach((id, j) => target.set(id, { x: stepX + (j % perTray) * (NW + 14), y: trayY + Math.floor(j / perTray) * (NH + 14) }));
      this.trayPos = { x: stepX, y: trayY - 26, show: idle.length > 0 };
    } else {
      SOURCES.forEach((id, i) => target.set(id, { x: (i % 2) * (NW + 12), y: Math.floor(i / 2) * stepY }));
      const chainX = (NW + 12) / 2;
      let y = 2 * stepY + 18;
      const put = (id) => {
        target.set(id, { x: chainX, y });
        y += NH + 28;
      };
      before.forEach(put);
      if (g.split) {
        // The lanes run down side by side under the fork.
        target.set(SPLIT, { x: chainX, y });
        y += NH + LANE_GAP_V;
        g.a.forEach((id, i) => target.set(id, { x: 0, y: y + i * (NH + 28) }));
        g.b.forEach((id, i) => target.set(id, { x: NW + 12, y: y + i * (NH + 28) }));
        y += laneLen * (NH + 28) + LANE_GAP_V - 28;
      }
      behind.forEach(put);
      const trayY = y + 12;
      idle.forEach((id, j) => target.set(id, { x: (j % 2) * (NW + 12), y: trayY + Math.floor(j / 2) * (NH + 12) }));
      this.trayPos = { x: 0, y: trayY - 26, show: idle.length > 0 };
    }
    this.fork = g.split;
    const mode = store.def(store.idx('split.mode')).options[Math.round(store.plain('split.mode'))];
    this.laneTags.forEach((el, k) => {
      el.hidden = !g.split;
      el.textContent = i18n.t(`lane.${mode}.${'ab'[k]}`);
    });
    for (const id of target.keys()) Object.assign(target.get(id), { w: NW, h: NH });

    // --- tags on the nodes that are being moved ---
    const sources = info.sources;
    const reach = new Map(); // node -> [source keys]
    const links = [];
    for (const slot of store.activeSlots()) {
      const key = sources[slot.src];
      const node = nodeOfParam(store.def(slot.dst).key);
      if (!this.pathIds.includes(node)) continue; // a mover moving another mover: listed in the panel only
      if (!reach.has(node)) reach.set(node, []);
      if (!reach.get(node).includes(key)) {
        reach.get(node).push(key);
        links.push({ key, from: nodeOfSource(key), to: node });
      }
    }
    for (const id of this.pathIds) {
      const el = this.nodes.get(id);
      const keys = reach.get(id) ?? [];
      const buffs = el.querySelector('.buffs');
      if (buffs.dataset.sig !== keys.join()) {
        buffs.dataset.sig = keys.join();
        buffs.replaceChildren(...keys.map((key) => h('span', { class: 'buff', dataset: { src: key }, style: { '--c': modColor(key) } }, i18n.sourceName(key))));
      }
      el.classList.toggle('off', !isOn(store, id));
      el.classList.toggle('idle', idle.includes(id));
    }

    // --- the movers, on their own plane ---
    const movers = this.visibleMovers();
    for (const id of [...this.moverScopes.keys()]) {
      if (!movers.includes(id)) {
        this.moverScopes.get(id).dispose();
        this.moverScopes.delete(id);
        this.nodes.get(id)?.remove();
        this.nodes.delete(id);
        this.pos.delete(id);
      }
    }
    for (const id of movers) {
      if (this.moverScopes.has(id)) continue;
      const [el, scope] = app.inScope(() => this.#moverNode(id));
      this.moverScopes.set(id, scope);
      this.nodes.set(id, el);
      this.content.append(el);
    }
    // Each mover sits as close as it can to the nodes it acts on.
    const along = V ? 'y' : 'x';
    const size = V ? MH + 14 : MW + 18;
    const wanted = movers.map((id) => {
      const targets = links.filter((l) => l.from === id).map((l) => target.get(l.to)[along] + (V ? NH : NW) / 2);
      return { id, at: targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length - (V ? MH : MW) / 2 : Infinity };
    });
    wanted.sort((a, b) => a.at - b.at);
    let cursor = -Infinity;
    const cross = V ? 2 * NW + 12 + 44 : -(MH + 74);
    const start = V ? 0 : stepX;
    for (const m of wanted) {
      const at = Math.max(Number.isFinite(m.at) ? m.at : Math.max(cursor, start), cursor, V ? 0 : -Infinity);
      cursor = at + size;
      target.set(m.id, V ? { x: cross, y: at, w: MW, h: MH } : { x: at, y: cross, w: MW, h: MH });
    }
    const addAt = Math.max(Number.isFinite(cursor) ? cursor : start, start);
    target.set('+', V ? { x: cross, y: addAt, w: MW, h: MH } : { x: addAt, y: cross, w: MW, h: MH });
    const firstMover = wanted.length ? target.get(wanted[0].id) : target.get('+');
    const lastAdd = target.get('+');
    this.planePos = V
      ? { x: cross - 12, y: firstMover.y - 46, w: MW + 24, h: lastAdd.y + MH + 12 - (firstMover.y - 46) }
      : { x: Math.min(firstMover.x, stepX) - 16, y: cross - 34, w: Math.max(340, lastAdd.x + MW + 16 - (Math.min(firstMover.x, stepX) - 16)), h: MH + 48 };

    // --- lines ---
    const filterOn = isOn(store, 'filter');
    const edgeDefs = [];
    for (const id of SOURCES) {
      if (!isOn(store, id)) continue;
      if (throughFilter(store, id)) edgeDefs.push({ from: id, to: 'filter', tap: info.tap[id] });
      else edgeDefs.push({ from: id, to: 'amp', tap: info.tap[id], around: 'filter' });
    }
    if (filterOn) edgeDefs.push({ from: 'filter', to: 'amp', tap: info.tap.filterOut });
    // A run of nodes one after the other; `tap` carries what enters the first.
    const run = (from, tap, ids, extra) => {
      for (const id of ids) {
        edgeDefs.push({ from, to: id, tap, ...extra });
        [from, tap] = [id, tapOf(store, id)];
      }
      return [from, tap];
    };
    let [last, lastTap] = run('amp', info.tap.mix, g.pre);
    if (g.split) {
      run(last, lastTap, [SPLIT]);
      const join = behind[0];
      for (const [lane, ids, tap] of [[1, g.a, info.tap.splitA], [2, g.b, info.tap.splitB]]) {
        const [end, endTap] = run(SPLIT, tap, ids);
        // A lane with nothing on it still carries its part of the sound.
        edgeDefs.push({ from: end, to: join, tap: endTap, lane: ids.length ? 0 : lane });
      }
      [last, lastTap] = run(join, tapOf(store, join), behind.slice(1));
    } else run(last, lastTap, behind);
    this.edges = edgeDefs.map((e) => ({
      ...e,
      level: -1,
      base: s('path', { class: `edge-base ${e.around ? 'around' : ''}` }),
      glow: s('path', { class: 'edge-glow' }),
      flow: s('path', { class: 'edge-flow' }),
    }));
    this.tethers = links.map((l) => {
      const badge = this.nodes.get(l.to).querySelector(`.buff[data-src="${l.key}"]`);
      return {
        ...l,
        // Where the tag sits on its node, in layout pixels. (All zero while
        // the board is not in the document yet; it lays out again once it is.)
        dx: badge.offsetLeft + badge.offsetWidth / 2 + badge.parentElement.offsetLeft,
        badge,
        path: s('path', { class: 'tether', stroke: modColor(l.key) }),
        src: sources.indexOf(l.key),
        level: -1,
      };
    });
    this.svg.replaceChildren(
      ...this.tethers.map((t) => t.path),
      ...this.edges.map((e) => e.base),
      ...this.edges.map((e) => e.glow),
      ...this.edges.map((e) => e.flow),
    );
    this.setSelected(this.selected);

    // --- move there ---
    this.target = target;
    cancelAnimationFrame(this.tween);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = new Map([...target.keys()].map((id) => [id, this.pos.get(id) ?? target.get(id)]));
    if (!animate || reduce || !this.pos.size) {
      this.pos = new Map(target);
      this.#place(this.pos);
    } else {
      const t0 = performance.now();
      const stepFrame = (now) => {
        const t = ease(clamp((now - t0) / 260));
        const cur = new Map();
        for (const [id, b] of target) {
          const a = from.get(id);
          cur.set(id, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: b.w, h: b.h });
        }
        this.pos = cur;
        this.#place(cur);
        if (t < 1) this.tween = requestAnimationFrame(stepFrame);
      };
      this.tween = requestAnimationFrame(stepFrame);
    }
    if (!this.userMoved) this.fit(animate && !reduce);
  }

  /** Puts nodes and lines at the given positions. */
  #place(pos) {
    const V = this.vertical;
    for (const [id, el] of this.nodes) {
      const p = pos.get(id);
      if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    const add = pos.get('+');
    this.addBtn.style.transform = `translate(${add.x}px, ${add.y}px)`;
    const pl = this.planePos;
    Object.assign(this.plane.style, { transform: `translate(${pl.x}px, ${pl.y}px)`, width: `${pl.w}px`, height: `${pl.h}px` });
    this.trayLabel.hidden = !this.trayPos.show;
    this.trayLabel.style.transform = `translate(${this.trayPos.x}px, ${this.trayPos.y}px)`;

    const outOf = (p) => (V ? [p.x + p.w / 2, p.y + p.h] : [p.x + p.w, p.y + p.h / 2]);
    const into = (p) => (V ? [p.x + p.w / 2, p.y] : [p.x, p.y + p.h / 2]);
    // The line each lane of the fork runs along, and its name tag on the way there.
    const fork = this.fork && pos.get(SPLIT);
    const laneLine = (lane) => (V ? fork.x + fork.w / 2 + (lane === 1 ? -1 : 1) * ((NW + 12) / 2) : fork.y + fork.h / 2 + (lane === 1 ? -LANE : LANE));
    if (fork) {
      const [fx, fy] = outOf(fork);
      this.laneTags.forEach((el, k) => {
        const line = laneLine(k + 1);
        const at = V ? [(fx + line) / 2, fy + LANE_GAP_V / 2] : [fx + GAP_X / 2, (fy + line) / 2];
        el.style.transform = `translate(${at[0]}px, ${at[1]}px) translate(-50%, -50%)`;
      });
    }
    for (const e of this.edges) {
      const a = outOf(pos.get(e.from));
      const b = into(pos.get(e.to));
      let d;
      if (e.lane) {
        // An empty lane: out to its line, along it, and back in.
        const line = laneLine(e.lane);
        if (V) {
          const k = LANE_GAP_V / 2;
          d = `M${a[0]} ${a[1]}C${a[0]} ${a[1] + k} ${line} ${a[1] + k} ${line} ${a[1] + 2 * k}L${line} ${b[1] - 2 * k}C${line} ${b[1] - k} ${b[0]} ${b[1] - k} ${b[0]} ${b[1]}`;
        } else {
          const k = GAP_X / 2;
          d = `M${a[0]} ${a[1]}C${a[0] + k} ${a[1]} ${a[0] + k} ${line} ${a[0] + 2 * k} ${line}L${b[0] - 2 * k} ${line}C${b[0] - k} ${line} ${b[0] - k} ${b[1]} ${b[0]} ${b[1]}`;
        }
      } else if (e.around) {
        // Around the filter: pass beside it rather than through it.
        const f = pos.get(e.around);
        if (V) {
          const side = a[0] < f.x + f.w / 2 ? f.x - 26 : f.x + f.w + 26;
          d = `M${a[0]} ${a[1]}C${a[0]} ${a[1] + 30} ${side} ${f.y - 30} ${side} ${f.y + f.h / 2}S${b[0]} ${b[1] - 40} ${b[0]} ${b[1]}`;
        } else {
          const side = a[1] < f.y + f.h / 2 ? f.y - 26 : f.y + f.h + 26;
          d = `M${a[0]} ${a[1]}C${a[0] + 40} ${a[1]} ${f.x - 40} ${side} ${f.x + f.w / 2} ${side}S${b[0] - 50} ${b[1]} ${b[0]} ${b[1]}`;
        }
      } else if (V) {
        const k = Math.max(18, (b[1] - a[1]) / 2);
        d = `M${a[0]} ${a[1]}C${a[0]} ${a[1] + k} ${b[0]} ${b[1] - k} ${b[0]} ${b[1]}`;
      } else if (b[0] < a[0]) {
        // The chain wraps: out to the right, down between the rows, back in.
        const mid = b[1] + (this.target.get(e.to).wrapDy ?? (a[1] - b[1]) / 2);
        d = rounded([a, [a[0] + 22, a[1]], [a[0] + 22, mid], [b[0] - 22, mid], [b[0] - 22, b[1]], b]);
      } else {
        const k = Math.max(22, (b[0] - a[0]) / 2);
        d = `M${a[0]} ${a[1]}C${a[0] + k} ${a[1]} ${b[0] - k} ${b[1]} ${b[0]} ${b[1]}`;
      }
      e.base.setAttribute('d', d);
      e.glow.setAttribute('d', d);
      e.flow.setAttribute('d', d);
    }
    for (const t of this.tethers) {
      const from = pos.get(t.from);
      const to = pos.get(t.to);
      if (!from || !to) continue;
      const bx = to.x + t.dx;
      const by = to.y - 9;
      let d;
      if (from.w === NW) {
        // The amp's own envelope reaching another node: up and over.
        const sx = from.x + from.w - 30;
        d = `M${sx} ${from.y}C${sx} ${from.y - 46} ${bx} ${by - 46} ${bx} ${by}`;
      } else if (V) {
        const sy = from.y + from.h / 2;
        d = `M${from.x} ${sy}C${from.x - 44} ${sy} ${bx} ${by - 40} ${bx} ${by}`;
      } else {
        const sx = from.x + from.w / 2;
        const sy = from.y + from.h;
        const k = Math.max(24, (by - sy) / 2);
        d = `M${sx} ${sy}C${sx} ${sy + k} ${bx} ${by - k} ${bx} ${by}`;
      }
      t.path.setAttribute('d', d);
    }
  }

  // --- view: pan, zoom, fit -----------------------------------------------------------

  #applyView(animate = false) {
    const { x, y, k } = this.view;
    this.content.classList.toggle('gliding', animate);
    this.content.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    // The dot grid moves with the board, like paper under the nodes.
    this.el.style.backgroundSize = `${24 * k}px ${24 * k}px`;
    this.el.style.backgroundPosition = `${x}px ${y}px`;
  }

  /** Zooms and centres so the whole graph is visible. */
  fit(animate) {
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    if (!w || !hgt || !this.target) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const grow = (p) => {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w);
      y1 = Math.max(y1, p.y + p.h);
    };
    // On a phone the effects that are off sit below the fold: fit what is in
    // use, and let the user scroll down to the rest.
    const idle = this.vertical ? new Set(fxSpares(this.app.store)) : new Set();
    for (const [id, p] of this.target) if (!idle.has(id)) grow(p);
    grow(this.planePos);
    const pad = this.vertical ? 18 : 30;
    const k = clamp(Math.min((w - pad * 2) / (x1 - x0), (hgt - pad * 2) / (y1 - y0)), 0.3, 1.15);
    // Centred; on a phone the graph starts at the top, since it continues below.
    const top = this.vertical ? pad : (hgt - (y1 - y0) * k) / 2;
    this.view = { k, x: (w - (x1 - x0) * k) / 2 - x0 * k, y: top - y0 * k };
    this.userMoved = false;
    this.#applyView(animate);
  }

  #zoomAt(cx, cy, factor) {
    const v = this.view;
    const k = clamp(v.k * factor, 0.3, 2);
    const f = k / v.k;
    this.view = { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    this.userMoved = true;
    this.#applyView();
  }

  #zoomBy(factor) {
    this.#zoomAt(this.el.clientWidth / 2, this.el.clientHeight / 2, factor);
    this.content.classList.add('gliding');
  }

  #bindGestures() {
    const el = this.el;
    const pointers = new Map();
    let gesture = null;
    const local = (e) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const begin = () => {
      const pts = [...pointers.values()];
      if (pts.length === 1) gesture = { kind: 'pan', start: pts[0], view: { ...this.view }, moved: false };
      else if (pts.length === 2) {
        const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
        gesture = { kind: 'pinch', dist: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), mid, view: { ...this.view }, moved: true };
      }
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.board-tools')) return;
      pointers.set(e.pointerId, local(e));
      begin();
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !gesture) return;
      pointers.set(e.pointerId, local(e));
      const pts = [...pointers.values()];
      if (gesture.kind === 'pan' && pts.length === 1) {
        const dx = pts[0][0] - gesture.start[0];
        const dy = pts[0][1] - gesture.start[1];
        if (!gesture.moved && Math.hypot(dx, dy) < 7) return;
        if (!gesture.moved) {
          gesture.moved = true;
          // From here on it is a drag of the board, not a press on a node.
          el.setPointerCapture(e.pointerId);
          el.classList.add('panning');
        }
        this.view = { k: gesture.view.k, x: gesture.view.x + dx, y: gesture.view.y + dy };
        this.userMoved = true;
        this.#applyView();
      } else if (gesture.kind === 'pinch' && pts.length === 2) {
        const dist = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
        const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
        const k = clamp((gesture.view.k * dist) / gesture.dist, 0.3, 2);
        const f = k / gesture.view.k;
        this.view = { k, x: mid[0] - (gesture.mid[0] - gesture.view.x) * f, y: mid[1] - (gesture.mid[1] - gesture.view.y) * f };
        this.userMoved = true;
        this.#applyView();
      }
    });
    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (gesture?.moved) {
        // The press that ends a drag must not also open a node. The click, if
        // there is one, follows immediately; afterwards the guard is removed.
        const swallow = (ev) => ev.stopPropagation();
        el.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => el.removeEventListener('click', swallow, true), 0);
      }
      el.classList.remove('panning');
      gesture = null;
      if (pointers.size) begin();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [cx, cy] = local(e);
        // Trackpad pinches arrive as many small steps, wheel notches as few
        // large ones: scale each so both feel the same.
        if (e.ctrlKey || e.metaKey) this.#zoomAt(cx, cy, Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 40 ? 0.01 : 0.0022)));
        else {
          this.view = { ...this.view, x: this.view.x - e.deltaX, y: this.view.y - e.deltaY };
          this.userMoved = true;
          this.#applyView();
        }
      },
      { passive: false },
    );
  }

  // --- life ----------------------------------------------------------------------

  /** Every frame: the sound line brightens with the level passing through it,
   * and movers and their tags pulse with their current value. */
  #frame(live) {
    const scopes = this.app.scopes;
    for (const e of this.edges) {
      const level = Math.min(1, Math.sqrt(scopes.level(e.tap)) * 1.6);
      if (Math.abs(level - e.level) > 0.02) {
        e.level = level;
        e.glow.style.opacity = level.toFixed(2);
        e.flow.style.opacity = Math.min(1, level * 1.2).toFixed(2);
      }
    }
    const seen = new Map();
    for (const t of this.tethers) {
      const v = clamp(live.source(t.src));
      if (Math.abs(v - t.level) > 0.02) {
        t.level = v;
        t.badge.style.setProperty('--v', v.toFixed(2));
      }
      seen.set(t.key, v);
    }
    for (const id of this.moverScopes.keys()) {
      const el = this.nodes.get(id);
      const v = seen.get(id) ?? clamp(live.source(this.app.store.info.sources.indexOf(id)));
      if (Math.abs(v - (el.level ?? -1)) > 0.02) {
        el.level = v;
        el.style.setProperty('--v', v.toFixed(2));
      }
    }
  }
}
