<?php
/**
 * Plugin Name: MIAD Recommendations API
 * Description: Moteur de recommandations "achetés ensemble" — calcule une
 *              table de co-occurrence produit A / produit B à partir des
 *              vraies commandes WooCommerce (pas de produits "similaires"
 *              inventés). Recalcul automatique quotidien (WP-Cron) + un
 *              endpoint pour forcer un recalcul manuel depuis le dashboard
 *              admin. Lecture publique (données agrégées, non sensibles).
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'MIAD_RECO_TABLE', $GLOBALS['wpdb']->prefix . 'miad_product_pairs' );

function miad_reco_ensure_table(): void {
    global $wpdb;
    if ( get_option( 'miad_reco_table_version' ) === '1' ) return;

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $charset_collate = $wpdb->get_charset_collate();
    $table = MIAD_RECO_TABLE;

    $sql = "CREATE TABLE {$table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        product_id BIGINT UNSIGNED NOT NULL,
        paired_product_id BIGINT UNSIGNED NOT NULL,
        co_occurrence_count INT UNSIGNED NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY product_pair (product_id, paired_product_id),
        KEY product_id_idx (product_id)
    ) {$charset_collate};";

    dbDelta( $sql );
    update_option( 'miad_reco_table_version', '1' );
}
add_action( 'init', 'miad_reco_ensure_table' );

/**
 * Recalcule entièrement la table de co-occurrence à partir des N dernières
 * commandes payées. Vide puis reconstruit (plus simple et plus fiable qu'un
 * calcul incrémental) — acceptable vu la fréquence (quotidienne) et le
 * volume actuel de commandes.
 */
function miad_reco_recompute( int $max_orders = 1000 ): array {
    global $wpdb;

    $orders = wc_get_orders( [
        'status'  => [ 'completed', 'processing' ],
        'type'    => 'shop_order', // exclut explicitement shop_order_refund — voir commentaire plus bas
        'limit'   => $max_orders,
        'orderby' => 'date',
        'order'   => 'DESC',
        'return'  => 'ids',
    ] );

    // pair_key "A:B" (A < B) => count — évite de compter A→B et B→A séparément en mémoire
    $pair_counts = [];

    foreach ( $orders as $order_id ) {
        $order = wc_get_order( $order_id );
        // wc_get_orders() peut renvoyer un remboursement (WC_Order_Refund) mélangé
        // aux vraies commandes malgré 'type' => 'shop_order' selon la config
        // HPOS — WC_Order_Refund n'hérite PAS de WC_Order (toutes deux étendent
        // séparément WC_Abstract_Order), donc get_items()/get_billing_email()
        // y sont absents et provoquent une Fatal Error non catchable par un
        // try/catch(\Exception) classique. Trouvé le 2026-07-11 via le journal
        // admin : "Call to undefined method ...OrderRefund::get_billing_email()".
        if ( ! $order || ! is_a( $order, 'WC_Order' ) ) continue;

        $product_ids = [];
        foreach ( $order->get_items() as $item ) {
            $pid = $item->get_product_id();
            if ( $pid ) $product_ids[] = $pid;
        }
        $product_ids = array_values( array_unique( $product_ids ) );
        $count = count( $product_ids );
        if ( $count < 2 ) continue;

        for ( $i = 0; $i < $count; $i++ ) {
            for ( $j = $i + 1; $j < $count; $j++ ) {
                $a = $product_ids[ $i ];
                $b = $product_ids[ $j ];
                if ( $a === $b ) continue;
                $key = $a < $b ? "{$a}:{$b}" : "{$b}:{$a}";
                $pair_counts[ $key ] = ( $pair_counts[ $key ] ?? 0 ) + 1;
            }
        }
    }

    $wpdb->query( "TRUNCATE TABLE " . MIAD_RECO_TABLE );

    $now = current_time( 'mysql', true );
    $rows_inserted = 0;
    foreach ( $pair_counts as $key => $count ) {
        [ $a, $b ] = array_map( 'intval', explode( ':', $key ) );
        // Deux lignes (A→B et B→A) pour permettre une recherche directe par product_id dans les deux sens.
        $wpdb->insert( MIAD_RECO_TABLE, [
            'product_id' => $a, 'paired_product_id' => $b, 'co_occurrence_count' => $count, 'updated_at' => $now,
        ] );
        $wpdb->insert( MIAD_RECO_TABLE, [
            'product_id' => $b, 'paired_product_id' => $a, 'co_occurrence_count' => $count, 'updated_at' => $now,
        ] );
        $rows_inserted += 2;
    }

    update_option( 'miad_reco_last_run', $now );
    update_option( 'miad_reco_last_orders_scanned', count( $orders ) );

    return [ 'orders_scanned' => count( $orders ), 'pairs_found' => count( $pair_counts ), 'rows_inserted' => $rows_inserted ];
}

