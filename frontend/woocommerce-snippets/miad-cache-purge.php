<?php
/**
 * Plugin Name: MIAD Cache Purge
 * Description: Notifie le frontend Next.js (revalidation ISR /
 *              app/api/webhooks/woocommerce) à chaque création,
 *              modification ou suppression de produit WooCommerce. Sans ce
 *              plugin, aucun webhook WooCommerce natif n'est configuré
 *              (vérifié via /wp-json/wc/v3/webhooks : liste vide) — le
 *              cache produits reste donc périmé jusqu'à sa revalidation
 *              naturelle (jusqu'à 1h côté Next.js + stale-while-revalidate
 *              d'1 an côté edge), ce qui fait réapparaître des produits
 *              supprimés au premier chargement.
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Envoie une notification fire-and-forget au frontend. Utilise le même
 * secret partagé (X-Headless-Secret) que les autres endpoints WP→Next.js
 * du projet (miad-rep-api.php, miad-tracking.php) — doit être défini dans
 * wp-config.php sous MIAD_HEADLESS_SECRET ou MIAD_INTERNAL_SECRET, et
 * correspondre à INTERNAL_API_SECRET côté .env.local Next.js.
 */
function miad_cache_purge_notify( int $product_id, string $action ): void {
    if ( wp_is_post_revision( $product_id ) || wp_is_post_autosave( $product_id ) ) return;

    // INTERNAL_API_SECRET en premier : c'est le nom de constante déjà confirmé
    // fonctionnel (miad-analytics-api.php, .env.local côté Next.js) après la
    // longue désynchronisation résolue le 2026-07-06 — les deux autres noms
    // restent en repli pour compatibilité avec les autres snippets existants.
    $secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET
        : ( defined( 'MIAD_HEADLESS_SECRET' ) ? MIAD_HEADLESS_SECRET
        : ( defined( 'MIAD_INTERNAL_SECRET' ) ? MIAD_INTERNAL_SECRET : null ) );
    if ( ! $secret ) return; // pas de secret configuré : on n'appelle jamais sans authentification

    $frontend = rtrim( get_option( 'miad_frontend_url', 'https://www.miadmarket.com' ), '/' );
    $product  = function_exists( 'wc_get_product' ) ? wc_get_product( $product_id ) : null;

    wp_remote_post( $frontend . '/api/webhooks/woocommerce', [
        'timeout'  => 5,
        'blocking' => false, // ne bloque jamais une sauvegarde/suppression dans l'admin WP
        'headers'  => [
            'Content-Type'      => 'application/json',
            'X-Headless-Secret' => $secret,
        ],
        'body' => wp_json_encode( [
            'action' => $action,
            'id'     => $product_id,
            'name'   => $product ? $product->get_name() : get_the_title( $product_id ),
        ] ),
    ] );
}

add_action( 'woocommerce_new_product', function ( $product_id ) {
    miad_cache_purge_notify( (int) $product_id, 'product.created' );
} );

add_action( 'woocommerce_update_product', function ( $product_id ) {
    miad_cache_purge_notify( (int) $product_id, 'product.updated' );
} );

// Couvre la suppression définitive ET la mise à la corbeille (le cas le plus
// fréquent depuis l'admin WP — "Supprimer" y met d'abord en corbeille).
add_action( 'before_delete_post', function ( $post_id ) {
    if ( get_post_type( $post_id ) !== 'product' ) return;
    miad_cache_purge_notify( (int) $post_id, 'product.deleted' );
} );

add_action( 'wp_trash_post', function ( $post_id ) {
    if ( get_post_type( $post_id ) !== 'product' ) return;
    miad_cache_purge_notify( (int) $post_id, 'product.deleted' );
} );
