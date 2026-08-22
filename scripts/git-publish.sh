#!/usr/bin/env bash
# ============================================================
# Crée et pousse le dépôt MIAD Market en UNE commande.
#   bash scripts/git-publish.sh
#
# Prérequis optionnels :
#   - GitHub CLI (`gh`) pour créer le dépôt distant automatiquement
#   - ou un remote déjà configuré (`git remote add origin …`)
# ============================================================
set -euo pipefail

REPO="miad-backend"
GREEN='\033[0;32m'; DIM='\033[2m'; NC='\033[0m'

say()  { printf "%b\n" "${GREEN}→${NC} $*"; }
note() { printf "%b\n" "${DIM}   $*${NC}"; }

say "Initialisation Git (branche main)…"
git init -b main >/dev/null 2>&1 || true

say "Ajout de tous les fichiers (le .gitignore protège les secrets)…"
git add -A
git commit -m "feat: backend MIAD Market sans WordPress — socle microservices Go

- 7 services Go, une base Postgres chacun
- contrats .proto + grpc-gateway (REST/JSON identique au frontend)
- Kafka, Redis, Caddy, docker-compose pour VPS
- import WooCommerce, system-check agrégé, plan de migration 6 phases" >/dev/null 2>&1 || true

if command -v gh >/dev/null 2>&1; then
  say "Création du dépôt GitHub privé « $REPO » via gh…"
  gh repo create "$REPO" --private --source=. --push --remote=origin 2>/dev/null \
    || { note "dépôt peut-être déjà existant — tentative de push direct…"; git push -u origin main; }
else
  if git remote get-url origin >/dev/null 2>&1; then
    say "Remote « origin » détecté — push…"
    git push -u origin main
  else
    note "Pas de GitHub CLI ni de remote. Deux options :"
    note "  1) installer gh : https://cli.github.com  puis relancer ce script"
    note "  2) créer le dépôt sur github.com, puis :"
    note "     git remote add origin git@github.com:TON_USER/$REPO.git"
    note "     git push -u origin main"
    exit 1
  fi
fi

say "Dépôt poussé avec succès."
note "Étape suivante — brancher le déploiement automatique sur le VPS :"
note "  GitHub → Settings → Secrets → Actions, ajouter :"
note "    VPS_HOST, VPS_USER, VPS_SSH_KEY (clé privée), VPS_PATH"
note "  Chaque push sur main déclenchera .github/workflows/deploy-vps.yml"
