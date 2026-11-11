// The wavetable editor: draw a wavetable of your own, or make one from a
// recording.
//
// A user table is a few frames; each frame is one cycle of the sound wave,
// stored as 128 points. The big canvas shows one frame and is drawn on with
// the pointer. Below it the frames are lined up like the pictures of a flip
// book: the oscillator's "Wave position" morphs from one to the next.
//
// Every stroke goes straight to the engine, so what is drawn is heard while
// it is drawn. The oscillator the editor was opened from plays the table.

import { h, s, clamp, setupCanvas } from './dom.js';
import { Slider } from './controls.js';
import { colors, alpha } from '../theme.js';
import { audioToFrames, toMono } from '../wavetable-import.js';

const SHAPES = {
  Sine: (t) => Math.sin(2 * Math.PI * t),
  Triangle: (t) => 1 - 4 * Math.abs(((t + 0.25) % 1) - 0.5),
  Saw: (t) => 2 * ((t + 0.5) % 1) - 1,
  Square: (t) => (t < 0.5 ? 1 : -1),
};
const SHAPE_ICONS = {
  Sine: 'M1 7C5-3 10-3 14 7S23 17 27 7',
  Triangle: 'M1 7L7.5 1L20.5 13L27 7',
  Saw: 'M1 7L14 1V13L27 7',
  Square: 'M1 7V1H14V13H27V7',
};
const IMPORT_COUNTS = [1, 4, 8, 16];
/** Longest stretch of a recording that is looked at, in seconds. */
const IMPORT_SECONDS = 30;
const LISTEN_NOTE = 48;

/** Name of user table `slot` as shown to the user. */
export const userTableName = (i18n, slot) => i18n.t('table.user', { n: slot + 1 });

/** Draws one frame of `points` as a line across a canvas context. */
function drawFrame(ctx, points, frame, per, w, hgt, pad) {
  const y = (v) => hgt / 2 - (v / 127) * (hgt / 2 - pad);
  ctx.beginPath();
  for (let i = 0; i <= per; i++) {
    // The last point leads back to the first: the cycle repeats.
    const v = points[frame * per + (i % per)];
    if (i) ctx.lineTo((i / per) * w, y(v));
    else ctx.moveTo(0, y(v));
  }
}

/**
 * Opens the editor for user table `slot`, heard through oscillator `osc`
 * ("oscA" or "oscB").
 */
