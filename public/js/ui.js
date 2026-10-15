// Shared UI building blocks. Everything renders server text via h()/textContent.
import { h, icon, mount, uid, $ } from './dom.js';
import { titleCase } from './format.js';

/* ---------------- Toasts (aria-live polite) ---------------- */
export function toast(message, kind = 'success') {
  let region = $('#toast-region');
  if (!region) {
    region = h('div', { id: 'toast-region', class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  const el = h('div', { class: `toast toast--${kind}` },
    icon(kind === 'error' ? 'x-circle' : kind === 'info' ? 'info' : 'check-circle'),
    h('span', {}, message));
  region.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4500);
}

/* ---------------- Dialogs (native <dialog>: focus trap + Esc built in) ---------------- */
/**
 * openDialog({ title, body, actions:[{label, kind, value, onClick}] }) -> Promise<value|null>
 * Focus returns to the opener when the dialog closes.
 */
export function openDialog({ title, description, body, actions = [], dismissible = true, size }) {
  const opener = document.activeElement;
  const titleId = uid('dlg-title');
  const descId = description ? uid('dlg-desc') : null;
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId, 'aria-describedby': descId });
    if (size === 'lg') dialog.style.width = 'min(760px, calc(100vw - 24px))';
    let result = null;
    const close = (value) => { result = value; dialog.close(); };
    const foot = h('div', { class: 'dialog__foot' }, actions.map((a) => {
      const btn = h('button', { type: 'button', class: `btn btn-${a.kind || 'secondary'}`, dataset: { value: a.value ?? '' } }, a.icon ? icon(a.icon) : null, a.label);
      btn.addEventListener('click', async () => {
        if (a.onClick) {
          const keepOpen = await a.onClick(btn, close);
          if (keepOpen === true) return;
        }
        close(a.value ?? null);
      });
      return btn;
    }));
    const inner = h('div', { class: 'dialog__inner' },
      h('div', { class: 'dialog__head' },
        h('h2', { id: titleId }, title),
        dismissible ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close dialog', onclick: () => close(null) }, icon('close')) : null),
      h('div', { class: 'dialog__body' }, description ? h('p', { id: descId, class: 'muted' }, description) : null, body || null),
      actions.length ? foot : null);
    dialog.append(inner);
    dialog.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (opener && opener.focus) opener.focus();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    const primary = dialog.querySelector('.btn-primary, .btn-danger, .btn-success');
    (primary || dialog.querySelector('button')).focus();
  });
}

export function confirmDialog({ title, description, body, confirmLabel = 'Confirm', kind = 'primary', cancelLabel = 'Cancel' }) {
  return openDialog({
    title, description, body,
    actions: [
      { label: cancelLabel, kind: 'secondary', value: false },
      { label: confirmLabel, kind, value: true },
    ],
  }).then((v) => v === true);
}

/* ---------------- Buttons ---------------- */
/** Disable a button and show a spinner while `work` runs; prevents double submission. */
export async function withBusy(button, work, busyLabel) {
  if (!button || button.dataset.busy === '1') return undefined;
  const original = Array.from(button.childNodes);
  button.dataset.busy = '1';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  mount(button, h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel || button.textContent.trim());
  try {
    return await work();
  } finally {
    if (button.isConnected) {
      mount(button, ...original);
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
    delete button.dataset.busy;
  }
}

export function copyButton(text, label = 'Copy') {
  const btn = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': `${label}` }, icon('copy', { cls: 'icon-sm' }));
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success');
    } catch {
      toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  });
  return btn;
}

/* ---------------- Status badges (text + icon, never colour alone) ---------------- */
const STATUS = {
  active: ['success', 'check-circle'], verified: ['success', 'check-circle'], completed: ['success', 'check-circle'], success: ['success', 'check-circle'],
  pending: ['warning', 'clock'], locked: ['danger', 'lock'], suspended: ['danger', 'x-circle'], rejected: ['danger', 'x-circle'],
  failed: ['danger', 'x-circle'], failure: ['danger', 'x-circle'], frozen: ['info', 'snowflake'], closed: ['neutral', 'x-circle'],
};
export function badge(status, label) {
  const [kind, ic] = STATUS[status] || ['neutral', 'info'];
  return h('span', { class: `badge badge--${kind}` }, icon(ic), label || titleCase(status));
}

