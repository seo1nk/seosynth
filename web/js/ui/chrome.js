// Everything around the instrument itself: the top bar, the hint strip,
// pop-ups, sharing, the sound browser, file export and the guide.

import { h, s, clamp } from './dom.js';
import { Slider } from './controls.js';
import { Meter } from './displays.js';
import { PRESETS, CATEGORIES, presetTitle } from '../presets.js';
import { shareUrl } from '../share.js';
import { zip } from '../zip.js';
import { savedTheme } from '../theme.js';

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

export function icon(name, filled = false) {
  return s('svg', { viewBox: '0 0 24 24', class: `icon ${filled ? 'filled' : ''}`, 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));
}

// ---------------------------------------------------------------------------
// Hint strip
// ---------------------------------------------------------------------------

/**
 * Explains the control under the pointer or with keyboard focus. Lives at
 * the bottom of the settings panel and is hidden when there is nothing to say.
 */
export class Help {
  constructor(app) {
    this.app = app;
    this.title = h('strong', {});
    this.value = h('output', { class: 'help-value' });
    this.body = h('p', {});
    this.el = h('div', { class: 'help', 'aria-live': 'polite', hidden: true }, h('div', { class: 'help-head' }, this.title, this.value), this.body);
    this.current = null;
    this.timer = null;
  }

  /** Registers `getter() -> { title, body, value }` for an element. */
  attach(el, getter) {
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

  show(info) {
    if (!info || !info.body) return;
    clearTimeout(this.timer);
    this.title.textContent = info.title ?? '';
    this.value.textContent = info.value ?? '';
    this.value.hidden = !info.value;
    this.body.textContent = info.body;
    this.el.hidden = false;
  }

  clear() {
    this.current = null;
    this.el.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Toasts, pop-overs, dialogs
// ---------------------------------------------------------------------------

export function createToaster() {
  const host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.append(host);
  const toast = (message, ms = 2800) => {
    const el = h('div', { class: 'toast' }, message);
    host.replaceChildren(el);
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 400);
  };
  toast.clear = () => host.replaceChildren();
  return toast;
}

/** A floating panel next to `anchor`. Returns a function that closes it. */
export function popover(anchor, content, { onClose } = {}) {
  document.querySelector('.popover')?.dispatchEvent(new Event('dismiss'));
  const el = h('div', { class: 'popover', role: 'dialog' }, content);
  document.body.append(el);
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const left = clamp(a.left + a.width / 2 - r.width / 2, 8, Math.max(8, window.innerWidth - r.width - 8));
  const below = a.bottom + 8 + r.height < window.innerHeight;
  const top = below ? a.bottom + 8 : Math.max(8, a.top - r.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    onClose?.();
  };
  const outside = (e) => {
    if (!el.contains(e.target)) close();
  };
  const key = (e) => {
    if (e.key === 'Escape') {
      // Only this pop-over closes, not the panel behind it.
      e.stopPropagation();
      close();
      anchor.focus?.();
    }
  };
  el.addEventListener('dismiss', close);
  // Deferred so the click that opened it does not close it again.
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
  });
  el.querySelector('button:not(:disabled), input, select')?.focus({ preventScroll: true });
  return close;
}

