// Login page: POST /api/auth/login with CSRF, then hand over to the app shell.
import { api, ApiError, ensureCsrf } from './api.js';
import { h, icon, mount, $ } from './dom.js';
import { alertBox } from './ui.js';

const form = $('#login-form');
const email = $('#email');
const password = $('#password');
const submit = $('#login-submit');
const status = $('#login-status');
const toggle = $('#toggle-password');

const params = new URLSearchParams(window.location.search);

// Only allow returning to an in-app hash route (prevents open redirects).
function safeNext() {
  const next = params.get('next') || '';
  return /^#\/[\w\-/?=&.%]*$/.test(next) ? next : '';
}

function showStatus(kind, title, message) {
  mount(status, alertBox(kind, title, message));
  status.focus();
}

function setFieldError(input, message) {
  const err = document.getElementById(`${input.id}-err`);
  if (message) {
    mount(err, icon('alert'), h('span', {}, message));
    err.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  } else {
    err.hidden = true;
    input.removeAttribute('aria-invalid');
  }
}

[email, password].forEach((input) => input.addEventListener('input', () => setFieldError(input, null)));

toggle.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(show));
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  mount(toggle, icon(show ? 'eye' : 'eye-off'));
});

if (params.get('expired') === '1') {
  showStatus('info', 'Your session has ended', 'For your security you were signed out. Please log in again.');
} else if (params.get('signedout') === '1') {
  showStatus('success', 'You have signed out', 'Thanks for banking with Vault24.');
}

// Already signed in? Go straight to the app.
(async () => {
  try {
    const { authenticated } = await api.get('/auth/session', { expectAuth: false });
    if (authenticated) { window.location.replace(`/app.html${safeNext()}`); return; }
  } catch { /* offline: the submit handler will report it */ }
  ensureCsrf().catch(() => { /* surfaced on submit */ });
})();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  setFieldError(email, null);
  setFieldError(password, null);
  mount(status);

  // Browser-side checks are for usability only; the server validates everything.
  let firstInvalid = null;
  if (!email.value.trim()) { setFieldError(email, 'Enter your email address.'); firstInvalid = email; }
  else if (!email.checkValidity()) { setFieldError(email, 'Enter a valid email address, like name@example.com.'); firstInvalid = email; }
  if (!password.value) { setFieldError(password, 'Enter your password.'); firstInvalid = firstInvalid || password; }
  if (firstInvalid) { firstInvalid.focus(); return; }

  const original = Array.from(submit.childNodes);
  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');
  mount(submit, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Signing in…');

  try {
    const result = await api.post('/auth/login', { email: email.value.trim(), password: password.value }, { expectAuth: false });
    password.value = '';
    const target = result.must_change_password ? '#/security?required=1' : (safeNext() || '#/dashboard');
    window.location.replace(`/app.html${target}`);
    return;
  } catch (err) {
    password.value = '';
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 400 && err.details.length) {
      const map = err.fieldErrors();
      if (map.email) setFieldError(email, map.email);
      if (map.password) setFieldError(password, map.password);
      (map.email ? email : password).focus();
    } else if (err.status === 401) {
      showStatus('error', 'Login failed', 'The email or password is incorrect. After 5 failed attempts the account is locked for your protection.');
    } else if (err.code === 'ACCOUNT_INACTIVE') {
      showStatus('error', 'Account unavailable', 'This user account is locked or suspended. Please contact a Vault24 branch.');
    } else if (err.status === 429) {
      showStatus('warning', 'Too many attempts', 'Please wait a few minutes before trying again.');
    } else {
      showStatus('error', 'Could not sign in', err.message);
    }
  } finally {
    if (submit.isConnected) {
      mount(submit, ...original);
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  }
});
