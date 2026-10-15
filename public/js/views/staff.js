// Staff screens. Every action calls the real staff-only endpoint; the role
// check in the router only hides navigation. The server enforces everything.
import { api, ApiError, upload, download } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { money, groupAccountNumber, formatDate, formatDateTime, parseMajorToMinor, fileSize, normalizeName, titleCase } from '../format.js';
import { MAX_DOCUMENT_BYTES, CURRENCY } from '../config.js';
import {
  pageHead, field, errorSummary, showErrors, clearErrors, withBusy, loadInto, badge, alertBox, toast,
  emptyState, skeletonRows, copyButton, confirmDialog, openDialog,
} from '../ui.js';
import { dd } from './shared.js';

const firstName = (name) => String(name || '').split(/\s+/)[0];

/* =========================== Dashboard =========================== */
export async function dashboard({ root, session }) {
  const recent = h('section', { class: 'card card--flush', 'aria-labelledby': 'rc-title' });
  const action = (href, ic, title, text) => h('a', { class: 'action-tile', href },
    h('span', { class: 'stat__icon', 'aria-hidden': 'true' }, icon(ic)), h('span', { class: 'action-tile__title' }, title), h('span', { class: 'muted' }, text));
  mount(root,
    pageHead(`Good to see you, ${firstName(session.user.full_name)}`, 'Branch operations for Vault24 staff.'),
    h('div', { class: 'action-grid' },
      action('#/staff/register', 'user-plus', 'Register customer', 'Create a customer with their ID document'),
      action('#/staff/deposit', 'cash', 'Cash deposit', 'Verify an account and post a deposit'),
      action('#/staff/customers', 'search', 'Find customer', 'Search, view documents, open accounts'),
      action('#/staff/customers', 'wallet', 'Open account', 'Choose a verified customer first')),
    h('div', { style: 'height:20px' }),
    recent);
  const head = h('div', { class: 'card__head' }, h('h2', { id: 'rc-title' }, 'Recently registered customers'), h('a', { class: 'card__link', href: '#/staff/customers' }, 'All customers', icon('arrow-right', { cls: 'icon-sm' })));
  const body = h('div');
  mount(recent, head, body);
  await loadInto(body, () => api.get('/staff/customers'), ({ customers }) => customers.length
    ? customerTable(customers.slice(0, 8))
    : emptyState('No customers yet', 'Register the first customer to get started.', h('a', { class: 'btn btn-primary', href: '#/staff/register' }, 'Register customer')),
  { loading: skeletonRows(5, 4) });
}

function customerTable(rows) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table table--stack' },
    h('caption', { class: 'visually-hidden' }, 'Customers'),
    h('thead', {}, h('tr', {}, ['Name', 'Email', 'Identity', 'Status', 'Registered', ''].map((t) => h('th', { scope: 'col' }, t ? t : h('span', { class: 'visually-hidden' }, 'Open'))))),
    h('tbody', {}, rows.map((c) => h('tr', { class: 'is-clickable', onclick: (e) => { if (!e.target.closest('a')) window.location.hash = `#/staff/customers/${c.id}`; } },
      h('td', { 'data-label': 'Name', class: 'cell-primary' }, c.full_name),
      h('td', { 'data-label': 'Email' }, c.email),
      h('td', { 'data-label': 'Identity' }, badge(c.verification_status)),
      h('td', { 'data-label': 'Status' }, badge(c.status)),
      h('td', { 'data-label': 'Registered', class: 'nowrap' }, formatDate(c.created_at)),
      h('td', { class: 'cell-actions' }, h('a', { class: 'btn btn-secondary btn-sm', href: `#/staff/customers/${c.id}`, 'aria-label': `Open ${c.full_name}` }, 'Open')))))));
}

