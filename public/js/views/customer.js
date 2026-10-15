// Customer dashboard, account list and account detail.
import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { money, groupAccountNumber, formatDate } from '../format.js';
import { pageHead, loadInto, errorState, emptyState, skeletonRows, copyButton, badge, alertBox } from '../ui.js';
import { txTable, openTxDetail, balancesHidden, setBalancesHidden, maskedMoney, eyeToggle, accountStatusText, dd } from './shared.js';

const firstName = (name) => String(name || '').split(/\s+/)[0];

/* =========================== Dashboard =========================== */
export async function dashboard({ root, session, query }) {
  const head = pageHead(`Welcome back, ${firstName(session.user.full_name)}!`, "Here's an overview of your banking activity.");
  const body = h('div', { class: 'dash-grid' });
  mount(root, head, body);

  const main = h('div', { class: 'stack' });
  const side = h('aside', { class: 'stack', 'aria-label': 'Shortcuts' }, securityCard(), quickActions(), promoCard());
  mount(body, main, side);

  let accounts = [];
  let selectedId = Number(query.get('account')) || null;
  let recent = null;
  let recentError = null;

  const verificationNote = session.user.verification_status !== 'verified'
    ? alertBox('warning', 'Identity check in progress', 'Your identity document is being reviewed. Some services start once it is approved.')
    : null;

  const statsEl = h('div', { class: 'stat-grid', 'aria-live': 'polite' });
  const tabsEl = h('div');
  const recentEl = h('section', { class: 'card card--flush', 'aria-labelledby': 'recent-title' });

  async function loadAccounts() {
    mount(main, verificationNote, h('div', { class: 'stat-grid' }, [1, 2, 3, 4].map(() => h('div', { class: 'stat stat--sky' }, h('span', { class: 'skeleton', style: 'width:42px;height:42px;border-radius:50%' }), h('span', { class: 'skeleton', style: 'width:60%' }), h('span', { class: 'skeleton', style: 'width:80%;height:24px' })))), h('div', { class: 'card' }, skeletonRows(6, 5)));
    try {
      ({ accounts } = await api.get('/accounts'));
    } catch (err) {
      if (err.status === 401) return;
      mount(main, errorState(err, loadAccounts, 'We could not load your accounts'));
      return;
    }
    if (!accounts.length) {
      mount(main, verificationNote, h('div', { class: 'card' }, emptyState('No accounts yet', 'Vault24 staff open accounts at a branch once your identity is verified.')));
      return;
    }
    if (!accounts.some((a) => a.id === selectedId)) selectedId = accounts[0].id;
    mount(main, verificationNote, tabsEl, statsEl, recentEl);
    renderAll();
    loadRecent();
  }

  async function loadRecent() {
    recent = null;
    recentError = null;
    renderRecent();
    try {
      recent = await api.get(`/accounts/${selectedId}/transactions`, { query: { limit: 6 } });
    } catch (err) {
      if (err.status === 401) return;
      recentError = err;
    }
    renderStats();
    renderRecent();
  }

  const selected = () => accounts.find((a) => a.id === selectedId);

  function renderAll() {
    renderTabs();
    renderStats();
    renderRecent();
  }

  function renderTabs() {
    if (accounts.length < 2) { mount(tabsEl); return; }
    mount(tabsEl, h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Choose account' }, accounts.map((a) =>
      h('button', {
        type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(a.id === selectedId),
        onclick: () => {
          selectedId = a.id;
          history.replaceState(null, '', `#/dashboard?account=${a.id}`);
          renderAll();
          loadRecent();
        },
      }, `${a.account_type_label} · ${a.account_number.slice(-4)}`))));
  }

  function renderStats() {
    const a = selected();
    if (!a) return;
    const hidden = balancesHidden();
    const toggle = () => setBalancesHidden(!balancesHidden());
    mount(statsEl,
      stat('blue', 'bank', 'Account Balance', maskedMoney(money(a.balance_minor, a.currency), hidden), eyeToggle(hidden, toggle), `${a.account_type_label} · ${groupAccountNumber(a.account_number)}`),
      stat('green', 'transfer', 'Available Balance', maskedMoney(money(a.available_balance_minor, a.currency), hidden), eyeToggle(hidden, toggle), 'No holds on this account'),
      stat('purple', 'calendar', 'Total Transactions', recent ? String(recent.total_count).padStart(4, '0') : h('span', { class: 'skeleton', style: 'width:64px;height:22px' }), null, 'On this account'),
      stat('sky', 'shield', 'Account Status', accountStatusText(a.status), null, a.status === 'active' ? 'Ready to send and receive' : 'Contact a branch for help'));
  }

  function renderRecent() {
    const a = selected();
    if (!a) return;
    const viewAll = h('a', { class: 'card__link', href: `#/history?account=${a.id}` }, 'View All', icon('arrow-right', { cls: 'icon-sm' }));
    let content;
    if (recentError) content = errorState(recentError, loadRecent, 'Recent transactions are unavailable');
    else if (!recent) content = skeletonRows(6, 5);
    else if (!recent.transactions.length) content = emptyState('No transactions yet', 'Deposits and transfers on this account will appear here.');
    else content = txTable(recent.transactions, { currency: a.currency, hidden: balancesHidden(), onOpen: (tx) => openTxDetail(tx, a.currency) });
    mount(recentEl, h('div', { class: 'card__head' }, h('h2', { id: 'recent-title' }, 'Recent Transactions'), viewAll), content);
  }

  const onVisibility = () => { renderStats(); renderRecent(); };
  document.addEventListener('vault24:balances-visibility', onVisibility);
  await loadAccounts();
  return () => document.removeEventListener('vault24:balances-visibility', onVisibility);
}

