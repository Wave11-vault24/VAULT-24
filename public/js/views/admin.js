// Administrator screens: only operations the backend actually exposes.
// There is deliberately no UI to edit balances, roles or audit records.
import { api, ApiError, download } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { money, groupAccountNumber, formatDateTime, fileSize, titleCase } from '../format.js';
import {
  pageHead, field, errorSummary, showErrors, clearErrors, withBusy, loadInto, badge, alertBox, toast,
  emptyState, skeletonRows, copyButton, confirmDialog, openDialog, errorState,
} from '../ui.js';
import { dd } from './shared.js';

/* =========================== Dashboard =========================== */
export async function dashboard({ root, session }) {
  const statsEl = h('div', { class: 'stat-grid' });
  const recon = h('section', { class: 'card', 'aria-labelledby': 'rec-title' });
  const audit = h('section', { class: 'card card--flush', 'aria-labelledby': 'au-title' });
  mount(root,
    pageHead(`Administration`, `Signed in as ${session.user.full_name}.`),
    statsEl, h('div', { style: 'height:20px' }),
    h('div', { class: 'dash-grid' }, audit, h('div', { class: 'stack' }, recon, quickLinks())));

  const tile = (tint, ic, label, value, href) => h('a', { class: `stat stat--${tint} stat--link`, href },
    h('span', { class: 'stat__icon', 'aria-hidden': 'true' }, icon(ic)),
    h('span', { class: 'stat__label' }, label),
    h('span', { class: 'stat__value' }, value));

  loadInto(statsEl, () => Promise.all([api.get('/admin/users'), api.get('/admin/documents', { query: { status: 'pending' } })]), ([u, d]) => {
    const users = u.users;
    const count = (pred) => String(users.filter(pred).length);
    return [
      tile('blue', 'users', 'Customers', count((x) => x.role === 'customer'), '#/admin/users?role=customer'),
      tile('green', 'user', 'Staff', count((x) => x.role === 'staff'), '#/admin/users?role=staff'),
      tile('purple', 'file-check', 'ID documents to review', String(d.documents.length), '#/admin/documents?status=pending'),
      tile('sky', 'lock', 'Locked or suspended users', count((x) => x.status !== 'active'), '#/admin/users'),
    ];
  }, { loading: skeletonRows(1, 4) });

  const loadRecon = () => loadInto(recon, () => api.get('/admin/reconciliation'), ({ healthy, mismatches }) => [
    h('div', { class: 'card__head' }, h('h2', { id: 'rec-title' }, 'Ledger reconciliation'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: loadRecon }, icon('refresh', { cls: 'icon-sm' }), 'Re-check')),
    healthy
      ? alertBox('success', 'Balanced', 'Every account balance equals the sum of its ledger entries.')
      : alertBox('error', `${mismatches.length} account(s) do not reconcile`, null,
        h('ul', {}, mismatches.map((m) => h('li', {}, `${m.account_number}: balance ${money(m.balance_minor)} vs ledger ${money(m.ledger_sum)}`)))),
  ]);
  loadRecon();

  loadInto(audit, () => api.get('/admin/audit-logs', { query: { limit: 8 } }), ({ audit_logs: rows }) => [
    h('div', { class: 'card__head' }, h('h2', { id: 'au-title' }, 'Recent security events'), h('a', { class: 'card__link', href: '#/admin/audit' }, 'Full audit log', icon('arrow-right', { cls: 'icon-sm' }))),
    rows.length ? auditTable(rows, { compact: true }) : emptyState('No events yet'),
  ], { loading: skeletonRows(6, 4) });
}

