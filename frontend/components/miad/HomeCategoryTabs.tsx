"use client"

// Bande d'onglets catégorie en haut de l'accueil, style AliExpress : "Explorer"
// (accueil normal) + un onglet par grande catégorie du catalogue. Change juste
// l'onglet actif côté client, jamais de navigation/rechargement de page.

export interface HomeTab {
  slug: string
  label: string
  labelEn: string
}

// Onglets = les vraies catégories racines du catalogue (catalog-svc
// GET /categories), triées par nombre de produits décroissant. Les slugs
// sont volontairement SANS le suffixe de langue (`-fr`/`-en`) : la
// résolution slug→id est tolérante (voir app/api/products/route.ts et
// lib/woo-server.ts fetchCategoryRow), donc le même onglet marche en FR et
// en EN. Corrigé le 2026-08-28 : l'ancienne liste contenait `bebe-enfant`
// et `sante-bien-etre` qui n'existent pas en base (0 produit, jamais
// créées) et omettait Sacs (195), Pagnes (129), Chaussures (58), etc.
export const HOME_CATEGORY_TABS: HomeTab[] = [
  { slug: 'sacs-maroquinerie', label: 'Sacs', labelEn: 'Bags' },
  { slug: 'pagnes-tissus-africains', label: 'Pagnes', labelEn: 'Fabrics' },
  { slug: 'mode-vetements', label: 'Mode', labelEn: 'Fashion' },
  { slug: 'bijoux-accessoires', label: 'Bijoux', labelEn: 'Jewelry' },
  { slug: 'alimentation-epicerie', label: 'Alimentation', labelEn: 'Groceries' },
  { slug: 'beaute-soin-naturel', label: 'Beauté', labelEn: 'Beauty' },
  { slug: 'chaussures-sandales', label: 'Chaussures', labelEn: 'Shoes' },
  { slug: 'artisanat-art-africain', label: 'Artisanat', labelEn: 'Crafts' },
  { slug: 'soin-cheveux-naturels', label: 'Cheveux', labelEn: 'Hair care' },
  { slug: 'maison-decoration', label: 'Maison', labelEn: 'Home' },
  { slug: 'livres-religieux', label: 'Livres', labelEn: 'Books' },
  { slug: 'electronique-tech', label: 'Électronique', labelEn: 'Electronics' },
]

interface HomeCategoryTabsProps {
  activeTab: string
  onSelectTab: (slug: string) => void
  language?: 'fr' | 'en'
}

export function HomeCategoryTabs({ activeTab, onSelectTab, language = 'fr' }: HomeCategoryTabsProps) {
  return (
    <nav className="bg-card border-b border-border sticky top-0 z-30">
      <div className="container mx-auto px-4">
        <div className="flex gap-6 overflow-x-auto scrollbar-hide">
          <button
            type="button"
            onClick={() => onSelectTab('explore')}
            className={`shrink-0 py-3 text-sm font-black uppercase tracking-tight border-b-2 transition-colors ${
              activeTab === 'explore'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {language === 'en' ? 'Explore' : 'Explorer'}
          </button>
          {HOME_CATEGORY_TABS.map(tab => (
            <button
              key={tab.slug}
              type="button"
              onClick={() => onSelectTab(tab.slug)}
              className={`shrink-0 py-3 text-sm font-black uppercase tracking-tight border-b-2 transition-colors ${
                activeTab === tab.slug
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {language === 'en' ? tab.labelEn : tab.label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}
