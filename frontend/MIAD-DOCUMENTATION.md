# MIAD Market — Documentation Complète du Projet

> Plateforme e-commerce headless dédiée aux produits africains.  
> Connecte 10+ pays africains avec la diaspora mondiale.

---

## 1. VUE D'ENSEMBLE

**MIAD Market** est une marketplace multi-vendeurs headless construite sur :
- **Frontend** : Next.js 15 + React 19 (TypeScript)
- **Backend** : WordPress + WooCommerce + Dokan (multi-vendeurs)
- **Authentification** : Firebase (OTP SMS) + JWT (email/mot de passe)
- **Paiements** : Stripe, PayDunya
- **Notifications** : Twilio (WhatsApp), Email SMTP
- **Hébergement** : Vercel (frontend), WordPress auto-géré (backend)

---

## 2. ARCHITECTURE TECHNIQUE

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (Vercel)                    │
│            Next.js 15  •  React 19  •  TypeScript       │
│                                                         │
│  app/                                                   │
│  ├── page.tsx              Page principale (SSR)        │
│  ├── MiadMarketClient.tsx  Client principal (SPA)       │
│  ├── api/                  API Routes Next.js           │
│  │   ├── auth/login        Authentification             │
│  │   ├── products          Catalogue produits           │
│  │   ├── orders            Gestion commandes            │
│  │   ├── customer          Profil client                │
│  │   ├── representant/me   Données représentant         │
│  │   └── stores            Boutiques vendeurs           │
│  └── components/miad/      Tous les composants UI       │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                    BACKEND (WordPress)                  │
│         WooCommerce + Dokan + Snippets PHP custom       │
│                                                         │
│  woocommerce-snippets/                                  │
│  ├── miad-auth.php          Authentification Firebase   │
│  ├── miad-email-customizer  Emails transactionnels      │
│  ├── miad-representative    Rôles + dashboard rep       │
│  ├── miad-rep-api           API REST messagerie         │
│  ├── miad-coins             Système de fidélité         │
│  ├── miad-jwt-config        Configuration JWT Auth      │
│  ├── miad-push              Notifications push FCM      │
│  ├── miad-tracking          Suivi colis                 │
│  ├── miad-cart-recovery     Récupération panier         │
│  ├── miad-r2-offload        Stockage médias Cloudflare  │
│  └── miad-performance       Optimisation WP             │
└─────────────────────────────────────────────────────────┘
```

---

## 3. COMPOSANTS FRONTEND

### Navigation & Layout
| Composant | Rôle |
|-----------|------|
| `Header.tsx` | En-tête avec recherche, panier, icône messages (badge), compte |
| `BottomNav.tsx` | Navigation mobile bas d'écran |
| `Footer.tsx` | Pied de page avec pays et catégories |
| `MobileSidebar.tsx` | Menu latéral mobile |

### Pages principales
| Composant | Rôle |
|-----------|------|
| `HomePage.tsx` | Accueil : produits par pays, sections, héro |
| `ProductDetail.tsx` | Fiche produit complète avec variations |
| `CartPage.tsx` | Panier d'achat |
| `CheckoutPage.tsx` | Tunnel de commande (adresse WooCommerce standard) |
| `HelpCenter.tsx` | Centre d'aide avec sujets (FAQ) |

### Dashboards
| Composant | Rôle |
|-----------|------|
| `ClientDashboard.tsx` | Espace client (commandes, messages, adresses, coins) |
| `Dashboard.tsx` | Dashboard vendeur |
| `AdminDashboard.tsx` | Dashboard administrateur |
| `RepresentantPage.tsx` | Page espace représentant (Next.js) |

### Catalogue & Produits
| Composant | Rôle |
|-----------|------|
| `CategoryPage.tsx` | Page catégorie |
| `CategoriesListPage.tsx` | Liste de toutes les catégories |
| `CategoriesSection.tsx` | Section catégories (homepage) |
| `CountryPage.tsx` | Page par pays |
| `CountrySection.tsx` | Section pays (homepage) |
| `ProductCard.tsx` | Carte produit |
| `ProductSkeleton.tsx` | Skeleton loader produit |
| `ProductVariations.tsx` | Sélecteur de variations |
| `VariationSelector.tsx` | UI sélection variation |
| `StoresListPage.tsx` | Liste des boutiques |
| `VendorStoreWrapper.tsx` | Page boutique vendeur |

### Commerce
| Composant | Rôle |
|-----------|------|
| `AddToCartButton.tsx` | Bouton ajout panier |
| `QuickSelectModal.tsx` | Modal sélection rapide (produits variables) |
| `CouponsSection.tsx` | Codes promo |
| `StripePaymentForm.tsx` | Formulaire paiement Stripe |
| `ShippingInfo.tsx` | Informations livraison |
| `ProductShippingEstimate.tsx` | Estimation frais livraison |

### Représentants
| Composant | Rôle |
|-----------|------|
| `RepMessages.tsx` | Messagerie représentant ↔ client |

### Authentification
| Composant | Rôle |
|-----------|------|
| `LoginPage.tsx` | Connexion (email + OTP) |
| `RegisterPage.tsx` | Inscription |
| `OtpInput.tsx` | Saisie code OTP |
| `MagicLinkHandler.tsx` | Gestion lien magique |

### Utilitaires UI
| Composant | Rôle |
|-----------|------|
| `CoinsWidget.tsx` | Widget MIAD Coins |
| `CoinsBanner.tsx` | Bannière coins |
| `TrackingTimeline.tsx` | Timeline suivi colis |
| `OrderDetailPanel.tsx` | Panneau détail commande |
| `OrderHistory.tsx` | Historique commandes |
| `ShareButton.tsx` | Bouton partage réseaux |
| `QRCodeImage.tsx` | Génération QR code |
| `InstallPrompt.tsx` | Prompt installation PWA |
| `PushManager.tsx` | Gestion notifications push |
| `HeroSection.tsx` | Section héro |
| `FlashSalesSection.tsx` | Section ventes flash |
| `ProgressBar.tsx` | Barre de progression |
| `BackNavigationGuard.tsx` | Garde navigation retour |
| `ContactVendorForm.tsx` | Formulaire contact vendeur |

---

## 4. API ROUTES (Next.js)

| Route | Méthode | Description |
|-------|---------|-------------|
| `/api/auth/login` | POST | Connexion email/OTP → retourne JWT + rôle |
| `/api/products` | GET | Catalogue produits (pagination infinite) |
| `/api/categories` | GET | Catégories WooCommerce |
| `/api/stores` | GET | Boutiques vendeurs Dokan |
| `/api/orders` | POST | Création commande WooCommerce |
| `/api/customer` | GET | Profil client connecté |
| `/api/representant/me` | GET | Données représentant connecté |

---

## 5. SYSTÈME DE RÔLES

| Rôle WordPress | Niveau | Accès |
|----------------|--------|-------|
| `administrator` | Admin | Tout le site WordPress |
| `miad_super_rep` | Super Représentant | Toutes les zones, toutes commandes |
| `miad_representative` | Représentant Pays | Sa zone uniquement |
| `seller` / `vendor` | Vendeur Dokan | Sa boutique |
| `subscriber` (défaut) | Client | Son compte |

### Redirections à la connexion
- `miad_super_rep` → `/espace-representant/`
- `miad_representative` → `/espace-representant/`
- `seller` / `vendor` → Dashboard vendeur
- `administrator` → `/wp-admin/`
- Client → Dashboard client

---

## 6. SYSTÈME EMAIL (miad-email-customizer.php)

### Types d'emails
| Code | Déclencheur | Destinataire |
|------|-------------|--------------|
| `miad_order_received` | Commande créée (checkout) | Client |
| `miad_pending_payment` | Statut → "pending" (hors création) | Client |
| `miad_processing` | Statut → "processing" | Client |
| `miad_order_cancelled` | Statut → "cancelled" | Client |
| `miad_welcome` | Inscription (WooCommerce ou OTP) | Client |
| `new_order` | Commande créée | Admin |

### Template email
- Fond blanc, bordure verte #005826
- Logo MIAD en en-tête
- Footer avec support@miadmarket.com
- Compatible Gmail, Outlook, mobile
- Sans images (anti-spam)

### Hooks utilisés
```php
woocommerce_checkout_order_created     // → miad_order_received + new_order admin
woocommerce_order_status_cancelled     // → miad_order_cancelled
woocommerce_order_status_changed       // → miad_pending_payment (anti-doublon)
woocommerce_payment_successful_result  // → Redirection page succès
woocommerce_created_customer           // → miad_welcome (checkout)
miad_new_customer_registered           // → miad_welcome (OTP/Firebase)
```

---

## 7. SYSTÈME REPRÉSENTANTS (miad-representative.php)

### Fonctionnalités
- **Rôle `miad_representative`** : affecté à un pays, voit les commandes de sa zone
- **Rôle `miad_super_rep`** : aucune restriction de zone, voit tout
- Redirection automatique vers `/espace-representant/` à la connexion
- Tableau de bord PHP (shortcode `[miad_rep_dashboard]`) avec :
  - Stats : total, action requise, en transit, livrées
  - Onglet Commandes (60 dernières)
  - Onglet En transit (transporteur local + N° tracking)
  - Onglet Vendeurs de la zone
  - Onglet Export CSV

### Chaîne de livraison
```
vendor_confirmed → rep_received → local_pickup → intl_handoff → delivered
```

### Notifications automatiques (commande processing)
1. Email HTML professionnel → Représentant de zone
2. WhatsApp Twilio → Représentant (template ou fallback texte)
3. WhatsApp Twilio → Admin (optionnel)
4. Étape livraison → `vendor_confirmed` automatiquement

---

## 8. MESSAGERIE REPRÉSENTANTS (miad-rep-api.php)

### Endpoints REST WordPress
| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/miad/v1/messages` | GET | Liste messages du rep connecté |
| `/miad/v1/messages` | POST | Créer nouveau message client → rep |
| `/miad/v1/messages/{id}/reply` | POST | Répondre à un message |
| `/miad/v1/representant/me` | GET | Données représentant connecté |

