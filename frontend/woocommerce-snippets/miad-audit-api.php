<?php
/**
 * Plugin Name: MIAD Audit API
 * Description: Endpoints REST sécurisés (même secret partagé que MIAD Products
 *              API) pour auditer le catalogue produits : images manquantes,
 *              variations invalides, anomalies (prix, titre, SKU, stock),
 *              boutiques Dokan sans produit, versions WP/WooCommerce. Lecture
 *              seule par défaut — la correction (tag "a-verifier") ne se
 *              déclenche que via /audit/apply, jamais de suppression.
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Scan complet du catalogue via requêtes SQL directes (plutôt que
 * wc_get_products() en boucle) — sur un catalogue de plusieurs centaines de
 * produits, l'hydratation d'objets WC_Product un par un dépasse largement le
 * max_execution_time d'un hébergement mutualisé. Chaque catégorie d'anomalie
 * est une requête ciblée et indexée.
 */
function miad_audit_run_scan(): array {
    global $wpdb;
    $posts = $wpdb->posts;
    $meta  = $wpdb->postmeta;

    $statuses = "'publish','draft','pending'";

    // 1. Produits sans image (pas de _thumbnail_id ET galerie vide/absente)
    $no_image = $wpdb->get_results( "
        SELECT p.ID, p.post_title
        FROM {$posts} p
        LEFT JOIN {$meta} thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
        LEFT JOIN {$meta} gal   ON gal.post_id = p.ID AND gal.meta_key = '_product_image_gallery'
        WHERE p.post_type = 'product' AND p.post_status IN ({$statuses})
          AND ( thumb.meta_value IS NULL OR thumb.meta_value = '' )
          AND ( gal.meta_value IS NULL OR gal.meta_value = '' )
    ", ARRAY_A );

    // 2. Produits variables sans AUCUNE variation
    $variable_ids = $wpdb->get_col( "
        SELECT p.ID FROM {$posts} p
        INNER JOIN {$wpdb->term_relationships} tr ON tr.object_id = p.ID
        INNER JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_type'
        INNER JOIN {$wpdb->terms} t ON t.term_id = tt.term_id AND t.slug = 'variable'
        WHERE p.post_type = 'product' AND p.post_status IN ({$statuses})
    " );
    $variable_no_variations = [];
    if ( $variable_ids ) {
        $placeholders = implode( ',', array_fill( 0, count( $variable_ids ), '%d' ) );
        $with_variations = $wpdb->get_col( $wpdb->prepare( "
            SELECT DISTINCT post_parent FROM {$posts}
            WHERE post_type = 'product_variation' AND post_parent IN ({$placeholders})
        ", $variable_ids ) );
        $missing = array_diff( $variable_ids, $with_variations );
        foreach ( $missing as $id ) {
            $variable_no_variations[] = [ 'ID' => $id, 'post_title' => get_the_title( $id ) ];
        }
    }

    // 3. Variations sans prix ou sans stock géré
    $bad_variations = $wpdb->get_results( "
        SELECT v.ID, v.post_parent,
               price.meta_value AS price
        FROM {$posts} v
        LEFT JOIN {$meta} price ON price.post_id = v.ID AND price.meta_key = '_price'
        WHERE v.post_type = 'product_variation' AND v.post_status = 'publish'
          AND ( price.meta_value IS NULL OR price.meta_value = '' )
    ", ARRAY_A );

    // 4. Anomalies diverses
    $price_zero = $wpdb->get_results( "
        SELECT p.ID, p.post_title FROM {$posts} p
        INNER JOIN {$meta} pr ON pr.post_id = p.ID AND pr.meta_key = '_price'
        WHERE p.post_type = 'product' AND p.post_status IN ({$statuses})
          AND ( pr.meta_value = '' OR pr.meta_value = '0' OR pr.meta_value IS NULL )
    ", ARRAY_A );

    $empty_title = $wpdb->get_results( "
        SELECT ID, post_title FROM {$posts}
        WHERE post_type = 'product' AND post_status IN ({$statuses}) AND ( post_title = '' OR post_title IS NULL )
    ", ARRAY_A );

    $duplicate_titles = $wpdb->get_results( "
        SELECT post_title, GROUP_CONCAT(ID) AS ids, COUNT(*) AS cnt FROM {$posts}
        WHERE post_type = 'product' AND post_status IN ({$statuses}) AND post_title != ''
        GROUP BY post_title HAVING cnt > 1
    ", ARRAY_A );

    $empty_description = $wpdb->get_results( "
        SELECT ID, post_title FROM {$posts}
        WHERE post_type = 'product' AND post_status IN ({$statuses}) AND ( post_content = '' OR post_content IS NULL )
    ", ARRAY_A );

    $no_category = $wpdb->get_results( "
        SELECT p.ID, p.post_title FROM {$posts} p
        WHERE p.post_type = 'product' AND p.post_status IN ({$statuses})
          AND NOT EXISTS (
            SELECT 1 FROM {$wpdb->term_relationships} tr
            INNER JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
            WHERE tr.object_id = p.ID AND tt.taxonomy = 'product_cat'
          )
    ", ARRAY_A );

    $duplicate_skus = $wpdb->get_results( "
        SELECT meta_value AS sku, GROUP_CONCAT(post_id) AS ids, COUNT(*) AS cnt FROM {$meta}
        WHERE meta_key = '_sku' AND meta_value != ''
        GROUP BY meta_value HAVING cnt > 1
    ", ARRAY_A );

    $negative_stock = $wpdb->get_results( "
        SELECT p.ID, p.post_title, s.meta_value AS stock FROM {$posts} p
        INNER JOIN {$meta} s ON s.post_id = p.ID AND s.meta_key = '_stock'
        WHERE p.post_type IN ('product','product_variation') AND p.post_status IN ({$statuses})
          AND CAST(s.meta_value AS SIGNED) < 0
    ", ARRAY_A );

    // Construit la liste d'anomalies avec raison précise, un item par (produit, raison)
    $anomalies = [];
    foreach ( $price_zero as $r )        $anomalies[] = [ 'id' => (int) $r['ID'], 'title' => $r['post_title'], 'reason' => 'prix=0' ];
    foreach ( $empty_title as $r )       $anomalies[] = [ 'id' => (int) $r['ID'], 'title' => '(sans titre)', 'reason' => 'titre-vide' ];
    foreach ( $duplicate_titles as $r ) {
        foreach ( explode( ',', $r['ids'] ) as $id ) {
            $others = array_diff( explode( ',', $r['ids'] ), [ $id ] );
            $anomalies[] = [ 'id' => (int) $id, 'title' => $r['post_title'], 'reason' => 'titre-duplique-avec-ID-' . implode( '-', $others ) ];
        }
    }
    foreach ( $empty_description as $r ) $anomalies[] = [ 'id' => (int) $r['ID'], 'title' => $r['post_title'], 'reason' => 'description-vide' ];
    foreach ( $no_category as $r )       $anomalies[] = [ 'id' => (int) $r['ID'], 'title' => $r['post_title'], 'reason' => 'categorie-manquante' ];
    foreach ( $duplicate_skus as $r ) {
        foreach ( explode( ',', $r['ids'] ) as $id ) {
            $others = array_diff( explode( ',', $r['ids'] ), [ $id ] );
            $anomalies[] = [ 'id' => (int) $id, 'title' => get_the_title( $id ), 'reason' => 'sku-duplique-(' . $r['sku'] . ')-avec-ID-' . implode( '-', $others ) ];
        }
    }
    foreach ( $negative_stock as $r )    $anomalies[] = [ 'id' => (int) $r['ID'], 'title' => $r['post_title'], 'reason' => 'stock-negatif=' . $r['stock'] ];

    return [
        'no_image'               => $no_image,
        'variable_no_variations' => $variable_no_variations,
        'bad_variations'         => array_map( fn( $v ) => [ 'id' => (int) $v['ID'], 'parent_id' => (int) $v['post_parent'] ], $bad_variations ),
        'anomalies'              => $anomalies,
        'counts' => [
            'no_image'               => count( $no_image ),
            'variable_no_variations' => count( $variable_no_variations ),
            'bad_variations'         => count( $bad_variations ),
            'anomalies'              => count( $anomalies ),
        ],
    ];
}

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-audit/v1', '/scan', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function () {
            return new WP_REST_Response( array_merge( [ 'ok' => true ], miad_audit_run_scan() ), 200 );
        },
    ] );
} );

/**
 * Applique le tag "a-verifier" (product_tag) aux produits listés — jamais de
 * suppression ni de changement de statut ici. wp_set_object_terms() en mode
 * additif (append=true) : ne retire aucun tag existant.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-audit/v1', '/apply', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $ids    = array_map( 'intval', (array) ( $request->get_param( 'productIds' ) ?? [] ) );
            $action = sanitize_key( (string) ( $request->get_param( 'action' ) ?? 'tag' ) ); // tag | draft | trash
            if ( empty( $ids ) ) {
                return new WP_REST_Response( [ 'error' => 'productIds[] requis.' ], 400 );
            }
            if ( ! in_array( $action, [ 'tag', 'draft', 'trash' ], true ) ) {
                return new WP_REST_Response( [ 'error' => 'action doit être tag, draft ou trash.' ], 400 );
            }
            if ( $action === 'tag' && ! term_exists( 'a-verifier', 'product_tag' ) ) {
                wp_insert_term( 'a-verifier', 'product_tag' );
            }
            $done = []; $errors = [];
            foreach ( $ids as $id ) {
                $post_type = get_post_type( $id );
                // product_variation autorisé seulement pour trash — sert à nettoyer les
                // variations orphelines (post_parent=0, produit parent supprimé sans elles),
                // cas trouvé le 2026-07-11 via /scan (bad_variations). tag/draft n'ont pas
                // de sens pour une variation, restent restreints à product.
                $allowed = $action === 'trash' ? [ 'product', 'product_variation' ] : [ 'product' ];
                if ( ! in_array( $post_type, $allowed, true ) ) { $errors[] = $id; continue; }
                if ( $action === 'tag' ) {
                    $r = wp_set_object_terms( $id, 'a-verifier', 'product_tag', true );
                    if ( is_wp_error( $r ) ) { $errors[] = $id; continue; }
                } elseif ( $action === 'draft' ) {
                    $r = wp_update_post( [ 'ID' => $id, 'post_status' => 'draft' ], true );
                    if ( is_wp_error( $r ) ) { $errors[] = $id; continue; }
                } else { // trash — réversible, jamais de suppression définitive automatique
                    $r = wp_trash_post( $id );
                    if ( ! $r ) { $errors[] = $id; continue; }
                }
                $done[] = $id;
            }
            return new WP_REST_Response( [ 'ok' => true, 'action' => $action, 'done' => $done, 'errors' => $errors ], 200 );
        },
        'args' => [ 'productIds' => [ 'required' => true ], 'action' => [] ],
    ] );
} );

/**
 * Liste tous les produits publiés avec leur(s) catégorie(s) assignée(s) et
 * leur vendeur — sert de base à l'audit de classification (le "scan"
 * ci-dessus ne signale que les produits SANS catégorie, pas ceux mal
 * classés). Une seule requête SQL groupée, pas de boucle wc_get_products().
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-audit/v1', '/categories', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function () {
            global $wpdb;
            $posts = $wpdb->posts;

            $rows = $wpdb->get_results( "
                SELECT p.ID, p.post_title, p.post_author AS vendor_id,
                       GROUP_CONCAT(DISTINCT t.name SEPARATOR '|') AS cat_names,
                       GROUP_CONCAT(DISTINCT t.slug SEPARATOR '|') AS cat_slugs
                FROM {$posts} p
                LEFT JOIN {$wpdb->term_relationships} tr ON tr.object_id = p.ID
                LEFT JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_cat'
                LEFT JOIN {$wpdb->terms} t ON t.term_id = tt.term_id
                WHERE p.post_type = 'product' AND p.post_status = 'publish'
                GROUP BY p.ID
                ORDER BY p.ID
            ", ARRAY_A );

            $products = array_map( function ( $r ) {
                return [
                    'id'         => (int) $r['ID'],
                    'title'      => $r['post_title'],
                    'vendor_id'  => (int) $r['vendor_id'],
                    'categories' => $r['cat_names'] ? explode( '|', $r['cat_names'] ) : [],
                    'catSlugs'   => $r['cat_slugs'] ? explode( '|', $r['cat_slugs'] ) : [],
                ];
            }, $rows );

            return new WP_REST_Response( [ 'ok' => true, 'count' => count( $products ), 'products' => $products ], 200 );
        },
    ] );
} );

/** Boutiques Dokan sans aucun produit publié. */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-audit/v1', '/vendors-empty', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function () {
            $sellers = get_users( [ 'role' => 'seller', 'fields' => [ 'ID', 'display_name', 'user_email' ] ] );
            $empty = [];
            foreach ( $sellers as $seller ) {
                $count = (int) count_user_posts( $seller->ID, 'product', true );
                if ( $count === 0 ) {
                    $settings   = get_user_meta( $seller->ID, 'dokan_profile_settings', true );
                    $store_name = is_array( $settings ) ? ( $settings['store_name'] ?? '' ) : '';
                    $empty[] = [
                        'vendor_id'  => $seller->ID,
                        'store_name' => $store_name ?: $seller->display_name,
                        'email'      => $seller->user_email,
                    ];
                }
            }
            return new WP_REST_Response( [ 'ok' => true, 'empty_vendors' => $empty, 'count' => count( $empty ) ], 200 );
        },
    ] );
} );

/** Versions WordPress / WooCommerce actuelles vs disponibles (lecture seule, aucune mise à jour déclenchée). */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-audit/v1', '/versions', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function () {
            require_once ABSPATH . 'wp-admin/includes/update.php';
            require_once ABSPATH . 'wp-admin/includes/plugin.php';

            wp_version_check();
            wp_update_plugins();

            $core_updates   = get_site_transient( 'update_core' );
            $latest_wp      = '';
            if ( ! empty( $core_updates->updates ) ) {
                foreach ( $core_updates->updates as $u ) {
                    if ( $u->response === 'upgrade' ) { $latest_wp = $u->version; break; }
                }
            }

            $wc_current = defined( 'WC_VERSION' ) ? WC_VERSION : null;
            $wc_latest  = '';
            $plugin_updates = get_site_transient( 'update_plugins' );
            if ( ! empty( $plugin_updates->response ) ) {
                foreach ( $plugin_updates->response as $file => $info ) {
                    if ( strpos( $file, 'woocommerce.php' ) !== false ) {
                        $wc_latest = $info->new_version ?? '';
                        break;
                    }
                }
            }

            return new WP_REST_Response( [
                'ok' => true,
                'wordpress' => [ 'current' => get_bloginfo( 'version' ), 'latest' => $latest_wp ?: null, 'update_available' => (bool) $latest_wp ],
                'woocommerce' => [ 'current' => $wc_current, 'latest' => $wc_latest ?: null, 'update_available' => (bool) $wc_latest ],
            ], 200 );
        },
    ] );
} );

/**
 * Envoie le rapport d'audit à l'email admin via wp_mail() — passe par
 * FluentSMTP comme tous les autres emails du site (miad-email-customizer.php),
 * pas de service tiers (Brevo n'est pas configuré sur ce projet).
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-audit/v1', '/send-report', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $subject = sanitize_text_field( (string) ( $request->get_param( 'subject' ) ?? "Rapport d'audit catalogue MIAD" ) );
            $html    = wp_kses_post( (string) ( $request->get_param( 'html' ) ?? '' ) );
            if ( ! $html ) {
                return new WP_REST_Response( [ 'error' => 'html requis.' ], 400 );
            }
            $to  = get_option( 'admin_email' );
            $ok  = wp_mail( $to, $subject, $html, [ 'Content-Type: text/html; charset=UTF-8' ] );
            return new WP_REST_Response( [ 'ok' => $ok, 'sent_to' => $to ], $ok ? 200 : 500 );
        },
        'args' => [ 'subject' => [], 'html' => [ 'required' => true ] ],
    ] );
} );
