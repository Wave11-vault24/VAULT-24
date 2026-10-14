'use strict';

const { z } = require('zod');
const { LIMITS, ACCOUNT_TYPE_KEYS } = require('../config/constants');

// Positive database ID from a route/query string. Rejects "1abc", "0", "-1", "1e3".
const id = z.string().regex(/^[1-9]\d{0,9}$/, 'Must be a positive integer ID.').transform(Number);

const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email address.').max(254));

const fullName = z.string().trim()
  .min(2).max(120)
  .regex(/^[\p{L}][\p{L}\p{M} .'-]*$/u, 'Name may contain letters, spaces, apostrophes, hyphens and dots.');

// Empty string from a form field means "not supplied".
const phone = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().regex(/^\+?[0-9][0-9 ]{6,18}$/, 'Phone number must be 7-19 digits, optional leading +.').optional(),
);

const noControlChars = /^[^\u0000-\u001f\u007f]*$/;
const narration = z.string().trim().min(3).max(LIMITS.NARRATION_MAX).regex(noControlChars, 'Narration contains invalid characters.');

const currency = z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code.');

// JSON number only: "500" (a string) is rejected so there is no coercion ambiguity.
const amountMinor = (max) => z.number({ error: 'amount_minor must be an integer number of minor units.' })
  .int('amount_minor must be an integer (minor units, e.g. 50000 = 500.00).')
  .positive('amount_minor must be greater than zero.')
  .max(max, `amount_minor may not exceed ${max}.`);

const accountNumber = z.string().trim().toUpperCase().regex(/^V24\d{10}$/, 'Account number must look like V24XXXXXXXXXX.');

const accountType = z.enum(ACCOUNT_TYPE_KEYS, { error: `account_type must be one of: ${ACCOUNT_TYPE_KEYS.join(', ')}.` });

const password = z.string().min(1).max(128);
const strongPassword = z.string()
  .min(12, 'Password must be at least 12 characters.')
  .max(128)
  .regex(/[a-z]/, 'Password needs a lower-case letter.')
  .regex(/[A-Z]/, 'Password needs an upper-case letter.')
  .regex(/\d/, 'Password needs a digit.');

const pagination = z.strictObject({
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().min(1).max(100)).optional(),
  before_id: id.optional(),
});

module.exports = {
  z, id, email, fullName, phone, narration, currency, amountMinor, accountNumber, accountType, password, strongPassword, pagination,
};