### CPT `miad_message`
- Auteur = client
- Meta `_rep_id` = représentant assigné
- Meta `_status` = open/closed
- Meta `_replies` = tableau JSON des réponses

### Emails de notification
- **Au représentant** : template MIAD avec bouton CTA → `/espace-representant/`
- **Au client** : confirmation de réception du message

---

## 9. PAYS DE LIVRAISON (lib/woocommerce.ts)

Triés alphabétiquement, tous en USD ($) :

| Pays | Code | Région |
|------|------|--------|
| Afrique du Sud | `za` | Afrique Australe |
| Algérie | `dz` | Afrique du Nord |
| Bénin | `bj` | Afrique de l'Ouest |
| Burkina Faso | `bf` | Afrique de l'Ouest |
| Cameroun | `cm` | Afrique Centrale |
| Canada | `ca` | Amérique du Nord |
| Congo | `cg` | Afrique Centrale |
| Côte d'Ivoire | `ci` | Afrique de l'Ouest |
| États-Unis | `us` | Amérique du Nord |
| France | `fr` | Europe |
| Gabon | `ga` | Afrique Centrale |
| Ghana | `gh` | Afrique de l'Ouest |
| Guinée | `gn` | Afrique de l'Ouest |
| Kenya | `ke` | Afrique de l'Est |
| Mali | `ml` | Afrique de l'Ouest |
| Maroc | `ma` | Afrique du Nord |
| Niger | `ne` | Afrique de l'Ouest |
| Nigéria | `ng` | Afrique de l'Ouest |
| RDC | `cd` | Afrique Centrale |
| Sénégal | `sn` | Afrique de l'Ouest |
| Tanzanie | `tz` | Afrique de l'Est |
| Togo | `tg` | Afrique de l'Ouest |
| Tunisie | `tn` | Afrique du Nord |

