<?php
/**
 * MIAD Cart Recovery — Récupération de paniers abandonnés
 *
 * Ce snippet :
 *  1. Sauvegarde le panier de chaque utilisateur connecté
 *  2. Détecte les abandons (panier non commandé après 1h)
 *  3. Envoie un email de récupération avec les vrais produits + lien "Restaurer"
 *  4. Fournit un endpoint qui restaure le panier en 1 clic
 *  5. Corrige l'affichage des produits dans les emails de commande
 *
 * NÉCESSITE : miad-email-customizer.php chargé en amont.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Vérifie qu'une URL d'image pointe vers un format affiché de façon fiable dans les
 * clients email (Gmail ne supporte pas AVIF/WebP dans le corps des messages). On
 * n'a aucun moyen de garantir qu'une variante JPEG/PNG existe sur R2 pour cette
 * miniature, donc on rejette tout ce qui n'est pas un format email-safe plutôt que
 * de risquer une image cassée.
 */
function miad_is_email_safe_image_url( string $url ): bool {
    if ( ! $url ) return false;
    $ext = strtolower( pathinfo( parse_url( $url, PHP_URL_PATH ) ?: '', PATHINFO_EXTENSION ) );
    return in_array( $ext, [ 'jpg', 'jpeg', 'png', 'gif' ], true );
}

/* ═══════════════════════════════════════════════════════════════════
   1. SAUVEGARDE DU PANIER EN TEMPS RÉEL
═══════════════════════════════════════════════════════════════════ */

// Sauvegarde à chaque modification du panier
add_action( 'woocommerce_cart_updated', 'miad_save_cart' );
add_action( 'woocommerce_add_to_cart',  'miad_save_cart' );

function miad_save_cart(): void {
    $user_id = get_current_user_id();
    if ( ! $user_id ) return;

    $cart = WC()->cart;
    if ( ! $cart || $cart->is_empty() ) {
        delete_user_meta( $user_id, '_miad_saved_cart' );
        return;
    }

    $items = [];
    foreach ( $cart->get_cart() as $key => $item ) {
        $product = $item['data'];
        if ( ! $product ) continue;
        $img_id  = $product->get_image_id();
        $img_url = $img_id ? wp_get_attachment_image_url( $img_id, 'thumbnail' ) : '';
        if ( ! miad_is_email_safe_image_url( (string) $img_url ) ) $img_url = '';

        $items[] = [
            'product_id'   => $item['product_id'],
            'variation_id' => $item['variation_id'] ?? 0,
            'quantity'     => $item['quantity'],
            'name'         => $product->get_name(),
            'price'        => (float) $product->get_price(),
            'regular'      => (float) $product->get_regular_price(),
            'image'        => $img_url ?: ( defined('MIAD_LOGO_URL') ? MIAD_LOGO_URL : '' ),
            // Lien frontend Next.js (/product/{slug}), jamais l'URL WordPress native
            // (api.miadmarket.com) — le client ne doit jamais atterrir sur le backend.
            'url'          => ( defined('MIAD_SITE_URL') ? MIAD_SITE_URL : 'https://www.miadmarket.com' ) . '/product/' . $product->get_slug(),
        ];
    }

    update_user_meta( $user_id, '_miad_saved_cart', [
        'items'   => $items,
        'total'   => (float) $cart->get_cart_contents_total(),
        'saved'   => current_time( 'c' ),
        'token'   => wp_generate_password( 32, false ),
        'sent'    => 0,
    ] );
}

// Supprimer le panier sauvegardé quand la commande est passée
add_action( 'woocommerce_checkout_order_processed', function ( $order_id ) {
    $order = wc_get_order( $order_id );
    if ( $order ) delete_user_meta( $order->get_user_id(), '_miad_saved_cart' );
} );

/* ═══════════════════════════════════════════════════════════════════
   2. CRON — Vérifie les paniers abandonnés toutes les heures
═══════════════════════════════════════════════════════════════════ */

add_action( 'init', function () {
    if ( ! wp_next_scheduled( 'miad_check_abandoned_carts' ) ) {
        wp_schedule_event( time(), 'hourly', 'miad_check_abandoned_carts' );
    }
} );

add_action( 'miad_check_abandoned_carts', 'miad_process_abandoned_carts' );

function miad_process_abandoned_carts(): void {
    // Trouver les utilisateurs avec un panier sauvegardé non envoyé depuis + d'1h
    global $wpdb;
    $threshold = date( 'c', strtotime( '-1 hour' ) );

    $users = $wpdb->get_col(
        "SELECT user_id FROM {$wpdb->usermeta}
         WHERE meta_key = '_miad_saved_cart'
         LIMIT 50"
    );

    foreach ( $users as $user_id ) {
        $data = get_user_meta( (int) $user_id, '_miad_saved_cart', true );
        if ( ! is_array( $data ) || ! empty( $data['sent'] ) ) continue;
        if ( empty( $data['items'] ) ) continue;
        if ( $data['saved'] > $threshold ) continue; // Trop récent

        miad_send_cart_recovery_email( (int) $user_id, $data );

        // Marquer comme envoyé
        $data['sent'] = 1;
        update_user_meta( (int) $user_id, '_miad_saved_cart', $data );
    }
}

