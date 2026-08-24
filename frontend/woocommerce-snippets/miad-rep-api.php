<?php
/**
 * MIAD Representative — Endpoints REST headless (Next.js)
 *
 * GET /wp-json/miad/v1/representant/me        → dashboard du représentant connecté (JWT)
 *                                               Retourne : vendeurs de sa zone, commandes,
 *                                               clients acheteurs, stats, code parrainage
 * GET /wp-json/miad/v1/representant/country   → représentant pour un pays (?country=SN)
 *                                               Détecte automatiquement via IP si absent
 *
 * INSTALLATION : Code Snippets WordPress (activer "Exécuter partout")
 * DÉPEND DE    : miad-representative.php (rôle miad_representative + dokan_get_store_info)
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ─────────────────────────────────────────────────────────────────────────────
// CPT : miad_message — stockage des messages clients (sans Firebase)
// ─────────────────────────────────────────────────────────────────────────────

add_action( 'init', function () {
    register_post_type( 'miad_message', [
        'public'       => false,
        'show_ui'      => true,
        'show_in_menu' => true,
        'labels'       => [
            'name'          => 'Messages MIAD',
            'singular_name' => 'Message MIAD',
            'all_items'     => 'Tous les messages',
            'menu_name'     => 'Messages MIAD',
        ],
        'supports'     => [ 'title', 'editor' ],
        'menu_icon'    => 'dashicons-format-chat',
    ] );
} );

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES REST — Messages
// ─────────────────────────────────────────────────────────────────────────────

add_action( 'rest_api_init', function () {

    register_rest_route( 'miad/v1', '/messages', [
        [ 'methods' => 'POST', 'permission_callback' => 'miad_headless_secret_check', 'callback' => 'miad_rest_create_message' ],
        [
            'methods'             => 'GET',
            'permission_callback' => 'miad_headless_secret_check',
            'callback'            => 'miad_rest_list_messages',
            'args'                => [
                'rep_id'   => [ 'type' => 'integer', 'required' => false ],
                'status'   => [ 'type' => 'string',  'required' => false ],
                'per_page' => [ 'type' => 'integer', 'default'  => 100 ],
            ],
        ],
    ] );

    register_rest_route( 'miad/v1', '/messages/(?P<id>\d+)', [
        'methods'             => 'PATCH',
        'permission_callback' => 'miad_headless_secret_check',
        'callback'            => 'miad_rest_update_message',
        'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
    ] );

    register_rest_route( 'miad/v1', '/messages/(?P<id>\d+)/reply', [
        'methods'             => 'POST',
        'permission_callback' => 'miad_headless_secret_check',
        'callback'            => 'miad_rest_reply_message',
        'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
    ] );

} );

// ─────────────────────────────────────────────────────────────────────────────
// CALLBACKS — Messages
// ─────────────────────────────────────────────────────────────────────────────

function miad_rest_create_message( WP_REST_Request $request ): WP_REST_Response {
    $p            = $request->get_json_params();
    $client_name  = sanitize_text_field( $p['client_name'] ?? '' );
    $client_email = sanitize_email( $p['client_email'] ?? '' );
    $message      = sanitize_textarea_field( $p['message'] ?? '' );
    $rep_id       = (int) ( $p['rep_id'] ?? 0 );
    $rep_name     = sanitize_text_field( $p['rep_name'] ?? '' );
    $country      = sanitize_text_field( $p['country'] ?? '' );

    if ( ! $client_name || ! $message ) {
        return rest_ensure_response( [ 'ok' => false, 'error' => 'Données manquantes' ] );
    }

    $post_id = wp_insert_post( [
        'post_type'    => 'miad_message',
        'post_title'   => $client_name,
        'post_content' => $message,
        'post_status'  => 'publish',
    ] );

    if ( is_wp_error( $post_id ) ) {
        return rest_ensure_response( [ 'ok' => false, 'error' => $post_id->get_error_message() ] );
    }

    update_post_meta( $post_id, '_miad_client_name',  $client_name );
    update_post_meta( $post_id, '_miad_client_email', $client_email );
    update_post_meta( $post_id, '_miad_rep_id',       $rep_id );
    update_post_meta( $post_id, '_miad_rep_name',     $rep_name );
    update_post_meta( $post_id, '_miad_country',      $country );
    update_post_meta( $post_id, '_miad_status',       'new' );
    update_post_meta( $post_id, '_miad_replies',      wp_json_encode( [] ) );
    update_post_meta( $post_id, '_miad_created_at',   current_time( 'mysql' ) );

    // Push FCM au représentant
    if ( $rep_id && function_exists( 'miad_send_push_to_user' ) ) {
        miad_send_push_to_user(
            $rep_id,
            '📩 Nouveau message',
            ( $client_name ?: 'Un client' ) . ' vous a écrit',
            home_url( '/espace-representant/' )
        );
    }

    // Email de notification au représentant
    if ( $rep_id && function_exists( 'miad_send_professional_email' ) ) {
        $rep_user  = get_userdata( $rep_id );
        $rep_email = $rep_user ? $rep_user->user_email : '';
        if ( $rep_email ) {
            $rep_space_url = esc_url( rtrim( defined('MIAD_SITE_URL') ? MIAD_SITE_URL : get_option('miad_frontend_url','https://www.miadmarket.com'), '/' ) . '/espace-representant/' );
        $rep_body = '<h2>📩 Nouveau message client</h2>'
                . '<p>Un nouveau message attend votre réponse dans votre espace représentant.</p>'
                . '<div style="background:#f9fafb;border-left:4px solid #005826;border-radius:6px;padding:16px 20px;margin:20px 0">'
                . '<p style="margin:0 0 8px"><strong>De :</strong> ' . esc_html( $client_name ) . ( $client_email ? ' &lt;' . esc_html( $client_email ) . '&gt;' : '' ) . '</p>'
                . ( $country ? '<p style="margin:0 0 8px"><strong>Pays :</strong> ' . esc_html( $country ) . '</p>' : '' )
                . '<p style="margin:0"><strong>Message :</strong><br><span style="color:#374151">' . nl2br( esc_html( $message ) ) . '</span></p>'
                . '</div>'
                . '<div style="text-align:center;margin:24px 0"><a href="' . $rep_space_url . '" style="display:inline-block;background:#005826;color:#fff;font-weight:800;padding:14px 32px;border-radius:50px;text-decoration:none;font-size:.85rem;text-transform:uppercase;letter-spacing:.5px">Voir mon espace représentant →</a></div>'
                . '<p style="font-size:.85rem;color:#6b7280;text-align:center">Connectez-vous et répondez directement depuis votre tableau de bord.</p>';
            miad_send_professional_email( $rep_email, '📩 Nouveau message de ' . esc_html( $client_name ), $rep_body, null, [ 'email_type' => 'miad_msg_rep' ] );
        }
    }

    // Email de confirmation au client
    if ( $client_email && is_email( $client_email ) && function_exists( 'miad_send_professional_email' ) ) {
        $confirm_body = '<h2>Votre message a bien été reçu !</h2>'
            . '<p>Bonjour <strong>' . esc_html( $client_name ) . '</strong>, notre équipe vous répondra dans les plus brefs délais.</p>'
            . '<div style="background:#f0fdf4;border-left:4px solid #005826;border-radius:6px;padding:16px 20px;margin:20px 0">'
            . '<p style="margin:0;color:#374151"><strong>Votre message :</strong><br>' . nl2br( esc_html( $message ) ) . '</p>'
            . '</div>'
            . '<p style="font-size:.85rem;color:#6b7280">Vous recevrez une notification dès qu\'un représentant vous répond.</p>';
        miad_send_professional_email( $client_email, '✅ Message bien reçu — MIAD Market', $confirm_body, null, [ 'email_type' => 'miad_msg_client_confirm' ] );
    }

    return rest_ensure_response( [ 'ok' => true, 'id' => $post_id ] );
}

function miad_rest_list_messages( WP_REST_Request $request ): WP_REST_Response {
    $rep_id   = (int) $request->get_param( 'rep_id' );
    $status   = sanitize_text_field( $request->get_param( 'status' ) ?? '' );
    $per_page = (int) ( $request->get_param( 'per_page' ) ?? 100 );

    $meta_query = [];
    if ( $rep_id )  $meta_query[] = [ 'key' => '_miad_rep_id', 'value' => $rep_id, 'type' => 'NUMERIC' ];
    if ( $status )  $meta_query[] = [ 'key' => '_miad_status', 'value' => $status ];

    $args = [
        'post_type'      => 'miad_message',
        'post_status'    => 'publish',
        'posts_per_page' => $per_page,
        'orderby'        => 'date',
        'order'          => 'DESC',
    ];
    if ( ! empty( $meta_query ) ) $args['meta_query'] = $meta_query;

    $posts    = get_posts( $args );
    $messages = array_map( function ( $p ) {
        $raw     = get_post_meta( $p->ID, '_miad_replies', true );
        $replies = is_string( $raw ) ? ( json_decode( $raw, true ) ?: [] ) : [];
        return [
            'id'           => $p->ID,
            'client_name'  => get_post_meta( $p->ID, '_miad_client_name',  true ),
            'client_email' => get_post_meta( $p->ID, '_miad_client_email', true ),
            'message'      => $p->post_content,
            'rep_id'       => (int) get_post_meta( $p->ID, '_miad_rep_id',   true ),
            'rep_name'     => get_post_meta( $p->ID, '_miad_rep_name',     true ),
            'country'      => get_post_meta( $p->ID, '_miad_country',      true ),
            'status'       => get_post_meta( $p->ID, '_miad_status',       true ) ?: 'new',
            'replies'      => $replies,
            'created_at'   => get_post_meta( $p->ID, '_miad_created_at',   true ) ?: $p->post_date,
        ];
    }, $posts );

    return rest_ensure_response( [ 'ok' => true, 'messages' => array_values( $messages ) ] );
}

function miad_rest_reply_message( WP_REST_Request $request ): WP_REST_Response {
    $post_id   = (int) $request->get_param( 'id' );
    $p         = $request->get_json_params();
    $text      = sanitize_textarea_field( $p['text'] ?? '' );
    $from_name = sanitize_text_field( $p['from_name'] ?? 'MIAD' );
    $from_role = sanitize_text_field( $p['from_role'] ?? 'rep' );

    if ( ! $text ) return rest_ensure_response( [ 'ok' => false, 'error' => 'Message vide' ] );

    $post = get_post( $post_id );
    if ( ! $post || $post->post_type !== 'miad_message' ) {
        return rest_ensure_response( [ 'ok' => false, 'error' => 'Message introuvable' ] );
    }

    $raw     = get_post_meta( $post_id, '_miad_replies', true );
    $replies = is_string( $raw ) ? ( json_decode( $raw, true ) ?: [] ) : [];
    $replies[] = [
        'from' => $from_role,
        'name' => $from_name,
        'text' => $text,
        'at'   => current_time( 'mysql' ),
    ];

    update_post_meta( $post_id, '_miad_replies', wp_json_encode( $replies ) );
    update_post_meta( $post_id, '_miad_status',  'replied' );

    // Notifier le client par email (template MIAD)
    $client_email = get_post_meta( $post_id, '_miad_client_email', true );
    $client_name  = get_post_meta( $post_id, '_miad_client_name',  true );

    if ( $client_email && is_email( $client_email ) && function_exists( 'miad_send_professional_email' ) ) {
        $reply_body = '<h2>💬 Réponse à votre message</h2>'
            . '<p>Bonjour <strong>' . esc_html( $client_name ) . '</strong>,</p>'
            . '<p><strong>' . esc_html( $from_name ) . '</strong> vous a répondu :</p>'
            . '<div style="background:#f9fafb;border-left:4px solid #F5A623;border-radius:6px;padding:16px 20px;margin:20px 0">'
            . '<p style="margin:0;font-size:.95rem;line-height:1.7;color:#1a1a1a">' . nl2br( esc_html( $text ) ) . '</p>'
            . '</div>'
            . '<p style="font-size:.85rem;color:#6b7280">Vous pouvez répondre directement via notre site ou application.</p>';
        miad_send_professional_email( $client_email, '💬 Réponse de ' . esc_html( $from_name ) . ' — MIAD Market', $reply_body, null, [ 'email_type' => 'miad_msg_reply' ] );
    }

    return rest_ensure_response( [ 'ok' => true ] );
}

function miad_rest_update_message( WP_REST_Request $request ): WP_REST_Response {
    $post_id = (int) $request->get_param( 'id' );
    $p       = $request->get_json_params();
    $status  = sanitize_text_field( $p['status'] ?? '' );

    if ( ! in_array( $status, [ 'new', 'replied', 'closed' ], true ) ) {
        return rest_ensure_response( [ 'ok' => false, 'error' => 'Statut invalide' ] );
    }

    $post = get_post( $post_id );
    if ( ! $post || $post->post_type !== 'miad_message' ) {
        return rest_ensure_response( [ 'ok' => false, 'error' => 'Message introuvable' ] );
    }

    update_post_meta( $post_id, '_miad_status', $status );
    return rest_ensure_response( [ 'ok' => true ] );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES REST — Représentants + Email
// ─────────────────────────────────────────────────────────────────────────────

add_action( 'rest_api_init', function () {

    register_rest_route( 'miad/v1', '/representant/me', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => 'miad_rest_rep_me',
    ] );

    register_rest_route( 'miad/v1', '/representant/country', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => 'miad_rest_rep_for_country',
        'args'                => [
            'country' => [ 'type' => 'string', 'sanitize_callback' => 'sanitize_text_field', 'required' => false ],
        ],
    ] );

    // GET /miad/v1/representant/{id} — info publique d'un représentant par ID
    register_rest_route( 'miad/v1', '/representant/(?P<id>\d+)', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => 'miad_rest_rep_by_id',
        'args'                => [
            'id' => [ 'type' => 'integer', 'required' => true ],
        ],
    ] );

    // POST /miad/v1/send-email — envoi d'email via wp_mail (headless)
    register_rest_route( 'miad/v1', '/send-email', [
        'methods'             => 'POST',
        'permission_callback' => 'miad_headless_secret_check',
        'callback'            => 'miad_rest_send_email',
    ] );

    // GET /miad/v1/tracking/{number} — suivi DHL via dhlconfig.php
    register_rest_route( 'miad/v1', '/tracking/(?P<number>[^/]+)', [
        'methods'             => 'GET',
        'permission_callback' => 'miad_headless_secret_check',
        'callback'            => 'miad_rest_get_tracking',
        'args'                => [
            'number' => [ 'type' => 'string', 'required' => true, 'sanitize_callback' => 'sanitize_text_field' ],
        ],
    ] );

    // POST /miad/v1/orders/{id}/acknowledge — prise en charge par le représentant
    register_rest_route( 'miad/v1', '/orders/(?P<id>\d+)/acknowledge', [
        'methods'             => 'POST',
        'permission_callback' => 'miad_headless_secret_check',
        'callback'            => 'miad_rest_acknowledge_order',
        'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
    ] );

} );

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY CHECK : X-Headless-Secret requis pour les endpoints sensibles
// ─────────────────────────────────────────────────────────────────────────────

function miad_headless_secret_check( WP_REST_Request $request ): bool {
    // INTERNAL_API_SECRET est le nom canonique (défini dans wp-config.php, celui
    // que Next.js envoie réellement) — MIAD_INTERNAL_SECRET/MIAD_HEADLESS_SECRET
    // gardés en repli pour compat avec d'anciens déploiements. Le check contre
    // MIAD_INTERNAL_SECRET seul renvoyait toujours faux (constante jamais
    // définie), cassant en silence /messages, /orders/{id}/acknowledge et
    // /send-email — trouvé via le nouveau journal d'actions admin (2026-07-10).
    $expected = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET
        : ( defined( 'MIAD_HEADLESS_SECRET' ) ? MIAD_HEADLESS_SECRET
        : ( defined( 'MIAD_INTERNAL_SECRET' ) ? MIAD_INTERNAL_SECRET : null ) );
    if ( ! $expected ) return false;
    return hash_equals( $expected, (string) $request->get_header( 'X-Headless-Secret' ) );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 3 : /miad/v1/representant/{id}
// ─────────────────────────────────────────────────────────────────────────────

function miad_rest_rep_by_id( WP_REST_Request $request ): WP_REST_Response {
    $rep_id = (int) $request->get_param( 'id' );
    $rep    = get_userdata( $rep_id );

    if ( ! $rep || ! in_array( 'miad_representative', (array) $rep->roles, true ) ) {
        return rest_ensure_response( [ 'found' => false ] );
    }

    return rest_ensure_response( [
        'found'    => true,
        'id'       => $rep->ID,
        'name'     => $rep->display_name,
        'email'    => $rep->user_email,
        'whatsapp' => get_user_meta( $rep->ID, 'miad_rep_whatsapp', true ),
        'avatar'   => get_avatar_url( $rep->ID, [ 'size' => 96 ] ),
        'country'  => get_user_meta( $rep->ID, 'miad_assigned_country', true ),
    ] );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 4 : /miad/v1/send-email  (POST, X-Headless-Secret requis)
// ─────────────────────────────────────────────────────────────────────────────

function miad_rest_send_email( WP_REST_Request $request ): WP_REST_Response {
    $params  = $request->get_json_params();
    $to      = sanitize_email( $params['to'] ?? '' );
    $subject = sanitize_text_field( $params['subject'] ?? 'Message MIAD Market' );
    $html    = wp_kses_post( $params['html'] ?? '' );

    if ( ! $to || ! is_email( $to ) ) {
        return rest_ensure_response( [ 'ok' => false, 'error' => 'Email destinataire invalide' ] );
    }

    $headers = [
        'Content-Type: text/html; charset=UTF-8',
        'From: MIAD Market <no-reply@' . parse_url( get_site_url(), PHP_URL_HOST ) . '>',
    ];

    // BCC systématique à miasugestion@gmail.com (inbox admin MIAD)
    $miad_admin = 'miasugestion@gmail.com';
    if ( $miad_admin !== $to ) {
        $headers[] = 'Bcc: ' . $miad_admin;
    }
    // BCC WordPress admin si différent
    $admin_email = get_option( 'admin_email' );
    if ( $admin_email && $admin_email !== $to && $admin_email !== $miad_admin ) {
        $headers[] = 'Bcc: ' . $admin_email;
    }

    $sent = wp_mail( $to, $subject, $html, $headers );

    return rest_ensure_response( [ 'ok' => $sent ] );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT : /miad/v1/tracking/{number}  (X-Headless-Secret requis)
// ─────────────────────────────────────────────────────────────────────────────

function miad_rest_acknowledge_order( WP_REST_Request $request ): WP_REST_Response {
    $order_id = (int) $request->get_param( 'id' );
    $p        = $request->get_json_params();
    $rep_name = sanitize_text_field( $p['rep_name'] ?? 'Représentant' );

    $order = wc_get_order( $order_id );
    if ( ! $order ) {
        return rest_ensure_response( [ 'ok' => false, 'error' => 'Commande introuvable' ] );
    }

    // Éviter une double prise en charge
    if ( $order->get_meta( '_miad_rep_acknowledged' ) === '1' ) {
        return rest_ensure_response( [ 'ok' => true, 'already_acknowledged' => true ] );
    }

    $now = current_time( 'mysql' );
    $order->update_meta_data( '_miad_rep_acknowledged',    '1' );
    $order->update_meta_data( '_miad_rep_acknowledged_by', $rep_name );
    $order->update_meta_data( '_miad_rep_acknowledged_at', $now );
    $order->update_meta_data( '_miad_rep_name',            $rep_name );
    $order->save();

    // Changer le statut → déclenche le hook woocommerce_order_status_changed
    // qui envoie automatiquement l'email miad_rep_taken au client
    // (défini dans miad-email-customizer.php section 15)
    $order->update_status(
        'miad-rep-charge',
        sprintf( '👤 Prise en charge par : %s — email client envoyé automatiquement.', esc_html( $rep_name ) )
    );

    return rest_ensure_response( [
        'ok'              => true,
        'acknowledged_at' => $now,
        'new_status'      => 'miad-rep-charge',
    ] );
}

function miad_rest_get_tracking( WP_REST_Request $request ): WP_REST_Response {
    $number = sanitize_text_field( $request->get_param( 'number' ) );

    if ( ! function_exists( 'miad_dhl_get_tracking_info' ) ) {
        return rest_ensure_response( [ 'error' => 'DHL module non actif' ] );
    }

    $env    = get_option( 'miad_dhl_api_mode', 'sandbox' );
    $result = miad_dhl_get_tracking_info( $number, $env );

    return rest_ensure_response( $result );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 1 : /miad/v1/representant/me  (JWT requis)
// ─────────────────────────────────────────────────────────────────────────────

function miad_rest_rep_me( WP_REST_Request $request ): WP_REST_Response|WP_Error {

    // Authentification JWT
    $auth = $request->get_header( 'Authorization' ) ?? '';
    if ( ! str_starts_with( $auth, 'Bearer ' ) ) {
        return new WP_Error( 'unauthorized', 'Token manquant', [ 'status' => 401 ] );
    }

    $user_id = miad_rep_user_id_from_jwt( trim( substr( $auth, 7 ) ) );
    if ( ! $user_id ) {
        return new WP_Error( 'invalid_token', 'Session invalide', [ 'status' => 401 ] );
    }

    $user = get_userdata( $user_id );
    $is_super_rep = $user && in_array( 'miad_super_rep', (array) $user->roles, true );
    if ( ! $user || ( ! in_array( 'miad_representative', (array) $user->roles, true ) && ! $is_super_rep ) ) {
        return new WP_Error( 'forbidden', 'Accès réservé aux représentants', [ 'status' => 403 ] );
    }

    $country_code = $is_super_rep ? '' : (string) get_user_meta( $user_id, 'miad_assigned_country', true );

    // ── Code de parrainage unique ─────────────────────────────────────────────
    $referral_code = get_user_meta( $user_id, 'miad_rep_referral_code', true );
    if ( ! $referral_code ) {
        $referral_code = 'REP' . strtoupper( substr( md5( $user->user_email ), 0, 6 ) );
        update_user_meta( $user_id, 'miad_rep_referral_code', $referral_code );
    }

    $commission_rate = (float) ( get_user_meta( $user_id, 'miad_rep_commission_rate', true ) ?: 5 );

    // ── Vendeurs de la zone du représentant (via Dokan) ───────────────────────
    $vendors_data = [];
    if ( function_exists( 'dokan_get_store_info' ) && ( $country_code || $is_super_rep ) ) {
        $all_sellers = get_users( [ 'role__in' => [ 'seller', 'vendor', 'wcfm_vendor' ] ] );
        foreach ( $all_sellers as $seller ) {
            $info = dokan_get_store_info( $seller->ID );
            if ( ! $is_super_rep && ( $info['address']['country'] ?? '' ) !== $country_code ) continue;

            // Commandes de ce vendeur
            $seller_orders = wc_get_orders( [
                'status'   => [ 'processing', 'completed', 'on-hold' ],
                'limit'    => -1,
                'meta_key' => '_dokan_vendor_id',
                'meta_value' => $seller->ID,
            ] );

            $seller_total    = 0.0;
            $seller_products = 0;

            // Compter les produits du vendeur
            $products_count = count( get_posts( [
                'post_type'   => 'product',
                'author'      => $seller->ID,
                'post_status' => 'publish',
                'numberposts' => -1,
                'fields'      => 'ids',
            ] ) );

            foreach ( $seller_orders as $order ) {
                foreach ( $order->get_items() as $item ) {
                    if ( get_post_field( 'post_author', $item->get_product_id() ) == $seller->ID ) {
                        $seller_total += (float) $item->get_total();
                    }
                }
            }

            $vendors_data[] = [
                'id'       => $seller->ID,
                'name'     => $info['store_name'] ?? $seller->display_name,
                'email'    => $seller->user_email,
                'avatar'   => $info['gravatar'] ?? get_avatar_url( $seller->ID, [ 'size' => 64 ] ),
                'products' => $products_count,
                'orders'   => count( $seller_orders ),
                'total'    => round( $seller_total, 2 ),
                'phone'    => $info['phone'] ?? '',
            ];
        }
    }

    // ── Commandes de la zone ──────────────────────────────────────────────────
    $vendor_ids      = array_column( $vendors_data, 'id' );
    $all_zone_orders = [];
    $zone_total      = 0.0;
    $zone_clients    = [];

    if ( ! empty( $vendor_ids ) ) {
        $all_orders = wc_get_orders( [
            'status'  => [ 'processing', 'completed', 'on-hold', 'pending' ],
            'limit'   => 300,
            'orderby' => 'date',
            'order'   => 'DESC',
        ] );

        foreach ( $all_orders as $order ) {
            $order_has_zone_vendor = false;
            $order_vendors         = [];

            foreach ( $order->get_items() as $item ) {
                $vid = (int) get_post_field( 'post_author', $item->get_product_id() );
                if ( in_array( $vid, $vendor_ids, true ) ) {
                    $order_has_zone_vendor = true;
                    $info = dokan_get_store_info( $vid );
                    $order_vendors[] = $info['store_name'] ?? '';
                    $zone_total += (float) $item->get_total();
                }
            }

            if ( ! $order_has_zone_vendor ) continue;

            $client_email = $order->get_billing_email();
            if ( $client_email ) $zone_clients[ $client_email ] = true;

            $all_zone_orders[] = [
                'id'              => $order->get_id(),
                'number'          => $order->get_order_number(),
                'date'            => $order->get_date_created()?->date( 'Y-m-d H:i' ) ?? '',
                'status'          => $order->get_status(),
                'client'          => $order->get_formatted_billing_full_name(),
                'email'           => $client_email,
                'phone'           => $order->get_billing_phone(),
                // array_values() est indispensable ici : array_filter()/array_unique()
                // laissent des trous dans les clés, et PHP encode alors ce tableau en
                // objet JS ({}) plutôt qu'en tableau ([]) — RepresentantPage.tsx appelle
                // .join(', ') dessus, d'où le crash "vendors.join is not a function"
                // sur /espace-representant pour les comptes représentant/super-représentant.
                'vendors'         => array_values( array_unique( array_filter( $order_vendors ) ) ),
                'total'           => (float) $order->get_total(),
                // Mode de livraison choisi par le client (MIAD Standard/MIAD Express)
                // — absent jusqu'ici du dashboard représentant (demandé le 2026-07-17).
                'shipping_method' => $order->get_shipping_method() ?: 'MIAD Standard',
                'tracking'        => $order->get_meta( '_miad_dhl_tracking_number' ) ?: '',
                'acknowledged'    => (bool) $order->get_meta( '_miad_rep_acknowledged' ),
                'acknowledged_by' => $order->get_meta( '_miad_rep_acknowledged_by' ) ?: '',
                'acknowledged_at' => $order->get_meta( '_miad_rep_acknowledged_at' ) ?: '',
            ];
        }
    }

    // Pending et on-hold toujours en tête — jamais noyés par les commandes récentes
    usort( $all_zone_orders, function ( $a, $b ) {
        $priority = [ 'pending' => 0, 'on-hold' => 1, 'processing' => 2, 'completed' => 3 ];
        $pa = $priority[ $a['status'] ] ?? 4;
        $pb = $priority[ $b['status'] ] ?? 4;
        if ( $pa !== $pb ) return $pa - $pb;
        return strcmp( $b['date'], $a['date'] );
    } );

    $zone_orders_total = count( $all_zone_orders );
    $recent_orders     = array_slice( $all_zone_orders, 0, 50 );

    // ── Clients recrutés via code parrainage ──────────────────────────────────
    $referred_ids = get_users( [
        'meta_key'   => 'miad_referred_by',
        'meta_value' => $referral_code,
        'fields'     => 'ids',
        'number'     => 200,
    ] );

    $referral_clients = [];
    $referral_earned  = 0.0;
    $referral_orders  = 0;

    foreach ( $referred_ids as $cid ) {
        $client = get_userdata( $cid );
        if ( ! $client ) continue;
        $client_orders = wc_get_orders( [
            'customer_id' => $cid,
            'status'      => [ 'processing', 'completed' ],
            'limit'       => -1,
        ] );
        $client_total = array_sum( array_map( fn( $o ) => (float) $o->get_total(), $client_orders ) );
        $referral_earned  += $client_total * ( $commission_rate / 100 );
        $referral_orders  += count( $client_orders );
        $referral_clients[] = [
            'name'   => $client->display_name,
            'email'  => $client->user_email,
            'orders' => count( $client_orders ),
            'total'  => round( $client_total, 2 ),
            'date'   => $client->user_registered,
        ];
    }

    // ── Pays détecté du visiteur (bonus pour l'affichage côté front) ──────────
    $countries_obj = new WC_Countries();
    $country_name  = $countries_obj->countries[ $country_code ] ?? $country_code;

    // ── Messages non lus ─────────────────────────────────────────────────────
    $unread_meta = [
        'relation' => 'AND',
        [ 'key' => '_miad_status', 'value' => 'new' ],
    ];
    if ( ! $is_super_rep ) {
        $unread_meta[] = [ 'key' => '_miad_rep_id', 'value' => $user_id, 'type' => 'NUMERIC' ];
    }
    $unread_messages = (int) count( get_posts( [
        'post_type'      => 'miad_message',
        'post_status'    => 'publish',
        'posts_per_page' => -1,
        'fields'         => 'ids',
        'meta_query'     => $unread_meta,
    ] ) );

    // Liste de tous les représentants (super rep uniquement)
    $all_reps = [];
    if ( $is_super_rep ) {
        foreach ( get_users( [ 'role' => 'miad_representative', 'number' => 300 ] ) as $r ) {
            $all_reps[] = [
                'id'      => $r->ID,
                'name'    => $r->display_name,
                'email'   => $r->user_email,
                'country' => get_user_meta( $r->ID, 'miad_assigned_country', true ),
                'avatar'  => get_avatar_url( $r->ID, [ 'size' => 64 ] ),
            ];
        }
    }

    return rest_ensure_response( [
        'success'          => true,
        'is_super_rep'     => $is_super_rep,
        // Profil du représentant
        'id'               => $user_id,
        'name'             => $user->display_name,
        'email'            => $user->user_email,
        'avatar'           => get_avatar_url( $user_id, [ 'size' => 96 ] ),
        'country_code'     => $is_super_rep ? 'ALL' : $country_code,
        'country_name'     => $is_super_rep ? 'Tous les pays' : $country_name,
        'whatsapp'         => get_user_meta( $user_id, 'miad_rep_whatsapp', true ),
        // Parrainage
        'referral_code'    => $referral_code,
        'commission_rate'  => $commission_rate,
        'referral_earned'  => round( $referral_earned, 2 ),
        'referral_clients' => $referral_clients,
        'referral_orders'  => $referral_orders,
        // Zone / Global vendeurs
        'vendors'          => $vendors_data,
        'vendors_count'    => count( $vendors_data ),
        // Commandes zone / globales
        'recent_orders'    => $recent_orders,
        'zone_orders'      => $zone_orders_total,
        'zone_total'       => round( $zone_total, 2 ),
        'zone_clients'     => count( $zone_clients ),
        // Messages
        'unread_messages'  => $unread_messages,
        // Super rep — liste de tous les représentants
        'all_reps'         => $all_reps,
    ] );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 2 : /miad/v1/representant/country (public)
// ─────────────────────────────────────────────────────────────────────────────

function miad_rest_rep_for_country( WP_REST_Request $request ): WP_REST_Response {
    $country = strtoupper( $request->get_param( 'country' ) ?: '' );
    if ( ! $country ) $country = miad_rep_detect_country();

    $reps = get_users( [
        'role'       => 'miad_representative',
        'meta_key'   => 'miad_assigned_country',
        'meta_value' => $country,
        'number'     => 1,
    ] );

    if ( empty( $reps ) ) return rest_ensure_response( [ 'found' => false, 'country' => $country ] );

    $rep = $reps[0];
    return rest_ensure_response( [
        'found'    => true,
        'id'       => $rep->ID,
        'country'  => $country,
        'name'     => $rep->display_name,
        'whatsapp' => get_user_meta( $rep->ID, 'miad_rep_whatsapp', true ),
        'avatar'   => get_avatar_url( $rep->ID, [ 'size' => 96 ] ),
    ] );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER : Détecter le pays du visiteur via IP
// ─────────────────────────────────────────────────────────────────────────────

function miad_rep_detect_country(): string {
    // 1. Cloudflare
    if ( ! empty( $_SERVER['HTTP_CF_IPCOUNTRY'] ) ) {
        $cf = strtoupper( sanitize_text_field( $_SERVER['HTTP_CF_IPCOUNTRY'] ) );
        if ( $cf !== 'XX' ) return $cf;
    }
    // 2. WooCommerce Geolocation (MaxMind)
    if ( class_exists( 'WC_Geolocation' ) ) {
        $geo = WC_Geolocation::geolocate_ip( WC_Geolocation::get_ip_address(), false, true );
        if ( ! empty( $geo['country'] ) ) return strtoupper( $geo['country'] );
    }
    // 3. Session WooCommerce
    if ( function_exists( 'WC' ) && WC()->customer ) {
        $c = WC()->customer->get_billing_country();
        if ( $c ) return strtoupper( $c );
    }
    // 4. ipapi.co (cache 6h pour éviter les appels répétés)
    $ip = sanitize_text_field( trim( explode( ',', $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '' )[0] ) );
    if ( $ip ) {
        $key    = 'miad_country_' . md5( $ip );
        $cached = get_transient( $key );
        if ( $cached ) return $cached;
        $res = wp_remote_get( "https://ipapi.co/{$ip}/country/", [ 'timeout' => 3 ] );
        if ( ! is_wp_error( $res ) ) {
            $code = strtoupper( trim( wp_remote_retrieve_body( $res ) ) );
            if ( preg_match( '/^[A-Z]{2}$/', $code ) ) {
                set_transient( $key, $code, HOUR_IN_SECONDS * 6 );
                return $code;
            }
        }
    }
    return 'SN'; // Fallback Sénégal
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER : ID utilisateur depuis JWT
// ─────────────────────────────────────────────────────────────────────────────

function miad_rep_user_id_from_jwt( string $token ): int {
    if ( function_exists( 'jwt_auth_get_user' ) ) {
        $user = jwt_auth_get_user( $token );
        return is_a( $user, 'WP_User' ) ? (int) $user->ID : 0;
    }
    $parts = explode( '.', $token );
    if ( count( $parts ) !== 3 ) return 0;
    $payload = json_decode( base64_decode( str_replace( [ '-', '_' ], [ '+', '/' ], $parts[1] ) ), true );
    return (int) ( $payload['data']['user']['id'] ?? $payload['sub'] ?? 0 );
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK : Lier un nouveau compte à un représentant au moment de l'inscription
// ─────────────────────────────────────────────────────────────────────────────

add_action( 'user_register', function ( int $user_id ) {
    $ref = sanitize_text_field( $_COOKIE['miad_ref'] ?? $_GET['ref'] ?? '' );
    if ( ! $ref ) return;
    $exists = get_users( [ 'meta_key' => 'miad_rep_referral_code', 'meta_value' => $ref, 'number' => 1, 'fields' => 'ids' ] );
    if ( ! empty( $exists ) ) update_user_meta( $user_id, 'miad_referred_by', $ref );
} );

// ─────────────────────────────────────────────────────────────────────────────
// SÉCURITÉ : Bloquer /espace-representant/ en WordPress classique (fallback)
// (Dans l'app Next.js headless la protection est faite côté client + API JWT)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CRON : Supprimer les messages éphémères de plus de 7 jours
// ─────────────────────────────────────────────────────────────────────────────

add_action( 'wp', function () {
    if ( ! wp_next_scheduled( 'miad_purge_old_messages' ) ) {
        wp_schedule_event( time(), 'daily', 'miad_purge_old_messages' );
    }
} );

add_action( 'miad_purge_old_messages', function () {
    $old_ids = get_posts( [
        'post_type'      => 'miad_message',
        'post_status'    => 'publish',
        'posts_per_page' => -1,
        'fields'         => 'ids',
        'date_query'     => [ [ 'column' => 'post_date', 'before' => '7 days ago' ] ],
    ] );
    foreach ( $old_ids as $id ) {
        wp_delete_post( $id, true );
    }
} );

add_action( 'template_redirect', function () {
    if ( ! is_page( 'espace-representant' ) ) return;
    if ( is_user_logged_in() && ( current_user_can( 'miad_representative' ) || current_user_can( 'manage_options' ) ) ) return;
    wp_redirect( wp_login_url( get_permalink() ) );
    exit;
} );