/* ---------------- Alerts / states ---------------- */
export function alertBox(kind, title, message, extra) {
  const ic = { error: 'alert', success: 'check-circle', warning: 'alert', info: 'info' }[kind];
  return h('div', { class: `alert alert--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(ic),
    h('div', { class: 'alert__body' }, title ? h('p', { class: 'alert__title' }, title) : null, message ? h('p', {}, message) : null, extra || null));
}

export function errorState(error, onRetry, title = 'We could not load this') {
  const msg = error && error.message ? error.message : 'Something went wrong.';
  return h('div', { class: 'state state--error', role: 'alert' },
    h('div', { class: 'state__icon' }, icon('alert', { cls: 'icon-lg' })),
    h('h3', {}, title),
    h('p', {}, msg),
    error && error.requestId ? h('p', { class: 'kbd-note' }, `Reference: ${error.requestId}`) : null,
    onRetry ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: onRetry }, icon('refresh'), 'Try again') : null);
}

export function emptyState(title, message, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'state__icon' }, icon('info', { cls: 'icon-lg' })),
    h('h3', {}, title), message ? h('p', {}, message) : null, action || null);
}

export function skeletonRows(n = 5, cols = 4) {
  return h('div', { 'aria-hidden': 'true' }, Array.from({ length: n }, () =>
    h('div', { class: 'skeleton-row' }, Array.from({ length: cols }, (_, i) => h('span', { class: 'skeleton', style: `flex:${i === 1 ? 2 : 1}` })))));
}

export function loadingBlock(label = 'Loading…') {
  return h('div', { class: 'state', role: 'status' }, h('div', { class: 'spinner' }), h('p', {}, label));
}

/* ---------------- Forms ---------------- */
/**
 * Build a labelled field. Returns { wrap, input, setError }.
 * opts: { label, name, type, required, hint, value, placeholder, autocomplete, inputmode, icon, prefix, control }
 */
export function field(opts) {
  const id = uid(`f-${opts.name}`);
  const hintId = opts.hint ? `${id}-hint` : null;
  const errId = `${id}-err`;
  const control = opts.control || h(opts.multiline ? 'textarea' : 'input', {
    id, name: opts.name, type: opts.multiline ? null : (opts.type || 'text'),
    class: opts.multiline ? 'textarea' : ['input', opts.trail ? 'input--trail' : ''],
    required: opts.required || null, value: opts.value ?? null, placeholder: opts.placeholder || null,
    autocomplete: opts.autocomplete || null, inputmode: opts.inputmode || null, maxlength: opts.maxlength || null,
    pattern: opts.pattern || null, readonly: opts.readonly || null,
    'aria-describedby': [hintId].filter(Boolean).join(' ') || null,
  });
  if (opts.control) {
    control.id = id;
    if (hintId) control.setAttribute('aria-describedby', hintId);
  }
  let inner = control;
  if (opts.icon) inner = h('div', { class: 'input-icon' }, icon(opts.icon), control, opts.trail || null);
  else if (opts.prefix) inner = h('div', { class: 'input-prefix' }, h('span', { class: 'input-prefix__text', 'aria-hidden': 'true' }, opts.prefix), control);
  const error = h('p', { id: errId, class: 'field-error', hidden: true });
  const wrap = h('div', { class: 'field' },
    h('label', { for: id }, opts.label, opts.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null, opts.required ? h('span', { class: 'visually-hidden' }, ' (required)') : null),
    opts.hint ? h('p', { id: hintId, class: 'hint' }, opts.hint) : null,
    inner, error);
  const setError = (message) => {
    if (message) {
      mount(error, icon('alert'), h('span', {}, message));
      error.hidden = false;
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', [hintId, errId].filter(Boolean).join(' '));
    } else {
      error.hidden = true;
      control.removeAttribute('aria-invalid');
      if (hintId) control.setAttribute('aria-describedby', hintId); else control.removeAttribute('aria-describedby');
    }
  };
  control.addEventListener('input', () => setError(null));
  return { wrap, input: control, setError, name: opts.name };
}

/**
 * Show server/client errors on a form. fields: array from field().
 * Unknown-field errors go to the summary box. Focuses the first invalid field.
 */
export function showErrors(summaryEl, fields, error, title = 'Please correct the following') {
  const map = typeof error.fieldErrors === 'function' ? error.fieldErrors() : (error.fields || {});
  const unmatched = [];
  let first = null;
  for (const [name, message] of Object.entries(map)) {
    const f = fields.find((x) => x.name === name);
    if (f) { f.setError(message); first = first || f.input; } else unmatched.push(message);
  }
  const hasFieldErrors = Object.keys(map).length > 0;
  const message = hasFieldErrors ? (unmatched.length ? null : 'Check the highlighted fields.') : error.message;
  const list = unmatched.length ? h('ul', {}, unmatched.map((m) => h('li', {}, m))) : null;
  mount(summaryEl, alertBox('error', hasFieldErrors ? title : 'That did not work', message, list));
  summaryEl.hidden = false;
  if (first) first.focus(); else summaryEl.focus();
}

export function clearErrors(summaryEl, fields) {
  for (const f of fields) f.setError(null);
  if (summaryEl) { mount(summaryEl); summaryEl.hidden = true; }
}

export function errorSummary() {
  return h('div', { class: 'form-summary', tabindex: '-1', hidden: true });
}

export function pageHead(title, subtitle, actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', { tabindex: '-1', 'data-page-title': '' }, title), subtitle ? h('p', {}, subtitle) : null),
    actions ? h('div', { class: 'page-head__actions' }, actions) : null);
}

/** Render async content into a container with loading -> data|error states. */
export async function loadInto(container, loader, render, { loading = loadingBlock(), errorTitle } = {}) {
  mount(container, loading);
  container.setAttribute('aria-busy', 'true');
  try {
    const data = await loader();
    if (!container.isConnected) return;
    mount(container, render(data));
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (err && err.status === 401) return; // global session-expired handler takes over
    mount(container, errorState(err, () => loadInto(container, loader, render, { loading, errorTitle }), errorTitle));
  } finally {
    container.removeAttribute('aria-busy');
  }
}
