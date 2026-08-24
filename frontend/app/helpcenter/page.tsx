import MiadMarketClient from '../MiadMarketClient'

export const runtime = 'edge';

/**
 * Page dédiée au Centre d'Aide (SEO Friendly)
 */
async function getInitialData() {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://127.0.0.1:3000';
  
  try {
    const results = await Promise.allSettled([
      fetch(`${baseUrl}/api/categories?lang=fr`, { next: { revalidate: 3600 } }),
      fetch(`${baseUrl}/api/detect-country`, { cache: 'no-store' })
    ]);

    const getData = async (res: PromiseSettledResult<Response>) => {
      if (res.status === 'fulfilled' && res.value.ok) {
        try { return await res.value.json(); } catch { return {}; }
      }
      return {};
    };

    const catData = await getData(results[0]);
    const countryData = await getData(results[1]);

    return {
      categories: catData.categories || [],
      userCountryCode: countryData?.countryCode || 'SN',
    };
  } catch (e) {
    return { categories: [], userCountryCode: 'SN' };
  }
}

export default async function HelpCenterPage() {
  const data = await getInitialData();

  return (  
    <MiadMarketClient 
      initialProducts={[]} 
      initialCategories={data.categories}
      initialStores={[]}
      initialUserCountryCode={data.userCountryCode}
      forcedView="help"
      shippingRates={{}}
    />
  )
}
