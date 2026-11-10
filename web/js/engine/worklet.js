// Audio thread. Owns its own instance of the wasm engine and renders sound.
// Kept self-contained (no imports, no TextDecoder) because that is what every
// browser supports inside an AudioWorklet.

const TELEMETRY_EVERY = 6; // render quanta between telemetry posts (~60 Hz)
const TAPS_EVERY = 12; // (~30 Hz)
const TAP_WINDOW = 1024; // samples of each tap sent to the UI

class SeosynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasm, tele, tap } = options.processorOptions;
    const module = new WebAssembly.Module(wasm);
    this.x = new WebAssembly.Instance(module, {}).exports;
    this.x.init(sampleRate);
    this.tele = tele;
    this.tap = tap;
    this.quantum = 0;
    this.peakL = 0;
    this.peakR = 0;
    this.sendTaps = true;
    this.buffer = null;
    this.port.onmessage = (e) => this.handle(e.data);
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  // Views into wasm memory, rebuilt whenever the memory grows.
  views() {
    const buffer = this.x.memory.buffer;
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.outL = new Float32Array(buffer, this.x.out_l_ptr(), 1024);
      this.outR = new Float32Array(buffer, this.x.out_r_ptr(), 1024);
      this.teleView = new Float32Array(buffer, this.x.telemetry_ptr(), this.tele.len);
      this.tapView = new Float32Array(buffer, this.x.taps_ptr(), this.tap.count * this.tap.len);
    }
  }

  handle(m) {
    const x = this.x;
    switch (m[0]) {
      case 'param':
        x.set_param(m[1], m[2]);
        break;
      case 'on':
        x.note_on(m[1], m[2]);
        break;
      case 'off':
        x.note_off(m[1]);
        break;
      case 'patch': {
        const bytes = m[1];
        new Uint8Array(x.memory.buffer, x.io_ptr(), bytes.length).set(bytes);
        x.patch_load(bytes.length);
        break;
      }
      case 'bend':
        x.pitch_bend(m[1]);
        break;
      case 'wheel':
        x.mod_wheel(m[1]);
        break;
      case 'touch':
        x.aftertouch(m[1]);
        break;
      case 'allOff':
        x.all_notes_off();
        break;
      case 'panic':
        x.panic_stop();
        break;
      case 'taps':
        this.sendTaps = !!m[1];
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    this.x.process(n);
    this.views();
    out[0].set(this.outL.subarray(0, n));
    if (out[1]) out[1].set(this.outR.subarray(0, n));

    const t = this.teleView;
    this.peakL = Math.max(this.peakL, t[this.tele.peakL]);
    this.peakR = Math.max(this.peakR, t[this.tele.peakR]);

    this.quantum++;
    if (this.quantum % TELEMETRY_EVERY === 0) {
      const tele = t.slice();
      tele[this.tele.peakL] = this.peakL;
      tele[this.tele.peakR] = this.peakR;
      this.peakL = 0;
      this.peakR = 0;
      const msg = { type: 'tele', tele };
      const transfer = [tele.buffer];
      if (this.sendTaps && this.quantum % TAPS_EVERY === 0) {
        // Unroll each ring buffer so the UI gets the most recent samples in
        // chronological order.
        const { count, len } = this.tap;
        const taps = new Float32Array(count * TAP_WINDOW);
        const end = t[this.tele.tapPos];
        const start = (end - TAP_WINDOW + len) % len;
        for (let k = 0; k < count; k++) {
          const ring = this.tapView.subarray(k * len, (k + 1) * len);
          const first = Math.min(TAP_WINDOW, len - start);
          taps.set(ring.subarray(start, start + first), k * TAP_WINDOW);
          if (first < TAP_WINDOW) taps.set(ring.subarray(0, TAP_WINDOW - first), k * TAP_WINDOW + first);
        }
        msg.taps = taps;
        transfer.push(taps.buffer);
      }
      this.port.postMessage(msg, transfer);
    }
    return true;
  }
}

registerProcessor('seosynth', SeosynthProcessor);
