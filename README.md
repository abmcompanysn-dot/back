# MIAD Market — backend sans WordPress

Remplacement complet du backend WordPress / WooCommerce / Dokan / WPML par une
architecture microservices en Go, pensée pour un **VPS + Docker Compose**.
Le frontend Next.js n'est **pas réécrit** : il continue d'appeler les mêmes
routes JSON (`app/api/*`), seule l'URL cible change (WooCommerce → passerelle Caddy).

> Document de cadrage associé : sections 1 à 9 du brief « Backend sans WordPress ».
> Ce dépôt en est l'implémentation de démarrage : contrats, socle, 7 services,
> infra, import WooCommerce et outil de health-check.

---

## 1. Contenu du dépôt

```
proto/miad/<svc>/v1/*.proto   Contrats Protobuf — source de vérité (AVANT la logique)
services/<svc>/main.go        7 services Go (REST direct ; grpc-gateway après codegen)
internal/kit/                 Socle commun : config, Postgres, Redis, Kafka, erreurs, santé
cmd/wc-import/                Import ponctuel WooCommerce/Dokan → Postgres (phase 2)
deploy/Caddyfile              Passerelle externe (remplace l'URL WooCommerce)
deploy/init-db.sh             Crée les 7 bases au premier démarrage de Postgres
scripts/system-check.sh       /admin/system-check transverse — agrège les 7 services
docker-compose.yml            Postgres 16 + Redis 7 + Kafka KRaft + 7 services + Caddy
```

## 2. Les 7 services

| Service          | Port  | Base Postgres     | Publie sur Kafka                        | Consomme               |
|------------------|-------|-------------------|------------------------------------------|------------------------|
| catalog-svc      | 8081  | miad_catalog      | `product.created`, `product.updated`     | —                      |
| vendor-svc       | 8082  | miad_vendor       | `vendor.registered`, `vendor.updated`    | —                      |
| order-svc        | 8083  | miad_order        | `order.created`, `order.status_changed`  | —                      |
| payment-svc      | 8084  | miad_payment      | `payment.confirmed`, `payment.failed`    | `order.created`        |
| shipping-svc     | 8085  | miad_shipping     | — (appelé en synchrone au checkout)      | —                      |
| auth-svc         | 8086  | miad_auth         | `customer.registered`                    | —                      |
| notification-svc | 8087  | miad_notification | — (consommateur pur)                     | `order.*`, `payment.*` |

**Règles structurantes** : une base par service (jamais partagée, pas de FK entre
bases) · traduction FR/EN par paire de lignes `trid`+`lang` (modèle WPML conservé,
import sans transformation) · erreurs toujours explicites
(`{"error":{"code","message"}}`) · health-check natif sur chaque service.

## 3. Démarrage sur VPS

Prérequis : VPS 2 vCPU / 4 Go min. (Kafka KRaft single-node ≈ 1 Go), Docker ≥ 24.

```bash
# 1 — Docker sur un VPS vierge
curl -fsSL https://get.docker.com | sh

# 2 — Publier sur le dépôt GitHub
bash scripts/git-publish.sh
# Équivalent manuel :
#   git init && git add -A && git commit -m "premier commit" && git branch -M main
#   git remote add origin https://github.com/abmcompanysn-dot/backend-miad.git
#   git push -u origin main
# Cloner ailleurs : git clone https://github.com/abmcompanysn-dot/backend-miad.git

# 3 — Somme de dépendances Go (génère go.sum pour le build Docker)
go mod tidy

# 4 — Configuration
cp .env.example .env
#    éditer : POSTGRES_PASSWORD, JWT_SECRET, clés Stripe/PayDunya

# 5 — Tout d'un coup
docker compose up -d --build

# 6 — Vérifier — LE point qui manquait sous WordPress
bash scripts/system-check.sh
curl -s localhost:8081/system-check | jq    # détail par dépendance
curl -s "localhost:8081/products?lang=fr&page=1" | jq
```

Le frontend Next.js pointe ensuite `app/api/*` vers ce VPS (Caddy, port 80/443).

## 4. Génération gRPC / grpc-gateway

Les contrats `.proto` sont écrits ; les stubs Go se génèrent ensuite :

```bash
make proto     # protoc + protoc-gen-go + protoc-gen-go-grpc + protoc-gen-grpc-gateway
```

Chaque service remplacera alors ses handlers `net/http` par les serveurs générés —
**même contrat JSON**, zéro changement côté frontend (annotations
`google.api.http` déjà posées sur chaque RPC).

## 5. Migration WooCommerce (plan en 6 phases)

1. Socle infra + catalog-svc en lecture seule (ce dépôt démarre ici)
2. `make import WC_URL=… WC_KEY=… WC_SECRET=…` — lecture `wc/v3/*` + `dokan/v1/stores`,
   réutilise la logique de `lib/woo-server.ts`
3. Bascule lecture (`/products`, `/categories`, `/stores`) — écriture encore sur WP
4. Services d'écriture : order / payment / auth — WP gardé en lecture seule
5. shipping-svc + notification-svc (consommateurs, risque minimal)
6. Extinction WordPress après 2 semaines sans incident + archivage MySQL

## 6. État du socle — ce qui est câblé, ce qui est signalé

Câblé : schémas auto-appliqués · CRUD catalogue (trid/lang, variations, pagination
explicite) · boutiques + délégations inter-services · éclatement de commande par
boutique + reaper `payment_expired` · consommation Kafka (payment, notification) ·
OTP → JWT HS256 + sessions Redis · zones/tarifs de livraison · health-check agrégé.

Signalé explicitement dans le code (jamais de 404/500 muets) :
- `GET /products/{id}/similar` → 501 tant que Vectorize n'est pas rebranché
- Webhooks Stripe/PayDunya : vérification de signature à compléter avec les clés réelles
- Envoi SMS/email réel : fournisseur à configurer (`SMS_PROVIDER_URL`), sinon journalisé
- Tarifs de livraison seedés avec la STRUCTURE de `shipping-utils.ts` —
  **synchroniser les montants exacts avant la bascule**

## 7. Risques de cohérence éventuelle — gérés, pas tus

- **Commande créée sans `payment.confirmed`** : statut `pending_payment` + reaper
  qui passe en `payment_expired` après `PAYMENT_TIMEOUT_MINUTES` (défaut 30).
- **notification-svc en panne** : offsets Kafka, rattrapage au redémarrage.
- **order-svc injoignable à la confirmation** : `payment.confirmed` reste sur Kafka ;
  la mutation de statut est retentée — rien n'est perdu silencieusement.
