/* ============================================================
   MIAD Market — données du brief « Backend sans WordPress »
   (cadrage, conception, exécution) + géométrie du diagramme.
   ============================================================ */

export interface Service {
  id: string;
  name: string;
  port: string;
  db: string;
  role: string;
  publishes: string[];
  consumes: string[];
  tables: string[];
  sample: string[];
  x: number;
  y: number;
}

export const NODE_W = 104;
export const NODE_H = 46;

export const SERVICES: Service[] = [
  {
    id: "auth",
    name: "auth-svc",
    port: "8086",
    db: "miad_auth",
    role: "OTP SMS/email, sessions Redis + JWT HS256. Le code ne circule jamais : seule une référence opaque.",
    publishes: ["customer.registered"],
    consumes: [],
    tables: ["customers"],
    sample: ["POST /auth/otp/send", "POST /auth/otp/verify", "GET /customer"],
    x: 20,
    y: 130,
  },
  {
    id: "catalog",
    name: "catalog-svc",
    port: "8081",
    db: "miad_catalog",
    role: "Produits, variations, catégories, avis, recherche. Traduction FR/EN par paire de lignes trid+lang (modèle WPML conservé).",
    publishes: ["product.created", "product.updated"],
    consumes: [],
    tables: ["products", "product_variations", "categories", "reviews"],
    sample: ["GET /products", "GET /products/:id", "POST /vendor/products"],
    x: 144,
    y: 130,
  },
  {
    id: "vendor",
    name: "vendor-svc",
    port: "8082",
    db: "miad_vendor",
    role: "Boutiques (ex-Dokan) : profils, logo/bannière R2, vérification. Délègue produits et commandes aux services propriétaires.",
    publishes: ["vendor.registered", "vendor.updated"],
    consumes: [],
    tables: ["vendors"],
    sample: ["GET /stores", "PUT /vendor/profile", "GET /vendor/:id/products"],
    x: 268,
    y: 130,
  },
  {
    id: "order",
    name: "order-svc",
    port: "8083",
    db: "miad_order",
    role: "Commandes multi-vendeurs éclatées par boutique. Reaper payment_expired : le cas « paiement jamais confirmé » est géré, pas tu.",
    publishes: ["order.created", "order.status_changed"],
    consumes: [],
    tables: ["orders", "coupons"],
    sample: ["POST /orders", "GET /orders/:id", "GET /vendor/orders"],
    x: 392,
    y: 130,
  },
  {
    id: "payment",
    name: "payment-svc",
    port: "8084",
    db: "miad_payment",
    role: "Stripe (carte) + PayDunya (Wave, Orange Money). Écoute order.created, signe les webhooks, publie payment.confirmed.",
    publishes: ["payment.confirmed", "payment.failed"],
    consumes: ["order.created"],
    tables: ["payments"],
    sample: ["POST /payments/init", "POST /payments/webhook/stripe"],
    x: 516,
    y: 130,
  },
  {
    id: "shipping",
    name: "shipping-svc",
    port: "8085",
    db: "miad_shipping",
    role: "Zones local / continent / international. Tarifs repris de shipping-utils.ts, stockés en base au lieu d'être codés en dur.",
    publishes: [],
    consumes: [],
    tables: ["shipping_zones"],
    sample: ["GET /shipping-rates", "GET /shipping-rates/quote"],
    x: 640,
    y: 130,
  },
  {
    id: "notification",
    name: "notification-svc",
    port: "8087",
    db: "miad_notification",
    role: "Consommateur pur : push web + email. S'il tombe, les commandes continuent ; il rattrape son retard via les offsets Kafka.",
    publishes: [],
    consumes: ["order.created", "order.status_changed", "payment.confirmed", "payment.failed"],
    tables: ["notifications"],
    sample: ["GET /notifications/stats"],
    x: 590,
    y: 360,
  },
];

