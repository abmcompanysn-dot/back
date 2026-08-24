<?php
/**
 * Plugin Name: MIAD Performance — Cache variations WooCommerce
 * Description: Cache transient 30 min pour /wc/v3/products/{id}/variations
 *              et /wc/v3/products — réduit les requêtes SQL sous charge.
 * Version: 1.0
 * Author: MIAD Market
 *
 * INSTALLATION : Code Snippets (WordPress) — Run everywhere
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'MIAD_CACHE_TTL', 30 * MINUTE_IN_SECONDS );

/* ═══════════════════════════════════════════════════════════════════
   1. CACHE — Intercepte les GET /wc/v3/products/{id}/variations
              et /wc/v3/products avant l'exécution WordPress
═══════════════════════════════════════════════════════════════════ */

add_filter( 'rest_pre_dispatch', function ( $result, $server, WP_REST_Request $request ) {
    if ( $result !== null ) return $result;
    if ( $request->get_method() !== 'GET' ) return $result;

    $route = $request->get_route();
    if ( ! preg_match( '#/wc/v3/products(/\d+/variations)?$#', $route ) ) return $result;

    $cache_key = 'miad_rc_' . md5( $route . serialize( $request->get_params() ) );
    $cached    = get_transient( $cache_key );
    if ( $cached === false ) return $result;

    return rest_ensure_response( $cached );
}, 10, 3 );

/* ═══════════════════════════════════════════════════════════════════
   2. STOCKAGE — Enregistre la réponse en transient après exécution
═══════════════════════════════════════════════════════════════════ */

add_filter( 'rest_post_dispatch', function ( $result, $server, WP_REST_Request $request ) {
    if ( $request->get_method() !== 'GET' ) return $result;

    $route = $request->get_route();
    if ( ! preg_match( '#/wc/v3/products(/\d+/variations)?$#', $route ) ) return $result;

    $data = $result->get_data();
    if ( empty( $data ) ) return $result;

    $cache_key = 'miad_rc_' . md5( $route . serialize( $request->get_params() ) );
    // Ne stocker que si pas déjà en cache (évite double écriture)
    if ( get_transient( $cache_key ) === false ) {
        set_transient( $cache_key, $data, MIAD_CACHE_TTL );
    }

    return $result;
}, 10, 3 );

/* ═══════════════════════════════════════════════════════════════════
   3. INVALIDATION — Purge le cache quand un produit est mis à jour
═══════════════════════════════════════════════════════════════════ */

add_action( 'woocommerce_update_product', 'miad_purge_product_cache' );
add_action( 'woocommerce_new_product',    'miad_purge_product_cache' );
add_action( 'save_post_product',          'miad_purge_product_cache' );

function miad_purge_product_cache( int $product_id = 0 ): void {
    global $wpdb;
    $wpdb->query(
        "DELETE FROM {$wpdb->options}
         WHERE option_name LIKE '_transient_miad_rc_%'
            OR option_name LIKE '_transient_timeout_miad_rc_%'"
    );
}
