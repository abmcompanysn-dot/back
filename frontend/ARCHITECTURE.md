# Architecture MIAD Market — Référence système complète

> Document de référence pour le diagnostic et la maintenance.  
> À garder à jour à chaque modification majeure du système.

---

## 1. Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────┐
│  Navigateur client                                              │
│  miadmarket.com                                                 │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTPS
┌────────────────────▼────────────────────────────────────────────┐
│  Cloudflare Pages (Edge)                                        │
│  Next.js 14 App Router — @cloudflare/next-on-pages             │
│  runtime = 'edge' sur tous les routes API                       │
│  Déploiement : git push main → auto-deploy                     │
└────┬───────────────┬────────────────┬────────────────┬──────────┘
     │               │                │                │
     ▼               ▼                ▼                ▼
WordPress       Stripe API      PayDunya API     Firebase FCM
api.miadmarket  api.stripe.com  app.paydunya.com fcm.googleapis
.com                                             .com
```

---

## 2. Domaines et URLs

| Rôle | URL |
|------|-----|
| Site client (frontend) | `https://www.miadmarket.com` |
| API WordPress / WooCommerce | `https://api.miadmarket.com` |
| CDN images produits | `https://cdn.miadmarket.com` |
| Dashboard Cloudflare | `https://dash.cloudflare.com` |
| Dashboard Stripe | `https://dashboard.stripe.com` |
| Dashboard PayDunya | `https://app.paydunya.com` |
| Dashboard Firebase | `https://console.firebase.google.com` |

---

## 3. Frontend — Next.js sur Cloudflare Pages

### Stack
- **Framework** : Next.js 14 App Router
- **Adapter** : `@cloudflare/next-on-pages` (edge runtime uniquement)
- **Hébergement** : Cloudflare Pages, projet `miad`
- **Déploiement** : `git push` vers `main` sur GitHub → build automatique

### Fichiers clés
| Fichier | Rôle |
|---------|------|
| `app/page.tsx` | Page principale (SPA), lit les searchParams Stripe/PayDunya |
| `app/MiadMarketClient.tsx` | Shell SPA, routing côté client, retour Stripe 3DS |
| `app/order-received/page.tsx` | Page de confirmation PayDunya |
| `middleware.ts` | CSP headers, CORS, nonce |
| `components/miad/CheckoutPage.tsx` | Tunnel de commande |
| `components/miad/ClientDashboard.tsx` | Espace client |
| `components/miad/LazyImage.tsx` | Image lazy avec fallback logo MIAD |
| `components/miad/RecommendedProducts.tsx` | Algo de suggestion produits |

### Variables d'environnement (Cloudflare Pages secrets)
```
NEXT_PUBLIC_WOO_URL          = https://api.miadmarket.com
NEXT_PUBLIC_R2_URL           = https://cdn.miadmarket.com
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = pk_live_...
WOO_CONSUMER_KEY             = ck_...
WOO_CONSUMER_SECRET          = cs_...
INTERNAL_API_SECRET          = (secret partagé avec WordPress)
MIAD_PRODUCTS_API            = https://api.miadmarket.com/wp-json/miad-products/v1
MIAD_PRODUCTS_SECRET         = (secret pour miad-products endpoints)
MIAD_LINK_API                = (URL API liens)
MIAD_LINK_SECRET             = (secret API liens)
R2_DST_ACCOUNT_ID            = 5e8fd042542e85a3f38cba06304ed5c0
R2_DST_BUCKET                = miadr2
R2_ACCESS_KEY_ID             = (clé R2)
R2_SECRET_ACCESS_KEY         = (secret R2)
```
> **Note** : `STRIPE_SECRET_KEY` N'est PAS dans les secrets Next.js — elle est uniquement dans WordPress.

