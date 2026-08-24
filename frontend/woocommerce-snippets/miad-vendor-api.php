<?php
/**
 * Plugin Name: MIAD Vendor API
 * Description: Endpoint REST sécurisé pour créer un compte vendeur Dokan
 *              (utilisateur WordPress + rôle seller + profil boutique) depuis
 *              scripts/miad.mjs, même principe et même secret partagé que
 *              MIAD Products API. Le nouveau vendeur reçoit l'email standard
 *              WordPress pour définir son mot de passe — jamais de mot de
 *              passe en clair renvoyé par l'API ou visible côté agent/CLI.
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/create-vendor', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            // Réutilise le même secret que MIAD Products API (même niveau de
            // confiance : appelé uniquement par scripts/miad.mjs en local).
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $store_name = sanitize_text_field( (string) $request->get_param( 'storeName' ) );
            $email      = sanitize_email( (string) $request->get_param( 'email' ) );
            $first_name = sanitize_text_field( (string) ( $request->get_param( 'firstName' ) ?? '' ) );
            $last_name  = sanitize_text_field( (string) ( $request->get_param( 'lastName' ) ?? '' ) );
            $country    = strtoupper( sanitize_text_field( (string) ( $request->get_param( 'country' ) ?? '' ) ) );
            $city       = sanitize_text_field( (string) ( $request->get_param( 'city' ) ?? '' ) );
            $phone      = sanitize_text_field( (string) ( $request->get_param( 'phone' ) ?? '' ) );

            if ( ! $store_name || ! is_email( $email ) ) {
                return new WP_REST_Response( [ 'error' => 'storeName et email (valide) requis.' ], 400 );
            }
            if ( email_exists( $email ) ) {
                return new WP_REST_Response( [ 'error' => "Un compte existe déjà avec l'email \"" . esc_html( $email ) . '".' ], 409 );
            }

            // Génère un identifiant unique à partir du nom de boutique (même
            // esprit que les slugs de boutique déjà utilisés sur le site).
            $base_login = sanitize_user( sanitize_title( $store_name ), true ) ?: 'vendeur';
            $login      = $base_login;
            $suffix     = 1;
            while ( username_exists( $login ) ) {
                $suffix++;
                $login = $base_login . $suffix;
            }

            $random_password = wp_generate_password( 20, true );
            $user_id = wp_insert_user( [
                'user_login' => $login,
                'user_email' => $email,
                'user_pass'  => $random_password,
                'first_name' => $first_name,
                'last_name'  => $last_name,
                'role'       => 'seller', // rôle vendeur Dokan
            ] );

            if ( is_wp_error( $user_id ) ) {
                return new WP_REST_Response( [ 'error' => $user_id->get_error_message() ], 500 );
            }

            // Profil boutique Dokan minimal — le vendeur complètera le reste
            // (logo, bannière, description) lui-même depuis son tableau de bord.
            update_user_meta( $user_id, 'dokan_profile_settings', [
                'store_name'  => $store_name,
                'phone'       => $phone,
                'show_email'  => '',
                'location'    => '',
                'banner'      => '',
                'gravatar'    => '',
                'social'      => [],
                'payment'     => [],
                'address'     => [
                    'street_1' => '',
                    'street_2' => '',
                    'city'     => $city,
                    'zip'      => '',
                    'country'  => $country,
                    'state'    => '',
                ],
            ] );

            // Envoie l'email standard WordPress "définissez votre mot de passe"
            // — jamais le mot de passe généré lui-même, ni dans la réponse API
            // ni par email, pour ne pas faire transiter un secret en clair.
            wp_new_user_notification( $user_id, null, 'user' );

            return new WP_REST_Response( [
                'ok'         => true,
                'vendor_id'  => $user_id,
                'login'      => $login,
                'store_url'  => home_url( '/store/' . sanitize_title( $store_name ) . '/' ),
                'email_sent' => true,
            ], 201 );
        },
        'args' => [
            'storeName' => [ 'required' => true ],
            'email'     => [ 'required' => true ],
            'firstName' => [],
            'lastName'  => [],
            'country'   => [],
            'city'      => [],
            'phone'     => [],
        ],
    ] );

    // Supprime un compte vendeur (usage : nettoyage de comptes de test créés
    // via /create-vendor). Refuse si le vendeur a le moindre produit, pour ne
    // jamais supprimer par erreur une vraie boutique avec un catalogue.
    register_rest_route( 'miad-products/v1', '/delete-vendor', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $vendor_id = (int) $request->get_param( 'vendorId' );
            $force     = (bool) $request->get_param( 'force' );
            if ( ! $vendor_id ) {
                return new WP_REST_Response( [ 'error' => 'vendorId requis.' ], 400 );
            }

            $user = get_userdata( $vendor_id );
            if ( ! $user || ! in_array( 'seller', (array) $user->roles, true ) ) {
                return new WP_REST_Response( [ 'error' => "Aucun vendeur avec l'ID $vendor_id." ], 404 );
            }

            $product_ids = get_posts( [
                'post_type'      => 'product',
                'post_status'    => 'any',
                'author'         => $vendor_id,
                'posts_per_page' => -1,
                'fields'         => 'ids',
            ] );

            if ( $product_ids && ! $force ) {
                return new WP_REST_Response( [
                    'error'       => count( $product_ids ) . ' produit(s) trouvé(s) — suppression refusée pour éviter de casser une vraie boutique. Repasse avec force=true pour tout supprimer (vendeur + produits).',
                    'product_ids' => $product_ids,
                ], 409 );
            }

            $deleted_products = [];
            foreach ( $product_ids as $pid ) {
                if ( wp_delete_post( $pid, true ) ) $deleted_products[] = $pid;
            }

            require_once ABSPATH . 'wp-admin/includes/user.php';
            $store_name = '';
            $settings = get_user_meta( $vendor_id, 'dokan_profile_settings', true );
            if ( is_array( $settings ) && ! empty( $settings['store_name'] ) ) {
                $store_name = $settings['store_name'];
            }

            $deleted = wp_delete_user( $vendor_id );
            if ( ! $deleted ) {
                return new WP_REST_Response( [ 'error' => 'Échec de la suppression.' ], 500 );
            }

            return new WP_REST_Response( [
                'ok'               => true,
                'vendor_id'        => $vendor_id,
                'store_name'       => $store_name,
                'deleted_products' => $deleted_products,
            ], 200 );
        },
        'args' => [
            'vendorId' => [ 'required' => true ],
            'force'    => [],
        ],
    ] );
} );

/**
 * Renomme le nom d'affichage d'une boutique existante (dokan_profile_settings
 * ['store_name']) — ne touche jamais le slug/l'URL de la boutique, pour ne
 * pas casser un lien déjà partagé. Fusionne dans les réglages existants
 * plutôt que de les remplacer, pour ne perdre aucun autre champ (logo,
 * adresse, réseaux sociaux...).
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/rename-vendor-store', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $vendor_id  = (int) $request->get_param( 'vendorId' );
            $store_name = sanitize_text_field( (string) ( $request->get_param( 'storeName' ) ?? '' ) );

            if ( ! $vendor_id || ! get_userdata( $vendor_id ) ) {
                return new WP_REST_Response( [ 'error' => 'vendorId invalide.' ], 400 );
            }
            if ( ! $store_name ) {
                return new WP_REST_Response( [ 'error' => 'storeName requis.' ], 400 );
            }

            $settings = get_user_meta( $vendor_id, 'dokan_profile_settings', true );
            if ( ! is_array( $settings ) ) $settings = [];
            $old_name = $settings['store_name'] ?? '';
            $settings['store_name'] = $store_name;
            update_user_meta( $vendor_id, 'dokan_profile_settings', $settings );

            return new WP_REST_Response( [
                'ok'        => true,
                'vendor_id' => $vendor_id,
                'old_name'  => $old_name,
                'new_name'  => $store_name,
            ], 200 );
        },
        'args' => [
            'vendorId'  => [ 'required' => true ],
            'storeName' => [ 'required' => true ],
        ],
    ] );
} );

/**
 * Override manuel logo/bannière vendeur — contourne le fait que Dokan
 * n'utilise jamais l'URL CDN pour dokan_profile_settings['gravatar']/['banner']
 * (reconfirmé le 2026-07-14 : identique après vidage de cache et re-sync,
 * même incident que le 2026-07-04 sur MALAÏKA'S HOUSE — Dokan reconstruit
 * l'URL depuis le chemin local peu importe où pointe réellement le fichier).
 * Plutôt que de dépendre de Dokan, on stocke une URL de override dans une
 * meta dédiée que app/api/stores/route.ts préfère quand elle existe.
 */
