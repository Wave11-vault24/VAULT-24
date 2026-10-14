# Vault24 Bank — Backend

Backend for a **fictional** digital bank, built for a 24-hour cybersecurity hackathon.
No real money, people, accounts or identity documents are involved.

**Stack:** Node.js 22 · Express 5 · SQLite (better-sqlite3) · Zod · Argon2id · express-session (SQLite store) · Helmet · express-rate-limit · Multer · Jest + Supertest

**Status:** all seven milestones done. **233 automated tests passing**; see [docs/TEST_REPORT.md](docs/TEST_REPORT.md) and the threat model in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

---

## Quick start

```bash
npm install
cp .env.example .env
# put a real secret in .env:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run db:reset        # create database + fictional demo data (prints logins)
npm run dev             # http://localhost:3000/api/health
```

Run the guided demo in a second terminal (needs `curl` and `jq`):

```bash
bash scripts/demo-walkthrough.sh
```

### npm scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Start with nodemon / plain node. Migrations run on start. |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:create-admin` | One-time first admin from `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` env vars. Refuses if an admin exists. |
| `npm run db:seed` | Seed fictional demo data into an empty database |
| `npm run db:reset` | Delete DB + stored documents, migrate, seed (refuses in production) |
| `npm test` | Full test suite (isolated in-memory DB per suite, temp storage) |
| `npm run test:report` | Run tests with coverage and regenerate `docs/TEST_REPORT.md` |

### Environment (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables Secure cookies, `trust proxy`, and refuses weak secrets |
| `PORT` | `3000` | |
| `DATABASE_PATH` | `data/vault24.db` | Tests use `:memory:` |
| `SESSION_SECRET` | — | **Required in production**, ≥ 32 chars |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | Comma-separated CORS allow-list |
| `DOCUMENT_STORAGE_PATH` | `storage/private-documents` | Outside any public folder; git-ignored |
| `MAX_DOCUMENT_SIZE_BYTES` | `5242880` (5 MB) | |
| `BANK_CURRENCY` | `ZMW` | Single currency |

---

## Demo credentials (fictional, created by `npm run db:reset`)

| Role | Email | Password | Notes |
|---|---|---|---|
| admin | `admin@vault24.test` | `Vault24-Admin-Demo1` | |
| staff | `teller@vault24.test` | `Vault24-Staff-Demo1` | |
| customer | `jane@vault24.test` | `Vault24-Customer-Demo1` | Savings + Salary |
| customer | `john@vault24.test` | `Vault24-Customer-Demo1` | Savings |
| customer | `mary@vault24.test` | `Vault24-Customer-Demo1` | Student |
| customer | `chanda@vault24.test` | `Vault24-Customer-Demo1` | Business + Savings |
| customer | `peter@vault24.test` | `Vault24-Customer-Demo1` | ID **pending**, no accounts |
| customer | `rita@vault24.test` | `Vault24-Customer-Demo1` | ID **rejected**, no accounts |

Account numbers are random, so they change on every reset; the seed prints them.

---

## Account types

| `account_type` | Label | Number prefix | Daily outgoing transfer limit |
|---|---|---|---|
| `savings` | Savings Account | `V2410` | 20,000.00 ZMW |
| `student` | Student Account | `V2420` | 5,000.00 ZMW |
| `salary` | Salary Account | `V2430` | 50,000.00 ZMW |
| `business` | Business Account | `V2440` | 200,000.00 ZMW |

