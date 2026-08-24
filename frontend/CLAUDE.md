# Agent MIAD Market — Instructions & Mémoire

Ce fichier est la mémoire de l'agent Claude pour le projet MIAD Market.
Lire ce fichier en entier avant toute action sur les produits.

---

## gstack

gstack (skill pack Claude Code, installé globalement dans `~/.claude/skills/gstack`) est disponible pour ce projet.
Pour toute navigation web (tester le site, scraper une page, QA), utiliser le skill `/browse` de gstack — ne jamais utiliser les outils `mcp__claude-in-chrome__*`.

Skills disponibles : `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`,
`/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`,
`/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`, `/retro`, `/investigate`,
`/document-release`, `/document-generate`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`,
`/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`, `/health`, `/spec`, `/skillify`, `/scrape`, `/diagram`, `/make-pdf`.

---

## Rôle de l'agent

Tu es l'assistant technique du fondateur de **MIAD Market**, une marketplace e-commerce africaine.
Ta mission principale : **créer, modifier et maintenir les fiches produit WooCommerce** via des scripts locaux,
sans jamais modifier la base de données directement ni passer par l'interface WordPress Admin.

Tout passe par :
1. Le script CLI `scripts/miad.mjs` (commandes produits)
2. Le plugin WordPress `woocommerce-snippets/miad-products-api.php` (endpoints REST)

---

## Architecture en bref

- **Frontend** : Next.js 14 App Router → Cloudflare Pages → `miadmarket.com`
- **Backend** : WordPress + WooCommerce → `api.miadmarket.com`
- **Images** : Cloudflare R2 → `cdn.miadmarket.com`
- **Multilingue** : WPML (fr/en)
- **Vendeurs** : Dokan (marketplace multi-vendeurs)
- **Référence complète** : voir `ARCHITECTURE.md`

---

## Script principal — `scripts/miad.mjs`

Toutes les opérations produits passent par ce script unique.
Il lit automatiquement `.env.local` pour `MIAD_PRODUCTS_API` et `MIAD_PRODUCTS_SECRET`.

```bash
# Créer un produit simple
node scripts/miad.mjs create \
  --name "Nom du produit" \
  --price 8500 \
  --vendor <VENDOR_ID> \
  --category "Bijoux" \
  --image https://cdn.miadmarket.com/... \
  --status publish

# Créer un produit variable (avec variations de prix/quantité)
node scripts/miad.mjs create-variable \
  --name "Nom du produit" \
  --vendor <VENDOR_ID> \
  --image https://cdn.miadmarket.com/... \
  --attr "Commande" \
  --variation "1 pièce:15000" \
  --variation "3 pièces:40000" \
  --variation "5 pièces:60000"

# Synchroniser images → R2/CDN (obligatoire après création)
node scripts/miad.mjs sync <id1> <id2> ...

# Voir liens + image CDN d'un produit
node scripts/miad.mjs links <id1> <id2> ...

# Réassigner vendeur
node scripts/miad.mjs set-author --vendor <VENDOR_ID> <id1> <id2> ...

# Changer image vedette
node scripts/miad.mjs set-image --product <id> --image https://cdn.miadmarket.com/...

# Changer prix de variations
node scripts/miad.mjs set-price --price 9000 <variation-id1> <variation-id2> ...

# Vider le cache WooCommerce
node scripts/miad.mjs clear-cache <id1> <id2> ...

# Renommer un produit
node scripts/miad.mjs rename --id <id> --name "Nouveau nom"

# Aide complète
node scripts/miad.mjs --help
```

---

## Workflow — Créer une fiche produit

### Étape 1 — Préparer l'image

Si l'image est déjà sur R2/CDN : utiliser directement `https://cdn.miadmarket.com/...`

Si l'image est locale (JPG/PNG reçu du vendeur) :
```bash
npx wrangler r2 object put miadr2/<chemin/image.jpg> \
  --file ./image.jpg --remote \
  --account-id 5e8fd042542e85a3f38cba06304ed5c0
```
L'URL CDN devient : `https://cdn.miadmarket.com/<chemin/image.jpg>`

### Étape 2 — Créer le produit

```bash
node scripts/miad.mjs create --name "..." --price ... --vendor ... --image https://... \
  --name-en "..." --description-en "..."
```

Note : `create` = produit simple (un seul prix).
`create-variable` = produit avec plusieurs prix selon la quantité commandée.

**Toujours fournir `--name-en` / `--description-en`** (et `--short-desc-en` si
une description courte est utilisée) — demandé le 2026-07-25 : chaque produit
doit avoir une vraie traduction anglaise, pas seulement le français. Ces
flags créent automatiquement une traduction WPML liée à l'original (voir
`/create` et `/create-variable` dans `miad-products-api.php` —
`miad_products_api_create_translation_en()`), en réutilisant les mêmes
images/prix/catégorie que la version FR. Pas de traduction automatique côté
script : c'est à l'agent de traduire lui-même le nom/la description avant de
lancer la commande (décision du 2026-07-25 — pas de dépendance à un service
de traduction externe). Pour `create-variable`, ajouter `--variation-en
"label fr:label en"` seulement pour les labels qui ont vraiment besoin
d'être traduits (ex: "1 pièce:1 piece") — les tailles numériques n'ont pas
besoin de cette option, elles restent identiques dans les deux langues.

### Étape 3 — Synchroniser les miniatures

Obligatoire : WooCommerce a besoin de miniatures 150x150, 300x300, etc. sur CDN.

```bash
node scripts/miad.mjs sync <product-id>
```

Résultat attendu : `sizes_synced=8` (ou plus), `r2_state=UPLOADED`

### Étape 4 — Vérifier

```bash
node scripts/miad.mjs links <product-id>
```

---

## Toutes les boutiques (71 vendeurs)

> Les emails ne sont pas exposés par l'API Dokan publique. Pour les obtenir : WP Admin → Dokan → Vendeurs.
> Pour ajouter l'email d'un vendeur ici, le noter dans la colonne "Email" après consultation WP Admin.

### Vendeurs prioritaires (boutiques avec produits créés)

