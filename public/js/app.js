// App shell: confirms the session with GET /api/auth/me, builds role-aware
// navigation, and routes between views (hash routing, no build step).
// Role checks here only decide what to SHOW; the server authorises every call.
import { api, ApiError } from './api.js';
import { h, icon, mount, $ } from './dom.js';
import { initials, titleCase } from './format.js';
import { errorState, toast, withBusy, pageHead } from './ui.js';

import * as customer from './views/customer.js';
import * as transfer from './views/transfer.js';
import * as history from './views/history.js';
import * as profile from './views/profile.js';
import * as staff from './views/staff.js';
import * as admin from './views/admin.js';

const root = $('#root');
const session = { user: null, mustChangePassword: false };

const NAV = {
  customer: [
    ['#/dashboard', 'home', 'Dashboard'],
    ['#/accounts', 'wallet', 'My Accounts'],
    ['#/transfer', 'transfer', 'Transfer Funds'],
    ['#/history', 'clock', 'Transaction History'],
    ['#/profile', 'user', 'Profile'],
    ['#/security', 'shield', 'Security'],
  ],
  staff: [
    ['#/dashboard', 'home', 'Dashboard'],
    ['#/staff/register', 'user-plus', 'Register Customer'],
    ['#/staff/customers', 'users', 'Customers'],
    ['#/staff/deposit', 'cash', 'Cash Deposit'],
    ['#/profile', 'user', 'Profile'],
    ['#/security', 'shield', 'Security'],
  ],
  admin: [
    ['#/dashboard', 'home', 'Dashboard'],
    ['#/admin/users', 'users', 'Users & Staff'],
    ['#/admin/documents', 'file-check', 'ID Documents'],
    ['#/admin/audit', 'list', 'Audit Log'],
    ['#/profile', 'user', 'Profile'],
    ['#/security', 'shield', 'Security'],
  ],
};

// [pattern, roles, view]. ':param' segments are captured.
const ROUTES = [
  ['/dashboard', ['customer'], customer.dashboard],
  ['/dashboard', ['staff'], staff.dashboard],
  ['/dashboard', ['admin'], admin.dashboard],
  ['/accounts', ['customer'], customer.accounts],
  ['/accounts/:id', ['customer', 'staff', 'admin'], customer.accountDetail],
  ['/transfer', ['customer'], transfer.view],
  ['/history', ['customer'], history.view],
  ['/profile', ['customer', 'staff', 'admin'], profile.profileView],
  ['/security', ['customer', 'staff', 'admin'], profile.securityView],
  ['/staff/register', ['staff'], staff.register],
  ['/staff/customers', ['staff'], staff.customers],
  ['/staff/customers/:id', ['staff'], staff.customerDetail],
  ['/staff/deposit', ['staff'], staff.deposit],
  ['/admin/users', ['admin'], admin.users],
  ['/admin/users/:id', ['admin'], admin.userDetail],
  ['/admin/documents', ['admin'], admin.documents],
  ['/admin/audit', ['admin'], admin.audit],
];

/* ---------------- Session ---------------- */

function goToLogin(reason) {
  const next = encodeURIComponent(window.location.hash || '');
  const flag = reason === 'expired' ? 'expired=1&' : '';
  window.location.replace(`/login.html?${flag}next=${next}`);
}

window.addEventListener('vault24:session-expired', () => {
  session.user = null;
  goToLogin('expired');
});

async function refreshMe(opts) {
  const me = await api.get('/auth/me', opts);
  session.user = me.user;
  session.mustChangePassword = me.must_change_password;
  return me;
}

async function logout(button) {
  await withBusy(button, async () => {
    try {
      await api.post('/auth/logout');
      session.user = null;
      window.location.replace('/login.html?signedout=1');
    } catch (err) {
      // Never pretend logout worked: the server session may still be alive.
      toast(err.status === 401 ? 'You were already signed out.' : `Sign out failed: ${err.message}`, 'error');
      if (err.status === 401) window.location.replace('/login.html?signedout=1');
    }
  }, 'Signing out…');
}