/* ═══════════════════════════════════════════════════════════════════
   3. EMAIL DE RÉCUPÉRATION DE PANIER
═══════════════════════════════════════════════════════════════════ */

function miad_send_cart_recovery_email( int $user_id, array $cart_data ): void {
    $user = get_userdata( $user_id );
    if ( ! $user ) return;

    $name      = $user->display_name;
    $total     = array_sum( array_map( fn($i) => $i['price'] * $i['quantity'], $cart_data['items'] ) );
    $total_fmt = wc_price( $total );
    $token     = $cart_data['token'];
    // Toujours le frontend Next.js (www), jamais wc_get_checkout_url() qui
    // pointe vers api.miadmarket.com — voir le commentaire détaillé sur la
    // section 4 plus bas. /api/cart-restore reconstruit le panier côté
    // Next.js puis redirige vers /?cart=<id>, page que le client voit
    // vraiment (contrairement à une page WordPress backend).
    $site_url  = defined('MIAD_SITE_URL') ? MIAD_SITE_URL : 'https://www.miadmarket.com';
    $restore   = add_query_arg( [ 'token' => $token, 'uid' => $user_id ], rtrim( $site_url, '/' ) . '/api/cart-restore' );

    // Construire le tableau des produits abandonnés.
    // IMPORTANT : `display:flex` sur un <td> (ancienne version) n'est pas
    // fiable dans les clients email — Outlook (moteur Word) l'ignore
    // complètement et Gmail le supporte de façon inconsistante, ce qui
    // cassait l'alignement image + nom du produit. Remplacé par le pattern
    // "bulletproof" standard email : une table imbriquée avec
    // valign="middle", supportée partout.
    $items_html = '';
    foreach ( $cart_data['items'] as $item ) {
        $items_html .= sprintf(
            '<tr>
              <td style="padding:12px;border-bottom:1px solid #f0f0f0">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td valign="middle" style="width:52px">
                      <img src="%s" width="52" height="52" style="display:block;width:52px;height:52px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb" alt="">
                    </td>
                    <td valign="middle" style="padding-left:10px">
                      <strong style="font-size:.9rem">%s</strong>
                    </td>
                  </tr>
                </table>
              </td>
              <td style="padding:12px;border-bottom:1px solid #f0f0f0;font-size:.9rem">%d</td>
              <td style="padding:12px;border-bottom:1px solid #f0f0f0;font-size:.9rem;font-weight:700;color:#005826">%s</td>
            </tr>',
            esc_url( $item['image'] ),
            esc_html( $item['name'] ),
            $item['quantity'],
            wc_price( $item['price'] * $item['quantity'] )
        );
    }

    $body = "
        <h2>Vous avez oublié quelque chose, {$name} ! 🛒</h2>
        <p>Vous avez laissé des produits dans votre panier MIAD Market. Ils vous attendent encore !</p>

        <table style='width:100%;border-collapse:collapse;margin:20px 0;border-radius:8px;overflow:hidden'>
          <thead>
            <tr>
              <th style='background:#f9fafb;padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;border-bottom:2px solid #F5A623'>Produit</th>
              <th style='background:#f9fafb;padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;border-bottom:2px solid #F5A623'>Qté</th>
              <th style='background:#f9fafb;padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;border-bottom:2px solid #F5A623'>Prix</th>
            </tr>
          </thead>
          <tbody>{$items_html}</tbody>
          <tfoot>
            <tr>
              <th colspan='2' style='text-align:right;padding:14px 12px;color:#6b7280'>Total</th>
              <td style='padding:14px 12px;font-weight:900;font-size:1.1rem;color:#005826'>{$total_fmt}</td>
            </tr>
          </tfoot>
        </table>

        <div style='text-align:center;margin:28px 0'>
          <a href='" . esc_url( $restore ) . "'
             style='display:inline-block;background:#F5A623;color:#111;font-weight:900;padding:16px 36px;border-radius:50px;text-decoration:none;font-size:.9rem;text-transform:uppercase;letter-spacing:.06em;box-shadow:0 4px 12px rgba(245,166,35,.4)'>
            🛒 Récupérer mon panier
          </a>
        </div>
        <p style='text-align:center;color:#9ca3af;font-size:.8rem'>
          Ce lien restaure automatiquement votre panier et vous amène au paiement.
        </p>";

    $subject = "🛒 {$name}, votre panier MIAD Market vous attend ({$total_fmt})";

    if ( function_exists( 'miad_send_professional_email' ) ) {
        miad_send_professional_email( $user->user_email, $subject, $body );
    } else {
        wp_mail( $user->user_email, $subject, $body, [ 'Content-Type: text/html; charset=UTF-8' ] );
    }
}