| ID | Boutique | Propriétaire | Ville | Pays | Email |
|----|----------|-------------|-------|------|-------|
| **95** | **MALAÏKA'S HOUSE** | DAGHA FABIOLE ARISCA | Yaoundé | CM | — |
| **48** | **Nadjoa beads** | Portia NanaAdjoa Amanor | Accra | GH | — |

### Toutes les boutiques — par ordre d'inscription

| ID | Boutique | Propriétaire | Ville | Pays | Slug | Inscrit |
|----|----------|-------------|-------|------|------|---------|
| 17 | Ayzha Cosmetics | Seynabou DIAO | Dakar | SN | ayzha-cosmetics | 2025-11-21 |
| 18 | Mamaniboutique | Katy SYLLA | Dakar | SN | mamaniboutique | 2025-11-22 |
| 20 | Naby Gold | Khaly DIACK | Tivaouane | SN | naby-gold | 2025-11-27 |
| 22 | Café Touba Mame Fatou | Mame Fatou Niang | Dakar | SN | cafe-touba-mame-fatou | 2025-11-29 |
| 24 | I'Dool | Oly DIENG | Dakar | SN | idool | 2025-12-02 |
| 25 | Thilor design | Badou MBAYE | Tivaouane | SN | thilor-design | 2025-12-18 |
| 26 | MAC Collection | El Hadji Cheikh SAMB | Tivaouane | SN | mac-collection | 2025-12-18 |
| 27 | MOFOUNGOUROU Galerie d'Art | Souleymane Bah | — | GN | mofoungourou-galerie-d-art | 2025-12-24 |
| 29 | ALL store | Company ABM | — | — | brunel | 2025-12-30 |
| 32 | Perles De Lux | Perles | Isheri Oshun | NG | perles-de-lux | 2026-01-20 |
| 33 | nana_coutureofficial | Yahya Awahu | — | NG | nana-coutureofficial | 2026-01-23 |
| 41 | AdaH | Adama Diallo | Conakry | GN | adama | 2026-01-27 |
| 42 | MŪHEBA | Mouhibath Seidou | Accra | GH | mouhibath | 2026-01-28 |
| 45 | la maison des delices | Djenabou Kolon Diallo | — | — | djenabou | 2026-01-28 |
| 46 | Pure bio by Nastou | Nastou Konaté | Conakry | GN | konate | 2026-01-29 |
| **48** | **Nadjoa beads** | **Portia NanaAdjoa Amanor** | **Accra** | **GH** | portia | **2026-01-30** |
| 49 | Styleworld | Nana Plyce | Accra | GH | nanaplyce | 2026-01-30 |
| 50 | noblesse sn | noblesse sn | — | SN | noblessesn | 2026-02-03 |
| 53 | Fatoumata'store | Fatoumata BA | — | — | fatoumataba1 | 2026-02-04 |
| 54 | La Petite Damba | Sâa Michel Koundouno | — | — | lapetitedamba | 2026-02-05 |
| 55 | Les Épices de Maëlle | Mara Fatoumata | — | GN | maelleepice | 2026-02-06 |
| 56 | AKatty-by Echour | Aminé Echour | Guinée | GN | akatty | 2026-02-06 |
| 57 | Africa Art center | Mohamed Camara | — | GN | africaart1 | 2026-02-06 |
| 58 | Komara et frères | Bangaly Kaba | — | GN | bangaly1 | 2026-02-06 |
| 59 | Boiro création | Boiro Mamadou Dialigué | Conakry | GN | mamadoudialigue | 2026-02-06 |
| 61 | COFAPP | Alarény Diallo | — | GN | cofapp | 2026-02-07 |
| 62 | Thierno textile | Thierno Mahmoud Bah | — | GN | thierno | 2026-02-07 |
| 65 | ADJI BIO ET SERVICES | Hadjiratou Barry | — | GN | barry | 2026-02-07 |
| 66 | COSAAN GROUPE | Fatou Thiam Diop | Dakar | — | cosaan-groupe | 2026-02-08 |
| 68 | Teranga Infusion | Ndeye Astou Sarr | Dakar | SN | infusion-locale | 2026-02-08 |
| 73 | Bio kya | Dr Rokhy THIAM | — | SN | bio-kya | 2026-02-09 |
| 75 | la Petite Attou | Diarra Bousso Ndao | Dakar | SN | attou | 2026-02-10 |
| 76 | Diouma | Diouma Diouf | Dakar | SN | diouma | 2026-02-10 |
| 77 | Dabo filitex | Tidiane Dabo | — | — | dabo-filitex | 2026-02-10 |
| 79 | Awa | Awa Thiam | Dakar | SN | awa-thiam | 2026-02-11 |
| 81 | MAGUY SN | Maguette Samb | Dakar | SN | maguy-sn | 2026-02-11 |
| 82 | waxtu | Alexis Waxtu | Dakar | SN | waxtu | 2026-02-11 |
| 83 | Mamis Ba | Mamis Ba | Dakar | SN | mamis-ba | 2026-02-11 |
| 84 | Mes perles By Awa | Awa Thiam | Dakar | SN | mes-perles-by-awa | 2026-02-11 |
| 85 | Mame Babacar Business | Fatima Diop | Dakar | SN | mame-babacar-business | 2026-02-12 |
| 86 | Tawa mboudaye acajou | Babacar Loum | Dakar | SN | loum | 2026-02-12 |
| 87 | BK by Yacine | Yacine GUEYE | Dakar | SN | bk-by-yacine | 2026-02-12 |
| 88 | Ets Bio distribution (Elobio & LAQUINA) | NGOULOURE ELEONORE NDADEM | — | CM | ets-bio-distribution-bu-elobio-laquina | 2026-02-13 |
| 90 | chez bio distribution | Nzakou Jules A Ndefo | — | CM | ndefo-nzakou-jules-a | 2026-02-13 |
| 91 | Djibril Trading | Djibril Mbao | — | SN | djibril123 | 2026-02-13 |
| 94 | Lebou Agro | Adji Salimata Gningue | — | SN | salimata | 2026-02-23 |
| **95** | **MALAÏKA'S HOUSE** | **DAGHA FABIOLE ARISCA** | **Yaoundé** | **CM** | dagha-fabiole-arisca | **2026-02-26** |
| 98 | Complexe yayou Naby business | Khady Ndiaye | — | SN | complexe-yayou-naby-business | 2026-02-27 |
| 101 | Georgine wax | Georgine Hounvou | Cotonou | BJ | georginehounvougmail-com | 2026-03-06 |
| 104 | I &M Chic création | Mariama Diallo | Conakry | GN | i-m-chic-creation | 2026-03-07 |
| 105 | Adore ESSENTIALS | Coumba Mbaye | Dakar | SN | adore-essentials | 2026-03-07 |
| 106 | Blings_by_ze | Zeinabb Moradeyo Abdullahi | Suleja, Niger | NG | abdullahimoradeyogmail-com | 2026-03-07 |
| 107 | BarryAfricaincaaps | Sadou Barry | Dakar | SN | marquebarryafricaincaaps | 2026-03-08 |
| 108 | Sahel Natura | Marie Louise Anssibaty Manga | Dakar | SN | sahel-natura | 2026-03-08 |
| 109 | Lipton Café Touba | Ndeye Arise Diop | Dakar | SN | lipton-cafe-touba | 2026-03-08 |
| 110 | maktaba assahaba | Mouhamed Khoutbou Ndaw | Dakar | SN | maktaba-assahaba | 2026-03-08 |
| 111 | Fadhilou hijab | Ndiaye Dior | Dakar | SN | fadhilou-hijab | 2026-03-08 |
| 112 | Galerie Fon Amonmi | Ronaldo HOUESSOU | Cotonou | BJ | galerie-fon-amonmi | 2026-03-08 |
| 113 | complexe-yayou-naby-business (2) | Khady Ndiaye | Dakar | SN | complexe-yayou-naby-business-2 | 2026-03-08 |
| 118 | EAAP TIM VIP AFRICAINE | Savadogo OUSMANE | — | SN | vip-africaine | 2026-03-13 |
| 120 | Wall Art Print | Maodo SY Mbaye | — | SN | maodo-sy-mbaye | 2026-03-13 |
| 121 | Bijouterie Dabakh | Makhtar Thiam Ndiaga | — | SN | thiam-ndiaga | 2026-03-13 |
| 122 | jamta-sport | Ndiaye Marie Louise | — | — | marie-louise | 2026-03-13 |
| 123 | atelier MK | KPATENON Houéfa Merveille | Cotonou | BJ | merveille-kpatenon | 2026-03-13 |
| 124 | garellemode | MONGBE Sèlomé Dorcas | Cotonou | BJ | selome-dorcas | 2026-03-13 |
| 125 | Fallou mode | Fallou Diaw | Dakar | SN | fallou-diaw | 2026-03-18 |
| 126 | Fall | Fall Abibatou | Dakar | SN | abibatou-fall | 2026-03-19 |
| 137 | MAHU STORE | ATEKOSSI Brunel | Dakar | SN | brunel-atekossi | 2026-05-12 |
| 142 | attiale | — | Abidjan | CI | attiale | 2026-05-20 |
| 143 | RicardoDesign | Lafouet Ricardo Ngoulla | — | CM | ricardodesign | 2026-05-30 |
| 144 | (sans nom) | Jores GBODOGBE | — | — | gbodogbejores5 | 2026-06-17 |

