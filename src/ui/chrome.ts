// Everything around the instrument itself: the top bar, the hint strip,
// pop-ups, sharing, the sound browser, file export and the guide.

import { h, s, clamp } from './dom.ts';
import { Slider } from './controls.ts';
import { Meter } from './displays.ts';
import { PRESETS, CATEGORIES, presetTitle } from '../presets.ts';
import { shareUrl } from '../share.ts';
import { zip } from '../zip.ts';
import { savedTheme } from '../theme.ts';
import type { App, DialogOptions, PopoverOptions, Toaster } from '../app.ts';
import type { Child } from './dom.ts';
import type { Lang } from '../i18n.ts';
import type { Theme } from '../theme.ts';
import type { SerumNote } from '../engine/types.ts';

const ICONS = {
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  undo: 'M9 7L4 12l5 5M4 12h10a5 5 0 0 1 0 10h-2',
  redo: 'M15 7l5 5-5 5M20 12H10a5 5 0 0 0 0 10h2',
  volume: 'M4 9.5v5h3.5L12 18V6L7.5 9.5zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  menu: 'M4 7h16M4 12h16M4 17h16',
  prev: 'M14.5 6l-6 6 6 6',
  next: 'M9.5 6l6 6-6 6',
  keys: 'M3 6h18v12H3zM8 6v7M12 6v7M16 6v7M6.5 13v5M10 13v5M14 13v5M17.5 13v5',
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, filled = false): SVGSVGElement {
  return s('svg', { viewBox: '0 0 24 24', class: `icon ${filled ? 'filled' : ''}`, 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));
}

// ---------------------------------------------------------------------------
// Hint strip
// ---------------------------------------------------------------------------

/**
 * Explains the control under the pointer or with keyboard focus. Lives at
 * the bottom of the settings panel and is hidden when there is nothing to say.
 */
/** What the hint strip says about a control. */
export interface HelpInfo {
  title?: string;
  body: string;
  value?: string | null;
}

export type HelpGetter = () => HelpInfo | null;

export class Help {
  readonly app: App;
  readonly title: HTMLElement;
  readonly value: HTMLOutputElement;
  readonly body: HTMLParagraphElement;
  readonly el: HTMLDivElement;
  current: HelpGetter | null;
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(app: App) {
    this.app = app;
    this.title = h('strong', {});
    this.value = h('output', { class: 'help-value' });
    this.body = h('p', {});
    this.el = h('div', { class: 'help', 'aria-live': 'polite', hidden: true }, h('div', { class: 'help-head' }, this.title, this.value), this.body);
    this.current = null;
    this.timer = undefined;
  }

  /** Registers `getter() -> { title, body, value }` for an element. */
  attach(el: Element, getter: HelpGetter): void {
    const show = () => {
      this.current = getter;
      this.show(getter());
    };
    const hide = () => {
      if (this.current !== getter) return;
      // Wait a moment: moving to the next control should not make it blink.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.current === getter && this.clear(), 260);
    };
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focusin', show);
    el.addEventListener('focusout', hide);
    el.addEventListener('pointermove', () => this.current === getter && this.show(getter()));
  }

  show(info: HelpInfo | null): void {
    if (!info || !info.body) return;
    clearTimeout(this.timer);
    this.title.textContent = info.title ?? '';
    this.value.textContent = info.value ?? '';
    this.value.hidden = !info.value;
    this.body.textContent = info.body;
    this.el.hidden = false;
  }

