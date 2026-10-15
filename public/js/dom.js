// Tiny, safe DOM builder. Server-supplied values are only ever set as text
// (textContent / attributes), never parsed as HTML, so a malicious narration
// like "<img onerror=...>" renders as plain text.
import { ICONS } from './config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-label': 'Close' }, 'Text', child)
 * - string/number children become text nodes
 * - null/false/undefined children are skipped
 * - on* props become event listeners (no inline handlers: CSP forbids them)
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'ref') {
      value(el);
    } else if (key in el && typeof value !== 'string' && key !== 'list') {
      el[key] = value; // e.g. disabled, checked, value as non-string
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace all children of el. */
export function mount(el, ...children) {
  clear(el);
  return append(el, children);
}

/** <svg class="icon"><use href="sprite.svg#name"/></svg>, decorative unless label given. */
export function icon(name, { cls = '', label } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let idSeq = 0;
export const uid = (prefix = 'id') => `${prefix}-${++idSeq}`;