function stat(tint, ic, label, value, action, sub) {
  return h('div', { class: `stat stat--${tint}` },
    h('span', { class: 'stat__icon', 'aria-hidden': 'true' }, icon(ic)),
    h('span', { class: 'stat__label' }, label),
    action ? h('span', { class: 'stat__action' }, action) : null,
    h('span', { class: 'stat__value' }, value),
    sub ? h('span', { class: 'stat__sub' }, sub) : null);
}

function securityCard() {
  return h('section', { class: 'card promo-security', 'aria-labelledby': 'sec-title' },
    h('div', { class: 'promo-security__row' },
      h('span', { class: 'stat__icon', style: 'background:var(--icon-blue)', 'aria-hidden': 'true' }, icon('shield')),
      h('div', {},
        h('h2', { id: 'sec-title' }, 'Your Security Matters'),
        h('p', { class: 'muted' }, 'Use a strong, unique password and never share it. You can change it at any time.'))),
    h('a', { class: 'btn btn-primary btn-sm', href: '#/security' }, 'Manage Security'));
}

function quickActions() {
  const item = (href, ic, label) => h('li', {}, h('a', { class: 'quick-action', href }, icon(ic), h('span', {}, label), icon('chevron-right', { cls: 'icon-sm' })));
  return h('section', { class: 'card', 'aria-labelledby': 'qa-title' },
    h('h2', { id: 'qa-title', class: 'card-title' }, 'Quick Actions'),
    h('ul', { class: 'quick-actions', role: 'list' },
      item('#/transfer', 'transfer', 'Make a Transfer'),
      item('#/history', 'file', 'View Statements'),
      item('#/accounts', 'wallet', 'My Accounts'),
      item('#/profile', 'user', 'Update Profile')));
}

function promoCard() {
  return h('section', { class: 'card promo-card', 'aria-label': 'Vault24' },
    h('div', {},
      h('p', { class: 'promo-card__title' }, 'Bank Smarter, Safer, Anytime'),
      h('p', { class: 'muted' }, 'Your security, our priority.')),
    h('img', { src: '/assets/images/hero-illustration.jpg', alt: '', width: '160', height: '153', loading: 'lazy' }));
}

/* =========================== Account list =========================== */
export async function accounts({ root }) {
  const list = h('div', { class: 'account-grid' });
  mount(root, pageHead('My Accounts', 'All accounts held in your name.'), list);
  const render = ({ accounts: rows }) => {
    if (!rows.length) return h('div', { class: 'card' }, emptyState('No accounts yet', 'Vault24 staff open accounts at a branch once your identity is verified.'));
    const hidden = balancesHidden();
    return h('div', { class: 'account-grid' }, rows.map((a) => accountCard(a, hidden)));
  };
  await loadInto(list, () => api.get('/accounts'), render, { loading: h('div', { class: 'card' }, skeletonRows(3, 3)) });
}