// Recalcul quotidien automatique via WP-Cron.
if ( ! wp_next_scheduled( 'miad_reco_daily_recompute' ) ) {
    wp_schedule_event( time(), 'daily', 'miad_reco_daily_recompute' );
}
add_action( 'miad_reco_daily_recompute', function () { miad_reco_recompute(); } );

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/recommendations', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true', // lecture publique : juste des IDs produits + compteurs agrégés
        'callback'            => function ( WP_REST_Request $request ) {
            global $wpdb;
            $product_id = (int) $request->get_param( 'product_id' );
            $limit      = max( 1, min( 20, (int) ( $request->get_param( 'limit' ) ?? 8 ) ) );
            if ( ! $product_id ) {
                return new WP_REST_Response( [ 'error' => 'product_id requis' ], 400 );
            }

            $results = $wpdb->get_results( $wpdb->prepare(
                "SELECT paired_product_id AS product_id, co_occurrence_count FROM " . MIAD_RECO_TABLE . "
                 WHERE product_id = %d ORDER BY co_occurrence_count DESC LIMIT %d",
                $product_id, $limit
            ), ARRAY_A );

            return new WP_REST_Response( [ 'ok' => true, 'recommendations' => $results ], 200 );
        },
        'args' => [ 'product_id' => [ 'required' => true ], 'limit' => [] ],
    ] );
} );

// Recalcul manuel forcé — protégé par le même secret interne que les autres
// endpoints admin (évite qu'un visiteur lance un recalcul coûteux à volonté).
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/recommendations/recompute', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( ! $internal_secret ) return false;
            return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $max_orders = (int) ( $request->get_param( 'maxOrders' ) ?? 1000 );
            $stats = miad_reco_recompute( $max_orders ?: 1000 );
            return new WP_REST_Response( array_merge( [ 'ok' => true ], $stats ), 200 );
        },
        'args' => [ 'maxOrders' => [] ],
    ] );
} );

// Statut (dernière exécution) — utile pour le dashboard admin.
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/recommendations/status', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( ! $internal_secret ) return false;
            return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
        },
        'callback' => function () {
            global $wpdb;
            $total_pairs = (int) $wpdb->get_var( "SELECT COUNT(*) FROM " . MIAD_RECO_TABLE );
            return new WP_REST_Response( [
                'ok'             => true,
                'lastRun'        => get_option( 'miad_reco_last_run', null ),
                'ordersScanned'  => (int) get_option( 'miad_reco_last_orders_scanned', 0 ),
                'totalPairRows'  => $total_pairs,
            ], 200 );
        },
    ] );
} );

/**
 * Repli quand aucune co-occurrence n'existe pour ce client (catalogue/
 * historique de commandes encore trop petit pour avoir des paires) — les
 * produits les plus vendus du site, hors ce que le client a déjà acheté.
 * Signalé le 2026-07-11 : avec une table de co-occurrence encore clairsemée,
 * la quasi-totalité des clients étaient ignorés (0 email envoyé) faute de
 * recommandation personnalisée — mieux vaut leur montrer les best-sellers
 * que ne rien envoyer du tout.
 */
function miad_reco_fallback_top_ids( array $exclude_ids, int $limit = 4 ): array {
    if ( ! function_exists( 'wc_get_products' ) ) return [];
    return wc_get_products( [
        'status'   => 'publish',
        'limit'    => $limit,
        'orderby'  => 'popularity', // trie par total_sales — pas de nouvelle requête SQL à écrire
        'order'    => 'DESC',
        'exclude'  => $exclude_ids,
        'return'   => 'ids',
    ] );
}

