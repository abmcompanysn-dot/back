-- ============================================================
-- fix-variable-products.sql — nettoyage des produits variables abîmés
-- (attributs pa_* jamais renommés + valeurs = term_id WooCommerce +
-- variations dupliquées), catalog-svc / base miad_catalog.
--
-- Diagnostic et consignes : session 2026-08-28 avec le fondateur.
--
-- USAGE :
--   Dry-run (voir ce qui SERA fait, ROLLBACK à la fin) :
--     psql ... -v apply=0 -f fix-variable-products.sql
--   Application réelle :
--     psql ... -v apply=1 -f fix-variable-products.sql
--
--   Sur le VPS :
--     kubectl -n miad exec -i deploy/postgres-0 -- \
--       psql -U miad -d miad_catalog -v apply=0 < scripts/fix-variable-products.sql
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- Garde-fou : si -v apply n'est pas fourni, on force le dry-run.
\if :{?apply}
\else
  \set apply 0
\endif

\echo ''
\echo '════════════════════════════════════════════════════════'
\echo '  AVANT — état des produits ciblés'
\echo '════════════════════════════════════════════════════════'
SELECT v.product_id, p.name, v.id AS var_id, v.attributes, v.price_usd, v.stock
FROM product_variations v JOIN products p ON p.id = v.product_id
WHERE v.product_id IN (360,364,365,366,367,368,624,628,651,652,653,654,655,658,659,661,663,
                       672,674,675,683,694,696,697,698,699,707,709,711,824)
ORDER BY v.product_id, v.id;

-- ─────────────────────────────────────────────────────────────
-- 1. RENOMMAGE DE CLÉS + REMAP DE VALEURS (term_id → libellé)
--    On reconstruit l'objet attributes proprement par produit.
-- ─────────────────────────────────────────────────────────────

-- helper : remplace une clé K1 par K2 dans le JSONB, en remappant la
-- valeur via une table de correspondance passée en JSON.
-- (fait inline ci-dessous, pas de fonction pour rester portable)

-- 360 — Ensemble NAOMI : pa_taille→Taille ; 100=Grande taille, 95=Petite taille
UPDATE product_variations SET attributes =
  jsonb_build_object('Taille',
    CASE attributes->>'pa_taille'
      WHEN '100' THEN 'Grande taille'
      WHEN '95'  THEN 'Petite taille'
      ELSE attributes->>'pa_taille' END)
WHERE product_id = 360 AND attributes ? 'pa_taille';

-- 624 & 628 — Sacs vendeur 42 : Motif/pa_motif→Taille ; 996=Grand 997=Moyen 998=Petit
-- Les libellés "Motif 1/2/3" résiduels sont des doublons de l'ancienne
-- nomenclature → on les supprime d'abord.
DELETE FROM product_variations
WHERE product_id IN (624,628)
  AND coalesce(attributes->>'pa_motif', attributes->>'Motif') LIKE 'Motif %';
UPDATE product_variations SET attributes =
  jsonb_build_object('Taille',
    CASE coalesce(attributes->>'pa_motif', attributes->>'Motif')
      WHEN '996' THEN 'Grand'
      WHEN '997' THEN 'Moyen'
      WHEN '998' THEN 'Petit'
      ELSE coalesce(attributes->>'pa_motif', attributes->>'Motif') END)
WHERE product_id IN (624,628) AND (attributes ? 'pa_motif' OR attributes ? 'Motif');

-- 651,652,653,654,655,658,661,663 — Poudres vendeur 46 : Poids ; 1163=Grand 1164=Moyen 1165=Petit
UPDATE product_variations SET attributes =
  jsonb_build_object('Poids',
    CASE coalesce(attributes->>'pa_poids', attributes->>'Poids')
      WHEN '1163' THEN 'Grand'
      WHEN '1164' THEN 'Moyen'
      WHEN '1165' THEN 'Petit'
      ELSE coalesce(attributes->>'pa_poids', attributes->>'Poids') END)
WHERE product_id IN (651,652,653,654,655,658,661,663)
  AND (attributes ? 'pa_poids' OR attributes ? 'Poids');