  clear(): void {
    this.current = null;
    this.el.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Toasts, pop-overs, dialogs
// ---------------------------------------------------------------------------

/** The Popover API: top layer, light dismiss and Esc handled by the browser. */
const hasPopover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');

/**
 * Short messages at the top of the screen. They sit in one named region,
 * in the top layer (a manual popover) so nothing covers them, and each can
 * be closed. While a modal dialog is open the page behind it is inert, so a
 * message waits until the dialog closes.
 */
export function createToaster(t: (key: string) => string): Toaster {
  const notify = (document as Document & { ariaNotify?: (text: string) => void }).ariaNotify;
  const host = h('div', { class: 'toasts', role: 'region' });
  // Without ariaNotify() the region itself announces what appears in it.
  if (typeof notify !== 'function') host.setAttribute('aria-live', 'polite');
  if (hasPopover) host.setAttribute('popover', 'manual');
  document.body.append(host);
  let timers: ReturnType<typeof setTimeout>[] = [];
  /** Where focus was before it went into a toast (given back when it closes). */
  let before: HTMLElement | null = null;
  host.addEventListener('focusin', (e) => {
    if (!host.contains(e.relatedTarget as Node)) before = e.relatedTarget as HTMLElement | null;
  });

  const setShown = (shown: boolean) => {
    if (!hasPopover) return;
    if (shown && !host.matches(':popover-open')) host.showPopover();
    if (!shown && host.matches(':popover-open')) host.hidePopover();
  };
  const clear = () => {
    for (const id of timers) clearTimeout(id);
    timers = [];
    const hadFocus = host.contains(document.activeElement);
    host.replaceChildren();
    setShown(false);
    if (hadFocus) before?.focus({ preventScroll: true });
  };
  const show = (message: string, ms: number) => {
    clear();
    host.setAttribute('aria-label', t('toast.region'));
    const el = h(
      'div',
      { class: 'toast' },
      h('span', {}, message),
      h('button', { type: 'button', class: 'toast-close', 'aria-label': t('btn.close'), onclick: clear }, '×'),
    );
    host.replaceChildren(el);
    setShown(true);
    if (typeof notify === 'function') notify.call(document, message);
    timers.push(setTimeout(() => el.classList.add('out'), ms));
    timers.push(setTimeout(clear, ms + 400));
  };
  const toast = (message: string, ms = 2800) => {
    const modal = document.querySelector<HTMLDialogElement>('dialog:modal');
    if (modal) modal.addEventListener('close', () => show(message, ms), { once: true });
    else show(message, ms);
  };
  return Object.assign(toast, { clear });
}

/**
 * A floating panel next to `anchor`. Returns a function that closes it.
 * It is an auto popover: in the top layer (also above a dialog), closed by
 * a press outside or Esc, after which focus goes back where it was.
 */
export function popover(anchor: HTMLElement, content: Child, { onClose }: PopoverOptions = {}): () => void {
  document.querySelector('.popover')?.dispatchEvent(new Event('dismiss'));
  const el = h('div', { class: 'popover' }, content);
  document.body.append(el);
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    el.remove();
    onClose?.();
  };
  // Without the Popover API: close on a press outside and on Esc by hand.
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) finish();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Only this pop-over closes, not the panel behind it.
    e.stopPropagation();
    finish();
    anchor.focus?.();
  };
  if (hasPopover) {
    el.setAttribute('popover', 'auto');
    el.addEventListener('toggle', (e) => {
      if ((e as ToggleEvent).newState === 'closed') finish();
    });
    // `source` ties the popover to its button (ignored where unsupported).
    (el.showPopover as (options?: { source?: HTMLElement }) => void)({ source: anchor });
  } else {
    // Deferred so the click that opened it does not close it again.
    setTimeout(() => {
      if (closed) return;
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', key, true);
    });
  }
  anchor.setAttribute('aria-expanded', 'true');

  // Next to the button: centred under it, or above it if there is no room.
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const left = clamp(a.left + a.width / 2 - r.width / 2, 8, Math.max(8, window.innerWidth - r.width - 8));
  const below = a.bottom + 8 + r.height < window.innerHeight;
  const top = below ? a.bottom + 8 : Math.max(8, a.top - r.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const close = () => {
    if (hasPopover && el.matches(':popover-open')) el.hidePopover();
    else finish();
  };
  el.addEventListener('dismiss', close);
  el.querySelector<HTMLElement>('button:not(:disabled), input, select')?.focus({ preventScroll: true });
  return close;
}

let dialogCount = 0;

/**
 * A modal dialog. It closes with its × button, Esc, or a press on the
 * backdrop (`closedby="any"`, with a fallback where that is missing).
 */