/**
 * IDs produits actuellement dans le panier sauvegardé d'un client, via
 * l'option _miad_saved_cart déjà maintenue par le système de récupération
 * de panier abandonné (miad-cart-recovery.php, mise à jour à chaque ajout/
 * retrait de panier). Signalé le 2026-07-11 : un produit déjà dans le
 * panier du client ressortait quand même en recommandation — corrigé pour
 * les clients CONNECTÉS uniquement (le panier d'un invité n'existe que
 * dans son navigateur, jamais envoyé à WordPress ; repli silencieux sur un
 * tableau vide, pas une erreur). Lit directement la meta plutôt que
 * d'appeler une fonction de cet autre fichier, pour rester autonome.
 */
function miad_reco_cart_product_ids_for_email( string $email ): array {
    $user = get_user_by( 'email', $email );
    if ( ! $user ) return [];
    $cart = get_user_meta( $user->ID, '_miad_saved_cart', true );
    if ( ! is_array( $cart ) || empty( $cart['items'] ) ) return [];
    return array_values( array_unique( array_map( fn( $i ) => (int) ( $i['product_id'] ?? 0 ), $cart['items'] ) ) );
}

/**
 * Co-occurrence (ou repli best-sellers) pour une liste de produits déjà
 * achetés — factorisé hors de miad_reco_send_emails() pour être réutilisé
 * par miad_reco_get_recommendations_for_email() (personnalisation des
 * emails de diffusion, demandée le 2026-07-11). $extra_exclude_ids
 * s'ajoute à l'exclusion finale sans participer à la recherche de
 * co-occurrence (ex: panier en cours — pas un signal d'achat).
 */
function miad_reco_top_ids_for_bought( array $bought_ids, int $limit = 4, array $extra_exclude_ids = [] ): array {
    global $wpdb;
    $exclude_ids = array_values( array_unique( array_merge( $bought_ids, $extra_exclude_ids ) ) );

    if ( empty( $bought_ids ) ) return miad_reco_fallback_top_ids( $exclude_ids, $limit );

    $reco_scores = [];
    foreach ( $bought_ids as $pid ) {
        $rows = $wpdb->get_results( $wpdb->prepare(
            "SELECT paired_product_id, co_occurrence_count FROM " . MIAD_RECO_TABLE . "
             WHERE product_id = %d ORDER BY co_occurrence_count DESC LIMIT 5",
            $pid
        ), ARRAY_A );
        foreach ( $rows as $row ) {
            $rpid = (int) $row['paired_product_id'];
            if ( in_array( $rpid, $exclude_ids, true ) ) continue; // déjà acheté ou déjà au panier
            $reco_scores[ $rpid ] = ( $reco_scores[ $rpid ] ?? 0 ) + (int) $row['co_occurrence_count'];
        }
    }

    if ( empty( $reco_scores ) ) return miad_reco_fallback_top_ids( $exclude_ids, $limit );
    arsort( $reco_scores );
    return array_slice( array_keys( $reco_scores ), 0, $limit );
}

/** Infos communes à un produit, réutilisées par les deux modèles (grille/liste). */
function miad_reco_product_card_data( WC_Product $product ): array {
    $img_id  = $product->get_image_id();
    $img_url = $img_id ? wp_get_attachment_image_url( $img_id, 'medium' ) : 'https://www.miadmarket.com/wp-content/uploads/logo.png';
    $product_url = rtrim( defined( 'MIAD_SITE_URL' ) ? MIAD_SITE_URL : 'https://www.miadmarket.com', '/' ) . '/product/' . $product->get_slug();

    $regular      = (float) $product->get_regular_price();
    $sale         = (float) $product->get_price();
    $discount_pct = ( $product->is_on_sale() && $regular > 0 ) ? (int) round( ( 1 - $sale / $regular ) * 100 ) : 0;

    $price_html = '<span style="color:#005826;font-weight:800">' . wp_strip_all_tags( wc_price( $sale ) ) . '</span>';
    if ( $discount_pct > 0 ) {
        $price_html .= ' <span style="color:#9ca3af;text-decoration:line-through;font-size:11px">' . wp_strip_all_tags( wc_price( $regular ) ) . '</span>';
    }

    return compact( 'img_url', 'product_url', 'discount_pct', 'price_html' );
}