-- 659 — Poudre Girofle/Gingembre/Curcuma : Poids ; 1163=1.5kg 1164=1kg 1165=500g
--        (les libellés "1.5kg"/"1kg"/"500g" existent déjà en double → on les garde,
--         on remappe les term_id vers les mêmes libellés puis on dédoublonne plus bas)
UPDATE product_variations SET attributes =
  jsonb_build_object('Poids',
    CASE coalesce(attributes->>'pa_poids', attributes->>'Poids')
      WHEN '1163' THEN '1.5kg'
      WHEN '1164' THEN '1kg'
      WHEN '1165' THEN '500g'
      ELSE coalesce(attributes->>'pa_poids', attributes->>'Poids') END)
WHERE product_id = 659 AND (attributes ? 'pa_poids' OR attributes ? 'Poids');

-- 672,674,675 — Tissus Guinée vendeur 48 : on SUPPRIME les variations term_id
--   (motif numérique 1104-1116, 1110-1111) et on garde les PAG-… en nettoyant
--   le libellé à tirets.
DELETE FROM product_variations
WHERE product_id IN (672,674,675)
  AND (attributes->>'Motif') ~ '^[0-9]{3,4}$';

-- 674 : supprime aussi les 2 doublons anglais (Diamond Pattern / Radiant Circular)
--   déjà couverts par motif-losanges / motif-circulaire-rayonnant
DELETE FROM product_variations
WHERE product_id = 674 AND (attributes->>'Motif') IN ('Diamond Pattern','Radiant Circular Pattern');

-- Nettoyage libellés à tirets → phrase lisible (Capitalize + espaces)
UPDATE product_variations SET attributes =
  jsonb_build_object('Motif',
    initcap(replace(regexp_replace(attributes->>'Motif', '^(motif|pag)[- ]?', '', 'i'), '-', ' ')))
WHERE product_id IN (672,674,675) AND (attributes->>'Motif') LIKE '%-%';

-- 683 — Chemise textile Guinée : recrée Taille L/XL/XXL (on efface l'existant term_id)
DELETE FROM product_variations WHERE product_id = 683;
INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
SELECT 683, p.sku, jsonb_build_object('Taille', t), p.price_usd, 50,
       COALESCE((p.images->>0), '')
FROM products p, unnest(ARRAY['L','XL','XXL']) AS t
WHERE p.id = 683;

-- 694 — Têtes de bus : pa_finition→Taille ; 1014=Grand 1015=Petit
-- On supprime d'abord les variations de finition "Noir"/"Ébène" (hors
-- périmètre : on ne garde que la taille), PUIS on remappe.
DELETE FROM product_variations
WHERE product_id = 694 AND (attributes->>'pa_finition') IN ('Noir','Ébène');
UPDATE product_variations SET attributes =
  jsonb_build_object('Taille',
    CASE attributes->>'pa_finition'
      WHEN '1014' THEN 'Grand'
      WHEN '1015' THEN 'Petit'
      ELSE attributes->>'pa_finition' END)
WHERE product_id = 694 AND attributes ? 'pa_finition';

-- 696 — tam tam : Taille ; 1007=Grand 1008=Petit
UPDATE product_variations SET attributes =
  jsonb_build_object('Taille',
    CASE attributes->>'Taille'
      WHEN '1007' THEN 'Grand'
      WHEN '1008' THEN 'Petit'
      ELSE attributes->>'Taille' END)
WHERE product_id = 696 AND (attributes->>'Taille') ~ '^[0-9]{3,4}$';

-- 697 — statue nimba : Taille ; 1004=Grand 1006=Petit
UPDATE product_variations SET attributes =
  jsonb_build_object('Taille',
    CASE attributes->>'Taille'
      WHEN '1004' THEN 'Grand'
      WHEN '1006' THEN 'Petit'
      ELSE attributes->>'Taille' END)
WHERE product_id = 697 AND (attributes->>'Taille') ~ '^[0-9]{3,4}$';

-- 698,699 — Chemises Indigo vendeur 52 :
--   pa_manches→Manches (1000=Courtes 1001=Longues) ; Taille recréée L/XL/XXL ;
--   attribut pa_couleur SUPPRIMÉ (chemise indigo = 1 couleur).
DELETE FROM product_variations WHERE product_id IN (698,699);
INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
SELECT p.id, p.sku,
       jsonb_build_object('Manches', m, 'Taille', t),
       p.price_usd, 50, COALESCE((p.images->>0), '')