export function dialog(app: App, title: Child, content: Child, { onClose, wide }: DialogOptions = {}): HTMLDialogElement {
  const titleId = `dialog-title-${++dialogCount}`;
  const dlg = h(
    'dialog',
    { class: `dialog ${wide ? 'wide' : ''}`, closedby: 'any', 'aria-labelledby': titleId },
    h(
      'header',
      {},
      h('h2', { id: titleId }, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': app.i18n.t('btn.close'), onclick: () => dlg.close() }, '×'),
    ),
    h('div', { class: 'dialog-body' }, content),
  );
  dlg.addEventListener('close', () => {
    onClose?.();
    // Gone once its closing transition has played.
    setTimeout(() => dlg.remove(), 300);
  });
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    // A press and its release both on the backdrop close it. The position is
    // tested rather than the target: the dialog is also the target of its
    // own padding and of the gaps between its children.
    const outside = (e: PointerEvent) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dlg.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e);
    });
    dlg.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e)) dlg.close();
    });
  }
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = (name: string): string => (name || 'seosynth').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'seosynth';

/** A small "beta" tag for features that are still experimental. */
export function Beta(app: App): HTMLElement {
  const { t } = app.i18n;
  return h('span', { class: 'beta-badge', title: t('beta.help') }, t('beta'));
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export function Header(app: App): HTMLElement {
  const { store, i18n } = app;
  const t = i18n.t;

  // --- choose a sound ---------------------------------------------------------
  const nameEl = h('span', { class: 'sound-name' });
  const renderName = () => {
    nameEl.textContent = store.getName();
  };
  app.on('name', renderName);
  renderName();
  const step = (d: number) => {
    const n = PRESETS.length;
    app.loadPreset((((app.presetIndex ?? (d > 0 ? -1 : 0)) + d) % n + n) % n);
  };
  const soundBtn = h(
    'button',
    { type: 'button', class: 'sound-btn', title: t('preset.title'), onclick: () => openSounds() },
    h('span', { class: 'sound-label' }, t('preset.label')),
    nameEl,
    h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
  );
  function openSounds() {
    const close = popover(
      soundBtn,
      h(
        'div',
        { class: 'sound-menu' },
        CATEGORIES.map((cat) =>
          h(
            'div',
            { class: 'sound-cat' },
            h('h4', {}, t(`cat.${cat}`)),
            PRESETS.map((p, k) =>
              p.cat === cat
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'menu-item',
                      'aria-current': String(k === app.presetIndex),
                      onclick: () => {
                        close();
                        app.loadPreset(k);
                      },
                    },
                    presetTitle(p, i18n.lang),
                  )
                : null,
            ),
          ),
        ),
      ),
    );
  }

  // --- listen -------------------------------------------------------------------
  const listenIcon = h('span', { class: 'listen-icon' }, icon('play', true));
  const listenLabel = h('span', {}, t('btn.listen'));
  const listen = h(
    'button',
    { type: 'button', class: 'listen', 'aria-pressed': 'false', title: t('btn.listen.help'), onclick: () => app.keyboard.toggleDemo() },
    listenIcon,
    listenLabel,
  );
  app.onDemo = (playing: boolean) => {
    listen.setAttribute('aria-pressed', String(playing));
    listenIcon.replaceChildren(icon(playing ? 'stop' : 'play', true));
    listenLabel.textContent = t(playing ? 'btn.stop' : 'btn.listen');
  };

  // --- undo / redo ----------------------------------------------------------------
  const undoBtn = h('button', { type: 'button', class: 'tool', title: `${t('btn.undo')} (Ctrl+Z)`, 'aria-label': t('btn.undo'), onclick: () => store.undo() }, icon('undo'));
  const redoBtn = h('button', { type: 'button', class: 'tool', title: `${t('btn.redo')} (Ctrl+Shift+Z)`, 'aria-label': t('btn.redo'), onclick: () => store.redo() }, icon('redo'));
  const renderHistory = () => {
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  };
  app.on('commit', renderHistory);
  renderHistory();

  // --- menu ---------------------------------------------------------------------
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      try {
        store.fromJSON(JSON.parse(await file.text()));
        app.presetIndex = null;
        app.toast(t('file.imported'));
      } catch {
        app.toast(t('file.importFailed'));
      }
    },
  });
  const menuBtn = h('button', { type: 'button', class: 'tool', 'aria-label': t('btn.menu'), title: t('btn.menu'), onclick: () => openMenu() }, icon('menu'));
  function openMenu() {
    const item = (label: Child, fn: () => void) =>
      h('button', { type: 'button', class: 'menu-item', onclick: () => { close(); fn(); } }, label);
    const choice = <V extends string>(label: string, options: [V, string][], current: V, pick: (value: V) => void) =>
      h(
        'div',
        { class: 'menu-choice' },
        h('span', {}, label),
        h(
          'div',
          { class: 'segmented' },
          options.map(([value, text]) =>
            h('button', { type: 'button', 'aria-pressed': String(value === current), onclick: () => { close(); pick(value); } }, text),
          ),
        ),
      );
    const close = popover(
      menuBtn,
      h(
        'div',
        { class: 'menu main-menu' },
        item(t('menu.new'), () => {
          store.init();
          app.presetIndex = null;
          app.toast(t('toast.patchInit'));
        }),
        item(t('file.importJson'), () => fileInput.click()),
        item(t('file.exportJson'), () => {
          download(`${safeName(store.getName())}.seosynth.json`, JSON.stringify(store.toJSON(), null, 2), 'application/json');
          app.toast(t('file.exported'));
        }),
        item([t('file.exportSerum'), Beta(app)], () => openSerumExport(app)),
        h('div', { class: 'menu-rule' }),
        item(t('matrix.title'), () => app.mods.matrixPanel()),
        item(t('tour.title'), () => app.tour.start()),
        h('div', { class: 'menu-rule' }),
        choice<Lang>(t('menu.lang'), [['ja', '日本語'], ['en', 'English']], i18n.lang, (v) => app.setLang(v)),
        choice<Theme>(t('menu.theme'), [['auto', t('theme.auto')], ['light', t('theme.light')], ['dark', t('theme.dark')]], savedTheme(), (v) => app.setTheme(v)),
      ),
    );
  }

  const keysBtn = h(
    'button',
    { type: 'button', class: 'tool keys-toggle', 'aria-pressed': 'true', 'aria-label': t('kb.toggle'), title: t('kb.toggle'), onclick: () => app.toggleKeyboard() },
    icon('keys'),
  );
  app.onKeyboardShown = (shown: boolean) => keysBtn.setAttribute('aria-pressed', String(shown));

  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, 'seosynth'),
    h(
      'div',
      { class: 'sound-picker' },
      h('button', { type: 'button', class: 'tool', 'aria-label': t('btn.prev'), title: t('btn.prev'), onclick: () => step(-1) }, icon('prev')),
      soundBtn,
      h('button', { type: 'button', class: 'tool', 'aria-label': t('btn.next'), title: t('btn.next'), onclick: () => step(1) }, icon('next')),
    ),
    listen,
    h(
      'div',
      { class: 'top-right' },
      undoBtn,
      redoBtn,
      h('div', { class: 'top-volume' }, icon('volume'), Slider(app, 'master.volume', { bare: true, noMod: true, class: 'mini' }), Meter(app)),
      keysBtn,
      h('button', { type: 'button', class: 'btn primary btn-share', onclick: () => openShare(app) }, t('btn.share')),
      menuBtn,
      fileInput,
    ),
  );
}

