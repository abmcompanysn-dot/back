# MIAD Market — backend sans WordPress

Remplacement complet du backend WordPress / WooCommerce / Dokan / WPML par une
architecture microservices en Go, déployée sur un **VPS en Kubernetes (k3s)**.
Le frontend Next.js n'est **pas réécrit** : il continue d'appeler les mêmes
routes JSON (`app/api/*`), seule l'URL cible change (WooCommerce → passerelle Caddy).

> Document de cadrage : sections 1 à 9 du brief « Backend sans WordPress ».
> Ce dépôt en est l'implémentation : contrats, socle, **8 services**, infra,
> console d'administration, import WooCommerce et outil de health-check.

---

## 1. Contenu du dépôt

```
proto/miad/<svc>/v1/*.proto     Contrats Protobuf — source de vérité (AVANT la logique)
services/<svc>/main.go          8 services Go (REST direct ; grpc-gateway après codegen)
services/admin-svc/dashboard.html  Console d'administration embarquée (vanilla JS)
internal/kit/                   Socle commun : config, Postgres, Redis, Kafka, erreurs, santé
cmd/wc-import/                  Import ponctuel WooCommerce/Dokan → Postgres (phase 2)
deploy/Caddyfile                Passerelle externe (remplace l'URL WooCommerce)
deploy/init-db.sh               Crée les 7 bases au premier démarrage de Postgres
deploy/k8s/*.yaml               Manifests Kubernetes (k3s) — mode principal
docker-compose.yml              Repli local : Postgres + Redis + Kafka + 8 services + Caddy
scripts/vps-bootstrap.sh        Déploiement VPS en UNE commande (k3s)
scripts/system-check.sh         Health-check transverse — agrège les 8 services
scripts/system-check-k8s.sh     Équivalent Kubernetes (sonde chaque pod)
scripts/git-publish.sh          Publie le dépôt sur GitHub en une commande
```

## 2. Les 8 services

| Service          | Port  | Base Postgres     | Publie sur Kafka                        | Consomme               |
|------------------|-------|-------------------|------------------------------------------|------------------------|
| catalog-svc      | 8081  | miad_catalog      | `product.created`, `product.updated`     | —                      |
| vendor-svc       | 8082  | miad_vendor       | `vendor.registered`, `vendor.updated`    | —                      |
| order-svc        | 8083  | miad_order        | `order.created`, `order.status_changed`  | —                      |
| payment-svc      | 8084  | miad_payment      | `payment.confirmed`, `payment.failed`    | `order.created`        |
| shipping-svc     | 8085  | miad_shipping     | — (appelé en synchrone au checkout)      | —                      |
| auth-svc         | 8086  | miad_auth         | `customer.registered`                    | —                      |
| notification-svc | 8087  | miad_notification | — (consommateur pur)                     | `order.*`, `payment.*` |
| admin-svc        | 8088  | — (agrégateur)    | —                                        | — (lit via HTTP interne) |

**Règles structurantes** : une base par service (jamais partagée, pas de FK entre
bases) · traduction FR/EN par paire de lignes `trid`+`lang` (modèle WPML conservé,
import sans transformation) · erreurs toujours explicites
(`{"error":{"code","message"}}`) · health-check natif sur chaque service.

## 3. Console d'administration

`admin-svc` sert une interface complète sur `GET /admin` — embarquée dans le
binaire Go (`embed`), en vanilla JS, **zéro build frontend**. Elle interroge
l'API interne `/admin/api/*` qui exige un **JWT `role=admin`** sur chaque requête.

**Vues** : Vue d'ensemble (compteurs + CA + état des services) · Commandes ·
Produits (FR/EN) · Boutiques · Clients · Paiements (Stripe/PayDunya) · Livraison
(devis interactif) · Système (health-check par dépendance).

**Authentification** (auth-svc) :
- **Acheteur** — `POST /auth/otp/send` → `/auth/otp/verify` (code 6 chiffres en
  Redis, TTL borné, jamais renvoyé dans la réponse)
- **Admin** — `POST /auth/admin/login` (email + mot de passe, sel + 10 000 itérations
  SHA-256, seedé depuis `ADMIN_EMAIL`/`ADMIN_PASSWORD`)
- **Admin via Firebase** — `POST /auth/firebase` (jeton Google vérifié auprès de
  `oauth2.googleapis.com`, puis email croisé avec la table `admins`)

**Paiements réels** : Stripe Checkout Session (`api.stripe.com`) et PayDunya
invoices (`app.paydunya.com`, Wave / Orange Money en XOF), signatures de webhook
vérifiées, confirmation propagée via Kafka (`payment.confirmed` → commande `paid`).

## 4. Déploiement sur VPS (Kubernetes — k3s)

