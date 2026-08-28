-- ============================================================
-- fix-variable-products-en.sql — même nettoyage que
-- fix-variable-products.sql, pour les TRADUCTIONS ANGLAISES.
--
-- Les produits EN portent les mêmes term_id parasites (1163, 996, 1000…)
-- mais avec des clés déjà "propres" (Weight/Pattern/Color/Sleeves/Finish/
-- Size). On remappe vers des libellés ANGLAIS cohérents avec la version FR
-- corrigée le 2026-08-28.
--
-- USAGE :
--   Dry-run  : psql ... -v apply=0 -f fix-variable-products-en.sql
--   Réel     : psql ... -v apply=1 -f fix-variable-products-en.sql
--   VPS      : kubectl -n miad exec -i deploy/postgres-0 -- \
--                psql -U miad -d miad_catalog -v apply=0 < scripts/fix-variable-products-en.sql
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

\if :{?apply}
\else
  \set apply 0
\endif

-- IDs EN concernés (via trid, cf. diagnostic 2026-08-28)
--   1516,1518            = Tiger Nut Powder            (Weight)  → FR 651/652
--   1517,1520,1521,1523,1527,1529 = autres poudres    (Weight)  → FR 653/654/655/658/661/663
--   1524                = Clove/Ginger/Turmeric Powder (Weight)  → FR 659 (1.5kg/1kg/500g)
--   1489,1494           = sacs                          (Pattern) → FR 624/628 (Grand/Moyen/Petit → Large/Medium/Small)
--   1566               = Tetes de Bus                  (Finish)  → FR 694 (Large/Small)
--   1568               = Tam-Tam                        (Size)    → FR 696 (Large/Small)
--   1569               = Statue nimba                   (Size)    → FR 697 (Large/Small)
--   1570               = Indigo Shirt Signature         (Color)   → FR 699 (attribut Color supprimé)
--   1571               = Signature Indigo Shirt No.2    (Color,Size,Sleeves) → FR 698 (recréé L/XL/XXL + Short/Long)
--   1551               = Chemise Textile Guinéen        (Size)    → FR 683 (L/XL/XXL)
--   1580,1582,1583     = tableaux/table                 (Pattern) → FR 709/707/711 (Pattern 1-4)
--   1237-1241          = robes Djezner EN               (Size)    → FR 364-368 (3→15 years)

\echo ''
\echo '════ AVANT (EN) ════'
SELECT v.product_id, left(p.name,42) AS nom, v.id AS var_id, v.attributes, v.price_usd
FROM product_variations v JOIN products p ON p.id=v.product_id
WHERE v.product_id IN (1237,1238,1239,1240,1241,1489,1494,1516,1517,1518,1520,1521,1523,1524,
                       1527,1529,1551,1566,1568,1569,1570,1571,1580,1582,1583)
ORDER BY v.product_id, v.id;

-- ── Poudres EN : Weight ; 1163→Large 1164→Medium 1165→Small ──
UPDATE product_variations SET attributes =
  jsonb_build_object('Weight',
    CASE attributes->>'Weight'
      WHEN '1163' THEN 'Large' WHEN '1164' THEN 'Medium' WHEN '1165' THEN 'Small'
      ELSE attributes->>'Weight' END)
WHERE product_id IN (1516,1517,1518,1520,1521,1523,1527,1529) AND attributes ? 'Weight';

-- 1524 (= FR 659) : Weight ; 1163→1.5kg 1164→1kg 1165→500g
UPDATE product_variations SET attributes =
  jsonb_build_object('Weight',
    CASE attributes->>'Weight'
      WHEN '1163' THEN '1.5kg' WHEN '1164' THEN '1kg' WHEN '1165' THEN '500g'
      ELSE attributes->>'Weight' END)
WHERE product_id = 1524 AND attributes ? 'Weight';

-- ── Sacs EN : Pattern → Size ; 996→Large 997→Medium 998→Small ──
DELETE FROM product_variations
WHERE product_id IN (1489,1494) AND (attributes->>'Pattern') LIKE 'Motif %';
UPDATE product_variations SET attributes =
  jsonb_build_object('Size',
    CASE attributes->>'Pattern'
      WHEN '996' THEN 'Large' WHEN '997' THEN 'Medium' WHEN '998' THEN 'Small'
      ELSE attributes->>'Pattern' END)
WHERE product_id IN (1489,1494) AND attributes ? 'Pattern';

-- ── Têtes de Bus EN (1566) : Finish → Size ; 1014→Large 1015→Small ──
DELETE FROM product_variations
WHERE product_id = 1566 AND (attributes->>'Finish') IN ('Noir','Ébène','Black','Ebony');
UPDATE product_variations SET attributes =
  jsonb_build_object('Size',
    CASE attributes->>'Finish'
      WHEN '1014' THEN 'Large' WHEN '1015' THEN 'Small'
      ELSE attributes->>'Finish' END)