> **Note** : Les boutiques gras (ID 48 et 95) sont celles avec lesquelles on a déjà travaillé.
> Pays : SN=Sénégal, GN=Guinée, GH=Ghana, CM=Cameroun, BJ=Bénin, NG=Nigeria, CI=Côte d'Ivoire

---

## Catégories produits

Toujours utiliser une catégorie existante — ne jamais en créer une nouvelle.
Dans les scripts, utiliser le **nom exact** (colonne "Nom à utiliser dans --category").

### Catégories principales (actives, avec produits)

| ID | Nom à utiliser dans --category | Nb produits | Sous-catégories principales |
|----|-------------------------------|------------|----------------------------|
| 4476 | Mode - Vêtements | 451 | Pagnes, Sacs, Vêtements Homme/Femme, Chaussures |
| 4479 | Bijoux - Accessoires | 191 | Accessoires Mode, Bijoux Artisanaux Africains |
| 4477 | Beauté - Soin Naturel | 123 | Soin Visage, Cheveux, Huiles, Parfums |
| 4481 | Artisanat - Art Africain | 77 | Tableaux, Sculpture, Vannerie |
| 4478 | Alimentation - Épicerie | 45 | Épices, Boissons, Céréales |
| 4480 | Maison - Décoration | 9 | Décoration Africaine, Ustensiles |
| 4482 | Bébé - Enfant | 3 | Vêtements bébé, Jouets |
| 4483 | Santé - Bien-être | 1 | Plantes médicinales, Compléments |

### Arborescence complète

