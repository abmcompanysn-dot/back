<?php
/**
 * Plugin Name: MIAD Tracking — Suivi de commandes & logistique
 * Description: Endpoints REST pour gérer les numéros de suivi, les étiquettes
 *              et les événements logistiques des commandes WooCommerce.
 * Version: 1.0
 * Author: MIAD Market
 *
 * INSTALLATION : Code Snippets (WordPress) ou functions.php
 *
 * Endpoints exposés :
 *   GET  /wp-json/miad/v1/tracking/{order_id}         — récupère le suivi d'une commande
 *   POST /wp-json/miad/v1/tracking/{order_id}         — enregistre/met à jour le suivi
 *   POST /wp-json/miad/v1/tracking/{order_id}/event   — ajoute un événement manuel
 *   GET  /wp-json/miad/v1/tracking/search/{number}    — cherche une commande par n° de suivi
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════ */

/**
 * Vérifie que la requête vient du serveur Next.js (X-Headless-Secret)
 * ou d'un utilisateur authentifié avec les bons rôles.
 */
function miad_tracking_can_write(): bool {
    // Secret server-to-server
    $expected = defined( 'MIAD_HEADLESS_SECRET' ) ? MIAD_HEADLESS_SECRET : null; // secret obligatoire, doit etre defini dans wp-config.php
    $received = $_SERVER['HTTP_X_HEADLESS_SECRET'] ?? '';
    if ( $expected && hash_equals( $expected, $received ) ) return true;

    // Utilisateur WordPress authentifié (administrateur ou représentant)
    $user = wp_get_current_user();
    if ( ! $user->exists() ) return false;

    $allowed = [ 'administrator', 'miad_representative', 'miad_representant', 'representant', 'miad_rep', 'miad_agent' ];
    return (bool) array_intersect( $allowed, (array) $user->roles );
}

function miad_tracking_can_read(): bool {
    $expected = defined( 'MIAD_HEADLESS_SECRET' ) ? MIAD_HEADLESS_SECRET : null; // secret obligatoire, doit etre defini dans wp-config.php
    $received = $_SERVER['HTTP_X_HEADLESS_SECRET'] ?? '';
    if ( $expected && hash_equals( $expected, $received ) ) return true;

    return wp_get_current_user()->exists();
}