/* ---------------- Shell ---------------- */

let els = {};

function buildShell() {
  const { user } = session;
  const nav = h('nav', { class: 'sidebar__nav', 'aria-label': 'Main' },
    NAV[user.role].map(([href, ic, label]) => h('a', { class: 'nav-link', href, dataset: { route: href.slice(1) } }, icon(ic), label)));

  const logoutBtn = h('button', { type: 'button', class: 'nav-link', onclick: (e) => logout(e.currentTarget) }, icon('logout'), 'Logout');

  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Navigation' },
    h('div', { class: 'sidebar__head' },
      h('a', { class: 'brand brand--inverse', href: '#/dashboard', 'aria-label': 'Vault24 dashboard' },
        h('img', { class: 'brand__mark', src: '/assets/images/logo-mark-white.png', alt: '', width: '40', height: '36' }),
        h('span', { class: 'brand__text' }, h('span', { class: 'brand__name' }, 'VAULT', h('span', {}, '24')), h('span', { class: 'brand__tag' }, 'Secure Banking, Anytime'))),
      h('button', { type: 'button', class: 'icon-btn sidebar__close', 'aria-label': 'Close menu', onclick: closeNav }, icon('close'))),
    nav,
    h('div', { class: 'sidebar__foot' }, logoutBtn));

  const scrim = h('div', { class: 'scrim', hidden: true, onclick: closeNav });

  const menuBtn = h('button', { type: 'button', class: 'icon-btn menu-button', 'aria-label': 'Open menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false', onclick: openNav }, icon('menu'));

  // Header search: customers only. There is no server search endpoint, so it
  // opens Transaction History filtered over the rows loaded there.
  const search = user.role === 'customer'
    ? h('form', { class: 'app-header__search', role: 'search', onsubmit: (e) => {
      e.preventDefault();
      const q = e.currentTarget.elements.q.value.trim();
      window.location.hash = q ? `#/history?q=${encodeURIComponent(q)}` : '#/history';
    } },
    h('label', { class: 'visually-hidden', for: 'header-search' }, 'Search your transactions'),
    h('div', { class: 'input-icon' }, icon('search'),
      h('input', { class: 'input', id: 'header-search', name: 'q', type: 'search', placeholder: 'Search transactions…', autocomplete: 'off' })))
    : h('div', { class: 'app-header__spacer' });

  const menuList = h('div', { class: 'user-menu__list', id: 'user-menu-list', hidden: true },
    h('a', { href: '#/profile' }, icon('user'), 'Profile'),
    h('a', { href: '#/security' }, icon('shield'), 'Security'),
    h('button', { type: 'button', onclick: (e) => logout(e.currentTarget) }, icon('logout'), 'Logout'));
  const menuButton = h('button', { type: 'button', class: 'user-menu__button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'user-menu-list', onclick: toggleUserMenu },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(user.full_name)),
    h('span', { class: 'user-menu__text' },
      h('span', { class: 'user-menu__name' }, `Hello, ${user.full_name}`),
      h('span', { class: 'user-menu__role' }, titleCase(user.role))),
    h('span', { class: 'visually-hidden' }, `Account menu for ${user.full_name}`),
    icon('chevron-down', { cls: 'icon-sm' }));
  const userMenu = h('div', { class: 'user-menu' }, menuButton, menuList);

  const header = h('header', { class: 'app-header' }, menuBtn, search, user.role === 'customer' ? h('div', { class: 'app-header__spacer' }) : null, userMenu);
  const content = h('main', { class: 'content', id: 'content', tabindex: '-1' });

  mount(root, h('div', { class: 'app' }, sidebar, scrim, h('div', { class: 'main' }, header, content)));
  els = { sidebar, scrim, menuBtn, content, menuButton, menuList, nav };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeNav(); closeUserMenu(); }
  });
  document.addEventListener('click', (e) => {
    if (!userMenu.contains(e.target)) closeUserMenu();
  });
}

