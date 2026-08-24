<?php
/**
 * Plugin Name: MIAD Auth — Endpoint d'authentification de secours
 * Description: Fournit /wp-json/miad/v1/auth quand le plugin JWT Auth
 *              retourne 403 (plugin absent, clé manquante, WAF, etc.).
 *              Utilise wp_authenticate() natif et stocke la session en
 *              transient WordPress (24h). Compatible PHP 7.4+.
 * Version: 1.0
 * Author: MIAD Market
 *
 * INSTALLATION : Code Snippets (WordPress) ou functions.php
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   0. EXPÉDITEUR EMAIL — noreply@miadmarket.com
═══════════════════════════════════════════════════════════════════ */

add_filter( 'wp_mail_from',      fn() => 'noreply@miadmarket.com' );
add_filter( 'wp_mail_from_name', fn() => 'MIAD Market' );

/* ═══════════════════════════════════════════════════════════════════
   1. ENDPOINT /wp-json/miad/v1/auth — Login
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {

    // POST /wp-json/miad/v1/auth  — génère un token de session MIAD
    register_rest_route( 'miad/v1', '/auth', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            $username = sanitize_user( (string) $req->get_param( 'username' ) );
            $password = (string) $req->get_param( 'password' );

            if ( ! $username || ! $password ) {
                return new WP_Error( 'missing', 'Identifiants manquants', [ 'status' => 400 ] );
            }

            $user = wp_authenticate( $username, $password );

            if ( is_wp_error( $user ) ) {
                // Message générique pour ne pas révéler si l'email existe
                return new WP_Error( 'auth_failed', 'Identifiants ou mot de passe incorrects', [ 'status' => 401 ] );
            }

            // Génère un token de session sécurisé (64 hex chars)
            $token = 'miad_' . bin2hex( random_bytes( 32 ) );

            // Stocke en transient : miad_session_{token} → user_id (24h)
            set_transient( 'miad_sess_' . $token, $user->ID, DAY_IN_SECONDS );

            $roles     = (array) $user->roles;
            $is_admin  = in_array( 'administrator', $roles, true );
            $is_vendor = (bool) array_intersect( [ 'seller', 'vendor', 'wcfm_vendor', 'dc_vendor' ], $roles );

            return [
                'success'          => true,
                'token'            => $token,
                'user_display_name'=> $user->display_name,
                'user_email'       => $user->user_email,
                'user_nicename'    => $user->user_nicename,
                'id'               => $user->ID,
                'role'             => $is_admin ? 'admin' : ( $is_vendor ? 'vendor' : 'buyer' ),
                'avatar'           => get_avatar_url( $user->ID, [ 'size' => 96 ] ),
            ];
        },
    ] );

    // ── POST /miad/v1/otp/send ──────────────────────────────────────────────
    register_rest_route( 'miad/v1', '/otp/send', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            $email = sanitize_email( (string) $req->get_param( 'email' ) );
            if ( ! is_email( $email ) ) {
                return new WP_Error( 'invalid_email', 'Adresse email invalide.', [ 'status' => 400 ] );
            }
            $code = str_pad( (string) random_int( 0, 999999 ), 6, '0', STR_PAD_LEFT );
            $hash = md5( $email . AUTH_SALT );
            set_transient( "miad_otp_{$hash}", [
                'code'     => wp_hash_password( $code ),
                'email'    => $email,
                'attempts' => 0,
            ], 600 ); // 10 minutes
            $subject = "{$code} — Votre code de connexion MIAD Market";
            $body = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code MIAD</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);" cellpadding="0" cellspacing="0">

      <!-- En-tête verte -->
      <tr>
        <td style="background:linear-gradient(135deg,#005826 0%,#007a38 100%);padding:36px 40px;text-align:center;">
          <img src="https://www.miadmarket.com/logo/logo.png" alt="MIAD Market" width="56" height="56"
               style="border-radius:14px;background:#fff;padding:6px;display:block;margin:0 auto 14px;">
          <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">MIAD Market</p>
          <p style="margin:4px 0 0;font-size:12px;color:rgba(255,255,255,.65);letter-spacing:1px;text-transform:uppercase;">Made in Africa · Shared with the World</p>
        </td>
      </tr>

      <!-- Corps -->
      <tr>
        <td style="padding:40px 40px 32px;">

          <p style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111827;text-align:center;">Votre code de connexion</p>
          <p style="margin:0 0 32px;font-size:15px;color:#6b7280;text-align:center;">Entrez ce code à 6 chiffres pour vous connecter :</p>

          <!-- Code en un seul bloc — sélection/copie en un geste, sans espaces parasites
               introduits par des cellules séparées par chiffre -->
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 10px;width:100%;">
            <tr>
              <td style="background:#f0faf4;border:2px solid #005826;border-radius:14px;text-align:center;padding:18px 12px;">
                <span style="font-size:38px;font-weight:900;color:#005826;font-family:\'Courier New\',monospace;letter-spacing:8px;">' . esc_html( $code ) . '</span>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 32px;font-size:12px;color:#9ca3af;text-align:center;">Sélectionnez le code ci-dessus pour le copier rapidement.</p>

          <!-- Timer -->
          <table cellpadding="0" cellspacing="0" style="background:#fefce8;border:1px solid #fde68a;border-radius:12px;margin:0 auto 28px;width:100%;">
            <tr>
              <td style="padding:14px 20px;text-align:center;">
                <span style="font-size:14px;color:#92400e;font-weight:600;">Ce code expire dans <strong>10 minutes</strong></span>
              </td>
            </tr>
          </table>

          <!-- Avertissement -->
          <table cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;margin:0 auto;width:100%;">
            <tr>
              <td style="padding:14px 20px;text-align:center;">
                <span style="font-size:13px;color:#991b1b;font-weight:600;">Ne partagez jamais ce code. MIAD ne vous le demandera jamais.</span>
              </td>
            </tr>
          </table>

        </td>
      </tr>

      <!-- Séparateur -->
      <tr><td style="height:1px;background:#f3f4f6;"></td></tr>

      <!-- Pied de page -->
      <tr>
        <td style="padding:24px 40px;text-align:center;">
          <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;">Si vous n\'avez pas demandé ce code, ignorez cet email.</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            &copy; ' . date('Y') . ' MIAD Market &nbsp;·&nbsp;
            <a href="https://www.miadmarket.com" style="color:#005826;text-decoration:none;">miadmarket.com</a>
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body></html>';
            wp_mail( $email, $subject, $body, [ 'Content-Type: text/html; charset=UTF-8' ] );
            return [ 'success' => true ];
        },
    ] );

    // ── POST /miad/v1/otp/send-email — envoie l'email OTP pour un code généré côté Next.js ──
    // Appelé par le serveur Next.js (X-Headless-Secret requis) pour envoyer le template
    // OTP brandé après avoir stocké le code dans Firestore.
    register_rest_route( 'miad/v1', '/otp/send-email', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            // Server-to-server only — verify internal secret
            $expected = defined( 'MIAD_HEADLESS_SECRET' ) ? MIAD_HEADLESS_SECRET : null; // secret obligatoire, doit etre defini dans wp-config.php
            $received = $req->get_header( 'x-headless-secret' );
            if ( ! $expected || ! $received || ! hash_equals( $expected, $received ) ) {
                return new WP_Error( 'forbidden', 'Forbidden', [ 'status' => 403 ] );
            }

            $email = sanitize_email( (string) $req->get_param( 'email' ) );
            $code  = preg_replace( '/\D/', '', (string) $req->get_param( 'code' ) );
            if ( ! is_email( $email ) || strlen( $code ) !== 6 ) {
                return new WP_Error( 'missing', 'Email et code requis.', [ 'status' => 400 ] );
            }

            $subject = "{$code} — Votre code de connexion MIAD Market";
            $body = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Code MIAD</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);" cellpadding="0" cellspacing="0">
      <tr><td style="background:linear-gradient(135deg,#005826 0%,#007a38 100%);padding:36px 40px;text-align:center;">
        <img src="https://www.miadmarket.com/wp-content/uploads/logo.png" alt="MIAD Market" width="56" height="56" style="border-radius:14px;background:#fff;padding:6px;display:block;margin:0 auto 14px;">
        <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;">MIAD Market</p>
        <p style="margin:4px 0 0;font-size:12px;color:rgba(255,255,255,.65);letter-spacing:1px;text-transform:uppercase;">Made in Africa · Shared with the World</p>
      </td></tr>
      <tr><td style="padding:40px 40px 32px;">
        <p style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111827;text-align:center;">Votre code de connexion</p>
        <p style="margin:0 0 32px;font-size:15px;color:#6b7280;text-align:center;">Entrez ce code à 6 chiffres pour vous connecter :</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 auto 10px;width:100%;">
          <tr>
            <td style="background:#f0faf4;border:2px solid #005826;border-radius:14px;text-align:center;padding:18px 12px;">
              <span style="font-size:38px;font-weight:900;color:#005826;font-family:\'Courier New\',monospace;letter-spacing:8px;">' . esc_html( $code ) . '</span>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 32px;font-size:12px;color:#9ca3af;text-align:center;">Sélectionnez le code ci-dessus pour le copier rapidement.</p>
        <table cellpadding="0" cellspacing="0" style="background:#fefce8;border:1px solid #fde68a;border-radius:12px;margin:0 auto 28px;width:100%;">
          <tr><td style="padding:14px 20px;text-align:center;"><span style="font-size:14px;color:#92400e;font-weight:600;">Ce code expire dans <strong>10 minutes</strong></span></td></tr>
        </table>
        <table cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;margin:0 auto;width:100%;">
          <tr><td style="padding:14px 20px;text-align:center;"><span style="font-size:13px;color:#991b1b;font-weight:600;">Ne partagez jamais ce code. MIAD ne vous le demandera jamais.</span></td></tr>
        </table>
      </td></tr>
      <tr><td style="height:1px;background:#f3f4f6;"></td></tr>
      <tr><td style="padding:24px 40px;text-align:center;">
        <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;">Si vous n\'avez pas demandé ce code, ignorez cet email.</p>
        <p style="margin:0;font-size:12px;color:#9ca3af;">&copy; ' . date('Y') . ' MIAD Market &nbsp;·&nbsp;<a href="https://www.miadmarket.com" style="color:#005826;text-decoration:none;">miadmarket.com</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>';
            wp_mail( $email, $subject, $body, [ 'Content-Type: text/html; charset=UTF-8' ] );
            return [ 'success' => true ];
        },
    ] );

    // ── POST /miad/v1/otp/verify ─────────────────────────────────────────────
    register_rest_route( 'miad/v1', '/otp/verify', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            $email        = sanitize_email( (string) $req->get_param( 'email' ) );
            $code         = preg_replace( '/\D/', '', (string) $req->get_param( 'code' ) );
            $name         = sanitize_text_field( (string) ( $req->get_param( 'name' )         ?: '' ) );
            $phone        = sanitize_text_field( (string) ( $req->get_param( 'phone' )        ?: '' ) );
            $account_type = sanitize_key( (string) ( $req->get_param( 'account_type' ) ?: 'buyer' ) );

            if ( ! is_email( $email ) || strlen( $code ) !== 6 ) {
                return new WP_Error( 'missing', 'Email et code à 6 chiffres requis.', [ 'status' => 400 ] );
            }
            $hash = md5( $email . AUTH_SALT );
            $data = get_transient( "miad_otp_{$hash}" );
            if ( ! $data ) {
                return new WP_Error( 'expired', 'Code expiré. Demandez un nouveau code.', [ 'status' => 400 ] );
            }
            if ( (int) $data['attempts'] >= 5 ) {
                delete_transient( "miad_otp_{$hash}" );
                return new WP_Error( 'too_many', 'Trop de tentatives. Demandez un nouveau code.', [ 'status' => 429 ] );
            }
            if ( ! wp_check_password( $code, $data['code'] ) ) {
                $data['attempts']++;
                set_transient( "miad_otp_{$hash}", $data, 600 );
                $left = 5 - (int) $data['attempts'];
                return new WP_Error( 'invalid_code', "Code incorrect. {$left} essai(s) restant(s).", [ 'status' => 400 ] );
            }
            delete_transient( "miad_otp_{$hash}" );

            // Récupérer ou créer l'utilisateur
            $user = get_user_by( 'email', $email );
            if ( ! $user ) {
                $base  = sanitize_user( strtolower( (string) explode( '@', $email )[0] ), true ) ?: 'user';
                $login = $base;
                $i     = 1;
                while ( username_exists( $login ) ) { $login = $base . '_' . $i++; }
                $uid = wp_create_user( $login, wp_generate_password( 20 ), $email );
                if ( is_wp_error( $uid ) ) {
                    return new WP_Error( 'create_failed', 'Impossible de créer le compte.', [ 'status' => 500 ] );
                }
                $user = get_userdata( $uid );
                if ( $name ) {
                    $parts = explode( ' ', trim( $name ), 2 );
                    wp_update_user( [ 'ID' => $uid, 'display_name' => $name, 'first_name' => $parts[0], 'last_name' => $parts[1] ?? '' ] );
                }
                if ( $phone ) update_user_meta( $uid, 'billing_phone', $phone );
                if ( $account_type === 'vendor' ) $user->set_role( 'seller' );
                do_action( 'miad_new_customer_registered', $uid, $email, $name ?: '' );
            }

            $token = 'miad_' . bin2hex( random_bytes( 32 ) );
            set_transient( 'miad_sess_' . $token, $user->ID, DAY_IN_SECONDS );
            $roles     = (array) $user->roles;
            $is_admin  = in_array( 'administrator', $roles, true );
            $is_vendor = (bool) array_intersect( [ 'seller', 'vendor', 'wcfm_vendor', 'dc_vendor' ], $roles );
            $is_rep    = (bool) array_intersect( [ 'miad_representative', 'miad_representant', 'representant', 'miad_rep', 'miad_agent' ], $roles );
            return [
                'success'          => true,
                'token'            => $token,
                'user_display_name'=> $user->display_name,
                'user_email'       => $user->user_email,
                'user_nicename'    => $user->user_nicename,
                'id'               => $user->ID,
                'role'             => $is_admin ? 'admin' : ( $is_vendor ? 'vendor' : ( $is_rep ? 'representant' : 'buyer' ) ),
                'roles'            => $roles,
                'avatar'           => get_avatar_url( $user->ID, [ 'size' => 96 ] ),
            ];
        },
    ] );

    // GET /wp-json/miad/v1/me  — profil de l'utilisateur courant
    register_rest_route( 'miad/v1', '/me', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            $user_id = miad_get_user_from_token();
            if ( ! $user_id ) {
                return new WP_Error( 'unauthorized', 'Session invalide ou expirée', [ 'status' => 401 ] );
            }

            $user    = get_userdata( $user_id );
            $roles   = (array) $user->roles;
            $is_admin  = in_array( 'administrator', $roles, true );
            $is_vendor = (bool) array_intersect( [ 'seller', 'vendor', 'wcfm_vendor', 'dc_vendor' ], $roles );
            $is_rep    = (bool) array_intersect( [ 'miad_representative', 'miad_representant', 'representant', 'miad_rep', 'miad_agent' ], $roles );

            // Données WooCommerce client
            $customer = function_exists( 'wc_get_customer' ) ? new WC_Customer( $user_id ) : null;

            return [
                'id'           => $user->ID,
                'display_name' => $user->display_name,
                'email'        => $user->user_email,
                'role'         => $is_admin ? 'admin' : ( $is_vendor ? 'vendor' : ( $is_rep ? 'representant' : 'buyer' ) ),
                'roles'        => $roles,
                'avatar'       => get_avatar_url( $user_id, [ 'size' => 96 ] ),
                'billing'      => $customer ? [
                    'first_name' => $customer->get_billing_first_name(),
                    'last_name'  => $customer->get_billing_last_name(),
                    'address_1'  => $customer->get_billing_address_1(),
                    'city'       => $customer->get_billing_city(),
                    'country'    => $customer->get_billing_country(),
                    'phone'      => $customer->get_billing_phone(),
                ] : [],
            ];
        },
    ] );

    // DELETE /wp-json/miad/v1/auth  — déconnexion (révoque le token)
    register_rest_route( 'miad/v1', '/auth', [
        'methods'             => 'DELETE',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            $user_id = miad_get_user_from_token();
            $token   = miad_extract_bearer_token();
            if ( $token ) delete_transient( 'miad_sess_' . $token );
            return [ 'success' => true ];
        },
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   2. FILTRE determine_current_user — authentifie les requêtes REST
      avec le token de session MIAD (Bearer miad_xxxx)
═══════════════════════════════════════════════════════════════════ */