export const INCIDENTS = [
  {
    date: "29 juil. 2026",
    tag: "404 silencieux",
    tone: "alert" as const,
    title: "Panne silencieuse totale",
    body: "Tous les endpoints du plugin produits ont répondu 404 pendant des heures, sans erreur visible côté site : chaque page boutique affichait simplement « aucun produit ». Cause probable : un Code Snippet réactivé côté WP Admin, invisible depuis le frontend.",
    fix: "Health-check natif par service + scripts/system-check.sh qui agrège les 7 : une panne se voit en une commande, pas en heures de pages vides.",
  },
  {
    date: "récurrent",
    tag: "403 anti-bot",
    tone: "warn" as const,
    title: "Blocage SiteGround selon le User-Agent",
    body: "Les images et logos vendeurs servis depuis api.miadmarket.com renvoient un 403 selon le User-Agent du visiteur — confirmé : UA desktop bloqué, UA mobile accepté, même fichier. Un proxy dédié /api/image-proxy existe uniquement pour contourner ça.",
    fix: "Images déjà sur R2 + CDN Cloudflare : conservées telles quelles, plus aucun asset ne transite par l'hébergeur PHP.",
  },
  {
    date: "récurrent",
    tag: "filtrage WPML",
    tone: "warn" as const,
    title: "L'API filtre silencieusement par langue",
    body: "L'include= de WooCommerce filtre par langue courante sans le dire : envoyer 100 IDs produit renvoie tantôt 50, tantôt 25, sans erreur ni documentation. La pagination frontend compense à l'aveugle (page vide = fin de liste, jamais de taille fixe).",
    fix: "Pagination explicite et documentée : page, page_size, total, has_more. Le frontend ne devine plus jamais la fin d'une liste.",
  },
];

export const GOALS = [
  "Rapide : Go compilé, plus de PHP interprété par requête",
  "Services indépendamment scalables et déployables",
  "Images/CDN sur l'infra Cloudflare déjà en place (R2 + CDN)",
  "Erreurs explicites partout, health-check natif par service",
  "Même contrat d'API côté frontend, autant que possible",
];

export const CONSTRAINTS = [
  "Couvrir 100 % des fonctionnalités existantes — aucune régression visible côté acheteur ou vendeur",
  "Le frontend Next.js n'est pas réécrit : seules les routes app/api/* changent de backend cible",
  "Les données existantes (catalogue, boutiques, commandes) sont importées depuis WooCommerce/Dokan — jamais recréées à la main",
];

export const STACK = [
  { layer: "Services", choice: "Go", why: "Un binaire compilé par domaine métier" },
  { layer: "RPC interne", choice: "gRPC + Protobuf", why: "Contrats stricts et typés entre services" },
  { layer: "Passerelle externe", choice: "grpc-gateway", why: "REST/JSON généré depuis les mêmes .proto — le frontend ne voit rien" },
  { layer: "Base de données", choice: "PostgreSQL × 7", why: "Une base par service, jamais partagée" },
  { layer: "Bus d'événements", choice: "Kafka", why: "Découplage asynchrone, rejeu depuis les offsets" },
  { layer: "Cache & sessions", choice: "Redis", why: "Fiches produit très lues + sessions JWT partagées" },
  { layer: "Images", choice: "R2 (existant)", why: "Bucket miadr2 déjà en place, zéro migration d'assets" },
  { layer: "CDN", choice: "Cloudflare (existant)", why: "Reste devant R2 et le frontend" },
];

export const LEDGER = {
  kept: [
    ["Frontend Next.js 15", "aucune réécriture — app/api/* pointe vers la passerelle"],
    ["Images produits/boutiques (R2)", "bucket miadr2 inchangé"],
    ["CDN Cloudflare", "reste devant R2 et le frontend"],
    ["Stripe / PayDunya", "intégrés dans payment-svc au lieu de PHP"],
    ["Recherche sémantique (Vectorize)", "appelée depuis catalog-svc"],
  ],
  dropped: [
    ["WordPress / WooCommerce / Dokan", "remplacés par les 7 services"],
    ["WPML", "traduction FR/EN modélisée nativement (trid/lang)"],
    ["SiteGround (hébergement PHP)", "retiré"],
  ],
};

