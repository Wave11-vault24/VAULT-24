// Transfer: form -> review -> submit -> authoritative result.
// One idempotency key per intended transfer, created when the customer reaches
// the review step and REUSED for every retry of that same attempt. Editing the
// transfer starts a new attempt (and a new key).
import { api, ApiError, newIdempotencyKey } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { money, groupAccountNumber, parseMajorToMinor, formatDateTime } from '../format.js';
import { pageHead, field, errorSummary, showErrors, clearErrors, withBusy, alertBox, errorState, emptyState, loadingBlock, badge, copyButton, toast } from '../ui.js';
import { dd } from './shared.js';

const ACCOUNT_RE = /^V24\d{10}$/;
const FAILURE_TEXT = {
  INSUFFICIENT_FUNDS: 'There is not enough money in the source account for this transfer.',
  DAILY_LIMIT_EXCEEDED: 'This transfer would go over the daily transfer limit for this account type.',
};

export async function view({ root, query }) {
  const area = h('div', { class: 'form-narrow' });
  mount(root, pageHead('Transfer Funds', 'Send money to any Vault24 account.'), area);

  let accounts = [];
  // The intended transfer. `key` is null until the customer reaches review.
  const draft = { from: query.get('from') || '', to: '', amountText: '', narration: '', key: null };

  async function loadAccounts() {
    mount(area, loadingBlock('Loading your accounts…'));
    try {
      ({ accounts } = await api.get('/accounts'));
    } catch (err) {
      if (err.status === 401) return;
      mount(area, errorState(err, loadAccounts, 'We could not load your accounts'));
      return;
    }
    const active = accounts.filter((a) => a.status === 'active');
    if (!active.length) {
      mount(area, h('div', { class: 'card' }, emptyState('No account can send transfers', 'You need an active account. Please contact a Vault24 branch.')));
      return;
    }
    if (!active.some((a) => a.account_number === draft.from)) draft.from = active[0].account_number;
    showForm();
  }

  /* ---------------- Step 1: form ---------------- */
  function showForm(serverError) {
    draft.key = null; // any change of mind = a new transfer attempt
    const active = accounts.filter((a) => a.status === 'active');
    const summary = errorSummary();

    const fromSelect = h('select', { class: 'select', name: 'from', required: true },
      active.map((a) => h('option', { value: a.account_number, selected: a.account_number === draft.from || null },
        `${a.account_type_label} · ${groupAccountNumber(a.account_number)} · ${money(a.balance_minor, a.currency)}`)));
    const fFrom = field({ label: 'From account', name: 'from_account_number', required: true, control: fromSelect });
    const fTo = field({ label: 'Recipient account number', name: 'to_account_number', required: true, value: draft.to, placeholder: 'V24XXXXXXXXXX', autocomplete: 'off', icon: 'wallet', hint: 'Vault24 account numbers start with V24 followed by 10 digits.', maxlength: 20 });
    const fAmount = field({ label: 'Amount', name: 'amount_minor', required: true, value: draft.amountText, prefix: 'ZMW', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', hint: 'Up to 2 decimal places, e.g. 250.00' });
    const fNarr = field({ label: 'Narration (optional)', name: 'narration', value: draft.narration, placeholder: 'e.g. Rent for October', maxlength: 140, hint: '3 to 140 characters. Shown to you and the recipient.' });
    const fields = [fFrom, fTo, fAmount, fNarr];

    const limitNote = h('p', { class: 'hint' });
    const updateLimit = () => {
      const a = accounts.find((x) => x.account_number === fromSelect.value);
      limitNote.textContent = a ? `Available: ${money(a.available_balance_minor, a.currency)} · Daily limit for a ${a.account_type_label}: ${money(a.daily_transfer_limit_minor, a.currency)}` : '';
    };
    fromSelect.addEventListener('change', updateLimit);
    updateLimit();

    const form = h('form', { class: 'form card', novalidate: true },
      summary, fFrom.wrap, limitNote, fTo.wrap, fAmount.wrap, fNarr.wrap,
      h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Review transfer', icon('arrow-right'))));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearErrors(summary, fields);
      draft.from = fromSelect.value;
      draft.to = fTo.input.value.replace(/\s+/g, '').toUpperCase();
      draft.amountText = fAmount.input.value.trim();
      draft.narration = fNarr.input.value.trim();

      const errors = {};
      if (!draft.from) errors.from_account_number = 'Choose the account to send from.';
      if (!draft.to) errors.to_account_number = 'Enter the recipient account number.';
      else if (!ACCOUNT_RE.test(draft.to)) errors.to_account_number = 'Account numbers look like V24 followed by 10 digits.';
      else if (draft.to === draft.from) errors.to_account_number = 'You cannot transfer to the same account.';
      const minor = parseMajorToMinor(draft.amountText);
      if (!draft.amountText) errors.amount_minor = 'Enter an amount.';
      else if (minor === null) errors.amount_minor = 'Enter a valid amount, e.g. 250.00 (up to 2 decimal places).';
      else if (minor <= 0) errors.amount_minor = 'The amount must be more than zero.';
      if (draft.narration && draft.narration.length < 3) errors.narration = 'Narration must be at least 3 characters, or leave it empty.';
      if (Object.keys(errors).length) {
        showErrors(summary, fields, { fields: errors });
        return;
      }
      showReview(minor);
    });

    mount(area, form);
    if (serverError) showErrors(summary, fields, serverError);
  }

  /* ---------------- Step 2: review ---------------- */
  function showReview(amountMinor) {
    const sender = accounts.find((a) => a.account_number === draft.from);
    if (!draft.key) draft.key = newIdempotencyKey();
    const payload = {
      from_account_number: draft.from,
      to_account_number: draft.to,
      amount_minor: amountMinor,
      currency: sender.currency,
      idempotency_key: draft.key,
    };
    if (draft.narration) payload.narration = draft.narration;

    const overBalance = amountMinor > sender.available_balance_minor;
    const confirmBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('check'), 'Confirm transfer');
    const editBtn = h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => showForm() }, icon('arrow-left'), 'Edit');
    confirmBtn.addEventListener('click', () => withBusy(confirmBtn, async () => {
      editBtn.disabled = true;
      await submit(payload, sender);
    }, 'Sending…'));

    mount(area, h('section', { class: 'card stack', 'aria-labelledby': 'review-title' },
      h('h2', { id: 'review-title', tabindex: '-1' }, 'Review your transfer'),
      h('dl', { class: 'dl' },
        dd('From', `${sender.account_type_label} · ${groupAccountNumber(sender.account_number)}`),
        dd('To account number', h('span', { class: 'mono review-number' }, groupAccountNumber(payload.to_account_number))),
        dd('Amount', h('span', { class: 'review-amount amount' }, money(amountMinor, sender.currency))),
        dd('Narration', payload.narration || '—')),
      alertBox('info', 'Check the account number carefully', 'Vault24 confirms the recipient\'s name on your receipt once the transfer is processed. Transfers cannot be reversed from the app.'),
      overBalance ? alertBox('warning', 'More than your available balance', `You have ${money(sender.available_balance_minor, sender.currency)} available, so the bank is likely to decline this transfer.`) : null,
      h('div', { class: 'form-actions' }, editBtn, confirmBtn)));
    area.querySelector('#review-title').focus();
  }

  /* ---------------- Step 3: submit (and safe retry) ---------------- */
  async function submit(payload, sender) {
    try {
      const { data, headers } = await api.raw('POST', '/transfers', { body: payload });
      showSuccess(data.transfer, headers.get('Idempotent-Replayed') === 'true');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 401) return;
      if (err.status === 422 && err.body && err.body.transfer) return showDeclined(err.body.transfer, sender);
      if (err.network || err.status >= 500) return showUnknown(payload, sender, err);
      // Rejected before any money moved (validation, not found, key misuse): back to the form.
      const mapped = new ApiError({ ...err, message: err.message, details: err.details });
      if (err.code === 'SENDER_ACCOUNT_NOT_FOUND' || err.code === 'SENDER_ACCOUNT_NOT_ACTIVE') mapped.details = [{ field: 'body.from_account_number', message: err.message }];
      if (err.code === 'RECIPIENT_NOT_AVAILABLE' || err.code === 'SELF_TRANSFER') mapped.details = [{ field: 'body.to_account_number', message: err.message }];
      if (err.code === 'CURRENCY_MISMATCH') mapped.details = [{ field: 'body.to_account_number', message: err.message }];
      showForm(mapped);
    }
  }

  /** Network failure or 5xx: we do NOT know whether the transfer happened. */
  function showUnknown(payload, sender, err) {
    const retryBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('refresh'), 'Check status and retry safely');
    retryBtn.addEventListener('click', () => withBusy(retryBtn, () => submit(payload, sender), 'Checking…'));
    const busy = err.status === 503;
    mount(area, h('section', { class: 'card stack', 'aria-labelledby': 'unknown-title', role: 'alert' },
      h('div', { class: 'result-icon result-icon--warning' }, icon('alert', { cls: 'icon-lg' })),
      h('h2', { id: 'unknown-title', tabindex: '-1' }, busy ? 'The bank was busy' : 'We could not confirm your transfer'),
      h('p', {}, busy
        ? 'Nothing was changed. You can safely try again.'
        : 'The connection dropped before Vault24 replied, so the transfer may or may not have gone through.'),
      h('p', { class: 'muted' }, 'Retrying sends the same request with the same safety key, so the bank will never send it twice. If it already went through you will see the original receipt.'),
      h('div', { class: 'form-actions' },
        retryBtn,
        h('a', { class: 'btn btn-secondary', href: '#/history' }, 'Check transaction history'))));
    area.querySelector('#unknown-title').focus();
  }

  function showSuccess(t, replayed) {
    draft.key = null;
    draft.to = '';
    draft.amountText = '';
    draft.narration = '';
    toast('Transfer completed', 'success');
    mount(area, h('section', { class: 'card stack receipt', 'aria-labelledby': 'ok-title' },
      h('div', { class: 'result-icon result-icon--success' }, icon('check-circle', { cls: 'icon-lg' })),
      h('h2', { id: 'ok-title', tabindex: '-1' }, 'Transfer completed'),
      replayed ? alertBox('info', 'Already processed', 'This is the original result. The transfer was only sent once.') : null,
      h('dl', { class: 'dl dl--2' },
        dd('Reference', h('span', { class: 'copy-row' }, h('span', { class: 'mono' }, t.reference), copyButton(t.reference, 'Copy reference'))),
        dd('Status', badge(t.status)),
        dd('Amount', h('span', { class: 'amount' }, money(t.amount_minor, t.currency))),
        dd('Recipient name', t.to_account_name),
        dd('From', h('span', { class: 'mono' }, groupAccountNumber(t.from_account_number))),
        dd('To', h('span', { class: 'mono' }, groupAccountNumber(t.to_account_number))),
        dd('Narration', t.narration || '—'),
        dd('Completed', formatDateTime(t.completed_at)),
        t.sender_balance_after_minor != null ? dd('Your new balance', h('span', { class: 'amount' }, money(t.sender_balance_after_minor, t.currency))) : null),
      h('div', { class: 'form-actions no-print' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => loadAccounts() }, icon('plus'), 'Make another transfer'),
        h('a', { class: 'btn btn-secondary', href: '#/history' }, 'View history'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => window.print() }, icon('printer'), 'Print'))));
    area.querySelector('#ok-title').focus();
    api.get('/accounts').then((r) => { accounts = r.accounts; }).catch(() => {});
  }

  function showDeclined(t, sender) {
    draft.key = null; // the declined attempt is final; a retry is a new transfer
    mount(area, h('section', { class: 'card stack', 'aria-labelledby': 'fail-title', role: 'alert' },
      h('div', { class: 'result-icon result-icon--danger' }, icon('x-circle', { cls: 'icon-lg' })),
      h('h2', { id: 'fail-title', tabindex: '-1' }, 'Transfer declined'),
      h('p', {}, FAILURE_TEXT[t.failure_reason] || 'The bank declined this transfer.'),
      h('p', { class: 'muted' }, 'No money left your account.'),
      h('dl', { class: 'dl dl--2' },
        dd('Reference', h('span', { class: 'mono' }, t.reference)),
        dd('Status', badge(t.status)),
        dd('Amount', money(t.amount_minor, t.currency)),
        dd('From', groupAccountNumber(t.from_account_number))),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => showForm() }, icon('arrow-left'), 'Change the transfer'),
        h('a', { class: 'btn btn-secondary', href: `#/accounts/${sender.id}` }, 'View account'))));
    area.querySelector('#fail-title').focus();
  }

  await loadAccounts();
}
