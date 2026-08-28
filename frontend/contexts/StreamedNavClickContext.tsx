"use client"

import { createContext, useContext, type ReactNode } from 'react'
import { type WooProduct, type WooVendor } from '@/lib/woocommerce'

// Les cartes produit/boutique rendues à l'intérieur des sections Server
// Component streamées de l'accueil (HomeSections.tsx, CountrySectionServer.tsx)
// sont elles-mêmes des composants client (LinkStoreCard, LinkProductCard) —
// mais un Server
// Component parent ne peut pas leur passer directement les callbacks
// handleVendorClick/handleProductClick de MiadMarketClient.tsx (fonctions non
// sérialisables à travers la frontière serveur→client). Un Context, lui,
// traverse cette frontière sans problème tant que le Provider est monté par
// un ancêtre client (voir MiadMarketClient.tsx) : ces cartes appellent donc
// directement handleVendorClick/handleProductClick via ce contexte au clic,
// au lieu de naviguer par <Link href="/?v=..."> et d'attendre que l'effet de
// réactivité URL retrouve le produit/la boutique dans le state chargé côté
// client — ce qui pouvait échouer silencieusement tant que ce state n'était
// pas encore chargé, ou ne jamais aboutir pour une boutique au-delà des 100
// premières (voir CLAUDE.md, incident du 2026-07-12).
interface StreamedNavClickValue {
  onVendorClick: (v: WooVendor) => void
  onProductClick: (p: WooProduct) => void
  // Même raison que ci-dessus, pour le bouton "Voir tout" d'une section pays
  // (CountrySectionServer.tsx) — remplace un <Link href="/?v=country&code=...">
  // qui attendait le round-trip serveur avant d'afficher quoi que ce soit
  // (~2-3s sans prefetch, signalé le 2026-07-23), alors que la vue pays n'a
  // besoin d'aucune donnée nouvelle (stores/allProducts déjà en mémoire).
  onViewAllCountry?: (code: string) => void
  // Bouton "Voir tout" d'une rangée catégorie de l'accueil
  // (CategoryRow.tsx) — bascule vers la vue catégorie sans round-trip
  // serveur (setSelectedCategory + navigateTo('category')).
  onViewAllCategory?: (slug: string) => void
}

const StreamedNavClickContext = createContext<StreamedNavClickValue | null>(null)

export function StreamedNavClickProvider({ value, children }: { value: StreamedNavClickValue; children: ReactNode }) {
  return (
    <StreamedNavClickContext.Provider value={value}>
      {children}
    </StreamedNavClickContext.Provider>
  )
}

// Renvoie null hors provider plutôt que de lancer — ces cartes sont aussi
// utilisées dans des contextes de prévisualisation/tests sans MiadMarketClient.
export function useStreamedNavClick(): StreamedNavClickValue | null {
  return useContext(StreamedNavClickContext)
}