```
Mode - Vêtements (4476) — 451 produits
├── Pagnes - Tissus Africains (4486) — 68
├── Sacs - Maroquinerie (4491) — 52        ← sacs, pochettes, tote bags
├── Vêtements Homme (4488) — 46
├── Chaussures - Sandales (4490) — 24
├── Vêtements Femme (4487) — 15
└── Vêtements Enfant (4489) — 0

Bijoux - Accessoires (4479) — 191 produits
├── Accessoires Mode (4505) — 144          ← ceintures, écharpes, lunettes…
├── Bijoux Artisanaux Africains (4503) — 12 ← colliers, bracelets, boucles cauris
└── Bijoux Fantaisie (4504) — 0

Beauté - Soin Naturel (4477) — 123 produits
├── Soin Visage - Corps (4493) — 46
├── Soin Cheveux Naturels (4492) — 32
├── Huiles - Beurres Naturels (4495) — 9
├── Parfums - Encens (4497) — 2
├── Savons Artisanaux (4494) — 0
└── Cosmétiques - Maquillage (4496) — 0

Artisanat - Art Africain (4481) — 77 produits
├── Tableaux - Peintures (4512) — 52
├── Sculpture - Statuettes (4510) — 15
├── Vannerie - Paniers (4511) — 7
└── Textile Artisanal (4513) — 0

Alimentation - Épicerie (4478) — 45 produits
├── Épices - Condiments (4498) — 26
├── Boissons - Infusions (4500) — 7
├── Céréales - Légumineuses (4499) — 6
├── Produits Transformés (4501) — 4
└── Fruits - Légumes Séchés (4502) — 0

Maison - Décoration (4480) — 9 produits
├── Décoration Africaine (4506) — 5
├── Ustensiles de Cuisine (4507) — 1
├── Literie - Textiles Maison (4508) — 0
└── Bougies - Aromathérapie (4509) — 0

Bébé - Enfant (4482) — 3 produits
├── Vêtements Bébé (4514)
├── Jouets - Éveil (4515)
└── Puériculture (4516)

Santé - Bien-être (4483) — 1 produit
├── Plantes Médicinales (4517)
├── Compléments Naturels (4518)
└── Hygiène - Soins (4519)

Électronique - Tech (4484) — 0 produits
├── Téléphones - Accessoires (4520)
├── Informatique - Tablettes (4521)
└── Audio - Vidéo (4522)

Services - Formation (4485) — 0 produits
├── Formations en Ligne (4523)
└── Services Professionnels (4524)
```

### Guide rapide — quelle catégorie choisir ?

| Type de produit | Catégorie à utiliser |
|----------------|---------------------|
| Sac, pochette, tote bag | `Sacs - Maroquinerie` |
| Pagne, tissu wax, kente, bogolan | `Pagnes - Tissus Africains` |
| Collier, bracelet, bague, boucles (artisanat) | `Bijoux Artisanaux Africains` |
| Collier, bracelet fantaisie (non artisanal) | `Bijoux - Accessoires` |
| Robe, ensemble, tenue femme | `Vêtements Femme` |
| Tenue homme, boubou | `Vêtements Homme` |
| Crème, savon, huile corps/visage | `Soin Visage - Corps` |
| Shampoing, huile capillaire | `Soin Cheveux Naturels` |
| Tableau, peinture | `Tableaux - Peintures` |
| Statue, sculpture | `Sculpture - Statuettes` |
| Épices, piments, condiments | `Épices - Condiments` |
| Thé, café, infusion | `Boissons - Infusions` |
| Décoration maison | `Décoration Africaine` |

---

## Plugin WordPress — `woocommerce-snippets/miad-products-api.php`

Ce fichier est la **source de vérité** du plugin. Il est déployé via le plugin WordPress **Code Snippets**.

### Déploiement après modification
1. Copier le contenu du fichier
2. Aller sur WP Admin → Code Snippets → trouver "MIAD Products API"
3. Coller le nouveau contenu → Sauvegarder et activer
4. Demander confirmation "DEJA" avant de lancer les scripts

### Endpoints disponibles

| Endpoint | Script | Rôle |
|----------|--------|------|
| `POST /create` | `create` | Produit simple |
| `POST /create-variable` | `create-variable` | Produit variable + variations |
| `POST /set-image` | `set-image` | Changer image vedette (bypass WPML) |
| `POST /set-variation-price` | `set-price` | Changer prix variation (bypass WPML) |
| `POST /set-author` | `set-author` | Réassigner vendeur |
| `POST /sync-thumbnails` | — | Sync par attachment ID (ancien) |
| `POST /sync-product-images` | `sync` | Sync par product ID (nouveau, préféré) |
| `POST /clear-cache` | `clear-cache` | Vider cache WooCommerce |
| `POST /permalinks` | `links` | Liens + image CDN |
| `POST /update-name` | `rename` | Renommer produit |

---

## Règles importantes

### Images
- **Toujours** syncer après création : `node scripts/miad.mjs sync <id>`
- Les images doivent être sur `cdn.miadmarket.com`, pas `api.miadmarket.com`
- Ne jamais utiliser les URLs `/wp-content/uploads/...` dans les scripts (elles sont supprimées après upload R2)
- Le bug historique : `miad_r2_sync_attachment()` supprimait les dérivés sans les uploader → CORRIGÉ dans le plugin actuel

### Logos vendeurs (Dokan) — NE PAS migrer vers le CDN

**Ne jamais lancer `/sync-thumbnails` sur un attachment de logo/bannière vendeur Dokan.**
Contrairement aux images produits, le champ `gravatar` renvoyé par
`/wp-json/dokan/v1/stores` n'est **pas** recalculé dynamiquement via
`wp_get_attachment_url()` — il continue de pointer vers l'ancienne URL locale
`api.miadmarket.com/wp-content/uploads/...` même après un sync R2 réussi
(vérifié le 2026-07-04 : `/wp-json/wp/v2/media/{id}` reflète bien le CDN,
mais `dokan/v1/stores[].gravatar` non, pour ce même attachment).

