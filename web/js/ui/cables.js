// The wires. Audio cables join the modules of the signal chain and glow
// with the level passing through them; thin coloured wires show which
// modulation source moves which knob.

import { s } from './dom.js';
import { SOURCE_COLORS } from './controls.js';

export class Cables {
  /** @param stage the positioned element that contains all modules */
  constructor(app, stage) {
    this.app = app;
    this.stage = stage;
    this.audioLayer = s('svg', { class: 'cables audio', 'aria-hidden': 'true' });
    this.modLayer = s('svg', { class: 'cables mod', 'aria-hidden': 'true' });
    stage.append(this.audioLayer, this.modLayer);
    this.audio = [];
    this.modPaths = [];
    this.hot = 0;
    this.showMods = true;
    this.pending = false;
    new ResizeObserver(() => this.schedule()).observe(stage);
    window.addEventListener('resize', () => this.schedule());
    app.store.on('slots', () => this.schedule());
    app.store.on('patch', () => this.schedule());
  }

  /**
   * Declares the audio connections. Each: { from, to, tap, color, via }
   * where `from`/`to` are functions returning port elements (or null to hide
   * the cable) and `via` optionally returns a y coordinate to detour through
   * (the bypass rail under the filter).
   */
  setAudio(connections) {
    this.audio = connections.map((c) => {
      const base = s('path', { class: 'cable-base' });
      const glow = s('path', { class: 'cable-glow', stroke: c.color });
      this.audioLayer.append(base, glow);
      return { ...c, base, glow };
    });
    this.schedule();
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.update();
    });
  }

  /** Position of an element's centre in stage coordinates, corrected for
   * any CSS zoom so it matches the SVG's own coordinate system. */
  #pos(el, edge) {
    const r = el.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const zoom = sr.width / this.stage.offsetWidth || 1;
    const x = edge === 'left' ? r.left : edge === 'right' ? r.right : r.left + r.width / 2;
    const y = edge === 'top' ? r.top : edge === 'bottom' ? r.bottom : r.top + r.height / 2;
    return [(x - sr.left) / zoom, (y - sr.top) / zoom];
  }

  update() {
    const w = this.stage.offsetWidth;
    const hgt = this.stage.offsetHeight;
    for (const layer of [this.audioLayer, this.modLayer]) {
      layer.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
      layer.setAttribute('width', w);
      layer.setAttribute('height', hgt);
    }

    for (const c of this.audio) {
      const from = c.from();
      const to = c.to();
      const visible = from && to && from.offsetParent && to.offsetParent;
      c.base.style.display = c.glow.style.display = visible ? '' : 'none';
      if (!visible) continue;
      const [x0, y0] = this.#pos(from, 'right');
      const [x1, y1] = this.#pos(to, 'left');
      const rail = c.via?.();
      let d;
      if (rail != null && x1 > x0) {
        // Detour: drop to the rail, run along it, come back up.
        const k = Math.min(26, (x1 - x0) / 4);
        d = `M${x0} ${y0}C${x0 + k} ${y0} ${x0 + k} ${rail} ${x0 + 2 * k} ${rail}L${x1 - 2 * k} ${rail}C${x1 - k} ${rail} ${x1 - k} ${y1} ${x1} ${y1}`;
      } else if (x1 > x0 + 8) {
        const k = Math.max(14, (x1 - x0) / 2);
        d = `M${x0} ${y0}C${x0 + k} ${y0} ${x1 - k} ${y1} ${x1} ${y1}`;
      } else {
        // Stacked layout: the target is below, so loop out and back in.
        const k = 30;
        d = `M${x0} ${y0}C${x0 + k} ${y0} ${x1 - k} ${y1} ${x1} ${y1}`;
      }
      c.base.setAttribute('d', d);
      c.glow.setAttribute('d', d);
    }

    // Modulation wires.
    const { store } = this.app;
    for (const p of this.modPaths) p.remove();
    this.modPaths = [];
    if (!this.showMods) return;
    for (const m of store.activeSlots()) {
      const chip = this.stage.querySelector(`.mod-src[data-src="${m.src}"]`);
      let target = this.stage.querySelector(`.knob[data-param="${m.dst}"]`);
      // A knob inside a closed section: point at the nearest visible parent.
      while (target && !target.offsetParent) target = target.parentElement?.closest('.fx-unit, .card') ?? null;
      if (target?.classList.contains('fx-unit')) target = target.querySelector('.fx-head') ?? target;
      if (!chip || !chip.offsetParent || !target) continue;
      const [x0, y0] = this.#pos(chip);
      const isKnob = target.classList.contains('knob');
      const [x1, y1] = isKnob ? this.#pos(target.querySelector('.knob-dial') ?? target) : this.#pos(target, 'bottom');
      const dy = Math.max(30, Math.abs(y1 - y0) * 0.45);
      const up = y1 < y0 ? -1 : 1;
      const path = s('path', {
        class: 'mod-wire',
        stroke: SOURCE_COLORS[m.src],
        d: `M${x0} ${y0}C${x0} ${y0 + up * dy} ${x1} ${y1 - up * dy} ${x1} ${y1}`,
        'data-src': m.src,
      });
      const end = s('circle', { class: 'mod-wire-end', cx: x1, cy: y1, r: 2.4, fill: SOURCE_COLORS[m.src], 'data-src': m.src });
      this.modLayer.append(path, end);
      this.modPaths.push(path, end);
    }
    this.highlight(this.hot);
  }

  highlight(src) {
    this.hot = src;
    this.modLayer.classList.toggle('focus', src > 0);
    for (const p of this.modPaths) p.classList.toggle('hot', Number(p.dataset.src) === src);
  }

  setShowMods(on) {
    this.showMods = on;
    this.update();
  }

  /** Called every frame with the scope bank to light up the cables. */
  frame(scopes) {
    for (const c of this.audio) {
      const level = Math.min(1, Math.sqrt(scopes.level(c.tap)) * 1.6);
      if (Math.abs(level - (c.level ?? -1)) > 0.02) {
        c.level = level;
        c.glow.style.opacity = (0.12 + 0.88 * level).toFixed(2);
      }
    }
  }
}
