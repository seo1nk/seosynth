// Minimal DOM helpers: the UI is plain DOM, no framework.

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(el, attrs, children, isSvg) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') {
      // Custom properties (--x) can only be set through setProperty.
      for (const [name, value] of Object.entries(v)) {
        if (name.startsWith('--')) el.style.setProperty(name, value);
        else el.style[name] = value;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (!isSvg && k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** h('div', { class: 'x', onclick }, child, 'text') */
export function h(tag, attrs, ...children) {
  return apply(document.createElement(tag), attrs, children, false);
}

export function s(tag, attrs, ...children) {
  return apply(document.createElementNS(SVG_NS, tag), attrs, children, true);
}

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/**
 * Drag helper with pointer capture. `onMove` receives the movement since the
 * drag started; works the same for mouse, pen and touch.
 */
export function drag(el, { onStart, onMove, onEnd, cursor }) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const state = onStart?.(e);
    if (state === false) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    if (cursor) document.body.style.cursor = cursor;
    const move = (ev) => onMove?.(ev.clientX - x0, ev.clientY - y0, ev, state);
    const up = (ev) => {
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
export function setupCanvas(canvas, width, height) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
