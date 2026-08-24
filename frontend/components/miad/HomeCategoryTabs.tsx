"use client"

// Bande d'onglets catégorie en haut de l'accueil, style AliExpress : "Explorer"
// (accueil normal) + un onglet par grande catégorie du catalogue. Change juste
// l'onglet actif côté client, jamais de navigation/rechargement de page.

export interface HomeTab {
  slug: string
  label: string
  labelEn: string
}

export const HOME_CATEGORY_TABS: HomeTab[] = [
  { slug: 'mode-vetements', label: 'Mode', labelEn: 'Fashion' },
  { slug: 'bijoux-accessoires', label: 'Bijoux', labelEn: 'Jewelry' },
  { slug: 'beaute-soin-naturel', label: 'Beauté', labelEn: 'Beauty' },
  { slug: 'artisanat-art-africain', label: 'Artisanat', labelEn: 'Crafts' },
  { slug: 'alimentation-epicerie', label: 'Alimentation', labelEn: 'Groceries' },
  { slug: 'maison-decoration', label: 'Maison', labelEn: 'Home' },
  { slug: 'bebe-enfant', label: 'Bébé', labelEn: 'Baby' },
  { slug: 'sante-bien-etre', label: 'Santé', labelEn: 'Health' },
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
