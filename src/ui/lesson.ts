// The lesson card: walks through building a preset from the init sound.
//
// The steps come from src/lesson.ts. Each step opens the node it is about,
// lists the values to set and ticks them off as the sound reaches them,
// and points at the next control to touch. "Set them all" sets the step.

import type { App } from '../app.ts';
import { h, type Child } from './dom.ts';
import { PRESETS, presetTitle, type Preset } from '../presets.ts';
import { lessonSteps, lessonStart, hasPrepared, isDone, applyTarget, type LessonStep, type Target } from '../lesson.ts';
import { formatValue } from '../format.ts';
import { isMover } from './nodes.ts';

const hasPopover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
const FOCUS = 'lesson-focus';
/** Settings under "Play settings" by the keyboard. */
const PLAY_KEYS = new Set(['master.mono', 'master.legato', 'master.porta', 'master.portaAlways', 'master.voices', 'master.bendRange']);
/** Phone widths, where the node's settings are a sheet over the board. */
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 47.5em)').matches;

export class Lesson {
  readonly app: App;
  preset: Preset | null = null;
  steps: LessonStep[] = [];
  /** 0 is the introduction, 1..steps.length the steps, then the end. */
  step = -1;
  collapsed = false;
  el: HTMLElement | null = null;
  timer: ReturnType<typeof setInterval> | undefined;
  /** The control last pointed at, scrolled into view once. */
  #pointed: Element | null = null;

  constructor(app: App) {
    this.app = app;
  }

  get active(): boolean {
    return this.step >= 0;
  }

  /** Starts building preset `index` from the init sound. */
  start(index: number): void {
    const { app } = this;
    const { store, i18n } = app;
    const preset = PRESETS[index];
    app.tour.stop();
    this.stop();
    this.preset = preset;
    // On a phone the card starts folded, so the sheet under it stays usable.
    this.collapsed = narrow();
    this.steps = lessonSteps(preset, store);
    app.loading = true;
    try {
      store.fromJSON(lessonStart(preset, presetTitle(preset, i18n.lang)));
    } finally {
      app.loading = false;
    }
    // The demo still plays the phrase that suits this sound.
    app.presetIndex = index;
    app.select(null);
    app.toast(i18n.t('lesson.started'), 5000);
    this.go(0);
    app.onPresetChange?.();
  }

  stop(): void {
    this.step = -1;
    clearInterval(this.timer);
    this.el?.remove();
    this.el = null;
    this.#unfocus();
    this.app.onPresetChange?.();
  }

