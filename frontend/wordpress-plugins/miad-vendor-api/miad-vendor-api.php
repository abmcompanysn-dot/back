<?php
/**
 * Plugin Name:  MIAD Vendor API
 * Plugin URI:   https://miadmarket.com
 * Description:  Endpoint REST /wp-json/miad/v1/vendor/* pour le dashboard vendeur headless (produits, commandes, stats — accès direct DB, aucun appel REST interne).
 * Version:      1.1.0
 * Author:       MIAD Market
 * Requires PHP: 7.4
 * PHP tested up to: 8.3
 * Requires at least: 5.9
 * WC requires at least: 5.0
 * WC tested up to: 9.0
 * License: proprietary
 */

defined('ABSPATH') || exit;

/* ══════════════════════════════════════════════════════════════════════════════
   HPOS (High-Performance Order Storage) compatibility declaration
   ══════════════════════════════════════════════════════════════════════════════ */
add_action('before_woocommerce_init', function () {
    if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
            'custom_order_tables', __FILE__, true
        );
    }
});

/* ══════════════════════════════════════════════════════════════════════════════
   Enregistrement des routes REST
   ══════════════════════════════════════════════════════════════════════════════ */
add_action('rest_api_init', function () {
    $ns = 'miad/v1';

    /* Dashboard complet (identité + stats + produits + commandes récentes) */
    register_rest_route($ns, '/vendor/dashboard', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'miad_endpoint_dashboard',
        'permission_callback' => 'miad_check_vendor_permission',
    ]);

    /* Liste paginée des produits du vendeur */
    register_rest_route($ns, '/vendor/products', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'miad_endpoint_products',
        'permission_callback' => 'miad_check_vendor_permission',
        'args'                => [
            'per_page' => ['default' => 20, 'sanitize_callback' => 'absint'],
            'page'     => ['default' => 1,  'sanitize_callback' => 'absint'],
            'status'   => ['default' => 'publish', 'sanitize_callback' => 'sanitize_text_field'],
        ],
    ]);

    /* Liste paginée des commandes du vendeur (filtrées par produits) */
    register_rest_route($ns, '/vendor/orders', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'miad_endpoint_orders',
        'permission_callback' => 'miad_check_vendor_permission',
        'args'                => [
            'per_page' => ['default' => 20,   'sanitize_callback' => 'absint'],
            'page'     => ['default' => 1,     'sanitize_callback' => 'absint'],
            'status'   => ['default' => 'any', 'sanitize_callback' => 'sanitize_text_field'],
        ],
    ]);

    /* Identité seule (endpoint léger) */
    register_rest_route($ns, '/vendor/me', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'miad_endpoint_me',
        'permission_callback' => 'miad_check_vendor_permission',
    ]);
});

/* ══════════════════════════════════════════════════════════════════════════════
   Permission : utilisateur connecté + rôle vendeur
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_check_vendor_permission() {
    $user_id = get_current_user_id();
    if (!$user_id) {
        return new WP_Error('miad_unauthorized', 'Non autorisé — token JWT manquant ou invalide.', ['status' => 401]);
    }
    $user = get_userdata($user_id);

    /* 1. Dokan natif (méthode officielle) */
    if (function_exists('dokan_is_user_seller') && dokan_is_user_seller($user_id)) {
        return true;
    }

    /* 2. Rôles WordPress connus pour les vendeurs */
    $vendor_roles = ['seller', 'vendor', 'dokan_seller', 'dokan_vendor', 'wcfm_vendor', 'shop_manager', 'administrator'];
    if (!empty(array_intersect($vendor_roles, (array) $user->roles))) {
        return true;
    }

    /* 3. Meta Dokan (au cas où le rôle n'est pas synchronisé) */
    $dokan_enable_selling = get_user_meta($user_id, 'dokan_enable_selling', true);
    if ($dokan_enable_selling === 'yes') {
        return true;
    }

    return new WP_Error('miad_forbidden', 'Accès réservé aux vendeurs. Rôles: ' . implode(', ', (array) $user->roles), ['status' => 403]);
}

