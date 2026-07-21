#!/usr/bin/env bash
set -euo pipefail
[ -f .dev.vars ] && set -a && . .dev.vars && set +a
: "${TG_TOKEN:?set TG_TOKEN in .dev.vars or env}"
: "${TG_SECRET:?set TG_SECRET in .dev.vars or env}"
: "${WORKER_URL:?pass WORKER_URL=https://...workers.dev}"

curl -sS -F "url=$WORKER_URL" -F "secret_token=$TG_SECRET" \
  "https://api.telegram.org/bot$TG_TOKEN/setWebhook"
echo

curl -sS "https://api.telegram.org/bot$TG_TOKEN/setMyCommands" \
  -H 'Content-Type: application/json' \
  -d '{"commands":[
    {"command":"cash","description":"balance and monthly overview"},
    {"command":"chart","description":"cash and spending trends"},
    {"command":"last","description":"recent entries"},
    {"command":"edit","description":"update an entry"},
    {"command":"add","description":"manual expense"},
    {"command":"income","description":"log income"},
    {"command":"ask","description":"search and analyze finances"},
    {"command":"timezone","description":"set local timezone"},
    {"command":"undo","description":"delete last entry"},
    {"command":"help","description":"show usage"}
  ]}'
echo
