#!/usr/bin/env bash
# ============================================================
# Publie le backend MIAD Market sur le dépôt GitHub :
#   https://github.com/abmcompanysn-dot/backend-miad
#
#   bash scripts/git-publish.sh
#
# Adapté du quickstart GitHub — mais pousse TOUT le projet
# (le `git add README.md` du quickstart ne suffirait pas).
# ============================================================
set -euo pipefail

REMOTE="https://github.com/abmcompanysn-dot/backend-miad.git"
GREEN='\033[0;32m'; DIM='\033[2m'; NC='\033[0m'
say()  { printf "%b\n" "${GREEN}→${NC} $*"; }
note() { printf "%b\n" "${DIM}   $*${NC}"; }

# 1 — git init (le README existe déjà : pas besoin de le créer)
[ -d .git ] || git init

# 2 — tout le projet (le .gitignore protège .env et les binaires)
say "Ajout de tous les fichiers…"
git add -A

# 3 — commit (réutilisable : ne fait rien s'il n'y a pas de changement)
if git diff --cached --quiet; then
  say "Rien de nouveau à commiter."
else
  git commit -m "backend MIAD Market — 8 services Go + console admin

catalog · vendor · order · payment · shipping · auth · notification · admin
contrats .proto + grpc-gateway · Kafka · Redis · k3s + docker-compose
OTP + mot de passe admin + Firebase · Stripe/PayDunya · import WooCommerce"
fi

# 4 — branche main
git branch -M main

# 5 — remote vers le dépôt GitHub
if git remote get-url origin >/dev/null 2>&1; then
  say "Remote « origin » déjà présent — mise à jour…"
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

# 6 — push
say "Push vers $REMOTE…"
git push -u origin main

say "Dépôt publié : https://github.com/abmcompanysn-dot/backend-miad"
note "Étape suivante — secrets GitHub pour le déploiement auto sur VPS :"
note "  Settings → Secrets and variables → Actions → ajouter :"
note "    VPS_HOST · VPS_USER · VPS_SSH_KEY · VPS_PATH"
