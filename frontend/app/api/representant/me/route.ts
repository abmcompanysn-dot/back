import { NextResponse } from 'next/server'
import { WOO_URL, INTERNAL_SECRET, fetchWpUser, wpHeaders, isRep as checkIsRep } from '@/lib/miad-server-auth'

export const runtime = 'edge';

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Token manquant' }, { status: 401 })
  }
  const token = authHeader.slice(7)

  try {
    const userData = await fetchWpUser(token)
    if (!userData) {
      return NextResponse.json({ error: 'Session invalide' }, { status: 401 })
    }

    if (!checkIsRep(userData)) {
      return NextResponse.json({ error: 'Accès réservé aux représentants' }, { status: 403 })
    }

    // Call the custom WordPress representative endpoint (the rich data source)
    // Use wpHeaders so miad_ tokens go via X-Miad-Session (bypasses JWT Auth)
    const repRes = await fetch(`${WOO_URL}/wp-json/miad/v1/representant/me`, {
      headers: wpHeaders(token),
      cache: 'no-store',
    })

    if (repRes.ok) {
      const text = await repRes.text()
      if (!text.trim().startsWith('<')) {
        const repData = JSON.parse(text)
        if (repData?.success) {
          return NextResponse.json(repData)
        }
      }
    }

    // Fallback: build a minimal response from WP user meta (when plugin not installed yet)
    const meta: Record<string, any> = userData.meta || {}
    const roles: string[] = userData.roles || []
    const isSuperRep = roles.includes('miad_super_rep')

    const referralCode =
      meta.miad_rep_referral_code ||
      meta._miad_rep_code ||
      `REP${String(userData.id).toUpperCase()}`

    return NextResponse.json({
      success: true,
      id: userData.id,
      name: userData.name || userData.display_name,
      email: userData.email,
      avatar: userData.avatar_urls?.['96'] || userData.avatar || '',
      country_code: isSuperRep ? 'ALL' : (meta.miad_assigned_country || ''),
      country_name: isSuperRep ? 'Tous les pays' : (meta.miad_assigned_country || ''),
      is_super_rep: isSuperRep,
      whatsapp: meta.miad_rep_whatsapp || '',
      referral_code: referralCode,
      commission_rate: Number(meta.miad_rep_commission_rate || 5),
      referral_earned: 0,
      referral_clients: [],
      referral_orders: 0,
      vendors: [],
      vendors_count: 0,
      recent_orders: [],
      zone_orders: 0,
      zone_total: 0,
      zone_clients: 0,
    })

  } catch {
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 })
  }
}
