// The clip sequencer's editor: a piano roll in a drawer above the keyboard,
// so the keys can be played while the clip is drawn.
//
// The piano roll (src/pianoroll) knows nothing of seosynth. This file is the
// glue: it keeps the roll's clip (notes with ids) in step with the patch's
// clip (plain notes in the engine), plays notes while they are placed,
// records undo steps when a gesture ends and shows where the clip is.

import { h } from './dom.ts';
import { Slider, Switch } from './controls.ts';
import { noteName } from '../format.ts';
import { PianoRoll, adoptIds, applyOps, idMaker } from '../pianoroll/index.ts';
import type { Clip, Op } from '../pianoroll/index.ts';
import type { App } from '../app.ts';

/** Grid choices: label and the part of a quarter note. */
const GRIDS: [string, number][] = [
  ['1/4', 1],
  ['1/8', 1 / 2],
  ['1/16', 1 / 4],
  ['1/32', 1 / 8],
  ['1/8T', 1 / 3],
  ['1/16T', 1 / 6],
];
const BARS = [1, 2, 4, 8];

/** The grid picked last (kept while the page is open). */
let gridChoice = 2;

export interface ClipPanel {
  el: HTMLElement;
  /** Starts or stops playing the clip from its root note. */
  togglePlay(): void;
}

