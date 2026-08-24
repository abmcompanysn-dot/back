<?php
/**
 * Plugin Name: MIAD API — Sécurité de base
 * Description: Durcissement de sécurité pour l'API WooCommerce/WordPress headless
 *              (api.miadmarket.com) consommée par le frontend Next.js. À activer
 *              comme plugin séparé (wp-content/plugins/miad-api-security/) ou
 *              coller dans functions.php du thème actif.
 * Version: 1.0
 */

if (!defined('ABSPATH')) exit;

/**
 * ============================================================================
 * 1. SURFACE D'ATTAQUE CLASSIQUE WORDPRESS
 *    Ces vecteurs ne sont jamais utilisés par le frontend headless — on les
 *    désactive entièrement.
 * ============================================================================
 */

// Désactive XML-RPC (cible n°1 des attaques brute-force WordPress)
add_filter('xmlrpc_enabled', '__return_false');
add_filter('wp_headers', function (array $headers): array {
    unset($headers['X-Pingback']);
    return $headers;
});

// Masque la version de WordPress (évite le fingerprinting de vulnérabilités connues)
remove_action('wp_head', 'wp_generator');
add_filter('the_generator', '__return_empty_string');

// Retire le numéro de version des scripts/styles (?ver=6.x)
add_filter('style_loader_src', 'miad_remove_version_query', 9999);
add_filter('script_loader_src', 'miad_remove_version_query', 9999);
function miad_remove_version_query(string $src): string {
    return remove_query_arg('ver', $src);
}

// Bloque l'énumération des utilisateurs (/?author=1, /wp-json/wp/v2/users)
add_action('rest_authentication_errors', function ($result) {
    if (!is_user_logged_in() && strpos($_SERVER['REQUEST_URI'] ?? '', '/wp/v2/users') !== false) {
        return new WP_Error('rest_forbidden', 'Accès interdit.', ['status' => 403]);
    }
    return $result;
});
add_action('template_redirect', function () {
    if (!is_admin() && isset($_GET['author'])) {
        wp_die('Accès interdit.', 403);
    }
});

/**
 * ============================================================================
 * 2. LIMITATION DE TAUX (RATE LIMITING) SUR L'API REST
 *    Protège contre le scraping/abus automatisé sans pénaliser le frontend
 *    Next.js (identifié par son User-Agent + sa clé WooCommerce).
 * ============================================================================
 */
add_action('rest_api_init', function () {
    add_filter('rest_pre_dispatch', 'miad_check_ban', 0, 3);
    add_filter('rest_pre_dispatch', 'miad_rate_limit_rest', 1, 3);
}, 0);

/**
 * Bannissement temporaire après échecs 401/403 répétés sur l'API
 * (signe de tentative de devinette de clé/jeton/secret).
 */
const MIAD_AUTH_FAIL_LIMIT  = 8;             // échecs autorisés
const MIAD_AUTH_FAIL_WINDOW = 5 * MINUTE_IN_SECONDS;  // ... sur cette fenêtre
const MIAD_BAN_DURATION     = 30 * MINUTE_IN_SECONDS; // durée du bannissement

function miad_check_ban($result, WP_REST_Server $server, WP_REST_Request $request) {
    $ip = miad_get_client_ip();
    if (get_transient('miad_banned_' . md5($ip))) {
        return new WP_Error(
            'rest_temporarily_banned',
            'Accès temporairement bloqué suite à des échecs d\'authentification répétés.',
            ['status' => 403]
        );
    }
    return $result;
}

add_filter('rest_post_dispatch', function ($response, WP_REST_Server $server, WP_REST_Request $request) {
    if (!($response instanceof WP_REST_Response)) {
        return $response;
    }

    $status = $response->get_status();
    if ($status === 401 || $status === 403) {
        $ip       = miad_get_client_ip();
        $fail_key = 'miad_unauth_' . md5($ip);

        $fails = (int) get_transient($fail_key) + 1;
        set_transient($fail_key, $fails, MIAD_AUTH_FAIL_WINDOW);

        if ($fails >= MIAD_AUTH_FAIL_LIMIT) {
            set_transient('miad_banned_' . md5($ip), 1, MIAD_BAN_DURATION);
            error_log("[MIAD API SECURITY] IP bannie 30 min après {$fails} échecs 401/403 : {$ip}");
        }
    }

    return $response;
}, 999, 3);

function miad_rate_limit_rest($result, WP_REST_Server $server, WP_REST_Request $request) {
    // Le client headless officiel n'est jamais limité (déjà authentifié par clé WooCommerce/secret interne)
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    if ($ua === 'MIAD-Headless-Client') {
        return $result;
    }

    $ip  = miad_get_client_ip();
    $key = 'miad_rl_' . md5($ip);

    $count = (int) get_transient($key);
    $limit = 120; // requêtes / minute / IP pour le trafic non identifié

    if ($count >= $limit) {
        return new WP_Error(
            'rest_rate_limited',
            'Trop de requêtes. Réessayez dans une minute.',
            ['status' => 429]
        );
    }

    set_transient($key, $count + 1, MINUTE_IN_SECONDS);
    return $result;
}

