// The patch as the UI sees it.
//
// The main-thread engine instance holds the authoritative patch. Every edit
// goes through this store, which applies it there, forwards it to the audio
// thread, and tells the widgets that display it.

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const MAX_HISTORY = 200;

export class Store {
  constructor(core, audio) {
    this.core = core;
    this.audio = audio;
    this.info = core.info;
    this.params = core.params;
    this.watchers = new Map();
    this.listeners = new Map();
    this.slots = core.getSlots();
    this.history = [core.save()];
    this.cursor = 0;
  }

  // --- events ---------------------------------------------------------------
  // 'patch'  everything may have changed (preset load, undo)
  // 'slots'  modulation routings changed
  // 'lfo'    (index) an LFO shape changed
  // 'fx'     effect order changed
  // 'name'   patch name changed
  // 'commit' an edit was completed (good moment to update the share URL)

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  /** Calls `fn(norm)` whenever parameter `i` changes. */
  watch(i, fn) {
    if (!this.watchers.has(i)) this.watchers.set(i, new Set());
    this.watchers.get(i).add(fn);
    return () => this.watchers.get(i).delete(fn);
  }

  #notify(i) {
    const v = this.core.get(i);
    for (const fn of this.watchers.get(i) ?? []) fn(v);
  }

  #notifyAll() {
    for (const i of this.watchers.keys()) this.#notify(i);
  }

  // --- parameters -----------------------------------------------------------

  idx(key) {
    return this.core.idx(key);
  }
  def(i) {
    return this.params[i];
  }
  get(i) {
    return this.core.get(i);
  }
  getPlain(i) {
    return this.core.getPlain(i);
  }
  /** Value of a parameter by key, in real units. */
  plain(key) {
    return this.core.getPlain(this.idx(key));
  }

  set(i, norm) {
    const v = Math.min(1, Math.max(0, norm));
    if (v === this.core.get(i)) return;
    this.core.set(i, v);
    this.audio.post(['param', i, v]);
    this.#notify(i);
  }

  setPlain(i, plain) {
    this.set(i, this.core.toNorm(i, plain));
  }

  reset(i) {
    this.set(i, this.params[i].defNorm);
  }

  // --- structure ------------------------------------------------------------

  #sync() {
    this.audio.post(['patch', this.core.save()]);
  }

  setSlot(i, slot) {
    this.core.setSlot(i, slot);
    this.slots = this.core.getSlots();
    this.#sync();
    this.emit('slots');
  }

  clearSlot(i) {
    this.setSlot(i, { src: 0, dst: -1, amount: 0, bipolar: false });
  }

  /** Routings as [{ index, src, dst, amount, bipolar }] for the used slots. */
  activeSlots() {
    return this.slots.map((s, index) => ({ index, ...s })).filter((s) => s.src > 0 && s.dst >= 0);
  }

  modsFor(dst) {
    return this.activeSlots().filter((s) => s.dst === dst);
  }

  /**
   * Routes `src` to `dst`. If that pair already exists its amount is
   * replaced. Returns the slot index, or -1 if all slots are in use.
   */
  addMod(src, dst, amount = 0.25, bipolar = false) {
    let i = this.slots.findIndex((s) => s.src === src && s.dst === dst);
    if (i < 0) i = this.slots.findIndex((s) => s.src === 0 || s.dst < 0);
    if (i < 0) return -1;
    this.setSlot(i, { src, dst, amount, bipolar });
    return i;
  }

  getLfoShape(l) {
    return this.core.getLfoShape(l);
  }

  setLfoShape(l, points) {
    this.core.setLfoShape(l, points);
    this.#sync();
    this.emit('lfo', l);
  }

  getFxOrder() {
    return this.core.getFxOrder();
  }

  setFxOrder(order) {
    if (this.core.setFxOrder(order)) {
      this.#sync();
      this.emit('fx');
    }
  }

  getName() {
    return this.core.getName();
  }

  setName(name) {
    this.core.setName(name);
    this.#sync();
    this.emit('name');
  }

  // --- whole patch ----------------------------------------------------------

  #reloaded() {
    this.slots = this.core.getSlots();
    this.#sync();
    this.#notifyAll();
    this.emit('patch');
    this.emit('slots');
    this.emit('fx');
    this.emit('name');
  }

  toBytes() {
    return this.core.save();
  }

  /** Loads a binary patch. Returns false if the data is not valid. */
  loadBytes(bytes, { commit = true } = {}) {
    if (!this.core.load(bytes)) return false;
    this.#reloaded();
    if (commit) this.commit();
    return true;
  }

  init() {
    this.core.init();
    this.#reloaded();
    this.commit();
  }

  /** Human-readable form, used for preset files and the built-in presets. */
  toJSON() {
    const c = this.core;
    const out = { format: 'nami-patch', version: 1, name: c.getName(), params: {} };
    for (const p of this.params) {
      const plain = c.getPlain(p.i);
      if (p.curve === 'enum') {
        if (Math.round(plain) !== Math.round(p.def)) out.params[p.key] = p.options[Math.round(plain)];
      } else if (p.curve === 'bool') {
        if (plain !== p.def) out.params[p.key] = plain >= 0.5;
      } else if (p.curve === 'int') {
        if (plain !== p.def) out.params[p.key] = plain;
      } else if (Math.abs(c.get(p.i) - p.defNorm) > 1e-5) {
        out.params[p.key] = Number(plain.toPrecision(6));
      }
    }
    const mods = this.activeSlots().map((s) => ({
      source: this.info.sources[s.src],
      target: this.params[s.dst].key,
      amount: Number(s.amount.toFixed(4)),
      ...(s.bipolar ? { bipolar: true } : {}),
    }));
    if (mods.length) out.mods = mods;
    const shapes = {};
    for (let l = 0; l < 4; l++) {
      const pts = c.getLfoShape(l);
      const isDefault = pts.length === 3 && pts[0].y === 0 && pts[1].x === 0.5 && pts[1].y === 1 && pts[2].y === 0 && pts.every((p) => p.curve === 0);
      if (!isDefault) shapes[l + 1] = pts.map((p) => [p.x, p.y, p.curve].map((v) => Number(v.toFixed(4))));
    }
    if (Object.keys(shapes).length) out.lfoShapes = shapes;
    const order = c.getFxOrder();
    if (!order.every((v, i) => v === i)) out.fxOrder = order.map((i) => this.info.fx[i]);
    return out;
  }

  /**
   * Applies a patch in JSON form on top of the init patch. Unknown keys are
   * ignored so files from other versions still load. Returns a list of
   * warnings for anything that was skipped.
   */
  fromJSON(obj, { commit = true } = {}) {
    const warnings = [];
    if (!obj || typeof obj !== 'object' || typeof obj.params !== 'object') throw new Error('not a patch file');
    const c = this.core;
    c.init();
    for (const [key, value] of Object.entries(obj.params ?? {})) {
      const p = c.byKey.get(key);
      if (!p) {
        warnings.push(`unknown parameter: ${key}`);
        continue;
      }
      let plain;
      if (p.curve === 'enum') {
        plain = typeof value === 'string' ? p.options.indexOf(value) : Number(value);
        if (!(plain >= 0)) {
          warnings.push(`unknown option for ${key}: ${value}`);
          continue;
        }
      } else if (p.curve === 'bool') {
        plain = value ? 1 : 0;
      } else {
        plain = Number(value);
        if (!Number.isFinite(plain)) continue;
      }
      c.setPlain(p.i, plain);
    }
    let slot = 0;
    for (const m of obj.mods ?? []) {
      const src = this.info.sources.indexOf(m.source);
      const dst = c.byKey.get(m.target);
      if (src <= 0 || !dst || !dst.mod) {
        warnings.push(`skipped modulation: ${m.source} -> ${m.target}`);
        continue;
      }
      if (slot >= this.info.numSlots) break;
      c.setSlot(slot++, { src, dst: dst.i, amount: Number(m.amount) || 0, bipolar: !!m.bipolar });
    }
    for (const [l, pts] of Object.entries(obj.lfoShapes ?? {})) {
      const index = Number(l) - 1;
      if (index >= 0 && index < 4 && Array.isArray(pts)) {
        c.setLfoShape(index, pts.map(([x, y, curve]) => ({ x, y, curve: curve ?? 0 })));
      }
    }
    if (Array.isArray(obj.fxOrder)) {
      const order = obj.fxOrder.map((k) => this.info.fx.indexOf(k));
      if (!c.setFxOrder(order)) warnings.push('invalid effect order');
    }
    c.setName(typeof obj.name === 'string' ? obj.name : 'Untitled');
    this.#reloaded();
    if (commit) this.commit();
    return warnings;
  }

  // --- undo / redo ----------------------------------------------------------

  /** Marks the end of an edit: records an undo step if anything changed. */
  commit() {
    const bytes = this.core.save();
    if (!same(bytes, this.history[this.cursor])) {
      this.history.length = this.cursor + 1;
      this.history.push(bytes);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.cursor = this.history.length - 1;
    }
    this.emit('commit');
  }

  get canUndo() {
    return this.cursor > 0;
  }
  get canRedo() {
    return this.cursor < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo) return;
    this.cursor--;
    this.core.load(this.history[this.cursor]);
    this.#reloaded();
    this.emit('commit');
  }

  redo() {
    if (!this.canRedo) return;
    this.cursor++;
    this.core.load(this.history[this.cursor]);
    this.#reloaded();
    this.emit('commit');
  }
}
