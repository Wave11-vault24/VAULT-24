'use strict';

/**
 * Seed FICTIONAL demo data through the real services, so every row obeys the
 * same rules as production code (audit trail, ledger entries, PDF checks).
 *
 *   npm run db:seed     seed an empty database
 *   npm run db:reset    delete the database + stored documents, migrate, seed
 *
 * Refuses to run in production. All people, documents and money are invented.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../src/config/env');
const { openDatabase } = require('../src/config/database');
const { migrate } = require('../src/db/migrate');
const { hashPassword } = require('../src/utils/password');
const { createInitialAdmin } = require('../src/services/bootstrap.service');
const userService = require('../src/services/user.service');
const documentService = require('../src/services/document.service');
const accountService = require('../src/services/account.service');
const depositService = require('../src/services/deposit.service');
const transferService = require('../src/services/transfer.service');
const { syntheticIdentityPdf } = require('./lib/synthetic-pdf');

// Shared, documented demo passwords. Dev/demo ONLY.
const DEMO = {
  admin: { full_name: 'Ada Admin', email: 'admin@vault24.test', password: 'Vault24-Admin-Demo1' },
  staff: { full_name: 'Tom Teller', email: 'teller@vault24.test', password: 'Vault24-Staff-Demo1' },
  customerPassword: 'Vault24-Customer-Demo1',
};

// [name, email, phone, verification outcome, account types, cash deposits (minor units) per type]
const CUSTOMERS = [
  ['Jane Mwangi', 'jane@vault24.test', '+260 971 000101', 'verified', { savings: 1_250_000, salary: 3_400_000 }],
  ['John Daka', 'john@vault24.test', '+260 971 000102', 'verified', { savings: 450_000 }],
  ['Mary Sakala', 'mary@vault24.test', '+260 971 000103', 'verified', { student: 85_000 }],
  ['Chanda Enterprises Owner', 'chanda@vault24.test', '+260 971 000104', 'verified', { business: 9_800_000, savings: 200_000 }],
  ['Peter Pending', 'peter@vault24.test', '+260 971 000105', 'pending', {}],
  ['Rita Rejected', 'rita@vault24.test', '+260 971 000106', 'rejected', {}],
];

function pdfFile(name) {
  return { buffer: syntheticIdentityPdf(name), originalname: `${name.toLowerCase().replace(/\s+/g, '-')}-synthetic-id.pdf`, mimetype: 'application/pdf' };
}

async function main() {
  if (config.isProduction) throw new Error('Refusing to seed demo data in production.');

  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.DATABASE_PATH + suffix, { force: true });
    if (fs.existsSync(config.DOCUMENT_STORAGE_PATH)) {
      for (const f of fs.readdirSync(config.DOCUMENT_STORAGE_PATH)) {
        if (/^[a-f0-9]{64}$/.test(f)) fs.rmSync(path.join(config.DOCUMENT_STORAGE_PATH, f));
      }
    }
    console.log('Database and stored documents removed.');
  }

  const db = openDatabase(config.DATABASE_PATH);
  try {
    migrate(db);
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
      throw new Error('Database already contains users. Use "npm run db:reset" to start over.');
    }
    const requestId = `seed-${crypto.randomUUID()}`;
    const setDemoPassword = async (userId, password) => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(password), userId);
    };

    const adminRef = await createInitialAdmin(db, { fullName: DEMO.admin.full_name, email: DEMO.admin.email, password: DEMO.admin.password });
    const admin = { id: adminRef.id };

    const { staff: staffRow } = await userService.createStaff(db, { admin, input: DEMO.staff, requestId });
    await setDemoPassword(staffRow.id, DEMO.staff.password);
    const staff = { id: staffRow.id };

    const accountsByEmail = {};
    for (const [name, email, phone, outcome, deposits] of CUSTOMERS) {
      const reg = await userService.registerCustomer(db, config, {
        staff, input: { full_name: name, email, phone_number: phone }, file: pdfFile(name), requestId,
      });
      await setDemoPassword(reg.customer.id, DEMO.customerPassword);

      if (outcome !== 'pending') {
        documentService.review(db, {
          documentId: reg.document.id, reviewer: admin, decision: outcome,
          rejectionReason: outcome === 'rejected' ? 'Synthetic document unreadable (demo rejection)' : undefined, requestId,
        });
      }

      accountsByEmail[email] = {};
      for (const [type, amount] of Object.entries(deposits)) {
        const acct = accountService.openAccount(db, config, { staff, customerId: reg.customer.id, accountType: type, requestId });
        accountsByEmail[email][type] = acct;
        depositService.postDeposit(db, {
          staff, requestId,
          input: { account_number: acct.account_number, account_name: acct.account_name, amount_minor: amount, currency: config.BANK_CURRENCY, narration: 'Opening cash deposit at branch' },
        });
      }
    }

    // A few transfers so dashboards have history.
    const jane = db.prepare('SELECT id FROM users WHERE email = ?').get('jane@vault24.test');
    const john = db.prepare('SELECT id FROM users WHERE email = ?').get('john@vault24.test');
    const t = (customerId, from, to, amount, narration) => transferService.createTransfer(db, {
      customer: { id: customerId }, requestId,
      input: { from_account_number: from.account_number, to_account_number: to.account_number, amount_minor: amount, currency: config.BANK_CURRENCY, narration, idempotency_key: crypto.randomUUID() },
    });
    const A = accountsByEmail;
    t(jane.id, A['jane@vault24.test'].salary, A['jane@vault24.test'].savings, 500_000, 'Transfer to Savings Account');
    t(jane.id, A['jane@vault24.test'].savings, A['mary@vault24.test'].student, 35_000, 'Transfer to Mary S.');
    t(john.id, A['john@vault24.test'].savings, A['jane@vault24.test'].savings, 120_000, 'Money for groceries');
    t(jane.id, A['jane@vault24.test'].salary, A['chanda@vault24.test'].business, 87_500, 'Electricity bill share');

    console.log('\nFictional demo data created.\n');
    console.log('Role      Email                    Password');
    console.log(`admin     ${DEMO.admin.email.padEnd(24)} ${DEMO.admin.password}`);
    console.log(`staff     ${DEMO.staff.email.padEnd(24)} ${DEMO.staff.password}`);
    for (const [name, email, , outcome] of CUSTOMERS) {
      console.log(`customer  ${email.padEnd(24)} ${DEMO.customerPassword}   (${name}, ID ${outcome})`);
    }
    console.log('\nAccounts:');
    for (const row of db.prepare(`SELECT a.account_number, a.account_type, a.balance_minor, u.email FROM accounts a JOIN users u ON u.id = a.user_id ORDER BY a.id`).all()) {
      console.log(`  ${row.account_number}  ${row.account_type.padEnd(8)}  ${(row.balance_minor / 100).toFixed(2).padStart(11)} ${config.BANK_CURRENCY}  ${row.email}`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
});