Choix acté : **k3s** (Kubernetes en un binaire, sans plan de contrôle lourd).

```bash
# Sur le VPS, UNE seule commande fait tout :
# installe k3s → namespace + Secret depuis .env → manifests →
# build des 8 images → import containerd → rollouts → health-check
git clone https://github.com/abmcompanysn-dot/backend-miad.git /opt/miad-backend
bash /opt/miad-backend/scripts/vps-bootstrap.sh

# Vérifier à tout moment
bash /opt/miad-backend/scripts/system-check-k8s.sh
kubectl -n miad get pods
```

Scalabilité : `kubectl -n miad scale deploy/catalog-svc --replicas=3`
(services stateless). `docker-compose.yml` reste disponible en repli local avec
exactement le même `.env` — rien n'est verrouillé.

**Variables à définir dans `.env` avant le premier boot** :
`POSTGRES_PASSWORD`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYDUNYA_API_KEY_*`,
`FIREBASE_WEB_CLIENT_ID` (optionnel).

Le frontend Next.js pointe ensuite `app/api/*` vers ce VPS (Caddy, port 80/443).

## 5. Générer les stubs gRPC / grpc-gateway

Les contrats `.proto` sont écrits ; les stubs Go se génèrent ensuite :

```bash
make proto     # protoc + protoc-gen-go + protoc-gen-go-grpc + protoc-gen-grpc-gateway
```

Chaque service remplacera alors ses handlers `net/http` par les serveurs générés —
**même contrat JSON**, zéro changement côté frontend (annotations
`google.api.http` déjà posées sur chaque RPC).

## 6. Migration WooCommerce (plan en 6 phases)

1. Socle infra + catalog-svc en lecture seule (ce dépôt démarre ici)
2. `make import WC_URL=… WC_KEY=… WC_SECRET=…` — lecture `wc/v3/*` + `dokan/v1/stores`,
   réutilise la logique de `lib/woo-server.ts`
3. Bascule lecture (`/products`, `/categories`, `/stores`) — écriture encore sur WP
4. Services d'écriture : order / payment / auth — WP gardé en lecture seule
5. shipping-svc + notification-svc (consommateurs, risque minimal)
6. Extinction WordPress après 2 semaines sans incident + archivage MySQL

## 7. Mettre à jour le dépôt (git flow)

Le code vit dans le sandbox ; pour que **`origin/main` contienne toutes les
modifications**, pousse depuis la machine qui a le code :

```bash
# Première fois (ou si le dossier n'est pas encore un dépôt git) :
bash scripts/git-publish.sh
# = git init · git add -A · commit · remote add · push -u origin main

# Ensuite, après chaque lot de modifications :
git add -A
git commit -m "feat: console admin, Firebase, paiements Stripe/PayDunya"
git push origin main
```

Dès que `main` est poussé, le workflow `.github/workflows/deploy-vps.yml`
redéploie automatiquement sur le VPS (si les secrets `VPS_HOST`, `VPS_USER`,
`VPS_SSH_KEY`, `VPS_PATH` sont configurés). Sinon, sur le VPS :
`cd /opt/miad-backend && git pull && bash scripts/vps-bootstrap.sh`.

Vérifier que tout est bien sur la branche :
```bash
git log origin/main --oneline -5     # doit montrer tes derniers commits
```

## 8. État du socle — câblé vs signalé

Câblé : schémas auto-appliqués · CRUD catalogue (trid/lang, variations, pagination
explicite) · boutiques + délégations inter-services · éclatement de commande par
boutique + reaper `payment_expired` · consommation Kafka (payment, notification) ·
OTP + mot de passe admin + Firebase → JWT HS256 + sessions Redis ·
paiements Stripe/PayDunya avec signatures · zones/tarifs de livraison ·
console admin complète · health-check agrégé.

Signalé explicitement dans le code (jamais de 404/500 muets) :
- `GET /products/{id}/similar` → 501 tant que Vectorize n'est pas rebranché
- Envoi SMS/email réel : fournisseur à configurer (`SMS_PROVIDER_URL`), sinon journalisé
- Tarifs de livraison seedés avec la STRUCTURE de `shipping-utils.ts` —
  **synchroniser les montants exacts avant la bascule**

## 9. Cohérence éventuelle — gérée, pas tue

- **Commande créée sans `payment.confirmed`** : statut `pending_payment` + reaper
  qui passe en `payment_expired` après `PAYMENT_TIMEOUT_MINUTES` (défaut 30).
- **notification-svc en panne** : offsets Kafka, rattrapage au redémarrage.
- **order-svc injoignable à la confirmation** : `payment.confirmed` reste sur Kafka ;
  la mutation de statut est retentée — rien n'est perdu silencieusement.