/* ═══════════════════════════════════════════════════════════════════
   4. RESTAURATION DU PANIER — via le lien de l'email
   ---------------------------------------------------------------------
   L'ancienne version restaurait dans WC()->cart (session PHP native) puis
   redirigeait vers wc_get_checkout_url() — deux bugs pour un site headless :
   1) wc_get_checkout_url() pointe vers api.miadmarket.com (le backend
      WordPress), jamais vers www.miadmarket.com (le frontend Next.js) que
      le client doit voir — même règle déjà appliquée pour les liens produit
      (cf. miad_save_cart() plus haut : 'url' utilise MIAD_SITE_URL).
   2) Le panier réel du client vit côté Next.js (localStorage / le
      mécanisme de partage de panier /api/cart-share), pas dans la session
      PHP WooCommerce — même si l'URL pointait au bon endroit, le frontend
      n'aurait jamais lu WC()->cart.
   Remplacé par un simple endpoint REST en lecture seule qui renvoie les
   articles bruts (product_id/variation_id/quantity) : c'est Next.js
   (app/api/cart-restore/route.ts) qui récupère les vrais produits et
   reconstruit le panier via /api/cart-share, exactement comme le partage
   de panier entre appareils.
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad/v1', '/saved-cart-items', [
        'methods'             => 'GET',
        'callback'            => function ( WP_REST_Request $request ) {
            $token   = sanitize_text_field( (string) $request->get_param( 'token' ) );
            $user_id = (int) $request->get_param( 'uid' );

            if ( ! $token || ! $user_id ) {
                return new WP_Error( 'missing_params', 'token et uid requis.', [ 'status' => 400 ] );
            }

            $data = get_user_meta( $user_id, '_miad_saved_cart', true );
            if ( ! is_array( $data ) || empty( $data['token'] ) || ! hash_equals( $data['token'], $token ) ) {
                return new WP_Error( 'invalid_token', 'Lien de panier invalide ou expiré.', [ 'status' => 404 ] );
            }
            if ( empty( $data['items'] ) ) {
                return new WP_REST_Response( [ 'success' => true, 'items' => [] ], 200 );
            }

            $items = array_map( function ( $item ) {
                return [
                    'product_id'   => (int) $item['product_id'],
                    'variation_id' => (int) ( $item['variation_id'] ?? 0 ),
                    'quantity'     => (int) $item['quantity'],
                ];
            }, $data['items'] );

            return new WP_REST_Response( [ 'success' => true, 'items' => $items ], 200 );
        },
        // Secret partagé uniquement — le token du panier fait déjà office
        // d'autorisation, mais on garde la même barrière que le reste des
        // endpoints internes plutôt que de rendre cette route publique.
        // Vérification en ligne (pas d'appel à une fonction d'un autre
        // snippet) pour que ce fichier reste autonome.
        'permission_callback' => function ( WP_REST_Request $request ) {
            $header_secret   = $request->get_header( 'X-Headless-Secret' );
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( $header_secret && $internal_secret && $header_secret === $internal_secret ) {
                return true;
            }
            return new WP_Error( 'rest_forbidden', 'Accès non autorisé.', [ 'status' => 403 ] );
        },
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   5. CORRECTION EMAIL COMMANDE — récupérer les vrais prix
   (Corrige le bug $0.00 dans les emails de commande pending)
═══════════════════════════════════════════════════════════════════ */

add_filter( 'woocommerce_email_order_items_args', function ( array $args ): array {
    // Force l'affichage des prix même pour les commandes pending
    // IMPORTANT : ne pas toucher à show_image ici — miad-wc-custom-emails.php le force
    // à false pour TOUS les emails (URLs R2/AVIF non supportées par Gmail). Le réactiver
    // ici l'aurait réintroduit globalement, pas seulement pour ce correctif de prix.
    $args['show_sku']          = true;
    $args['plain_text']        = false;
    $args['sent_to_admin']     = false;
    return $args;
} );

// S'assure que les items ont bien leur prix au moment de l'envoi
add_action( 'woocommerce_order_status_pending', function ( int $order_id ) {
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;

    // Recalculer les totaux si $0
    if ( (float) $order->get_total() === 0.0 && $order->get_item_count() > 0 ) {
        $order->calculate_totals();
        $order->save();
    }
}, 5 );