/* ═══════════════════════════════════════════════════════════════════
   REST ENDPOINTS
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {

    /* ── GET  /miad/v1/tracking/{order_id} ─────────────────────────── */
    register_rest_route( 'miad/v1', '/tracking/(?P<order_id>\d+)', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            if ( ! miad_tracking_can_read() ) {
                return new WP_Error( 'forbidden', 'Accès refusé', [ 'status' => 403 ] );
            }

            $order_id = (int) $req->get_param( 'order_id' );
            $order    = wc_get_order( $order_id );
            if ( ! $order ) {
                return new WP_Error( 'not_found', 'Commande introuvable', [ 'status' => 404 ] );
            }

            $tracking_number = $order->get_meta( '_miad_tracking_number', true );
            $carrier         = $order->get_meta( '_miad_carrier', true );
            $events_json     = $order->get_meta( '_miad_tracking_events', true );
            $events          = $events_json ? json_decode( $events_json, true ) : [];

            return [
                'order_id'        => $order_id,
                'tracking_number' => $tracking_number ?: '',
                'carrier'         => $carrier ?: '',
                'events'          => is_array( $events ) ? $events : [],
                'order_status'    => $order->get_status(),
                'order_total'     => $order->get_total(),
                'billing'         => [
                    'first_name' => $order->get_billing_first_name(),
                    'last_name'  => $order->get_billing_last_name(),
                    'email'      => $order->get_billing_email(),
                    'phone'      => $order->get_billing_phone(),
                ],
                'shipping' => [
                    'first_name' => $order->get_shipping_first_name(),
                    'last_name'  => $order->get_shipping_last_name(),
                    'address_1'  => $order->get_shipping_address_1(),
                    'address_2'  => $order->get_shipping_address_2(),
                    'city'       => $order->get_shipping_city(),
                    'state'      => $order->get_shipping_state(),
                    'postcode'   => $order->get_shipping_postcode(),
                    'country'    => $order->get_shipping_country(),
                ],
            ];
        },
    ] );

    /* ── POST /miad/v1/tracking/{order_id} ─────────────────────────── */
    register_rest_route( 'miad/v1', '/tracking/(?P<order_id>\d+)', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            if ( ! miad_tracking_can_write() ) {
                return new WP_Error( 'forbidden', 'Accès refusé', [ 'status' => 403 ] );
            }

            $order_id = (int) $req->get_param( 'order_id' );
            $order    = wc_get_order( $order_id );
            if ( ! $order ) {
                return new WP_Error( 'not_found', 'Commande introuvable', [ 'status' => 404 ] );
            }

            $tracking_number = sanitize_text_field( (string) $req->get_param( 'tracking_number' ) );
            $carrier         = sanitize_text_field( (string) $req->get_param( 'carrier' ) );
            $events          = $req->get_param( 'events' );

            if ( ! $tracking_number ) {
                return new WP_Error( 'missing', 'tracking_number requis', [ 'status' => 400 ] );
            }

            $order->update_meta_data( '_miad_tracking_number', $tracking_number );
            $order->update_meta_data( '_miad_carrier', $carrier ?: 'MIAD Express' );

            if ( is_array( $events ) ) {
                $order->update_meta_data( '_miad_tracking_events', wp_json_encode( $events ) );
            }

            // Ajouter une note à la commande
            $order->add_order_note(
                sprintf(
                    '[MIAD] N° de suivi %s (%s) enregistré par %s.',
                    $tracking_number,
                    $carrier ?: 'MIAD Express',
                    wp_get_current_user()->display_name ?: 'API'
                )
            );

            // Passer la commande en "Expédiée" si elle est en "processing"
            if ( $order->get_status() === 'processing' ) {
                $order->update_status( 'on-hold', '[MIAD] Commande expédiée — en attente de livraison.' );
            }

            $order->save();

            return [
                'success'         => true,
                'order_id'        => $order_id,
                'tracking_number' => $tracking_number,
                'carrier'         => $carrier ?: 'MIAD Express',
            ];
        },
    ] );

    /* ── POST /miad/v1/tracking/{order_id}/event ────────────────────── */
    register_rest_route( 'miad/v1', '/tracking/(?P<order_id>\d+)/event', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            if ( ! miad_tracking_can_write() ) {
                return new WP_Error( 'forbidden', 'Accès refusé', [ 'status' => 403 ] );
            }

            $order_id = (int) $req->get_param( 'order_id' );
            $order    = wc_get_order( $order_id );
            if ( ! $order ) {
                return new WP_Error( 'not_found', 'Commande introuvable', [ 'status' => 404 ] );
            }

            $description = sanitize_text_field( (string) $req->get_param( 'description' ) );
            $location    = sanitize_text_field( (string) $req->get_param( 'location' ) );
            $status_code = sanitize_text_field( (string) $req->get_param( 'status' ) );
            $timestamp   = sanitize_text_field( (string) $req->get_param( 'timestamp' ) );

            if ( ! $description ) {
                return new WP_Error( 'missing', 'description requise', [ 'status' => 400 ] );
            }

            $new_event = [
                'timestamp'   => $timestamp ?: gmdate( 'c' ),
                'location'    => $location,
                'description' => $description,
                'status'      => $status_code ?: 'in_transit',
            ];

            $events_json = $order->get_meta( '_miad_tracking_events', true );
            $events      = $events_json ? json_decode( $events_json, true ) : [];
            if ( ! is_array( $events ) ) $events = [];

            // Insérer en premier (ordre anti-chronologique)
            array_unshift( $events, $new_event );
            $order->update_meta_data( '_miad_tracking_events', wp_json_encode( $events ) );

            // Mettre à jour le statut WooCommerce si "delivered"
            if ( $status_code === 'delivered' ) {
                $order->update_status( 'completed', '[MIAD] Livraison confirmée.' );
            }

            $order->save();

            return [ 'success' => true, 'event' => $new_event, 'total_events' => count( $events ) ];
        },
    ] );

    /* ── GET  /miad/v1/tracking/search/{number} ─────────────────────── */
    register_rest_route( 'miad/v1', '/tracking/search/(?P<number>[^/]+)', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            if ( ! miad_tracking_can_read() ) {
                return new WP_Error( 'forbidden', 'Accès refusé', [ 'status' => 403 ] );
            }

            $number = sanitize_text_field( urldecode( (string) $req->get_param( 'number' ) ) );
            if ( ! $number ) {
                return new WP_Error( 'missing', 'Numéro requis', [ 'status' => 400 ] );
            }

            // Rechercher les commandes avec ce meta
            $orders = wc_get_orders( [
                'meta_key'   => '_miad_tracking_number',
                'meta_value' => $number,
                'limit'      => 5,
            ] );

            if ( empty( $orders ) ) {
                return new WP_Error( 'not_found', 'Aucune commande trouvée pour ce n° de suivi', [ 'status' => 404 ] );
            }

            $order        = $orders[0];
            $events_json  = $order->get_meta( '_miad_tracking_events', true );
            $events       = $events_json ? json_decode( $events_json, true ) : [];

            return [
                'order_id'        => $order->get_id(),
                'order_number'    => $order->get_order_number(),
                'tracking_number' => $number,
                'carrier'         => $order->get_meta( '_miad_carrier', true ) ?: 'MIAD Express',
                'order_status'    => $order->get_status(),
                'events'          => is_array( $events ) ? $events : [],
            ];
        },
    ] );

} );

