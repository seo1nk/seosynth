// Main-thread side of the audio engine: owns the AudioContext and the
// AudioWorklet node, and relays messages to the audio thread.

import type { AudioMessage, AudioReply, EngineInfo, ProcessorOptions } from './types.ts';

export const TAP_WINDOW = 1024;

export class AudioEngine {
  readonly wasmBytes: ArrayBuffer;
  readonly info: EngineInfo;
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  ready = false;
  queue: AudioMessage[] = [];
  onTelemetry: ((tele: Float32Array, taps?: Float32Array) => void) | null = null;
  onState: ((state: AudioContextState) => void) | null = null;
  /** Supplies the raw frames of a factory table the audio thread asks for. */
  tableSource: ((index: number) => Float32Array) | null = null;
  starting: Promise<void> | null = null;

  /**
   * @param wasmBytes  the compiled engine
   * @param info       `EngineCore.info` (buffer layouts)
   */
  constructor(wasmBytes: ArrayBuffer, info: EngineInfo) {
    this.wasmBytes = wasmBytes;
    this.info = info;
  }

  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  get running(): boolean {
    return this.ready && this.ctx?.state === 'running';
  }

  /** Builds the audio graph. Safe to call before any user gesture. */
  start(): Promise<void> {
    if (!this.starting) this.starting = this.#start();
    return this.starting;
  }

  async #start(): Promise<void> {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    ctx.addEventListener('statechange', () => this.onState?.(ctx.state));
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    const processorOptions: ProcessorOptions = { wasm: this.wasmBytes, tele: this.info.tele, tap: this.info.tap };
    const node = new AudioWorkletNode(ctx, 'seosynth', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions,
    });
    this.node = node;
    node.port.onmessage = (e: MessageEvent<AudioReply>) => {
      const m = e.data;
      if (m.type === 'ready') {
        this.ready = true;
        for (const q of this.queue) node.port.postMessage(q);
        this.queue.length = 0;
        this.onState?.(ctx.state);
      } else if (m.type === 'tele') {
        this.onTelemetry?.(m.tele, m.taps);
      } else if (m.type === 'needTable') {
        const raw = this.tableSource?.(m.index);
        // The frames are not needed here afterwards: hand the buffer over.
        if (raw) node.port.postMessage(['table', m.index, raw] satisfies AudioMessage, [raw.buffer]);
      }
    };
    node.onprocessorerror = (e) => console.error('audio processor error', e);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;
    this.analyser = analyser;
    node.connect(analyser);
    node.connect(ctx.destination);
  }

  /** Browsers only let audio start from a user gesture: call from one. */
  async resume(): Promise<void> {
    await this.start();
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* stays suspended until the next gesture */
      }
    }
  }

  post(msg: AudioMessage): void {
    if (this.ready && this.node) this.node.port.postMessage(msg);
    else if (msg[0] !== 'on' && msg[0] !== 'off') {
      // Before the worklet exists, remember state changes but not notes.
      if (msg[0] === 'patch') this.queue = this.queue.filter((q) => q[0] !== 'patch' && q[0] !== 'param');
      this.queue.push(msg);
    }
  }
}
