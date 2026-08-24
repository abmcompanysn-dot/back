<?php
/**
 * Plugin Name: MIAD API Cache
 * Description: Met en cache les réponses des endpoints REST lents (Dokan stores,
 *              produits WooCommerce) pour éviter de refaire le calcul lourd à
 *              chaque requête. Réduit /wp-json/dokan/v1/stores de ~10s à quasi
 *              instantané sur cache chaud. Le cache se purge automatiquement
 *              dès qu'un produit ou une boutique est modifié.
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   CONFIGURATION — routes mises en cache et leur durée de vie (secondes)
═══════════════════════════════════════════════════════════════════ */

function miad_api_cache_routes(): array {
    // 24h pour tout — sûr car le cache est purgé automatiquement dès qu'un
    // produit ou une boutique change (voir les hooks de purge plus bas),
    // donc la durée longue ne sert qu'à éviter de recalculer pour rien.
    return [
        '#^/dokan/v1/stores#'              => DAY_IN_SECONDS,
        '#^/wc/v3/products$#'              => DAY_IN_SECONDS,
        '#^/wc/v3/products/categories#'    => DAY_IN_SECONDS,
    ];
}

function miad_api_cache_ttl_for_route( string $route ): ?int {
    foreach ( miad_api_cache_routes() as $pattern => $ttl ) {
        if ( preg_match( $pattern, $route ) ) return $ttl;
    }
    return null;
}

/**
 * Clé basée sur $_SERVER['REQUEST_URI'] brut plutôt que sur
 * $request->get_query_params() : ce dernier peut être enrichi par
 * WooCommerce entre rest_pre_dispatch et rest_post_dispatch (valeurs par
 * défaut appliquées aux arguments optionnels), ce qui change la clé
 * calculée selon le moment et fait que la lecture ne retrouve jamais ce
 * que l'écriture vient de stocker. L'URL brute, elle, ne bouge jamais
 * pendant le traitement d'une même requête.
 */
function miad_api_cache_key( WP_REST_Request $request ): string {
    $uri = $_SERVER['REQUEST_URI'] ?? ( $request->get_route() . '?' . http_build_query( $request->get_query_params() ) );
    $uri = preg_replace( '/([?&])(consumer_key|consumer_secret)=[^&]*/', '$1', $uri ); // pas de secrets dans la clé
    return 'miad_api_cache_' . md5( $uri );
}

/**
 * Lecture/écriture directes dans wp_options via $wpdb, en CONTOURNANT
 * volontairement get_transient()/set_transient().
 *
 * Raison : sur cet hébergement, les transients ne persistent jamais entre
 * deux requêtes (vérifié : deux appels identiques consécutifs renvoient
 * tous les deux "MISS"), très probablement parce qu'un cache d'objet local
 * (APCu/Memcached non partagé entre workers PHP-FPM) intercepte les
 * transients avant qu'ils n'atteignent la base de données. Écrire/lire
 * directement la table wp_options (toujours partagée, c'est MySQL) évite
 * ce problème quelle que soit la cause exacte côté serveur.
 */
function miad_api_cache_get_raw( string $key ): ?array {
    global $wpdb;
    $row = $wpdb->get_var( $wpdb->prepare(
        "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
        '_miad_raw_cache_' . $key
    ) );
    if ( $row === null ) return null;
    $decoded = json_decode( $row, true );
    if ( ! is_array( $decoded ) || ! isset( $decoded['expires'] ) ) return null;
    if ( $decoded['expires'] < time() ) {
        $wpdb->delete( $wpdb->options, [ 'option_name' => '_miad_raw_cache_' . $key ] );
        return null;
    }
    return $decoded;
}

function miad_api_cache_set_raw( string $key, $data, int $status, int $ttl ): void {
    global $wpdb;
    $payload = wp_json_encode( [ 'data' => $data, 'status' => $status, 'expires' => time() + $ttl ] );
    $option_name = '_miad_raw_cache_' . $key;
    $exists = $wpdb->get_var( $wpdb->prepare( "SELECT option_id FROM {$wpdb->options} WHERE option_name = %s", $option_name ) );
    if ( $exists ) {
        $wpdb->update( $wpdb->options, [ 'option_value' => $payload ], [ 'option_name' => $option_name ] );
    } else {
        $wpdb->insert( $wpdb->options, [ 'option_name' => $option_name, 'option_value' => $payload, 'autoload' => 'no' ] );
    }
}

/* ═══════════════════════════════════════════════════════════════════
   INTERCEPTION — sert le cache si présent, sinon laisse passer et
   enregistre le résultat pour la prochaine fois.
═══════════════════════════════════════════════════════════════════ */

