#!/usr/bin/env bash
# ============================================================
# Équivalent Kubernetes de scripts/system-check.sh :
# interroge /system-check DANS chaque pod (kubectl exec + wget,
# présent dans l'image Alpine des services).
# ============================================================
set -u
kubectl() { k3s kubectl "$@"; }

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
echo "── MIAD Market · system-check (cluster k3s) ───────────────"
for name in "${!SVC[@]}"; do
  port="${SVC[$name]}"
  body=$(kubectl -n miad exec "deploy/$name" -- \
    wget -qO- -T 3 "http://localhost:$port/system-check" 2>/dev/null) || body=""
  if [ -n "$body" ]; then
    status=$(printf '%s' "$body" | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
    echo "  ✔ $name (pod) — $status"
    [ "$status" != "ok" ] && overall=1
  else
    echo "  ✘ $name — pod injoignable"
    overall=1
  fi
done
echo "───────────────────────────────────────────────────────────"
[ $overall -eq 0 ] && echo "TOUS LES PODS SONT OK" || echo "AU MOINS UN POD EST EN DÉFAUT"
exit $overall