function quickLinks() {
  const item = (href, ic, label) => h('li', {}, h('a', { class: 'quick-action', href }, icon(ic), h('span', {}, label), icon('chevron-right', { cls: 'icon-sm' })));
  return h('section', { class: 'card', 'aria-labelledby': 'aq-title' },
    h('h2', { id: 'aq-title', class: 'card-title' }, 'Quick Actions'),
    h('ul', { class: 'quick-actions', role: 'list' },
      item('#/admin/documents?status=pending', 'file-check', 'Review ID documents'),
      item('#/admin/users?create=staff', 'user-plus', 'Create staff member'),
      item('#/admin/users', 'users', 'Manage user status'),
      item('#/admin/audit', 'list', 'Search audit log')));
}

/* =========================== Users =========================== */
export async function users({ root, query, session }) {
  const role = query.get('role') || '';
  const status = query.get('status') || '';
  const roleSel = h('select', { class: 'select', id: 'u-role' }, ['', 'customer', 'staff', 'admin'].map((r) => h('option', { value: r, selected: r === role || null }, r ? titleCase(r) : 'All roles')));
  const statusSel = h('select', { class: 'select', id: 'u-status' }, ['', 'active', 'locked', 'suspended'].map((s) => h('option', { value: s, selected: s === status || null }, s ? titleCase(s) : 'All statuses')));
  const apply = () => {
    const qs = new URLSearchParams();
    if (roleSel.value) qs.set('role', roleSel.value);
    if (statusSel.value) qs.set('status', statusSel.value);
    window.location.hash = `#/admin/users${qs.toString() ? `?${qs}` : ''}`;
  };
  roleSel.addEventListener('change', apply);
  statusSel.addEventListener('change', apply);

  const list = h('div');
  const createBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => createStaffDialog(load) }, icon('user-plus'), 'Create staff member');
  mount(root,
    pageHead('Users & Staff', 'Manage access for customers and staff.', createBtn),
    h('div', { class: 'card filters' }, h('div', { class: 'filters__grid filters__grid--2' },
      h('div', { class: 'field' }, h('label', { for: 'u-role' }, 'Role'), roleSel),
      h('div', { class: 'field' }, h('label', { for: 'u-status' }, 'Status'), statusSel))),
    h('div', { style: 'height:16px' }),
    h('section', { class: 'card card--flush', 'aria-label': 'Users' }, list));

  async function load() {
    await loadInto(list, () => api.get('/admin/users', { query: { role: role || undefined, status: status || undefined } }), ({ users: rows }) => rows.length
      ? userTable(rows, session.user.id, load)
      : emptyState('No users match', 'Try a different filter.'), { loading: skeletonRows(6, 5) });
  }
  await load();
  if (query.get('create') === 'staff') createStaffDialog(load);
}

function userTable(rows, selfId, reload) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table table--stack' },
    h('caption', { class: 'visually-hidden' }, 'Users'),
    h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', 'Identity', 'Failed logins', 'Actions'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows.map((u) => h('tr', {},
      h('td', { 'data-label': 'Name', class: 'cell-primary' }, u.full_name),
      h('td', { 'data-label': 'Email' }, u.email),
      h('td', { 'data-label': 'Role' }, titleCase(u.role)),
      h('td', { 'data-label': 'Status' }, badge(u.status)),
      h('td', { 'data-label': 'Identity' }, badge(u.verification_status)),
      h('td', { 'data-label': 'Failed logins' }, String(u.failed_login_attempts)),
      h('td', { class: 'cell-actions' },
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:8px' },
          u.role === 'customer' ? h('a', { class: 'btn btn-secondary btn-sm', href: `#/admin/users/${u.id}` }, 'Accounts') : null,
          u.id === selfId
            ? h('span', { class: 'hint' }, 'You')
            : h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => statusDialog(u, reload) }, 'Change status'))))))));
}