**Incident du 2026-07-04 :** un test de migration sur la boutique MALAÏKA'S
HOUSE (vendor 95) a supprimé le fichier local du logo (`miad_r2_sync_attachment`
supprime l'original après upload R2), causant un 404 en direct sur le site —
réparé via le nouvel endpoint `/restore-local-copy` (télécharge depuis R2 et
réécrit le fichier à son chemin d'origine). Diagnostic plus poussé :
`dokan_profile_settings['gravatar']` stocke un **attachment ID** (ex: 20807
pour vendor 95) résolu on ne sait comment par Dokan — probablement pas via
les mêmes hooks que WooCommerce/WP core, sans qu'on ait accès au code qui
gère ça (`miad-r2-offload.php` est volontairement absent de ce dépôt).

**Conclusion :** tant qu'on n'a pas identifié le mécanisme exact utilisé par
Dokan pour cette URL, ne pas retenter cette migration — le gain de vitesse
ne justifie pas le risque de casser une boutique à chaque tentative.
Les endpoints `/restore-local-copy` et `/vendor-store-info` (diagnostic en
lecture seule) restent disponibles dans le plugin si besoin d'investiguer
plus tard.

**Reconfirmé le 2026-07-14** sur la boutique RicardoDesign (vendor 143,
attachment 37668) : `/sync-thumbnails` uploade bien vers R2 et supprime le
fichier local (confirmé par un 404 immédiat sur l'ancienne URL), mais
`dokan/v1/stores/{id}.gravatar` continue de renvoyer l'ancienne URL locale
(désormais cassée) — **identique avant et après un vidage de cache**
(`wp_cache_delete`/`clean_post_cache` sur l'attachment), ce qui écarte
l'hypothèse d'un simple cache périmé : Dokan reconstruit cette URL depuis le
chemin local sans jamais passer par un mécanisme sensible au filtre R2/CDN.
La piste API officielle Dokan (`PUT /wp-json/dokan/v1/stores/{id}`) est
bloquée par une 401 avec nos identifiants WooCommerce actuels (Basic Auth
consumer key/secret non acceptés par cet endpoint). Fichier restauré à
chaque test via `/restore-local-copy` — aucune casse laissée en production.

**Solution retenue (2026-07-14) — override manuel, pas de migration :**
plutôt que de dépendre de Dokan, `miad-vendor-api.php` expose désormais :
- Une page **WP Admin → Images Vendeurs** : par boutique, un bouton
  "Synchroniser vers R2" (récupère l'URL CDN de l'attachment logo/bannière)
  + un champ où coller cette URL + Enregistrer. Stocke l'URL dans les meta
  utilisateur `_miad_logo_override_url` / `_miad_banner_override_url`.
- Un endpoint public en lecture `GET /vendor-image-overrides` (pas de
  secret — juste des URLs déjà publiques) que `app/api/stores/route.ts`
  interroge et fusionne avec la liste Dokan : si un override existe pour un
  vendeur, il remplace le `gravatar`/`banner` (cassé) renvoyé par Dokan.
- Aucune suppression de fichier local déclenchée par ce chemin — la
  synchronisation R2 déclenchée depuis cette page utilise toujours
  `/sync-thumbnails` en interne (donc supprime bien le local, comme documenté
  ci-dessus), mais le site ne dépend plus de ce que Dokan en fait ensuite.

**Depuis le 2026-08-07**, plus besoin de passer par cette page WP Admin pour
poser logo/bannière : `POST /wp-json/miad-products/v1/set-vendor-images`
(secret partagé, mêmes en-têtes que les autres endpoints `miad-products/v1`)
écrit directement dans les deux meta ci-dessus. Utiliser :

```bash
node scripts/miad.mjs set-vendor-images --vendor <ID> --logo https://cdn.miadmarket.com/... --banner https://cdn.miadmarket.com/...
```

La page WP Admin reste disponible (utile en secours / vérification visuelle),
mais n'est plus le seul chemin.

### Header dupliqué au scroll (intermittent, non résolu)

QA du 2026-07-05 sur la page boutique vendeur : observé une fois 2 vraies
balises `<header>` dans le DOM (confirmé via `document.querySelectorAll('header').length === 2`,
capturé en screenshot — un second bandeau recherche/devise/connexion/panier
flottant au milieu de la page, par-dessus la bannière "MIAD Express"),
reproductible aussi bien sur l'accueil que sur la page vendeur.

Le HTML servi par le serveur (`curl` brut) ne contient qu'**un seul** `<header>`,
et `<Header>` n'est importé/rendu qu'à un seul endroit dans tout le code
(`app/MiadMarketClient.tsx:1061`) — donc ce n'est pas un doublon stable côté
React/JSX. Sur plusieurs tentatives de reproduction ultérieures (délais avant/après
scroll variés), la plupart du temps un seul `<header>` réel était présent — un
signe de bug d'hydratation React transitoire (mismatch serveur/client qui se
répare tout seul), pas un rendu dupliqué permanent. Cause exacte non identifiée
dans `components/miad/Header.tsx` (pas de `Date.now()`, valeur aléatoire, ou
accès direct à `window` en dehors d'un `useEffect`).

**Décision (2026-07-05) :** mis de côté pour l'instant — trop rare/intermittent
pour justifier le temps d'investigation immédiat. À reprendre si le bug devient
plus fréquent ou visible pour les clients.

### Liens directs produit/boutique (corrigé le 2026-07-07)

Bug trouvé par QA le 2026-07-07 : `app/page.tsx` lisait le search param `view`,
alors que **tous** les liens internes utilisent `v` (`/?v=product&slug=X`,
`/?v=vendor&slug=X` — voir `MiadMarketClient.tsx` `handleProductClick`/
`handleVendorClick`). Résultat : `forcedView` était toujours `undefined` sur un
chargement direct (lien partagé, favori, actualisation de page, nouvel onglet),
donc la page retombait sur l'accueil sans erreur visible — reproductible aussi
bien via clic réel dans l'app (marche) que via URL directe (échouait).

Corrigé : `page.tsx` lit maintenant `v` (+ `slug`), mappe `v=vendor` → la vraie
valeur interne `View` qui est `'store'` (pas `'vendor'`), et passe
`forcedProductSlug`/`forcedVendorSlug` à `MiadMarketClient`. Pour les produits,
un fallback fetch (`/api/products?slug=`) rattrape le cas où le produit n'est
pas dans les 100 premiers `initialProducts` chargés côté serveur. Pour les
boutiques, pas de fallback équivalent : `forcedVendorSlug` ne résout que parmi
les 100 premiers `initialStores` — un lien direct vers une boutique au-delà de
ce rang affichera encore un skeleton indéfiniment (limitation connue, pas
encore corrigée).

### Prix des produits : `--price` est en dollars US réels, pas en FCFA

**Découverte le 2026-07-25**, en préparant la création de produits pour un
vendeur nigérian payé en naira. Contrairement à ce que ce fichier disait
jusqu'ici, `--price`/`--cost` ne sont **pas** en FCFA : ils sont stockés
**tels quels, sans aucune conversion**, dans le champ `_price`/`_regular_price`
de WooCommerce — vérifié à trois niveaux concordants :
1. Code source : `miad-products-api.php` fait juste
   `$product->set_regular_price((string) $price)`, aucun calcul.
2. Produits réels en base : ex. produit 39478 → `price: "16"`, produit 39774
   → `price: "37.78"` — des montants clairement à l'échelle du dollar (pas du
   FCFA, où un article ne coûterait jamais "16").
3. Frontend : `contexts/CurrencyContext.tsx` traite explicitement le prix
   stocké comme un montant USD (`formatPrice(usdAmount)`) et le multiplie par
   un taux (FCFA ≈ 600 par défaut, ou une valeur admin dynamique) **au moment
   de l'affichage**, pour n'importe laquelle des 8 devises proposées par
   `CurrencySelector.tsx` (USD, CAD, EUR, GBP, FCFA, MAD, GHS, GNF) — le site
   n'affiche donc plus "que du FCFA" comme l'affirmait cette section avant
   correction.

**Donc : toujours entrer `--price`/`--cost` en dollars US réels** (ex. un
tissu à 40$ → `--price 40`, pas `--price 24000`).

Certains vendeurs (diaspora) donnent leurs prix en **dollars canadiens (CAD)**
ou d'autres devises locales (naira, cedi...). **Toujours convertir
automatiquement en USD** avant de créer/modifier un produit — jamais laisser
un montant non-USD tel quel, et jamais faire le calcul à la main pour le CAD
(taux fixe câblé, voir ci-dessous) ; pour les autres devises, chercher un taux
actuel et le faire confirmer par le fondateur avant de convertir.

Taux CAD → USD câblé dans `scripts/miad.mjs` (constante `CAD_TO_USD_RATE`,
valeur 0.71, mise à jour le 2026-07-25 — corrige un bug où l'ancien taux
CAD→FCFA à 450 aurait produit un prix ~630x trop élevé s'il avait été
utilisé ; aucun produit publié n'a heureusement ce défaut, vérifié sur tout
le catalogue avant correction).

```bash
node scripts/miad.mjs create --name "..." --price-cad 45 --vendor ...
node scripts/miad.mjs create-variable --name "..." --variation-cad "1 pièce:35" --variation-cad "10 pièces:38"
node scripts/miad.mjs set-price --price-cad 45 <variation-id>
```

Si le taux de change réel change significativement, mettre à jour
`CAD_TO_USD_RATE` dans `scripts/miad.mjs` ET cette valeur ici.

### Produits WPML
- Ne jamais modifier les images via `PUT /wc/v3/products/{id}` → risque d'écrasement par WPML
- Toujours passer par `/miad-products/v1/set-image` ou `miad.mjs set-image`

### Variations
- Ne jamais modifier les prix via WC batch → risque d'écrasement par WPML
- Toujours passer par `/miad-products/v1/set-variation-price` ou `miad.mjs set-price`

### Scripts locaux
- Les scripts s'exécutent localement et appellent directement `api.miadmarket.com`
- Ne jamais passer par les routes Next.js `/api/...`
- Timeout de 90 secondes par produit (opérations longues : génération + upload R2)

---

## Scripts disponibles dans `scripts/`

| Fichier | Rôle |
|---------|------|
| `miad.mjs` | **CLI tout-en-un** (toujours utiliser celui-ci) |
| `sync-thumbnails.mjs` | Sync miniatures des 10 SAC+POCHETTE VIP (attachments 39854-39863) |
| `sync-product-images.mjs` | Sync images par ID produit (supplanté par `miad.mjs sync`) |
| `clear-cache-sacs.mjs` | Vide cache des 10 SAC VIP (IDs 39774-39810) |
| `list-sacs-links.mjs` | Liens des 10 SAC VIP |
| `create-malaakas-sacs.mjs` | Création des 10 SAC+POCHETTE VIP |

---

## Produits créés — Historique

### Boutique MALAÄKA'S HOUSE (vendor 95)

| ID produit | Nom | Motif | Statut images |
|-----------|-----|-------|--------------|
| 39774 | SAC+POCHETTE VIP — Denim & Kente Soleil | Denim & Kente Soleil | ✅ CDN synced |
| 39778 | SAC+POCHETTE VIP — Nuit Bogolan Géo | Nuit Bogolan Géo | ✅ CDN synced |
| 39782 | SAC+POCHETTE VIP — Rouge Wax Éclair | Rouge Wax Éclair | ✅ CDN synced |
| 39786 | SAC+POCHETTE VIP — Bordeaux Kente Fleur | Bordeaux Kente Fleur | ✅ CDN synced |
| 39790 | SAC+POCHETTE VIP — Chocolat Bogolan | Chocolat Bogolan | ✅ CDN synced |
| 39794 | SAC+POCHETTE VIP — Denim Splash Arc-en-ciel | Denim Splash | ✅ CDN synced |
| 39798 | SAC+POCHETTE VIP — Naturel Kente Mandala | Naturel Kente | ✅ CDN synced |
| 39802 | SAC+POCHETTE VIP — Caramel Arabesque | Caramel Arabesque | ✅ CDN synced |
| 39806 | SAC+POCHETTE VIP — Nuit Kente Soleil | Nuit Kente Soleil | ✅ CDN synced |
| 39810 | SAC+POCHETTE VIP — Orange Soleil Arabesque | Orange Soleil | ✅ CDN synced |

### Boutique Portia NanaAdjoa Amanor (bijoux)

| ID produit | Nom | Statut images |
|-----------|-----|--------------|
| 39478 | Collier Artisanal Perles Noires et Coquillages Cauris | ✅ CDN synced |
| 39475 | L'Appel de la Sirène — Bracelet Manchette à Coquillages | ✅ CDN synced |
| 39472 | Bague Spirale Dorée et Coquillage Cauris | ✅ CDN synced |
| 39469 | Murmures de l'Océan — Boucles d'Oreilles à Coquillages Cauris | ✅ CDN synced |
| 39463 | Boucles d'Oreilles Artisanales « Nadjoa Beads » | ✅ CDN synced |
| 39509 | Ensemble Collier et Boucles d'Oreilles « Élégance Artisanale » | ✅ CDN synced |
| 39411 | Toghu Cameroun's style | ✅ CDN synced |

### Boutique Asoebi_by_nana (vendor 33, ex-"nana_coutureofficial", Lagos NG)

Onboarding du 2026-07-26 : vendeur déjà existant (compte créé le 2026-01-23,
même email/adresse), boutique renommée depuis "nana_coutureofficial". 4 types
de tissus reçus par WhatsApp (Ankara Stoned Super Wax Glitter, Swiss Voil
Lace, Dentelle Appliquée, VIP Vanety Cotton), prix donnés en naira nigérian
— convertis en USD (le fondateur a choisi cette devise plutôt que FCFA, voir
la section "Prix des produits" plus haut). **Un produit par photo reçue**
(demande explicite du fondateur, pas une galerie groupée) → 40 produits au
total, IDs 42353–42590 (FR + traduction EN automatique pour chacun),
catégorie `Pagnes - Tissus Africains`, images sur
`cdn.miadmarket.com/whatsapp-onboarding/nana/...`.

---

## Recherche sémantique & recommandations IA (Vectorize + Workers AI)

En cours de mise en place (juillet 2026) — recherche sémantique produits + "produits similaires" en s'appuyant sur l'infra Cloudflare existante (Pages), sans nouveau service à héberger.

### Infra Cloudflare

- **Vectorize** : index `miad-products` (1024 dims, cosine) — créé via `wrangler vectorize create`.
- **Workers AI** : modèle `@cf/baai/bge-m3` (multilingue, 100+ langues dont le français — ne pas utiliser un modèle `-en-` comme `bge-base-en-v1.5`, le catalogue est rédigé en français).
- Bindings déclarés dans `wrangler.jsonc` (`AI`, `VECTORIZE`) — actifs uniquement sur le déploiement Cloudflare Pages réel (no-op en `next dev` local, comme `CATALOG_KV`).

### Endpoint — `app/api/admin/embeddings/route.ts`

Génère les embeddings du vrai catalogue WooCommerce (pas de données mock) et les upsert dans Vectorize. Protégé par le header `X-Internal-Secret` (= `INTERNAL_API_SECRET`).

Appelé via :

```bash
node scripts/miad.mjs sync-embeddings --all        # tout le catalogue publié
node scripts/miad.mjs sync-embeddings 39478 39475  # produits spécifiques
```

Nécessite `MIAD_SITE_URL` (défaut `https://miadmarket.com`) — c'est le seul cas où un script local appelle une route Next.js plutôt que WordPress directement, car les bindings AI/Vectorize n'existent que côté Cloudflare Pages.

### Correctif — assistant IA (`app/api/chat/ai/route.ts`)

`search_products` interrogeait auparavant des données générées localement (`allProducts` dans `lib/woocommerce.ts`, marqué "replace with real WooCommerce REST API calls" dans le code) au lieu du vrai catalogue. Corrigé : appelle désormais directement `wp-json/wc/v3/products` (WOO_CONSUMER_KEY/SECRET).

### État — juillet 2026

Les 5 phases prévues sont livrées :

1. ✅ `/api/search/semantic` (embed requête → query Vectorize → fallback recherche mot-clé) — branché dans l'assistant IA (`app/api/chat/ai/route.ts`).
2. ✅ "Produits similaires" sur la fiche produit (`components/miad/SimilarProducts.tsx`, endpoint `/api/products/[id]/similar` — nearest-neighbors du vecteur déjà stocké, pas besoin de ré-embedder).
3. ✅ Personnalisation légère (`lib/recommendations.ts` : similarité sémantique sur le dernier produit vu via `getRecentlyViewedIds()`, avant repli sur l'heuristique catégorie+popularité). Toujours pas de D1.
4. ✅ Automatisation : `.github/workflows/sync-embeddings.yml` — ré-embed le catalogue publié chaque nuit (02h UTC) en appelant `/api/admin/embeddings` avec `{"all": true}`. **Nécessite un secret GitHub Actions `INTERNAL_API_SECRET`** (Settings → Secrets and variables → Actions), même valeur que dans `.env.local` — pas encore configuré, le workflow échouera tant que ce n'est pas fait.

Bug corrigé en route : `vectorize.query()` attend `returnMetadata: "none" | "indexed" | "all"`, pas un booléen (`true`/`false` casse la requête avec `VECTOR_QUERY_ERROR 40026`).

Logique partagée dans `lib/woo-catalog.ts` (accès WooCommerce) et `lib/cloudflare-ai.ts` (bindings AI/Vectorize) — à réutiliser pour toute nouvelle fonctionnalité IA plutôt que dupliquer les fetch WooCommerce.

---

## Correctifs & nouveautés — 11 au 14 juillet 2026

### Bug critique corrigé — filtrage produits par catégorie

`app/api/products/route.ts` envoyait le **slug** de catégorie tel quel au
paramètre `category` de `wc/v3/products`, qui attend en réalité un **ID de
terme**. Résultat : les bannières catégories (accueil ET page catégorie)
retombaient systématiquement sur une liste vide ou incohérente (repli
temporaire sur les produits déjà en mémoire côté client, remplacé ensuite
par la vraie requête — cassée — une fois revenue). Corrigé : le slug est
maintenant résolu en ID via `wc/v3/products/categories?slug=...` avant
l'appel. Impacte `CategoryPage.tsx` et les bannières catégorie de l'accueil.

### Outillage d'audit de classification produits

Nouveaux endpoints/commandes pour vérifier que les produits sont dans la
bonne catégorie (le `/audit/scan` existant ne signalait que les produits
**sans** catégorie, pas les mal classés) :
- `GET /audit/categories` (`miad-audit-api.php`) — liste tous les produits
  publiés avec leur(s) catégorie(s) et vendeur, une seule requête SQL.
- `node scripts/miad.mjs audit-categories [--out fichier.json]` — répartition
  par catégorie + détection heuristique (mots-clés du titre vs catégorie
  assignée, voir `CATEGORY_HINTS` dans `miad.mjs`) des incohérences à vérifier.
- `node scripts/miad.mjs set-category --category "Nom" <id...>` — réassigne
  la catégorie de un ou plusieurs produits (wrapper autour de
  `/update-product`, déjà existant).
- `node scripts/miad.mjs set-category-image --category-id <id> --image <url>`
  — définit l'image de bannière d'une catégorie WooCommerce (direct wc/v3,
  Basic Auth — pas de risque WPML connu sur les images de catégorie,
  contrairement aux produits). **Important** : WooCommerce télécharge et
  héberge localement l'image fournie (même si l'URL donnée est déjà sur le
  CDN) — toujours lancer `/sync-thumbnails` sur l'attachment résultant
  ensuite pour la repasser sur R2/CDN (sinon elle reste sur
  `api.miadmarket.com/wp-content/uploads/...`, non souhaité).

### Bannières de catégories — nouvelle direction artistique

Nouveau style validé le 2026-07-11 : **photo éditoriale premium** (photo
réaliste, fond studio coloré par catégorie, bandeau vert de marque
`#005826` avec le nom de la catégorie). Généré via Canva (MCP), 6 des 8
catégories principales déjà en place sur le site (Mode - Vêtements, Bijoux
- Accessoires, Beauté - Soin Naturel, Artisanat - Art Africain, Maison -
Décoration, Alimentation - Épicerie). Restent à faire : Bébé - Enfant,
Santé - Bien-être, + les ~34 sous-catégories. Le gabarit de prompt complet
(couleur de fond + sujet par catégorie/sous-catégorie) est dans le fichier
de travail `category-banner-prompts.md` (scratchpad de session, à
régénérer si besoin — pas versionné dans le repo). Pipeline d'intégration :
upload R2 manuel (`wrangler r2 object put`) → `set-category-image` →
`/sync-thumbnails` sur l'attachment résultant (même remarque que ci-dessus).

### Prefetch au survol étendu à tout le site

La "stratégie AliExpress" (précharger les données au survol pour un
affichage instantané au clic) n'était câblée que dans `CategoryPage.tsx` et
`CountrySection.tsx`. Elle est maintenant intégrée **directement dans
`ProductCard.tsx`** (le composant partagé utilisé partout : accueil,
recherche, ticker...), donc active automatiquement partout sans
duplication. Prefetch boutique (`prefetchStore`/`prefetchStoreProducts`)
ajouté aussi à `BrandDayBanner.tsx`. Ces fonctions restent volontairement
**locales à chaque fichier** (pas de lib partagée) — préférence explicite
du fondateur.

### Proxy anti-blocage SiteGround pour les images boutique

Confirmé le 2026-07-13 : les logos/bannières vendeur encore hébergés en
direct sur `api.miadmarket.com` (volontairement pas sur le CDN, voir plus
haut) peuvent déclencher le blocage anti-bot SiteGround selon le
User-Agent du visiteur (403 reproduit avec un UA desktop, 200 avec un UA
mobile, pour la même image). Nouvelle route `app/api/image-proxy/route.ts`
qui récupère l'image côté serveur (en transmettant le User-Agent réel du
visiteur) et la sert depuis `miadmarket.com` — `lib/image-utils.ts`
(`proxyIfLocalWp`) réécrit automatiquement les URLs `api.miadmarket.com`
vers ce proxy dans `LazyImage` et partout où un logo/bannière vendeur est
rendu via `next/image` en direct (`HomePage`, `CountryPage`,
`BrandDayBanner`, `ProductTicker`, `VendorStoreWrapper`, `ProductDetail`).

### Override manuel logo/bannière vendeur (voir section Dokan ci-dessus)

Page **WP Admin → Images Vendeurs** (`miad-vendor-api.php`) + endpoint
`GET /vendor-image-overrides` + fusion dans `app/api/stores/route.ts`. Voir
le détail dans la section "Logos vendeurs (Dokan)" plus haut.

### Inscription vendeur désactivée

Demandé le 2026-07-13 : plus personne ne peut créer un compte vendeur
depuis le site. Bloqué à deux niveaux — sélecteur de type de compte retiré
de `RegisterPage.tsx` (tout le monde s'inscrit comme acheteur), et
`app/api/auth/otp/verify/route.ts` refuse explicitement
`account_type=vendor` (403) pour qu'un appel API direct ne contourne pas le
blocage. La connexion des vendeurs déjà inscrits n'est pas affectée
(`LoginPage.tsx` n'envoie pas `account_type`). Création de compte vendeur
toujours possible manuellement via `node scripts/miad.mjs create-vendor`
ou `create-vendor` (`miad-vendor-api.php`).

### Sélecteur de langue FR/EN masqué

Demandé le 2026-07-14 : masqué dans `components/miad/Header.tsx` (commenté,
pas supprimé — à réactiver en retirant le commentaire JSX autour du bloc
"Switcher FR / EN"). Le site reste en français par défaut.

### Flux Google Merchant Center / Google Shopping — déjà en place

`app/merchant-feed/route.ts` (exposé en `/merchant-feed.xml` via une
réécriture dans `next.config.mjs`) génère un flux RSS + namespace Google
(`g:id`, `g:price`, `g:image_link`, `g:availability`, `g:brand`, etc.) à
partir du vrai catalogue WooCommerce. Vérifié fonctionnel le 2026-07-14 :
627 produits, prix cohérents (échelle USD — le champ `_price` WooCommerce
du catalogue est bien en USD, la conversion FCFA n'existe que côté
affichage frontend). Pour l'utiliser avec Google Ads/Shopping : soumettre
cette URL dans Google Merchant Center (configuration côté compte Google, pas
de code à écrire côté agent) — le flux se revalide tout seul (cache 1h).

## Variables d'environnement (`.env.local`)

```
MIAD_PRODUCTS_API=https://api.miadmarket.com/wp-json/miad-products/v1
MIAD_PRODUCTS_SECRET=<secret>
MIAD_SITE_URL=https://miadmarket.com
```

---

*Mis à jour : 25 juillet 2026*
