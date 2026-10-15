# Vault24 Frontend — Inspection, Integration Matrix and Plan

Phase 1 output of the frontend brief. Everything here comes from inspecting the real backend: source code plus a live probe of every route on a seeded server, on 2026-10-15. It is not taken from the backend brief or from memory.

## 1. Repository inspection summary

| Item | Finding |
|---|---|
| Entry point | `src/server.js` → `createApp()` in `src/app.js`; `npm run dev` / `npm start` |
| Module system | CommonJS on the backend. The frontend uses native ES modules in the browser (no build step). |
| Existing frontend | None: no `public/` directory, and Express serves no static files |
| API base | `/api` on the same origin as the server |
| Auth | Server-side session cookie `vault24.sid` (HttpOnly, SameSite=Strict, Secure in production, 30-min rolling idle) |
| CSRF | Synchronizer token. `GET /api/auth/csrf-token` → `{ csrf_token }`, sent as `X-CSRF-Token` on every POST/PATCH, **including login**. Login and change-password return a **new** token. |
| Error envelope | `{ error: { code, message, request_id, details?: [{ field: "body.email", message }] } }` |
| Status codes seen | 200, 201, 204 (logout), 400, 401, 403 (`FORBIDDEN`, `CSRF_INVALID`, `ACCOUNT_INACTIVE`, `PASSWORD_CHANGE_REQUIRED`), 404, 409, 413, 422, 429, 500, 503 |
| CSP (Helmet default) | `script-src 'self'`, `script-src-attr 'none'`, `img-src 'self' data:`, `style-src 'self' https: 'unsafe-inline'`. **No inline scripts or inline event handlers are allowed**, so all JS goes in external module files. |
| Upload contract | `multipart/form-data`, field `identity_document`, PDF only, 5 MB (`MAX_DOCUMENT_SIZE_BYTES`), signature-checked server-side |
| Money | Integer minor units (`balance_minor`), plus server-formatted strings (`balance: "18350.00"`); currency `ZMW` |
| Browser test tooling | Chromium 141 via Playwright 1.56 is available, so real end-to-end and viewport tests are possible |

## 2. Actual backend routes and contracts

Probed live: 35 calls across anonymous, customer, staff and admin sessions; every route behaved as documented.

