#!/usr/bin/env bash
# ============================================================
# /admin/system-check transverse — le point qui manquait sous
# WordPress (incident du 29 juil. 2026). Interroge le
# /system-check de chaque service et agrège le résultat.
# ============================================================
set -u

HOST="${GATEWAY_HOST:-localhost}"
declare -A SVC=(
  [catalog-svc]=8081
  [vendor-svc]=8082
  [order-svc]=8083
  [payment-svc]=8084
  [shipping-svc]=8085
  [auth-svc]=8086
  [notification-svc]=8087
  [admin-svc]=8088
  [email-svc]=8089
)

overall=0
echo "── MIAD Market · system-check ─────────────────────────────"
for name in "${!SVC[@]}"; do
  port="${SVC[$name]}"
  body=$(curl -sf --max-time 3 "http://${HOST}:${port}/system-check" 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$body" ]; then
    status=$(printf '%s' "$body" | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
    echo "  ✔ $name (:$port) — $status"
    [ "$status" != "ok" ] && overall=1
  else
    echo "  ✘ $name (:$port) — injoignable"
    overall=1
  fi
done
echo "───────────────────────────────────────────────────────────"
[ $overall -eq 0 ] && echo "TOUS LES SERVICES SONT OK" || echo "AU MOINS UN SERVICE EST EN DÉFAUT"
exit $overall