### Routes API Next.js
| Endpoint | Méthode | Rôle |
|----------|---------|------|
| `/api/orders` | POST | Créer commande WC + init paiement Stripe ou PayDunya |
| `/api/orders/[id]/confirm-stripe` | POST | Délègue vérif Stripe à WP puis met à jour WC |
| `/api/orders/[id]/confirm-paydunya` | POST | Lit statut WC (déjà mis à jour par IPN PayDunya) |
| `/api/orders/[id]/shipping-address` | PATCH | Modifier adresse livraison (client authentifié) |
| `/api/products` | GET | Catalogue WC + variations + fallback WPML |
| `/api/push/send` | POST | Envoyer notification push FCM |
| `/api/webhooks/woocommerce` | POST | Reçoit webhooks WC → revalidate cache Next.js |
| `/api/auth/[...]` | * | JWT login/refresh via WP |

---

## 4. Backend — WordPress / WooCommerce

### Stack
- **CMS** : WordPress + WooCommerce
- **Multilingue** : WPML
- **URL** : `https://api.miadmarket.com`
- **Hébergement** : Serveur dédié (non Cloudflare Pages)
- **Déploiement snippets** : Plugin **Code Snippets** (copie manuelle depuis ce repo)

### Endpoints WooCommerce REST standard (`/wp-json/wc/v3/`)
Authentification : `?consumer_key=ck_...&consumer_secret=cs_...`

| Endpoint | Usage |
|----------|-------|
| `GET /products` | Catalogue, filtres catégorie/langue |
| `GET /products/{id}/variations` | Variantes d'un produit variable |
| `GET /orders/{id}` | Lire une commande |
| `PUT /orders/{id}` | Mettre à jour statut/adresse commande |
| `GET /customers/{id}` | Profil client |
| `PUT /customers/{id}` | Sauvegarder adresse client |

### Endpoints custom (`/wp-json/miad/v1/`)
Authentification : header `X-Headless-Secret: {INTERNAL_API_SECRET}`

| Endpoint | Méthode | Fichier snippet | Rôle |
|----------|---------|----------------|------|
| `/create-payment-intent` | POST | `intent payement.php` | Crée PaymentIntent Stripe + sauve `_stripe_intent_id` sur la commande WC |
| `/confirm-stripe-order` | POST | `intent payement.php` | Vérifie PI auprès Stripe + `payment_complete()` sur commande WC |
| `/rep-acknowledge` | POST | `miad-rep-api.php` | Représentant prend en charge une commande → statut `miad-rep-charge` |

### Endpoints custom (`/wp-json/miad-products/v1/`)
Authentification : header `X-Miad-Products-Secret: {MIAD_PRODUCTS_SECRET}`

| Endpoint | Méthode | Fichier snippet | Rôle |
|----------|---------|----------------|------|
| `/create` | POST | `miad-products-api.php` | Créer produit WC |
| `/set-image` | POST | `miad-products-api.php` | Changer image featured + galerie (bypass WPML resync) |
| `/set-variation-price` | POST | `miad-products-api.php` | Modifier prix variante (bypass WPML) |

> ⚠️ **Attention** : la version live de `/set-image` ne supporte pas encore `galleryUrls` — déploiement en attente.

### Snippets WordPress (Code Snippets) — fichiers de référence dans ce repo
| Fichier repo | Snippet WP | Statut |
|-------------|-----------|--------|
| `woocommerce-snippets/miad-auth.php` | Auth JWT | ✅ Déployé |
| `woocommerce-snippets/miad-push.php` | Tokens FCM + envoi push | ✅ Déployé (avec hook `miad-rep-charge`) |
| `woocommerce-snippets/miad-rep-api.php` | API représentant | ✅ Déployé |
| `woocommerce-snippets/miad-products-api.php` | API gestion produits | ⚠️ Partiellement (sans gallery) |
| `woocommerce-snippets/miad-email-customizer.php` | Emails custom | ✅ Déployé |
| `app/api/webhooks/woocommerce/intent payement.php` | Stripe PaymentIntent + confirm | ⚠️ À redéployer (ajout `_stripe_intent_id`) |
| `app/api/webhooks/woocommerce/paydunia.php` | PayDunya IPN webhook | ✅ Déployé |

---

## 5. Paiement Stripe (cartes bancaires)