export function dialog(app, title, content, { onClose, wide } = {}) {
  const dlg = h(
    'dialog',
    { class: `dialog ${wide ? 'wide' : ''}` },
    h(
      'header',
      {},
      h('h2', {}, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': app.i18n.t('btn.close'), onclick: () => dlg.close() }, '×'),
    ),
    h('div', { class: 'dialog-body' }, content),
  );
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = (name) => (name || 'seosynth').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'seosynth';

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export function Header(app) {
  const { store, i18n } = app;
  const t = i18n.t;

  // --- choose a sound ---------------------------------------------------------
  const nameEl = h('span', { class: 'sound-name' });
  const renderName = () => {
    nameEl.textContent = store.getName();
  };
  app.on('name', renderName);
  renderName();
  const step = (d) => {
    const n = PRESETS.length;
    app.loadPreset((((app.presetIndex ?? (d > 0 ? -1 : 0)) + d) % n + n) % n);
  };
  const soundBtn = h(
    'button',
    { type: 'button', class: 'sound-btn', 'aria-haspopup': 'true', title: t('preset.title'), onclick: () => openSounds() },
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
  app.onDemo = (playing) => {
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
  const menuBtn = h('button', { type: 'button', class: 'tool', 'aria-haspopup': 'true', 'aria-label': t('btn.menu'), title: t('btn.menu'), onclick: () => openMenu() }, icon('menu'));
  function openMenu() {
    const item = (label, fn) =>
      h('button', { type: 'button', class: 'menu-item', onclick: () => { close(); fn(); } }, label);
    const choice = (label, options, current, pick) =>
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
        item(t('file.exportSerum'), () => openSerumExport(app)),
        h('div', { class: 'menu-rule' }),
        item(t('matrix.title'), () => app.mods.matrixPanel()),
        item(t('tour.title'), () => app.tour.start()),
        h('div', { class: 'menu-rule' }),
        choice(t('menu.lang'), [['ja', '日本語'], ['en', 'English']], i18n.lang, (v) => app.setLang(v)),
        choice(t('menu.theme'), [['auto', t('theme.auto')], ['light', t('theme.light')], ['dark', t('theme.dark')]], savedTheme(), (v) => app.setTheme(v)),
      ),
    );
  }

  const keysBtn = h(
    'button',
    { type: 'button', class: 'tool keys-toggle', 'aria-pressed': 'true', 'aria-label': t('kb.toggle'), title: t('kb.toggle'), onclick: () => app.toggleKeyboard() },
    icon('keys'),
  );
  app.onKeyboardShown = (shown) => keysBtn.setAttribute('aria-pressed', String(shown));

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

function openShare(app) {
  const { store, i18n } = app;
  const t = i18n.t;
  const url = h('textarea', { class: 'share-url', readOnly: true, rows: 4, onfocus: () => url.select() });
  // A sound that carries a table of its own makes a long link.
  const long = h('p', { class: 'share-note', hidden: true }, t('share.long'));
  const refresh = () => {
    url.value = shareUrl(store.toBytes());
    long.hidden = url.value.length < 2000;
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

export function openSerumExport(app) {
  const { core, store, i18n } = app;
  const t = i18n.t;
  const { preset, notes, tables } = core.serumExport();
  const base = safeName(store.getName());
  const fileName = (path) => path.split('/').pop();

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

  const noteText = (n) => {
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
    app.toast(t('file.exported'));
  };

  dialog(
    app,
    t('serum.title'),
    h(
      'div',
      { class: 'serum-export' },
      h('p', {}, t('serum.intro')),
      h('p', { class: 'caveat' }, t('serum.caveat')),
      h('div', { class: 'dialog-actions start' }, h('button', { type: 'button', class: 'btn primary', onclick: downloadZip }, t('serum.zip'))),
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
const TOUR = [
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
  constructor(app) {
    this.app = app;
    this.step = -1;
    this.el = null;
    this.timer = null;
  }

  start() {
    this.go(0);
  }

  stop() {
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
    const target = document.querySelector(TOUR[this.step]?.focus);
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

  go(step) {
    const { i18n, store } = this.app;
    const t = i18n.t;
    this.stop();
    if (step < 0 || step >= TOUR.length) return;
    this.step = step;
    const def = TOUR[step];
    if ('select' in def) this.app.select(def.select);
    const target = document.querySelector(def.focus);
    target?.classList.add('tour-focus');
    const baseline = (def.changed ?? []).map((k) => store.plain(k));
    const check = h('span', { class: 'tour-check', hidden: true }, t('tour.did'));
    const last = step === TOUR.length - 1;
    this.el = h(
      'aside',
      { class: 'tour', role: 'dialog', 'aria-label': t('tour.title') },
      h('div', { class: 'tour-step' }, h('span', {}, t('tour.step', { n: step + 1, total: TOUR.length })), check),
      h('h3', {}, t(`tour.${step + 1}.title`)),
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
    this.#place();
    this.timer = setInterval(() => {
      const done = def.done ? def.done(this.app) : def.changed ? def.changed.some((k, n) => Math.abs(store.plain(k) - baseline[n]) > 1e-4) : false;
      check.hidden = !done;
      this.#place();
    }, 300);
  }
}