async function statusDialog(u, reload) {
  const select = h('select', { class: 'select', name: 'status' }, ['active', 'locked', 'suspended'].map((s) => h('option', { value: s, selected: s === u.status || null }, titleCase(s))));
  const fStatus = field({ label: 'New status', name: 'status', required: true, control: select });
  const fReason = field({ label: 'Reason (recorded in the audit log)', name: 'reason', placeholder: 'e.g. Customer called to report a lost phone', maxlength: 200 });
  const summary = errorSummary();
  await openDialog({
    title: `Change status — ${u.full_name}`,
    description: 'Locking or suspending signs the user out immediately. Setting Active also clears failed login attempts.',
    body: h('div', { class: 'form' }, summary, fStatus.wrap, fReason.wrap),
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Save status', kind: 'primary',
        onClick: async (btn) => {
          clearErrors(summary, [fStatus, fReason]);
          const reason = fReason.input.value.trim();
          if (reason && reason.length < 3) { showErrors(summary, [fStatus, fReason], { fields: { reason: 'Use at least 3 characters, or leave it empty.' } }); return true; }
          let keepOpen = false;
          await withBusy(btn, async () => {
            try {
              await api.patch(`/admin/users/${u.id}/status`, { status: select.value, reason: reason || undefined });
              toast(`${u.full_name} is now ${select.value}`, 'success');
            } catch (err) {
              keepOpen = true;
              if (err instanceof ApiError && err.status !== 401) showErrors(summary, [fStatus, fReason], err);
            }
          }, 'Saving…');
          if (!keepOpen) reload();
          return keepOpen;
        },
      },
    ],
  });
}

async function createStaffDialog(reload) {
  const summary = errorSummary();
  const fName = field({ label: 'Full name', name: 'full_name', required: true, autocomplete: 'off' });
  const fEmail = field({ label: 'Work email', name: 'email', type: 'email', required: true, autocomplete: 'off' });
  const fPhone = field({ label: 'Phone (optional)', name: 'phone_number', type: 'tel', autocomplete: 'off' });
  const fields = [fName, fEmail, fPhone];
  let created = null;
  await openDialog({
    title: 'Create staff member',
    description: 'The new staff member receives a one-time temporary password and must change it at first login.',
    body: h('div', { class: 'form' }, summary, fName.wrap, fEmail.wrap, fPhone.wrap),
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Create staff', kind: 'primary',
        onClick: async (btn) => {
          clearErrors(summary, fields);
          const body = { full_name: fName.input.value.trim(), email: fEmail.input.value.trim() };
          if (fPhone.input.value.trim()) body.phone_number = fPhone.input.value.trim();
          const errors = {};
          if (body.full_name.length < 2) errors.full_name = 'Enter a full name.';
          if (!body.email || !fEmail.input.checkValidity()) errors.email = 'Enter a valid email address.';
          if (Object.keys(errors).length) { showErrors(summary, fields, { fields: errors }); return true; }
          let keepOpen = false;
          await withBusy(btn, async () => {
            try {
              created = await api.post('/admin/staff', body);
            } catch (err) {
              keepOpen = true;
              if (err instanceof ApiError && err.status !== 401) {
                if (err.status === 409) showErrors(summary, fields, { fields: { email: err.message } });
                else showErrors(summary, fields, err);
              }
            }
          }, 'Creating…');
          return keepOpen;
        },
      },
    ],
  });
  if (!created) return;
  await openDialog({
    title: 'Staff member created',
    body: h('div', { class: 'stack' },
      h('dl', { class: 'dl' }, dd('Name', created.staff.full_name), dd('Email', created.staff.email), dd('Role', titleCase(created.staff.role))),
      h('div', { class: 'secret' }, h('span', {}, created.temporary_password), copyButton(created.temporary_password, 'Copy temporary password')),
      alertBox('warning', 'Shown only once', 'Hand this to the staff member securely. It cannot be displayed again.')),
    actions: [{ label: 'Done', kind: 'primary' }],
  });
  reload();
}