function openNav() {
  els.sidebar.classList.add('is-open');
  els.scrim.hidden = false;
  els.menuBtn.setAttribute('aria-expanded', 'true');
  const first = els.sidebar.querySelector('.nav-link');
  if (first) first.focus();
}
function closeNav() {
  if (!els.sidebar || !els.sidebar.classList.contains('is-open')) return;
  els.sidebar.classList.remove('is-open');
  els.scrim.hidden = true;
  els.menuBtn.setAttribute('aria-expanded', 'false');
  els.menuBtn.focus();
}
function toggleUserMenu() {
  const open = els.menuList.hidden;
  els.menuList.hidden = !open;
  els.menuButton.setAttribute('aria-expanded', String(open));
  if (open) els.menuList.querySelector('a, button').focus();
}
function closeUserMenu() {
  if (!els.menuList || els.menuList.hidden) return;
  els.menuList.hidden = true;
  els.menuButton.setAttribute('aria-expanded', 'false');
}

/* ---------------- Router ---------------- */

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/dashboard';
  const [path, qs = ''] = raw.split('?');
  return { path: path.replace(/\/+$/, '') || '/dashboard', query: new URLSearchParams(qs) };
}

function match(path) {
  let roleMismatch = false;
  for (const [pattern, roles, view] of ROUTES) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    const m = re.exec(path);
    if (!m) continue;
    if (!roles.includes(session.user.role)) { roleMismatch = true; continue; }
    const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return { view, params };
  }
  return { view: roleMismatch ? forbiddenView : notFoundView, params: {} };
}

let cleanup = null;
let routeSeq = 0;

async function route() {
  if (!session.user) return;
  closeNav();
  closeUserMenu();
  const { path, query } = parseHash();

  // Users with a temporary password may only use the Security page (server enforces this too).
  if (session.mustChangePassword && path !== '/security') {
    window.location.replace('#/security?required=1');
    return;
  }

  const { view, params } = match(path);
  for (const link of els.nav.querySelectorAll('.nav-link')) {
    const r = link.dataset.route;
    const active = path === r || (r !== '/dashboard' && path.startsWith(`${r}/`));
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }

  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  const seq = ++routeSeq;
  mount(els.content);
  try {
    cleanup = await view({ root: els.content, params, query, session, refreshMe, isCurrent: () => seq === routeSeq });
  } catch (err) {
    if (err && err.status === 401) return;
    mount(els.content, errorState(err, route, 'This page could not be shown'));
  }
  if (seq !== routeSeq) return;
  const title = els.content.querySelector('[data-page-title]');
  document.title = `${title ? title.textContent : 'Vault24'} — Vault24`;
  if (title) title.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function notFoundView({ root: r }) {
  mount(r, pageHead('Page not found'), h('div', { class: 'card state' },
    h('div', { class: 'state__icon' }, icon('info', { cls: 'icon-lg' })),
    h('p', {}, 'That page does not exist.'),
    h('a', { class: 'btn btn-primary', href: '#/dashboard' }, 'Back to dashboard')));
}

function forbiddenView({ root: r }) {
  mount(r, pageHead('Access denied'), h('div', { class: 'card state state--error' },
    h('div', { class: 'state__icon' }, icon('lock', { cls: 'icon-lg' })),
    h('p', {}, 'Your role does not have access to this page.'),
    h('a', { class: 'btn btn-primary', href: '#/dashboard' }, 'Back to dashboard')));
}

/* ---------------- Boot ---------------- */

async function boot() {
  try {
    // No session yet means "please log in", not "session expired".
    const { authenticated } = await api.get('/auth/session', { expectAuth: false });
    if (!authenticated) { goToLogin(); return; }
    await refreshMe({ expectAuth: false });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { goToLogin(); return; }
    if (err instanceof ApiError && err.code === 'ACCOUNT_INACTIVE') {
      window.location.replace('/login.html');
      return;
    }
    mount(root, h('main', { class: 'boot' }, errorState(err, boot, 'Vault24 is unavailable')));
    return;
  }
  buildShell();
  window.addEventListener('hashchange', route);
  route();
}

boot();