/* =========================== PDF picker (shared by register + replacement upload) =========================== */
function pdfPicker({ required = true } = {}) {
  let file = null;
  const errId = `pdf-err-${Math.random().toString(36).slice(2)}`;
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'visually-hidden', id: `pdf-${errId}`, 'aria-describedby': `${errId}-hint ${errId}` });
  const error = h('p', { class: 'field-error', id: errId, hidden: true });
  const chipHost = h('div');
  const zone = h('div', { class: 'dropzone' },
    icon('upload', { cls: 'icon-lg' }),
    h('p', {}, h('strong', {}, 'Drag a PDF here'), ' or'),
    h('label', { class: 'btn btn-secondary btn-sm', for: input.id }, 'Choose file'),
    h('p', { class: 'hint', id: `${errId}-hint` }, `PDF only, up to ${fileSize(MAX_DOCUMENT_BYTES)}. Use synthetic documents only — never a real ID.`));

  const setError = (msg) => {
    if (msg) { mount(error, icon('alert'), h('span', {}, msg)); error.hidden = false; zone.setAttribute('aria-invalid', 'true'); }
    else { error.hidden = true; zone.removeAttribute('aria-invalid'); }
  };

  const render = () => {
    zone.hidden = Boolean(file);
    mount(chipHost, file ? h('div', { class: 'file-chip' },
      icon('file'),
      h('span', { class: 'file-chip__name' }, file.name),
      h('span', { class: 'muted nowrap' }, fileSize(file.size)),
      h('label', { class: 'btn btn-ghost btn-sm', for: input.id }, 'Replace'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { file = null; input.value = ''; render(); zone.querySelector('label').focus(); } }, 'Remove')) : null);
  };

  // Preliminary checks only; the server verifies the PDF signature and size.
  const accept = (f) => {
    setError(null);
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) || (f.type && f.type !== 'application/pdf')) { setError('Choose a PDF file (.pdf).'); return; }
    if (f.size > MAX_DOCUMENT_BYTES) { setError(`That file is ${fileSize(f.size)}. The limit is ${fileSize(MAX_DOCUMENT_BYTES)}.`); return; }
    if (f.size === 0) { setError('That file is empty.'); return; }
    file = f;
    render();
  };
  input.addEventListener('change', () => accept(input.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-dragover'); accept(e.dataTransfer.files[0]); });

  const wrap = h('div', { class: 'field' },
    h('span', { class: 'label', id: `${errId}-label` }, 'Identity document (PDF)', required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    input, zone, chipHost, error);
  return {
    wrap, input, setError,
    get file() { return file; },
    reset() { file = null; input.value = ''; render(); },
    validate() { if (required && !file) { setError('Attach the customer\'s identity document (PDF).'); zone.querySelector('label').focus(); return false; } return true; },
  };
}

function progressBar() {
  const bar = h('div', { class: 'progress__bar' });
  const label = h('span', { class: 'hint' });
  const el = h('div', { class: 'stack-sm', hidden: true },
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Upload progress' }, bar), label);
  return {
    el,
    set(fraction) {
      const pct = Math.round(fraction * 100);
      el.hidden = false;
      bar.style.width = `${pct}%`;
      el.firstChild.setAttribute('aria-valuenow', String(pct));
      label.textContent = pct < 100 ? `Uploading… ${pct}%` : 'Upload complete. Verifying the document…';
    },
    hide() { el.hidden = true; },
  };
}

/* =========================== Register customer =========================== */
export async function register({ root }) {
  const area = h('div', { class: 'form-narrow' });
  mount(root, pageHead('Register Customer', 'Create a customer profile. The identity document is reviewed by an administrator.'), area);
  showRegisterForm(area);
}

function showRegisterForm(area, keep = {}) {
  const summary = errorSummary();
  const fName = field({ label: 'Full name', name: 'full_name', required: true, value: keep.full_name || '', autocomplete: 'off', hint: 'As it appears on the identity document.' });
  const fEmail = field({ label: 'Email address', name: 'email', type: 'email', required: true, value: keep.email || '', autocomplete: 'off', inputmode: 'email' });
  const fPhone = field({ label: 'Phone number (optional)', name: 'phone_number', type: 'tel', value: keep.phone_number || '', autocomplete: 'off', inputmode: 'tel', placeholder: '+260 971 000000' });
  const pdf = pdfPicker();
  const fields = [fName, fEmail, fPhone];
  const progress = progressBar();
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('user-plus'), 'Register customer');

  const form = h('form', { class: 'card form', novalidate: true },
    summary,
    alertBox('info', null, 'The customer role is set by the bank automatically. A one-time temporary password is generated for you to hand to the customer.'),
    fName.wrap, fEmail.wrap, fPhone.wrap, pdf.wrap, progress.el,
    h('div', { class: 'form-actions' }, submitBtn));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(summary, fields);
    pdf.setError(null);
    const values = { full_name: fName.input.value.trim(), email: fEmail.input.value.trim(), phone_number: fPhone.input.value.trim() };
    const errors = {};
    if (values.full_name.length < 2) errors.full_name = 'Enter the customer\'s full name.';
    if (!values.email) errors.email = 'Enter an email address.';
    else if (!fEmail.input.checkValidity()) errors.email = 'Enter a valid email address.';
    if (values.phone_number && !/^\+?[0-9][0-9 ]{6,18}$/.test(values.phone_number)) errors.phone_number = 'Phone number must be 7–19 digits, with an optional leading +.';
    if (Object.keys(errors).length) { showErrors(summary, fields, { fields: errors }); return; }
    if (!pdf.validate()) return;

    const fd = new FormData();
    fd.set('full_name', values.full_name);
    fd.set('email', values.email);
    if (values.phone_number) fd.set('phone_number', values.phone_number);
    fd.set('identity_document', pdf.file, pdf.file.name);

    withBusy(submitBtn, async () => {
      try {
        const result = await upload('/staff/customers', fd, { onProgress: (f) => progress.set(f) });
        showRegistered(area, result);
      } catch (err) {
        progress.hide();
        if (!(err instanceof ApiError) || err.status === 401) return;
        if (err.code === 'IDENTITY_DOCUMENT_REQUIRED' || err.code === 'INVALID_DOCUMENT' || err.code === 'FILE_TOO_LARGE') {
          pdf.setError(err.message);
          showErrors(summary, fields, { message: err.message, fieldErrors: () => ({}) });
        } else if (err.status === 409) {
          showErrors(summary, fields, { fields: { email: err.message } });
        } else {
          showErrors(summary, fields, err);
        }
      }
    }, 'Registering…');
  });
  mount(area, form);
}

