<?php
/**
 * Plugin Name: MIAD Push Notifications
 * Description: Gestion des push notifications Firebase (FCM HTTP v1) — stockage
 *              des tokens, envoi via Next.js (Firebase Admin SDK), déclenchement
 *              automatique lors des commandes et messages clients.
 * Version: 2.0
 * Author: MIAD Market
 *
 * INSTALLATION : Code Snippets (WordPress) — Run everywhere
 *
 * CONFIGURATION REQUISE :
 *   1. WP Admin → MIAD Emails → 🔔 Push → coller l'URL Next.js + INTERNAL_API_SECRET
 *   2. La VAPID key → variable .env NEXT_PUBLIC_FIREBASE_VAPID_KEY (déjà configuré)
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   1. MENU ADMIN — Configuration Push
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_submenu_page(
        'miad-emails',
        'Push Notifications',
        '🔔 Push',
        'manage_options',
        'miad-push',
        'miad_push_admin_page'
    );
} );

function miad_push_admin_page(): void {
    if ( isset( $_POST['miad_push_save'] ) && check_admin_referer( 'miad_push' ) ) {
        update_option( 'miad_frontend_url',          esc_url_raw( $_POST['frontend_url'] ?? 'https://www.miadmarket.com' ) );
        update_option( 'miad_push_internal_secret',  sanitize_text_field( $_POST['internal_secret'] ?? '' ) );
        echo '<div class="updated"><p>✅ Configuration Push enregistrée.</p></div>';
    }

    // Envoi manuel de test
    if ( isset( $_POST['miad_push_test'] ) && check_admin_referer( 'miad_push' ) ) {
        $result = miad_send_push_to_all(
            '🔔 Test MIAD Market',
            sanitize_text_field( $_POST['push_test_body'] ?? 'Ceci est un test de notification push.' ),
            'https://www.miadmarket.com'
        );
        echo '<div class="updated"><p>✅ Notification envoyée à ' . $result . ' appareil(s).</p></div>';
    }

    $frontend = get_option( 'miad_frontend_url',         'https://www.miadmarket.com' );
    $secret   = get_option( 'miad_push_internal_secret', '' );
    $total    = count( miad_get_all_push_tokens() );
    ?>
    <div class="wrap" style="max-width:800px">
        <h1>🔔 Push Notifications (FCM HTTP v1)</h1>
        <p><strong><?= $total ?></strong> appareil(s) abonné(s)</p>

        <div class="card" style="padding:20px;margin-bottom:24px">
            <h3>Configuration</h3>
            <p style="background:#fff8e1;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;font-size:13px">
                ℹ️ L'envoi utilise l'API FCM HTTP v1 via le front-end Next.js (Firebase Admin SDK + Service Account).<br>
                Collez l'URL du front Next.js et le secret interne partagé.
            </p>
            <form method="post">
                <?php wp_nonce_field('miad_push'); ?>
                <p>
                    <label><strong>URL du front-end Next.js :</strong><br>
                        <input type="url" name="frontend_url" value="<?= esc_attr($frontend) ?>" style="width:100%;margin-top:4px" placeholder="https://www.miadmarket.com">
                    </label>
                </p>
                <p>
                    <label><strong>Secret interne (INTERNAL_API_SECRET de .env.local) :</strong><br>
                        <input type="password" name="internal_secret" value="<?= esc_attr($secret) ?>" style="width:100%;margin-top:4px">
                        <span class="description">Même valeur que INTERNAL_API_SECRET dans le .env.local Next.js</span>
                    </label>
                </p>
                <button type="submit" name="miad_push_save" class="button button-primary">Enregistrer</button>
            </form>
        </div>

        <div class="card" style="padding:20px;margin-bottom:24px">
            <h3>Envoyer une notification à tous les abonnés</h3>
            <form method="post">
                <?php wp_nonce_field('miad_push'); ?>
                <p>
                    <label>Message :<br>
                        <input type="text" name="push_test_body" style="width:100%" placeholder="Votre message de notification…" required>
                    </label>
                </p>
                <button type="submit" name="miad_push_test" class="button button-primary">📤 Envoyer à tous</button>
            </form>
        </div>

        <div class="card" style="padding:20px">
            <h3>Appareils abonnés (<?= $total ?>)</h3>
            <?php
            $tokens = miad_get_all_push_tokens();
            if ( empty( $tokens ) ) {
                echo '<p>Aucun appareil enregistré.</p>';
            } else {
                echo '<table class="wp-list-table widefat striped"><thead><tr><th>User ID</th><th>Token (tronqué)</th><th>Date</th></tr></thead><tbody>';
                foreach ( array_slice( $tokens, 0, 50 ) as $t ) {
                    printf(
                        '<tr><td>%s</td><td><code>%s...</code></td><td>%s</td></tr>',
                        esc_html( $t['user_id'] ?: '—' ),
                        esc_html( substr( $t['token'], 0, 30 ) ),
                        esc_html( $t['date'] ?? '' )
                    );
                }
                echo '</tbody></table>';
            }
            ?>
        </div>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   2. REST API — Endpoints pour Next.js
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {

    // POST /wp-json/miad/v1/push/subscribe — enregistre un token FCM
    register_rest_route( 'miad/v1', '/push/subscribe', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $req ) {
            $token   = sanitize_text_field( (string) $req->get_param('token') );
            $user_id = (int) $req->get_param('user_id');

            if ( ! $token ) {
                return new WP_Error( 'missing_token', 'Token manquant', [ 'status' => 400 ] );
            }

            miad_save_push_token( $token, $user_id ?: 0 );
            return [ 'success' => true, 'registered' => count( miad_get_all_push_tokens() ) ];
        },
    ] );

    // GET /wp-json/miad/v1/push/stats — nombre d'appareils abonnés, pour
    // l'onglet Push du dashboard admin (même pattern que /email/subscribers).
    register_rest_route( 'miad/v1', '/push/stats', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            if ( ! function_exists( 'miad_headless_secret_check' ) ) return false;
            return miad_headless_secret_check( $request );
        },
        'callback'            => function () {
            $tokens = miad_get_all_push_tokens();
            $with_user = count( array_filter( $tokens, fn( $t ) => (int) ( $t['user_id'] ?? 0 ) > 0 ) );
            return [
                'devices'        => count( $tokens ),
                'devices_linked' => $with_user,
            ];
        },
    ] );

    // POST /wp-json/miad/v1/push/send — envoie une notification push (HTTP v1)
    // Sans secret partagé, ce endpoint était ouvert à n'importe qui sur
    // Internet : un simple POST (title/body facultatifs) suffisait à
    // déclencher miad_send_push_to_all() et spammer tous les abonnés push du
    // site — corrigé le 2026-07-30. Même vérification que /email/broadcast
    // (X-Headless-Secret, voir miad_headless_secret_check() dans
    // miad-rep-api.php) : c'est ce qu'envoie callHeadlessAdmin côté Next.js
    // (lib/miad-admin-api.ts), utilisé par le nouvel onglet Push du dashboard admin.
    register_rest_route( 'miad/v1', '/push/send', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            if ( ! function_exists( 'miad_headless_secret_check' ) ) return false;
            return miad_headless_secret_check( $request );
        },
        'callback'            => function ( WP_REST_Request $req ) {
            $title   = sanitize_text_field( (string) $req->get_param('title') );
            $body    = sanitize_text_field( (string) $req->get_param('body') );
            $url     = esc_url_raw( (string) ( $req->get_param('url') ?: 'https://www.miadmarket.com' ) );
            $user_id = (int) $req->get_param('user_id');
            $token   = sanitize_text_field( (string) $req->get_param('token') );

            if ( $token ) {
                $sent = miad_fcm_send_v1( [ $token ], $title, $body, $url );
            } elseif ( $user_id ) {
                $sent = miad_send_push_to_user( $user_id, $title, $body, $url );
            } else {
                $sent = miad_send_push_to_all( $title, $body, $url );
            }

            return [ 'success' => true, 'sent' => $sent ];
        },
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   3. DÉCLENCHEMENT AUTOMATIQUE — lors des emails commandes
═══════════════════════════════════════════════════════════════════ */

