import { type WooCategory, countries, translations } from '@/lib/woocommerce'
import Link from 'next/link'
import Image from 'next/image'

interface FooterProps {
  categories?: WooCategory[]
  onCountryClick?: (code: string) => void
  selectedCountry?: string
  language?: 'fr' | 'en'
}

export function Footer({ categories, onCountryClick, selectedCountry, language = 'fr' }: FooterProps) {
  const t = translations[language]
  return (
    <footer className="bg-secondary text-secondary-foreground py-8">
      <div className="container mx-auto px-4 text-center">
        <div className="flex flex-col items-center justify-center gap-2 mb-4">
          <div className="h-10 w-auto mb-2">
            <Image src="/logo/logo.png" alt="MIAD Market" width={160} height={40} className="h-full w-auto object-contain" />
          </div>
          <span className="font-bold text-lg">MIAD Market</span>
        </div>
        <p className="text-secondary-foreground/70 text-sm">
          {t.slogan}
        </p>
        <div className="mt-6 flex justify-center gap-8">
          <Link href="/helpcenter" className="text-[10px] font-black uppercase tracking-widest hover:text-accent transition-colors">
            {t.helpCenter}
          </Link>
        </div>
        <div className="mt-4 flex justify-center gap-3 flex-wrap transition-all">
          <Image src="/logo/ga.svg" alt="Google Pay" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
          <Image src="/logo/limk.svg" alt="Link" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
          <Image src="/logo/om.png" alt="Orange Money" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
          <Image src="/logo/ma.png" alt="Moov" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
          <Image src="/logo/mt.png" alt="MTN" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
          <Image src="/logo/dj.png" alt="Djamo" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
          <Image src="/logo/ya.png" alt="Yas" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
          <Image src="/logo/we.png" alt="Wave" width={100} height={24} className="h-6 w-auto object-contain bg-white rounded-sm p-0.5" />
        </div>

        {/* Sélecteur de pays élégant dans le Footer */}
        <div className="mt-8 mb-6 flex flex-wrap justify-center gap-3">
          {countries.map((country) => (
            <button
              type="button"
              key={country.code}
              onClick={() => onCountryClick?.(country.code)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all ${
                selectedCountry === country.code 
                ? 'bg-accent text-accent-foreground border-accent shadow-sm' 
                : 'bg-background/10 border-border hover:border-accent/50'
              }`}
            >
              <span className="text-base">{country.flag}</span>
              <span className="text-[10px] font-bold uppercase tracking-tight">{country.name}</span>
            </button>
          ))}
        </div>

        <p className="text-secondary-foreground/50 text-xs mt-4">
          &copy; {new Date().getFullYear()} MIAD Market. {t.allRights}
        </p>
      </div>
    </footer>
  )
}
