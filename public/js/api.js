// The ONE place the frontend talks to the backend. Contract (see docs/FRONTEND_INTEGRATION.md):
//  - Session: server-side cookie (HttpOnly) sent automatically on same-origin requests.
//  - CSRF: token from GET /auth/csrf-token, echoed as X-CSRF-Token on every
//    POST/PATCH (login included). Login and change-password return a NEW token.
//  - Errors: { error: { code, message, request_id, details? } }.
// The CSRF token lives only in this module's memory, never in web storage,
// and nothing here logs request bodies, tokens or cookies.
import { API_BASE_URL } from './config.js';

let csrfToken = null;
let csrfPromise = null;

export class ApiError extends Error {
  constructor({ status = 0, code = 'NETWORK_ERROR', message, details = [], requestId = null, body = null, network = false }) {
    super(message || 'The request could not be completed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = Array.isArray(details) ? details : [];
    this.requestId = requestId;
    this.body = body;           // full parsed body, e.g. { error, transfer } for failed transfers
    this.network = network;     // true = no HTTP response (offline, DNS, reset...)
  }

  /** field -> message map, with "body." / "query." prefixes stripped. */
  fieldErrors() {
    const out = {};
    for (const d of this.details) {
      const key = String(d.field || '').replace(/^(body|query|params)\./, '');
      if (key && !out[key]) out[key] = d.message;
    }
    return out;
  }
}

const FRIENDLY = {
  0: 'Could not reach Vault24. Check your connection and try again.',
  401: 'Your session has ended. Please sign in again.',
  403: 'You do not have permission to do that.',
  404: 'We could not find what you were looking for.',
  413: 'That file is too large.',
  429: 'Too many attempts. Please wait a moment and try again.',
  500: 'Something went wrong on our side. Please try again.',
  503: 'The bank is busy right now. Nothing was changed. Please try again.',
};

function buildUrl(path, query) {
  const url = new URL(API_BASE_URL + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function parseBody(response) {
  const type = response.headers.get('content-type') || '';
  if (response.status === 204) return null;
  if (type.includes('application/json')) {
    try { return await response.json(); } catch { return null; }
  }
  return null; // non-JSON (e.g. an HTML error page from a proxy): never shown raw
}

function toApiError(status, body) {
  const e = (body && body.error) || {};
  return new ApiError({
    status,
    code: e.code || `HTTP_${status}`,
    message: e.message || FRIENDLY[status] || FRIENDLY[500],
    details: e.details,
    requestId: e.request_id,
    body,
  });
}

/** Fetch (or reuse) a CSRF token for this session. */
export async function ensureCsrf(force = false) {
  if (csrfToken && !force) return csrfToken;
  if (!csrfPromise) {
    csrfPromise = (async () => {
      const res = await fetch(buildUrl('/auth/csrf-token'), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const body = await parseBody(res);
      if (!res.ok || !body || !body.csrf_token) throw toApiError(res.status, body);
      csrfToken = body.csrf_token;
      return csrfToken;
    })().finally(() => { csrfPromise = null; });
  }
  return csrfPromise;
}

export function forgetCsrf() { csrfToken = null; }

function notifySessionExpired() {
  window.dispatchEvent(new CustomEvent('vault24:session-expired'));
}

/**
 * request('GET', '/accounts', { query, body, signal, expectAuth })
 * Returns { data, status, headers }. Throws ApiError on failure.
 * expectAuth=false (login page) suppresses the global session-expired event.
 */
export async function request(method, path, { body, query, signal, expectAuth = true, _retried = false } = {}) {
  const headers = { Accept: 'application/json' };
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite) headers['X-CSRF-Token'] = await ensureCsrf();
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError({ network: true, message: FRIENDLY[0] });
  }

  const data = await parseBody(response);
  if (data && data.csrf_token) csrfToken = data.csrf_token;

  if (response.ok) return { data, status: response.status, headers: response.headers };

  // The server rejects a bad CSRF token BEFORE running the route, so one retry with a fresh token is safe.
  if (response.status === 403 && data && data.error && data.error.code === 'CSRF_INVALID' && isWrite && !_retried) {
    await ensureCsrf(true);
    return request(method, path, { body, query, signal, expectAuth, _retried: true });
  }

  const error = toApiError(response.status, data);
  if (response.status === 401 && expectAuth) notifySessionExpired();
  throw error;
}

export const api = {
  get: (path, opts) => request('GET', path, opts).then((r) => r.data),
  post: (path, body, opts) => request('POST', path, { ...opts, body }).then((r) => r.data),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }).then((r) => r.data),
  raw: request,
};

/**
 * Multipart upload with progress (fetch has no upload progress, so XHR).
 * Never sets Content-Type: the browser adds the multipart boundary.
 */
export async function upload(path, formData, { onProgress, _retried = false } = {}) {
  const token = await ensureCsrf();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(path));
    xhr.withCredentials = false; // same-origin: cookies are sent anyway
    xhr.setRequestHeader('X-CSRF-Token', token);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.responseType = 'text';
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); });
    }
    xhr.addEventListener('error', () => reject(new ApiError({ network: true, message: FRIENDLY[0] })));
    xhr.addEventListener('abort', () => reject(new ApiError({ network: true, code: 'ABORTED', message: 'Upload cancelled.' })));
    xhr.addEventListener('load', async () => {
      let body = null;
      if ((xhr.getResponseHeader('content-type') || '').includes('application/json')) {
        try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      if (xhr.status === 403 && body?.error?.code === 'CSRF_INVALID' && !_retried) {
        try {
          await ensureCsrf(true);
          return resolve(await upload(path, formData, { onProgress, _retried: true }));
        } catch (err) { return reject(err); }
      }
      if (xhr.status === 401) notifySessionExpired();
      return reject(toApiError(xhr.status, body));
    });
    xhr.send(formData);
  });
}

/** Download a protected file through the session (e.g. an ID document) and save it. */
export async function download(path, fallbackName = 'document.pdf') {
  let response;
  try {
    response = await fetch(buildUrl(path), { credentials: 'same-origin' });
  } catch {
    throw new ApiError({ network: true, message: FRIENDLY[0] });
  }
  if (!response.ok) {
    const body = await parseBody(response);
    if (response.status === 401) notifySessionExpired();
    throw toApiError(response.status, body);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const name = (match && match[1]) || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/** Idempotency key for one intended transfer. Reused on retries of the same attempt. */
export function newIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