### Flux complet
```
1. Client → CheckoutPage → POST /api/orders
2. Next.js → WC API : crée commande (status: pending)
3. Next.js → WP /miad/v1/create-payment-intent :
   - Crée PaymentIntent Stripe (montant en centimes CAD)
   - Sauve _stripe_intent_id + transaction_id sur commande WC
4. Next.js → client : renvoie clientSecret
5. Client → Stripe JS : confirme paiement (carte/3DS)
6. Stripe → WC webhook (wc-api=wc_stripe) : payment_intent.succeeded
   → WC Stripe plugin retrouve commande via _stripe_intent_id
   → Marque commande payée automatiquement
7. Stripe → navigateur : redirect return_url
   ?payment_success=1&order_id=X&payment_intent=pi_xxx
8. Next.js page.tsx lit payment_intent → MiadMarketClient
9. MiadMarketClient → POST /api/orders/{id}/confirm-stripe (filet de sécurité)
10. Next.js → WP /miad/v1/confirm-stripe-order :
    - Vérifie PI auprès de Stripe (clé secrète côté WP)
    - Si pas encore payée : payment_complete()
```

### Points critiques
- La clé secrète Stripe (`sk_live_...`) est uniquement dans WordPress (`wp-config.php` ou réglages WC Stripe). Elle n'est **jamais** dans les secrets Cloudflare.
- Le webhook Stripe pointe vers : `https://api.miadmarket.com/?wc-api=wc_stripe`
- `return_url` = `https://www.miadmarket.com/?payment_success=1&order_id={id}`

---

## 6. Paiement PayDunya (Mobile Money)

### Flux complet
```
1. Client → CheckoutPage → POST /api/orders
2. Next.js → WC API : crée commande
3. Next.js → PayDunya /checkout-invoice/create :
   - return_url = https://www.miadmarket.com/order-received?order_id=X&token=T
   - callback_url = https://api.miadmarket.com (IPN webhook PayDunya)
4. Client → PayDunya : effectue paiement Mobile Money
5. PayDunya → WP (IPN webhook) : marque commande payée automatiquement
6. PayDunya → navigateur : redirect /order-received?order_id=X&token=T
7. Page /order-received → POST /api/orders/{id}/confirm-paydunya
8. confirm-paydunya → WC API GET orders/{id} : lit statut (déjà mis à jour par IPN)
9. Affichage : success / pending / failed selon statut WC
```

### Points critiques
- L'IPN PayDunya (étape 5) est le mécanisme fiable — la confirmation navigateur (étapes 7-9) est un affichage seulement.
- Le WAF WordPress bloque parfois les headers custom → on lit le statut WC directement sans appel à un endpoint custom.
- Clés PayDunya : dans WordPress et dans les variables Next.js (`.env.local`).

---

## 7. CDN et images (Cloudflare R2)

| Propriété | Valeur |
|-----------|--------|
| Bucket production | `miadr2` |
| Compte Cloudflare | `5e8fd042542e85a3f38cba06304ed5c0` |
| URL publique | `https://cdn.miadmarket.com` |
| Bucket source legacy | `imagemiad` (R2_BUCKET dans .env) |

### Upload d'une image
```bash
# OBLIGATOIRE : --remote sinon l'upload va dans la simulation locale Miniflare
npx wrangler r2 object put miadr2/products/mon-image.jpg \
  --file ./mon-image.jpg --remote \
  --account-id 5e8fd042542e85a3f38cba06304ed5c0
```

### Application sur un produit WC
Appeler `POST /wp-json/miad-products/v1/set-image` avec :
```json
{ "productId": 39407, "imageUrl": "https://cdn.miadmarket.com/products/mon-image.jpg" }
```
> ⚠️ Les produits WPML ont un risque de resync média si on utilise `PUT /wc/v3/products/{id}` directement — toujours passer par `/set-image`.

---

## 8. Notifications push (FCM)