/* =========================== Customer accounts (admin) =========================== */
export async function userDetail({ root, params }) {
  const area = h('div');
  mount(root, h('a', { class: 'back-link', href: '#/admin/users?role=customer' }, icon('arrow-left', { cls: 'icon-sm' }), 'All customers'), pageHead('Customer accounts', 'Freeze, unfreeze or close accounts. Closing requires a zero balance.'), area);
  const load = () => loadInto(area, () => api.get('/accounts', { query: { customer_id: params.id } }), ({ accounts }) => {
    if (!accounts.length) return h('div', { class: 'card' }, emptyState('No accounts', 'This customer has no accounts.'));
    return h('div', { class: 'account-grid' }, accounts.map((a) => h('article', { class: 'card account-card' },
      h('div', { class: 'account-card__top' }, h('div', {}, h('h2', {}, a.account_type_label), h('p', { class: 'muted' }, a.account_name)), badge(a.status)),
      h('p', { class: 'mono account-card__number' }, groupAccountNumber(a.account_number)),
      h('p', { class: 'account-card__balance amount' }, money(a.balance_minor, a.currency)),
      h('div', { class: 'form-actions' },
        h('a', { class: 'btn btn-secondary btn-sm', href: `#/accounts/${a.id}` }, 'History'),
        a.status !== 'closed' ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => accountStatusDialog(a, load) }, 'Change status') : null))));
  }, { errorTitle: 'Accounts not available' });
  await load();
}

async function accountStatusDialog(a, reload) {
  const options = ['active', 'frozen', 'closed'].filter((s) => s !== a.status);
  const select = h('select', { class: 'select' }, options.map((s) => h('option', { value: s }, titleCase(s))));
  const fStatus = field({ label: 'New status', name: 'status', required: true, control: select });
  const fReason = field({ label: 'Reason (required, audited)', name: 'reason', required: true, maxlength: 200 });
  const summary = errorSummary();
  await openDialog({
    title: `Account ${groupAccountNumber(a.account_number)}`,
    description: 'Frozen accounts cannot send or receive money. Closing is permanent and needs a zero balance.',
    body: h('div', { class: 'form' }, summary, fStatus.wrap, fReason.wrap),
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Save', kind: 'primary',
        onClick: async (btn) => {
          clearErrors(summary, [fStatus, fReason]);
          const reason = fReason.input.value.trim();
          if (reason.length < 3) { showErrors(summary, [fStatus, fReason], { fields: { reason: 'Give a reason of at least 3 characters.' } }); return true; }
          if (select.value === 'closed') {
            const sure = await confirmDialog({ title: 'Close this account permanently?', description: 'A closed account cannot be reopened.', confirmLabel: 'Close account', kind: 'danger' });
            if (!sure) return true;
          }
          let keepOpen = false;
          await withBusy(btn, async () => {
            try {
              await api.patch(`/admin/accounts/${a.id}/status`, { status: select.value, reason });
              toast(`Account is now ${select.value}`, 'success');
            } catch (err) {
              keepOpen = true;
              if (err instanceof ApiError && err.status !== 401) showErrors(summary, [fStatus, fReason], err);
            }
          }, 'Saving…');
          if (!keepOpen) reload();
          return keepOpen;
        },
      },
    ],
  });
}

/* =========================== ID document review =========================== */
export async function documents({ root, query }) {
  const status = query.has('status') ? query.get('status') : 'pending';
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter documents' }, [['pending', 'Pending'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['', 'All']].map(([value, label]) =>
    h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(value === status), onclick: () => { window.location.hash = `#/admin/documents?status=${value}`; } }, label)));
  const list = h('div');
  mount(root, pageHead('ID Documents', 'Review identity documents uploaded by staff.'), tabs, list);
  const load = () => loadInto(list, () => api.get('/admin/documents', { query: { status: status || undefined } }), ({ documents: rows }) => rows.length
    ? h('div', { class: 'stack' }, rows.map((d) => documentCard(d, load)))
    : h('div', { class: 'card' }, emptyState(status === 'pending' ? 'Nothing to review' : 'No documents', status === 'pending' ? 'All identity documents have been reviewed.' : null)),
  { loading: h('div', { class: 'card' }, skeletonRows(4, 3)) });
  await load();
}

