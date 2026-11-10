// Thin, DOM-free wrapper around one instance of the wasm engine.
// Used on the main thread (as the source of truth for the patch and for
// drawing previews) and in Node tests. The audio thread talks to its own
// instance directly, see worklet.js.

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class EngineCore {
  /** @param {WebAssembly.Instance} instance */
  constructor(instance, sampleRate = 48000) {
    this.x = instance.exports;
    this.x.init(sampleRate);
    this.sampleRate = sampleRate;
    /** Engine self-description: parameter table, option lists, layouts. */
    this.info = JSON.parse(this.#readString(this.x.describe()));
    this.params = this.info.params;
    this.byKey = new Map(this.params.map((p) => [p.key, p]));
    this.bySid = new Map(this.params.map((p) => [p.sid, p]));
  }

  static async fromBytes(bytes, sampleRate = 48000) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new EngineCore(instance, sampleRate);
  }

  // --- shared buffer --------------------------------------------------------
  // Views are re-created on every use: growing wasm memory detaches old ones.

  #bytes() {
    return new Uint8Array(this.x.memory.buffer, this.x.io_ptr(), this.x.io_cap());
  }
  #floats(n) {
    return new Float32Array(this.x.memory.buffer, this.x.io_ptr(), n);
  }
  #readString(len) {
    return decoder.decode(this.#bytes().subarray(0, len));
  }
  #readFloats(n) {
    return this.#floats(n).slice();
  }

  // --- parameters -----------------------------------------------------------

  /** Index of a parameter key such as "filter.cutoff". */
  idx(key) {
    const p = this.byKey.get(key);
    if (!p) throw new Error(`unknown parameter: ${key}`);
    return p.i;
  }
  get(i) {
    return this.x.get_param(i);
  }
  set(i, norm) {
    this.x.set_param(i, norm);
  }
  /** Normalised 0..1 value to real units. */
  toPlain(i, norm) {
    return this.x.param_plain(i, norm);
  }
  toNorm(i, plain) {
    return this.x.param_norm(i, plain);
  }
  getPlain(i) {
    return this.toPlain(i, this.get(i));
  }
  setPlain(i, plain) {
    this.set(i, this.toNorm(i, plain));
  }

  // --- modulation -----------------------------------------------------------

  getSlot(i) {
    this.x.slot_get(i);
    const [src, dst, amount, bipolar] = this.#floats(4);
    return { src, dst, amount, bipolar: bipolar !== 0 };
  }
  /** `dst` < 0 or `src` 0 clears the slot. */
  setSlot(i, { src, dst, amount, bipolar }) {
    this.x.slot_set(i, src, dst, amount, bipolar ? 1 : 0);
  }
  getSlots() {
    return Array.from({ length: this.info.numSlots }, (_, i) => this.getSlot(i));
  }

  getLfoShape(l) {
    const n = this.x.lfo_shape_get(l);
    const f = this.#floats(n * 3);
    return Array.from({ length: n }, (_, k) => ({ x: f[k * 3], y: f[k * 3 + 1], curve: f[k * 3 + 2] }));
  }
  setLfoShape(l, points) {
    const pts = points.slice(0, this.info.maxLfoPoints);
    const f = this.#floats(pts.length * 3);
    pts.forEach((p, k) => {
      f[k * 3] = p.x;
      f[k * 3 + 1] = p.y;
      f[k * 3 + 2] = p.curve ?? 0;
    });
    this.x.lfo_shape_set(l, pts.length);
  }

  getFxOrder() {
    const n = this.x.fx_order_get();
    return Array.from(this.#bytes().subarray(0, n));
  }
  setFxOrder(order) {
    this.#bytes().set(order);
    return this.x.fx_order_set() === 1;
  }

  // --- whole patch ----------------------------------------------------------

  getName() {
    return this.#readString(this.x.name_get());
  }
  setName(name) {
    const bytes = encoder.encode(String(name)).subarray(0, 250);
    this.#bytes().set(bytes);
    this.x.name_set(bytes.length);
  }
  /** Compact binary form of the patch (what share URLs carry). */
  save() {
    const n = this.x.patch_save();
    return this.#bytes().slice(0, n);
  }
  /** Returns false (and changes nothing) if `bytes` is not a valid patch. */
  load(bytes) {
    if (bytes.length > this.x.io_cap()) return false;
    this.#bytes().set(bytes);
    return this.x.patch_load(bytes.length) === 1;
  }
  init() {
    this.x.patch_init();
  }

  // --- previews -------------------------------------------------------------

  previewOsc(osc, pos, warpAmt, n = 256) {
    return this.#readFloats(this.x.preview_osc(osc, pos, warpAmt, n));
  }
  previewTable(table, pos, n = 128) {
    return this.#readFloats(this.x.preview_table(table, pos, n));
  }
  tableFrames(table) {
    return this.x.table_frames(table);
  }
  previewLfo(l, n = 256) {
    return this.#readFloats(this.x.preview_lfo(l, n));
  }
  /** dB at n log-spaced points 20 Hz..20 kHz, or null if not applicable. */
  filterResponse(type, cutoffHz, res, variation, n = 128) {
    const len = this.x.filter_response(type, cutoffHz, res, variation, n);
    return len ? this.#readFloats(len) : null;
  }
  curve(t, c) {
    return this.x.curve(t, c);
  }

  // --- Serum 2 export ---------------------------------------------------------

  #blob(len) {
    return new Uint8Array(this.x.memory.buffer, this.x.blob_ptr(), len).slice();
  }

  /**
   * The current patch as a Serum 2 preset.
   * `notes` lists what could not be translated exactly ({ code, detail });
   * `tables` are the wavetables the preset expects in Serum's Tables folder.
   */
  serumExport() {
    const preset = this.#blob(this.x.serum_export());
    const notes = this.#readString(this.x.serum_notes())
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, detail = ''] = line.split('\t');
        return { code, detail };
      });
    const count = this.x.serum_tables();
    const tables = Array.from(this.#bytes().subarray(0, count)).map((index) => ({
      index,
      path: this.#readString(this.x.serum_table_path(index)),
    }));
    return { preset, notes, tables };
  }

  /** A factory wavetable as a WAV file Serum can load. */
  serumTableWav(index) {
    return this.#blob(this.x.serum_table_wav(index));
  }

  // --- audio (tests and offline rendering) -----------------------------------

  noteOn(note, velocity = 0.8) {
    this.x.note_on(note, velocity);
  }
  noteOff(note) {
    this.x.note_off(note);
  }
  /** Renders `frames` (<= 1024) and returns copies of both channels. */
  render(frames) {
    this.x.process(frames);
    const buf = this.x.memory.buffer;
    return [
      new Float32Array(buf, this.x.out_l_ptr(), frames).slice(),
      new Float32Array(buf, this.x.out_r_ptr(), frames).slice(),
    ];
  }
  telemetry() {
    return new Float32Array(this.x.memory.buffer, this.x.telemetry_ptr(), this.info.tele.len);
  }
  tap(index) {
    const { len } = this.info.tap;
    return new Float32Array(this.x.memory.buffer, this.x.taps_ptr() + index * len * 4, len);
  }
}