// ---------------------------------------------------------------------------
// Share dialog
// ---------------------------------------------------------------------------

function openShare(app: App): void {
  const { store, i18n } = app;
  const t = i18n.t;
  const url = h('textarea', { class: 'share-url', readOnly: true, rows: 4, onfocus: () => url.select() });
  // A sound that carries a table of its own makes a long link.
  const long = h('p', { class: 'share-note', hidden: true }, t('share.long'));
  let pending = 0;
  const refresh = async () => {
    const n = ++pending;
    const value = await shareUrl(store.toBytes());
    if (n !== pending) return; // the name changed again meanwhile
    url.value = value;
    long.hidden = value.length < 2000;
  };
  const name = h('input', {
    type: 'text',
    maxLength: 48,
    value: store.getName(),
    oninput: () => {
      store.setName(name.value);
      refresh();
    },
    onchange: () => store.commit(),
  });
  refresh();
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn primary',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url.value);
        } catch {
          url.select();
          document.execCommand('copy');
        }
        copy.textContent = t('btn.copied');
        setTimeout(() => (copy.textContent = t('btn.copy')), 1800);
      },
    },
    t('btn.copy'),
  );
  const native = navigator.share
    ? h('button', { type: 'button', class: 'btn', onclick: () => navigator.share({ title: `seosynth: ${store.getName()}`, url: url.value }).catch(() => {}) }, t('share.native'))
    : null;
  dialog(
    app,
    t('share.title'),
    h(
      'div',
      { class: 'share' },
      h('p', {}, t('share.body')),
      h('label', {}, h('span', {}, t('share.name')), name),
      h('label', {}, h('span', {}, t('share.link')), url),
      long,
      h('div', { class: 'dialog-actions' }, native, copy),
    ),
  );
}

