<?php
/**
 * MIAD Coins System — WooCommerce Snippet
 *
 * Installation : Colle ce fichier dans Code Snippets (plugin WordPress)
 * ou dans functions.php de ton thème enfant.
 *
 * Ce snippet gère :
 *  1. Attribution automatique de coins à chaque commande complétée
 *  2. Lecture / écriture des coins par utilisateur (user meta)
 *  3. Historique des transactions par utilisateur
 *  4. Bonus quotidien (réclamable une fois par jour)
 *  5. REST API pour le front Next.js
 *  6. Comptage des visiteurs + taux de conversion dans l'admin
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════════
   CONSTANTES
═══════════════════════════════════════════════════════════════════════ */
define( 'MIAD_COINS_PER_ORDER',  500  );  // Coins gagnés par commande complétée
define( 'MIAD_COINS_DAILY',      50   );  // Coins bonus quotidien (connexion)
define( 'MIAD_COINS_PER_SHARE',  200  );  // Coins pour partager un lien produit
define( 'MIAD_COINS_PER_REVIEW', 30   );  // Coins pour laisser un avis approuvé
define( 'MIAD_COINS_REFERRAL',   1000 );  // Coins pour parrainage ami
// Valeur monétaire : 1 coin = 0.00001 USD  →  100 000 coins = 1 USD ≈ 600 FCFA
define( 'MIAD_COINS_VALUE_USD',  0.00001 );
define( 'MIAD_USD_TO_FCFA',      600     );

/* ═══════════════════════════════════════════════════════════════════════
   FONCTION 1 — Lire / écrire les coins d'un utilisateur
═══════════════════════════════════════════════════════════════════════ */

/**
 * Retourne le solde de coins d'un utilisateur.
 *
 * @param int $user_id  ID WordPress de l'utilisateur (0 = utilisateur courant)
 * @return int
 */
function miad_get_coins( int $user_id = 0 ): int {
    if ( ! $user_id ) $user_id = get_current_user_id();
    if ( ! $user_id ) return 0;
    return (int) get_user_meta( $user_id, '_miad_coins_balance', true );
}

/**
 * Ajoute des coins à un utilisateur et enregistre la transaction.
 *
 * @param int    $user_id
 * @param int    $amount   Nombre de coins à ajouter (positif)
 * @param string $reason   Libellé de la transaction
 * @return int             Nouveau solde
 */
function miad_add_coins( int $user_id, int $amount, string $reason = '' ): int {
    if ( ! $user_id || $amount <= 0 ) return miad_get_coins( $user_id );

    $balance = miad_get_coins( $user_id ) + $amount;
    update_user_meta( $user_id, '_miad_coins_balance', $balance );
    miad_push_history( $user_id, 'earn', $amount, $reason );

    do_action( 'miad_coins_added', $user_id, $amount, $reason, $balance );
    return $balance;
}

/**
 * Dépense des coins. Retourne false si solde insuffisant.
 *
 * @param int    $user_id
 * @param int    $amount
 * @param string $reason
 * @return bool|int  false si insuffisant, sinon nouveau solde
 */
function miad_spend_coins( int $user_id, int $amount, string $reason = '' ) {
    $balance = miad_get_coins( $user_id );
    if ( $balance < $amount ) return false;

    $new = $balance - $amount;
    update_user_meta( $user_id, '_miad_coins_balance', $new );
    miad_push_history( $user_id, 'spend', $amount, $reason );

    do_action( 'miad_coins_spent', $user_id, $amount, $reason, $new );
    return $new;
}

/* ═══════════════════════════════════════════════════════════════════════
   FONCTION 2 — Historique des transactions
═══════════════════════════════════════════════════════════════════════ */

/**
 * Ajoute une entrée dans l'historique (60 dernières transactions max).
 */
function miad_push_history( int $user_id, string $type, int $amount, string $reason ) {
    $history = miad_get_history( $user_id );
    array_unshift( $history, [
        'id'     => uniqid( 'tx_' ),
        'type'   => $type,
        'amount' => $amount,
        'reason' => sanitize_text_field( $reason ),
        'date'   => current_time( 'c' ),
    ] );
    update_user_meta( $user_id, '_miad_coins_history', array_slice( $history, 0, 60 ) );
}

/**
 * Retourne l'historique des transactions d'un utilisateur.
 *
 * @param int $user_id
 * @return array
 */
function miad_get_history( int $user_id ): array {
    $h = get_user_meta( $user_id, '_miad_coins_history', true );
    return is_array( $h ) ? $h : [];
}

/* ═══════════════════════════════════════════════════════════════════════
   FONCTION 3 — Bonus quotidien
═══════════════════════════════════════════════════════════════════════ */

