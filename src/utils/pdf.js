'use strict';

const path = require('path');

const PDF_MAGIC = Buffer.from('%PDF-');
const PDF_EOF = Buffer.from('%%EOF');

/**
 * Server-side PDF check that does not trust the extension or browser MIME:
 *  - must begin with the %PDF- signature followed by a version digit
 *  - must contain the %%EOF trailer in its last 1 KiB
 */
function looksLikePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) return false;
  if (!/^[12]$/.test(String.fromCharCode(buffer[5]))) return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024));
  return tail.includes(PDF_EOF);
}

/**
 * Display-only filename: basename only, safe characters only, forced .pdf.
 * Never used to build a storage path.
 */
function sanitizeFilename(original) {
  const base = path.basename(String(original || '')).replace(/\\/g, '');
  let clean = base.normalize('NFKC').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.\s]+/, '').slice(0, 100).trim();
  if (!clean) clean = 'document';
  if (!/\.pdf$/i.test(clean)) clean = `${clean.replace(/\.[^.]*$/, '')}.pdf`;
  return clean;
}

module.exports = { looksLikePdf, sanitizeFilename };