function miad_get_client_ip(): string {
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $key) {
        if (!empty($_SERVER[$key])) {
            $ip = trim(explode(',', $_SERVER[$key])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) return $ip;
        }
    }
    return '0.0.0.0';
}

/**
 * ============================================================================
 * 3. PROTECTION ANTI BRUTE-FORCE SUR LA CONNEXION (wp-login.php / wp-admin)
 * ============================================================================
 */
add_filter('authenticate', 'miad_check_login_lockout', 1, 1);
function miad_check_login_lockout($user) {
    $ip  = miad_get_client_ip();
    $key = 'miad_login_fail_' . md5($ip);

    if ((int) get_transient($key) >= 5) {
        return new WP_Error('too_many_attempts', '<strong>Erreur</strong> : trop de tentatives échouées. Réessayez dans 15 minutes.');
    }
    return $user;
}
add_action('wp_login_failed', function (string $username) {
    $key = 'miad_login_fail_' . md5(miad_get_client_ip());
    set_transient($key, (int) get_transient($key) + 1, 15 * MINUTE_IN_SECONDS);
});
add_action('wp_login', function () {
    delete_transient('miad_login_fail_' . md5(miad_get_client_ip()));
});

/**
 * ============================================================================
 * 4. BLOCAGE DES SONDES DE FICHIERS SENSIBLES
 *    (.env, .git, wp-config.php, xmlrpc.php, etc. — jamais légitimement requêtés)
 * ============================================================================
 */
add_action('init', function () {
    $uri = $_SERVER['REQUEST_URI'] ?? '';
    $blocked_patterns = [
        '/\.env(\..+)?$/i',
        '/\.git\//i',
        '/wp-config\.php/i',
        '/xmlrpc\.php/i',
        '/wp-admin\/install\.php/i', // sonde classique : tentative de réinstallation/prise de contrôle
        '/wp-admin\/upgrade\.php/i',
        '/\.well-known\/(?!acme-challenge)/i', // garde acme-challenge pour Let's Encrypt
    ];
    foreach ($blocked_patterns as $pattern) {
        if (preg_match($pattern, $uri)) {
            status_header(403);
            exit('Accès interdit.');
        }
    }
});

/**
 * ============================================================================
 * 5. EN-TÊTES DE SÉCURITÉ HTTP
 *    Miroir des en-têtes déjà appliqués côté Next.js (middleware.ts) — défense
 *    en profondeur si l'API est appelée directement (hors frontend).
 * ============================================================================
 */
add_action('send_headers', function () {
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
});

/**
 * ============================================================================
 * 6. CORS RESTREINT SUR L'API REST
 *    Seuls les domaines MIAD (frontend Next.js) peuvent appeler l'API REST
 *    depuis un navigateur. Les appels serveur-à-serveur (Next.js backend,
 *    consumer key WooCommerce) ne sont pas concernés par CORS.
 * ============================================================================
 */
add_action('rest_api_init', function () {
    remove_filter('rest_pre_serve_request', 'rest_send_cors_headers');
    add_filter('rest_pre_serve_request', function ($value) {
        $allowed_origins = [
            'https://miadmarket.com',
            'https://www.miadmarket.com',
        ];
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if (in_array($origin, $allowed_origins, true)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Access-Control-Allow-Credentials: true');
        }
        header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Authorization, Content-Type, X-Headless-Secret, X-Miad-Session');
        return $value;
    });
}, 15);

/**
 * ============================================================================
 * 7. DURCISSEMENTS DIVERS
 * ============================================================================
 */

// Désactive l'éditeur de fichiers de thèmes/plugins dans wp-admin
// (Idéalement définir aussi DISALLOW_FILE_EDIT=true dans wp-config.php)
add_filter('map_meta_cap', function (array $caps, string $cap): array {
    if (in_array($cap, ['edit_themes', 'edit_plugins', 'edit_files'], true)) {
        return ['do_not_allow'];
    }
    return $caps;
}, 10, 2);

// Désactive la révélation des erreurs PHP/SQL dans les réponses REST en production
add_filter('rest_post_dispatch', function (WP_REST_Response $response): WP_REST_Response {
    $data = $response->get_data();
    if (is_array($data) && isset($data['data']['params'])) {
        unset($data['data']['params']); // évite l'écho des paramètres bruts dans les erreurs
        $response->set_data($data);
    }
    return $response;
}, 10, 1);
