'use strict';

// Runs in a worker thread with its OWN SQLite connection to a shared file, so
// writes genuinely contend for SQLite's single write lock.
const { parentPort, workerData } = require('worker_threads');
const { openDatabase } = require('../../src/config/database');
const { createTransfer } = require('../../src/services/transfer.service');

const { dbPath, customerId, from, to, amount, count, keyPrefix, sharedKey } = workerData;
const db = openDatabase(dbPath);
const outcomes = { completed: 0, failed: 0, replayed: 0, busy: 0, errors: [] };

for (let i = 0; i < count; i++) {
  try {
    const { replayed, transfer } = createTransfer(db, {
      customer: { id: customerId },
      input: {
        from_account_number: from, to_account_number: to, amount_minor: amount, currency: 'ZMW',
        idempotency_key: sharedKey || `${keyPrefix}-${String(i).padStart(6, '0')}`,
      },
      requestId: null,
    });
    if (replayed) outcomes.replayed += 1;
    else outcomes[transfer.status] += 1;
  } catch (err) {
    if (err.code === 'SQLITE_BUSY') outcomes.busy += 1;
    else outcomes.errors.push(err.code || err.message);
  }
}
db.close();
parentPort.postMessage(outcomes);
