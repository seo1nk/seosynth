// Modulation routing: connecting sources (envelopes, LFOs, macros...) to
// knobs by drag and drop, and editing or removing those connections.

import { h, clamp, drag } from './dom.js';
import { SOURCE_COLORS } from './controls.js';

export class Mods {
  constructor(app) {
    this.app = app;
    this.assigning = 0;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.assigning) this.#endAssign();
    });
  }

  #srcKey(src) {
    return this.app.store.info.sources[src];
  }

  describe(slot) {
    const { store, i18n } = this.app;
    return `${i18n.sourceName(this.#srcKey(slot.src))} → ${i18n.paramTitle(store.def(slot.dst).key)}`;
  }

  /** Connects a source to a knob with a sensible starting amount. */
  connect(src, dst) {
    const { store, i18n } = this.app;
    if (!store.def(dst).mod) return;
    const existing = store.slots.findIndex((s) => s.src === src && s.dst === dst);
    if (existing < 0) {
      // A knob near its top has no room to go up, so start by pulling it
      // down: otherwise the new connection would seem to do nothing.
      const amount = store.get(dst) > 0.7 ? -0.4 : 0.3;
      if (store.addMod(src, dst, amount, false) < 0) {
        this.app.toast(i18n.t('matrix.full'));
        return;
      }
      store.commit();
    }
    this.app.toast(
      i18n.t('modhint.connected', { src: i18n.sourceName(this.#srcKey(src)), dst: i18n.paramTitle(store.def(dst).key) }),
    );
    this.app.flash(dst);
  }

  /**
   * The draggable ● of a modulation source. Drag it onto a knob, or click
   * it and then click the knob.
   */
  sourceChip(srcKey, { label = false } = {}) {
    const { store, i18n } = this.app;
    const src = store.info.sources.indexOf(srcKey);
    const name = i18n.sourceName(srcKey);
    const el = h(
      'button',
      {
        type: 'button',
        class: `mod-src ${label ? 'with-label' : ''}`,
        'aria-label': name,
        dataset: { src },
        style: { '--c': SOURCE_COLORS[src] },
      },
      h('span', { class: 'mod-src-dot' }),
      label ? h('span', { class: 'mod-src-name' }, name) : null,
    );
    let ghost = null;
    let target = null;
    let moved = false;
    const knobAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.knob[data-mod]') ?? null;
    drag(el, {
      onStart: (e) => {
        moved = false;
        target = null;
        ghost = h('div', { class: 'mod-ghost', style: { '--c': SOURCE_COLORS[src] } }, h('span', { class: 'mod-src-dot' }), name);
        document.body.append(ghost);
        ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
        this.app.root.classList.add('mod-dragging');
        this.app.help.show({ title: name, body: i18n.t('modhint.drag') });
        this.highlight(src);
      },
      onMove: (dx, dy, e) => {
        if (Math.hypot(dx, dy) > 5) moved = true;
        ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
        const next = knobAt(e.clientX, e.clientY);
        if (next !== target) {
          target?.classList.remove('drop-hot');
          target = next;
          target?.classList.add('drop-hot');
        }
      },
      onEnd: () => {
        ghost?.remove();
        ghost = null;
        this.app.root.classList.remove('mod-dragging');
        this.highlight(0);
        if (target) {
          target.classList.remove('drop-hot');
          this.connect(src, Number(target.dataset.param));
        } else if (!moved) {
          this.#beginAssign(src);
        }
      },
    });
    el.addEventListener('pointerenter', () => !this.app.root.classList.contains('mod-dragging') && this.highlight(src));
    el.addEventListener('pointerleave', () => !this.app.root.classList.contains('mod-dragging') && this.highlight(0));
    this.app.help.attach(el, () => ({
      title: name,
      body: [i18n.sourceHelp(srcKey), i18n.t('hint.modSource', { name })].filter(Boolean).join(' '),
    }));
    return el;
  }

  /** Emphasises the wires of one source (0 = none). */
  highlight(src) {
    this.app.cables?.highlight(src);
  }

  // Click-to-assign, for touch screens and anyone who prefers not to drag.
  #beginAssign(src) {
    const { i18n } = this.app;
    this.#endAssign();
    this.assigning = src;
    this.app.root.classList.add('mod-dragging');
    this.app.toast(i18n.t('modhint.assign'), 6000);
    this.highlight(src);
    this.onAssignClick = (e) => {
      const chip = e.target.closest?.('.mod-src');
      if (chip) return; // picking another source restarts via its own handler
      const knob = e.target.closest?.('.knob[data-mod]');
      e.preventDefault();
      e.stopPropagation();
      const chosen = this.assigning;
      this.#endAssign();
      if (knob) this.connect(chosen, Number(knob.dataset.param));
    };
    // Capture phase so the knob itself does not start a drag.
    document.addEventListener('pointerdown', this.onAssignClick, true);
  }

  #endAssign() {
    if (!this.assigning) return;
    this.assigning = 0;
    document.removeEventListener('pointerdown', this.onAssignClick, true);
    this.app.root.classList.remove('mod-dragging');
    this.highlight(0);
  }

  /** The small coloured dot next to a knob for one routing. */
  badge(index) {
    const { store, i18n } = this.app;
    const slot = () => store.slots[index];
    const el = h('button', { type: 'button', class: 'mod-badge', style: { '--c': SOURCE_COLORS[slot().src] }, 'aria-label': this.describe(slot()) });
    let start = 0;
    drag(el, {
      cursor: 'ns-resize',
      onStart: (e) => {
        e.stopPropagation();
        start = slot().amount;
      },
      onMove: (_dx, dy, e) => {
        const amount = clamp(start - dy / (e.shiftKey ? 800 : 120), -1, 1);
        store.setSlot(index, { ...slot(), amount });
        this.app.help.show(this.#badgeHelp(index));
      },
      onEnd: () => store.commit(),
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      store.clearSlot(index);
      store.commit();
      this.app.toast(i18n.t('modhint.removed'));
    });
    el.addEventListener('pointerenter', () => this.highlight(slot().src));
    el.addEventListener('pointerleave', () => this.highlight(0));
    this.app.help.attach(el, () => this.#badgeHelp(index));
    return el;
  }

  #badgeHelp(index) {
    const s = this.app.store.slots[index];
    if (!s || s.src === 0) return null;
    return {
      title: this.describe(s),
      body: this.app.i18n.t('hint.modAmount'),
      value: `${s.amount >= 0 ? '+' : ''}${Math.round(s.amount * 100)}%${s.bipolar ? ' ±' : ''}`,
    };
  }

  /** One editable line for a routing: amount slider, direction, remove. */
  routingRow(index, { showTarget = true } = {}) {
    const { store, i18n } = this.app;
    const s = store.slots[index];
    const slider = h('input', {
      type: 'range',
      min: -100,
      max: 100,
      step: 1,
      value: Math.round(s.amount * 100),
      'aria-label': i18n.t('matrix.amount'),
      oninput: () => {
        store.setSlot(index, { ...store.slots[index], amount: Number(slider.value) / 100 });
        amount.textContent = `${slider.value > 0 ? '+' : ''}${slider.value}%`;
      },
      onchange: () => store.commit(),
    });
    const amount = h('span', { class: 'route-amount' }, `${s.amount >= 0 ? '+' : ''}${Math.round(s.amount * 100)}%`);
    const bipolar = h(
      'button',
      {
        type: 'button',
        class: `toggle small ${s.bipolar ? 'on' : ''}`,
        title: i18n.t('matrix.bipolar.help'),
        onclick: () => {
          const cur = store.slots[index];
          store.setSlot(index, { ...cur, bipolar: !cur.bipolar });
          bipolar.classList.toggle('on', !cur.bipolar);
          store.commit();
        },
      },
      '±',
    );
    return h(
      'div',
      { class: 'route-row', style: { '--c': SOURCE_COLORS[s.src] } },
      h('span', { class: 'mod-src-dot' }),
      h('span', { class: 'route-name' }, showTarget ? this.describe(s) : i18n.sourceName(this.#srcKey(s.src))),
      slider,
      amount,
      bipolar,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          title: i18n.t('matrix.remove'),
          'aria-label': i18n.t('matrix.remove'),
          onclick: () => {
            store.clearSlot(index);
            store.commit();
          },
        },
        '×',
      ),
    );
  }

  /** Right-click menu of a knob. */
  knobMenu(i, anchor) {
    const { store, i18n } = this.app;
    const p = store.def(i);
    const body = h('div', { class: 'menu' });
    const sig = () => store.modsFor(i).map((m) => `${m.index}:${m.src}`).join();
    let last = null;
    const render = () => {
      if (sig() === last) return;
      last = sig();
      const mods = store.modsFor(i);
      const items = [
        h('div', { class: 'menu-title' }, i18n.paramTitle(p.key)),
        h('button', { type: 'button', class: 'menu-item', onclick: () => { store.reset(i); store.commit(); close(); } }, i18n.t('menu.reset')),
        p.curve === 'bool' || p.curve === 'enum'
          ? null
          : h('button', { type: 'button', class: 'menu-item', onclick: () => { close(); this.#enterValue(i); } }, i18n.t('menu.enter')),
        mods.length ? h('div', { class: 'menu-sub' }, i18n.t('menu.mods')) : null,
        mods.map((m) => this.routingRow(m.index, { showTarget: false })),
        p.mod ? h('div', { class: 'menu-sub' }, i18n.t('menu.addMod')) : null,
        p.mod
          ? h(
              'div',
              { class: 'menu-sources' },
              store.info.sources.slice(1).map((key, k) =>
                h(
                  'button',
                  { type: 'button', class: 'menu-source', style: { '--c': SOURCE_COLORS[k + 1] }, onclick: () => this.connect(k + 1, i) },
                  h('span', { class: 'mod-src-dot' }),
                  i18n.sourceName(key),
                ),
              ),
            )
          : null,
      ];
      body.replaceChildren(...items.flat().filter(Boolean));
    };
    render();
    const off = store.on('slots', render);
    const close = this.app.popover(anchor, body, { onClose: off });
  }

  #enterValue(i) {
    const { store, i18n } = this.app;
    const text = window.prompt(`${i18n.paramTitle(store.def(i).key)} — ${i18n.t('menu.enter.prompt')}`, String(Number(store.getPlain(i).toPrecision(5))));
    if (text === null) return;
    const v = Number(String(text).replace(',', '.').replace(/[^0-9eE+\-.]/g, ''));
    if (Number.isFinite(v)) {
      const p = store.def(i);
      // Percent parameters are typed as 0..100.
      store.setPlain(i, p.unit === '%' ? v / 100 : v);
      store.commit();
    }
  }

  /** The list of all routings in plain words. */
  matrixPanel() {
    const { store, i18n } = this.app;
    const list = h('div', { class: 'route-list' });
    let last = null;
    const render = () => {
      const slots = store.activeSlots();
      const sig = slots.map((m) => `${m.index}:${m.src}:${m.dst}`).join();
      if (sig === last) return;
      last = sig;
      list.replaceChildren(
        ...(slots.length ? slots.map((m) => this.routingRow(m.index)) : [h('p', { class: 'empty' }, i18n.t('matrix.empty'))]),
      );
    };
    render();
    const off = store.on('slots', render);
    this.app.dialog(i18n.t('matrix.title'), list, { onClose: off, wide: true });
  }
}
