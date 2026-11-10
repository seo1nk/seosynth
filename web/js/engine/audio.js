// Main-thread side of the audio engine: owns the AudioContext and the
// AudioWorklet node, and relays messages to the audio thread.

export const TAP_WINDOW = 1024;

export class AudioEngine {
  /**
   * @param {ArrayBuffer} wasmBytes  the compiled engine
   * @param {object} info            `EngineCore.info` (buffer layouts)
   */
  constructor(wasmBytes, info) {
    this.wasmBytes = wasmBytes;
    this.info = info;
    this.ctx = null;
    this.node = null;
    this.analyser = null;
    this.ready = false;
    this.queue = [];
    this.onTelemetry = null;
    this.onState = null;
    this.starting = null;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  get running() {
    return this.ready && this.ctx.state === 'running';
  }

  /** Builds the audio graph. Safe to call before any user gesture. */
  start() {
    if (!this.starting) this.starting = this.#start();
    return this.starting;
  }

  async #start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx.addEventListener('statechange', () => this.onState?.(this.ctx.state));
    await this.ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'nami', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm: this.wasmBytes, tele: this.info.tele, tap: this.info.tap },
    });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') {
        this.ready = true;
        for (const q of this.queue) this.node.port.postMessage(q);
        this.queue.length = 0;
        this.onState?.(this.ctx.state);
      } else if (m.type === 'tele') {
        this.onTelemetry?.(m.tele, m.taps);
      }
    };
    this.node.onprocessorerror = (e) => console.error('audio processor error', e);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;
    this.node.connect(this.analyser);
    this.node.connect(this.ctx.destination);
  }

  /** Browsers only let audio start from a user gesture: call from one. */
  async resume() {
    await this.start();
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* stays suspended until the next gesture */
      }
    }
  }

  post(msg) {
    if (this.ready) this.node.port.postMessage(msg);
    else if (msg[0] !== 'on' && msg[0] !== 'off') {
      // Before the worklet exists, remember state changes but not notes.
      if (msg[0] === 'patch') this.queue = this.queue.filter((q) => q[0] !== 'patch' && q[0] !== 'param');
      this.queue.push(msg);
    }
  }
}