add_filter( 'determine_current_user', function ( $user_id ) {
    // Si WordPress a déjà un user, on ne touche pas
    if ( $user_id ) return $user_id;

    $stored = miad_get_user_from_token();
    return $stored ?: $user_id;
}, 20 );

/* ═══════════════════════════════════════════════════════════════════
   3. HELPERS
═══════════════════════════════════════════════════════════════════ */

function miad_extract_bearer_token(): string {
    // Try multiple sources — FastCGI / Nginx / Apache all behave differently
    $header = $_SERVER['HTTP_AUTHORIZATION']
           ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']  // CGI redirect
           ?? '';

    if ( ! $header && function_exists( 'apache_request_headers' ) ) {
        $all    = apache_request_headers();
        $header = $all['Authorization'] ?? $all['authorization'] ?? '';
    }

    if ( ! $header ) {
        // Last resort: read directly from the WP REST request if available
        global $wp;
        if ( ! empty( $wp->query_vars['rest_route'] ) && class_exists( 'WP_REST_Server' ) ) {
            $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        }
    }

    if ( preg_match( '/Bearer\s+(.+)$/i', $header, $m ) ) {
        return trim( $m[1] );
    }
    return '';
}

function miad_get_user_from_token(): int {
    // Method 1: Standard Bearer token from Authorization header
    $token = miad_extract_bearer_token();
    if ( $token && strpos( $token, 'miad_' ) === 0 ) {
        $user_id = (int) get_transient( 'miad_sess_' . $token );
        if ( $user_id > 0 ) return $user_id;
    }

    // Method 2: Server-to-server call from Next.js (avoids JWT Auth interference)
    // Next.js sends X-Headless-Secret + X-Miad-Session instead of Authorization
    $expected = defined( 'MIAD_HEADLESS_SECRET' ) ? MIAD_HEADLESS_SECRET : null; // secret obligatoire, doit etre defini dans wp-config.php
    $received = $_SERVER['HTTP_X_HEADLESS_SECRET'] ?? '';
    if ( $expected && $received && hash_equals( $expected, $received ) ) {
        $session = trim( $_SERVER['HTTP_X_MIAD_SESSION'] ?? '' );
        if ( $session && strpos( $session, 'miad_' ) === 0 ) {
            $user_id = (int) get_transient( 'miad_sess_' . $session );
            if ( $user_id > 0 ) return $user_id;
        }
    }

    return 0;
}