function documentCard(d, reload) {
  const dl = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('download', { cls: 'icon-sm' }), 'Download PDF');
  dl.addEventListener('click', () => withBusy(dl, async () => {
    try { await download(`/documents/${d.id}/download`, d.original_filename); } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
  }, 'Downloading…'));
  const approve = h('button', { type: 'button', class: 'btn btn-success btn-sm' }, icon('check', { cls: 'icon-sm' }), 'Approve');
  const reject = h('button', { type: 'button', class: 'btn btn-danger btn-sm' }, icon('close', { cls: 'icon-sm' }), 'Reject');
  approve.addEventListener('click', () => review(d, 'verified', reload, approve));
  reject.addEventListener('click', () => review(d, 'rejected', reload, reject));
  return h('article', { class: 'card doc-card', 'aria-label': `Document ${d.original_filename} for ${d.customer_name}` },
    h('div', { class: 'account-card__top' },
      h('div', {}, h('h2', {}, d.customer_name), h('p', { class: 'muted' }, `Customer ID ${d.user_id}`)),
      badge(d.verification_status)),
    h('dl', { class: 'dl dl--2' },
      dd('File', `${d.original_filename} (${fileSize(d.file_size)})`),
      dd('Uploaded', `${formatDateTime(d.created_at)} by staff ID ${d.uploaded_by}`),
      d.reviewed_at ? dd('Reviewed', `${formatDateTime(d.reviewed_at)} by admin ID ${d.reviewed_by}`) : null,
      d.rejection_reason ? dd('Rejection reason', d.rejection_reason) : null),
    h('div', { class: 'form-actions' }, dl, d.verification_status === 'pending' ? [approve, reject] : null));
}

async function review(d, decision, reload, btn) {
  if (decision === 'verified') {
    const ok = await confirmDialog({
      title: 'Approve this identity document?',
      description: `${d.customer_name} will be marked as verified and staff will be able to open accounts for them. Make sure you have opened and checked the PDF.`,
      confirmLabel: 'Approve', kind: 'success',
    });
    if (!ok) return;
    await withBusy(btn, () => submitReview(d, { decision }, reload), 'Approving…');
    return;
  }
  const summary = errorSummary();
  const fReason = field({ label: 'Reason for rejection', name: 'rejection_reason', required: true, maxlength: 200, hint: 'Shown to staff. Do not include sensitive personal data.' });
  await openDialog({
    title: 'Reject this identity document?',
    description: `${d.customer_name} will be marked as rejected until a new document is approved.`,
    body: h('div', { class: 'form' }, summary, fReason.wrap),
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Reject document', kind: 'danger',
        onClick: async (b) => {
          clearErrors(summary, [fReason]);
          const reason = fReason.input.value.trim();
          if (reason.length < 3) { showErrors(summary, [fReason], { fields: { rejection_reason: 'Give a reason of at least 3 characters.' } }); return true; }
          let ok = false;
          await withBusy(b, async () => { ok = await submitReview(d, { decision, rejection_reason: reason }, reload, summary, [fReason]); }, 'Rejecting…');
          return !ok;
        },
      },
    ],
  });
}

async function submitReview(d, body, reload, summary, fields) {
  try {
    const { document: doc } = await api.patch(`/admin/documents/${d.id}/review`, body);
    toast(`Document ${doc.verification_status}`, 'success');
    reload();
    return true;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status === 401) return false;
    if (summary) showErrors(summary, fields, err);
    else toast(err.message, 'error');
    if (err.status === 409) reload();
    return false;
  }
}