function showRegistered(area, { customer, document: doc, temporary_password: temp }) {
  toast('Customer registered', 'success');
  mount(area, h('section', { class: 'card stack', 'aria-labelledby': 'reg-ok' },
    h('div', { class: 'result-icon result-icon--success' }, icon('check-circle', { cls: 'icon-lg' })),
    h('h2', { id: 'reg-ok', tabindex: '-1' }, 'Customer registered'),
    h('dl', { class: 'dl dl--2' },
      dd('Name', customer.full_name),
      dd('Email', customer.email),
      dd('Customer ID', String(customer.id)),
      dd('Identity status', badge(customer.verification_status)),
      dd('Document', `${doc.original_filename} (${fileSize(doc.file_size)})`),
      dd('Document status', badge(doc.verification_status))),
    h('div', { class: 'stack-sm' },
      h('p', { class: 'label' }, 'Temporary password'),
      h('div', { class: 'secret' }, h('span', {}, temp), copyButton(temp, 'Copy temporary password')),
      alertBox('warning', 'Shown only once', 'Give this to the customer in person. They must change it at first login. It cannot be displayed again.')),
    alertBox('info', 'Next step', 'An administrator must approve the identity document before you can open an account for this customer.'),
    h('div', { class: 'form-actions' },
      h('a', { class: 'btn btn-primary', href: `#/staff/customers/${customer.id}` }, 'Open customer record'),
      h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => showRegisterForm(area) }, icon('plus'), 'Register another'))));
  area.querySelector('#reg-ok').focus();
}