/**
 * Vérifie si l'utilisateur peut réclamer son bonus du jour.
 */
function miad_can_claim_daily( int $user_id ): bool {
    $last = get_user_meta( $user_id, '_miad_coins_daily', true );
    if ( ! $last ) return true;
    return date( 'Y-m-d' ) !== date( 'Y-m-d', strtotime( $last ) );
}

/**
 * Attribue le bonus quotidien (retourne 0 si déjà réclamé aujourd'hui).
 */
function miad_claim_daily( int $user_id ): int {
    if ( ! miad_can_claim_daily( $user_id ) ) return 0;
    update_user_meta( $user_id, '_miad_coins_daily', current_time( 'c' ) );
    return miad_add_coins( $user_id, MIAD_COINS_DAILY, 'Bonus quotidien' );
}

/* ═══════════════════════════════════════════════════════════════════════
   HOOKS WOOCOMMERCE — Attribution automatique
═══════════════════════════════════════════════════════════════════════ */

/**
 * +5 coins quand une commande passe en "completed".
 */
add_action( 'woocommerce_order_status_completed', function( int $order_id ) {
    $order   = wc_get_order( $order_id );
    $user_id = $order ? (int) $order->get_user_id() : 0;
    if ( ! $user_id ) return;

    // Éviter de doubler l'attribution si déjà faite
    if ( $order->get_meta( '_miad_coins_awarded' ) ) return;

    miad_add_coins( $user_id, MIAD_COINS_PER_ORDER, 'Commande #' . $order_id );
    $order->update_meta_data( '_miad_coins_awarded', '1' );
    $order->save();
} );

/**
 * +3 coins quand un avis WooCommerce est approuvé.
 */
add_action( 'comment_approved_product', function( $comment_id ) {
    $comment = get_comment( $comment_id );
    $user_id = $comment ? (int) $comment->user_id : 0;
    if ( ! $user_id ) return;
    miad_add_coins( $user_id, MIAD_COINS_PER_REVIEW, 'Avis produit' );
} );

/* ═══════════════════════════════════════════════════════════════════════
   COMPTAGE DES VISITEURS + CONVERSIONS
═══════════════════════════════════════════════════════════════════════ */

/**
 * Incrémente le compteur de visites (appelé via REST par le front Next.js
 * ou directement dans wp_head si rendu WordPress).
 */
add_action( 'wp_head', 'miad_track_visit' );
function miad_track_visit() {
    if ( is_admin() ) return;
    $today = date( 'Y-m-d' );
    $key   = 'miad_visits_' . $today;
    $count = (int) get_option( $key, 0 );
    update_option( $key, $count + 1, false );
}

/**
 * Retourne les statistiques des 30 derniers jours.
 *
 * @return array { visits_today, visits_30d, orders_30d, conversion_rate }
 */
function miad_get_stats(): array {
    $today      = date( 'Y-m-d' );
    $visits_today = (int) get_option( 'miad_visits_' . $today, 0 );

    $visits_30d = 0;
    for ( $i = 0; $i < 30; $i++ ) {
        $day = date( 'Y-m-d', strtotime( "-{$i} days" ) );
        $visits_30d += (int) get_option( 'miad_visits_' . $day, 0 );
    }

    // Commandes des 30 derniers jours
    $orders_30d = (int) wc_get_orders( [
        'status'       => [ 'completed', 'processing' ],
        'date_created' => '>' . ( time() - 30 * DAY_IN_SECONDS ),
        'return'       => 'ids',
        'limit'        => -1,
    ] );
    // wc_get_orders avec limit=-1 retourne un tableau
    if ( is_array( $orders_30d ) ) $orders_30d = count( $orders_30d );

    $rate = $visits_30d > 0 ? round( ( $orders_30d / $visits_30d ) * 100, 2 ) : 0;

    return [
        'visits_today'    => $visits_today,
        'visits_30d'      => $visits_30d,
        'orders_30d'      => $orders_30d,
        'conversion_rate' => $rate . '%',
    ];
}