---

## 10. FORMULAIRE DE COMMANDE (CheckoutPage.tsx)

Champs identiques au format WooCommerce standard :

| Champ | Obligatoire | Mapping WooCommerce |
|-------|-------------|---------------------|
| Prénom | ✅ | `billing.first_name` / `shipping.first_name` |
| Nom | ✅ | `billing.last_name` / `shipping.last_name` |
| Entreprise | ➖ | `billing.company` / `shipping.company` |
| Email | ✅ | `billing.email` |
| Téléphone | ✅ | `billing.phone` / `shipping.phone` |
| Pays / Région | ✅ | `billing.country` / `shipping.country` |
| État / Région | ➖ | `billing.state` / `shipping.state` |
| Adresse ligne 1 | ✅ | `billing.address_1` / `shipping.address_1` |
| Adresse ligne 2 | ➖ | `billing.address_2` / `shipping.address_2` |
| Ville | ✅ | `billing.city` / `shipping.city` |
| Code postal | ➖ | `billing.postcode` / `shipping.postcode` |

---

## 11. AUTHENTIFICATION

### Chemin OTP (Firebase)
```
Client → OTP SMS → Firebase → /api/auth/firebase
→ WordPress : wp_create_user() ou login
→ do_action('miad_new_customer_registered') → email de bienvenue
→ Retour token miad_XXXX + rôle
```

### Chemin Email/Mot de passe (JWT)
```
Client → /api/auth/login → JWT Auth WP
→ Vérification rôle → Retour token JWT + rôle normalisé
```

### Normalisation des rôles (login route)
```
administrator         → 'admin'
seller/vendor/wcfm_vendor → 'vendor'
miad_representative   → 'representant'
miad_super_rep        → 'representant'
miad_representant     → 'representant'
miad_rep / miad_agent → 'representant'
(autres)              → 'buyer'
```

---

## 12. SYSTÈME MIAD COINS (miad-coins.php)

- Cumul de points à chaque achat
- Conversion coins → réduction
- Widget affichage solde
- Administration via `miad-coins-admin.php`

---

## 13. NOTIFICATIONS PUSH (miad-push.php)

- Firebase Cloud Messaging (FCM)
- Token stocké en `user_meta`
- Composant `PushManager.tsx` côté client
- Déclenchement depuis WordPress sur events commandes