export const TABLES = [
  { name: "vendors", svc: "vendor-svc", content: "Boutique : nom, slug, logo/bannière (URL R2), pays, note, statut vérifié" },
  { name: "products", svc: "catalog-svc", content: "Champs de base + trid (groupe de traduction) + lang (fr/en) — paire de lignes liées" },
  { name: "product_variations", svc: "catalog-svc", content: "Prix/stock par variation (tailles, couleurs…), FK product_id en interne" },
  { name: "categories", svc: "catalog-svc", content: "Hiérarchie (parent_id), mêmes trid/lang que products pour les noms bilingues" },
  { name: "orders", svc: "order-svc", content: "Statut, référence client, adresses, lignes — une sous-commande par boutique" },
  { name: "payments", svc: "payment-svc", content: "Référence Stripe/PayDunya, montant, devise, statut — lié à order_id SANS FK SQL" },
  { name: "customers", svc: "auth-svc", content: "Compte acheteur : email, téléphone, adresses sauvegardées, méthode OTP" },
  { name: "shipping_zones", svc: "shipping-svc", content: "Reprend ZONE_SHIPPING_RATES / COUNTRY_TO_ZONE — stocké, plus codé en dur" },
  { name: "reviews", svc: "catalog-svc", content: "Note + commentaire, lié à une commande (anti-faux avis, vérifié via order-svc)" },
  { name: "coupons", svc: "order-svc", content: "Code, type de remise, montant, date d'expiration, compteur d'usages" },
];

export interface Endpoint {
  method: "GET" | "POST" | "PUT";
  path: string;
  svc: string;
  desc: string;
}

export const ENDPOINTS: Endpoint[] = [
  { method: "GET", path: "/products", svc: "catalog-svc", desc: "liste + filtres (catégorie, vendeur, recherche, langue, pagination explicite)" },
  { method: "GET", path: "/products/:id", svc: "catalog-svc", desc: "fiche produit + variations + variante liée (autre langue du trid)" },
  { method: "GET", path: "/products/:id/similar", svc: "catalog-svc", desc: "via Vectorize — inchangé, rebranché en phase 3" },
  { method: "GET", path: "/categories", svc: "catalog-svc", desc: "arbre complet, bilingue" },
  { method: "GET", path: "/search/suggestions", svc: "catalog-svc", desc: "recherche mot-clé as-you-type" },
  { method: "GET", path: "/stores", svc: "vendor-svc", desc: "liste des boutiques vérifiées" },
  { method: "GET", path: "/vendor/:id/products", svc: "vendor-svc", desc: "catalogue d'un vendeur — délégation à catalog-svc, erreur explicite si injoignable" },
  { method: "POST", path: "/vendor/products", svc: "catalog-svc", desc: "création produit simple ou variable — transaction locale, paire trid, publie product.created" },
  { method: "PUT", path: "/vendor/profile", svc: "vendor-svc", desc: "logo, bannière, coordonnées boutique" },
  { method: "GET", path: "/vendor/orders", svc: "vendor-svc", desc: "commandes reçues par ce vendeur — délégation à order-svc" },
  { method: "POST", path: "/orders", svc: "order-svc", desc: "crée la commande (éclatée par boutique), publie order.created — payment-svc l'écoute" },
  { method: "GET", path: "/orders/:id", svc: "order-svc", desc: "détail + statut de suivi" },
  { method: "POST", path: "/orders/:id/confirm-stripe", svc: "payment-svc", desc: "webhook Stripe/PayDunya → publie payment.confirmed" },
  { method: "GET", path: "/shipping-rates", svc: "shipping-svc", desc: "tarifs par zone/pays, détail de calcul explicite" },
  { method: "POST", path: "/auth/otp/send", svc: "auth-svc", desc: "envoi code par SMS/email — renvoie une référence opaque, jamais le code" },
  { method: "POST", path: "/auth/otp/verify", svc: "auth-svc", desc: "échange code → session Redis + JWT" },
  { method: "GET", path: "/customer", svc: "auth-svc", desc: "profil + historique commandes (appel vers order-svc)" },
  { method: "GET", path: "/admin/stats", svc: "transverse", desc: "agrège plusieurs services (ventes, vendeurs, produits)" },
  { method: "GET", path: "/admin/system-check", svc: "transverse", desc: "statut clair par service et par dépendance — le point qui manquait sous WordPress" },
];