WHERE product_id = 1566 AND attributes ? 'Finish';

-- ── Tam-Tam (1568) : Size ; 1007→Large 1008→Small ──
UPDATE product_variations SET attributes =
  jsonb_build_object('Size',
    CASE attributes->>'Size'
      WHEN '1007' THEN 'Large' WHEN '1008' THEN 'Small'
      ELSE attributes->>'Size' END)
WHERE product_id = 1568 AND (attributes->>'Size') ~ '^[0-9]{3,4}$';

-- ── Statue nimba (1569) : Size ; 1004→Large 1006→Small ──
UPDATE product_variations SET attributes =
  jsonb_build_object('Size',
    CASE attributes->>'Size'
      WHEN '1004' THEN 'Large' WHEN '1006' THEN 'Small'
      ELSE attributes->>'Size' END)
WHERE product_id = 1569 AND (attributes->>'Size') ~ '^[0-9]{3,4}$';

-- ── Chemise Textile Guinéen EN (1551) : recrée Size L/XL/XXL ──
DELETE FROM product_variations WHERE product_id = 1551;
INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
SELECT 1551, p.sku, jsonb_build_object('Size', t), p.price_usd, 50, COALESCE(p.images->>0,'')
FROM products p, unnest(ARRAY['L','XL','XXL']) AS t WHERE p.id = 1551;

-- ── Indigo Shirt Signature (1570 = FR 699) : Color supprimé, recrée Sleeves/Size ──
DELETE FROM product_variations WHERE product_id IN (1570,1571);
INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
SELECT p.id, p.sku, jsonb_build_object('Sleeves', s, 'Size', t), p.price_usd, 50, COALESCE(p.images->>0,'')
FROM products p, unnest(ARRAY['Short','Long']) AS s, unnest(ARRAY['L','XL','XXL']) AS t
WHERE p.id IN (1570,1571);

-- ── Tableaux/table EN (1580,1582,1583) : Pattern ; 996-999 → Pattern 1-4 ──
-- Purge d'abord les résidus "Motif N" (nomenclature FR laissée dans un
-- produit EN) et les variations {} vides.
DELETE FROM product_variations
WHERE product_id IN (1580,1582,1583)
  AND (coalesce(attributes->>'Pattern','') LIKE 'Motif %' OR attributes = '{}'::jsonb);
UPDATE product_variations SET attributes =
  jsonb_build_object('Pattern',
    CASE attributes->>'Pattern'
      WHEN '996' THEN 'Pattern 1' WHEN '997' THEN 'Pattern 2'
      WHEN '998' THEN 'Pattern 3' WHEN '999' THEN 'Pattern 4'
      ELSE attributes->>'Pattern' END)
WHERE product_id IN (1580,1582,1583) AND attributes ? 'Pattern';

-- ── Robes Djezner EN (1237-1241) : recrée Size "3 years"…"15 years" ──
DELETE FROM product_variations WHERE product_id IN (1237,1238,1239,1240,1241);
INSERT INTO product_variations (product_id, sku, attributes, price_usd, stock, image_url)
SELECT p.id, p.sku, jsonb_build_object('Size', n || ' years'), p.price_usd, 50, COALESCE(p.images->>0,'')
FROM products p, generate_series(3,15) AS n
WHERE p.id IN (1237,1238,1239,1240,1241);

-- ── Dédoublonnage (EN) ──
DELETE FROM product_variations a USING product_variations b
WHERE a.product_id = b.product_id AND a.attributes = b.attributes AND a.id > b.id
  AND a.product_id IN (1237,1238,1239,1240,1241,1489,1494,1516,1517,1518,1520,1521,1523,1524,
                       1527,1529,1551,1566,1568,1569,1570,1571,1580,1582,1583);

-- ── is_variable cohérent ──
UPDATE products p SET is_variable = FALSE
WHERE p.lang='en' AND p.is_variable = TRUE
  AND NOT EXISTS (SELECT 1 FROM product_variations v WHERE v.product_id = p.id);

\echo ''
\echo '════ APRÈS (EN) ════'
SELECT v.product_id, left(p.name,42) AS nom, v.id AS var_id, v.attributes, v.price_usd
FROM product_variations v JOIN products p ON p.id=v.product_id
WHERE v.product_id IN (1237,1238,1239,1240,1241,1489,1494,1516,1517,1518,1520,1521,1523,1524,
                       1527,1529,1551,1566,1568,1569,1570,1571,1580,1582,1583)
ORDER BY v.product_id, v.id;

\echo ''
\if :apply
  \echo '>>> apply=1 : COMMIT.'
  COMMIT;
\else
  \echo '>>> apply=0 (dry-run) : ROLLBACK.'
  ROLLBACK;
\endif