/* ═══════════════════════════════════════════════════════════════════
   6. REST API — stats paniers abandonnés (admin)
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad/v1', '/abandoned-carts', [
        'methods'             => 'GET',
        'callback'            => function () {
            global $wpdb;
            $rows = $wpdb->get_results(
                "SELECT user_id, meta_value FROM {$wpdb->usermeta}
                 WHERE meta_key = '_miad_saved_cart' LIMIT 50"
            );
            $result = [];
            foreach ( $rows as $row ) {
                $data = maybe_unserialize( $row->meta_value );
                if ( ! is_array( $data ) || empty( $data['items'] ) ) continue;
                $user  = get_userdata( $row->user_id );
                $total = array_sum( array_map( fn($i) => $i['price'] * $i['quantity'], $data['items'] ) );
                $result[] = [
                    'user'     => $user ? $user->display_name : 'Inconnu',
                    'email'    => $user ? $user->user_email : '',
                    'items'    => count( $data['items'] ),
                    'total'    => round( $total, 2 ),
                    'saved_at' => $data['saved'] ?? '',
                    'sent'     => ! empty( $data['sent'] ),
                ];
            }
            return rest_ensure_response( $result );
        },
        'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ),
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   7. PAGE ADMIN — Paniers abandonnés dans le dashboard
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_submenu_page(
        'woocommerce',
        'Paniers abandonnés',
        '🛒 Paniers abandonnés',
        'manage_woocommerce',
        'miad-abandoned-carts',
        function () {
            global $wpdb;

            // Relance manuelle
            if ( isset( $_POST['miad_force_send'] ) && check_admin_referer( 'miad_force_send' ) ) {
                $uid  = (int) $_POST['force_uid'];
                $data = get_user_meta( $uid, '_miad_saved_cart', true );
                if ( is_array( $data ) && ! empty( $data['items'] ) ) {
                    miad_send_cart_recovery_email( $uid, $data );
                    $data['sent'] = 1;
                    update_user_meta( $uid, '_miad_saved_cart', $data );
                    echo '<div class="notice notice-success"><p>✅ Email de récupération envoyé.</p></div>';
                }
            }

            $rows = $wpdb->get_results(
                "SELECT user_id, meta_value FROM {$wpdb->usermeta}
                 WHERE meta_key = '_miad_saved_cart' ORDER BY umeta_id DESC LIMIT 100"
            );
            ?>
            <div class="wrap" style="max-width:1000px">
                <h1>🛒 Paniers abandonnés</h1>
                <p style="color:#6b7280">Ces utilisateurs ont ajouté des produits sans finaliser leur commande.</p>

                <table class="wp-list-table widefat fixed striped" style="margin-top:16px">
                    <thead>
                        <tr>
                            <th>Utilisateur</th><th>Email</th><th>Produits</th>
                            <th>Total</th><th>Date</th><th>Email envoyé</th><th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                    <?php foreach ( $rows as $row ):
                        $data = maybe_unserialize( $row->meta_value );
                        if ( ! is_array( $data ) || empty( $data['items'] ) ) continue;
                        $user  = get_userdata( $row->user_id );
                        $total = array_sum( array_map( fn($i) => $i['price'] * $i['quantity'], $data['items'] ) );
                        $sent  = ! empty( $data['sent'] );
                    ?>
                    <tr>
                        <td><strong><?= esc_html( $user ? $user->display_name : 'Inconnu' ) ?></strong></td>
                        <td style="color:#6b7280"><?= esc_html( $user ? $user->user_email : '' ) ?></td>
                        <td>
                            <?php foreach ( $data['items'] as $item ): ?>
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                                <?php if ( $item['image'] ): ?>
                                <img src="<?= esc_url($item['image']) ?>" style="width:28px;height:28px;border-radius:4px;object-fit:cover">
                                <?php endif; ?>
                                <span style="font-size:.8rem"><?= esc_html($item['name']) ?> × <?= $item['quantity'] ?></span>
                            </div>
                            <?php endforeach; ?>
                        </td>
                        <td><strong style="color:#005826"><?= wc_price($total) ?></strong></td>
                        <td style="color:#9ca3af;font-size:.8rem">
                            <?= $data['saved'] ? date( 'd/m/Y H:i', strtotime($data['saved']) ) : '—' ?>
                        </td>
                        <td>
                            <?= $sent
                                ? '<span style="color:#059669;font-weight:700">✓ Envoyé</span>'
                                : '<span style="color:#dc2626">✗ Non envoyé</span>' ?>
                        </td>
                        <td>
                            <form method="post" style="display:inline">
                                <?php wp_nonce_field('miad_force_send'); ?>
                                <input type="hidden" name="force_uid" value="<?= $row->user_id ?>">
                                <button type="submit" name="miad_force_send" class="button button-small">
                                    📨 <?= $sent ? 'Re-envoyer' : 'Envoyer maintenant' ?>
                                </button>
                            </form>
                        </td>
                    </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            </div>
            <?php
        }
    );
} );