  #unfocus() {
    this.#pointed = null;
    for (const el of document.querySelectorAll(`.${FOCUS}`)) el.classList.remove(FOCUS);
  }

  /** Removes the outline but remembers what was pointed at, so it is not scrolled to again. */
  #clearOutline() {
    for (const el of document.querySelectorAll(`.${FOCUS}`)) el.classList.remove(FOCUS);
  }

  /** The words for one target: what to set and to what. */
  #describe(t: Target): string {
    const { store, i18n } = this.app;
    if (t.kind === 'mod') {
      const sentence = i18n.t('mod.sentence', { src: i18n.sourceName(t.source), dst: i18n.paramTitle(t.target) });
      const amount = `${t.amount > 0 && t.bipolar ? '±' : ''}${Math.round(t.amount * 100)}%`;
      const both = t.bipolar ? (i18n.lang === 'ja' ? `（${i18n.t('matrix.bipolar')}）` : ` (${i18n.t('matrix.bipolar')})`) : '';
      return i18n.t('lesson.mod', { sentence, amount: amount + both });
    }
    const p = store.def(store.idx(t.key));
    const plain = p.curve === 'enum' ? p.options.indexOf(String(t.value)) : typeof t.value === 'boolean' ? Number(t.value) : Number(t.value);
    const value = formatValue(p, plain, (o) => i18n.option(o));
    // Arpeggio and clip settings are not inside a node: say whose they are.
    const label = this.steps[this.step - 1]?.node === 'keys' || t.key.startsWith('master.') ? i18n.paramTitle(t.key) : i18n.paramLabel(t.key);
    return `${label}${i18n.lang === 'ja' ? '：' : ': '}${value}`;
  }

  /** The name of the folded place a setting is in, '' when it is in plain sight. */
  #where(key: string): string {
    const { i18n } = this.app;
    if (PLAY_KEYS.has(key)) return i18n.t('kb.settings');
    const summary = this.#control(key)?.closest('details')?.querySelector('summary');
    return summary?.textContent?.trim() ?? '';
  }

  #title(node: string): string {
    const { i18n } = this.app;
    if (node === 'keys') return i18n.t('lesson.keys');
    return isMover(node) ? i18n.sourceName(node) : i18n.nodeName(node);
  }

  #role(node: string): string {
    const { i18n } = this.app;
    if (node === 'keys') return i18n.t('lesson.keys.role');
    return isMover(node) ? i18n.sourceHelp(node) : i18n.nodeRole(node);
  }

  /** Opens what a step is about. */
  #open(step: LessonStep) {
    const { app } = this;
    if (step.node === 'keys') {
      app.select(null);
      app.toggleKeyboard(true);
    } else app.select(step.node);
  }

  /** The control of a parameter where it is shown now: a node's panel, the
   * drawer by the keys, or the play settings. */
  #control(key: string): Element | null {
    return document.querySelector(`.panel [data-key="${key}"], .kb-drawer [data-key="${key}"], .play-settings [data-key="${key}"]`);
  }

  /** The element to touch for a target, opening a folded section if needed. */
  #targetEl(t: Target): Element | null {
    const scope = document;
    if (t.kind === 'mod') {
      // Not connected yet: the form that connects; connected: its line, to set the amount.
      const { store } = this.app;
      const src = store.info.sources.indexOf(t.source);
      const dst = store.idx(t.target);
      const slot = store.activeSlots().find((s) => s.src === src && s.dst === dst);
      return scope.querySelector(slot ? `.panel .route-row[data-slot="${slot.index}"]` : '.panel .link-form');
    }
    if (t.key === 'arp.on' || t.key === 'clip.on') return scope.querySelector('.kb-mode');
    const ctl = this.#control(t.key);
    const fold = ctl?.closest('details');
    if (fold && !fold.open) fold.open = true;
    if (ctl) return ctl;
    // Play settings open from their button by the keyboard.
    if (t.key.startsWith('master.')) return scope.querySelector('.kb-settings-btn');
    // The arpeggiator's or the clip's settings: in the drawer by the keys.
    if (t.key.startsWith('arp.') || t.key.startsWith('clip.')) return scope.querySelector('.kb-drawer-btn:not([hidden])') ?? scope.querySelector('.kb-mode');
    // A switch in the node's head on the board.
    if (t.key.endsWith('.on')) return scope.querySelector(`.node[data-node="${t.key.slice(0, -3)}"] .switch`);
    return null;
  }

  /** Points at the first thing in this step that is not done yet. */
  #point(step: LessonStep, done: boolean[]) {
    this.#clearOutline();
    const { app } = this;
    const next = step.targets.findIndex((_, k) => !done[k]);
    if (next < 0) return;
    // The node's settings are closed: point at the node itself first.
    const el =
      step.node !== 'keys' && app.selected !== step.node
        ? document.querySelector(`.node[data-node="${step.node}"], .mover[data-node="${step.node}"]`)
        : this.#targetEl(step.targets[next]);
    if (!el) return;
    el.classList.add(FOCUS);
    // Bring a control that has moved on into view, once: the panel may be
    // scrolled past it, or on a phone it may be below the fold of the sheet.
    // Not on the board, which pans by itself and must not scroll.
    if (el !== this.#pointed) {
      this.#pointed = el;
      if (el.closest('.panel, .kb-drawer')) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  }

  #place() {
    if (!this.el) return;
    const board = document.querySelector('.board')?.getBoundingClientRect();
    const r = this.el.getBoundingClientRect();
    // On a phone the settings open as a sheet over the bottom of the board,
    // and the keys at the bottom of the screen: the card goes up top, out of their way.
    const def = this.steps[this.step - 1];
    const below = !!document.querySelector('.panel-slot.open') || (def?.node === 'keys' && this.step <= this.steps.length);
    if (board && narrow() && below) {
      this.el.style.left = '8px';
      this.el.style.top = `${Math.max(8, board.top + 8)}px`;
      return;
    }
    // Bottom left of the board, over the hint, clear of the panel on the right.
    const left = board ? board.left + 12 : 8;
    const bottom = board ? board.bottom - 12 : window.innerHeight - 8;
    this.el.style.left = `${Math.max(8, left)}px`;
    this.el.style.top = `${Math.max(8, bottom - r.height)}px`;
  }

  go(step: number): void {
    const { app } = this;
    const { store, i18n } = app;
    const t = i18n.t;
    const preset = this.preset;
    if (!preset) return;
    clearInterval(this.timer);
    this.el?.remove();
    this.#unfocus();
    const last = this.steps.length + 1;
    if (step < 0 || step > last) return this.stop();
    this.step = step;
    const name = presetTitle(preset, i18n.lang);
    const lang = i18n.lang === 'ja' ? 0 : 1;
    const def = step >= 1 && step < last ? this.steps[step - 1] : null;
    if (def) this.#open(def);
    // On a phone the card takes the top of the board, where notices show.
    if (def && narrow()) app.toast.clear();

    const btn = (label: string, onclick: () => void, cls = 'btn') => h('button', { type: 'button', class: cls, onclick }, label);
    const check = h('span', { class: 'tour-check', hidden: true }, t('tour.did'));
    // Where a setting is out of sight, the list says so: inside a folded
    // section of the panel, or under the play settings by the keys.
    const wheres = def ? def.targets.map(() => h('span', { class: 'lesson-where', hidden: true })) : [];
    const items = def ? def.targets.map((target, k) => h('li', {}, h('span', { class: 'lesson-mark', 'aria-hidden': 'true' }), h('span', {}, this.#describe(target), wheres[k]))) : [];
    // Folded, the card keeps only the next thing to do and the buttons.
    const nowMark = h('span', { class: 'lesson-mark', 'aria-hidden': 'true' });
    const nowText = h('span', {});
    const nowCount = h('span', { class: 'lesson-count' });
    const now = def ? h('p', { class: 'lesson-now', 'aria-live': 'polite' }, nowMark, nowText, nowCount) : null;
    let opener: HTMLElement | null = null;
    let body: Child[];
    let actions: Child[];
    if (step === 0) {
      body = [
        h('p', {}, t('lesson.intro.body', { n: this.steps.length, name })),
        hasPrepared(preset) ? h('p', {}, t('lesson.intro.prepared')) : null,
      ];
      actions = [btn(t('lesson.end'), () => this.stop(), 'btn quiet'), btn(t('lesson.start'), () => this.go(1), 'btn primary')];
    } else if (def) {
      const tip = preset.lesson?.[def.node];
      opener = def.node !== 'keys' ? h('p', { class: 'lesson-open' }, t('lesson.open', { name: this.#title(def.node) })) : null;
      body = [h('p', {}, this.#role(def.node)), tip ? h('p', { class: 'lesson-tip' }, tip[lang]) : null, opener, h('ul', { class: 'lesson-list' }, items)];
      actions = [
        btn(t('tour.back'), () => this.go(step - 1)),
        btn(t('lesson.doIt'), () => {
          for (const target of def.targets) applyTarget(store, target);
          store.commit();
        }),
        btn(t('tour.next'), () => this.go(step + 1), 'btn primary'),
      ];
    } else {
      body = [preset.note ? h('p', { class: 'lesson-tip' }, preset.note[lang]) : null, h('p', {}, t('lesson.done.body'))];
      actions = [btn(t('tour.back'), () => this.go(step - 1)), btn(t('lesson.finish'), () => this.stop(), 'btn primary')];
    }

    const fold = !def ? null : h('button', {
      type: 'button',
      class: 'lesson-fold',
      'aria-expanded': String(!this.collapsed),
      onclick: () => {
        this.collapsed = !this.collapsed;
        this.go(this.step);
      },
    }, t(this.collapsed ? 'lesson.expand' : 'lesson.collapse'));
    const title = step === 0 ? t('lesson.intro.title', { name }) : def ? this.#title(def.node) : t('lesson.done.title');
    this.el = h(
      'aside',
      { class: `tour lesson ${def && this.collapsed ? 'collapsed' : ''}`, role: 'dialog', 'aria-labelledby': 'lesson-title', tabindex: -1 },
      h(
        'div',
        { class: 'tour-step' },
        h('span', {}, step === 0 ? name : t('tour.step', { n: step, total: this.steps.length + 1 })),
        check,
        fold,
      ),
      h('h3', { id: 'lesson-title' }, title),
      h('div', { class: 'lesson-body' }, body),
      now,
      h('div', { class: 'tour-actions' }, actions),
      h('button', { type: 'button', class: 'lesson-close', 'aria-label': t('lesson.end'), title: t('lesson.end'), onclick: () => this.stop() }, '×'),
    );
    document.body.append(this.el);
    if (hasPopover) {
      this.el.setAttribute('popover', 'manual');
      this.el.showPopover();
    }
    this.#place();
    this.el.focus({ preventScroll: true });

    const tick = () => {
      if (def) {
        const done = def.targets.map((target) => isDone(store, target));
        items.forEach((li, k) => li.classList.toggle('done', done[k]));
        def.targets.forEach((target, k) => {
          const where = target.kind === 'param' ? this.#where(target.key) : '';
          wheres[k].textContent = where ? t('lesson.where', { name: where }) : '';
          wheres[k].hidden = !where;
        });
        check.hidden = !done.every(Boolean);
        if (opener) opener.hidden = app.selected === def.node;
        const next = done.indexOf(false);
        const closed = def.node !== 'keys' && app.selected !== def.node;
        nowMark.parentElement!.classList.toggle('done', next < 0);
        nowText.textContent = next < 0 ? t('lesson.now.done') : closed ? t('lesson.open', { name: this.#title(def.node) }) : this.#describe(def.targets[next]) + (wheres[next].textContent ?? '');
        nowCount.textContent = `${done.filter(Boolean).length} / ${done.length}`;
        this.#point(def, done);
      } else if (step === last) {
        this.#unfocus();
        document.querySelector('.listen')?.classList.add(FOCUS);
      }
      this.#place();
    };
    tick();
    this.timer = setInterval(tick, 300);
  }
}