/* ═══════════════════════════════════════════════════════════════════
   4. ROUTES PUBLIQUES — Bypass tout plugin d'auth pour OTP et auth
      (WordPress Application Passwords, JWT Auth, etc.)
═══════════════════════════════════════════════════════════════════ */

// Priority PHP_INT_MAX = runs LAST, after every other plugin (including JWT Auth at priority 10 or 99).
// This guarantees our MIAD routes are never blocked by JWT Auth regardless of its priority.
add_filter( 'rest_authentication_errors', function ( $error ) {
    $uri = $_SERVER['REQUEST_URI'] ?? '';
    $open_routes = [
        '/miad/v1/otp/send',
        '/miad/v1/otp/send-email',
        '/miad/v1/otp/verify',
        '/miad/v1/auth',
        '/miad/v1/me',
        '/miad/v1/representant/',
        '/miad/v1/messages',
        '/miad/v1/email/',
        '/miad/v1/tracking',
        '/miad/v1/create-payment-intent',
        '/miad/v1/create-paydunya-payment',
    ];
    foreach ( $open_routes as $route ) {
        if ( strpos( $uri, $route ) !== false ) {
            return null; // Always override JWT Auth errors for MIAD routes
        }
    }
    return $error;
}, PHP_INT_MAX );

// Whitelist pour le plugin JWT Auth (si installé)
add_filter( 'jwt_auth_whitelist', function ( $endpoints ) {
    $base = get_site_url();
    return array_merge( (array) $endpoints, [
        $base . '/wp-json/miad/v1/otp/send',
        $base . '/wp-json/miad/v1/otp/send-email',
        $base . '/wp-json/miad/v1/otp/verify',
        $base . '/wp-json/miad/v1/auth',
        $base . '/wp-json/miad/v1/me',
        $base . '/wp-json/miad/v1/representant/',
        $base . '/wp-json/miad/v1/messages',
        $base . '/wp-json/miad/v1/email/',
        $base . '/wp-json/miad/v1/create-payment-intent',
        $base . '/wp-json/miad/v1/create-paydunya-payment',
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   5. CORS — Autorise les requêtes depuis le front Next.js
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {
    remove_filter( 'rest_pre_serve_request', 'rest_send_cors_headers' );
    add_filter( 'rest_pre_serve_request', function ( $value ) {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        $allowed = [
            'https://www.miadmarket.com',
            'https://miadmarket.com',
            'http://localhost:3000',
            'http://localhost:3001',
        ];
        if ( in_array( $origin, $allowed, true ) || ( defined( 'WP_DEBUG' ) && WP_DEBUG ) ) {
            header( 'Access-Control-Allow-Origin: ' . ( $origin ?: '*' ) );
            header( 'Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS' );
            header( 'Access-Control-Allow-Headers: Authorization, Content-Type, X-Headless-Secret, X-Miad-Session' );
            header( 'Access-Control-Allow-Credentials: true' );
        }
        return $value;
    } );
}, 15 );