### Flux
```
1. Client navigateur → enregistre token FCM via JS SDK
2. Token envoyé à WP → sauvé dans user meta (miad_push_tokens)
3. Déclencheur (ex: statut commande → miad-rep-charge) :
   - Hook WP appelle miad_send_push_to_user()
   - WP → POST https://www.miadmarket.com/api/push/send (Next.js)
   - Next.js → FCM HTTP v1 API → notification sur le téléphone
```

### Fichiers concernés
- Tokens : `woocommerce-snippets/miad-push.php` → `miad_save_push_token()`, `miad_get_tokens_for_user()`
- Envoi WP → Next : `miad_fcm_send_v1()` dans le même fichier
- Endpoint Next.js : `app/api/push/send/route.ts`
- Variable manquante à vérifier : `NEXT_PUBLIC_FIREBASE_VAPID_KEY` (console Firebase → Paramètres projet → Web Push)

---

## 9. WPML — Particularités importantes

- Chaque produit traduit a son propre ID WooCommerce (`translations: { fr: 39407, en: 39411 }`)
- Les variantes (`product_variation`) ne sont **pas** toujours synchronisées entre traductions
- **Ne jamais** ajouter `?lang=fr` aux appels `/wc/v3/products/{id}/variations` — WPML retourne tableau vide
- Le frontend implémente un fallback : si variations vides, cherche dans les autres traductions via `product.translations`
- Un PUT direct sur `wc/v3/products/{id}` pour les images peut être écrasé par le hook de resync WPML → toujours utiliser `/miad-products/v1/set-image`

---

## 10. CSP (Content-Security-Policy)

Définie dans `middleware.ts`, fonction `buildCSP()`.

**Règle importante** : `next-on-pages` ne propage pas le nonce de Next.js à ses propres scripts internes → suppression du nonce + `unsafe-inline` obligatoire.

```
script-src 'self' 'unsafe-inline' [+ unsafe-eval en dev]
  https://js.stripe.com https://m.stripe.com https://m.stripe.network
  https://www.gstatic.com https://apis.google.com https://accounts.google.com
  https://embed.tawk.to https://*.tawk.to
  https://app.paydunya.com https://sandbox.paydunya.com
  https://static.cloudflareinsights.com
```

---

## 11. Authentification client

- **Mécanisme** : JWT WordPress (plugin JWT Auth)
- **Token stocké** : `localStorage.miad_token` ou `sessionStorage.miad_token`
- **Vérifié côté API** : `lib/miad-server-auth.ts` → `fetchWpUser(token)` appelle `/wp-json/miad/v1/me` (ou `/wp-json/wp/v2/users/me`)
- **Snippet WP** : `woocommerce-snippets/miad-auth.php`

---

## 12. Diagnostic rapide — que vérifier en cas de panne

| Symptôme | Vérifier |
|----------|---------|
| Paiement Stripe ne confirme pas la commande | `_stripe_intent_id` sauvé sur la commande ? Webhook `wc-api=wc_stripe` actif dans Stripe Dashboard ? Snippet `intent payement.php` à jour ? |
| Paiement PayDunya : commande reste `pending` | IPN webhook PayDunya reçu ? (`api.miadmarket.com` accessible) Statut commande dans WC admin ? |
| Variantes produit = 0 | Produit traduit WPML ? Vérifier `GET /wc/v3/products/{id}/variations` SANS `?lang=`. Vérifier fallback translations dans `/api/products` |
| Image produit ne change pas | Produit WPML ? Utiliser `/miad-products/v1/set-image`. Upload fait avec `--remote` ? CDN propagé ? |
| Push notification non reçue | `NEXT_PUBLIC_FIREBASE_VAPID_KEY` défini ? Token FCM enregistré pour l'utilisateur ? Snippet `miad-push.php` actif ? |
| Erreur CSP console | Nouveau domaine tiers à ajouter dans `middleware.ts` `buildCSP()` |
| Secret non reconnu en prod | `wrangler pages secret put NOM_SECRET` + nouveau déploiement obligatoire |
| Upload R2 silencieux (pas visible sur CDN) | Oublié `--remote` dans la commande wrangler |

---

*Dernière mise à jour : 1er juillet 2026*