/* =========================== Customer search =========================== */
export async function customers({ root, query }) {
  const q = query.get('q') || '';
  const input = h('input', { class: 'input', id: 'cust-q', type: 'search', name: 'q', value: q, placeholder: 'Name or email (min. 2 characters)', minlength: '2', autocomplete: 'off' });
  const results = h('div');
  const form = h('form', { class: 'card filters', role: 'search' },
    h('div', { class: 'search-row' },
      h('div', { class: 'field', style: 'flex:1' }, h('label', { for: 'cust-q' }, 'Search customers'), h('div', { class: 'input-icon' }, icon('search'), input)),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v && v.length < 2) { toast('Type at least 2 characters to search.', 'info'); return; }
    window.location.hash = v ? `#/staff/customers?q=${encodeURIComponent(v)}` : '#/staff/customers';
  });
  mount(root,
    pageHead('Customers', 'Search customers, review their documents and open accounts.', h('a', { class: 'btn btn-primary', href: '#/staff/register' }, icon('user-plus'), 'Register customer')),
    form, h('div', { style: 'height:16px' }),
    h('section', { class: 'card card--flush', 'aria-label': 'Results' },
      h('div', { class: 'card__head' }, h('h2', {}, q ? `Results for "${q}"` : 'Latest customers')), results));
  await loadInto(results, () => api.get('/staff/customers', { query: { q: q || undefined } }), ({ customers: rows }) => rows.length
    ? customerTable(rows)
    : emptyState('No customers found', q ? 'Check the spelling or search by email.' : 'No customers have been registered yet.'),
  { loading: skeletonRows(6, 4) });
}

/* =========================== Customer detail =========================== */
export async function customerDetail({ root, params }) {
  const area = h('div');
  mount(root, h('a', { class: 'back-link', href: '#/staff/customers' }, icon('arrow-left', { cls: 'icon-sm' }), 'All customers'), area);
  const reload = () => loadInto(area, () => api.get(`/staff/customers/${encodeURIComponent(params.id)}`), (data) => renderCustomer(data, reload), { errorTitle: 'Customer not available' });
  await reload();
}

function renderCustomer({ customer: c, accounts, documents }, reload) {
  const verified = c.verification_status === 'verified' && c.status === 'active';

  const docRows = documents.length ? h('ul', { class: 'doc-list', role: 'list' }, documents.map((d) => {
    const dl = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('download', { cls: 'icon-sm' }), 'Download');
    dl.addEventListener('click', () => withBusy(dl, async () => {
      try { await download(`/documents/${d.id}/download`, d.original_filename); } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
    }, 'Downloading…'));
    return h('li', { class: 'doc-item' },
      icon('file'),
      h('div', { class: 'doc-item__body' },
        h('p', { class: 'doc-item__name' }, d.original_filename),
        h('p', { class: 'hint' }, `${fileSize(d.file_size)} · uploaded ${formatDateTime(d.created_at)}`),
        d.rejection_reason ? h('p', { class: 'hint' }, `Reason: ${d.rejection_reason}`) : null),
      badge(d.verification_status), dl);
  })) : emptyState('No documents', 'Upload the customer\'s identity document.');

  const pdf = pdfPicker();
  const progress = progressBar();
  const upBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, icon('upload', { cls: 'icon-sm' }), 'Upload document');
  const upForm = h('form', { class: 'form', novalidate: true }, pdf.wrap, progress.el, h('div', { class: 'form-actions' }, upBtn));
  upForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pdf.validate()) return;
    const fd = new FormData();
    fd.set('identity_document', pdf.file, pdf.file.name);
    withBusy(upBtn, async () => {
      try {
        await upload(`/staff/customers/${c.id}/documents`, fd, { onProgress: (f) => progress.set(f) });
        toast('Document uploaded and sent for review', 'success');
        reload();
      } catch (err) {
        progress.hide();
        if (err.status !== 401) pdf.setError(err.message);
      }
    }, 'Uploading…');
  });

  const acctList = accounts.length ? h('ul', { class: 'doc-list', role: 'list' }, accounts.map((a) => h('li', { class: 'doc-item' },
    icon('wallet'),
    h('div', { class: 'doc-item__body' },
      h('p', { class: 'doc-item__name' }, a.account_type_label),
      h('p', { class: 'hint mono' }, groupAccountNumber(a.account_number))),
    h('span', { class: 'amount' }, money(a.balance_minor, a.currency)),
    badge(a.status),
    h('a', { class: 'btn btn-secondary btn-sm', href: `#/accounts/${a.id}` }, 'History')))) : emptyState('No accounts yet', verified ? 'Open the customer\'s first account below.' : 'Accounts can be opened once the identity is verified.');

  return h('div', { class: 'stack' },
    pageHead(c.full_name, c.email, badge(c.verification_status, `Identity ${c.verification_status}`)),
    h('div', { class: 'split' },
      h('section', { class: 'card', 'aria-labelledby': 'cd-title' },
        h('h2', { id: 'cd-title', class: 'card-title' }, 'Customer'),
        h('dl', { class: 'dl dl--2' },
          dd('Customer ID', String(c.id)), dd('Phone', c.phone_number || '—'),
          dd('Status', badge(c.status)), dd('Identity', badge(c.verification_status)),
          dd('Registered', formatDate(c.created_at)), dd('Registered by (staff ID)', String(c.created_by)))),
      h('section', { class: 'card', 'aria-labelledby': 'oa-title' },
        h('h2', { id: 'oa-title', class: 'card-title' }, 'Open an account'),
        openAccountForm(c, verified, reload))),
    h('section', { class: 'card', 'aria-labelledby': 'ac-title' }, h('h2', { id: 'ac-title', class: 'card-title' }, `Accounts (${accounts.length})`), acctList),
    h('section', { class: 'card', 'aria-labelledby': 'dc-title' },
      h('h2', { id: 'dc-title', class: 'card-title' }, 'Identity documents'), docRows,
      h('hr', { class: 'divider' }),
      h('h3', {}, 'Upload a replacement document'),
      h('p', { class: 'hint' }, 'Use this if a document was rejected. The new document goes to an administrator for review.'),
      upForm));
}