/* ═══════════════════════════════════════════════════════════════════
   EMAIL CLIENT — Notification de suivi automatique
   Envoyée quand un numéro de suivi est ajouté à une commande
═══════════════════════════════════════════════════════════════════ */

add_action( 'updated_post_meta', function ( $meta_id, $post_id, $meta_key, $meta_value ) {
    if ( $meta_key !== '_miad_tracking_number' || ! $meta_value ) return;

    $order = wc_get_order( $post_id );
    if ( ! $order ) return;

    $customer_email = $order->get_billing_email();
    $customer_name  = $order->get_billing_first_name() ?: 'Client';
    $carrier        = get_post_meta( $post_id, '_miad_carrier', true ) ?: 'MIAD Express';
    $order_number   = $order->get_order_number();
    $tracking_url   = 'https://www.miadmarket.com/mon-compte'; // Lien vers le dashboard client

    // Vérifier si c'est un nouveau numéro (pas encore envoyé)
    $already_notified = get_post_meta( $post_id, '_miad_tracking_notified', true );
    if ( $already_notified === $meta_value ) return; // Même numéro, ne pas re-notifier

    $subject = "🚚 Votre commande #{$order_number} est en route — {$carrier}";
    $body    = "
<h2 style='color:#005826'>Votre colis est expédié !</h2>
<p>Bonjour {$customer_name},</p>
<p>Bonne nouvelle ! Votre commande <strong>#{$order_number}</strong> a été expédiée via <strong>{$carrier}</strong>.</p>
<p><strong>Numéro de suivi :</strong> <code style='background:#f5f5f5;padding:4px 8px;border-radius:4px;font-size:16px;font-weight:bold'>{$meta_value}</code></p>
<p>Suivez votre colis directement depuis votre espace client MIAD Market.</p>
<p style='text-align:center;margin:24px 0'>
  <a href='{$tracking_url}' style='background:#005826;color:white;padding:12px 28px;border-radius:40px;text-decoration:none;font-weight:bold;font-size:14px'>
    Suivre ma commande
  </a>
</p>
<p style='color:#888;font-size:12px'>Merci d'avoir choisi MIAD Market.</p>
";

    if ( function_exists( 'miad_send_professional_email' ) ) {
        miad_send_professional_email( $customer_email, $subject, $body );
    } else {
        wp_mail( $customer_email, $subject, $body, [ 'Content-Type: text/html; charset=UTF-8' ] );
    }

    // Marquer comme notifié
    update_post_meta( $post_id, '_miad_tracking_notified', $meta_value );

}, 10, 4 );
