import { NextResponse } from 'next/server'

export const runtime = 'edge';

/**
 * GAP BACKEND CONNU : "Achetés ensemble" (composant
 * FrequentlyBoughtTogether.tsx) reposait sur un endpoint WordPress
 * (wp-json/miad-analytics/v1/recommendations) qui recalculait quotidiennement
 * de vraies co-occurrences de commandes. Aucun service Go n'expose cette
 * donnée aujourd'hui :
 *   - catalog-svc a bien GET /products/{id}/similar, mais il renvoie
 *     explicitement 501 not_implemented_yet ("conserver l'appel existant du
 *     frontend jusqu'au branchement de catalog-svc sur l'index Vectorize" —
 *     voir services/catalog-svc/main.go) — donc pas encore un substitut
 *     utilisable même pour de la similarité produit, encore moins pour des
 *     co-achats réels basés sur order-svc.
 *   - order-svc n'a aucune route d'agrégation de ce type (listOrders /
 *     getOrder ne font que lister/lire une commande, pas de calcul de
 *     co-occurrence entre produits).
 *
 * Pour ne pas fabriquer une fausse recommandation, cette route renvoie
 * toujours une liste vide — le composant appelant reste silencieux dans ce
 * cas (voir FrequentlyBoughtTogether.tsx : `if (loading || products.length
 * === 0) return null`), donc aucune régression visuelle, juste la
 * fonctionnalité elle-même absente tant que ce endpoint n'existe pas côté Go.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const productId = searchParams.get('product_id')

  if (!productId || !/^\d+$/.test(productId)) {
    return NextResponse.json({ recommendations: [] })
  }

  return NextResponse.json({ recommendations: [] })
}