export function ClipPanel(app: App): ClipPanel {
  const { store, i18n } = app;
  const t = i18n.t;
  const { ppq, minLength, maxLength } = store.info.clip;
  // Notes read from the patch get ids of one site, notes drawn in the roll
  // of another, so the two never meet.
  const newId = idMaker('patch');
  const fromPatch = (prev: Clip): Clip => adoptIds(prev, { ppq, ...store.getClip() }, newId);
  let model: Clip = fromPatch({ ppq, length: 0, notes: [] });
  let writing = false;
  let pending = 0;

  const write = () => {
    cancelAnimationFrame(pending);
    pending = 0;
    writing = true;
    store.setClip({ length: model.length, notes: model.notes.map(({ pitch, start, length, velocity }) => ({ pitch, start, length, velocity })) });
    writing = false;
  };

  // --- hearing notes while they are placed ---------------------------------------------
  const heard = new Set<number>();
  const hear = (pitch: number, velocity: number) => {
    app.audio.resume();
    heard.add(pitch);
    app.audio.post(['hear', pitch, velocity / 127]);
  };
  const unhear = (pitch: number) => {
    if (heard.delete(pitch)) app.audio.post(['unhear', pitch]);
  };

  const roll = new PianoRoll(model, {
    grid: ppq * GRIDS[gridChoice][1],
    minLength,
    maxLength,
    lowest: 24,
    highest: 96,
    noteName,
    label: t('clip.roll'),
    site: 'roll',
    onChange(ops: Op[], done: boolean) {
      model = applyOps(model, ops);
      if (ops.length) pending ||= requestAnimationFrame(write);
      if (done) {
        if (pending) write();
        // The engine tidies the clip (notes past the end, two at one place):
        // show what it keeps.
        model = fromPatch(model);
        roll.setClip(model);
        store.commit();
      }
      syncLength();
    },
    onSelect: () => showSelection(),
    onAudition: hear,
    onAuditionEnd: unhear,
  });

  // --- tools -------------------------------------------------------------------------------
  const play = h(
    'button',
    { type: 'button', class: 'btn small play-btn', 'aria-pressed': 'false', onclick: () => togglePlay() },
    h('span', { class: 'play-icon', 'aria-hidden': 'true' }),
    h('span', { class: 'play-text' }, t('clip.play')),
  );
  let playing: number | null = null;
  const togglePlay = () => {
    if (playing !== null) {
      app.keyboard.noteOff(playing);
      playing = null;
    } else {
      // Playing the clip needs the clip on.
      if (store.plain('clip.on') < 0.5) {
        store.set(store.idx('clip.on'), 1);
        store.commit();
      }
      playing = Math.round(store.plain('clip.root'));
      app.keyboard.noteOn(playing, 0.8);
    }
    play.setAttribute('aria-pressed', String(playing !== null));
    play.querySelector('.play-text')!.textContent = t(playing !== null ? 'clip.stop' : 'clip.play');
  };

  const lengthSel = h(
    'select',
    {
      'aria-label': t('clip.length'),
      onchange: () => {
        const after = Number(lengthSel.value);
        roll.apply([{ kind: 'length', before: model.length, after }]);
      },
    },
    BARS.map((bars) => h('option', { value: String(bars * 4 * ppq) }, t('clip.bars', { n: bars }))),
  );
  const syncLength = () => {
    // A length that is not a whole number of bars (set with the marker) is listed too.
    if (![...lengthSel.options].some((o) => Number(o.value) === model.length)) {
      lengthSel.append(h('option', { value: String(model.length), dataset: { extra: '1' } }, t('clip.beats', { n: model.length / ppq })));
    }
    for (const o of [...lengthSel.options]) if (o.dataset.extra && Number(o.value) !== model.length) o.remove();
    lengthSel.value = String(model.length);
  };

  const gridSel = h(
    'select',
    {
      'aria-label': t('clip.grid'),
      onchange: () => {
        gridChoice = Number(gridSel.value);
        roll.setGrid(ppq * GRIDS[gridChoice][1]);
      },
    },
    GRIDS.map(([label], k) => h('option', { value: String(k) }, label)),
  );
  gridSel.value = String(gridChoice);

  // --- the selected notes ----------------------------------------------------------------
  const velocity = h('input', {
    type: 'range',
    min: 1,
    max: 127,
    step: 1,
    'aria-label': t('clip.velocity'),
    oninput: () => {
      const v = Number(velocity.value);
      const picked = roll.selectedNotes();
      if (!picked.length) {
        roll.nextVelocity = v;
        return;
      }
      roll.apply(
        picked.map((n): Op => ({ kind: 'set', id: n.id, before: { velocity: n.velocity }, after: { velocity: v } })),
        false,
      );
    },
    onchange: () => roll.apply([], true),
  });
  const removeBtn = h('button', { type: 'button', class: 'btn small quiet', onclick: () => roll.deleteSelection() }, t('clip.delete'));
  const selInfo = h('span', { class: 'clip-sel' });
  const showSelection = () => {
    const picked = roll.selectedNotes();
    selInfo.textContent = picked.length ? t('clip.selected', { n: picked.length }) : t('clip.newNotes');
    velocity.value = String(picked.length ? Math.round(picked.reduce((s, n) => s + n.velocity, 0) / picked.length) : roll.nextVelocity);
    removeBtn.disabled = !picked.length;
  };
  const clearBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn small quiet',
      onclick: () => roll.apply(model.notes.map((note): Op => ({ kind: 'delete', note }))),
    },
    t('clip.clear'),
  );

  // --- keeping in step ---------------------------------------------------------------------
  app.on('clip', () => {
    if (writing) return;
    model = fromPatch(model);
    roll.setClip(model);
    syncLength();
  });
  app.onFrame((live) => roll.setPlayhead(live.clipPos >= 0 ? live.clipPos : null));
  app.onDispose(() => {
    if (pending) write();
    for (const p of [...heard]) unhear(p);
    if (playing !== null) app.keyboard.noteOff(playing);
    roll.dispose();
  });

  syncLength();
  showSelection();
  roll.reveal();

  const el = h(
    'section',
    { class: 'clip-panel', 'aria-label': t('clip.title') },
    h(
      'div',
      { class: 'clip-tools' },
      play,
      Switch(app, 'clip.loop'),
      h('label', { class: 'clip-field' }, h('span', { class: 'ctl-label' }, t('clip.length')), lengthSel),
      h('label', { class: 'clip-field' }, h('span', { class: 'ctl-label' }, t('clip.grid')), gridSel),
      Slider(app, 'clip.root', { class: 'clip-root' }),
    ),
    h('div', { class: 'clip-roll' }, roll.el),
    h(
      'div',
      { class: 'clip-foot' },
      selInfo,
      h('label', { class: 'clip-vel' }, h('span', { class: 'ctl-label' }, t('clip.velocity')), velocity),
      removeBtn,
      clearBtn,
      h('span', { class: 'clip-hint' }, t('clip.hint')),
    ),
  );
  return { el, togglePlay };
}