/**
 * Modèle "Grille catalogue" — 2 colonnes avec badge de réduction, style
 * AliExpress (demandé le 2026-07-11). Tables imbriquées uniquement (pas de
 * flex/grid CSS) pour rester fiable dans Outlook — même contrainte que le
 * reste des emails du site (voir miad-cart-recovery.php).
 */
function miad_reco_render_product_cards_grid( array $ids ): array {
    $names = [];
    $items = [];

    foreach ( $ids as $pid ) {
        $product = wc_get_product( $pid );
        if ( ! $product || ! $product->is_visible() ) continue;
        $names[] = $product->get_name();
        $d = miad_reco_product_card_data( $product );

        // Bandeau au-dessus de l'image plutôt qu'un badge en position absolue
        // sur le coin — position:absolute n'est pas fiable dans Outlook.
        $badge = $d['discount_pct'] > 0
            ? '<tr><td style="background:#e53e3e;color:#fff;font-size:11px;font-weight:800;padding:3px 0;text-align:center">-' . $d['discount_pct'] . '%</td></tr>'
            : '';

        $items[] = '
          <table cellpadding="0" cellspacing="0" width="100%" style="background:#fafafa;border-radius:12px;overflow:hidden">
            ' . $badge . '
            <tr><td>
              <a href="' . esc_url( $d['product_url'] ) . '"><img src="' . esc_url( $d['img_url'] ) . '" width="220" height="220" style="display:block;width:100%;max-width:220px;height:auto;object-fit:cover" alt=""></a>
            </td></tr>
            <tr><td style="padding:10px 12px 14px">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#111827;line-height:1.35;max-height:2.7em;overflow:hidden">' . esc_html( $product->get_name() ) . '</p>
              <p style="margin:0 0 10px;font-size:13px">' . $d['price_html'] . '</p>
              <a href="' . esc_url( $d['product_url'] ) . '" style="display:inline-block;background:#005826;color:#fff;text-decoration:none;font-size:11px;font-weight:700;padding:7px 14px;border-radius:20px">Voir le produit</a>
            </td></tr>
          </table>';
    }

    $html = '<table cellpadding="0" cellspacing="0" width="100%">';
    for ( $i = 0; $i < count( $items ); $i += 2 ) {
        $html .= '<tr>'
            . '<td width="50%" style="padding:6px;vertical-align:top">' . $items[ $i ] . '</td>'
            . '<td width="50%" style="padding:6px;vertical-align:top">' . ( $items[ $i + 1 ] ?? '' ) . '</td>'
            . '</tr>';
    }
    $html .= '</table>';

    return [ 'html' => $html, 'names' => $names ];
}

/**
 * Modèle "Liste classique" — un produit par ligne, image à gauche, texte à
 * droite (design d'origine, gardé en second choix — demandé le 2026-07-11 :
 * "plusieurs modèles au choix").
 */
function miad_reco_render_product_cards_list( array $ids ): array {
    $names = [];
    $html  = '';

    foreach ( $ids as $pid ) {
        $product = wc_get_product( $pid );
        if ( ! $product || ! $product->is_visible() ) continue;
        $names[] = $product->get_name();
        $d = miad_reco_product_card_data( $product );

        $html .= '
          <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;background:#fafafa;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="width:100px;padding:12px;"><img src="' . esc_url( $d['img_url'] ) . '" width="80" height="80" style="border-radius:10px;object-fit:cover;" alt=""></td>
              <td style="padding:12px 16px 12px 0;">
                <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#111827;">' . esc_html( $product->get_name() ) . '</p>
                <p style="margin:0 0 10px;font-size:13px;">' . $d['price_html'] . '</p>
                <a href="' . esc_url( $d['product_url'] ) . '" style="display:inline-block;background:#005826;color:#fff;text-decoration:none;font-size:11px;font-weight:700;padding:8px 16px;border-radius:20px;">Voir le produit</a>
              </td>
            </tr>
          </table>';
    }

    return [ 'html' => $html, 'names' => $names ];
}

