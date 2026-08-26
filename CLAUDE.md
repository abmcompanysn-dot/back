# MIAD Market — Mémoire de l'agent Claude

Ce fichier est la mémoire de l'agent Claude pour ce dépôt. Le lire en entier
avant toute action. Pour l'architecture technique détaillée (services,
ports, bases de données, endpoints de compatibilité, prix USD, etc.), voir
[README.md](README.md) — ce fichier-ci se concentre sur **le cycle de
travail concret** : où vit le code, comment relire mes modifications, et
comment elles arrivent en production.

---

## Ce dépôt (important — a changé le 2026-08-26)

Ce dossier (`vpsmiad` sur cette machine) est maintenant le **clone local du
vrai dépôt** `https://github.com/abmcompanysn-dot/back.git` — remplace
l'ancien contenu WordPress/WooCommerce qui vivait ici avant (celui-là est
définitivement supprimé, à l'exception de `.env.local`/`.env.example`
préservés lors de la bascule).

**Ce n'est plus un site WordPress.** C'est un monorepo :
- `services/`, `cmd/`, `proto/`, `internal/` → backend Go (11 microservices,
  k3s sur VPS)
- `frontend/` → Next.js, déployé sur Cloudflare Pages (`miadmarket.ca`)

Tout ancien contenu de mémoire mentionnant WooCommerce, WPML, Dokan,
`scripts/miad.mjs`, ou `woocommerce-snippets/miad-products-api.php`
correspond à l'**ancienne** architecture, avant la migration. Ne plus s'y
fier pour ce dépôt — voir [README.md section 8](README.md#8-migration-woocommerce-plan-en-6-phases)
pour le plan de migration et son état d'avancement.

---

## Le cycle complet : modif → relecture → prod

### 1. Où le code vit

Tout le travail se fait **directement dans ce dossier local**
(`C:\Users\Admin\OneDrive\Pictures\im\Desktop\vpsmiad`), qui est un vrai
clone git avec `origin` pointé sur GitHub. Plus de dossier scratchpad
temporaire à part — ce dossier-ci est la seule copie de travail.

```bash
git remote -v
# origin  https://github.com/abmcompanysn-dot/back.git
```

### 2. Comment je (l'agent) modifie le code

J'édite les fichiers directement dans ce dossier avec les outils Read/Edit/
Write — exactement comme n'importe quel éditeur. Rien n'est appliqué en
cachette : chaque modification est un vrai changement de fichier sur disque,
visible immédiatement dans VS Code (l'éditeur détecte le changement externe
et le montre, y compris en diff si le fichier était déjà ouvert).

### 3. Comment vous relisez mes modifications AVANT qu'elles partent

Avant tout commit, vous pouvez à tout moment :

```bash
git status              # quels fichiers ont changé
git diff                # le détail ligne par ligne (non indexé)
git diff --staged       # après un `git add`, avant le commit
```

Ou directement dans VS Code : l'onglet **Source Control** (icône branche
dans la barre latérale) montre la même chose visuellement, fichier par
fichier, avec diff coloré. Rien ne part vers GitHub tant qu'il n'y a pas eu
`git commit` **et** `git push` — les deux sont des actions explicites,
jamais automatiques de mon côté sauf si vous me le demandez.

### 4. Commit + push

Une fois que vous validez les changements :

```bash
git add -A
git commit -m "description du changement"
git push origin main
```

(Je fais normalement ça à votre demande, jamais sans confirmation implicite
— conformément aux règles de l'agent sur les actions visibles/partagées.)

### 5. Ce qui se passe automatiquement après le push

**Backend (Go, VPS k3s)** — dès que `main` est poussé sur GitHub, le
workflow `.github/workflows/deploy-vps.yml` se déclenche automatiquement et
se connecte en SSH au VPS pour lancer `vps-bootstrap.sh`, qui **rebuild et
redéploie les 11 services**. C'est un déploiement complet, pas ciblé.

> Pour un changement isolé dans **un seul service** (ex. juste
> `catalog-svc`), préférer se connecter au VPS et lancer
> `bash scripts/deploy-service.sh <service>` manuellement plutôt que de
> compter sur le workflow automatique — ça évite de reconstruire/redémarrer
> les 10 autres services pour rien. Voir
> [README.md section 9](README.md#9-mettre-à-jour-le-dépôt-git-flow).

**Frontend (Next.js, Cloudflare Pages)** — Cloudflare Pages est branché
directement sur ce même repo GitHub (`main`) et rebuild/déploie
automatiquement à chaque push, sans action manuelle. Le pipeline réel est
`next build` → `npx @cloudflare/next-on-pages` (conversion vers
`.vercel/output/static`) → déploiement — voir `frontend/wrangler.jsonc` et
`frontend/package.json` (`pages:build`/`deploy`). Vérifier l'état d'un
déploiement :

```bash
cd frontend && npx wrangler pages deployment list --project-name=miad-back
```

### 6. Vérifier que tout est bien synchronisé

```bash
git log origin/main --oneline -5   # confirme ce qui est réellement sur GitHub
git status                          # doit être "up to date with origin/main", rien en attente
```

Si jamais ce dossier local prend du retard (modifs faites ailleurs, par une
session parallèle par exemple) :

```bash
git pull origin main
```

---

## Résumé visuel du cycle

```
 Vous demandez une modif
          │
          ▼
 J'édite les fichiers ici (vpsmiad = clone local de "back")
          │
          ▼
 Vous relisez : git status / git diff / onglet Source Control VS Code
          │
          ▼
 git add -A · git commit · git push origin main
          │
          ├──► GitHub Actions (deploy-vps.yml) ──► VPS k3s ──► backend Go (11 services)
          │
          └──► Cloudflare Pages (auto-build sur push) ──► frontend Next.js ──► miadmarket.ca
```

---

## Conventions de travail établies

- Toujours vérifier `git status`/`git diff` avant tout commit, pour éviter
  d'écraser un travail en cours d'une session parallèle sur ce même dépôt.
- Backend : `go build ./...` (et `go vet ./...`) avant tout commit touchant
  `services/`, `cmd/`, `internal/`, ou `proto/`.
- Frontend : `npx tsc --noEmit` puis `npm run build` avant tout commit
  touchant `frontend/`.
- Déploiement backend ciblé (un seul service) : préférer
  `scripts/deploy-service.sh <service>` en SSH sur le VPS plutôt que de
  laisser le workflow automatique rebuild les 11 services à chaque petit
  changement.
- Jamais de commit/push sans confirmation implicite ou explicite de votre
  part — je vous préviens avant toute action visible sur GitHub/prod.

---

*Créé le 26 août 2026, au moment de la bascule de ce dossier vers le vrai
dépôt `back` (auparavant contenu WordPress obsolète).*