---

## 14. DÉPENDANCES FRONTEND

### Principales
| Package | Version | Rôle |
|---------|---------|------|
| `next` | ^15.1.0 | Framework React SSR |
| `react` / `react-dom` | ^19.0.0 | UI library |
| `typescript` | 5.7.3 | Typage statique |
| `tailwindcss` | ^4.2.0 | Styles CSS utilitaires |
| `framer-motion` | ^12.38.0 | Animations fluides |
| `swr` | ^2.4.1 | Data fetching + cache |
| `firebase` | ^12.12.1 | Auth OTP + Push |
| `firebase-admin` | ^13.10.0 | Firebase côté serveur |

### Paiements
| Package | Version | Rôle |
|---------|---------|------|
| `stripe` | ^22.1.1 | Paiement carte bancaire |
| `@stripe/react-stripe-js` | ^6.3.0 | Composants React Stripe |
| `@stripe/stripe-js` | ^9.4.0 | SDK Stripe client |

### UI Components
| Package | Version | Rôle |
|---------|---------|------|
| `lucide-react` | ^0.564.0 | Icônes |
| `@radix-ui/*` | divers | Primitives UI accessibles |
| `class-variance-authority` | ^0.7.1 | Variantes de styles |
| `clsx` / `tailwind-merge` | latest | Fusion classes CSS |
| `sonner` | ^1.7.4 | Notifications toast |
| `embla-carousel-react` | 8.6.0 | Carousel produits |
| `recharts` | 2.15.0 | Graphiques dashboard |
| `input-otp` | 1.4.2 | Input code OTP |
| `vaul` | ^1.1.2 | Drawer mobile |
| `cmdk` | 1.1.1 | Command palette |

### Formulaires & Validation
| Package | Version | Rôle |
|---------|---------|------|
| `react-hook-form` | ^7.54.1 | Gestion formulaires |
| `@hookform/resolvers` | ^3.9.1 | Résolveurs validation |
| `zod` | ^3.24.1 | Schémas de validation |

### Utilitaires
| Package | Version | Rôle |
|---------|---------|------|
| `date-fns` | 4.1.0 | Manipulation dates |
| `axios` | ^1.15.2 | HTTP client |
| `ioredis` | ^5.10.1 | Cache Redis |
| `qrcode` | ^1.5.4 | Génération QR codes |
| `dompurify` | ^3.4.2 | Sanitisation HTML |
| `speakeasy` | ^2.0.0 | TOTP / 2FA |
| `csv-parser` | ^3.2.0 | Export CSV |
| `@vercel/analytics` | 1.6.1 | Analytics Vercel |

---

## 15. VARIABLES D'ENVIRONNEMENT

```env
# WooCommerce / WordPress
NEXT_PUBLIC_WOO_URL=https://api.miadmarket.com
INTERNAL_API_SECRET=miad-headless-secret-2024

# Firebase
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
FIREBASE_SERVICE_ACCOUNT_KEY=

# Stripe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_SECRET_KEY=sk_...

# Redis (cache optionnel)
REDIS_URL=

# WebSocket (temps réel optionnel)
NEXT_PUBLIC_WS_URL=wss://...
```

---

## 16. PLUGINS WORDPRESS REQUIS

| Plugin | Rôle | Obligatoire |
|--------|------|-------------|
| WooCommerce | E-commerce | ✅ |
| Dokan Lite ou Pro | Multi-vendeurs | ✅ |
| JWT Authentication for WP REST API | Auth tokens | ✅ |
| WooCommerce Stripe Payment Gateway | Paiements Stripe | ✅ |
| PayDunya WooCommerce | Paiements Afrique | Recommandé |

---

## 17. STRUCTURE DES FICHIERS CLÉS

```
v0-miad-front-end/
├── app/
│   ├── page.tsx                    Point d'entrée SSR
│   ├── MiadMarketClient.tsx        SPA principal (routeur + état global)
│   ├── layout.tsx                  Layout racine
│   └── api/
│       ├── auth/login/route.ts     Auth + normalisation rôles
│       ├── products/route.ts       Catalogue
│       ├── orders/route.ts         Commandes
│       ├── customer/route.ts       Profil client
│       └── representant/me/route.ts Données rep
├── components/miad/               54 composants React
├── lib/
│   ├── woocommerce.ts              Types + pays + catégories
│   ├── miad-server-auth.ts         Auth serveur (REP_ROLES, isRep)
│   └── shipping-utils.ts           Calcul frais livraison
├── woocommerce-snippets/          12 fichiers PHP (Code Snippets WP)
└── public/
    ├── logo/logo.png
    └── sw.js                       Service Worker (PWA)
```

---

*Document généré automatiquement — MIAD Market v0.1.0*  
*Dernière mise à jour : 2026-05-26*