FROM products p,
     unnest(ARRAY['Courtes','Longues']) AS m,
     unnest(ARRAY['L','XL','XXL'])      AS t
WHERE p.id IN (698,699);

-- 707,709,711 — Tableaux Guinée : pa_motif→Motif ; 996-999 = Motif 1-4
UPDATE product_variations SET attributes =
  jsonb_build_object('Motif',
    CASE coalesce(attributes->>'pa_motif', attributes->>'Motif')
      WHEN '996' THEN 'Motif 1'
      WHEN '997' THEN 'Motif 2'
      WHEN '998' THEN 'Motif 3'
      WHEN '999' THEN 'Motif 4'
      ELSE coalesce(attributes->>'pa_motif', attributes->>'Motif') END)
WHERE product_id IN (707,709,711) AND (attributes ? 'pa_motif' OR attributes ? 'Motif');

-- 824 — Chemise blanche coton : garde les 5 variations "propres" (celles SANS
--   pa_pays/pa_couleur), supprime les 5 avec les term_id parasites,
--   normalise taille→Taille et 'l'→'L'.
DELETE FROM product_variations
WHERE product_id = 824 AND (attributes ? 'pa_pays' OR attributes ? 'pa_couleur');
UPDATE product_variations SET attributes =
  jsonb_build_object('Taille', upper(attributes->>'taille'))
WHERE product_id = 824 AND attributes ? 'taille';

-- 364-368 — Robes Djezner : on efface tout et on recrée 13 tailles "N ans"
DELETE FROM product_variations WHERE product_id IN (364,365,366,367,368);
INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
SELECT p.id, p.sku, jsonb_build_object('Taille', n || ' ans'), p.price_usd, 50,
       COALESCE((p.images->>0), '')
FROM products p, generate_series(3,15) AS n
WHERE p.id IN (364,365,366,367,368);

-- ─────────────────────────────────────────────────────────────
-- 2. DÉDOUBLONNAGE des variations identiques (même product_id + attributes)
--    Garde la plus petite id, supprime les autres. Couvre 659, 707/709/711,
--    et tous les autres doublons hérités de l'import (voir diagnostic section C).
-- ─────────────────────────────────────────────────────────────
DELETE FROM product_variations a
USING product_variations b
WHERE a.product_id = b.product_id
  AND a.attributes = b.attributes
  AND a.id > b.id;

-- ─────────────────────────────────────────────────────────────
-- 3. PRODUITS SANS IMAGE → inactifs (invisibles sur le site)
-- ─────────────────────────────────────────────────────────────
UPDATE products SET status = 'inactive', updated_at = now()
WHERE id IN (747, 1486, 1544, 1624)
  AND status = 'active';

-- ─────────────────────────────────────────────────────────────
-- 4. Marquer is_variable correctement (un produit sans variation ne doit
--    pas rester "variable")
-- ─────────────────────────────────────────────────────────────
UPDATE products p SET is_variable = FALSE
WHERE p.is_variable = TRUE
  AND NOT EXISTS (SELECT 1 FROM product_variations v WHERE v.product_id = p.id);

\echo ''
\echo '════════════════════════════════════════════════════════'
\echo '  APRÈS — nouvel état des produits ciblés'
\echo '════════════════════════════════════════════════════════'
SELECT v.product_id, p.name, v.id AS var_id, v.attributes, v.price_usd, v.stock
FROM product_variations v JOIN products p ON p.id = v.product_id
WHERE v.product_id IN (360,364,365,366,367,368,624,628,651,652,653,654,655,658,659,661,663,
                       672,674,675,683,694,696,697,698,699,707,709,711,824)
ORDER BY v.product_id, v.id;

\echo ''
\echo '-- produits désactivés (sans image) --'
SELECT id, name, status FROM products WHERE id IN (747,1486,1544,1624);

\echo ''
\if :apply
  \echo '>>> apply=1 : COMMIT des changements.'
  COMMIT;
\else
  \echo '>>> apply=0 (dry-run) : ROLLBACK, rien nest modifié. Relancer avec -v apply=1 pour appliquer.'
  ROLLBACK;
\endif