function openAccountForm(c, eligible, reload) {
  if (!eligible) {
    return alertBox('warning', 'Not eligible yet', c.status !== 'active'
      ? `This customer is ${c.status}. Accounts can only be opened for active customers.`
      : 'An administrator must verify this customer\'s identity document before an account can be opened.');
  }
  const summary = errorSummary();
  const select = h('select', { class: 'select', name: 'account_type', required: true }, h('option', { value: '' }, 'Loading account types…'));
  const fType = field({ label: 'Account type', name: 'account_type', required: true, control: select });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus'), 'Open account');
  const form = h('form', { class: 'form', novalidate: true },
    summary, fType.wrap,
    h('p', { class: 'hint' }, `The account name is taken from the verified record ("${c.full_name}"). The number is generated by the bank and the balance starts at ${money(0, CURRENCY)}.`),
    h('div', { class: 'form-actions' }, btn));
  let types = [];
  api.get('/accounts/types').then((r) => {
    types = r.account_types;
    mount(select, h('option', { value: '' }, 'Choose a type'), types.map((t) => h('option', { value: t.account_type }, `${t.label} (daily limit ${money(t.daily_transfer_limit_minor, CURRENCY)})`)));
  }).catch((err) => { if (err.status !== 401) mount(select, h('option', { value: '' }, 'Could not load account types')); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(summary, [fType]);
    if (!select.value) { showErrors(summary, [fType], { fields: { account_type: 'Choose an account type.' } }); return; }
    const t = types.find((x) => x.account_type === select.value);
    const ok = await confirmDialog({
      title: 'Open this account?',
      body: h('dl', { class: 'dl' }, dd('Customer', `${c.full_name} (ID ${c.id})`), dd('Account type', t ? t.label : select.value), dd('Opening balance', money(0, CURRENCY))),
      confirmLabel: 'Open account',
    });
    if (!ok) return;
    withBusy(btn, async () => {
      try {
        const { account } = await api.post('/accounts', { customer_id: c.id, account_type: select.value });
        await openDialog({
          title: 'Account opened',
          body: h('dl', { class: 'dl' },
            dd('Account number', h('span', { class: 'copy-row' }, h('span', { class: 'mono' }, groupAccountNumber(account.account_number)), copyButton(account.account_number, 'Copy account number'))),
            dd('Account name', account.account_name), dd('Type', account.account_type_label),
            dd('Balance', money(account.balance_minor, account.currency)), dd('Status', badge(account.status))),
          actions: [{ label: 'Done', kind: 'primary' }],
        });
        reload();
      } catch (err) {
        if (err instanceof ApiError && err.status !== 401) showErrors(summary, [fType], err);
      }
    }, 'Opening…');
  });
  return form;
}

