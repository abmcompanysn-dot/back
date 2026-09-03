# MIAD Market — backend sans WordPress

Remplacement complet du backend WordPress / WooCommerce / Dokan / WPML par une
architecture microservices en Go, déployée sur un **VPS en Kubernetes (k3s)**.

Ce dépôt est un **monorepo** : le backend Go (`services/`, `cmd/`, `proto/`)
et le frontend Next.js (`frontend/`) vivent côte à côte. Le frontend reste
hébergé sur **Cloudflare Pages** (aucun changement d'hébergement) — sa
présence ici sert uniquement à faire évoluer les deux ensemble et à garder
une seule source de vérité sur l'état de compatibilité entre eux.

> Document de cadrage : sections 1 à 9 du brief « Backend sans WordPress ».
> Ce dépôt en est l'implémentation : contrats, socle, **10 services**, infra,
> console d'administration, import WooCommerce, outil de health-check, et une
> première couche de compatibilité avec le frontend existant.

---

## 1. Contenu du dépôt

```
proto/miad/<svc>/v1/*.proto     Contrats Protobuf — source de vérité (AVANT la logique)
services/<svc>/main.go          10 services Go (REST direct ; grpc-gateway après codegen)
services/admin-svc/dashboard.html  Console d'administration embarquée (vanilla JS)
internal/kit/                   Socle commun : config, Postgres, Redis, Kafka, erreurs, santé
cmd/wc-import/                  Import ponctuel WooCommerce/Dokan → Postgres (phase 2)
frontend/                       Copie du frontend Next.js (v0-miad-front-end) — déployé sur Cloudflare Pages, pas sur ce VPS
deploy/Caddyfile                Passerelle externe (remplace l'URL WooCommerce)
deploy/init-db.sh               Crée les 9 bases au premier démarrage de Postgres
deploy/k8s/*.yaml               Manifests Kubernetes (k3s) — mode principal
docker-compose.yml              Repli local : Postgres + Redis + Kafka + 10 services + Caddy
scripts/vps-bootstrap.sh        Déploiement VPS en UNE commande (k3s)
scripts/system-check.sh         Health-check transverse — agrège les 10 services
scripts/system-check-k8s.sh     Équivalent Kubernetes (sonde chaque pod)
scripts/git-publish.sh          Publie le dépôt sur GitHub en une commande
```

## 2. Les 10 services

| Service          | Port  | Base Postgres     | Publie sur Kafka                          | Consomme                    |
|------------------|-------|-------------------|--------------------------------------------|------------------------------|
| catalog-svc      | 8081  | miad_catalog      | `product.created`, `product.updated`       | —                             |
| vendor-svc       | 8082  | miad_vendor       | `vendor.registered`, `vendor.updated`      | —                             |
| order-svc        | 8083  | miad_order        | `order.created`, `order.status_changed`    | —                             |
| payment-svc      | 8084  | miad_payment      | `payment.confirmed`, `payment.failed`      | `order.created`               |
| shipping-svc     | 8085  | miad_shipping     | — (appelé en synchrone au checkout)        | —                             |
| auth-svc         | 8086  | miad_auth         | `customer.registered`                      | —                             |
| notification-svc | 8087  | miad_notification | — (consommateur pur)                       | `order.*`, `payment.*`        |
| admin-svc        | 8088  | — (agrégateur)    | —                                           | — (lit via HTTP interne)      |
| email-svc        | 8089  | miad_email        | —                                           | `order.*`, `payment.*`, `customer.registered` |
| fulfillment-svc  | 8090  | miad_fulfillment  | `shipment.created`, `shipment.status_changed` | `order.status_changed`     |
| loyalty-svc      | 8091  | miad_loyalty      | `coins.awarded`, `message.created`         | —                             |

**Règles structurantes** : une base par service (jamais partagée, pas de FK entre
bases) · traduction FR/EN par paire de lignes `trid`+`lang` (modèle WPML conservé,
import sans transformation) · erreurs toujours explicites
(`{"error":{"code","message"}}`) · health-check natif sur chaque service.

## 3. Prix : USD partout, jamais FCFA en stockage

**Tous les montants en base sont en USD réel** (`price_usd`, `total_usd`,
`amount_usd`, etc. — `DOUBLE PRECISION`), exactement comme le vrai catalogue
WooCommerce source (`_price` n'est pas en FCFA, confirmé dans le CLAUDE.md du
frontend). Aucune conversion n'a lieu à l'écriture ni à la lecture — la
conversion en devise d'affichage (FCFA, CAD, …) reste une responsabilité du
frontend, comme aujourd'hui.

Deux endroits font exception, et convertissent explicitement au moment de
l'appel externe (jamais en stockage) :
- **Stripe** (`payment-svc`) reçoit un montant en **cents USD** (`total_usd × 100`),
  puisque l'USD a 2 décimales — contrairement au FCFA (0 décimale) qui
  aurait été envoyé tel quel.
- **PayDunya** (`payment-svc`) facture en XOF (devise locale UEMOA de ses
  moyens de paiement mobile Wave/Orange Money) — converti via le taux lu sur
  `shipping-svc` (`GET /exchange-rates`, source UNIQUE des taux de change,
  remplace les 3 constantes dupliquées du PHP historique).
- **PawaPay** (`payment-svc`, `pawapay.go`) facture dans la **devise locale
  du pays choisi par le client** (XOF, XAF, GHS, KES, NGN, TZS, UGX, RWF,
  ZMW, MWK, MZN, CDF, SLE — ~19 pays Afrique) — converti via
  `shipping-svc/exchange-rates` en priorité, table figée
  `pawapayFallbackRates` (datée, `pawapay.go`) en secours. Alternative à
  PayDunya : un seul des deux actif à la fois, bascule par toggle admin
  (Configuration → Paiements → « Fournisseur Mobile Money actif », écrit
  `pawapay_enabled` / `paydunya_enabled`). Désactivé par défaut, démarre en
  `sandbox` (`pawapay_environment`). Flux = **Payment Page hébergée**
  (`POST /v2/paymentpage` → `redirectUrl`, le client choisit opérateur +
  numéro chez PawaPay), retour sur `/order-received?provider=pawapay`,
  confirmation par webhook serveur-à-serveur
  (`POST /payments/webhook/pawapay`, une URL pour deposits/payouts/refunds,
  re-vérification GET du statut authoritatif — jamais le corps du callback).
  Payouts (versement vendeur) et refunds implémentés côté API
  (`POST /payout-requests/{id}/pawapay`, `POST /refunds`).

**Valeurs à confirmer avec le fondateur avant bascule prod** (documentées en
commentaire à chaque endroit concerné dans le code) :
- `shipping-svc` : le tarif « par article supplémentaire » en livraison zone
  et le tarif « local strict » (même pays/voisin immédiat) sont des
  estimations — `lib/shipping-utils.ts` du frontend ne les distingue pas
  explicitement.
- `shipping-svc` : les 5 tranches `domestic_tiers` (livraison Sénégal par
  distance, Haversine) sont un système entièrement nouveau, sans équivalent
  frontend à resynchroniser — valeurs de départ arbitraires.

## 4. Compatibilité avec le frontend existant

Le frontend (`frontend/`) appelle aujourd'hui WooCommerce/Dokan directement
(`app/api/*/route.ts`). Trois domaines ont une couche de compatibilité déjà
posée côté backend, pour que le jour où ces routes pointeront vers ce VPS au
lieu de WooCommerce, le frontend n'ait pas (ou peu) à changer :

- **Catalogue & boutiques** — `catalog-svc` (`/products`, `/products/{id}`,
  `/categories`) et `vendor-svc` (`/stores`) renvoient la forme de champs
  WooCommerce/Dokan (`price` en string décimale, `images[].src`,
  `regular_price`/`sale_price`, `store_name`/`gravatar`/`address.country`,
  etc.) **en plus** de leur forme native — les deux coexistent dans la même
  réponse JSON.
- **Panier / commande** — `order-svc` continue d'éclater une commande en
  sous-commandes par vendeur en interne (modèle marketplace multi-vendeur),
  mais expose `GET /orders/parent/{parent_id}` qui recompose une vue
  « commande unique » (`id`, `number`, `status` agrégé, `total`, `line_items[]`)
  pour l'affichage post-checkout / historique client, sans changer le modèle
  de données interne.
- **Paiement carte** — `payment-svc` utilise un **PaymentIntent Stripe**
  (pas une Checkout Session hébergée) : `POST /payments/init` est
  **synchrone** et renvoie `client_secret` immédiatement, pour que le
  frontend affiche son propre formulaire de carte (Stripe Elements) sans
  jamais rediriger l'acheteur hors du site. PayDunya reste en redirection
  (`redirect_url`), cohérent avec son fonctionnement Wave/Orange Money.
- **Connexion Google** — `POST /auth/firebase` est ouvert à n'importe quel
  acheteur (crée un compte `customers` à la volée si l'email Firebase est
  inconnu, même mécanisme que l'OTP). L'ancien comportement réservé aux
  admins existe toujours, sur une route distincte :
  `POST /auth/admin/firebase`.

**Ce qui reste à faire côté frontend** (hors périmètre de ce dépôt Go) pour
que ces 4 corrections servent réellement : pointer `app/api/orders/route.ts`
vers `GET /orders/parent/{id}` pour l'affichage post-checkout, remplacer le
flux de paiement carte actuel par `client_secret` + `Stripe.js`
`confirmCardPayment()`, et vérifier que le bouton de connexion Google appelle
bien `/auth/firebase` (pas une route admin).

## 5. Console d'administration

`admin-svc` sert une interface React (Vite, `services/admin-svc/webui/`,
**voir aussi** `services/admin-svc/webui/README.md` pour le détail du
projet) sous `GET /admin/` — **build requis avant `go build`**, le résultat
(`webui/dist/`) n'est pas committé (comme `node_modules/`) et est embarqué
dans le binaire Go via `go:embed`. Sans ce build, `go build ./services/admin-svc`
échoue explicitement (`pattern webui/dist: no matching files found`), jamais
silencieusement. `Dockerfile` gère ce build automatiquement (stage Node
dédié) — en dev local uniquement :

```bash
cd services/admin-svc/webui && npm install && npm run build
```

L'interface interroge l'API interne `/admin/api/*` qui exige un **JWT
`role=admin`** sur chaque requête.

**Vues** : Vue d'ensemble (compteurs + CA + état des services) · Commandes ·
Produits (FR/EN) · Boutiques · Clients · Paiements (Stripe/PayDunya) · Livraison
(devis interactif) · Marketing (coupons/fidélité, tracking publicitaire — en
construction) · **Sécurité** (activation/désactivation de la 2FA) ·
Système (health-check par dépendance).

**Authentification** (auth-svc) :
- **Acheteur** — `POST /auth/otp/send` → `/auth/otp/verify` (code 6 chiffres en
  Redis, TTL borné, jamais renvoyé dans la réponse) ou `POST /auth/firebase`
  (connexion Google, voir section 4)
- **Admin** — `POST /auth/admin/login` (email + mot de passe, sel + 10 000 itérations
  SHA-256, seedé depuis `ADMIN_EMAIL`/`ADMIN_PASSWORD`). Flux en **deux temps**
  si la 2FA est active sur le compte : sans `totp_code`, la réponse est
  `{"totp_required":true}` (pas une erreur) plutôt qu'un JWT — le dashboard
  affiche alors un second champ pour le code.
- **2FA (TOTP, RFC 6238)** — `POST /auth/admin/2fa/setup` (génère un secret,
  exige un JWT admin déjà valide), `POST /auth/admin/2fa/verify` (confirme
  avec un premier code — la 2FA ne s'active qu'après cette preuve, jamais
  automatiquement, pour éviter qu'un admin se verrouille lui-même hors de son
  compte avec un secret mal scanné), `POST /auth/admin/2fa/disable` (exige un
  code TOTP valide, pas seulement le JWT — un JWT volé seul ne doit jamais
  suffire à désactiver la 2FA). Implémentation en Go pur (pas de dépendance
  externe), validée contre les vecteurs de test officiels RFC 6238.
- **Admin via Firebase** — `POST /auth/admin/firebase` (jeton Google vérifié
  auprès de `oauth2.googleapis.com`, puis email croisé avec la table `admins`)

**Paiements réels** : Stripe PaymentIntent + Elements embarqué (`api.stripe.com`,
voir section 4) et PayDunya invoices (`app.paydunya.com`, Wave / Orange Money,
facturées en XOF converti depuis le stockage USD), signatures de webhook
vérifiées, confirmation propagée via Kafka (`payment.confirmed` → commande `paid`).

**Tracking & livraison** : `fulfillment-svc` tient une table `shipments` +
`tracking_events` unifiée (remplace 3 schémas historiques parallèles) et
intègre DHL Express (devis, création d'expédition, suivi — périmètre réduit
face aux 5500 lignes du PHP legacy, voir commentaires du fichier).
`shipping-svc` gère la livraison internationale par zone ET la livraison
nationale Sénégal par distance (Haversine), volontairement séparées.

**Fidélité & représentants** : `loyalty-svc` tient un ledger complet
`coin_transactions` (jamais tronqué, contrairement au blob meta historique)
et le dashboard des représentants pays (messagerie client, acquittement de
commande).

**Notifications push** : `notification-svc` envoie réellement via Firebase
Cloud Messaging (Admin SDK, JWT RS256 signé en interne) — pas de relais vers
le frontend comme sous WordPress.

## 6. Déploiement sur VPS (Kubernetes — k3s)

Choix acté : **k3s** (Kubernetes en un binaire, sans plan de contrôle lourd).

```bash
# Sur le VPS, UNE seule commande fait tout :
# installe k3s → namespace + Secret depuis .env → manifests →
# build des 10 images → import containerd → rollouts → health-check
git clone https://github.com/abmcompanysn-dot/back.git /opt/miad-backend
bash /opt/miad-backend/scripts/vps-bootstrap.sh

# Vérifier à tout moment
bash /opt/miad-backend/scripts/system-check-k8s.sh
kubectl -n miad get pods
```

Scalabilité : `kubectl -n miad scale deploy/catalog-svc --replicas=3`
(services stateless). `docker-compose.yml` reste disponible en repli local avec
exactement le même `.env` — rien n'est verrouillé.

**Variables à définir dans `.env` avant le premier boot** — voir `.env.example`
pour la liste complète et à jour. En résumé : `POSTGRES_PASSWORD`, `JWT_SECRET`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`PAYDUNYA_API_KEY_*`/`PAYDUNYA_MASTER_KEY`, `DHL_API_*` (optionnel, fulfillment-svc),
`FIREBASE_SERVICE_ACCOUNT_JSON` (optionnel, push), `FIREBASE_WEB_CLIENT_ID` (optionnel, login Google).

**Ce dépôt déploie uniquement le backend.** Le frontend (`frontend/`) reste
sur Cloudflare Pages — `vps-bootstrap.sh` ne le touche pas. Une fois le VPS
vérifié et les endpoints de compatibilité (section 4) branchés côté
frontend, ses routes `app/api/*` pointeront vers ce VPS (Caddy, port 80/443)
au lieu de WooCommerce.

## 7. Générer les stubs gRPC / grpc-gateway

Les contrats `.proto` sont écrits ; les stubs Go se génèrent ensuite :

```bash
make proto     # protoc + protoc-gen-go + protoc-gen-go-grpc + protoc-gen-grpc-gateway
```

Chaque service remplacera alors ses handlers `net/http` par les serveurs générés —
**même contrat JSON**, zéro changement côté frontend (annotations
`google.api.http` déjà posées sur chaque RPC).

## 8. Migration WooCommerce (plan en 6 phases)

1. Socle infra + catalog-svc en lecture seule (ce dépôt démarre ici)
2. `make import WC_URL=… WC_KEY=… WC_SECRET=…` — lecture `wc/v3/*` + `dokan/v1/stores`,
   réutilise la logique de `lib/woo-server.ts`. Copie directe des prix USD,
   aucune conversion (voir section 3).
3. Bascule lecture (`/products`, `/categories`, `/stores`) — écriture encore sur WP
4. Services d'écriture : order / payment / auth — WP gardé en lecture seule
5. shipping-svc + notification-svc (consommateurs, risque minimal)
6. Extinction WordPress après 2 semaines sans incident + archivage MySQL

## 9. Mettre à jour le dépôt (git flow)

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

**Redéployer UN SEUL service** (ex : modification isolée dans `catalog-svc`,
sans reconstruire ni redémarrer les 10 autres) :
```bash
# Sur le VPS, dans /opt/miad-backend, après git pull :
bash scripts/deploy-service.sh catalog-svc
```
Build l'image de ce service uniquement, l'importe dans containerd,
redémarre son `Deployment` k8s, attend le rollout, vérifie son
`/system-check` — les autres `Deployment` ne sont ni reconstruits ni
redémarrés. `scripts/vps-bootstrap.sh` reste la commande à utiliser pour
un premier déploiement ou une mise à jour large touchant plusieurs
services (il rebuild les 11 images à chaque fois).

## 10. État du socle — câblé vs signalé

Câblé : schémas auto-appliqués · CRUD catalogue (trid/lang, variations, pagination
explicite) · boutiques + délégations inter-services · éclatement de commande par
boutique + reaper `payment_expired` · consommation Kafka (payment, notification,
fulfillment) · OTP + mot de passe admin + Firebase (clients ET admins) → JWT HS256
+ sessions Redis · paiements Stripe (PaymentIntent + Elements) / PayDunya avec
signatures · zones/tarifs de livraison + national Sénégal (Haversine) · tracking
DHL unifié · coins/fidélité (ledger complet) · représentants pays · push FCM
direct · console admin complète · health-check agrégé · couche de compatibilité
JSON avec le frontend existant (section 4).

Signalé explicitement dans le code (jamais de 404/500 muets) :
- `GET /products/{id}/similar` → 501 tant que Vectorize n'est pas rebranché
- Envoi SMS réel : fournisseur à configurer (`SMS_PROVIDER_URL`), sinon journalisé
- Push FCM réel : nécessite `FIREBASE_SERVICE_ACCOUNT_JSON`, sinon journalisé sans envoi
- DHL réel : nécessite `DHL_API_USERNAME`/`DHL_API_PASSWORD`, sinon 503 explicite
- Tarifs de livraison seedés en USD, resynchronisés avec les VRAIES valeurs de
  `frontend/lib/shipping-utils.ts` — les montants « par article » et
  « local strict » restent des estimations à confirmer (voir section 3)

## 11. Cohérence éventuelle — gérée, pas tue

- **Commande créée sans `payment.confirmed`** : statut `pending_payment` + reaper
  qui passe en `payment_expired` après `PAYMENT_TIMEOUT_MINUTES` (défaut 30).
- **notification-svc / fulfillment-svc en panne** : offsets Kafka, rattrapage au redémarrage.
- **order-svc injoignable à la confirmation** : `payment.confirmed` reste sur Kafka ;
  la mutation de statut est retentée — rien n'est perdu silencieusement.
- **shipping-svc injoignable au checkout** : `shipping_usd` reste à 0 plutôt que
  de faire échouer toute la commande — les frais restent ajustables après coup,
  contrairement à un prix produit qui ne doit jamais dériver.

## 12. Ce qui n'a PAS encore été testé en exécution réelle

Important à savoir avant tout déploiement en confiance : ce dépôt compile
(`go build ./...`, `go vet ./...`, hors ligne) et a été relu ligne par ligne,
mais **aucun des 10 services n'a encore tourné avec une vraie base
Postgres/Redis/Kafka** — ni ici, ni ailleurs. Le premier test d'exécution
réelle (`docker compose up` ou `vps-bootstrap.sh`) reste à faire avant toute
bascule de trafic réel depuis miadmarket.com.

## 13. Bugs connus non résolus

### Page catégorie bloquée en chargement quand ouverte en lien direct (2026-09-03)

Ouvrir une URL `miadmarket.ca/?v=category&slug=X` **directement** (lien
partagé, favori, nouvel onglet, actualisation de page) laisse la page
bloquée indéfiniment sur un squelette de chargement — jamais de vrais
produits affichés. **Cliquer sur une catégorie depuis le site (navigation
normale) fonctionne bien** : seul l'accès direct par URL est concerné.

Investigation approfondie (session du 2026-09-03, tests réels via le skill
`browse`) a déjà éliminé 5 causes distinctes, toutes corrigées au passage
(voir l'historique git du même jour, `frontend/app/MiadMarketClient.tsx`
et `frontend/app/api/products/route.ts`) :
1. Requêtes catalogue séquentielles côté serveur → parallélisées.
2. Préchargement de 500 produits pour l'accueil, actif même hors accueil.
3. Fetch catalogue global actif à tort sur la vue catégorie.
4. `selectedCategory` jamais initialisé depuis l'URL (`forcedCategorySlug`
   manquant, contrairement à `forcedProductSlug`/`forcedVendorSlug`) —
   corrigé, confirmé par debug en direct.
5. `revalidateIfStale: false` (SWR) empêchant tout refetch de la liste des
   catégories quand elle démarre vide — tenté, **n'a pas résolu le
   problème** malgré la théorie qui semblait tenir.

Après ces 5 correctifs, `/api/categories` (et `/api/products?category=...`)
ne sont **toujours jamais appelés** sur cette page en lien direct (confirmé
par capture réseau) — la vraie cause reste donc non identifiée. Prochaines
pistes à explorer : vérifier si le composant `CategoryPage` (ou son
`useSWR` dédié) se monte réellement dans ce scénario ; comparer avec le
comportement du composant `HomePage`/`ProductDetail` (mêmes hooks SWR, qui
eux fonctionnent en lien direct) ; envisager un vrai breakpoint navigateur
(pas juste `console.log` + skill `browse`) pour inspecter l'état React en
direct.
