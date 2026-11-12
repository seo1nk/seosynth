// Minimal DOM helpers: the UI is plain DOM, no framework.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** `onclick`, `oninput`, ...: listeners, typed by event. */
type Handlers = {
  [K in keyof HTMLElementEventMap as `on${K}`]?: (e: HTMLElementEventMap[K]) => void;
};

/**
 * Attributes for `h()` and `s()`. `class`, `style` (an object; `--x` custom
 * properties allowed), `dataset` and `on*` listeners are handled specially.
 * Other keys become properties when the element has one (value, disabled,
 * hidden, ...) and attributes otherwise. `null`, `undefined` and `false`
 * are skipped.
 */
export type Attrs = Handlers & {
  class?: string;
  style?: Record<string, string | number>;
  dataset?: Record<string, string>;
  [key: string]: unknown;
};

/** Anything that can be a child: nodes, text, nothing, or lists of those. */
export type Child = Node | string | number | boolean | null | undefined | readonly Child[];

function apply<E extends Element>(el: E, attrs: Attrs | null | undefined, children: Child[], isSvg: boolean): E {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', String(v));
    else if (k === 'style' && typeof v === 'object') {
      const style = (el as unknown as ElementCSSInlineStyle).style;
      // Custom properties (--x) can only be set through setProperty.
      for (const [name, value] of Object.entries(v as Record<string, string | number>)) {
        if (name.startsWith('--')) style.setProperty(name, String(value));
        else (style as unknown as Record<string, string>)[name] = String(value);
      }
    } else if (k === 'dataset') Object.assign((el as unknown as HTMLElement).dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (!isSvg && k in el && k !== 'list' && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of (children as unknown[]).flat(Infinity) as (Node | string | number | boolean | null | undefined)[]) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** h('div', { class: 'x', onclick }, child, 'text') */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  return apply(document.createElement(tag), attrs, children, false);
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  return apply(document.createElementNS(SVG_NS, tag), attrs, children, true);
}

export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));

export interface DragHandlers<S> {
  /** Called on press; returning `false` cancels the drag. */
  onStart?: (e: PointerEvent) => S | false;
  /** Movement since the drag started. */
  onMove?: (dx: number, dy: number, e: PointerEvent, state: S) => void;
  onEnd?: (e: PointerEvent, state: S) => void;
  cursor?: string;
}

/**
 * Drag helper with pointer capture. `onMove` receives the movement since the
 * drag started; works the same for mouse, pen and touch.
 */
export function drag<S = void>(el: HTMLElement, { onStart, onMove, onEnd, cursor }: DragHandlers<S>): void {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const started = onStart?.(e);
    if (started === false) return;
    const state = started as S;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    if (cursor) document.body.style.cursor = cursor;
    const move = (ev: PointerEvent) => onMove?.(ev.clientX - x0, ev.clientY - y0, ev, state);
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (cursor) document.body.style.cursor = '';
      onEnd?.(ev, state);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

/** Sizes a canvas for the device pixel ratio and returns a 2D context
 * scaled so drawing code can use CSS pixels. */
export function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
