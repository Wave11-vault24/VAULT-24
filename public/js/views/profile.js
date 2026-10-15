// Profile (GET/PATCH /api/profile) and Security (POST /api/auth/change-password).
// Only phone_number is editable: the server rejects anything else, and the UI
// shows identity fields as read-only text, never as inputs.
import { api, ApiError } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { formatDate, titleCase } from '../format.js';
import { pageHead, field, errorSummary, showErrors, clearErrors, withBusy, loadInto, badge, alertBox, toast } from '../ui.js';
import { dd } from './shared.js';

export async function profileView({ root, refreshMe }) {
  const area = h('div', { class: 'split' });
  mount(root, pageHead('Profile', 'Your personal details held by Vault24.'), area);

  await loadInto(area, () => api.get('/profile'), ({ profile }) => {
    const details = h('section', { class: 'card', 'aria-labelledby': 'pd-title' },
      h('h2', { id: 'pd-title', class: 'card-title' }, 'Personal details'),
      h('dl', { class: 'dl' },
        dd('Full name', profile.full_name),
        dd('Email', profile.email),
        dd('Role', titleCase(profile.role)),
        dd('Status', badge(profile.status)),
        dd('Identity verification', badge(profile.verification_status)),
        dd('Member since', formatDate(profile.created_at))),
      h('p', { class: 'hint', style: 'margin-top:16px' }, 'To change your name or email, visit a Vault24 branch with your identity document.'));

    const summary = errorSummary();
    const phone = field({ label: 'Phone number', name: 'phone_number', type: 'tel', value: profile.phone_number || '', autocomplete: 'tel', inputmode: 'tel', placeholder: '+260 971 000000', hint: '7 to 19 digits, optional leading +. Leave empty to remove it.' });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('check'), 'Save changes');
    const form = h('form', { class: 'card form', novalidate: true, 'aria-labelledby': 'pe-title' },
      h('h2', { id: 'pe-title', class: 'card-title' }, 'Contact details'),
      summary, phone.wrap, h('div', { class: 'form-actions' }, saveBtn));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearErrors(summary, [phone]);
      const value = phone.input.value.trim();
      if (value && !/^\+?[0-9][0-9 ]{6,18}$/.test(value)) {
        showErrors(summary, [phone], { fields: { phone_number: 'Phone number must be 7–19 digits, with an optional leading +.' } });
        return;
      }
      withBusy(saveBtn, async () => {
        try {
          const res = await api.patch('/profile', { phone_number: value || null });
          phone.input.value = res.profile.phone_number || '';
          await refreshMe();
          toast('Profile updated', 'success');
        } catch (err) {
          if (err instanceof ApiError && err.status !== 401) showErrors(summary, [phone], err);
        }
      }, 'Saving…');
    });
    return [details, form];
  });
}

export async function securityView({ root, query, session, refreshMe }) {
  const required = session.mustChangePassword || query.get('required') === '1';
  const summary = errorSummary();
  const current = field({ label: 'Current password', name: 'current_password', type: 'password', required: true, autocomplete: 'current-password', hint: required ? 'Use the temporary password you were given at the branch.' : null });
  const next = field({ label: 'New password', name: 'new_password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters, with an upper-case letter, a lower-case letter and a digit.' });
  const confirm = field({ label: 'Confirm new password', name: 'confirm_password', type: 'password', required: true, autocomplete: 'new-password' });
  const fields = [current, next, confirm];
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('lock'), 'Change password');
  const result = h('div', { 'aria-live': 'polite' });

  const form = h('form', { class: 'card form form-narrow', novalidate: true, 'aria-labelledby': 'pw-title' },
    h('h2', { id: 'pw-title', class: 'card-title' }, 'Change password'),
    summary, current.wrap, next.wrap, confirm.wrap,
    h('div', { class: 'form-actions' }, saveBtn));

  mount(root,
    pageHead('Security', 'Keep your Vault24 sign-in safe.'),
    required ? alertBox('warning', 'Please set a new password', 'You signed in with a temporary password. Choose your own password to continue.') : null,
    required ? h('div', { style: 'height:16px' }) : null,
    result, form,
    h('section', { class: 'card form-narrow', style: 'margin-top:20px', 'aria-labelledby': 'tips-title' },
      h('h2', { id: 'tips-title', class: 'card-title' }, 'How Vault24 protects you'),
      h('ul', { class: 'tips' },
        h('li', {}, 'You are signed out automatically after 30 minutes without activity.'),
        h('li', {}, 'Five wrong passwords in a row lock the account until a branch unlocks it.'),
        h('li', {}, 'Changing your password signs you out on every other device.'),
        h('li', {}, 'Vault24 staff will never ask for your password.'))));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors(summary, fields);
    const errors = {};
    if (!current.input.value) errors.current_password = 'Enter your current password.';
    const pw = next.input.value;
    if (pw.length < 12) errors.new_password = 'Use at least 12 characters.';
    else if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) errors.new_password = 'Include an upper-case letter, a lower-case letter and a digit.';
    else if (pw === current.input.value) errors.new_password = 'The new password must be different from the current one.';
    if (confirm.input.value !== pw) errors.confirm_password = 'The passwords do not match.';
    if (Object.keys(errors).length) { showErrors(summary, fields, { fields: errors }); return; }

    withBusy(saveBtn, async () => {
      try {
        await api.post('/auth/change-password', { current_password: current.input.value, new_password: pw });
        fields.forEach((f) => { f.input.value = ''; });
        await refreshMe();
        mount(result, alertBox('success', 'Password changed', 'Any other sessions have been signed out.'), h('div', { style: 'height:16px' }));
        toast('Password changed', 'success');
        if (required) {
          mount(result, alertBox('success', 'Password changed', 'Taking you to your dashboard…'));
          setTimeout(() => { window.location.hash = '#/dashboard'; }, 900);
        }
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 401) return;
        current.input.value = '';
        if (err.message === 'Current password is incorrect.') showErrors(summary, fields, { fields: { current_password: err.message } });
        else showErrors(summary, fields, err);
      }
    }, 'Saving…');
  });
}
