// Everything around the synth itself: header, hint bar, pop-ups, sharing,
// preset browser, file menu and the guided tour.

import { h, clamp } from './dom.js';
import { PRESETS, CATEGORIES, presetTitle } from '../presets.js';
import { shareUrl } from '../share.js';

// ---------------------------------------------------------------------------
// Hint bar
// ---------------------------------------------------------------------------

/** Shows an explanation of whatever is under the pointer or has focus. */
export class Help {
  constructor(app) {
    this.app = app;
    this.title = h('strong', {});
    this.value = h('span', { class: 'hint-value' });
    this.body = h('span', { class: 'hint-body' });
    this.el = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite' }, this.title, this.value, this.body);
    this.current = null;
    this.clear();
  }

  /** Registers `getter() -> { title, body, value }` for an element. */
  attach(el, getter) {
    const show = () => {
      this.current = getter;
      this.show(getter());
    };
    const hide = () => {
      if (this.current === getter) this.clear();
    };
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focusin', show);
    el.addEventListener('focusout', hide);
    // Keep the value fresh while a control is being moved.
    el.addEventListener('pointermove', () => this.current === getter && this.show(getter()));
  }

  show(info) {
    if (!info) return;
    this.title.textContent = info.title ?? '';
    this.value.textContent = info.value ?? '';
    this.value.hidden = !info.value;
    this.body.textContent = info.body ?? '';
    this.el.classList.remove('idle');
  }

  clear() {
    this.current = null;
    this.title.textContent = '';
    this.value.hidden = true;
    this.body.textContent = this.app.i18n.t('hint.default');
    this.el.classList.add('idle');
  }
}

// ---------------------------------------------------------------------------
// Toasts, pop-overs, dialogs
// ---------------------------------------------------------------------------

export function createToaster() {
  const host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.append(host);
  const toast = (message, ms = 2600) => {
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
  const left = clamp(a.left + a.width / 2 - r.width / 2, 8, window.innerWidth - r.width - 8);
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
  el.querySelector('button, input, select')?.focus({ preventScroll: true });
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

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = (name) => (name || 'nami').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'nami';

export function Header(app) {
  const { store, i18n } = app;
  const t = i18n.t;

  // --- presets ------------------------------------------------------------------
  const nameEl = h('span', { class: 'preset-name' });
  const renderName = () => {
    nameEl.textContent = store.getName();
  };
  store.on('name', renderName);
  renderName();

  const stepPreset = (d) => {
    const n = PRESETS.length;
    app.loadPreset((((app.presetIndex ?? 0) + d) % n + n) % n);
  };
  const presetBtn = h(
    'button',
    { type: 'button', class: 'preset-btn', 'aria-haspopup': 'true', onclick: () => openPresets() },
    nameEl,
    h('span', { class: 'chevron' }, '▾'),
  );
  function openPresets() {
    const close = popover(
      presetBtn,
      h(
        'div',
        { class: 'preset-menu' },
        CATEGORIES.map((cat) =>
          h(
            'div',
            { class: 'preset-cat' },
            h('h4', {}, t(`cat.${cat}`)),
            PRESETS.map((p, k) =>
              p.cat === cat
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: `menu-item ${k === app.presetIndex ? 'current' : ''}`,
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

  // --- file menu ----------------------------------------------------------------
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
  const fileBtn = h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'true', onclick: () => openFile() }, t('btn.file'), ' ▾');
  function openFile() {
    const close = popover(
      fileBtn,
      h(
        'div',
        { class: 'menu' },
        h('button', { type: 'button', class: 'menu-item', onclick: () => { close(); fileInput.click(); } }, t('file.importJson')),
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item',
            onclick: () => {
              close();
              download(`${safeName(store.getName())}.nami.json`, JSON.stringify(store.toJSON(), null, 2), 'application/json');
              app.toast(t('file.exported'));
            },
          },
          t('file.exportJson'),
        ),
        app.exportSerum
          ? h('button', { type: 'button', class: 'menu-item', onclick: () => { close(); app.exportSerum(); } }, t('file.exportSerum'))
          : null,
      ),
    );
  }

  // --- undo / redo ----------------------------------------------------------------
  const undoBtn = h('button', { type: 'button', class: 'btn icon', title: `${t('btn.undo')} (Ctrl+Z)`, 'aria-label': t('btn.undo'), onclick: () => store.undo() }, '↶');
  const redoBtn = h('button', { type: 'button', class: 'btn icon', title: `${t('btn.redo')} (Ctrl+Shift+Z)`, 'aria-label': t('btn.redo'), onclick: () => store.redo() }, '↷');
  const renderHistory = () => {
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
  };
  store.on('commit', renderHistory);
  renderHistory();

  const wiresBtn = h(
    'button',
    {
      type: 'button',
      class: 'toggle on',
      title: t('btn.cables'),
      onclick: () => {
        const on = !wiresBtn.classList.contains('on');
        wiresBtn.classList.toggle('on', on);
        app.cables.setShowMods(on);
      },
    },
    t('btn.cables'),
  );

  const status = h('button', { type: 'button', class: 'audio-status', onclick: () => app.audio.resume() }, t('audio.start'));
  app.setAudioStatus = (running) => {
    status.hidden = running;
  };

  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'NAMI'), h('span', { class: 'logo-sub' }, '波'), h('span', { class: 'tagline' }, t('app.tagline'))),
    h(
      'div',
      { class: 'preset-nav' },
      h('button', { type: 'button', class: 'btn icon', 'aria-label': t('btn.prev'), title: t('btn.prev'), onclick: () => stepPreset(-1) }, '‹'),
      presetBtn,
      h('button', { type: 'button', class: 'btn icon', 'aria-label': t('btn.next'), title: t('btn.next'), onclick: () => stepPreset(1) }, '›'),
    ),
    status,
    h(
      'div',
      { class: 'top-actions' },
      undoBtn,
      redoBtn,
      h('button', { type: 'button', class: 'btn', onclick: () => { store.init(); app.presetIndex = null; app.toast(t('toast.patchInit')); } }, t('btn.init')),
      wiresBtn,
      h('button', { type: 'button', class: 'btn', onclick: () => app.mods.matrixPanel() }, t('btn.matrix')),
      fileBtn,
      fileInput,
      h('button', { type: 'button', class: 'btn primary btn-share', onclick: () => openShare(app) }, t('btn.share')),
      h('button', { type: 'button', class: 'btn', onclick: () => app.tour.start() }, `? ${t('btn.help')}`),
      h('button', { type: 'button', class: 'btn', lang: i18n.lang === 'ja' ? 'en' : 'ja', onclick: () => app.setLang(i18n.lang === 'ja' ? 'en' : 'ja') }, t('lang.switch')),
    ),
  );
}

// ---------------------------------------------------------------------------
// Share dialog
// ---------------------------------------------------------------------------

function openShare(app) {
  const { store, i18n } = app;
  const t = i18n.t;
  const url = h('textarea', { class: 'share-url', readOnly: true, rows: 4, 'aria-label': 'URL', onfocus: () => url.select() });
  const refresh = () => {
    url.value = shareUrl(store.toBytes());
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
        copy.textContent = `✓ ${t('btn.copied')}`;
        setTimeout(() => (copy.textContent = t('btn.copy')), 1800);
      },
    },
    t('btn.copy'),
  );
  const native = navigator.share
    ? h('button', { type: 'button', class: 'btn', onclick: () => navigator.share({ title: `Nami — ${store.getName()}`, url: url.value }).catch(() => {}) }, t('share.native'))
    : null;
  dialog(
    app,
    t('share.title'),
    h(
      'div',
      { class: 'share' },
      h('p', {}, t('share.body')),
      h('label', {}, h('span', {}, t('share.name')), name),
      url,
      h('div', { class: 'dialog-actions' }, native, copy),
    ),
  );
}

