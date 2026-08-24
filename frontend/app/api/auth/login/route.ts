/**
 * Route d'authentification Miad Market via WordPress JWT
 */
import { NextResponse } from 'next/server'
import { rateLimit, getIp, tooManyRequests } from '@/lib/rate-limit'

export const runtime = 'edge';

const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://api.miadmarket.com/').replace(/\/$/, '');
import { requireEnv } from '@/lib/require-env'
const INTERNAL_SECRET = requireEnv('INTERNAL_API_SECRET')

export async function POST(request: Request) {
  const ip = getIp(request)
  const rl = rateLimit(`login:${ip}`, 5, 5 * 60 * 1000) // 5 / 5 min
  if (!rl.allowed) return tooManyRequests(rl.resetAt)

  try {
    const body = await request.json().catch(() => ({}));
    const { username, password, firebase_token } = body;
    
    // 1. CAS FIREBASE (Google / Facebook)
    if (firebase_token) {
      const wpRes = await fetch(`${WOO_URL}/wp-json/miad/v1/auth/firebase`, {
        method: 'POST',
        headers: { 
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Headless-Secret': INTERNAL_SECRET,
          'User-Agent': 'MIAD-Headless-Client'
        },
        body: JSON.stringify({ token: firebase_token })
      });
      
      const wpText = await wpRes.text();

      // Vérification si la réponse est du HTML (Erreur WAF/SiteGround) ou un challenge 202
      if (wpText.trim().startsWith('<!DOCTYPE') || wpText.trim().startsWith('<html') || wpRes.status === 202) {
        return NextResponse.json({
          message: "Le serveur WordPress bloque la liaison Firebase. Désactivez l'Anti-Bot AI ou vérifiez le plugin Miad Auth." 
        }, { status: 502 })
      }

      if (!wpRes.ok) {
        return NextResponse.json({ message: "Liaison WordPress/Firebase échouée" }, { status: wpRes.status });
      }

      let wpData: any;
      try {
        wpData = JSON.parse(wpText);
      } catch (e) {
        return NextResponse.json({ message: "Réponse serveur invalide lors de la liaison Firebase" }, { status: 502 });
      }

      // Normalisation du rôle pour le client Next.js
      const REP_ROLES = ['miad_representative', 'miad_representant', 'representant', 'miad_rep', 'miad_agent', 'miad_super_rep']
      const role = wpData.role === 'administrator' ? 'admin'
        : (['seller', 'vendor', 'wcfm_vendor'].includes(wpData.role) ? 'vendor'
        : (REP_ROLES.includes(wpData.role) ? 'representant' : 'buyer'));

      return NextResponse.json({
        success: true,
        token: wpData.token,
        user_display_name: wpData.display_name || wpData.user_display_name,
        user_email: wpData.email || wpData.user_email,
        role: role, 
        id: wpData.id || wpData.user_id,
        avatar: wpData.avatar,
        user_nicename: wpData.user_nicename || wpData.display_name
      });
    }

    // 2. CAS CLASSIQUE (Username/Password)
    if (!username || !password) {
      return NextResponse.json({ message: 'Identifiants ou mot de passe manquants' }, { status: 400 })
    }

    // ── Étape 1 : Tentative JWT standard ───────────────────────────────────────
    let authData: any = {}
    let tokenObtained = false

    const jwtRes = await fetch(`${WOO_URL}/wp-json/jwt-auth/v1/token`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client',
      },
      body: JSON.stringify({ username, password }),
    })

    if (jwtRes.ok) {
      const jwtText = await jwtRes.text()
      if (!jwtText.trim().startsWith('<')) {
        try {
          const parsed = JSON.parse(jwtText)
          if (parsed.token) { authData = parsed; tokenObtained = true }
        } catch {}
      }
    }

    // ── Étape 2 : Fallback sur l'endpoint MIAD si JWT retourne 403/5xx ─────────
    if (!tokenObtained) {
      const fallbackRes = await fetch(`${WOO_URL}/wp-json/miad/v1/auth`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Headless-Secret': INTERNAL_SECRET,
          'User-Agent': 'MIAD-Headless-Client',
        },
        body: JSON.stringify({ username, password }),
      })

      if (fallbackRes.status === 202) {
        return NextResponse.json({
          message: "Connexion bloquée par la sécurité du serveur. Contactez le support."
        }, { status: 502 })
      }

      const fbText = await fallbackRes.text()
      if (fbText.trim().startsWith('<')) {
        return NextResponse.json({ message: "Erreur de communication serveur (WAF)." }, { status: 502 })
      }
      try {
        authData = JSON.parse(fbText)
        if (authData.token) tokenObtained = true
      } catch {
        return NextResponse.json({ message: "Réponse serveur invalide" }, { status: 502 })
      }

      if (!tokenObtained) {
        // "rest_no_route" = le snippet miad-auth.php n'est pas encore installé
        const isNoRoute = authData.code === 'rest_no_route' || fallbackRes.status === 404
        const isJwtBadConfig = authData.code === 'jwt_auth_bad_config'

        let msg: string
        if (isNoRoute) {
          msg = 'Service de connexion en cours de configuration. Veuillez utiliser "Continuer avec Google" ou réessayer dans quelques instants.'
        } else if (isJwtBadConfig) {
          msg = 'La configuration du serveur d\'authentification est incomplète. Contactez le support.'
        } else {
          msg = authData.message || 'Identifiants ou mot de passe incorrects'
        }

        return NextResponse.json({ message: msg }, { status: isNoRoute ? 503 : 401 })
      }
    }

    // 2. Récupération des détails du profil utilisateur pour obtenir les rôles
    // Ajout de ?context=edit pour s'assurer que les rôles et l'email sont bien renvoyés par WordPress
    const userResponse = await fetch(`${WOO_URL}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { 
        'Authorization': `Bearer ${authData.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Headless-Secret': INTERNAL_SECRET,
        'User-Agent': 'MIAD-Headless-Client'
      },
      next: { revalidate: 0 }
    });

    if (!userResponse.ok) {
      // On retourne quand même le token si on l'a, pour éviter de bloquer l'utilisateur
      return NextResponse.json({
        success: true,
        token: authData.token,
        role: 'buyer', // Par défaut
        user_display_name: authData.user_display_name || username,
        user_email: authData.user_email || username // Fallback for email
      });
    }

    // Vérification de sécurité avant le parsing JSON
    const userContentType = userResponse.headers.get("content-type");
    if (!userContentType || !userContentType.includes("application/json")) {
      await userResponse.text(); // consume body
      return NextResponse.json({
        success: true,
        token: authData.token,
        role: 'buyer',
        user_display_name: authData.user_display_name || username
      });
    }

    const userData = await userResponse.json();
    // et la logique isAdmin/isVendor fonctionnera comme prévu.
    const roles = userData.roles || [];
    const isAdmin  = roles.includes('administrator');
    const isVendor = roles.some((r: string) => ['seller', 'wcfm_vendor', 'vendor'].includes(r));
    const isRep    = roles.some((r: string) => ['miad_representative', 'miad_representant', 'representant', 'miad_rep', 'miad_agent', 'miad_super_rep'].includes(r));

    return NextResponse.json({
      success: true,
      token: authData.token,
      user_display_name: authData.user_display_name || authData.user_nicename || userData.name,
      id: userData.id,
      user_email: authData.user_email || userData.email,
      user_nicename: authData.user_nicename || userData.slug,
      role: isAdmin ? 'admin' : (isVendor ? 'vendor' : (isRep ? 'representant' : 'buyer')),
      avatar: userData.avatar_urls?.['96'] || userData.avatar,
    })

  } catch (error: any) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({
        message: "Le serveur a renvoyé une réponse invalide. Vérifiez la configuration du pare-feu WordPress."
      }, { status: 502 });
    }

    return NextResponse.json(
      { message: error.message || 'Erreur lors de la connexion' },
      { status: 500 }
    )
  }
}