/** Dispatcheur — 'grid' (défaut) ou 'list', voir les deux fonctions ci-dessus. */
function miad_reco_render_product_cards( array $ids, string $template = 'grid' ): array {
    return $template === 'list'
        ? miad_reco_render_product_cards_list( $ids )
        : miad_reco_render_product_cards_grid( $ids );
}

/**
 * Recommandations personnalisées pour UN client (par email), à partir de
 * ses vraies commandes — utilisé par la diffusion "Emails" pour ajouter des
 * suggestions de produits à chaque envoi, pas seulement par l'email de
 * recommandation dédié. Renvoie ['html' => ..., 'names' => [...]], html vide
 * si vraiment aucun produit à proposer (catalogue vide).
 */
function miad_reco_get_recommendations_for_email( string $email, int $limit = 4, string $template = 'grid' ): array {
    $orders = wc_get_orders( [
        'billing_email' => $email,
        'status'        => [ 'completed', 'processing' ],
        'type'          => 'shop_order',
        'limit'         => 50,
        'return'        => 'ids',
    ] );

    $bought_ids = [];
    foreach ( $orders as $order_id ) {
        $order = wc_get_order( $order_id );
        if ( ! $order || ! is_a( $order, 'WC_Order' ) ) continue; // même garde que miad_reco_recompute()
        foreach ( $order->get_items() as $item ) {
            $pid = $item->get_product_id();
            if ( $pid ) $bought_ids[] = $pid;
        }
    }
    $bought_ids = array_values( array_unique( $bought_ids ) );

    $cart_ids = miad_reco_cart_product_ids_for_email( $email );
    $top_ids  = miad_reco_top_ids_for_bought( $bought_ids, $limit, $cart_ids );
    return miad_reco_render_product_cards( $top_ids, $template );
}

/**
 * Envoie un email de recommandations personnalisées à chaque client ayant
 * déjà commandé — construit à partir de SES vrais achats + la table de
 * co-occurrence (jamais le même email pour tout le monde). Plafonné à
 * $max_orders commandes scannées et $max_customers clients par appel pour
 * rester dans les limites de temps d'exécution du serveur.
 */