// Push quand la commande est reçue
add_action( 'woocommerce_checkout_order_processed', function ( int $order_id, $posted_data, $order ) {
    if ( ! $order ) $order = wc_get_order( $order_id );
    if ( ! $order ) return;

    $user_id = (int) $order->get_user_id();
    if ( ! $user_id ) return; // Commande invité : pas de token enregistré

    miad_send_push_to_user(
        $user_id,
        '📬 Commande #' . $order->get_order_number() . ' reçue !',
        'Merci ' . $order->get_billing_first_name() . '. Votre commande est enregistrée.',
        'https://www.miadmarket.com'
    );
}, 35, 3 );

// Push quand le paiement est confirmé
add_action( 'woocommerce_order_status_processing', function ( int $order_id ) {
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $user_id = (int) $order->get_user_id();
    if ( ! $user_id ) return;

    miad_send_push_to_user(
        $user_id,
        '✅ Paiement confirmé — #' . $order->get_order_number(),
        'Votre paiement (' . html_entity_decode( wp_strip_all_tags( $order->get_formatted_order_total() ), ENT_QUOTES | ENT_HTML5 ) . ') a été validé.',
        'https://www.miadmarket.com'
    );
}, 20 );

// Push quand un représentant prend la commande en charge (miroir de l'email
// miad_rep_taken déjà envoyé dans miad-email-customizer.php section 15)
add_action( 'woocommerce_order_status_changed', function ( int $order_id, $from, $to ) {
    if ( $to !== 'miad-rep-charge' ) return;
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $user_id = (int) $order->get_user_id();
    if ( ! $user_id ) return;

    $rep_name = $order->get_meta( '_miad_rep_acknowledged_by' ) ?: 'Un représentant MIAD';

    miad_send_push_to_user(
        $user_id,
        '👤 Commande #' . $order->get_order_number() . ' prise en charge',
        $rep_name . ' s\'occupe maintenant de votre commande.',
        'https://www.miadmarket.com/?view=clientDashboard'
    );
}, 20, 3 );

