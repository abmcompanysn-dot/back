#!/usr/bin/env node
/**
 * Crée un produit WooCommerce à partir d'une spécification JSON — utilisé en
 * conversation : l'utilisateur donne nom/photo/catégorie/prix, Claude rédige
 * la description et remplit ce JSON, puis ce script appelle l'endpoint
 * sécurisé miad-products/v1/create (voir woocommerce-snippets/miad-products-api.php)
 * qui crée la fiche produit et télécharge lui-même les images depuis les URLs
 * données — pas besoin de les uploader à la main.
 *
 * Variables d'environnement requises (.env.local) :
 *   MIAD_PRODUCTS_API     ex: https://api.miadmarket.com/wp-json/miad-products/v1
 *   MIAD_PRODUCTS_SECRET  la clé affichée sur Outils > MIAD Products API
 *
 * Usage :
 *   node scripts/create-product.mjs '<json>'
 *   node scripts/create-product.mjs chemin/vers/produit.json
 *
 * Format JSON attendu :
 * {
 *   "name": "Sac en cuir africain tressé",
 *   "description": "<p>Texte complet en HTML...</p>",
 *   "shortDescription": "Résumé court pour les listes produits",
 *   "costPrice": 25,            // prix d'achat / coût
 *   "markupPercent": 40,        // marge à appliquer (=> prix final = cost * 1.4)
 *   "category": "Sacs",         // nom OU slug d'une catégorie existante
 *   "stockQuantity": 10,
 *   "images": ["https://exemple.com/photo1.jpg", "https://exemple.com/photo2.jpg"],
 *   "sku": "SAC-CUIR-001"       // optionnel
 * }
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const PRODUCTS_API   = (process.env.MIAD_PRODUCTS_API || 'https://api.miadmarket.com/wp-json/miad-products/v1').replace(/\/$/, '');
const PRODUCTS_SECRET = process.env.MIAD_PRODUCTS_SECRET;

if (!PRODUCTS_SECRET) {
  console.error('❌ MIAD_PRODUCTS_SECRET manquant dans .env.local (clé affichée sur Outils > MIAD Products API)');
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.error('❌ Usage : node scripts/create-product.mjs \'<json>\'  ou  node scripts/create-product.mjs fichier.json');
  process.exit(1);
}

const spec = existsSync(arg) ? JSON.parse(readFileSync(arg, 'utf8')) : JSON.parse(arg);

async function main() {
  if (!spec.name) {
    console.error('❌ "name" est requis dans la spécification.');
    process.exit(1);
  }

  console.log(`🔍 Création du produit "${spec.name}"…`);

  const res = await fetch(`${PRODUCTS_API}/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Miad-Products-Secret': PRODUCTS_SECRET,
    },
    body: JSON.stringify(spec),
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    console.error(`❌ Échec (${res.status}) :`, data.error || JSON.stringify(data));
    process.exit(1);
  }

  console.log(`✅ Produit créé : #${data.product_id} — ${data.permalink}`);
  console.log(`   Prix : ${data.price}$`);
  console.log(`   Catégorie trouvée : ${data.category_found ? 'oui' : 'non (vérifie le nom exact dans WooCommerce)'}`);
  console.log(`   Images attachées : ${data.images_attached}`);
  for (const img of data.images || []) {
    if (img.r2_url) console.log(`     ✅ #${img.attachment_id} → ${img.r2_url}`);
    else if (img.attachment_id) console.log(`     ⚠️  #${img.attachment_id} attachée mais pas encore sur R2 (sera reprise par la synchro automatique)`);
    else console.log(`     ❌ échec du téléchargement : ${img.source_url}`);
  }
  console.log(`   Éditer : ${data.edit_link}`);
  console.log(`\n💡 Pour la version anglaise (WPML) : ouvre ce produit dans wp-admin et utilise le bouton "+" en face du drapeau anglais pour dupliquer/traduire — la liaison de traduction WPML n'est pas faite via ce script.`);
}

main().catch((e) => {
  console.error('💥 Erreur fatale :', e);
  process.exit(1);
});