/* ═══════════════════════════════════════════════════════════════════════
   REST API — Endpoints pour le front Next.js
   Base URL : /wp-json/miad/v1/
═══════════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function() {

    // GET /wp-json/miad/v1/coins — solde + historique de l'utilisateur connecté
    register_rest_route( 'miad/v1', '/coins', [
        'methods'             => 'GET',
        'callback'            => function( WP_REST_Request $req ) {
            $user_id = get_current_user_id();
            if ( ! $user_id ) return new WP_Error( 'unauthorized', 'Non connecté', [ 'status' => 401 ] );
            return rest_ensure_response( [
                'balance' => miad_get_coins( $user_id ),
                'history' => array_slice( miad_get_history( $user_id ), 0, 20 ),
                'can_claim_daily' => miad_can_claim_daily( $user_id ),
            ] );
        },
        'permission_callback' => '__return_true',
    ] );

    // POST /wp-json/miad/v1/coins/daily — réclamer le bonus quotidien
    register_rest_route( 'miad/v1', '/coins/daily', [
        'methods'             => 'POST',
        'callback'            => function( WP_REST_Request $req ) {
            $user_id = get_current_user_id();
            if ( ! $user_id ) return new WP_Error( 'unauthorized', 'Non connecté', [ 'status' => 401 ] );
            $new_balance = miad_claim_daily( $user_id );
            return rest_ensure_response( [
                'claimed' => $new_balance > 0,
                'balance' => miad_get_coins( $user_id ),
                'earned'  => $new_balance > 0 ? MIAD_COINS_DAILY : 0,
            ] );
        },
        'permission_callback' => '__return_true',
    ] );

    // GET /wp-json/miad/v1/stats — visiteurs + conversions (admin uniquement)
    register_rest_route( 'miad/v1', '/stats', [
        'methods'             => 'GET',
        'callback'            => function() {
            return rest_ensure_response( miad_get_stats() );
        },
        'permission_callback' => function() {
            return current_user_can( 'manage_woocommerce' );
        },
    ] );

    // GET /wp-json/miad/v1/coins/leaderboard — top utilisateurs par coins (admin)
    register_rest_route( 'miad/v1', '/coins/leaderboard', [
        'methods'             => 'GET',
        'callback'            => function() {
            $users = get_users( [
                'meta_key'   => '_miad_coins_balance',
                'orderby'    => 'meta_value_num',
                'order'      => 'DESC',
                'number'     => 20,
            ] );
            $data = array_map( function( WP_User $u ) {
                return [
                    'id'       => $u->ID,
                    'name'     => $u->display_name,
                    'email'    => $u->user_email,
                    'balance'  => miad_get_coins( $u->ID ),
                ];
            }, $users );
            return rest_ensure_response( $data );
        },
        'permission_callback' => function() {
            return current_user_can( 'manage_woocommerce' );
        },
    ] );

} );

/* ═══════════════════════════════════════════════════════════════════════
   ADMIN — Colonne "Coins" dans la liste des utilisateurs
═══════════════════════════════════════════════════════════════════════ */

add_filter( 'manage_users_columns', function( array $cols ): array {
    $cols['miad_coins'] = '🪙 MIAD Coins';
    return $cols;
} );

add_filter( 'manage_users_custom_column', function( string $output, string $col, int $user_id ): string {
    if ( $col !== 'miad_coins' ) return $output;
    $bal = miad_get_coins( $user_id );
    return '<strong style="color:#F5A623">' . number_format( $bal ) . '</strong>';
}, 10, 3 );

/* ═══════════════════════════════════════════════════════════════════════
   ADMIN — Widget de stats sur le tableau de bord WordPress
═══════════════════════════════════════════════════════════════════════ */

add_action( 'wp_dashboard_setup', function() {
    wp_add_dashboard_widget(
        'miad_coins_stats',
        '🪙 MIAD Coins & Conversions',
        function() {
            $stats = miad_get_stats();
            echo '<table style="width:100%;border-collapse:collapse">';
            foreach ( [
                'Visites aujourd\'hui' => $stats['visits_today'],
                'Visites (30j)'        => number_format( $stats['visits_30d'] ),
                'Commandes (30j)'      => $stats['orders_30d'],
                'Taux de conversion'   => $stats['conversion_rate'],
            ] as $label => $val ) {
                echo "<tr>
                    <td style='padding:6px 0;color:#666'>{$label}</td>
                    <td style='padding:6px 0;font-weight:700;text-align:right'>{$val}</td>
                </tr>";
            }
            echo '</table>';

            // Top 5 utilisateurs
            $top = get_users( [
                'meta_key' => '_miad_coins_balance',
                'orderby'  => 'meta_value_num',
                'order'    => 'DESC',
                'number'   => 5,
            ] );
            if ( $top ) {
                echo '<hr style="margin:12px 0"><strong>Top Coins</strong><ul style="margin:8px 0 0">';
                foreach ( $top as $u ) {
                    $bal = miad_get_coins( $u->ID );
                    echo "<li style='display:flex;justify-content:space-between;padding:3px 0'>
                        <span>{$u->display_name}</span>
                        <strong style='color:#F5A623'>{$bal} C</strong>
                    </li>";
                }
                echo '</ul>';
            }
        }
    );
} );