- Format: `V24` + 2-digit product code + 8 random digits (random, so numbers don't reveal account volume).
- A customer may hold **one open account of each type**.
- Defined once in `src/config/constants.js`, mirrored by a database `CHECK`; a test fails if they drift apart.
- `GET /api/accounts/types` serves this table to the frontend.

---

## Business rules

| Rule | Where enforced |
|---|---|
| Only staff register customers; role is always `customer`; `created_by` = session user | `user.service.registerCustomer`, strict schema, DB `CHECK` |
| Registration requires a PDF ID; customer starts `pending` with a one-time temporary password | `document.service`, `user.service` |
| Only admins approve/reject IDs, never one they uploaded | `document.service.review` |
| Accounts open only for **active, ID-verified** customers, at **zero** balance | `account.service.openAccount`, DB trigger |
| Teller deposit needs matching account number **and** holder name | `deposit.service` + `utils/names.js` |
| Customers transfer only from accounts they own; no overdraft; per-type daily limit; idempotent | `transfer.service` |
| Ledger and audit log are append-only | DB triggers |
| No endpoint can set a balance | No such code path exists |

**Name-matching policy (deposits):** Unicode NFKC normalisation → trim → collapse spaces → lowercase, then an exact match. `"  JANE   mwangi "` matches `Jane Mwangi`; `"J. Mwangi"` does not.

**Locked vs suspended:** `locked` is set automatically after 5 failed logins; `suspended` is an admin decision. Both block login and kill existing sessions; only an admin can restore `active`.

---

## API

All responses are JSON. Money is always **integer minor units** (`50000` = 500.00 ZMW); responses also include formatted strings (`"500.00"`).
Errors look like `{ "error": { "code", "message", "request_id", "details?" } }`.

### Client flow (for the frontend)

1. `GET /api/auth/csrf-token` → `{ csrf_token }`. This also sets the session cookie.
2. `POST /api/auth/login` with header `X-CSRF-Token`, body `{ email, password }` → `{ user, must_change_password, csrf_token }`. **Store the new `csrf_token`**; it rotates at login.
3. If `must_change_password` is true, call `POST /api/auth/change-password` first.
4. Send `X-CSRF-Token` on every POST/PATCH. Use `credentials: 'include'` in `fetch`.

### Routes

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/health` | anyone | Liveness + DB check |
| `GET /api/auth/csrf-token` | anyone | Get CSRF token |
| `POST /api/auth/login` | anyone | `{ email, password }` |
| `POST /api/auth/logout` | signed in | Destroys session (204) |
| `GET /api/auth/me` | signed in | Current user + `must_change_password` |
| `POST /api/auth/change-password` | signed in | `{ current_password, new_password }` (12+ chars, upper, lower, digit) |
| `GET /api/profile` | signed in | Own profile |
| `PATCH /api/profile` | signed in | `{ phone_number }`; anything else → 400 |
| `GET /api/accounts/types` | signed in | Account-type catalogue |
| `GET /api/accounts` | customer: own · staff/admin: `?customer_id=` | List accounts |
| `GET /api/accounts/:accountId` | owner, staff, admin | One account |
| `GET /api/accounts/:accountId/transactions?limit=&before_id=` | owner, staff, admin | Ledger, newest first, with `total_count` |
| `POST /api/accounts` | **staff** | `{ customer_id, account_type }` |
| `POST /api/transfers` | **customer** | `{ from_account_number, to_account_number, amount_minor, currency, narration?, idempotency_key }` |
| `GET /api/transfers/:reference` | sender, recipient, staff, admin | Transfer details |
| `POST /api/staff/customers` | **staff** | multipart: `full_name`, `email`, `phone_number?`, `identity_document` (PDF) → includes `temporary_password` once |
| `GET /api/staff/customers?q=` | **staff** | Search customers |
| `GET /api/staff/customers/:customerId` | **staff** | Customer + accounts + documents |
| `POST /api/staff/customers/:customerId/documents` | **staff** | Upload replacement ID (multipart) |
| `GET /api/staff/customers/:customerId/documents` | **staff** | Document metadata |
| `GET /api/staff/accounts/lookup?account_number=` | **staff** | Pre-deposit check (name, type, status; no balance) |
| `POST /api/staff/deposits` | **staff** | `{ account_number, account_name, amount_minor, currency, narration }` → receipt |
| `GET /api/documents/:documentId/download` | staff, admin | Stream the PDF (attachment, no-store) |
| `POST /api/admin/staff` | **admin** | `{ full_name, email, phone_number? }` → `temporary_password` |
| `GET /api/admin/users?role=&status=` | **admin** | List users |
| `PATCH /api/admin/users/:userId/status` | **admin** | `{ status: active\|locked\|suspended, reason? }` |
| `GET /api/admin/documents?status=` | **admin** | Review queue |
| `PATCH /api/admin/documents/:documentId/review` | **admin** | `{ decision: "verified" }` or `{ decision: "rejected", rejection_reason }` |
| `PATCH /api/admin/accounts/:accountId/status` | **admin** | `{ status: active\|frozen\|closed, reason }` (close requires zero balance) |
| `GET /api/admin/audit-logs?action=&actor_user_id=&limit=&before_id=` | **admin** | Audit trail |
| `GET /api/admin/reconciliation` | **admin** | Balance vs ledger check |

### Transfer responses

| Situation | Status | Body |
|---|---|---|
| New transfer completed | 201 | `{ transfer }` |
| Same `idempotency_key`, same payload | 200 + `Idempotent-Replayed: true` | Original `{ transfer }` |
| Same key, different payload | 409 `IDEMPOTENCY_KEY_REUSED` | |
| Not enough money / over daily limit | 422 `INSUFFICIENT_FUNDS` / `DAILY_LIMIT_EXCEEDED` | `{ error, transfer }` (status `failed`, recorded) |
| Database busy | 503 `SERVICE_BUSY` | Nothing changed; retry with the same key |

Generate the key once per user action (e.g. `crypto.randomUUID()` when the Send button is pressed) and reuse it on retries.

### Mapping the dashboard design

| Dashboard element | Source |
|---|---|
| "Hello, Jane Mwangi / Customer" | `GET /api/auth/me` |
| Account Balance / Available Balance | `GET /api/accounts` → `balance`, `available_balance_minor` (equal, since there are no holds in this prototype) |
| Total Transactions | `GET /api/accounts/:id/transactions` → `total_count` |
| Account Status | `GET /api/profile` → `status` |
| Recent Transactions table | `GET /api/accounts/:id/transactions?limit=6` → `created_at`, `narration`, `direction`, `amount`, `balance_after` |
| Transfer Funds | `POST /api/transfers` |

ATM withdrawals and bill payments appear in the design but are **not implemented**; only cash deposits and transfers exist.

---

## Project structure

```text
src/
  app.js, server.js
  config/       env.js (validated settings), database.js (pragmas, BEGIN IMMEDIATE helper),
                constants.js (roles, account types, limits), session-store.js
  db/           migrate.js (checksummed migrations)
  middleware/   authenticate, authorize, csrf, validate, rate-limit, upload,
                request-id, request-logger, error-handler
  routes/       one router per area (auth, staff, deposits, accounts, transfers,
                profile, documents, admin)
  services/     business logic + SQL (auth, user, document, account, deposit,
                transfer, audit, admin, bootstrap)
  validators/   Zod schemas (strict: unknown fields are rejected)
  utils/        money, names, pdf, references, account numbers, passwords
migrations/     001_initial_schema.sql, 002_auth_and_policy.sql
scripts/        migrate, create-admin, seed, test-report, demo-walkthrough.sh
tests/          8 suites + harness + worker for multi-thread concurrency tests
docs/           THREAT_MODEL.md, TEST_REPORT.md
storage/private-documents/   uploaded PDFs (git-ignored)
```

Routes stay thin and services hold logic and SQL directly. We chose not to add separate controller and repository layers so the code stays small enough for a two-person team to explain line by line.

## Data conventions

- **Money:** `INTEGER` minor units everywhere. The DB rejects non-integers and negative balances.
- **Time:** UTC ISO-8601 with milliseconds, e.g. `2026-10-14T20:48:00.000Z`.
- **References:** `DEP-YYYYMMDD-XXXXXXXXXX`, `TRF-YYYYMMDD-XXXXXXXXXX` (random Crockford base32, never a DB id). Ledger legs add `-D` / `-C`.
- **Consistency:** `accounts.balance_minor` is the single authoritative balance. Every change to it writes a ledger row in the same transaction, so balance = sum(ledger), checked by `/api/admin/reconciliation`.
- **SQLite:** `foreign_keys=ON`, `busy_timeout=5000`, WAL, and `BEGIN IMMEDIATE` for every write path.

## Limitations

- SQLite has a single writer and a single file. It is fine for this demo, but not for multiple app instances or real banking load.
- Rate limits are in memory, per process.
- No MFA, no email/SMS. Temporary passwords are shown once to staff.
- No antivirus scan of PDFs; no encryption at rest.
- Cash deposits are trusted teller input; nothing proves cash was received.
- Single currency; no holds, reversals, interest, fees, ATM or bill payments.
- `npm audit` flags advisories in dev-only tooling (Jest, Nodemon); `npm audit --omit=dev` is clean.

More detail in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## AI assistance disclosure

This backend was written with substantial help from **Claude (Anthropic)**, working through the milestones of the team's engineering brief. The AI produced the code, migrations, tests and documentation. Every test result quoted here comes from actual runs, and the test report is generated from Jest's JSON output. During development, the concurrency tests were mutation-checked: weakening the transaction mode and the balance guard made them fail.

The team is responsible for reviewing, understanding and presenting the code.

## Team contributions

> **To fill in before submission.** List each team member and what they did, e.g.:
>
> | Member | Contribution |
> |---|---|
> | _Name 1_ | _e.g. requirements brief, security review, frontend integration, demo_ |
> | _Name 2_ | _e.g. test review, threat model review, deployment, presentation_ |