// Push quand la commande est livrée
add_action( 'woocommerce_order_status_completed', function ( int $order_id ) {
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $user_id = (int) $order->get_user_id();
    if ( ! $user_id ) return;

    miad_send_push_to_user(
        $user_id,
        '🎉 Commande #' . $order->get_order_number() . ' livrée !',
        'Votre colis est arrivé. Profitez-en !',
        'https://www.miadmarket.com'
    );
}, 20 );

/* ═══════════════════════════════════════════════════════════════════
   4. FONCTIONS UTILITAIRES
═══════════════════════════════════════════════════════════════════ */

function miad_save_push_token( string $token, int $user_id = 0 ): void {
    $tokens = get_option( 'miad_push_tokens', [] );

    // Éviter les doublons par token
    foreach ( $tokens as &$t ) {
        if ( $t['token'] === $token ) {
            $t['user_id'] = $user_id;
            $t['date']    = current_time( 'mysql' );
            update_option( 'miad_push_tokens', $tokens );
            return;
        }
    }
    unset( $t );

    $tokens[] = [
        'token'   => $token,
        'user_id' => $user_id,
        'date'    => current_time( 'mysql' ),
    ];

    // Limite à 5000 tokens stockés
    if ( count( $tokens ) > 5000 ) $tokens = array_slice( $tokens, -5000 );

    update_option( 'miad_push_tokens', $tokens );
}

function miad_get_all_push_tokens(): array {
    return (array) get_option( 'miad_push_tokens', [] );
}

function miad_get_tokens_for_user( int $user_id ): array {
    return array_values( array_filter(
        miad_get_all_push_tokens(),
        fn( $t ) => (int) ( $t['user_id'] ?? 0 ) === $user_id
    ) );
}

/**
 * Envoie des push FCM via l'API HTTP v1 en passant par le front Next.js.
 * Next.js utilise Firebase Admin SDK + Service Account (plus de Legacy key).
 *
 * @param string[] $tokens  Tokens FCM des appareils cibles
 */
function miad_fcm_send_v1( array $tokens, string $title, string $body, string $url = '' ): int {
    $frontend = rtrim( get_option( 'miad_frontend_url', 'https://www.miadmarket.com' ), '/' );
    $secret   = get_option( 'miad_push_internal_secret', '' );

    if ( ! $secret || empty( $tokens ) ) return 0;

    $sent = 0;
    foreach ( array_chunk( $tokens, 500 ) as $chunk ) {
        $response = wp_remote_post( $frontend . '/api/push/send', [
            'timeout' => 15,
            'headers' => [
                'Content-Type'      => 'application/json',
                'X-Internal-Secret' => $secret,
            ],
            'body' => wp_json_encode( [
                'tokens' => array_values( $chunk ),
                'title'  => $title,
                'body'   => $body,
                'url'    => $url ?: 'https://www.miadmarket.com',
            ] ),
        ] );

        if ( ! is_wp_error( $response ) ) {
            $data = json_decode( wp_remote_retrieve_body( $response ), true );
            $sent += (int) ( $data['sent'] ?? 0 );
        }
    }
    return $sent;
}

function miad_send_push_to_user( int $user_id, string $title, string $body, string $url = '' ): int {
    $token_objs = miad_get_tokens_for_user( $user_id );
    if ( empty( $token_objs ) ) return 0;
    return miad_fcm_send_v1( array_column( $token_objs, 'token' ), $title, $body, $url );
}

function miad_send_push_to_all( string $title, string $body, string $url = '' ): int {
    $tokens = array_column( miad_get_all_push_tokens(), 'token' );
    if ( empty( $tokens ) ) return 0;
    return miad_fcm_send_v1( $tokens, $title, $body, $url );
}