define( 'MIAD_VENDOR_LOGO_META', '_miad_logo_override_url' );
define( 'MIAD_VENDOR_BANNER_META', '_miad_banner_override_url' );

// Lecture publique (juste des URLs d'images déjà publiques, pas de secret) —
// consommé par app/api/stores/route.ts pour merger avec la liste Dokan.
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/vendor-image-overrides', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            global $wpdb;
            $rows = $wpdb->get_results( $wpdb->prepare(
                "SELECT user_id, meta_key, meta_value FROM {$wpdb->usermeta} WHERE meta_key IN (%s, %s)",
                MIAD_VENDOR_LOGO_META, MIAD_VENDOR_BANNER_META
            ), ARRAY_A );
            $overrides = [];
            foreach ( $rows as $r ) {
                $uid = (int) $r['user_id'];
                if ( $r['meta_value'] === '' ) continue;
                if ( ! isset( $overrides[ $uid ] ) ) $overrides[ $uid ] = [];
                $field = $r['meta_key'] === MIAD_VENDOR_LOGO_META ? 'logo' : 'banner';
                $overrides[ $uid ][ $field ] = $r['meta_value'];
            }
            return new WP_REST_Response( [ 'ok' => true, 'overrides' => $overrides ], 200 );
        },
    ] );

    // POST protégé par secret — même logique que le formulaire de la page
    // WP Admin ci-dessous (mêmes deux meta), pour poser logo/bannière depuis
    // scripts/miad.mjs sans passer par l'admin à chaque nouveau vendeur
    // (demandé le 2026-08-07 : "tu le fais toi-même").
    register_rest_route( 'miad-products/v1', '/set-vendor-images', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback'            => function ( WP_REST_Request $request ) {
            $vendor_id  = (int) $request->get_param( 'vendorId' );
            $logo_url   = esc_url_raw( trim( (string) ( $request->get_param( 'logoUrl' ) ?? '' ) ) );
            $banner_url = esc_url_raw( trim( (string) ( $request->get_param( 'bannerUrl' ) ?? '' ) ) );

            if ( ! $vendor_id || ! get_userdata( $vendor_id ) ) {
                return new WP_REST_Response( [ 'error' => 'vendorId invalide.' ], 400 );
            }
            if ( ! $logo_url && ! $banner_url ) {
                return new WP_REST_Response( [ 'error' => 'logoUrl et/ou bannerUrl requis.' ], 400 );
            }

            if ( $logo_url )   update_user_meta( $vendor_id, MIAD_VENDOR_LOGO_META, $logo_url );
            if ( $banner_url ) update_user_meta( $vendor_id, MIAD_VENDOR_BANNER_META, $banner_url );

            return new WP_REST_Response( [ 'ok' => true, 'vendorId' => $vendor_id ], 200 );
        },
    ] );
} );

