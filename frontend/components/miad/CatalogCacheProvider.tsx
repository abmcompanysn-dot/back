"use client"

import { SWRConfig, type Cache } from 'swr'
import { useRef, type ReactNode } from 'react'

const STORAGE_KEY = 'miad_catalog_swr_cache_v1'

// Seules les donnees publiques de catalogue (produits, categories, boutiques)
// sont persistees entre deux visites — jamais le panier, les commandes, le
// profil client/vendeur ou toute autre donnee liee a un compte. Au retour
// sur le site, ces donnees s'affichent instantanement depuis le cache local
// pendant que SWR revalide en arriere-plan et ne met a jour que ce qui a
// change, au lieu de tout retelecharger a vide.
const PERSISTABLE_PREFIXES = ['/api/products', '/api/categories', '/api/stores']

function isPersistable(key: string): boolean {
  return PERSISTABLE_PREFIXES.some((p) => key.includes(p))
}

// Une réponse catalogue vide (produits/boutiques/catégories) est presque
// toujours le symptôme d'une panne passagère (API WooCommerce/WordPress en
// panne, comme le 2026-07-29 où tout le plugin miad-products-api.php
// répondait 404) plutôt qu'un vrai résultat définitif — la persister aurait
// figé cette panne dans le navigateur du visiteur indéfiniment, même après
// que le site soit réparé, jusqu'à expiration ou vidage manuel du cache.
// Ne rien persister dans ce cas : au pire, un skeleton bref le temps que SWR
// revalide, jamais pire qu'un "aucun produit" qui ne se corrige jamais tout
// seul.
function isEmptyCatalogResult(value: any): boolean {
  const data = value?.data
  if (!data || typeof data !== 'object') return false
  const list = data.products ?? data.stores ?? data.categories
  return Array.isArray(list) && list.length === 0
}

function readPersistedEntries(): [string, any][] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function localStorageCacheProvider(): Cache {
  const map = new Map<string, any>(readPersistedEntries())

  if (typeof window !== 'undefined') {
    const persist = () => {
      try {
        const entries = Array.from(map.entries()).filter(
          ([key, value]) => isPersistable(key) && !isEmptyCatalogResult(value)
        )
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
      } catch {
        // quota depasse ou stockage indisponible : on abandonne silencieusement,
        // la mise en cache n'est qu'une optimisation, pas une dependance critique
      }
    }
    window.addEventListener('beforeunload', persist)
    window.addEventListener('pagehide', persist)
  }

  return map as Cache
}

export function CatalogCacheProvider({ children }: { children: ReactNode }) {
  const providerRef = useRef(localStorageCacheProvider)
  return (
    <SWRConfig value={{ provider: providerRef.current }}>
      {children}
    </SWRConfig>
  )
}