/* =========================== Cash deposit =========================== */
export async function deposit({ root }) {
  const area = h('div', { class: 'form-narrow' });
  mount(root, pageHead('Cash Deposit', 'Verify the account with the customer, then post the deposit.', h('span', { class: 'prototype-note' }, icon('info', { cls: 'icon-sm' }), 'Simulated transaction')), area);
  showDepositForm(area);
}

function showDepositForm(area, keep = {}) {
  const summary = errorSummary();
  const fNumber = field({ label: 'Account number', name: 'account_number', required: true, value: keep.account_number || '', placeholder: 'V24XXXXXXXXXX', autocomplete: 'off', icon: 'wallet' });
  const fName = field({ label: 'Account name (as stated by the customer)', name: 'account_name', required: true, value: keep.account_name || '', autocomplete: 'off', hint: 'Must match the name on the account. Case and extra spaces are ignored.' });
  const fAmount = field({ label: 'Amount', name: 'amount_minor', required: true, value: keep.amountText || '', prefix: CURRENCY, inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', hint: 'Maximum 100,000.00 per deposit.' });
  const fNarr = field({ label: 'Narration', name: 'narration', required: true, value: keep.narration || 'Cash deposit at branch', maxlength: 140 });
  const fields = [fNumber, fName, fAmount, fNarr];

  const lookupResult = h('div', { 'aria-live': 'polite' });
  const lookupBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('search'), 'Verify account');
  let verified = null;

  const showLookup = () => {
    if (!verified) { mount(lookupResult); return; }
    const entered = fName.input.value;
    const match = entered.trim() ? normalizeName(entered) === normalizeName(verified.account_name) : null;
    const eligible = verified.status === 'active' && verified.owner_status === 'active' && verified.owner_verification_status === 'verified';
    mount(lookupResult, h('div', { class: 'card lookup-card' },
      h('dl', { class: 'dl dl--2' },
        dd('Account name on file', verified.account_name),
        dd('Type', verified.account_type_label),
        dd('Account status', badge(verified.status)),
        dd('Holder identity', badge(verified.owner_verification_status))),
      match === true ? alertBox('success', 'Name matches', 'The name you entered matches the account.') : null,
      match === false ? alertBox('error', 'Name does not match', 'Confirm the name with the customer before continuing.') : null,
      !eligible ? alertBox('warning', 'Cannot receive deposits', 'This account or its holder is not eligible. The bank will decline a deposit.') : null));
  };

  lookupBtn.addEventListener('click', () => {
    fNumber.setError(null);
    const num = fNumber.input.value.replace(/\s+/g, '').toUpperCase();
    if (!/^V24\d{10}$/.test(num)) { fNumber.setError('Account numbers look like V24 followed by 10 digits.'); fNumber.input.focus(); return; }
    fNumber.input.value = num;
    withBusy(lookupBtn, async () => {
      try {
        ({ account: verified } = await api.get('/staff/accounts/lookup', { query: { account_number: num } }));
        showLookup();
      } catch (err) {
        verified = null;
        mount(lookupResult);
        if (err.status !== 401) fNumber.setError(err.status === 404 ? 'No account has this number.' : err.message);
      }
    }, 'Checking…');
  });
  fNumber.input.addEventListener('input', () => { verified = null; mount(lookupResult); });
  fName.input.addEventListener('input', showLookup);

  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Review deposit', icon('arrow-right'));
  const form = h('form', { class: 'card form', novalidate: true },
    summary,
    h('div', { class: 'lookup-row' }, fNumber.wrap, lookupBtn),
    lookupResult, fName.wrap, fAmount.wrap, fNarr.wrap,
    h('div', { class: 'form-actions' }, submitBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(summary, fields);
    const values = {
      account_number: fNumber.input.value.replace(/\s+/g, '').toUpperCase(),
      account_name: fName.input.value.trim(),
      amountText: fAmount.input.value.trim(),
      narration: fNarr.input.value.trim(),
    };
    const minor = parseMajorToMinor(values.amountText);
    const errors = {};
    if (!/^V24\d{10}$/.test(values.account_number)) errors.account_number = 'Account numbers look like V24 followed by 10 digits.';
    if (values.account_name.length < 2) errors.account_name = 'Enter the account name given by the customer.';
    if (minor === null) errors.amount_minor = 'Enter a valid amount, e.g. 500.00.';
    else if (minor <= 0) errors.amount_minor = 'The amount must be more than zero.';
    else if (minor > 10_000_000) errors.amount_minor = 'The maximum per deposit is 100,000.00.';
    if (values.narration.length < 3) errors.narration = 'Narration must be at least 3 characters.';
    if (Object.keys(errors).length) { showErrors(summary, fields, { fields: errors }); return; }

    const ok = await confirmDialog({
      title: 'Confirm cash deposit',
      description: 'Check every detail with the customer. Posting cannot be undone from this screen.',
      body: h('dl', { class: 'dl' },
        dd('Account number', h('span', { class: 'mono' }, groupAccountNumber(values.account_number))),
        dd('Account name', values.account_name),
        dd('Amount', h('span', { class: 'review-amount amount' }, money(minor, CURRENCY))),
        dd('Narration', values.narration)),
      confirmLabel: 'Post deposit',
    });
    if (!ok) return;

    withBusy(submitBtn, async () => {
      try {
        const { receipt } = await api.post('/staff/deposits', {
          account_number: values.account_number, account_name: values.account_name, amount_minor: minor, currency: CURRENCY, narration: values.narration,
        });
        showReceipt(area, receipt);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 401) return;
        const byCode = {
          ACCOUNT_NOT_FOUND: 'account_number', ACCOUNT_NAME_MISMATCH: 'account_name', CURRENCY_MISMATCH: 'amount_minor',
        };
        if (byCode[err.code]) showErrors(summary, fields, { fields: { [byCode[err.code]]: err.message } });
        else showErrors(summary, fields, err);
      }
    }, 'Posting…');
  });
  mount(area, form);
}

