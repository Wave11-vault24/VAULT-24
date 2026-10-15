// Money and date formatting. Money stays in integer minor units end-to-end;
// these helpers only convert to/from display strings, never via floats.
import { MINOR_PER_MAJOR } from './config.js';

/** 1835000 -> "18,350.00" (integer maths only). */
export function formatMinor(minor) {
  const n = Number(minor);
  if (!Number.isSafeInteger(n)) return '—';
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / MINOR_PER_MAJOR);
  const frac = String(abs % MINOR_PER_MAJOR).padStart(2, '0');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${frac}`;
}

/** "ZMW 18,350.00" */
export function money(minor, currency = 'ZMW') {
  return `${currency} ${formatMinor(minor)}`;
}

/** Signed display for ledger movements: "+ZMW 1,200.00" / "−ZMW 50.00". */
export function signedMoney(minor, currency = 'ZMW') {
  const sign = minor < 0 ? '−' : '+';
  return `${sign}${currency} ${formatMinor(Math.abs(minor))}`;
}

/**
 * Parse a user-typed major amount ("1,250.5") into minor units (125050)
 * without floating point. Returns null if the input isn't a valid amount.
 */
export function parseMajorToMinor(text) {
  const cleaned = String(text).trim().replace(/[,\s]/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  return Number(m[1]) * MINOR_PER_MAJOR + Number((m[2] || '').padEnd(2, '0'));
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const formatDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');

/** "V241051117787" -> "V24 1051 1177 87" for readability (display only). */
export function groupAccountNumber(n) {
  return String(n || '').replace(/^(V24)(\d{4})(\d{4})(\d{2})$/, '$1 $2 $3 $4');
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

export function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Same normalisation the server uses for teller name checks (utils/names.js). */
export function normalizeName(name) {
  return String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