add_filter( 'rest_pre_dispatch', function ( $result, WP_REST_Server $server, WP_REST_Request $request ) {
    if ( $request->get_method() !== 'GET' ) return $result;

    $ttl = miad_api_cache_ttl_for_route( $request->get_route() );
    if ( $ttl === null ) return $result;

    $cached = miad_api_cache_get_raw( miad_api_cache_key( $request ) );
    if ( $cached === null ) return $result;

    $response = new WP_REST_Response( $cached['data'] );
    $response->set_status( $cached['status'] );
    $response->header( 'X-Miad-Cache', 'HIT' );
    return $response;
}, 5, 3 );

add_filter( 'rest_post_dispatch', function ( $response, WP_REST_Server $server, WP_REST_Request $request ) {
    if ( $request->get_method() !== 'GET' || ! ( $response instanceof WP_REST_Response ) ) return $response;

    $ttl = miad_api_cache_ttl_for_route( $request->get_route() );
    if ( $ttl === null ) return $response;

    // Déjà servi depuis le cache — ne pas réenregistrer inutilement
    $existing_headers = $response->get_headers();
    if ( ( $existing_headers['X-Miad-Cache'] ?? '' ) === 'HIT' ) return $response;

    if ( $response->get_status() >= 200 && $response->get_status() < 300 ) {
        miad_api_cache_set_raw( miad_api_cache_key( $request ), $response->get_data(), $response->get_status(), $ttl );
        $response->header( 'X-Miad-Cache', 'MISS' );
    }

    return $response;
}, 10, 3 );

/* ═══════════════════════════════════════════════════════════════════
   PURGE AUTOMATIQUE — dès qu'une boutique ou un produit change, on vide
   tout le cache plutôt que de cibler une clé précise (le coût de
   recalculer au prochain hit est négligeable face à la complexité de
   cibler la bonne clé parmi toutes les combinaisons de paramètres).
═══════════════════════════════════════════════════════════════════ */

function miad_api_cache_flush(): void {
    global $wpdb;
    $wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '_miad_raw_cache_miad_api_cache_%'" );
}

// 'profile_update' a été retiré : ce hook se déclenche en réalité à quasi
// chaque requête REST authentifiée (WooCommerce/Dokan touchent les métadonnées
// utilisateur à l'authentification), donc il vidait le cache en continu et
// le faisait rester à 0 entrée en permanence — la mise en cache ne servait
// jamais à rien. 'dokan_store_profile_saved' suffit pour purger sur un vrai
// changement de boutique.
foreach ( [
    'woocommerce_update_product',
    'woocommerce_new_product',
    'woocommerce_delete_product',
    'dokan_store_profile_saved',
    'dokan_new_seller_created',
] as $hook ) {
    add_action( $hook, 'miad_api_cache_flush' );
}

/* ═══════════════════════════════════════════════════════════════════
   PAGE ADMIN — purge manuelle + statut
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_submenu_page( 'tools.php', 'MIAD API Cache', '⚡ MIAD API Cache', 'manage_options', 'miad-api-cache', 'miad_api_cache_page' );
} );

add_action( 'wp_ajax_miad_api_cache_flush', function () {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );
    miad_api_cache_flush();
    wp_send_json_success();
} );

function miad_api_cache_page(): void {
    global $wpdb;
    $count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE '_miad_raw_cache_miad_api_cache_%'" );
    ?>
    <div class="wrap" style="max-width:700px">
        <h1>⚡ MIAD API Cache</h1>
        <p style="color:#555">
            Met en cache les réponses des endpoints lents (boutiques Dokan, produits WooCommerce)
            pour accélérer le chargement du site headless. Se purge automatiquement à chaque
            modification de produit ou de boutique.
        </p>
        <table class="form-table">
            <tr><th>Routes en cache</th><td><code>/dokan/v1/stores</code>, <code>/wc/v3/products</code>, <code>/wc/v3/products/categories</code> (24h, purgé automatiquement à chaque modification)</td></tr>
            <tr><th>Entrées actuellement en cache</th><td id="miad-cache-count"><?= $count ?></td></tr>
        </table>
        <button type="button" id="miad-cache-flush-btn" class="button button-primary">🗑️ Vider le cache maintenant</button>
        <span id="miad-cache-flush-status" style="margin-left:10px;color:#555"></span>
    </div>
    <script>
    jQuery(document).ready(function($) {
        $('#miad-cache-flush-btn').on('click', function() {
            var $btn = $(this); $btn.attr('disabled', true);
            $('#miad-cache-flush-status').text('⌛ Purge en cours…');
            $.post(ajaxurl, { action: 'miad_api_cache_flush' }, function(res) {
                $btn.attr('disabled', false);
                $('#miad-cache-flush-status').text(res.success ? '✅ Cache vidé.' : '❌ Erreur.');
                $('#miad-cache-count').text('0');
            });
        });
    });
    </script>
    <?php
}