/* ══════════════════════════════════════════════════════════════════════════════
   /miad/v1/vendor/me — identité uniquement
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_endpoint_me(): WP_REST_Response {
    $user_id = get_current_user_id();
    $user    = get_userdata($user_id);
    return rest_ensure_response(miad_build_vendor_identity($user_id, $user));
}

/* ══════════════════════════════════════════════════════════════════════════════
   /miad/v1/vendor/dashboard — payload complet
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_endpoint_dashboard(WP_REST_Request $request): WP_REST_Response {
    $user_id  = get_current_user_id();
    $user     = get_userdata($user_id);
    $identity = miad_build_vendor_identity($user_id, $user);

    /* Produits (max 100) */
    $products   = miad_get_vendor_products($user_id, 100, 1, 'publish');
    $product_ids = array_column($products, 'id_int'); // entiers internes

    /* Commandes récentes (50 dernières) */
    $all_orders   = miad_get_vendor_orders($user_id, $product_ids, 50, 1, 'any');
    $recent_orders = array_slice($all_orders['orders'], 0, 10);

    /* Stats */
    $dokan_stats = miad_get_dokan_stats($user_id);
    $stats       = $dokan_stats ?: miad_calculate_stats($all_orders['orders'], count($products));

    /* Nettoyage : supprimer la clé interne id_int avant de renvoyer */
    $products_clean = array_map(function ($p) {
        unset($p['id_int']);
        return $p;
    }, $products);

    return rest_ensure_response(array_merge(
        [
            'userId'  => $user_id,
            'vendor'  => $identity,
        ],
        $stats,
        [
            'products'     => $products_clean,
            'recentOrders' => $recent_orders,
            'ordersTotal'  => $all_orders['total'],
        ]
    ));
}

