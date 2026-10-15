// Pieces shared by customer, staff and admin views.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { formatDateTime, formatMinor, signedMoney, money, groupAccountNumber, titleCase } from '../format.js';
import { openDialog, badge, loadInto, copyButton } from '../ui.js';

const TYPE_LABEL = { cash_deposit: 'Cash deposit', transfer_debit: 'Transfer out', transfer_credit: 'Transfer in' };

/* ---- Balance privacy toggle (UI preference only; not sensitive) ---- */
const PREF_KEY = 'vault24.hideBalances';
export function balancesHidden() {
  try { return localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
}
export function setBalancesHidden(v) {
  try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* storage blocked: keep in-memory only */ }
  document.dispatchEvent(new CustomEvent('vault24:balances-visibility'));
}

/** A money value that respects the hide-balances preference, with screen-reader text. */
export function maskedMoney(text, hidden) {
  return hidden
    ? h('span', { class: 'amount' }, h('span', { 'aria-hidden': 'true' }, '••••••'), h('span', { class: 'visually-hidden' }, 'hidden'))
    : h('span', { class: 'amount' }, text);
}

export function eyeToggle(hidden, onToggle) {
  return h('button', {
    type: 'button', class: 'icon-btn', 'aria-pressed': String(!hidden),
    'aria-label': hidden ? 'Show balances' : 'Hide balances', onclick: onToggle,
  }, icon(hidden ? 'eye-off' : 'eye'));
}

export function typeCell(tx) {
  const credit = tx.amount_minor > 0;
  return h('span', { class: 'cell-type' },
    h('span', { class: `dir dir--${credit ? 'credit' : 'debit'}` }, icon(credit ? 'arrow-down' : 'arrow-up')),
    h('span', {}, credit ? 'Credit' : 'Debit'));
}

/** Transactions table (becomes stacked cards on phones). */
export function txTable(rows, { currency = 'ZMW', hidden = false, showBalance = true, onOpen } = {}) {
  const head = h('thead', {}, h('tr', {},
    h('th', { scope: 'col' }, 'Date'),
    h('th', { scope: 'col' }, 'Description'),
    h('th', { scope: 'col' }, 'Type'),
    h('th', { scope: 'col', class: 'text-right' }, 'Amount'),
    showBalance ? h('th', { scope: 'col', class: 'text-right' }, 'Balance') : null,
    h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Details'))));
  const body = h('tbody', {}, rows.map((tx) => {
    const credit = tx.amount_minor > 0;
    const open = () => onOpen && onOpen(tx);
    return h('tr', { class: onOpen ? 'is-clickable' : null, onclick: (e) => { if (!e.target.closest('button')) open(); } },
      h('td', { 'data-label': 'Date', class: 'nowrap' }, formatDateTime(tx.created_at)),
      h('td', { 'data-label': 'Description', class: 'cell-primary' }, tx.narration || TYPE_LABEL[tx.transaction_type] || '—'),
      h('td', { 'data-label': 'Type' }, typeCell(tx)),
      h('td', { 'data-label': 'Amount', class: `text-right amount--${credit ? 'credit' : 'debit'}` }, maskedMoney(signedMoney(tx.amount_minor, currency), hidden)),
      showBalance ? h('td', { 'data-label': 'Balance', class: 'text-right' }, maskedMoney(formatMinor(tx.balance_after_minor), hidden)) : null,
      h('td', { class: 'cell-actions' }, onOpen
        ? h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': `Details for ${tx.narration || TYPE_LABEL[tx.transaction_type]} on ${formatDateTime(tx.created_at)}`, onclick: open }, icon('chevron-right'))
        : null));
  }));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table table--stack' }, h('caption', { class: 'visually-hidden' }, 'Transactions'), head, body));
}

/**
 * Transaction details. For transfer legs it fetches GET /api/transfers/:reference
 * (authoritative status and parties); deposits are shown from the row itself
 * because there is no deposit-detail endpoint.
 */
export function openTxDetail(tx, currency = 'ZMW') {
  const base = h('dl', { class: 'dl dl--2' },
    dd('Reference', h('span', { class: 'copy-row' }, h('span', { class: 'mono' }, tx.reference), copyButton(tx.reference, 'Copy reference'))),
    dd('Date', formatDateTime(tx.created_at)),
    dd('Type', TYPE_LABEL[tx.transaction_type] || titleCase(tx.transaction_type)),
    dd('Amount', h('span', { class: `amount amount--${tx.amount_minor > 0 ? 'credit' : 'debit'}` }, signedMoney(tx.amount_minor, currency))),
    dd('Balance after', money(tx.balance_after_minor, currency)),
    dd('Narration', tx.narration || '—'));
  const extra = h('div', { class: 'stack', style: 'margin-top:16px' });
  if (tx.transfer_reference) {
    loadInto(extra, () => api.get(`/transfers/${encodeURIComponent(tx.transfer_reference)}`), ({ transfer }) => h('div', { class: 'stack-sm' },
      h('h3', {}, 'Transfer'),
      h('dl', { class: 'dl dl--2' },
        dd('Status', badge(transfer.status)),
        dd('Transfer reference', h('span', { class: 'mono' }, transfer.reference)),
        dd('From account', h('span', { class: 'mono' }, groupAccountNumber(transfer.from_account_number))),
        dd('To account', h('span', { class: 'mono' }, groupAccountNumber(transfer.to_account_number))),
        dd('Recipient name', transfer.to_account_name),
        dd('Completed', formatDateTime(transfer.completed_at)))));
  }
  return openDialog({ title: 'Transaction details', body: h('div', {}, base, extra), actions: [{ label: 'Close', kind: 'primary' }] });
}

export function dd(label, value) {
  return h('div', {}, h('dt', {}, label), h('dd', {}, value));
}

export function accountStatusText(status) {
  const map = { active: ['', 'check-circle', 'Active'], frozen: ['--warning', 'snowflake', 'Frozen'], closed: ['--danger', 'x-circle', 'Closed'] };
  const [mod, ic, label] = map[status] || ['--warning', 'info', titleCase(status)];
  return h('span', { class: `status-text status-text${mod}` }, icon(ic), label);
}
