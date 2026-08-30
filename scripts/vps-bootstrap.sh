#!/usr/bin/env bash
# ============================================================
# Bootstrap Kubernetes (k3s) sur le VPS MIAD — UNE seule commande.
#
# Depuis le VPS :
#   git clone https://github.com/abmcompanysn-dot/back.git /opt/miad-backend
#   bash /opt/miad-backend/scripts/vps-bootstrap.sh
#
# Fait : installe k3s → crée namespace + Secret depuis .env →
# applique les manifests → build les 10 images → les importe dans
# containerd → attend les rollouts → vérifie tout explicitement.
# ============================================================
set -euo pipefail

REPO=https://github.com/abmcompanysn-dot/back.git
APP=/opt/miad-backend
SERVICES=(catalog-svc vendor-svc order-svc payment-svc shipping-svc auth-svc notification-svc email-svc fulfillment-svc loyalty-svc admin-svc)

say() { printf "\n\033[0;32m==> %s\033[0m\n" "$*"; }

# ---------- 1. k3s (Kubernetes allégé — parfait VPS single-node) ----------
say "Installation de k3s (si absent)…"
if ! command -v k3s >/dev/null 2>&1; then
  curl -sfL https://get.k3s.io | sh -
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl() { k3s kubectl "$@"; }

# ---------- 2. Code source — GitHub OU dossier local ----------
say "Récupération du code source…"
if [ -f "$APP/Makefile" ] && [ -d "$APP/services" ]; then
  say "Sources déjà présentes dans $APP — mode local (pas de clone)."
else
  [ -d "$APP" ] && rm -rf "$APP"
  git clone "$REPO" "$APP" || {
    echo "❌ Clone impossible — le dépôt GitHub est probablement vide."
    echo "   Deux solutions :"
    echo "   1) pousser le code sur GitHub depuis ton PC (voir console, section Maintenant)"
    echo "   2) déposer les sources dans $APP (ZIP exporté du sandbox + scp) puis relancer"
    exit 1
  }
fi
cd "$APP"
[ -d .git ] && { git pull --ff-only || true; }

# ---------- 3. .env — jamais dans le dépôt ----------
if [ ! -f .env ]; then
  cp .env.example .env
  echo "!! $APP/.env créé avec des valeurs par défaut."
  echo "!! Édite-le (nano .env) : POSTGRES_PASSWORD, JWT_SECRET, clés Stripe/PayDunya,"
  echo "!! puis relance ce script. Rien n'est déployé tant que ce n'est pas fait."
  exit 1
fi

# ---------- 4. Namespace + Secret ----------
say "Namespace + Secret (depuis .env)…"
kubectl apply -f deploy/k8s/00-base.yaml
kubectl -n miad create secret generic miad-secrets \
  --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -

# ---------- 5. Manifests (infra, services, passerelle) ----------
say "Application des manifests Kubernetes…"
kubectl apply -f deploy/k8s/10-infra.yaml
kubectl apply -f deploy/k8s/20-services.yaml
kubectl apply -f deploy/k8s/25-admin.yaml
# Le Caddyfile vient du dépôt : source unique avec docker-compose.
# k8s-dashboard-login.html ajouté le 2026-08-30 (page de connexion devant
# k8s.miadmarket.ca — voir le bloc k8s.miadmarket.ca du Caddyfile).
kubectl -n miad create configmap caddyfile \
  --from-file=Caddyfile=deploy/Caddyfile \
  --from-file=k8s-dashboard-login.html=deploy/k8s-dashboard-login.html \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f deploy/k8s/30-gateway.yaml

# ---------- 6. Build des images + import containerd (pas de registry) ----------
say "Build des 10 images Go…"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
for s in "${SERVICES[@]}"; do
  docker build --build-arg SERVICE="$s" -t "miad/$s:latest" .
  docker save "miad/$s:latest" | k3s ctr --namespace k8s.io images import -
done

# ---------- 7. Attente + vérification EXPLICITE ----------
say "Attente des rollouts…"
for s in "${SERVICES[@]}"; do
  kubectl -n miad rollout status "deploy/$s" --timeout=180s
done

say "État du cluster :"
kubectl -n miad get pods -o wide

say "Health-check de chaque service :"
bash scripts/system-check-k8s.sh

say "Terminé. La passerelle répond sur les ports 80/443 du VPS."
echo "    Test rapide : curl -s http://localhost/catalog/healthz"