export function openTableEditor(app, osc, slot) {
  const { store, i18n } = app;
  const t = i18n.t;
  const per = store.info.userPoints;
  const maxFrames = store.info.userMaxFrames;
  let points = store.getUserTable(slot);
  let frame = 0;
  let writing = false;
  let pending = 0;
  let recording = null; // the last recording that was opened, to import it again with another frame count
  const frames = () => points.length / per;

  // --- writing to the patch -------------------------------------------------
  const write = () => {
    pending = 0;
    writing = true;
    store.setUserTable(slot, points);
    writing = false;
  };
  /** Sends the table on the next frame; drawing produces many small changes. */
  const touch = () => {
    pending ||= requestAnimationFrame(write);
    render();
  };
  const finish = () => {
    if (pending) {
      cancelAnimationFrame(pending);
      write();
    }
    store.commit();
  };

  // --- the drawing area -------------------------------------------------------
  const canvas = h('canvas', { class: 'table-canvas', role: 'img', 'aria-label': t('editor.canvas') });
  const stage = h('div', { class: 'table-stage' }, canvas);
  let view = { ctx: null, w: 0, hgt: 0 };
  const fit = () => {
    const w = stage.clientWidth;
    if (!w) return;
    const hgt = Math.round(clamp(w * 0.4, 150, 210));
    view = { ctx: setupCanvas(canvas, w, hgt), w, hgt };
    render();
  };

  const renderCanvas = () => {
    const { ctx, w, hgt } = view;
    if (!ctx) return;
    const c = colors();
    ctx.clearRect(0, 0, w, hgt);
    ctx.lineWidth = 1;
    ctx.strokeStyle = alpha(c.ink, 0.1);
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const x = Math.round((w * k) / 4) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hgt);
    }
    ctx.stroke();
    ctx.strokeStyle = alpha(c.ink, 0.3);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(hgt / 2) + 0.5);
    ctx.lineTo(w, Math.round(hgt / 2) + 0.5);
    ctx.stroke();
    // The neighbouring frame, faintly: what this frame morphs into.
    if (frame + 1 < frames()) {
      drawFrame(ctx, points, frame + 1, per, w, hgt, 10);
      ctx.strokeStyle = alpha(c.sound, 0.25);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    drawFrame(ctx, points, frame, per, w, hgt, 10);
    ctx.strokeStyle = c.sound;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(w, hgt / 2);
    ctx.lineTo(0, hgt / 2);
    ctx.closePath();
    ctx.fillStyle = alpha(c.sound, 0.12);
    ctx.fill();
  };

  // Drawing: every pointer position sets the point under it; the points
  // between two positions are filled in so fast strokes leave no gaps.
  let last = null;
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const col = clamp(Math.round(((e.clientX - r.left) / r.width) * per), 0, per - 1);
    const value = clamp(Math.round((1 - (2 * (e.clientY - r.top - 10)) / (r.height - 20)) * 127), -127, 127);
    return [col, value];
  };
  const stroke = (e) => {
    const [col, value] = at(e);
    const [fromCol, fromValue] = last ?? [col, value];
    const span = Math.abs(col - fromCol);
    for (let k = 0; k <= span; k++) {
      const mix = span ? k / span : 1;
      points[frame * per + Math.round(fromCol + (col - fromCol) * mix)] = Math.round(fromValue + (value - fromValue) * mix);
    }
    last = [col, value];
    touch();
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    last = null;
    stroke(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (canvas.hasPointerCapture(e.pointerId)) stroke(e);
  });
  const lift = (e) => {
    if (!canvas.hasPointerCapture(e.pointerId)) return;
    canvas.releasePointerCapture(e.pointerId);
    last = null;
    finish();
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);

  // --- tools ------------------------------------------------------------------
  const setFrame = (fn) => {
    for (let i = 0; i < per; i++) points[frame * per + i] = clamp(Math.round(fn(i)), -127, 127);
    touch();
    finish();
  };
  const shapeButtons = Object.keys(SHAPES).map((name) =>
    h(
      'button',
      { type: 'button', class: 'btn small shape-btn', title: i18n.option(name), 'aria-label': i18n.option(name), onclick: () => setFrame((i) => 127 * SHAPES[name](i / per)) },
      s('svg', { viewBox: '0 0 28 14', class: 'shape-icon', 'aria-hidden': 'true' }, s('path', { d: SHAPE_ICONS[name] })),
    ),
  );
  const smooth = h(
    'button',
    {
      type: 'button',
      class: 'btn small',
      onclick: () => {
        const cur = points.slice(frame * per, (frame + 1) * per);
        const v = (i) => cur[(i + per) % per];
        setFrame((i) => (v(i - 2) + 4 * v(i - 1) + 6 * v(i) + 4 * v(i + 1) + v(i + 2)) / 16);
      },
    },
    t('editor.smooth'),
  );
  // Hold to hear a note, for when no keyboard is at hand.
  const listen = h('button', { type: 'button', class: 'btn small listen-btn' }, s('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, s('path', { d: 'M2 1l9 5-9 5z' })), t('editor.listen'));
  let sounding = false;
  const sound = (on) => {
    if (on === sounding) return;
    sounding = on;
    listen.setAttribute('aria-pressed', String(on));
    if (on) app.audio.resume();
    app.audio.post(on ? ['on', LISTEN_NOTE, 0.8] : ['off', LISTEN_NOTE]);
  };
  listen.addEventListener('pointerdown', (e) => {
    listen.setPointerCapture(e.pointerId);
    sound(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'blur']) listen.addEventListener(type, () => sound(false));
  listen.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') sound(true);
  });
  listen.addEventListener('keyup', () => sound(false));

  // --- frames -----------------------------------------------------------------
  const strip = h('div', { class: 'frame-strip', role: 'group', 'aria-label': t('editor.frames') });
  const removeBtn = h('button', { type: 'button', class: 'btn small quiet', onclick: () => removeFrame() }, t('editor.removeFrame'));
  const addBtn = h('button', { type: 'button', class: 'frame-add', title: t('editor.addFrame'), 'aria-label': t('editor.addFrame'), onclick: () => addFrame() }, '＋');
  let thumbs = [];
  const iPos = store.idx(`${osc}.pos`);
  /** Shows a frame for editing and moves the oscillator there, so it is the one that is heard. */
  const select = (f) => {
    frame = clamp(f, 0, frames() - 1);
    if (frames() > 1) {
      store.set(iPos, frame / (frames() - 1));
      store.commit();
    }
    render();
  };
  const addFrame = () => {
    if (frames() >= maxFrames) return;
    // A copy of the current frame, right behind it: a starting point to change.
    const next = new Int8Array(points.length + per);
    const cut = (frame + 1) * per;
    next.set(points.subarray(0, cut));
    next.set(points.subarray(frame * per, cut), cut);
    next.set(points.subarray(cut), cut + per);
    points = next;
    write();
    select(frame + 1);
    store.commit();
  };
  const removeFrame = () => {
    if (frames() <= 1) return;
    const next = new Int8Array(points.length - per);
    next.set(points.subarray(0, frame * per));
    next.set(points.subarray((frame + 1) * per), frame * per);
    points = next;
    write();
    select(Math.min(frame, frames() - 1));
    store.commit();
  };
  const renderStrip = () => {
    if (thumbs.length !== frames()) {
      thumbs = Array.from({ length: frames() }, (_, f) => {
        const cv = h('canvas', {});
        const ctx = setupCanvas(cv, 54, 30);
        const btn = h('button', { type: 'button', class: 'frame-thumb', 'aria-label': t('editor.frame', { n: f + 1 }), onclick: () => select(f) }, cv, h('span', {}, String(f + 1)));
        return { btn, ctx };
      });
      strip.replaceChildren(...thumbs.map((th) => th.btn), addBtn);
    }
    const c = colors();
    thumbs.forEach((th, f) => {
      th.btn.setAttribute('aria-pressed', String(f === frame));
      th.ctx.clearRect(0, 0, 54, 30);
      drawFrame(th.ctx, points, f, per, 54, 30, 4);
      th.ctx.strokeStyle = c.sound;
      th.ctx.lineWidth = 1.4;
      th.ctx.stroke();
    });
    addBtn.disabled = frames() >= maxFrames;
    removeBtn.disabled = frames() <= 1;
  };

  function render() {
    renderCanvas();
    renderStrip();
  }

  // --- from a recording ---------------------------------------------------------
  const status = h('p', { class: 'import-status', role: 'status' });
  let wanted = 8;
  const say = (key, vars) => {
    status.textContent = key ? t(key, vars) : '';
  };
  const importRecording = () => {
    if (!recording) return;
    const result = audioToFrames(recording.samples, recording.sampleRate, wanted);
    if (!result) return say('editor.import.silent');
    points = result.points;
    frame = 0;
    write();
    select(0);
    store.commit();
    const hz = Math.round(result.hz);
    if (!result.pitched) say('editor.import.unpitched', { n: result.frames });
    else if (result.frames === 1 && wanted > 1) say('editor.import.one', { hz });
    else say('editor.import.done', { n: result.frames, hz });
  };
  const openFile = async (file) => {
    if (!file) return;
    say('editor.import.working');
    try {
      await app.audio.start();
      const decoded = await app.audio.ctx.decodeAudioData(await file.arrayBuffer());
      const length = Math.min(decoded.length, Math.round(IMPORT_SECONDS * decoded.sampleRate));
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, ch) => decoded.getChannelData(ch).subarray(0, length));
      recording = { samples: toMono(channels), sampleRate: decoded.sampleRate };
    } catch (err) {
      console.warn('could not decode the audio file', err);
      return say('editor.import.failed');
    }
    // Let "analysing" show before the work starts.
    setTimeout(importRecording, 30);
  };
  const fileInput = h('input', {
    type: 'file',
    accept: 'audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aif,.aiff',
    hidden: true,
    onchange: () => {
      openFile(fileInput.files[0]);
      fileInput.value = '';
    },
  });
  const countButtons = IMPORT_COUNTS.map((n) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(n === wanted),
        onclick: () => {
          wanted = n;
          countButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(IMPORT_COUNTS[k] === n)));
          importRecording();
        },
      },
      String(n),
    ),
  );

  // --- the dialog ---------------------------------------------------------------
  let dlg = null;
  const [content, scope] = app.inScope(() => {
    // Undo, redo or a loaded sound may change the table under the editor.
    app.on('table', (changed) => {
      if (changed !== slot || writing) return;
      points = store.getUserTable(slot);
      frame = Math.min(frame, frames() - 1);
      render();
    });
    return h(
      'div',
      { class: 'table-editor' },
      h('p', { class: 'editor-intro' }, t('editor.intro')),
      stage,
      h('div', { class: 'editor-tools' }, h('span', { class: 'ctl-label' }, t('editor.start')), shapeButtons, smooth, listen),
      h(
        'section',
        { class: 'editor-part' },
        h('div', { class: 'editor-part-head' }, h('h3', {}, t('editor.frames')), removeBtn),
        strip,
        h('p', { class: 'editor-note' }, t('editor.frames.help')),
        Slider(app, `${osc}.pos`, { noMod: true }),
      ),
      h(
        'section',
        { class: 'editor-part' },
        h('h3', {}, t('editor.import.title')),
        h('p', { class: 'editor-note' }, t('editor.import.body')),
        h(
          'div',
          { class: 'import-row' },
          h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, t('editor.import.choose')),
          fileInput,
          h('span', { class: 'ctl-label' }, t('editor.import.count')),
          h('div', { class: 'segmented', role: 'group', 'aria-label': t('editor.import.count') }, countButtons),
        ),
        status,
      ),
      h(
        'div',
        { class: 'dialog-actions between' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn quiet',
            onclick: () => {
              points = Int8Array.from({ length: per }, (_, i) => Math.round(127 * SHAPES.Sine(i / per)));
              frame = 0;
              say('');
              write();
              render();
              store.commit();
            },
          },
          t('editor.reset'),
        ),
        h('button', { type: 'button', class: 'btn primary', onclick: () => dlg.close() }, t('editor.done')),
      ),
    );
  });

  const sizes = new ResizeObserver(fit);
  dlg = app.dialog(t('editor.title', { name: userTableName(i18n, slot) }), content, {
    wide: true,
    onClose: () => {
      sizes.disconnect();
      sound(false);
      if (pending) finish();
      scope.dispose();
    },
  });
  // Notes can be played from the computer keyboard while drawing.
  dlg.classList.add('keys-through', 'table-dialog');
  // A recording can also be dropped onto the editor.
  dlg.addEventListener('dragover', (e) => e.preventDefault());
  dlg.addEventListener('drop', (e) => {
    e.preventDefault();
    openFile(e.dataTransfer?.files?.[0]);
  });
  sizes.observe(stage);
  fit();
  return dlg;
}
