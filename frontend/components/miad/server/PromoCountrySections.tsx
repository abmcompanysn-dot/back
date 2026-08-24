import Link from 'next/link'
import Image from 'next/image'
import { Store } from 'lucide-react'
import { countries, formatPrice } from '@/lib/woocommerce'
import { fetchHomeCountryData } from '@/lib/woo-server'
import { ScrollRow } from '../ScrollRow'

const TARGET_COUNTRIES = ['sn', 'ci', 'gh', 'ng', 'gn', 'cm', 'bj']

// Sections "Marché [Pays]" — anciennement sur l'accueil (HomeSections.tsx),
// déplacées ici (demandé le 2026-07-24). Contrairement à CountrySectionServer
// (accueil), cette page n'est pas rendue à l'intérieur de MiadMarketClient :
// pas de StreamedNavClickProvider disponible, donc navigation par <Link>
// classique vers les routes SEO dédiées (/product/[slug], /vendor/[slug])
// plutôt que via le contexte réservé à l'accueil.
export async function PromoCountrySections() {
  const { productsByCountry, storesByCountry } = await fetchHomeCountryData()
  const codesWithData = new Set([...Object.keys(productsByCountry), ...Object.keys(storesByCountry)])
  const orderedCodes = [...new Set([...TARGET_COUNTRIES, ...codesWithData])].filter(code => codesWithData.has(code))

  return (
    <div className="space-y-10 mt-12">
      {orderedCodes.map(code => {
        const country = countries.find(c => c.code === code)
        if (!country) return null
        const products = productsByCountry[code] || []
        const stores = (storesByCountry[code] || []).slice(0, 8)
        if (products.length === 0 && stores.length === 0) return null

        return (
          <section key={code}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <Image
                  src={`https://flagcdn.com/w80/${code}.png`}
                  alt={country.name}
                  width={36}
                  height={25}
                  className="w-9 h-6 object-cover rounded shadow-sm border border-border"
                />
                <h2 className="text-lg font-bold text-foreground">Marché {country.name}</h2>
              </div>
              <Link href={`/?v=country&code=${code}`} className="text-xs font-bold text-accent hover:underline shrink-0">
                Voir tout
              </Link>
            </div>

            {stores.length > 0 && (
              <div className="mb-4">
                <h3 className="font-semibold text-foreground text-xs flex items-center gap-1.5 mb-2">
                  <Store size={14} className="text-accent" /> Boutiques
                </h3>
                <ScrollRow>
                  {stores.map((store: any) => (
                    <Link
                      key={store.id}
                      href={`/vendor/${store.slug}`}
                      className="shrink-0 w-56 bg-card border border-border rounded-xl overflow-hidden hover:shadow-md transition-all block"
                    >
                      <div className="h-16 bg-muted relative">
                        {store.banner && (
                          <Image src={store.banner} alt="" fill sizes="224px" className="object-cover" />
                        )}
                      </div>
                      <div className="p-3">
                        <p className="font-bold text-sm text-foreground truncate">{store.name}</p>
                      </div>
                    </Link>
                  ))}
                </ScrollRow>
              </div>
            )}

            {products.length > 0 && (
              <div>
                <h3 className="font-semibold text-foreground text-xs mb-2">Produits populaires</h3>
                <ScrollRow>
                  {products.map((p: any) => (
                    <Link
                      key={p.id}
                      href={`/product/${p.slug}`}
                      className="shrink-0 w-36 bg-card rounded-xl overflow-hidden border border-border hover:shadow-md transition-all block"
                    >
                      <div className="aspect-square relative bg-muted">
                        {p.image && (
                          <Image src={p.image} alt={p.name} fill sizes="144px" className="object-cover" />
                        )}
                      </div>
                      <div className="p-2">
                        <h4 className="text-[11px] font-medium line-clamp-2 h-8">{p.name}</h4>
                        <p className="mt-1 font-bold text-accent text-xs">{formatPrice(p.price)}$</p>
                      </div>
                    </Link>
                  ))}
                </ScrollRow>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
