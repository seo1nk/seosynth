// Connecting things that move (LFOs, envelopes, macros, how you play) to
// sliders, and editing or removing those connections.

import { h } from './dom.ts';
import { modColor } from '../theme.ts';
import { nodeOfParam, nodeOfSource, movableParams, movableNodes } from './nodes.ts';
import type { App } from '../app.ts';
import type { Slot } from '../engine/types.ts';
import type { ActiveSlot } from '../store.ts';

/** What a connection line is labelled with: the source, the target or both. */
type RouteLabel = 'source' | 'target' | 'both';

export class Mods {
  readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  key(src: number): string {
    return this.app.store.info.sources[src];
  }

  color(src: number): string {
    return modColor(this.key(src));
  }

  describe(slot: Pick<Slot, 'src' | 'dst'>): string {
    const { store, i18n } = this.app;
    return i18n.t('mod.sentence', { src: i18n.sourceName(this.key(slot.src)), dst: i18n.paramTitle(store.def(slot.dst).key) });
  }

  /** Connects a source to a slider with a sensible starting amount. */
  connect(src: number, dst: number): boolean {
    const { store, i18n } = this.app;
    if (!store.def(dst).mod) return false;
    if (store.slots.findIndex((s) => s.src === src && s.dst === dst) < 0) {
      // A slider near its top has no room to go up, so start by pulling it
      // down: otherwise the new connection would seem to do nothing.
      const amount = store.get(dst) > 0.7 ? -0.4 : 0.3;
      if (store.addMod(src, dst, amount, false) < 0) {
        this.app.toast(i18n.t('matrix.full', { n: store.info.numSlots }));
        return false;
      }
      store.commit();
    }
    this.app.toast(this.describe({ src, dst }));
    return true;
  }

  /** Removes every connection made by one source. */
  disconnectAll(src: number): void {
    const { store } = this.app;
    for (const slot of store.activeSlots()) if (slot.src === src) store.clearSlot(slot.index);
    store.commit();
  }

  /** The coloured dot next to a slider for one connection. */
  badge(index: number): HTMLButtonElement {
    const { store } = this.app;
    const s = store.slots[index];
    const el = h('button', {
      type: 'button',
      class: 'mod-badge',
      style: { '--c': this.color(s.src) },
      'aria-label': this.describe(s),
      onclick: () => this.controlMenu(s.dst, el),
    });
    this.app.help.attach(el, () => {
      const cur = store.slots[index];
      if (!cur || cur.src === 0) return null;
      return { title: this.describe(cur), body: this.app.i18n.t('hint.modAmount'), value: this.#amountText(cur) };
    });
    return el;
  }

  #amountText(s: Slot): string {
    return `${s.amount >= 0 ? '+' : ''}${Math.round(s.amount * 100)}%`;
  }