function miad_reco_send_emails( int $max_orders = 500, int $max_customers = 200, bool $dry_run = false, string $template = 'grid' ): array {
    global $wpdb;

    // Jusqu'à 200 clients × plusieurs requêtes de co-occurrence + un vrai
    // envoi SMTP chacun (souvent 1-3s via un relais externe type FluentSMTP)
    // peut largement dépasser le max_execution_time par défaut d'un hébergement
    // mutualisé (30-60s), ce qui tue le script en plein milieu avec une 500
    // brute sans aucun log applicatif — c'est la cause la plus probable du
    // 500 constaté le 2026-07-10 (aucune autre erreur trouvée dans ce fichier).
    if ( function_exists( 'set_time_limit' ) ) { @set_time_limit( 0 ); }
    // set_time_limit(0) seul n'a pas suffi (500 toujours constaté le
    // 2026-07-11 malgré ce fix) — memory_limit est une limite SÉPARÉE de
    // l'exécution : construire des centaines de blocs HTML produit + garder
    // toutes les commandes/clients en mémoire peut dépasser le memory_limit
    // par défaut d'un hébergement mutualisé (souvent 256M), ce qui tue le
    // script sans passer par un throw catchable. wp_raise_memory_limit() est
    // le pattern WP standard pour les tâches admin lourdes (import, export…).
    if ( function_exists( 'wp_raise_memory_limit' ) ) { wp_raise_memory_limit( 'admin' ); }

    $orders = wc_get_orders( [
        'status'  => [ 'completed', 'processing' ],
        'type'    => 'shop_order', // exclut shop_order_refund — voir commentaire dans miad_reco_recompute()
        'limit'   => $max_orders,
        'orderby' => 'date',
        'order'   => 'DESC',
        'return'  => 'ids',
    ] );

    // Vendeurs/admins exclus des recommandations — même raison que pour le
    // comptage "Clients WC" (miad-email-blast-api.php) : leurs propres
    // commandes de test sur le site réel ne doivent pas les faire apparaître
    // comme destinataires. Fonction partagée si déjà chargée, sinon repli
    // local pour que ce fichier reste autonome.
    $excluded_emails = function_exists( 'miad_email_blast_excluded_emails' )
        ? miad_email_blast_excluded_emails()
        : array_map( fn( $u ) => strtolower( $u->user_email ), get_users( [ 'role__in' => [ 'administrator', 'seller', 'vendor' ], 'fields' => [ 'user_email' ] ] ) );

    // email => { name, product_ids[] }
    $customers = [];
    foreach ( $orders as $order_id ) {
        $order = wc_get_order( $order_id );
        // Cause réelle du 500 constaté le 2026-07-11 : un WC_Order_Refund
        // mélangé aux vraies commandes n'a pas get_billing_email() — voir le
        // commentaire détaillé dans miad_reco_recompute() plus haut.
        if ( ! $order || ! is_a( $order, 'WC_Order' ) ) continue;
        $email = $order->get_billing_email();
        if ( ! $email || ! is_email( $email ) ) continue;
        if ( in_array( strtolower( $email ), $excluded_emails, true ) ) continue; // vendeur/admin — pas un vrai client

        if ( ! isset( $customers[ $email ] ) ) {
            $customers[ $email ] = [
                'name'        => $order->get_billing_first_name() ?: 'Client',
                'product_ids' => [],
            ];
        }
        foreach ( $order->get_items() as $item ) {
            $pid = $item->get_product_id();
            if ( $pid ) $customers[ $email ]['product_ids'][] = $pid;
        }
    }

    $sent = 0;
    $failed = 0;
    $skipped = 0;
    $processed = 0;
    $preview = []; // Rempli seulement si $dry_run — aperçu des destinataires avant envoi réel.

    foreach ( $customers as $email => $info ) {
        if ( $processed >= $max_customers ) break;
        $processed++;

        $bought_ids = array_values( array_unique( $info['product_ids'] ) );
        if ( empty( $bought_ids ) ) { $skipped++; continue; }

        // Repli sur les best-sellers déjà géré par miad_reco_top_ids_for_bought()
        // si ce client n'a pas de co-occurrence — voir son commentaire.
        $cart_ids = miad_reco_cart_product_ids_for_email( $email );
        $top_ids  = miad_reco_top_ids_for_bought( $bought_ids, 4, $cart_ids );
        if ( empty( $top_ids ) ) { $skipped++; continue; } // vraiment aucun produit à proposer

        $cards = miad_reco_render_product_cards( $top_ids, $template );
        $products_html = $cards['html'];
        $product_names = $cards['names'];
        // La grille garde son <table> englobant même vide — !$products_html
        // ne détecterait jamais "rien à montrer" ; on teste $product_names.
        if ( empty( $product_names ) ) { $skipped++; continue; }

        $split_to  = explode( '@', $email );
        $masked_to = substr( $split_to[0], 0, 2 ) . '***@' . ( $split_to[1] ?? 'domain.com' );

        // Aperçu : on s'arrête ici, avant de construire le HTML complet de
        // l'email et sans jamais appeler wp_mail() — juste qui recevrait
        // quoi, pour valider avant un vrai envoi.
        if ( $dry_run ) {
            $preview[] = [ 'email' => $masked_to, 'name' => $info['name'], 'products' => $product_names ];
            $sent++;
            continue;
        }

        $subject = 'Des produits qui pourraient vous plaire — MIAD Market';
        // Contenu SEUL (pas de <!DOCTYPE>/<body> ici) — miad_send_professional_email()
        // l'enveloppe dans le même habillage WooCommerce (logo, couleurs, pied
        // de page) que tous les autres emails du site (commandes, messages
        // représentant...). Avant ce correctif, cet email construisait son
        // propre HTML "maison" et n'avait pas le même rendu que le reste —
        // signalé le 2026-07-11 ("n'utilise pas notre modèle").
        $body = '<p style="margin:0 0 4px;font-size:20px;font-weight:800;color:#111827;">Bonjour ' . esc_html( $info['name'] ) . ',</p>'
            . '<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">D\'après vos achats précédents, voici des produits qui pourraient vous plaire :</p>'
            . $products_html;

        // miad_send_professional_email() vérifie déjà le retour de wp_mail()
        // et logue dans miad_email_logs (masquage, source, erreur détaillée)
        // — même pattern que /email/send et /email/broadcast, pas la peine
        // de dupliquer cette logique ici. Repli défensif sur wp_mail() brut
        // si miad-email-customizer.php n'était pas chargé (ne devrait pas
        // arriver en usage normal, mais évite un fatal sinon).
        $ok = function_exists( 'miad_send_professional_email' )
            ? miad_send_professional_email( $email, $subject, $body, null, [ 'email_type' => 'recommendation' ] )
            : (bool) wp_mail( $email, $subject, $body, [ 'Content-Type: text/html; charset=UTF-8' ] );
        if ( $ok ) {
            $sent++;
        } else {
            $failed++;
        }
    }

    return [
        'sent'            => $sent,
        'failed'          => $failed,
        'skipped'         => $skipped,
        'totalCustomers'  => count( $customers ),
        'ordersScanned'   => count( $orders ),
        'preview'         => $preview,
    ];
}

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/recommendations/send-emails', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( ! $internal_secret ) return false;
            return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $max_orders    = (int) ( $request->get_param( 'maxOrders' ) ?? 500 );
            $max_customers = (int) ( $request->get_param( 'maxCustomers' ) ?? 200 );
            $template      = in_array( $request->get_param( 'template' ), [ 'grid', 'list' ], true ) ? $request->get_param( 'template' ) : 'grid';
            // Le 500 constaté le 2026-07-10/11 arrivait sans aucun détail dans le
            // journal admin (fatal non catchable, probablement memory_limit —
            // voir wp_raise_memory_limit() plus haut). Ce try/catch(\Throwable)
            // ne peut pas rattraper un vrai out-of-memory, mais capture tout le
            // reste (TypeError, exception WooCommerce/Stripe...) pour qu'un futur
            // 500 arrive enfin avec un vrai message dans le journal au lieu d'une
            // page vide.
            try {
                $stats = miad_reco_send_emails( $max_orders ?: 500, $max_customers ?: 200, false, $template );
                return new WP_REST_Response( array_merge( [ 'ok' => true ], $stats ), 200 );
            } catch ( \Throwable $e ) {
                return new WP_REST_Response( [
                    'ok'    => false,
                    'error' => $e->getMessage(),
                    'file'  => $e->getFile() . ':' . $e->getLine(),
                ], 500 );
            }
        },
        'args' => [ 'maxOrders' => [], 'maxCustomers' => [], 'template' => [] ],
    ] );
} );

// Aperçu avant envoi réel : qui recevrait quoi, sans jamais appeler
// wp_mail() ni écrire dans miad_email_logs — demandé le 2026-07-11 pour
// valider avant de cliquer le vrai bouton d'envoi.
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/recommendations/send-emails/preview', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( ! $internal_secret ) return false;
            return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $max_orders    = (int) ( $request->get_param( 'maxOrders' ) ?? 500 );
            $max_customers = (int) ( $request->get_param( 'maxCustomers' ) ?? 200 );
            $template      = in_array( $request->get_param( 'template' ), [ 'grid', 'list' ], true ) ? $request->get_param( 'template' ) : 'grid';
            try {
                $stats = miad_reco_send_emails( $max_orders ?: 500, $max_customers ?: 200, true, $template );
                return new WP_REST_Response( array_merge( [ 'ok' => true ], $stats ), 200 );
            } catch ( \Throwable $e ) {
                return new WP_REST_Response( [
                    'ok'    => false,
                    'error' => $e->getMessage(),
                    'file'  => $e->getFile() . ':' . $e->getLine(),
                ], 500 );
            }
        },
        'args' => [ 'maxOrders' => [], 'maxCustomers' => [], 'template' => [] ],
    ] );
} );
