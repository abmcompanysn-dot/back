#!/usr/bin/env bash
# ============================================================
# Redéploie UN SEUL service, sans toucher aux 10 autres.
# À lancer directement SUR LE VPS (dans /opt/miad-backend), après un
# `git pull` qui a ramené le changement.
#
# Usage :
#   bash scripts/deploy-service.sh catalog-svc
#   bash scripts/deploy-service.sh admin-svc     # rebuild aussi webui/ automatiquement (Dockerfile s'en charge)
#
# Ce que ça fait, dans l'ordre : build l'image Docker de ce service
# uniquement → l'importe dans containerd (k3s) → redémarre son
# Deployment k8s → attend que le rollout soit terminé → vérifie son
# /system-check. Les 10 autres Deployments ne sont ni rebuild ni
# redémarrés — un changement dans catalog-svc ne fait jamais tourner
# order-svc, par exemple.
# ============================================================
set -euo pipefail

SERVICES=(catalog-svc vendor-svc order-svc payment-svc shipping-svc auth-svc notification-svc email-svc fulfillment-svc loyalty-svc admin-svc)

SVC="${1:-}"
if [ -z "$SVC" ]; then
  echo "Usage : bash scripts/deploy-service.sh <service>"
  echo "Services valides : ${SERVICES[*]}"
  exit 1
fi
valid=0
for s in "${SERVICES[@]}"; do
  [ "$s" = "$SVC" ] && valid=1
done
if [ "$valid" -ne 1 ]; then
  echo "❌ Service inconnu : $SVC"
  echo "Services valides : ${SERVICES[*]}"
  exit 1
fi

say() { printf "\n\033[0;32m==> %s\033[0m\n" "$*"; }

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl() { k3s kubectl "$@"; }

say "Build de l'image $SVC…"
docker build --build-arg SERVICE="$SVC" -t "miad/$SVC:latest" .

say "Import dans containerd (k3s)…"
docker save "miad/$SVC:latest" | k3s ctr --namespace k8s.io images import -

# L'image Docker + son cache de build ne servent plus une fois importés
# dans k3s : sans ce ménage, /var/lib/containerd (celui du démon docker,
# distinct de k3s) gonflait de plusieurs Go à CHAQUE déploiement et a
# saturé le disque du VPS (453 Go / 581 le 2026-09-01, nettoyé le jour
# même). On garde le cache récent (< 24 h) pour ne pas repartir de zéro
# si on redéploie plusieurs fois de suite.
say "Nettoyage du cache de build Docker…"
docker image rm "miad/$SVC:latest" >/dev/null 2>&1 || true
docker builder prune -f --filter until=24h >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

say "Redémarrage du Deployment $SVC (les autres services ne sont pas touchés)…"
kubectl -n miad rollout restart "deployment/$SVC"
kubectl -n miad rollout status "deployment/$SVC" --timeout=180s

say "Health-check de $SVC :"
PORT=$(kubectl -n miad get deploy "$SVC" -o jsonpath='{.spec.template.spec.containers[0].ports[0].containerPort}')
# "deploy/$SVC" (pas un nom de pod capturé au préalable) : kubectl exec
# résout le pod courant dynamiquement, évite la fenêtre de course où
# l'ancien pod vient de disparaître et le nouveau nom n'a pas encore
# été lu (observé lors du tout premier test de ce script).
kubectl -n miad exec "deploy/$SVC" -- wget -qO- --timeout=5 "http://localhost:$PORT/system-check" || {
  echo "⚠️  /system-check n'a pas répondu — vérifier les logs : kubectl -n miad logs deploy/$SVC"
  exit 1
}
echo
say "$SVC redéployé et sain."