function showReceipt(area, r) {
  toast('Deposit posted', 'success');
  mount(area, h('section', { class: 'card stack receipt', 'aria-labelledby': 'rcpt-title' },
    h('div', { class: 'receipt__head' },
      h('div', { class: 'result-icon result-icon--success' }, icon('check-circle', { cls: 'icon-lg' })),
      h('div', {}, h('h2', { id: 'rcpt-title', tabindex: '-1' }, 'Deposit receipt'), h('p', { class: 'muted' }, 'Vault24 Bank · Branch cash deposit'))),
    h('dl', { class: 'dl dl--2' },
      dd('Reference', h('span', { class: 'copy-row' }, h('span', { class: 'mono' }, r.reference), copyButton(r.reference, 'Copy reference'))),
      dd('Date', formatDateTime(r.created_at)),
      dd('Account number', h('span', { class: 'mono' }, groupAccountNumber(r.account_number))),
      dd('Account name', r.account_name),
      dd('Account type', titleCase(r.account_type)),
      dd('Amount', h('span', { class: 'review-amount amount' }, money(r.amount_minor, r.currency))),
      dd('Narration', r.narration),
      dd('New balance', h('span', { class: 'amount' }, money(r.balance_after_minor, r.currency))),
      dd('Teller (staff ID)', String(r.performed_by))),
    h('p', { class: 'hint receipt__note' }, 'Simulated transaction for a hackathon prototype. A successful posting confirms the ledger entry, not that physical cash was counted.'),
    h('div', { class: 'form-actions no-print' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => window.print() }, icon('printer'), 'Print receipt'),
      h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => showDepositForm(area) }, icon('plus'), 'New deposit'))));
  area.querySelector('#rcpt-title').focus();
}