  /**
   * One editable line for a connection: how far it moves the slider, in
   * which direction, and a button to remove it.
   * `show` picks what the line is labelled with: the source or the target.
   */
  routingRow(index: number, { show = 'both' }: { show?: RouteLabel } = {}): HTMLElement {
    const { store, i18n } = this.app;
    const s = store.slots[index];
    const amount = h('output', { class: 'route-amount' }, this.#amountText(s));
    const slider = h('input', {
      type: 'range',
      min: -100,
      max: 100,
      step: 1,
      value: Math.round(s.amount * 100),
      'aria-label': i18n.t('matrix.amount'),
      oninput: () => {
        const next = { ...store.slots[index], amount: Number(slider.value) / 100 };
        store.setSlot(index, next);
        amount.textContent = this.#amountText(next);
      },
      onchange: () => store.commit(),
    });
    const both = h(
      'button',
      {
        type: 'button',
        class: 'chip-toggle',
        'aria-pressed': String(s.bipolar),
        title: i18n.t('matrix.bipolar.help'),
        onclick: () => {
          const cur = store.slots[index];
          store.setSlot(index, { ...cur, bipolar: !cur.bipolar });
          both.setAttribute('aria-pressed', String(!cur.bipolar));
          store.commit();
        },
      },
      i18n.t('matrix.bipolar'),
    );
    const sourceKey = this.key(s.src);
    const targetKey = store.def(s.dst).key;
    const link = (text: string, node: string) => h('button', { type: 'button', class: 'link', onclick: () => this.app.select(node) }, text);
    const name =
      show === 'source'
        ? link(i18n.sourceName(sourceKey), nodeOfSource(sourceKey))
        : show === 'target'
          ? link(i18n.paramTitle(targetKey), nodeOfParam(targetKey))
          : h('span', {}, this.describe(s));
    return h(
      'div',
      { class: 'route-row', style: { '--c': this.color(s.src) } },
      h('div', { class: 'route-head' }, h('span', { class: 'mod-dot' }), h('span', { class: 'route-name' }, name), amount),
      h(
        'div',
        { class: 'route-controls' },
        slider,
        both,
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
      ),
    );
  }

  /**
   * A list of connections that keeps itself up to date.
   * `filter(slot)` picks which ones; `empty` is shown when there are none.
   */
  routeList({ filter, show, empty }: { filter: (slot: ActiveSlot) => boolean; show?: RouteLabel; empty?: string }): { el: HTMLElement; render: () => void } {
    const { store } = this.app;
    const list = h('div', { class: 'route-list' });
    let last: string | null = null;
    const render = () => {
      const slots = store.activeSlots().filter(filter);
      const sig = slots.map((m) => `${m.index}:${m.src}:${m.dst}`).join();
      if (sig === last) return;
      last = sig;
      list.replaceChildren(...(slots.length ? slots.map((m) => this.routingRow(m.index, { show })) : empty ? [h('p', { class: 'empty' }, empty)] : []));
    };
    render();
    return { el: list, render };
  }

  /**
   * "Connect to..." form for a source: pick a node, then one of its sliders.
   * This is how a mover is tied to a node of the signal path.
   */
  linkForm(sourceKey: string): HTMLFormElement {
    const { store, i18n } = this.app;
    const src = store.info.sources.indexOf(sourceKey);
    const nodes = movableNodes(store).filter((id) => movableParams(store, id).length);
    const nodeSel = h('select', { 'aria-label': i18n.t('link.node') }, nodes.map((id) => h('option', { value: id }, i18n.nodeName(id))));
    const paramSel = h('select', { 'aria-label': i18n.t('link.param') });
    const fill = () => {
      paramSel.replaceChildren(...movableParams(store, nodeSel.value).map((p) => h('option', { value: p.i }, i18n.paramLabel(p.key))));
    };
    nodeSel.addEventListener('change', fill);
    // Start on the filter cutoff: the classic first thing to move.
    if (nodes.includes('filter')) nodeSel.value = 'filter';
    fill();
    const cutoff = [...paramSel.options].find((o) => store.def(Number(o.value)).key === 'filter.cutoff');
    if (cutoff) paramSel.value = cutoff.value;
    return h(
      'form',
      {
        class: 'link-form',
        onsubmit: (e) => {
          e.preventDefault();
          this.connect(src, Number(paramSel.value));
        },
      },
      h('label', {}, h('span', {}, i18n.t('link.node')), nodeSel),
      h('label', {}, h('span', {}, i18n.t('link.param')), paramSel),
      h('button', { type: 'submit', class: 'btn primary' }, i18n.t('link.connect')),
    );
  }

  /** "What moves this slider" pop-over, opened from the + next to it. */
  controlMenu(i: number, anchor: HTMLElement): void {
    const { store, i18n } = this.app;
    const p = store.def(i);
    const routes = this.routeList({ filter: (s) => s.dst === i, show: 'source' });
    const choices = h('div', { class: 'source-list' });
    const renderChoices = () => {
      const taken = new Set(store.modsFor(i).map((m) => m.src));
      choices.replaceChildren(
        ...store.info.sources
          .slice(1)
          .map((key, k) =>
            taken.has(k + 1)
              ? null
              : h(
                  'button',
                  { type: 'button', class: 'source-choice', style: { '--c': this.color(k + 1) }, onclick: () => this.connect(k + 1, i) },
                  h('span', { class: 'mod-dot' }),
                  h('span', { class: 'source-name' }, i18n.sourceName(key)),
                  h('span', { class: 'source-what' }, i18n.sourceHelp(key)),
                ),
          )
          .filter((el) => el !== null),
      );
    };
    renderChoices();
    const body = h(
      'div',
      { class: 'menu control-menu' },
      h('div', { class: 'menu-title' }, i18n.t('mod.menuTitle', { name: i18n.paramTitle(p.key) })),
      routes.el,
      h('div', { class: 'menu-sub' }, i18n.t('mod.choose')),
      choices,
      h('div', { class: 'menu-rule' }),
      h('button', { type: 'button', class: 'menu-item', onclick: () => { store.reset(i); store.commit(); } }, i18n.t('menu.reset')),
    );
    const off = store.on('slots', () => {
      routes.render();
      renderChoices();
    });
    this.app.popover(anchor, body, { onClose: off });
  }

  enterValue(i: number): void {
    const { store, i18n } = this.app;
    const p = store.def(i);
    if (p.curve === 'bool' || p.curve === 'enum') return;
    const shown = p.unit === '%' ? store.getPlain(i) * 100 : store.getPlain(i);
    const text = window.prompt(`${i18n.paramTitle(p.key)}: ${i18n.t('menu.enter.prompt')}`, String(Number(shown.toPrecision(5))));
    if (text === null) return;
    const v = Number(String(text).replace(',', '.').replace(/[^0-9eE+\-.]/g, ''));
    if (Number.isFinite(v)) {
      store.setPlain(i, p.unit === '%' ? v / 100 : v);
      store.commit();
    }
  }

  /** Every connection in the sound, in plain sentences. */
  matrixPanel(): void {
    const { store, i18n } = this.app;
    const routes = this.routeList({ filter: () => true, show: 'both', empty: i18n.t('matrix.empty') });
    const off = store.on('slots', routes.render);
    this.app.dialog(i18n.t('matrix.title'), routes.el, { onClose: off, wide: true });
  }
}