// ── Page Admin WP : gestion manuelle logo/bannière vendeur ──────────────────
add_action( 'admin_menu', function () {
    add_menu_page(
        'Images Vendeurs MIAD',
        'Images Vendeurs',
        'manage_options',
        'miad-vendor-images',
        'miad_vendor_images_admin_page',
        'dashicons-store',
        58
    );
} );

function miad_vendor_images_admin_page(): void {
    if ( ! current_user_can( 'manage_options' ) ) return;

    if ( isset( $_POST['miad_vendor_image_nonce'] ) && wp_verify_nonce( $_POST['miad_vendor_image_nonce'], 'miad_vendor_image_save' ) ) {
        $vendor_id = (int) ( $_POST['vendor_id'] ?? 0 );
        if ( $vendor_id ) {
            $logo_url   = esc_url_raw( trim( (string) ( $_POST['logo_url'] ?? '' ) ) );
            $banner_url = esc_url_raw( trim( (string) ( $_POST['banner_url'] ?? '' ) ) );
            if ( $logo_url )   update_user_meta( $vendor_id, MIAD_VENDOR_LOGO_META, $logo_url );
            else               delete_user_meta( $vendor_id, MIAD_VENDOR_LOGO_META );
            if ( $banner_url ) update_user_meta( $vendor_id, MIAD_VENDOR_BANNER_META, $banner_url );
            else               delete_user_meta( $vendor_id, MIAD_VENDOR_BANNER_META );
            echo '<div class="notice notice-success"><p>Enregistré pour le vendeur #' . esc_html( (string) $vendor_id ) . '.</p></div>';
        }
    }

    // Synchronisation R2 déclenchée depuis cette page (lien GET, protégé par
    // capability manage_options + nonce — reste simple, pas besoin d'AJAX).
    if ( isset( $_GET['miad_sync_attachment'], $_GET['_wpnonce'] ) && wp_verify_nonce( $_GET['_wpnonce'], 'miad_sync_attachment' ) ) {
        $att_id = (int) $_GET['miad_sync_attachment'];
        if ( $att_id && function_exists( 'miad_products_api_sync_attachment_sizes' ) ) {
            $result = miad_products_api_sync_attachment_sizes( $att_id );
            if ( ! empty( $result['ok'] ) && ! empty( $result['r2_url'] ) ) {
                echo '<div class="notice notice-success"><p>Synchronisé sur R2 : <code>' . esc_html( $result['r2_url'] ) . '</code> — colle cette URL dans le champ correspondant ci-dessous puis Enregistrer.</p></div>';
            } else {
                echo '<div class="notice notice-error"><p>Échec de la synchronisation : ' . esc_html( $result['error'] ?? 'erreur inconnue' ) . '</p></div>';
            }
        }
    }

    $sellers = get_users( [ 'role' => 'seller', 'orderby' => 'display_name', 'order' => 'ASC' ] );
    echo '<div class="wrap"><h1>Images Vendeurs — Logo / Bannière</h1>';
    echo '<p>Dokan n\'utilise jamais l\'URL CDN pour le logo/la bannière (incident du 2026-07-04, reconfirmé le 2026-07-14) — inutile de re-tenter la migration automatique. Ici : synchronise l\'image vers R2 avec le bouton, colle l\'URL obtenue dans le champ, Enregistre — le site utilisera cette URL à la place de celle (cassée) que renvoie Dokan.</p>';

    foreach ( $sellers as $seller ) {
        $settings   = get_user_meta( $seller->ID, 'dokan_profile_settings', true );
        $store_name = is_array( $settings ) ? ( $settings['store_name'] ?? '' ) : '';
        if ( ! $store_name ) continue;

        $gravatar_id      = is_array( $settings ) ? (int) ( $settings['gravatar'] ?? 0 ) : 0;
        $banner_id        = is_array( $settings ) ? (int) ( $settings['banner'] ?? 0 ) : 0;
        $logo_override    = get_user_meta( $seller->ID, MIAD_VENDOR_LOGO_META, true );
        $banner_override  = get_user_meta( $seller->ID, MIAD_VENDOR_BANNER_META, true );

        echo '<div style="background:#fff;border:1px solid #ccd0d4;border-radius:4px;padding:14px 18px;margin-bottom:12px;max-width:900px;">';
        echo '<strong style="font-size:14px;">' . esc_html( $store_name ) . '</strong> <span style="color:#666">#' . (int) $seller->ID . '</span>';
        echo '<form method="post" style="display:flex;gap:24px;margin-top:10px;flex-wrap:wrap;">';
        wp_nonce_field( 'miad_vendor_image_save', 'miad_vendor_image_nonce' );
        echo '<input type="hidden" name="vendor_id" value="' . (int) $seller->ID . '">';

        foreach ( [ 'logo' => [ $gravatar_id, $logo_override, 'Logo' ], 'banner' => [ $banner_id, $banner_override, 'Bannière' ] ] as $field => [ $att_id, $override, $label ] ) {
            echo '<div style="flex:1;min-width:280px;">';
            echo '<label style="font-weight:600;display:block;margin-bottom:4px;">' . esc_html( $label ) . '</label>';
            if ( $att_id ) {
                $sync_url = wp_nonce_url( admin_url( 'admin.php?page=miad-vendor-images&miad_sync_attachment=' . $att_id ), 'miad_sync_attachment' );
                echo '<a href="' . esc_url( $sync_url ) . '" class="button button-small">Synchroniser vers R2</a>';
            } else {
                echo '<em style="color:#999">Aucune image posée</em>';
            }
            echo '<input type="url" name="' . $field . '_url" value="' . esc_attr( (string) $override ) . '" placeholder="https://cdn.miadmarket.com/..." style="width:100%;margin-top:6px;">';
            echo '</div>';
        }

        echo '<div style="align-self:flex-end;"><button type="submit" class="button button-primary">Enregistrer</button></div>';
        echo '</form></div>';
    }

    echo '</div>';
}