export const FEATURES = [
  { title: "Marketplace multi-vendeurs", body: "Chaque produit appartient à une boutique (ex-Dokan) ; commandes éclatées par boutique côté vendeur." },
  { title: "Bilingue FR/EN par paires de lignes", body: "Modèle trid/lang natif dans catalog-svc — pas de traduction automatique à la volée." },
  { title: "Produits variables", body: "Tailles/couleurs avec prix et stock indépendants par variation." },
  { title: "Livraison par zone", body: "Tarif local / même continent / international, déjà modélisé dans shipping-utils.ts." },
  { title: "Paiement double", body: "Stripe (carte) et PayDunya (Wave, Orange Money, XOF) en parallèle, choix au checkout." },
  { title: "Recherche à deux niveaux", body: "Mot-clé rapide pour l'auto-complétion, sémantique Vectorize pour l'assistant IA et les recommandations." },
  { title: "Outils vendeur", body: "Tableau de bord, gestion produits/commandes, upload photo direct vers R2." },
  { title: "Outils admin", body: "Audit catalogue, statistiques, gestion vendeurs, vérification système." },
  { title: "Notifications", body: "Push web (commandes, messages) et email transactionnel, en consommateur pur Kafka." },
];

export const PHASES = [
  {
    n: "01",
    title: "Socle : infra + catalog-svc",
    body: "Cluster ou conteneurs gérés, Postgres, Kafka, Redis provisionnés. Premier service écrit : catalog-svc (produits, catégories) en lecture seule, exposé via la passerelle. Aucun trafic réel encore.",
    gate: "Gate : /products et /categories répondent avec la même forme JSON que WooCommerce, sur données importées en dev.",
  },
  {
    n: "02",
    title: "Import ponctuel WooCommerce → Postgres",
    body: "Script qui lit wc/v3/products, dokan/v1/stores, wc/v3/orders et écrit dans les bases de catalog/vendor/order-svc — réutilise la logique de lecture déjà présente dans lib/woo-server.ts. Le trid WPML est copié tel quel.",
    gate: "Gate : comptages source = comptages cible, par langue, sur les trois entités.",
  },
  {
    n: "03",
    title: "Bascule lecture, écriture encore sur WordPress",
    body: "app/api/products, /categories, /stores basculent vers catalog-svc / vendor-svc : le plus gros volume de trafic, le risque le plus faible — lecture seule.",
    gate: "Gate : une semaine de trafic réel sans écart de rendu constaté côté frontend.",
  },
  {
    n: "04",
    title: "Services d'écriture : order, payment, auth",
    body: "Topics Kafka déployés (order.created, payment.confirmed…), bascule de la création de commande, du paiement, de la connexion OTP. WordPress reste accessible en lecture seule au cas où.",
    gate: "Gate : commandes de bout en bout (Stripe + PayDunya) encaissées et notifiées sur le nouveau backend.",
  },
  {
    n: "05",
    title: "shipping-svc + notification-svc",
    body: "Derniers services, branchés en consommateurs Kafka purs — risque le plus faible car aucun autre service n'en dépend en synchrone.",
    gate: "Gate : devis de livraison identiques à shipping-utils.ts, notifications livrées avec rejeu vérifié.",
  },
  {
    n: "06",
    title: "Extinction WordPress",
    body: "Après deux semaines sans incident sur le nouveau backend : résiliation SiteGround, archivage final de la base MySQL.",
    gate: "Gate : scripts/system-check.sh au vert 14 jours d'affilée + sauvegarde MySQL archivée hors ligne.",
  },
];

export const OUT_OF_SCOPE = [
  "Refonte du frontend Next.js — reste tel quel, seul le backend change",
  "Migration des images déjà sur R2 — seules les références en base changent de source",
  "Nouvelles fonctionnalités produit — ce projet reproduit l'existant, n'en ajoute pas",
  "Migration DHL / suivi colis avancé — dans un second temps, une fois le socle stable",
];

export const DEPLOY_STEPS = [
  { cmd: "curl -fsSL https://get.docker.com | sh", note: "Docker ≥ 24 sur un VPS vierge (2 vCPU / 4 Go min.)" },
  { cmd: "git clone git@github.com:MIAD/miad-backend.git && cd miad-backend", note: "Le dépôt contient services, contrats, infra et scripts" },
  { cmd: "go mod tidy", note: "Génère go.sum — requis pour le build des images Docker" },
  { cmd: "cp .env.example .env && nano .env", note: "POSTGRES_PASSWORD, JWT_SECRET, clés Stripe / PayDunya" },
  { cmd: "docker compose up -d --build", note: "Postgres 16 (7 bases créées au 1er boot) + Redis + Kafka KRaft + 7 services + Caddy" },
  { cmd: "bash scripts/system-check.sh", note: "Le point qui manquait sous WordPress : un statut clair par service et par dépendance" },
];