// ---------------------------------------------------------------------------
// Guided tour
// ---------------------------------------------------------------------------

const TOUR = [
  { focus: ['.keyboard'], done: (app) => app.keyboard.played },
  { focus: ['.flow-grid'] },
  { focus: ['[data-module="oscA"]'], changed: ['oscA.pos'] },
  { focus: ['[data-module="filter"]'], changed: ['filter.cutoff'] },
  { focus: ['[data-module="amp"]'], changed: ['env1.attack', 'env1.decay', 'env1.sustain', 'env1.release'] },
  {
    focus: ['[data-module="lfo1"]', '[data-key="filter.cutoff"]'],
    done: (app) => app.store.activeSlots().some((s) => app.store.info.sources[s.src] === 'lfo1' && app.store.def(s.dst).key === 'filter.cutoff'),
  },
  { focus: ['[data-module="fx"]'], done: (app) => app.store.info.fx.some((k) => app.store.plain(`${k}.on`) >= 0.5) },
  { focus: ['.btn-share', '.preset-nav'] },
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
      localStorage.setItem('nami.tour', 'seen');
    } catch {
      /* ignore */
    }
  }

  go(step) {
    const { i18n, store } = this.app;
    const t = i18n.t;
    this.stop();
    if (step < 0 || step >= TOUR.length) return;
    this.step = step;
    const def = TOUR[step];
    for (const sel of def.focus) document.querySelector(sel)?.classList.add('tour-focus');
    document.querySelector(def.focus[0])?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const baseline = (def.changed ?? []).map((k) => store.plain(k));
    const check = h('span', { class: 'tour-check', hidden: true }, '✓');
    const last = step === TOUR.length - 1;
    this.el = h(
      'aside',
      { class: 'tour', role: 'dialog', 'aria-label': t('tour.title') },
      h('div', { class: 'tour-step' }, t('tour.step', { n: step + 1, total: TOUR.length }), check),
      h('h3', {}, t(`tour.${step + 1}.title`)),
      h('p', {}, t(`tour.${step + 1}.body`)),
      h(
        'div',
        { class: 'tour-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.stop() }, t('tour.skip')),
        step > 0 ? h('button', { type: 'button', class: 'btn', onclick: () => this.go(step - 1) }, t('tour.back')) : null,
        h('button', { type: 'button', class: 'btn primary', onclick: () => (last ? this.stop() : this.go(step + 1)) }, last ? t('tour.done') : t('tour.next')),
      ),
    );
    document.body.append(this.el);
    // Tick the step off once the learner has actually done it.
    this.timer = setInterval(() => {
      const done = def.done ? def.done(this.app) : def.changed ? def.changed.some((k, n) => Math.abs(store.plain(k) - baseline[n]) > 1e-4) : false;
      check.hidden = !done;
    }, 300);
  }
}
