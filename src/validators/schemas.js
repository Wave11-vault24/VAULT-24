'use strict';

const c = require('./common');
const { LIMITS, USER_STATUSES, ACCOUNT_STATUSES } = require('../config/constants');

const { z } = c;

// All objects are strict: unknown keys (role, created_by, balance_minor...) => 400.

const auth = {
  login: z.strictObject({ email: c.email, password: c.password }),
  changePassword: z.strictObject({ current_password: c.password, new_password: c.strongPassword })
    .refine((v) => v.current_password !== v.new_password, { message: 'New password must differ from the current one.', path: ['new_password'] }),
};

const users = {
  registerCustomer: z.strictObject({ full_name: c.fullName, email: c.email, phone_number: c.phone }),
  createStaff: z.strictObject({ full_name: c.fullName, email: c.email, phone_number: c.phone }),
  updateProfile: z.strictObject({ phone_number: c.phone.nullable() })
    .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one editable field (phone_number).' }),
  customerIdParams: z.strictObject({ customerId: c.id }),
  userIdParams: z.strictObject({ userId: c.id }),
  setStatus: z.strictObject({ status: z.enum(USER_STATUSES), reason: z.string().trim().min(3).max(200).optional() }),
  search: z.strictObject({ q: z.string().trim().min(2).max(120).optional() }),
  listUsers: z.strictObject({
    role: z.enum(['customer', 'staff', 'admin']).optional(),
    status: z.enum(USER_STATUSES).optional(),
  }),
};

const documents = {
  docIdParams: z.strictObject({ documentId: c.id }),
  review: z.discriminatedUnion('decision', [
    z.strictObject({ decision: z.literal('verified') }),
    z.strictObject({ decision: z.literal('rejected'), rejection_reason: z.string().trim().min(3).max(200) }),
  ]),
  list: z.strictObject({ status: z.enum(['pending', 'verified', 'rejected']).optional() }),
};

const accounts = {
  open: z.strictObject({ customer_id: z.number().int().positive(), account_type: c.accountType }),
  accountIdParams: z.strictObject({ accountId: c.id }),
  list: z.strictObject({ customer_id: c.id.optional() }),
  lookup: z.strictObject({ account_number: c.accountNumber }),
  setStatus: z.strictObject({ status: z.enum(ACCOUNT_STATUSES), reason: z.string().trim().min(3).max(200) }),
  history: c.pagination,
};

const deposits = {
  create: z.strictObject({
    account_number: c.accountNumber,
    account_name: z.string().trim().min(2).max(120),
    amount_minor: c.amountMinor(LIMITS.MAX_DEPOSIT_MINOR),
    currency: c.currency,
    narration: c.narration,
  }),
};

const transfers = {
  create: z.strictObject({
    from_account_number: c.accountNumber,
    to_account_number: c.accountNumber,
    amount_minor: c.amountMinor(LIMITS.MAX_TRANSFER_MINOR),
    currency: c.currency,
    narration: c.narration.optional(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'idempotency_key must be 16-128 chars of letters, digits, _ or - (a UUID works).'),
  }).refine((v) => v.from_account_number !== v.to_account_number, {
    message: 'You cannot transfer to the same account.', path: ['to_account_number'],
  }),
  referenceParams: z.strictObject({ reference: z.string().regex(/^TRF-\d{8}-[0-9A-Z]{10}$/, 'Invalid transfer reference.') }),
};

const audit = {
  list: z.strictObject({
    action: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
    actor_user_id: c.id.optional(),
    limit: c.pagination.shape.limit,
    before_id: c.pagination.shape.before_id,
  }),
};

module.exports = { auth, users, documents, accounts, deposits, transfers, audit };