export const COMPOSE_STACK = [
  { c: "postgres:16-alpine", role: "7 bases dédiées (deploy/init-db.sh au premier boot)", expose: "127.0.0.1:5432" },
  { c: "redis:7-alpine", role: "Cache catalogue + sessions OTP/JWT", expose: "127.0.0.1:6379" },
  { c: "bitnami/kafka:3.7", role: "Bus KRaft single-node — managé Upstash possible", expose: "127.0.0.1:9092" },
  { c: "7 × services Go", role: "Un binaire compilé, image ~15 Mo sur alpine", expose: "8081 → 8087 (localhost)" },
  { c: "caddy:2-alpine", role: "Passerelle externe — l'URL que pointe app/api/*", expose: "80 / 443" },
];

export const PROMPT = `Construis un backend de remplacement pour MIAD Market (marketplace e-commerce africaine),
sans WordPress, en suivant exactement les sections 3 à 6 du document "Backend sans WordPress" :

- Stack : Go, architecture microservices. gRPC + Protobuf pour la communication interne
  entre services, grpc-gateway pour exposer une façade REST/JSON identique au contrat
  actuel de app/api/*. Kafka comme bus d'événements asynchrones entre services.
  Redis pour le cache et les sessions. PostgreSQL, une base par service (jamais partagée).
  R2 + CDN Cloudflare inchangés pour les images.
- Crée sept services indépendants (section 3) : catalog-svc, vendor-svc, order-svc,
  payment-svc, shipping-svc, auth-svc, notification-svc - chacun avec son propre schema
  Postgres (section 4 : vendors, products, product_variations, categories, orders,
  payments, customers, shipping_zones, reviews, coupons), son propre binaire Go, son
  propre Dockerfile.
- Modèle de traduction : trid (id de groupe) + lang (fr/en) sur products et categories,
  paire de lignes liées dans catalog-svc - jamais de colonnes name_fr/name_en côte à côte.
- Définis les contrats .proto par service AVANT d'écrire la logique métier - ils sont
  la source de vérité du contrat inter-service ET du contrat REST généré par
  grpc-gateway consommé par le frontend Next.js.
- Implémente les routes listées en section 5 avec exactement la même forme de réponse
  JSON que les routes Next.js actuelles dans app/api/**/route.ts (lis-les une par une
  avant d'écrire chaque endpoint équivalent).
- Déclare les topics Kafka documentés section 3 (order.created, payment.confirmed,
  payment.failed, product.updated, vendor.registered, order.status_changed,
  customer.registered) et branche payment-svc + notification-svc en consommateurs.
- Réutilise lib/shipping-utils.ts (COUNTRY_TO_ZONE, ZONE_SHIPPING_RATES) tel quel pour
  peupler shipping_zones - ne recalcule pas ces tarifs.
- Intègre Stripe et PayDunya directement dans payment-svc (plus de relais PHP).
- Ajoute un endpoint /admin/system-check qui teste chaque dépendance de chaque service
  (Postgres, Kafka, Redis, Stripe, PayDunya) et renvoie un statut clair par service - le
  point qui manquait complètement sous WordPress (voir section 1, incident du
  29 juillet 2026).
- Suis le plan de migration en 6 phases de la section 7 : un service à la fois, jamais
  d'écriture basculée tant que la lecture seule correspondante n'est pas validée en
  production.
- Ne touche pas au frontend Next.js au-delà de changer l'URL cible dans les routes
  app/api/* (vers la passerelle grpc-gateway).
- Signale explicitement toute fonctionnalité de la section 6 que tu ne peux pas
  reproduire à l'identique, avant de l'implémenter différemment.
- Signale aussi tout endroit où la cohérence éventuelle entre services (au lieu de
  transactions SQL) crée un risque réel (ex : commande créée sans confirmation de
  paiement) et propose une gestion explicite de ce cas avant de continuer.`;

export const STATS = [
  { value: 7, suffix: "", label: "services Go indépendants" },
  { value: 19, suffix: "", label: "routes contractualisées ici" },
  { value: 80, suffix: "+", label: "routes Next.js à couvrir" },
  { value: 70, suffix: "+", label: "boutiques actives à migrer" },
];
