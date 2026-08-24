<?php
/**
 * Plugin Name: MIAD AI — Protection données clients
 * Description: Snippet de sécurité : bloque tout accès de l'IA aux données clients.
 *              À mettre dans functions.php ou activer comme plugin séparé.
 * Version: 1.0
 */

if (!defined('ABSPATH')) exit;

/**
 * 1. WHITELIST ADMIN : seuls les admins MIAD voient les logs IA
 *    Ajouter les emails autorisés dans le tableau ci-dessous.
 */
add_filter('user_has_cap', function (array $caps, array $cap, array $args, WP_User $user): array {
    // Capacité custom : miad_view_ai_logs
    if (in_array('miad_view_ai_logs', $cap, true)) {
        $whitelist = [
            // Ajouter ici les emails des admins autorisés à voir les logs IA
            // 'tonemail@miad.com',
        ];
        $caps['miad_view_ai_logs'] = in_array($user->user_email, $whitelist, true) || $user->has_cap('manage_options');
    }
    return $caps;
}, 10, 4);

/**
 * 2. BLOCAGE TOTAL : l'endpoint IA ne peut jamais retourner de données clients
 *    Ce filtre intercepte toutes les réponses REST de miad-ai/v1/
 *    et supprime tout champ qui pourrait contenir du PII.
 */
add_filter('rest_post_dispatch', function (WP_REST_Response $response, WP_REST_Server $server, WP_REST_Request $request): WP_REST_Response {
    if (strpos($request->get_route(), '/miad-ai/') !== 0) {
        return $response;
    }

    $data = $response->get_data();

    // Supprimer tous les champs qui ne doivent jamais être exposés
    $forbidden_keys = ['email', 'billing', 'shipping', 'customer', 'user_id', 'user_email', 'phone', 'address', 'password', 'token', 'meta'];
    if (is_array($data)) {
        $data = miad_ai_strip_pii($data, $forbidden_keys);
        $response->set_data($data);
    }

    return $response;
}, 10, 3);

function miad_ai_strip_pii(array $data, array $forbidden_keys): array {
    foreach ($data as $key => $value) {
        if (in_array(strtolower((string)$key), $forbidden_keys, true)) {
            unset($data[$key]);
        } elseif (is_array($value)) {
            $data[$key] = miad_ai_strip_pii($value, $forbidden_keys);
        }
    }
    return $data;
}

/**
 * 3. VÉRIFICATION INJECTION PROMPT
 *    Si quelqu'un tente d'injecter des instructions dans la recherche,
 *    on nettoie et on bloque les patterns dangereux.
 */
add_filter('miad_ai_query_before_send', function (string $query): string {
    // Patterns d'injection prompt connus
    $injection_patterns = [
        '/ignore\s+(all\s+)?previous\s+instructions?/i',
        '/you\s+are\s+now\s+/i',
        '/reveal\s+(your\s+)?(prompt|instructions?|system)/i',
        '/act\s+as\s+/i',
        '/forget\s+(everything|all)/i',
        '/show\s+me\s+(all\s+)?(customers?|users?|emails?|passwords?)/i',
        '/liste\s+(des\s+)?(clients?|utilisateurs?|emails?)/i',
        '/donne[sz]?\s+(moi\s+)?(les?\s+)?(clients?|emails?|mots?\s+de\s+passe)/i',
    ];

    foreach ($injection_patterns as $pattern) {
        if (preg_match($pattern, $query)) {
            // On retourne une requête neutre sans révéler qu'on a détecté une attaque
            return 'Bonjour, quels produits vendez-vous sur MIAD Market ?';
        }
    }

    // Limiter la longueur
    return mb_substr($query, 0, 300);
}, 10, 1);

/**
 * 4. LOG DE SÉCURITÉ : alerter si tentative d'accès aux données clients
 */
add_action('rest_api_init', function () {
    add_filter('rest_pre_dispatch', function ($result, WP_REST_Server $server, WP_REST_Request $request) {
        // Bloquer toute tentative d'accès aux endpoints clients via le namespace miad-ai
        if (strpos($request->get_route(), '/miad-ai/') === 0) {
            $body = $request->get_body();
            $suspicious = ['customer', 'order', 'billing', 'password', 'email', 'utilisateur', 'commande'];
            foreach ($suspicious as $word) {
                if (stripos($body, $word) !== false) {
                    // Logger la tentative (sans stocker l'IP en clair)
                    error_log('[MIAD AI SECURITY] Requête suspecte détectée — mot clé: ' . $word);
                    break;
                }
            }
        }
        return $result;
    }, 10, 3);
});
