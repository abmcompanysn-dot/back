'use client'
import { useCallback, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import useSWR from 'swr'
import { ProductDetail } from './ProductDetail'
import { StandaloneHeader } from './StandaloneHeader'
import { type WooProduct, type WooProductVariation, type WooVendor } from '@/lib/woocommerce'
import { useCurrency } from '@/contexts/CurrencyContext'
import { subscribeCart, getCartCount, getServerCartCount, addItemToCart } from '@/lib/cart-store'

interface ProductDetailWrapperProps {
  product: WooProduct
  userCountry?: string
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

export function ProductDetailWrapper({ product, userCountry = 'SN' }: ProductDetailWrapperProps) {
  const router = useRouter()
  const { formatPrice: fp } = useCurrency()
  const cartCount = useSyncExternalStore(subscribeCart, getCartCount, getServerCartCount)

  // Charger les produits de la même boutique pour "Plus de cette boutique"
  const vendorId = product.vendor?.id
  const { data: vendorData } = useSWR<{ products: WooProduct[] }>(
    vendorId ? `/api/products?vendor=${vendorId}&per_page=20` : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 300000 }
  )
  const allProducts: WooProduct[] = vendorData?.products ?? []

  const addToCart = useCallback((p: WooProduct, quantity = 1, variation?: WooProductVariation) => {
    addItemToCart(p, quantity, variation)
  }, [])

  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      window.history.back()
    } else {
      router.push('/')
    }
  }, [router])

  const handleProductClick = useCallback((p: WooProduct) => {
    router.push(`/product/${p.slug}`)
  }, [router])

  const handleStoreClick = useCallback((v: WooVendor) => {
    // Fallback sur l'id si le slug est absent pour éviter /vendor/undefined → 404
    const dest = v?.slug || String(v?.id || '')
    if (!dest) return
    router.push(`/vendor/${dest}`)
  }, [router])

  const handleBuyNow = useCallback((p: WooProduct, qty: number, variation?: WooProductVariation) => {
    addToCart(p, qty, variation)
    router.push('/')
  }, [addToCart, router])

  const handleCartClick = useCallback(() => {
    router.push('/')
  }, [router])

  return (
    <div className="min-h-screen bg-background">
      <StandaloneHeader
        mode="product"
        title={product.name}
        subtitle={fp(product.price)}
        image={product.image?.startsWith('http') ? product.image : undefined}
        rating={product.rating}
        countryCode={product.countryCode}
      />

      <ProductDetail
        product={product}
        allProducts={allProducts}
        onBack={handleBack}
        onProductClick={handleProductClick}
        onStoreClick={handleStoreClick}
        onAddToCart={addToCart}
        onBuyNow={handleBuyNow}
        onCartClick={handleCartClick}
        userCountry={userCountry}
        cartCount={cartCount}
        shippingRates={{}}
      />
    </div>
  )
}
