# VAULT24 Banking Interface

A responsive banking interface with a welcome page, login form, verification step, and dashboard.

## Pages
- `index.html` — welcome/landing page based on the supplied VAULT24 design.
- `login.html` — login form and one-time-code step.
- `dashboard.html` — banking dashboard, transactions, transfer simulation, receipts, profile, security and settings.

## How to run
1. Extract the ZIP.
2. Open the project folder in VS Code and start a local server (for example, Live Server), or run `python -m http.server 8000` from the project folder.
3. Open `http://localhost:8000` in a browser.
4. Click **Login**.
5. Enter a valid email address and a password of at least 10 characters, including uppercase, lowercase, a number and a symbol.
6. Enter any 6-digit verification code.
7. You will be taken to `dashboard.html`.

The dashboard requires the session created by the login form. Logout returns to the login page. The login page's VAULT24 brand link returns to the welcome page.

## Important
This is a front-end interface only. No real authentication, SMS, backend, or money movement is connected. Use fictional data only. Real banking requires secure server-side authentication, session management, validation, and audited financial APIs.


## Security and dashboard updates
- Dashboard quick-access shortcuts for bank transfer, MTN Mobile Money, Airtel Money, and transaction history.
- Frontend email format validation and password-strength checks. The verification step accepts any six digits because SMS verification is not connected.
- Browser-side idle logout after 10 minutes and a restrictive Content Security Policy meta policy.
- Transfer review is available in the interface, and a transaction PIN is required to authorize the transfer request.

## Important security limitation
This remains a frontend-only interface. Browser-side checks can be bypassed and are not real authentication or banking security. Do not use real passwords, customer information, or real payment details. Before production use, implement server-side authentication and authorization, secure HttpOnly/SameSite cookies, password hashing, server-verified OTP delivery/expiry/attempt limits, CSRF protection, rate limiting, server-side validation, audit logging, TLS, and verified bank/mobile-money payment-provider integrations. Transfers in this project are simulated and do not move money.


## Transaction PIN

Set a separate 4–6 digit transaction PIN under Profile. The PIN is required to reveal account balances, authorize transfer requests, and download or print transaction slips. The login password is used only to sign in. These browser-side checks are for interface testing only; production banking must verify passwords on a secure server.


### Payment PIN and OTP flow
Payment requests now require the customer transaction PIN, followed by a 6-digit OTP entry before the request is recorded in the interface. Actual OTP delivery is not active in this frontend-only project. To send codes to customers, connect a secure backend that generates one-time codes, expires them, limits attempts, verifies them server-side, and sends them using an authorized SMS gateway. Bank and mobile-money transfers also require official provider integration before real payments can be processed.


### Payment authorization flow

The customer enters the payment details and selects **Continue to Payment**. After reviewing the details, **Pay Now** opens the transaction PIN prompt, followed by the 6-digit OTP prompt. This archive is a frontend project: it does not send real SMS OTPs or submit payments to banking/mobile-money providers. Connect a secure backend, OTP/SMS provider, and authorized payment integrations before handling real customer accounts or money.