| # | Method & path | Role | Request | Success response |
|---|---|---|---|---|
| 1 | `GET /api/health` | any | — | `{status, database}` |
| 2 | `GET /api/auth/csrf-token` | any | — | `{csrf_token}` |
| 3 | `POST /api/auth/login` | any | `{email, password}` | `{user, must_change_password, csrf_token}` |
| 4 | `POST /api/auth/logout` | signed in | — | 204 |
| 5 | `GET /api/auth/me` | signed in (incl. pending pw change) | — | `{user:{id, full_name, email, phone_number, role, status, verification_status}, must_change_password}` |
| 6 | `POST /api/auth/change-password` | signed in | `{current_password, new_password}` | `{message, csrf_token}` |
| 7 | `GET /api/profile` | signed in | — | `{profile}` |
| 8 | `PATCH /api/profile` | signed in | `{phone_number}` (string or null) | `{profile}` |
| 9 | `GET /api/accounts/types` | signed in | — | `{account_types:[{account_type, label, number_prefix, daily_transfer_limit_minor}]}` |
| 10 | `GET /api/accounts` | customer (own) / staff+admin with `?customer_id=` | — | `{accounts:[{id, account_number, account_name, account_type, account_type_label, currency, balance_minor, balance, available_balance_minor, daily_transfer_limit_minor, status, user_id, created_at}]}` |
| 11 | `GET /api/accounts/:id` | owner, staff, admin | — | `{account}` (404 if not owner) |
| 12 | `GET /api/accounts/:id/transactions?limit&before_id` | owner, staff, admin | — | `{account, total_count, transactions:[{id, reference, transaction_type, amount_minor, balance_after_minor, narration, created_at, transfer_reference, direction, amount, balance_after}], next_before_id}` |
| 13 | `POST /api/accounts` | staff | `{customer_id, account_type}` | 201 `{account}`; 422 `IDENTITY_NOT_VERIFIED` / `CUSTOMER_NOT_ELIGIBLE`; 409 `ACCOUNT_TYPE_EXISTS` |
| 14 | `POST /api/transfers` | customer | `{from_account_number, to_account_number, amount_minor, currency, narration?, idempotency_key}` | 201 `{transfer}`; 200 + `Idempotent-Replayed` on replay; 422 `{error, transfer}` (`INSUFFICIENT_FUNDS` / `DAILY_LIMIT_EXCEEDED`); 409 `IDEMPOTENCY_KEY_REUSED`; 404 sender/recipient |
| 15 | `GET /api/transfers/:reference` | sender, recipient, staff, admin | — | `{transfer:{reference, amount_minor, amount, currency, status, failure_reason, created_at, completed_at, from_account_number, to_account_number, to_account_name, narration, sender_balance_after_minor}}` |
| 16 | `POST /api/staff/customers` | staff | multipart `full_name, email, phone_number?, identity_document` | 201 `{customer, document, temporary_password}` |
| 17 | `GET /api/staff/customers?q=` | staff | — | `{customers:[user]}` (latest 50 without q) |
| 18 | `GET /api/staff/customers/:id` | staff | — | `{customer, accounts, documents}` |
| 19 | `POST /api/staff/customers/:id/documents` | staff | multipart `identity_document` | 201 `{document}` |
| 20 | `GET /api/staff/customers/:id/documents` | staff | — | `{documents}` |
| 21 | `GET /api/staff/accounts/lookup?account_number=` | staff | — | `{account:{account_number, account_name, account_type, account_type_label, currency, status, owner_status, owner_verification_status}}` (no balance) |
| 22 | `POST /api/staff/deposits` | staff | `{account_number, account_name, amount_minor, currency, narration}` | 201 `{receipt:{reference, account_number, account_name, account_type, amount_minor, amount, currency, narration, balance_after_minor, balance_after, performed_by, created_at}}` |
| 23 | `GET /api/documents/:id/download` | staff, admin | — | PDF bytes, `Content-Disposition: attachment` |
| 24 | `POST /api/admin/staff` | admin | `{full_name, email, phone_number?}` | 201 `{staff, temporary_password}` |
| 25 | `GET /api/admin/users?role&status` | admin | — | `{users:[user + failed_login_attempts]}` |
| 26 | `PATCH /api/admin/users/:id/status` | admin | `{status, reason?}` | `{user}` |
| 27 | `GET /api/admin/documents?status` | admin | — | `{documents:[doc + customer_name]}` |
| 28 | `PATCH /api/admin/documents/:id/review` | admin | `{decision:"verified"}` or `{decision:"rejected", rejection_reason}` | `{document}` |
| 29 | `PATCH /api/admin/accounts/:id/status` | admin | `{status, reason}` | `{account}` |
| 30 | `GET /api/admin/audit-logs?action&actor_user_id&limit&before_id` | admin | — | `{audit_logs:[{id, actor_user_id, action, target_type, target_id, outcome, request_id, metadata, created_at}], next_before_id}` |
| 31 | `GET /api/admin/reconciliation` | admin | — | `{healthy, mismatches}` |

## 3. Design assets and extracted theme

Sources: the three supplied images (landing 1080×720, dashboard 1080×720, login 720×1080). Colours were measured as the dominant value of image regions, not guessed.

**Assets cut from the supplied images** (no invented logo):
- `logo-mark-navy.png`, `logo-mark-white.png`: the bank-building mark, background removed, for light and dark surfaces. The "VAULT24 / Secure Banking, Anytime" wordmark is set as real text so it stays sharp and screen-reader friendly.
- `hero-illustration.jpg` (landing), `login-illustration.jpg` (login), `favicon.png`.

