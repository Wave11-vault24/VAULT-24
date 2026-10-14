# Vault24 Bank — Backend

Fictional digital-banking backend for a 24-hour cybersecurity hackathon. **No real money, people or documents.**

Stack: Node.js 22 · Express 5 · SQLite (better-sqlite3) · Zod · Argon2id · express-session · Helmet · Jest + Supertest.

## Status

| Milestone | State |
|---|---|
| 1 — Foundation (Express, SQLite, env validation, health check, error handling) | Done, tested |
| 2 — Database (migrations, constraints, admin bootstrap) | Done, tested |
| 3 — Auth & user management | Not started |
| 4 — Accounts API | Not started (schema + number generator ready) |
| 5 — Cash deposits | Not started |
| 6 — Transfers | Not started |
| 7 — Security review & submission | Not started |

## Setup

```bash
npm install
cp .env.example .env          # then set SESSION_SECRET (48+ random bytes)
npm run db:migrate
ADMIN_NAME="Ada Admin" ADMIN_EMAIL="admin@vault24.test" ADMIN_PASSWORD="<12+ chars, Aa1>" npm run db:create-admin
npm run dev                   # http://localhost:3000/api/health
npm test                      # isolated in-memory database per test file
```

`db:create-admin` refuses to run once any admin exists.

## Account types

| Type | Product code | Example number |
|---|---|---|
| `savings`  | 10 | `V2410xxxxxxxx` |
| `student`  | 20 | `V2420xxxxxxxx` |
| `salary`   | 30 | `V2430xxxxxxxx` |
| `business` | 40 | `V2440xxxxxxxx` |

Format: `V24` + 2-digit product code + 8 random digits. Random rather than sequential so numbers don't reveal account volume; uniqueness is enforced by a `UNIQUE` constraint. Types are defined once in `src/config/constants.js`, mirrored in a `CHECK` constraint, and a test fails if the two drift apart.

## Data conventions

- **Money** is `INTEGER` minor units (1 ZMW = 100 ngwee). The schema rejects non-integer and negative balances.
- **Timestamps** are UTC ISO-8601 with milliseconds: `2026-10-14T20:48:00.000Z`.
- **Every connection** enables `foreign_keys`, `busy_timeout=5000` and WAL (file databases).
- Financial writes use `BEGIN IMMEDIATE` (`withWriteTransaction`) to take SQLite's single write lock up front.

## Integrity enforced in the database (not just in code)

- Accounts open at zero balance; owner, number, type, currency and creator are immutable.
- `users.created_by` is immutable; only the bootstrap admin may have no creator.
- Ledger (`transactions`) and `audit_logs` are append-only (update/delete triggers abort).
- Transaction sign must match type: deposits/credits positive, debits negative; transfer legs must link to a transfer.
- Transfers: no self-transfers, positive amounts only, idempotency key unique per initiating user.
- Documents: PDF MIME only, filenames without path separators, reviewer/timestamp present iff reviewed.

## Known limitations (so far)

- SQLite allows one writer at a time and a single file; fine for a demo, not for multi-instance or high-concurrency banking.
- `npm audit` reports advisories in dev-only tooling (Jest/Nodemon); `npm audit --omit=dev` is clean.
