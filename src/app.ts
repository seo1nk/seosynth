// The application object every part of the UI is handed: the engine, the
// patch, the audio thread and the shared parts of the page. It is built in
// main.ts; this file describes it.

import type { EngineCore } from './engine/core.ts';
import type { AudioEngine } from './engine/audio.ts';
import type { Store, StoreEvent, StoreEvents } from './store.ts';
import type { I18n, Lang } from './i18n.ts';
import type { Theme } from './theme.ts';
import type { Mods } from './ui/mods.ts';
import type { ScopeBank } from './ui/displays.ts';
import type { Board } from './ui/board.ts';
import type { Keyboard } from './ui/keyboard.ts';
import type { Help, Tour } from './ui/chrome.ts';
import type { Lesson } from './ui/lesson.ts';
import type { Child } from './ui/dom.ts';

/** Collects the clean-up work of one part of the UI, so that part can be
 * thrown away (a closed panel, a language switch) without leaking listeners. */
export class Scope {
  cleanups: (() => void)[] = [];
  add(fn: () => void): void {
    this.cleanups.push(fn);
  }
  dispose(): void {
    for (const fn of this.cleanups.splice(0)) fn();
  }
}

/** The latest state reported by the audio thread. Before audio runs, values
 * fall back to the patch so the displays still make sense. */
export interface Live {
  /** Modulated value (0..1) of a parameter, as it sounds right now. */
  param(i: number): number;
  /** Current output of a modulation source. */
  source(s: number): number;
  envPos(e: number): number;
  envVal(e: number): number;
  lfoPhase(l: number): number;
  lfoVal(l: number): number;
  readonly active: boolean;
  readonly voices: number;
  readonly note: number;
  /** The newest note is still held (not ringing out). */
  readonly gate: boolean;
  /** Where the clip sequencer is, in ticks, or -1 while it is not playing. */
  readonly clipPos: number;
  /** The clip that plays (0-based). */
  readonly clipSlot: number;
  readonly pitch: number;
  readonly peakL: number;
  readonly peakR: number;
}

export interface Toaster {
  (message: string, ms?: number): void;
  clear(): void;
}

export interface PopoverOptions {
  onClose?: () => void;
}

export interface DialogOptions {
  onClose?: () => void;
  wide?: boolean;
}

export interface App {
  root: HTMLElement;
  core: EngineCore;
  store: Store;
  audio: AudioEngine;
  toast: Toaster;
  live: Live;
  i18n: I18n;
  help: Help;
  mods: Mods;
  scopes: ScopeBank;
  board: Board;
  keyboard: Keyboard;
  tour: Tour;
  lesson: Lesson;
  /** Movers the user put on the board that are not connected to anything yet. */
  movers: Set<string>;
  /** The node whose settings are open. */
  selected: string | null;
  /** The built-in preset that was loaded last, if the sound is still that one. */
  presetIndex: number | null;
  /** True while a whole sound is being loaded (edits then are not the user's). */
  loading: boolean;
  /** Clean-ups of the part of the UI being built right now. */
  scope: Scope;

  // Subscriptions made through these belong to `scope` and go away with it.
  watch(i: number, fn: (norm: number) => void): () => void;
  on<E extends StoreEvent>(event: E, fn: (...args: StoreEvents[E]) => void): () => void;
  onFrame(fn: (live: Live) => void): void;
  onDispose(fn: () => void): void;
  /** Runs `build` with a fresh scope; returns its result and the scope. */
  inScope<T>(build: () => T): [T, Scope];

  popover(anchor: HTMLElement, content: Child, options?: PopoverOptions): () => void;
  dialog(title: Child, content: Child, options?: DialogOptions): HTMLDialogElement;
  /** Records an undo step a moment after the last call. */
  commitSoon(): void;
  /** Opens the settings of a node, or closes the panel with `null`. */
  select(id: string | null): void;
  toggleKeyboard(show?: boolean): void;
  demoPhrase(): string;
  loadPreset(index: number): void;
  setLang(lang: Lang): void;
  setTheme(theme: Theme): void;

  // Hooks other parts set to hear about things.
  onKeyboardShown?: (shown: boolean) => void;
  onDemo?: (playing: boolean) => void;
  onPlay?: (note: number) => void;
}
