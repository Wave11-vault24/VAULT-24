# Vault24 — Threat Model

Scope: the Vault24 REST API, its SQLite database and private document storage. The frontend is treated as **untrusted**: every rule below is enforced on the server.

## Assets

| Asset | Why it matters |
|---|---|
| Account balances and the ledger | Direct financial loss if altered |
| Customer identity documents (PDF) | Sensitive personal data |
| Credentials and sessions | Lead to everything else |
| Audit trail | Needed to investigate incidents; must not be erasable |

## Trust boundaries

1. **Browser → API.** Everything crossing it is validated (Zod, strict schemas) and authenticated (server-side session).
2. **API → SQLite.** Parameterised statements only; integrity rules duplicated as `CHECK` constraints and triggers.
3. **API → document storage.** Files leave storage only through an authorised route.

## Actors

| Actor | Can | Cannot |
|---|---|---|
| Anonymous | Fetch a CSRF token, log in, health check | Anything else (401) |
| Customer | Own profile, own accounts, own history, transfers from own accounts | Register users, open accounts, deposit, read others' data |
| Staff | Register customers, upload IDs, open accounts, post deposits | Approve IDs, create staff, change statuses, edit balances |
| Admin | Create staff, review IDs, change user/account status, read audit | Register customers, deposit, transfer, edit balances or audit |

No role has a "set balance" or "edit ledger" capability. That code path does not exist.

## Risks and mitigations

### 1. Broken access control: reading or moving another customer's money (IDOR)
**Threat.** A customer changes an ID in a URL (`/api/accounts/7`) or sends `from_account_number` for someone else's account.
**Mitigations.**
- Ownership checked in the service layer on every account, transaction-history and transfer request (`user_id === session user`).
- Non-owned resources return **404**, identical to non-existent ones, so IDs can't be probed.
- Role checks in middleware (`authorize`) plus per-resource checks in services; denials are audited as `authz.denied`.
- User, role and status are re-read from the database on every request, so suspensions apply instantly.
**Evidence.** `tests/accounts.test.js` › *Account access*; `tests/transfers.test.js` › *cannot send from an account they do not own*; `tests/security.test.js` › *Route protection matrix*.

### 2. Double spending, race conditions and partial writes
**Threat.** Parallel or retried transfer requests overdraw an account, apply twice, or crash half-way and leave a debit with no credit.
**Mitigations.**
- Each transfer runs in one `BEGIN IMMEDIATE` transaction. It takes SQLite's single write lock before reading the balance, so the funds check cannot go stale.
- Defence in depth: the debit is a *conditional* update (`WHERE balance_minor >= amount`), and the schema has `CHECK (balance_minor >= 0)`.
- Mandatory idempotency key, unique per user. The same key with the same payload replays the stored result; the same key with a different payload is rejected (409).
- Debit, credit, transfer row, both ledger legs and the audit row commit together or not at all.
- `SQLITE_BUSY` returns 503 "nothing was changed", so clients can safely retry with the same key.
- `/api/admin/reconciliation` proves balance = sum(ledger) for every account.
**Evidence.** `tests/transfers.test.js` › *Concurrency* (20 parallel API requests; 8 threads with separate DB connections), *Idempotency*, *Rollback*. Mutation-tested: switching to deferred transactions and removing the balance guard makes the thread tests fail.

### 3. Credential attacks and session hijacking
**Threat.** Password guessing, credential stuffing, session fixation, cross-site request forgery, stolen cookies.
**Mitigations.**
- Argon2id hashing (19 MiB, t=2). The schema rejects anything that is not an `$argon2id$` hash.
- Account lockout after 5 consecutive failures, plus per-IP login rate limit (10 per 15 min).
- Same generic error for unknown email and wrong password; dummy hash verification equalises timing.
- Session ID regenerated at login and at password change; all of a user's other sessions are destroyed on password change, suspension or lock.
- Cookie: `HttpOnly`, `SameSite=Strict`, `Secure` in production, 30-minute rolling idle timeout. Sessions are stored server-side and destroyed on logout.
- Synchronizer CSRF token required on every state-changing request, including login.
- Staff-issued temporary passwords must be changed before any other action.
**Evidence.** `tests/auth.test.js`.

### 4. Malicious file upload and document leakage
**Threat.** Uploading a script or polyglot disguised as a PDF; path traversal through the filename; guessing document URLs.
**Mitigations.**
- Accepted only if the declared MIME type, the extension **and** the file signature (`%PDF-x` header and `%%EOF` trailer) all agree. 5 MB limit.
- Stored under a random 256-bit name outside the web root with mode `0600`. The client's filename is sanitised and used only for display.
- Downloads go through `/api/documents/:id/download` (staff/admin only), are always sent as attachments with `no-store`, and are audited.
- Storage keys and paths never appear in API responses.
**Evidence.** `tests/users-documents.test.js`.

### 5. Insider misuse by staff
**Threat.** A teller credits a friend's account, approves their own fake ID, or covers their tracks.
**Mitigations.**
- Staff cannot review documents; an admin can't review a document they uploaded (separation of duties).
- Accounts open only for admin-verified customers. Deposits require the account number **and** matching holder name.
- `performed_by` / `created_by` always come from the session; the schema rejects them in request bodies.
- Ledger and audit tables are append-only (database triggers block UPDATE/DELETE).
**Residual risk.** Nothing proves cash was physically received. A real bank would reconcile tills against deposits and require dual control above a threshold.

### 6. Information disclosure through errors and logs
**Mitigations.** A central error handler returns generic 500s without stack traces or SQL. Request logs record the method, path without query string, status, duration and user ID only. Audit metadata passes through a key-based redactor (`password`, `token`, `session`, `csrf`, `hash`…).
**Evidence.** `tests/security.test.js` › *Safe logging and auditing*, *Error responses*.

## Accepted limitations (prototype)

- **SQLite:** one writer at a time and one file. Not suitable for multiple app instances or high-concurrency production banking; a real system would use PostgreSQL with row-level locking and replication.
- **Rate limits** are held in process memory: they reset on restart and aren't shared between instances.
- **No MFA, no email/SMS delivery.** Temporary passwords are shown once to staff to hand over in person.
- **No virus scanning** of uploaded PDFs; the signature check stops type confusion, not malicious PDF content. Staff should open documents in a sandboxed viewer.
- **No encryption at rest** for the database or documents; this relies on host disk encryption.
- **Cash deposits** are trusted teller entries (see risk 5).
- **No real money**, no external payment rails; all data is fictional.