/* ══════════════════════════════════════════════════════════════════════════════
   /miad/v1/vendor/products
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_endpoint_products(WP_REST_Request $request): WP_REST_Response {
    $user_id  = get_current_user_id();
    $per_page = (int) $request->get_param('per_page');
    $page     = (int) $request->get_param('page');
    $status   = $request->get_param('status');

    $raw      = miad_get_vendor_products($user_id, min($per_page, 100), $page, $status);
    $products = array_map(function ($p) { unset($p['id_int']); return $p; }, $raw);

    return rest_ensure_response([
        'products' => $products,
        'total'    => count($products),
        'userId'   => $user_id,
    ]);
}

/* ══════════════════════════════════════════════════════════════════════════════
   /miad/v1/vendor/orders
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_endpoint_orders(WP_REST_Request $request): WP_REST_Response {
    $user_id  = get_current_user_id();
    $per_page = (int) $request->get_param('per_page');
    $page     = (int) $request->get_param('page');
    $status   = $request->get_param('status');

    /* Récupérer les IDs des produits du vendeur (IDs seulement, rapide) */
    $product_ids = miad_get_vendor_product_ids($user_id);

    $result = miad_get_vendor_orders($user_id, $product_ids, min($per_page, 100), $page, $status);

    return rest_ensure_response([
        'orders' => $result['orders'],
        'total'  => $result['total'],
    ]);
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS — Identité vendeur
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_build_vendor_identity(int $user_id, WP_User $user): array {
    $identity = [
        'id'     => $user_id,
        'name'   => $user->display_name ?: $user->user_login,
        'slug'   => $user->user_login,
        'email'  => $user->user_email,
        'avatar' => get_avatar_url($user_id, ['size' => 96]),
        'roles'  => (array) $user->roles,
    ];

    /* Infos boutique Dokan (si disponible) */
    if (function_exists('dokan_get_vendor')) {
        $vendor = dokan_get_vendor($user_id);
        if ($vendor && method_exists($vendor, 'get_shop_name')) {
            $store = $vendor->get_shop_info();
            $identity['shop_name']   = $vendor->get_shop_name() ?: $user->display_name;
            $identity['shop_url']    = $vendor->get_shop_url();
            $identity['shop_banner'] = method_exists($vendor, 'get_banner') ? $vendor->get_banner() : '';
            $identity['gravatar']    = method_exists($vendor, 'get_avatar') ? $vendor->get_avatar() : get_avatar_url($user_id, ['size' => 96]);
            $identity['phone']       = $store['phone']   ?? '';
            $identity['address']     = $store['address'] ?? [];
            if (method_exists($vendor, 'get_rating')) {
                $rating = $vendor->get_rating();
                $identity['rating'] = ['rating' => $rating['rating'] ?? 0, 'count' => $rating['count'] ?? 0];
            }
        }
    }

    /* Fallback : meta boutique générique (Dokan / WC Vendors style) */
    if (empty($identity['shop_name'])) {
        $identity['shop_name'] = get_user_meta($user_id, 'dokan_profile_settings', true)['store_name']
            ?? get_user_meta($user_id, '_wcv_vendor_shop_name', true)
            ?? $user->display_name;
    }

    return $identity;
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS — IDs des produits du vendeur (requête légère)
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_get_vendor_product_ids(int $user_id): array {
    global $wpdb;
    return array_map('intval', $wpdb->get_col($wpdb->prepare(
        "SELECT ID FROM {$wpdb->posts}
         WHERE post_type = 'product' AND post_status = 'publish' AND post_author = %d",
        $user_id
    )));
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS — Produits du vendeur (format dashboard)
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_get_vendor_products(int $user_id, int $limit = 100, int $page = 1, string $status = 'publish'): array {
    $statuses = $status === 'any' ? ['publish', 'draft', 'pending', 'private'] : [$status];

    $args = [
        'post_type'      => 'product',
        'post_status'    => $statuses,
        'posts_per_page' => $limit,
        'paged'          => $page,
        'author'         => $user_id,
        'orderby'        => 'date',
        'order'          => 'DESC',
        'fields'         => 'ids',
    ];
    $query = new WP_Query($args);
    $user  = get_userdata($user_id);

    $products = [];
    foreach ($query->posts as $post_id) {
        $product = wc_get_product($post_id);
        if (!$product) continue;

        /* Image principale */
        $image_id  = $product->get_image_id();
        $image_url = $image_id ? (string) wp_get_attachment_image_url($image_id, 'woocommerce_single') : '';

        /* Galerie */
        $gallery = [];
        foreach ($product->get_gallery_image_ids() as $gid) {
            $url = wp_get_attachment_image_url($gid, 'woocommerce_single');
            if ($url) $gallery[] = (string) $url;
        }

        /* Catégories */
        $term_list = get_the_terms($post_id, 'product_cat');
        $cats      = [];
        if ($term_list && !is_wp_error($term_list)) {
            foreach ($term_list as $t) $cats[] = ['name' => $t->name, 'slug' => $t->slug];
        }

        /* Attributs */
        $attributes = [];
        foreach ($product->get_attributes() as $attr) {
            $attributes[] = [
                'id'      => $attr->get_id(),
                'name'    => wc_attribute_label($attr->get_name()),
                'options' => $attr->is_taxonomy()
                    ? wp_get_post_terms($post_id, $attr->get_name(), ['fields' => 'names'])
                    : $attr->get_options(),
                'visible' => $attr->get_visible(),
            ];
        }

        $products[] = [
            'id_int'           => (int) $post_id,               // clé interne pour les requêtes SQL
            'id'               => (string) $post_id,
            'name'             => $product->get_name(),
            'slug'             => get_post_field('post_name', $post_id),
            'price'            => (float) ($product->get_price() ?: 0),
            'regularPrice'     => (float) ($product->get_regular_price() ?: 0),
            'salePrice'        => $product->get_sale_price() !== '' ? (float) $product->get_sale_price() : null,
            'type'             => $product->get_type(),
            'image'            => $image_url,
            'images'           => $gallery,
            'category'         => !empty($cats) ? $cats[0]['name'] : '',
            'categorySlug'     => !empty($cats) ? $cats[0]['slug'] : '',
            'categories'       => $cats,
            'stock'            => $product->get_stock_quantity() ?? 0,
            'inStock'          => $product->is_in_stock(),
            'status'           => $product->get_status(),
            'description'      => $product->get_description(),
            'shortDescription' => $product->get_short_description(),
            'attributes'       => $attributes,
            'vendor'           => [
                'id'   => (string) $user_id,
                'name' => $user->display_name ?: $user->user_login,
                'slug' => $user->user_login,
            ],
            'currency'    => get_woocommerce_currency(),
            'lang'        => 'fr',
        ];
    }
    return $products;
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS — Commandes du vendeur (via DB directement)
   Utilise les tables HPOS si activées, sinon posts/postmeta classiques.
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_get_vendor_orders(int $user_id, array $product_ids, int $limit = 50, int $page = 1, string $status = 'any'): array {
    if (empty($product_ids)) return ['orders' => [], 'total' => 0];

    global $wpdb;

    /* Trouver les order_ids contenant au moins un produit du vendeur */
    $ids_placeholder = implode(',', array_fill(0, count($product_ids), '%d'));

    /* Compatible HPOS + legacy posts */
    $hpos_enabled = miad_is_hpos_enabled();

    if ($hpos_enabled) {
        $order_items_table    = $wpdb->prefix . 'woocommerce_order_items';
        $order_itemmeta_table = $wpdb->prefix . 'woocommerce_order_itemmeta';
    } else {
        $order_items_table    = $wpdb->prefix . 'woocommerce_order_items';
        $order_itemmeta_table = $wpdb->prefix . 'woocommerce_order_itemmeta';
    }

    $query = $wpdb->prepare(
        "SELECT DISTINCT oi.order_id
         FROM {$order_items_table} AS oi
         INNER JOIN {$order_itemmeta_table} AS oim ON oi.order_item_id = oim.order_item_id
         WHERE oi.order_item_type = 'line_item'
           AND oim.meta_key = '_product_id'
           AND CAST(oim.meta_value AS UNSIGNED) IN ({$ids_placeholder})
         ORDER BY oi.order_id DESC",
        ...$product_ids
    );

    $all_ids = $wpdb->get_col($query);
    $total   = count($all_ids);

    if ($total === 0) return ['orders' => [], 'total' => 0];

    /* Pagination */
    $offset   = ($page - 1) * $limit;
    $page_ids = array_slice($all_ids, $offset, $limit);

    $orders = [];
    foreach ($page_ids as $order_id) {
        $order = wc_get_order((int) $order_id);
        if (!$order) continue;

        /* Filtrer le statut si demandé */
        if ($status !== 'any') {
            $order_status = str_replace('wc-', '', $order->get_status());
            if ($order_status !== $status && 'wc-' . $order_status !== $status) continue;
        }

        /* Items : garder uniquement les produits du vendeur */
        $items = [];
        foreach ($order->get_items() as $item) {
            $prod_id = (int) $item->get_product_id();
            if (!in_array($prod_id, $product_ids, true)) continue;

            $item_image = '';
            $item_prod  = $item->get_product();
            if ($item_prod) {
                $img_id    = $item_prod->get_image_id();
                $item_image = $img_id ? (string) wp_get_attachment_image_url($img_id, 'thumbnail') : '';
            }

            $items[] = [
                'product_id' => $prod_id,
                'name'       => $item->get_name(),
                'quantity'   => $item->get_quantity(),
                'subtotal'   => (float) $item->get_subtotal(),
                'image'      => $item_image,
            ];
        }

        $billing  = $order->get_address('billing');
        $shipping = $order->get_address('shipping');
        $created  = $order->get_date_created();

        $orders[] = [
            'id'               => $order->get_id(),
            'number'           => $order->get_order_number(),
            'status'           => str_replace('wc-', '', $order->get_status()),
            'date'             => $created ? $created->format('c') : '',
            'total'            => (float) $order->get_total(),
            'currency'         => $order->get_currency(),
            'customer_name'    => trim(($billing['first_name'] ?? '') . ' ' . ($billing['last_name'] ?? '')) ?: 'Client',
            'customer_email'   => $billing['email'] ?? '',
            'customer_phone'   => $billing['phone'] ?? '',
            'shipping_country' => ($shipping['country'] ?? '') ?: ($billing['country'] ?? ''),
            'shipping_method'  => $order->get_shipping_method(),
            'payment_method'   => $order->get_payment_method_title(),
            'items'            => $items,
        ];
    }

    return ['orders' => $orders, 'total' => $total];
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS — Stats Dokan (si plugin actif)
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_get_dokan_stats(int $user_id): ?array {
    if (!function_exists('dokan_get_vendor')) return null;

    $vendor = dokan_get_vendor($user_id);
    if (!$vendor) return null;

    /* Dokan expose get_order_stats() sur l'objet vendor */
    $order_data = method_exists($vendor, 'get_order_count') ? $vendor->get_order_count() : null;
    $sales      = [];
    if (function_exists('dokan_get_seller_info')) {
        $info  = dokan_get_seller_info($user_id);
        $sales = $info['info']['sales'] ?? [];
    }

    return [
        'revenue'            => isset($sales['this_month']) ? number_format((float) $sales['this_month'], 2, '.', '') : null,
        'revenue_last_month' => isset($sales['last_month'])  ? number_format((float) $sales['last_month'],  2, '.', '') : '0.00',
        'orders_total'       => $order_data['total']      ?? null,
        'orders_pending'     => $order_data['pending']    ?? 0,
        'orders_processing'  => $order_data['processing'] ?? 0,
        'orders_completed'   => $order_data['completed']  ?? 0,
        'orders_cancelled'   => $order_data['cancelled']  ?? 0,
        'products_total'     => null,
        'products_published' => null,
        'reviews_count'      => method_exists($vendor, 'get_rating') ? ($vendor->get_rating()['count'] ?? 0) : 0,
    ];
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS — Stats calculées depuis les commandes
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_calculate_stats(array $orders, int $products_count): array {
    $by_status = [];
    foreach ($orders as $o) {
        $s = $o['status'];
        $by_status[$s] = ($by_status[$s] ?? 0) + 1;
    }

    $revenue = array_reduce(
        array_filter($orders, fn ($o) => in_array($o['status'], ['completed', 'processing', 'on-hold'], true)),
        fn ($carry, $o) => $carry + $o['total'],
        0.0
    );

    return [
        'revenue'            => number_format($revenue, 2, '.', ''),
        'revenue_last_month' => '0.00',
        'orders_total'       => count($orders),
        'orders_pending'     => $by_status['pending']    ?? 0,
        'orders_processing'  => $by_status['processing'] ?? 0,
        'orders_completed'   => $by_status['completed']  ?? 0,
        'orders_cancelled'   => $by_status['cancelled']  ?? 0,
        'products_total'     => $products_count,
        'products_published' => $products_count,
        'reviews_count'      => 0,
    ];
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS — Détection HPOS
   ══════════════════════════════════════════════════════════════════════════════ */
function miad_is_hpos_enabled(): bool {
    if (!class_exists('\Automattic\WooCommerce\Utilities\OrderUtil')) return false;
    return method_exists('\Automattic\WooCommerce\Utilities\OrderUtil', 'custom_orders_table_usage_is_enabled')
        && \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
}
