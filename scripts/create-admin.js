'use strict';

// Usage: ADMIN_NAME="..." ADMIN_EMAIL="..." ADMIN_PASSWORD="..." npm run db:create-admin
// Credentials come from environment variables so they never land in shell history
// as arguments or in the repository. The password is never printed.

const { config } = require('../src/config/env');
const { openDatabase } = require('../src/config/database');
const { migrate } = require('../src/db/migrate');
const { createInitialAdmin } = require('../src/services/bootstrap.service');

(async () => {
  const db = openDatabase(config.DATABASE_PATH);
  try {
    migrate(db);
    const admin = await createInitialAdmin(db, {
      fullName: process.env.ADMIN_NAME,
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
    console.log(`Administrator created: ${admin.email} (id ${admin.id})`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
