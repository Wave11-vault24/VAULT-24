// Customer transaction history: server-side paging (GET /accounts/:id/transactions
// with before_id). The text and type filters work on the rows loaded so far,
// because the API has no search endpoint; the UI says so.
import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { groupAccountNumber } from '../format.js';
import { pageHead, errorState, emptyState, skeletonRows, loadingBlock } from '../ui.js';
import { txTable, openTxDetail, balancesHidden } from './shared.js';

export async function view({ root, query }) {
  const area = h('div');
  mount(root, pageHead('Transaction History', 'Deposits and transfers on your accounts, newest first.',
    h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => window.print() }, icon('printer'), 'Print statement')), area);
  mount(area, loadingBlock('Loading your accounts…'));

  let accounts;
  try {
    ({ accounts } = await api.get('/accounts'));
  } catch (err) {
    if (err.status === 401) return;
    mount(area, errorState(err, () => view({ root, query })));
    return;
  }
  if (!accounts.length) {
    mount(area, h('div', { class: 'card' }, emptyState('No accounts yet', 'Your transactions will appear here once an account is opened.')));
    return;
  }

  const state = {
    accountId: accounts.some((a) => a.id === Number(query.get('account'))) ? Number(query.get('account')) : accounts[0].id,
    q: query.get('q') || '',
    dir: 'all',
    rows: [],
    nextBefore: null,
    total: 0,
  };
  const account = () => accounts.find((a) => a.id === state.accountId);

  const acctSelect = h('select', { class: 'select', id: 'hist-account' },
    accounts.map((a) => h('option', { value: String(a.id), selected: a.id === state.accountId || null }, `${a.account_type_label} · ${groupAccountNumber(a.account_number)}`)));
  const search = h('input', { class: 'input', id: 'hist-q', type: 'search', value: state.q, placeholder: 'Narration or reference', autocomplete: 'off' });
  const dirSelect = h('select', { class: 'select', id: 'hist-dir' },
    h('option', { value: 'all' }, 'All'), h('option', { value: 'credit' }, 'Money in'), h('option', { value: 'debit' }, 'Money out'));

  const status = h('p', { class: 'muted', 'aria-live': 'polite' });
  const tableEl = h('div');
  const moreBtn = h('button', { type: 'button', class: 'btn btn-secondary', hidden: true }, 'Load older transactions');

  mount(area,
    h('div', { class: 'card filters no-print' },
      h('div', { class: 'filters__grid' },
        h('div', { class: 'field' }, h('label', { for: 'hist-account' }, 'Account'), acctSelect),
        h('div', { class: 'field' }, h('label', { for: 'hist-q' }, 'Filter'), search),
        h('div', { class: 'field' }, h('label', { for: 'hist-dir' }, 'Type'), dirSelect)),
      h('p', { class: 'hint' }, 'Filters apply to the transactions loaded below. Use "Load older transactions" to include earlier ones.')),
    h('div', { style: 'height:16px' }),
    h('section', { class: 'card card--flush', 'aria-label': 'Transactions' },
      h('div', { class: 'card__head' }, h('h2', {}, 'Transactions'), status),
      tableEl,
      h('div', { class: 'load-more no-print' }, moreBtn)));

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return state.rows.filter((r) => (state.dir === 'all' || r.direction === state.dir)
      && (!q || String(r.narration || '').toLowerCase().includes(q) || r.reference.toLowerCase().includes(q)));
  }

  function render() {
    const a = account();
    const rows = filtered();
    status.textContent = state.rows.length
      ? `Showing ${rows.length} of ${state.rows.length} loaded · ${state.total} in total`
      : '';
    if (!state.rows.length) mount(tableEl, emptyState('No transactions yet', 'Deposits and transfers on this account will appear here.'));
    else if (!rows.length) mount(tableEl, emptyState('No matches', 'No loaded transactions match your filter.'));
    else mount(tableEl, txTable(rows, { currency: a.currency, hidden: balancesHidden(), onOpen: (tx) => openTxDetail(tx, a.currency) }));
    moreBtn.hidden = !state.nextBefore;
  }

  async function load(more = false) {
    if (!more) { state.rows = []; state.nextBefore = null; mount(tableEl, skeletonRows(8, 5)); status.textContent = ''; }
    moreBtn.disabled = true;
    try {
      const data = await api.get(`/accounts/${state.accountId}/transactions`, { query: { limit: 25, before_id: more ? state.nextBefore : undefined } });
      state.rows.push(...data.transactions);
      state.nextBefore = data.next_before_id;
      state.total = data.total_count;
      render();
    } catch (err) {
      if (err.status === 401) return;
      mount(tableEl, errorState(err, () => load(more)));
    } finally {
      moreBtn.disabled = false;
    }
  }

  acctSelect.addEventListener('change', () => {
    state.accountId = Number(acctSelect.value);
    history.replaceState(null, '', `#/history?account=${state.accountId}`);
    load();
  });
  search.addEventListener('input', () => { state.q = search.value; render(); });
  dirSelect.addEventListener('change', () => { state.dir = dirSelect.value; render(); });
  moreBtn.addEventListener('click', () => load(true));

  await load();
}