| Token | Value | Source / note |
|---|---|---|
| `--color-primary` | `#156CF2` | Login and active-nav buttons (#126CF0–#0C6CFC). White text 4.71:1 (AA) |
| `--color-primary-hover` | `#0F5BD6` | Darker step; also used for link text (6.02:1) |
| `--color-navy` / `--color-text` | `#0B1F4D` | Headlines (#001842–#001254), softened slightly |
| `--color-sidebar` | `#062454` | Dashboard sidebar (#062454) |
| `--color-background` | `#F0F6FC` | Dashboard page (#F0F6FC); login page #EAF0FC |
| `--color-surface` | `#FFFFFF` | Cards and header |
| `--color-text-muted` | `#53627C` | Design grey #7890AE fails AA (3.28:1) → darkened to pass on white, background and tinted cards |
| `--tint-blue/green/purple/sky` | `#DEEAFC` `#E4F6F0` `#EAEAFC` `#E4F0FC` | The four dashboard stat cards |
| `--icon-blue/green/purple` | `#1270F4` `#00A262` `#7E52F0` | Stat-card icon circles |
| `--color-success` | `#157A55` | Design "Active" green #3C9678 fails AA (3.12:1) → darkened |
| `--color-danger` | `#C2353A` | Debit arrows (red), AA on white |
| Radii | 8px controls · 12px cards · 16px panels | Measured from buttons and cards |
| Type | System UI sans stack (Inter-like geometric) | No font file supplied; no external font requests (keeps CSP strict and works offline) |

Personality: airy light-blue backgrounds, white cards with soft shadows, a navy sidebar, one saturated blue for actions, and tinted pastel stat cards.

## 4. Screen → endpoint integration matrix (with verification evidence)

Evidence names refer to tests in `e2e/` (Playwright, real browser and real server) unless marked *Jest* (`tests/`). Results: `docs/FRONTEND_TEST_REPORT.md`.

| Screen / workflow | Calls | Role | Loading | Success | Error handling | Evidence |
|---|---|---|---|---|---|---|
| Landing | — (static) | public | — | Login link | — | auth › landing page links to login |
| Login | `GET /auth/session`, `GET /auth/csrf-token`, `POST /auth/login` | public | Button busy | Redirect by role, or forced password change | 400 field errors, 401 generic, 403 inactive, 429 wait, network | auth › wrong password…, client-side validation…, locked accounts…, rate limiting (429)… |
| App boot / session | `GET /auth/session`, `GET /auth/me` | signed in | Full-page spinner | Role navigation from `/me` | 401 → login ("session ended") | auth › protected pages redirect…, expired session… |
| Logout | `POST /auth/logout` | signed in | Button busy | Back to login | Failure shown; user stays signed in | auth › logout ends the server session… |
| Customer dashboard | `GET /accounts`, `GET /accounts/:id/transactions?limit=6` | customer | Skeleton cards and rows | Stat cards + recent table | Error panel + Retry; empty states | customer › dashboard shows the real balance…, balances can be hidden…, switching account tabs… |
| Accounts list / detail | `GET /accounts`, `GET /accounts/:id`, `GET /accounts/:id/transactions` | customer | Skeletons | Cards; copy number | 404 → "Account not available" | customer › accounts page lists only own accounts… |
| Transfer (form → review → result) | `GET /accounts`, `POST /transfers` | customer | Button busy | Receipt with server reference and recipient name | 400/404 field errors, 422 declined screen, network/5xx → "outcome unknown" + same-key retry | transfer › all 7 tests |
| Transaction history + detail | `GET /accounts/:id/transactions` (paged), `GET /transfers/:ref` | customer | Skeleton rows | Table/cards, Load older, filters | Error + Retry; empty / no matches | customer › history pages…, header search…, transaction details dialog… |
| Profile | `GET /profile`, `PATCH /profile` | all | Skeleton | Saved + refreshed | Field errors | customer › profile edits only the phone number… |
| Security (change password) | `POST /auth/change-password` | all | Button busy | Success; new CSRF token | Field errors, wrong current password | auth › temporary password must change it… |
| Staff dashboard | `GET /staff/customers` | staff | Skeleton | Recent customers + actions | Error + Retry | staff-admin journey; a11y scan staff #/dashboard |
| Register customer + PDF | `POST /staff/customers` (multipart, XHR progress) | staff | Progress bar | Customer, **pending** ID, one-time temp password | Invalid PDF (server signature), too large / not PDF (browser), duplicate email, missing file | staff-admin › register → approve…, server-side PDF validation…, missing document and duplicate email… |
| Customer search / detail | `GET /staff/customers?q=`, `GET /staff/customers/:id` | staff | Skeleton | Profile, documents, accounts | 404 | staff-admin › register → approve… (steps 2, 4) |
| Replacement ID upload | `POST /staff/customers/:id/documents` | staff | Progress bar | New pending document | 400/413 inline | *Jest* users-documents › new upload puts them back to pending |
| Download ID document | `GET /documents/:id/download` | staff, admin | Button busy | Browser download | Toast | staff-admin › register → approve… (step 3) |
| Open account | `GET /accounts/types`, `POST /accounts` | staff | Button busy | Number, zero balance, status | Not eligible (pending ID) shown before submit; 409/422 inline | staff-admin › register → approve… (steps 2, 4) |
| Lookup + cash deposit | `GET /staff/accounts/lookup`, `POST /staff/deposits` | staff | Busy | Review dialog → printable receipt | 404 number, 422 name mismatch / not eligible | staff-admin › register → approve… (step 5), deposit to an unknown account… |
| Staff view of account history | `GET /accounts/:id`, `GET /accounts/:id/transactions` | staff | Skeleton | Ledger | 404 | customer detail "History" links (same view as customer detail) |
| Admin dashboard | `GET /admin/users`, `GET /admin/documents`, `GET /admin/reconciliation`, `GET /admin/audit-logs` | admin | Skeletons | Counts, reconciliation, recent events | Per-panel error + Retry | staff-admin › admin dashboard and audit log… |
| Users + status | `GET /admin/users`, `PATCH /admin/users/:id/status` | admin | Skeleton | Row updated | Own status not offered; errors in dialog | staff-admin › admin creates staff, suspends and reactivates… |
| Create staff | `POST /admin/staff` | admin | Busy | One-time temp password | 400/409 in dialog | staff-admin › admin creates staff… |
| Customer accounts: freeze/close | `GET /accounts?customer_id=`, `PATCH /admin/accounts/:id/status` | admin | Skeleton | Status updated | "zero balance" refusal shown | staff-admin › admin can freeze an account… |
| ID document review | `GET /admin/documents`, `PATCH /admin/documents/:id/review` | admin | Skeleton | Status updated after confirmation | Reason required; 409 already reviewed | staff-admin › register → approve… (step 3), admin rejects a document… |
| Audit log | `GET /admin/audit-logs` | admin | Skeleton | Table, Load older, filters | Error + Retry | staff-admin › admin dashboard and audit log… |
| Not found / access denied | — | any | — | — | Dedicated views + HTML 404 | auth › customer opening an admin URL…; staff cannot reach admin screens…; *Jest* unknown pages get the HTML 404 |
| Responsive + accessibility | all pages | all | — | — | — | responsive-a11y › 10 widths × 15 screens, money never clipped, axe scans (14 screens), keyboard, focus, reduced motion |

Routes deliberately not called by the UI: `GET /api/health` (operations only) and `GET /api/staff/customers/:id/documents`, because the customer-detail call already returns the documents.

## 5. Missing endpoints and backend dependencies

| Need (from designs or brief) | Backend status | Frontend decision |
|---|---|---|
| Serve the frontend from Express (same origin) | **Missing** | **Added**: `express.static` for `public/` plus an HTML 404 for non-API paths. Small backend change, with tests. |
| "Am I signed in?" without a console 401 | Missing (only `/auth/me`, which returns 401) | **Added** `GET /api/auth/session` → `{ authenticated }`. Always 200, never creates a session. Tested in Jest. |
| E2E runs log in dozens of times | Login limiter allows 10 attempts per 15 min | **Added** the `DISABLE_RATE_LIMIT=true` env switch for test runs; **ignored when `NODE_ENV=production`** (Jest-tested). |
| Recipient name check *before* sending a transfer | Missing (the name is only returned after the transfer) | Confirmation shows the account number only, with no fake "verified recipient" claim; the receipt shows the name the server returns. A lookup endpoint would need enumeration protection. **Not added; listed as future work.** |
| "Forgot password?" | Missing (by design: no email/SMS) | Replaced by the text "Forgot your password? Visit a branch." No dead link. |
| "Login with Biometric", "Remember me" | Missing | Omitted |
| "Create one" (public sign-up) | Intentionally absent (staff register customers) | Replaced by "New customers are registered at a branch." |
| "Two-step verification" copy on the security card | No MFA | Card reworded to promote password change; no false MFA claim |
| Notifications bell | Missing | Omitted |
| Pay Bills, ATM withdrawal, Get Support | Missing | Omitted; "View Statements" maps to Transaction History (printable) |
| Global "Search transactions, payees" | No search endpoint | Header search jumps to History and filters **loaded** rows client-side (documented limitation) |
| Settings page | Nothing configurable | Merged into Profile and Security |
| Staff/admin dashboard statistics | No stats endpoint | Built from existing list endpoints (counts are of returned rows, capped by server limits) |
| Deposit detail lookup by reference | Missing | Detail dialog uses the transaction row already loaded |

## 6. Incremental implementation plan

1. **Backend:** serve `public/` statically with an HTML 404; add tests.
2. **Design foundation:** tokens, base, layout (sidebar, header, off-canvas mobile nav), components (buttons, cards, forms, tables → mobile cards, badges, dialog, toast, skeletons).
3. **API client and auth:** central client (CSRF bootstrap and rotation, one safe retry on `CSRF_INVALID`, typed `ApiError`, network vs HTTP errors, XHR uploads with progress); login, logout, session expiry, forced password change, role-aware hash router.
4. **Customer:** dashboard, accounts, transfer (form → confirm → result, idempotent retry), history, transaction detail, profile, security.
5. **Staff:** dashboard, register and upload, customer search and detail, replacement upload, open account, lookup and deposit with receipt.
6. **Admin:** dashboard, users and status, create staff, customer accounts and freeze/close, document review, audit log.
7. **Verification:** Playwright end-to-end tests against a real seeded server (all three roles, failures, duplicate submission, network interruption, idempotent retry); viewport sweep 320–1920 px for horizontal overflow; keyboard and dialog checks; console-error check.
8. **Final review:** grep for `href="#"`, `innerHTML`, inline handlers and dead controls; update README and the test report.