// ---------------------------------------------------------------------------
// Serum 2 export
// ---------------------------------------------------------------------------

export function openSerumExport(app: App): void {
  const { core, store, i18n } = app;
  const t = i18n.t;
  const { preset, notes, tables } = core.serumExport();
  const base = safeName(store.getName());
  const fileName = (path: string) => path.split('/').pop() ?? path;

  const tableList = tables.length
    ? h(
        'ul',
        { class: 'file-list' },
        tables.map((tb) =>
          h(
            'li',
            {},
            h('code', {}, `Tables/${tb.path}`),
            h('button', { type: 'button', class: 'btn small', onclick: () => download(fileName(tb.path), core.serumTableWav(tb.index), 'audio/wav') }, t('serum.download')),
          ),
        ),
      )
    : h('p', { class: 'muted' }, t('serum.tables.none'));

  const noteText = (n: SerumNote) => {
    const key = `serum.note.${n.code}`;
    const text = t(key, { detail: n.detail });
    return text === key ? `${n.code} ${n.detail}`.trim() : text;
  };

  const downloadZip = () => {
    const files = [
      { name: `${base}.SerumPreset`, data: preset },
      ...tables.map((tb) => ({ name: `Tables/${tb.path}`, data: core.serumTableWav(tb.index) })),
      { name: 'README.txt', data: `${t('serum.readme')}\n\n${notes.map((n) => `- ${noteText(n)}`).join('\n')}\n` },
    ];
    download(`${base} (Serum 2).zip`, zip(files), 'application/zip');
    // Said inside the dialog: a message behind it would not be seen.
    saved.textContent = t('file.exported');
  };
  const saved = h('span', { class: 'muted', role: 'status' });

  dialog(
    app,
    [t('serum.title'), Beta(app)],
    h(
      'div',
      { class: 'serum-export' },
      h('p', {}, t('serum.intro')),
      h('p', { class: 'caveat' }, t('serum.caveat')),
      h('div', { class: 'dialog-actions start' }, h('button', { type: 'button', class: 'btn primary', onclick: downloadZip }, t('serum.zip')), saved),
      h('h3', {}, t('serum.step1')),
      h(
        'ul',
        { class: 'file-list' },
        h(
          'li',
          {},
          h('code', {}, `${base}.SerumPreset`),
          h('button', { type: 'button', class: 'btn small', onclick: () => download(`${base}.SerumPreset`, preset, 'application/octet-stream') }, t('serum.download')),
        ),
      ),
      h('h3', {}, t('serum.step2')),
      h('p', { class: 'muted' }, t('serum.tables.help')),
      tableList,
      h('h3', {}, t('serum.notes')),
      h('ul', { class: 'note-list' }, notes.map((n) => h('li', {}, noteText(n)))),
    ),
    { wide: true },
  );
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------

/**
 * Each step opens the relevant node, points at one thing and says what to
 * try. `done` ticks the step off once the learner has actually done it.
 */
interface TourStep {
  /** Node to open (`null` closes the panel); left out, the panel stays as it is. */
  select?: string | null;
  /** What to point at. */
  focus: string;
  /** Parameters whose change counts as having tried it. */
  changed?: string[];
  done?: (app: App) => boolean;
}

const TOUR: TourStep[] = [
  { focus: '.listen', done: (app) => app.keyboard.played },
  { select: null, focus: '.board' },
  { select: 'oscA', focus: '.panel .ctl[data-key="oscA.pos"]', changed: ['oscA.pos'] },
  { select: 'filter', focus: '.panel .ctl[data-key="filter.cutoff"]', changed: ['filter.cutoff'] },
  { select: 'amp', focus: '.panel .env-display', changed: ['env1.attack', 'env1.decay', 'env1.sustain', 'env1.release'] },
  { select: null, focus: '.mover.add', done: (app) => app.store.activeSlots().length > 0 },
  { select: null, focus: '.node[data-node="reverb"]', done: (app) => app.store.info.fx.some((k) => app.store.plain(`${k}.on`) >= 0.5) },
  { select: null, focus: '.btn-share' },
];

export class Tour {
  readonly app: App;
  step = -1;
  el: HTMLElement | null = null;
  timer: ReturnType<typeof setInterval> | undefined;

  constructor(app: App) {
    this.app = app;
  }

  start(): void {
    this.go(0);
  }

  stop(): void {
    this.step = -1;
    clearInterval(this.timer);
    this.el?.remove();
    this.el = null;
    for (const el of document.querySelectorAll('.tour-focus')) el.classList.remove('tour-focus');
    try {
      localStorage.setItem('seosynth.tour', 'seen');
    } catch {
      /* ignore */
    }
  }

  #place() {
    const focus = TOUR[this.step]?.focus;
    const target = focus ? document.querySelector(focus) : null;
    if (!this.el || !target) return;
    const a = target.getBoundingClientRect();
    const r = this.el.getBoundingClientRect();
    // Large targets (the board) get the card inside their top-left corner.
    const big = a.height > window.innerHeight * 0.4;
    const below = a.bottom + 12 + r.height < window.innerHeight - 8;
    const top = big ? a.top + 16 : below ? a.bottom + 12 : Math.max(8, a.top - r.height - 12);
    const left = clamp(big ? a.left + 16 : a.left, 8, Math.max(8, window.innerWidth - r.width - 8));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  go(step: number): void {
    const { i18n, store } = this.app;
    const t = i18n.t;
    this.stop();
    if (step < 0 || step >= TOUR.length) return;
    this.step = step;
    const def = TOUR[step];
    if (def.select !== undefined) this.app.select(def.select);
    const target = document.querySelector(def.focus);
    target?.classList.add('tour-focus');
    const baseline = (def.changed ?? []).map((k) => store.plain(k));
    const check = h('span', { class: 'tour-check', hidden: true }, t('tour.did'));
    const last = step === TOUR.length - 1;
    // A manual popover: in the top layer, and it stays open while the
    // learner works on the page. Named by its heading.
    this.el = h(
      'aside',
      { class: 'tour', role: 'dialog', 'aria-labelledby': 'tour-title', tabindex: -1 },
      h('div', { class: 'tour-step' }, h('span', {}, t('tour.step', { n: step + 1, total: TOUR.length })), check),
      h('h3', { id: 'tour-title' }, t(`tour.${step + 1}.title`)),
      h('p', {}, t(`tour.${step + 1}.body`)),
      h(
        'div',
        { class: 'tour-actions' },
        h('button', { type: 'button', class: 'btn quiet', onclick: () => this.stop() }, t('tour.skip')),
        step > 0 ? h('button', { type: 'button', class: 'btn', onclick: () => this.go(step - 1) }, t('tour.back')) : null,
        h('button', { type: 'button', class: 'btn primary', onclick: () => (last ? this.stop() : this.go(step + 1)) }, last ? t('tour.done') : t('tour.next')),
      ),
    );
    document.body.append(this.el);
    if (hasPopover) {
      this.el.setAttribute('popover', 'manual');
      this.el.showPopover();
    }
    this.#place();
    // Focus goes into the step, so keyboard and screen reader users are
    // taken to it; Tab reaches its buttons.
    this.el.focus({ preventScroll: true });
    this.timer = setInterval(() => {
      const done = def.done ? def.done(this.app) : def.changed ? def.changed.some((k, n) => Math.abs(store.plain(k) - baseline[n]) > 1e-4) : false;
      check.hidden = !done;
      this.#place();
    }, 300);
  }
}
