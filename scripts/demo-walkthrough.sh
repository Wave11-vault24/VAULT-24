#!/usr/bin/env bash
# Live demo against a running server seeded with `npm run db:reset`.
#   npm run dev            (terminal 1)
#   bash scripts/demo-walkthrough.sh   (terminal 2)
# Requires: curl, jq.
set -euo pipefail
API="${API:-http://localhost:3000/api}"
JAR_DIR="$(mktemp -d)"
trap 'rm -rf "$JAR_DIR"' EXIT

step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

# login <name> <email> <password>  -> stores cookie jar + CSRF token for <name>
login() {
  local jar="$JAR_DIR/$1.jar"
  local csrf
  csrf=$(curl -s -c "$jar" "$API/auth/csrf-token" | jq -r .csrf_token)
  csrf=$(curl -s -b "$jar" -c "$jar" -H "Content-Type: application/json" -H "X-CSRF-Token: $csrf" \
    -d "{\"email\":\"$2\",\"password\":\"$3\"}" "$API/auth/login" | jq -r .csrf_token)
  echo "$csrf" > "$JAR_DIR/$1.csrf"
}
get()  { curl -s -b "$JAR_DIR/$1.jar" "$API$2"; }
send() { curl -s -w '\nHTTP %{http_code}\n' -b "$JAR_DIR/$1.jar" -X "$2" -H "Content-Type: application/json" \
           -H "X-CSRF-Token: $(cat "$JAR_DIR/$1.csrf")" -d "$4" "$API$3"; }

step "Health"
curl -s "$API/health" | jq

step "Customer Jane logs in and views her accounts"
login jane jane@vault24.test Vault24-Customer-Demo1
get jane /accounts | jq '.accounts[] | {account_number, account_type_label, balance, daily_transfer_limit_minor}'
JANE_SAV=$(get jane /accounts | jq -r '.accounts[] | select(.account_type=="savings") | .account_number')

step "Customer Jane tries to open her own account (expect 403)"
send jane POST /accounts '{"customer_id":1,"account_type":"business"}'

step "Teller logs in, looks up Jane's account, posts a 500.00 cash deposit"
login teller teller@vault24.test Vault24-Staff-Demo1
get teller "/staff/accounts/lookup?account_number=$JANE_SAV" | jq
send teller POST /staff/deposits "{\"account_number\":\"$JANE_SAV\",\"account_name\":\"Jane Mwangi\",\"amount_minor\":50000,\"currency\":\"ZMW\",\"narration\":\"Cash deposit at branch\"}"

step "Teller enters the wrong name (expect 422 ACCOUNT_NAME_MISMATCH)"
send teller POST /staff/deposits "{\"account_number\":\"$JANE_SAV\",\"account_name\":\"Jane Mwangii\",\"amount_minor\":50000,\"currency\":\"ZMW\",\"narration\":\"Cash deposit at branch\"}"

step "Jane sends 100.00 to John, then retries with the SAME idempotency key"
JOHN_SAV=$(curl -s -b "$JAR_DIR/teller.jar" "$API/staff/customers?q=john" | jq -r '.customers[0].id' \
  | xargs -I{} curl -s -b "$JAR_DIR/teller.jar" "$API/staff/customers/{}" | jq -r '.accounts[0].account_number')
KEY="demo-$(date +%s)-$RANDOM-idem"
BODY="{\"from_account_number\":\"$JANE_SAV\",\"to_account_number\":\"$JOHN_SAV\",\"amount_minor\":10000,\"currency\":\"ZMW\",\"narration\":\"Lunch money\",\"idempotency_key\":\"$KEY\"}"
send jane POST /transfers "$BODY"
send jane POST /transfers "$BODY"

step "Jane tries to overdraw (expect 422 INSUFFICIENT_FUNDS)"
send jane POST /transfers "{\"from_account_number\":\"$JANE_SAV\",\"to_account_number\":\"$JOHN_SAV\",\"amount_minor\":1950000,\"currency\":\"ZMW\",\"idempotency_key\":\"overdraw-$RANDOM-$RANDOM-x\"}"

step "Admin checks the ledger reconciles and reads the audit trail"
login admin admin@vault24.test Vault24-Admin-Demo1
get admin /admin/reconciliation | jq
get admin "/admin/audit-logs?limit=8" | jq '.audit_logs[] | {action, outcome, actor_user_id, target_type, target_id}'

step "Done"