function accountCard(a, hidden) {
  return h('article', { class: 'card account-card', 'aria-labelledby': `acct-${a.id}` },
    h('div', { class: 'account-card__top' },
      h('div', {},
        h('h2', { id: `acct-${a.id}` }, a.account_type_label),
        h('p', { class: 'muted' }, a.account_name)),
      badge(a.status)),
    h('div', { class: 'copy-row' },
      h('span', { class: 'mono account-card__number' }, groupAccountNumber(a.account_number)),
      copyButton(a.account_number, `Copy account number ${a.account_number}`)),
    h('div', {},
      h('p', { class: 'muted' }, 'Balance'),
      h('p', { class: 'account-card__balance' }, maskedMoney(money(a.balance_minor, a.currency), hidden))),
    h('p', { class: 'hint' }, `Daily transfer limit: ${money(a.daily_transfer_limit_minor, a.currency)}`),
    h('div', { class: 'form-actions' },
      h('a', { class: 'btn btn-secondary btn-sm', href: `#/accounts/${a.id}` }, 'View details'),
      a.status === 'active' ? h('a', { class: 'btn btn-primary btn-sm', href: `#/transfer?from=${a.account_number}` }, icon('transfer', { cls: 'icon-sm' }), 'Transfer') : null));
}

/* =========================== Account detail (customer, staff, admin) =========================== */
export async function accountDetail({ root, params, session }) {
  const id = params.id;
  const role = session.user.role;
  const backHref = role === 'customer' ? '#/accounts' : null;
  const info = h('div');
  const hist = h('section', { class: 'card card--flush', 'aria-labelledby': 'hist-title' });
  mount(root,
    backHref ? h('a', { class: 'back-link', href: backHref }, icon('arrow-left', { cls: 'icon-sm' }), 'All accounts') : h('button', { type: 'button', class: 'back-link back-link--button', onclick: () => history.back() }, icon('arrow-left', { cls: 'icon-sm' }), 'Back'),
    pageHead('Account details'), info, h('div', { style: 'height:20px' }), hist);

  let account;
  await loadInto(info, () => api.get(`/accounts/${encodeURIComponent(id)}`), (data) => {
    account = data.account;
    return h('section', { class: 'card' },
      h('div', { class: 'account-card__top' },
        h('div', {}, h('h2', {}, account.account_type_label), h('p', { class: 'muted' }, account.account_name)),
        badge(account.status)),
      h('dl', { class: 'dl dl--2', style: 'margin-top:16px' },
        dd('Account number', h('span', { class: 'copy-row' }, h('span', { class: 'mono' }, groupAccountNumber(account.account_number)), copyButton(account.account_number, 'Copy account number'))),
        dd('Balance', h('span', { class: 'amount' }, money(account.balance_minor, account.currency))),
        dd('Currency', account.currency),
        dd('Daily transfer limit', money(account.daily_transfer_limit_minor, account.currency)),
        dd('Opened', formatDate(account.created_at)),
        dd('Status', badge(account.status))),
      role === 'customer' && account.status === 'active'
        ? h('div', { class: 'form-actions', style: 'margin-top:16px' }, h('a', { class: 'btn btn-primary', href: `#/transfer?from=${account.account_number}` }, icon('transfer'), 'Transfer from this account'))
        : null);
  }, { errorTitle: 'Account not available' });
  if (!account) { hist.hidden = true; return; }
  await historyPanel(hist, account, { title: 'Transactions' });
}

/** Paged ledger panel used by account detail (keyset pagination via before_id). */
export async function historyPanel(container, account, { title }) {
  const rows = [];
  let nextBefore = null;
  let total = 0;
  const tableEl = h('div');
  const moreBtn = h('button', { type: 'button', class: 'btn btn-secondary', hidden: true, onclick: () => load(true) }, 'Load older transactions');
  const countEl = h('span', { class: 'muted' });
  mount(container, h('div', { class: 'card__head' }, h('h2', { id: 'hist-title' }, title), countEl), tableEl, h('div', { class: 'load-more' }, moreBtn));

  async function load(more = false) {
    if (!more) mount(tableEl, skeletonRows(6, 5));
    moreBtn.disabled = true;
    try {
      const data = await api.get(`/accounts/${account.id}/transactions`, { query: { limit: 20, before_id: more ? nextBefore : undefined } });
      rows.push(...data.transactions);
      nextBefore = data.next_before_id;
      total = data.total_count;
      countEl.textContent = `${rows.length} of ${total}`;
      mount(tableEl, rows.length
        ? txTable(rows, { currency: account.currency, onOpen: (tx) => openTxDetail(tx, account.currency) })
        : emptyState('No transactions yet', 'Deposits and transfers will appear here.'));
      moreBtn.hidden = !nextBefore;
    } catch (err) {
      if (err.status === 401) return;
      mount(tableEl, errorState(err, () => load(more)));
    } finally {
      moreBtn.disabled = false;
    }
  }
  await load();
}