/* =========================== Audit log =========================== */
function auditTable(rows, { compact = false } = {}) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table table--stack' },
    h('caption', { class: 'visually-hidden' }, 'Audit events'),
    h('thead', {}, h('tr', {}, ['Time', 'Event', 'Actor', 'Target', 'Outcome', compact ? null : 'Details'].filter(Boolean).map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { 'data-label': 'Time', class: 'nowrap' }, formatDateTime(r.created_at)),
      h('td', { 'data-label': 'Event', class: 'cell-primary mono' }, r.action),
      h('td', { 'data-label': 'Actor', class: 'nowrap' }, r.actor_user_id == null ? 'system / anonymous' : `User ${r.actor_user_id}`),
      h('td', { 'data-label': 'Target' }, `${r.target_type}${r.target_id ? ` ${r.target_id}` : ''}`),
      h('td', { 'data-label': 'Outcome' }, badge(r.outcome)),
      compact ? null : h('td', { 'data-label': 'Details', class: 'audit-meta' }, Object.keys(r.metadata || {}).length ? JSON.stringify(r.metadata) : '—'))))));
}

export async function audit({ root, query }) {
  const action = query.get('action') || '';
  const actor = query.get('actor') || '';
  const fAction = h('input', { class: 'input', id: 'a-action', value: action, placeholder: 'e.g. transfer.create', autocomplete: 'off', pattern: '[a-z_.]{1,64}' });
  const fActor = h('input', { class: 'input', id: 'a-actor', value: actor, placeholder: 'User ID', inputmode: 'numeric', autocomplete: 'off' });
  const form = h('form', { class: 'card filters', role: 'search' },
    h('div', { class: 'filters__grid' },
      h('div', { class: 'field' }, h('label', { for: 'a-action' }, 'Event'), fAction),
      h('div', { class: 'field' }, h('label', { for: 'a-actor' }, 'Actor user ID'), fActor),
      h('div', { class: 'field filters__actions' }, h('span', { class: 'label', 'aria-hidden': 'true' }, ' '), h('button', { type: 'submit', class: 'btn btn-primary' }, 'Apply filters'))),
    h('p', { class: 'hint' }, 'Common events: auth.login, transfer.create, deposit.create, customer.register, document.review, authz.denied, user.status_change.'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const qs = new URLSearchParams();
    const a = fAction.value.trim();
    const u = fActor.value.trim();
    if (a && !/^[a-z_.]{1,64}$/.test(a)) { toast('Event names use lower-case letters, dots and underscores.', 'error'); return; }
    if (u && !/^[1-9]\d*$/.test(u)) { toast('Actor must be a numeric user ID.', 'error'); return; }
    if (a) qs.set('action', a);
    if (u) qs.set('actor', u);
    window.location.hash = `#/admin/audit${qs.toString() ? `?${qs}` : ''}`;
  });

  const rows = [];
  let nextBefore = null;
  const tableEl = h('div');
  const countEl = h('span', { class: 'muted', 'aria-live': 'polite' });
  const moreBtn = h('button', { type: 'button', class: 'btn btn-secondary', hidden: true, onclick: () => load(true) }, 'Load older events');
  mount(root, pageHead('Audit Log', 'Read-only record of security-relevant events.'), form, h('div', { style: 'height:16px' }),
    h('section', { class: 'card card--flush', 'aria-label': 'Audit events' }, h('div', { class: 'card__head' }, h('h2', {}, 'Events'), countEl), tableEl, h('div', { class: 'load-more' }, moreBtn)));

  async function load(more = false) {
    if (!more) mount(tableEl, skeletonRows(8, 5));
    moreBtn.disabled = true;
    try {
      const data = await api.get('/admin/audit-logs', { query: { action: action || undefined, actor_user_id: actor || undefined, limit: 50, before_id: more ? nextBefore : undefined } });
      rows.push(...data.audit_logs);
      nextBefore = data.next_before_id;
      countEl.textContent = `${rows.length} event${rows.length === 1 ? '' : 's'} loaded`;
      mount(tableEl, rows.length ? auditTable(rows) : emptyState('No events match', 'Try a different filter.'));
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

