<?php
/**
 * Plugin Name: MIAD Products API
 * Description: Endpoint REST sécurisé dédié à la création de produits
 *              WooCommerce depuis un script externe (clé secrète partagée,
 *              même principe que MIAD R2 Link). Gère catégorie, stock,
 *              images (téléchargées depuis une URL) en un seul appel.
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Corrige les URLs srcset WordPress qui pointent encore vers le serveur local
 * au lieu de R2/CDN. wp_calculate_image_srcset construit les URLs directement
 * depuis les métadonnées sans passer par wp_get_attachment_image_src — d'où le
 * besoin d'un filtre séparé.
 */
add_filter( 'wp_calculate_image_srcset', function ( $sources, $size_array, $image_src, $image_meta, $attachment_id ) {
    if ( ! function_exists( 'miad_r2_cfg' ) ) return $sources;
    $r2_url = get_post_meta( $attachment_id, '_miad_r2_url', true );
    if ( empty( $r2_url ) ) return $sources;
    $r2_base = rtrim( dirname( $r2_url ), '/' );
    foreach ( $sources as $w => $src ) {
        $sources[ $w ]['url'] = $r2_base . '/' . basename( wp_parse_url( $src['url'], PHP_URL_PATH ) );
    }
    return $sources;
}, 10, 5 );

function miad_products_api_secret(): string {
    $secret = get_option( 'miad_products_api_secret', '' );
    if ( empty( $secret ) ) {
        $secret = wp_generate_password( 40, false );
        update_option( 'miad_products_api_secret', $secret );
    }
    return $secret;
}

/**
 * Vérifie le secret ET protège contre le brute-force : après 10 échecs en 5
 * minutes depuis une même IP, bloque cette IP 15 minutes (transients
 * WordPress, aucune table dédiée). Demandé le 2026-07-29 pour protéger tous
 * les endpoints de ce fichier — chacun se contentait jusqu'ici d'un simple
 * hash_equals() sans aucune limite sur le nombre de tentatives.
 */
function miad_products_api_authorized( WP_REST_Request $request ): bool {
    $ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? 'unknown';

    if ( get_transient( 'miad_api_lockout_' . md5( $ip ) ) ) {
        return false;
    }

    if ( hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) ) ) {
        return true;
    }

    $fail_key = 'miad_api_fails_' . md5( $ip );
    $fails    = (int) get_transient( $fail_key ) + 1;
    set_transient( $fail_key, $fails, 5 * MINUTE_IN_SECONDS );
    if ( $fails >= 10 ) {
        set_transient( 'miad_api_lockout_' . md5( $ip ), true, 15 * MINUTE_IN_SECONDS );
    }
    return false;
}

/**
 * Cherche une catégorie produit existante par nom ou slug (insensible à la
 * casse) — ne crée jamais de nouvelle catégorie, pour éviter les doublons
 * "Sacs" / "sacs" / "Sac" qui arriveraient avec des saisies différentes.
 */
function miad_products_api_find_category( string $name_or_slug ): ?int {
    $term = get_term_by( 'name', $name_or_slug, 'product_cat' );
    if ( ! $term ) $term = get_term_by( 'slug', sanitize_title( $name_or_slug ), 'product_cat' );
    return $term ? (int) $term->term_id : null;
}

/**
 * Cherche un vendeur Dokan par son adresse email — plus fiable qu'une
 * recherche par nom de boutique (pas d'ambiguïté en cas de faute de frappe
 * ou de boutiques au nom proche). Vérifie que le compte a bien le rôle
 * vendeur Dokan, pas n'importe quel utilisateur WordPress.
 */
function miad_products_api_find_vendor_by_email( string $email ): ?int {
    $user = get_user_by( 'email', $email );
    if ( ! $user ) return null;
    if ( ! in_array( 'seller', (array) $user->roles, true ) && ! in_array( 'vendor', (array) $user->roles, true ) ) {
        return null; // existe mais n'est pas vendeur (ex: un client avec le même email)
    }
    return (int) $user->ID;
}

/**
 * Assigne explicitement la langue WPML 'fr' à un produit fraîchement créé.
 *
 * Bug trouvé le 2026-07-13 : $product->save() sans language details ne fait
 * jamais bénéficier le post de la langue "par défaut" du site — WPML lui
 * assigne 'en' (constaté sur 632 produits publiés, y compris des produits
 * créés il y a plusieurs semaines comme le SAC+POCHETTE VIP #39774). Or
 * quasiment toutes les requêtes front (accueil, page boutique SSR, etc.)
 * filtrent sur lang=fr par défaut — un produit resté 'en' est donc
 * invisible pour la quasi-totalité des visiteurs, y compris sur sa propre
 * page boutique vendeur. wpml_set_element_language_details est l'action
 * WPML standard pour ça (pas de trid : c'est une pièce unique, pas une
 * paire de traductions).
 */
function miad_products_api_set_language_fr( int $product_id ): void {
    if ( ! has_action( 'wpml_set_element_language_details' ) ) return;
    do_action( 'wpml_set_element_language_details', [
        'element_id'           => $product_id,
        'element_type'         => 'post_product',
        'trid'                 => null,
        'language_code'        => 'fr',
        'source_language_code' => null,
    ] );
}

/**
 * Crée la traduction anglaise d'un produit fraîchement créé en FR — demandé
 * le 2026-07-25 : chaque nouveau produit doit avoir une version EN (nom +
 * description) en plus du FR, pas seulement le FR comme jusqu'ici.
 *
 * Duplique un WC_Product_Simple minimal avec le contenu EN (même prix,
 * catégorie, image vedette/galerie que l'original — pas de re-téléchargement,
 * juste reprise des mêmes attachment_id) puis lie les deux via
 * wpml_set_element_language_details avec le même trid, exactement le
 * mécanisme WPML standard pour une paire de traductions (voir
 * miad_products_api_set_language_fr ci-dessus pour le contexte du bug du
 * 2026-07-13 sur la langue par défaut).
 */
function miad_products_api_create_translation_en( int $fr_product_id, string $name_en, string $description_en, string $short_description_en, ?int $vendor_id ): ?int {
    if ( ! $name_en || ! has_action( 'wpml_set_element_language_details' ) || ! has_filter( 'wpml_element_trid' ) ) return null;

    $fr_product = wc_get_product( $fr_product_id );
    if ( ! $fr_product ) return null;

    $trid = apply_filters( 'wpml_element_trid', null, $fr_product_id, 'post_product' );
    if ( ! $trid ) return null;

    $product_en = new WC_Product_Simple();
    $product_en->set_name( $name_en );
    $product_en->set_status( $fr_product->get_status() );
    $product_en->set_regular_price( $fr_product->get_regular_price() );
    if ( $fr_product->get_sale_price() ) $product_en->set_sale_price( $fr_product->get_sale_price() );
    $product_en->set_description( $description_en ?: $fr_product->get_description() );
    $product_en->set_short_description( $short_description_en ?: $fr_product->get_short_description() );
    if ( $fr_product->get_sku() ) $product_en->set_sku( $fr_product->get_sku() . '-en' );
    $cat_ids = $fr_product->get_category_ids();
    if ( $cat_ids ) $product_en->set_category_ids( $cat_ids );
    if ( $fr_product->get_manage_stock() ) {
        $product_en->set_manage_stock( true );
        $product_en->set_stock_quantity( $fr_product->get_stock_quantity() );
        $product_en->set_stock_status( $fr_product->get_stock_status() );
    }

    $product_en_id = $product_en->save();
    if ( ! $product_en_id ) return null;

    do_action( 'wpml_set_element_language_details', [
        'element_id'           => $product_en_id,
        'element_type'         => 'post_product',
        'trid'                 => $trid,
        'language_code'        => 'en',
        'source_language_code' => 'fr',
    ] );

    if ( $vendor_id && get_userdata( $vendor_id ) ) {
        wp_update_post( [ 'ID' => $product_en_id, 'post_author' => $vendor_id ] );
    }

    // Réutilise les mêmes images que l'original — pas de re-téléchargement.
    $thumb_id = get_post_thumbnail_id( $fr_product_id );
    if ( $thumb_id ) set_post_thumbnail( $product_en_id, $thumb_id );
    $gallery = get_post_meta( $fr_product_id, '_product_image_gallery', true );
    if ( $gallery ) update_post_meta( $product_en_id, '_product_image_gallery', $gallery );

    wc_delete_product_transients( $product_en_id );
    clean_post_cache( $product_en_id );

    return $product_en_id;
}

/**
 * Équivalent de miad_products_api_create_translation_en() pour un produit
 * VARIABLE — duplique aussi les variations. $variations_en_labels est un
 * tableau optionnel [ ancien_label_fr => label_en ] ; toute variation dont
 * le label FR n'y figure pas garde son label tel quel (ex: tailles
 * numériques "20", "22"... déjà universelles, pas besoin de traduction).
 */
function miad_products_api_create_variable_translation_en( int $fr_product_id, string $name_en, string $description_en, string $short_description_en, ?int $vendor_id, string $attribute_name, array $variations_en_labels = [] ): ?int {
    if ( ! $name_en || ! has_action( 'wpml_set_element_language_details' ) || ! has_filter( 'wpml_element_trid' ) ) return null;
    if ( ! class_exists( 'WC_Product_Variable' ) ) return null;

    $fr_product = wc_get_product( $fr_product_id );
    if ( ! $fr_product || ! $fr_product->is_type( 'variable' ) ) return null;

    $trid = apply_filters( 'wpml_element_trid', null, $fr_product_id, 'post_product' );
    if ( ! $trid ) return null;

    $fr_variations = $fr_product->get_available_variations( 'objects' );

    $product_en = new WC_Product_Variable();
    $product_en->set_name( $name_en );
    $product_en->set_status( $fr_product->get_status() );
    $product_en->set_description( $description_en ?: $fr_product->get_description() );
    $product_en->set_short_description( $short_description_en ?: $fr_product->get_short_description() );
    $cat_ids = $fr_product->get_category_ids();
    if ( $cat_ids ) $product_en->set_category_ids( $cat_ids );

    $attr_options = array_map( fn( $v ) => $variations_en_labels[ $v ] ?? $v, array_map( fn( $variation ) => $variation->get_attributes()[ sanitize_title( $attribute_name ) ] ?? '', $fr_variations ) );
    $attribute = new WC_Product_Attribute();
    $attribute->set_name( $attribute_name );
    $attribute->set_options( array_values( array_unique( $attr_options ) ) );
    $attribute->set_visible( true );
    $attribute->set_variation( true );
    $product_en->set_attributes( [ $attribute ] );

    $product_en_id = $product_en->save();
    if ( ! $product_en_id ) return null;

    do_action( 'wpml_set_element_language_details', [
        'element_id'           => $product_en_id,
        'element_type'         => 'post_product',
        'trid'                 => $trid,
        'language_code'        => 'en',
        'source_language_code' => 'fr',
    ] );

    if ( $vendor_id && get_userdata( $vendor_id ) ) {
        wp_update_post( [ 'ID' => $product_en_id, 'post_author' => $vendor_id ] );
    }

    $thumb_id = get_post_thumbnail_id( $fr_product_id );
    if ( $thumb_id ) set_post_thumbnail( $product_en_id, $thumb_id );

    $attr_key = sanitize_title( $attribute_name );
    foreach ( $fr_variations as $fr_variation ) {
        $fr_label = $fr_variation->get_attributes()[ $attr_key ] ?? '';
        if ( $fr_label === '' ) continue;
        $en_label = $variations_en_labels[ $fr_label ] ?? $fr_label;

        $variation_en = new WC_Product_Variation();
        $variation_en->set_parent_id( $product_en_id );
        $variation_en->set_attributes( [ $attr_key => $en_label ] );
        $variation_en->set_regular_price( $fr_variation->get_regular_price() );
        $variation_en->set_status( 'publish' );
        $variation_en->save();
    }

    WC_Product_Variable::sync( $product_en_id );
    wc_delete_product_transients( $product_en_id );
    clean_post_cache( $product_en_id );

    return $product_en_id;
}

/** Télécharge une image depuis une URL et l'attache au produit (vedette ou galerie) */
function miad_products_api_attach_image( string $url, int $product_id, bool $is_featured ): ?int {
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $tmp = download_url( $url, 20 );
    if ( is_wp_error( $tmp ) ) return null;

    $file_array = [
        'name'     => basename( wp_parse_url( $url, PHP_URL_PATH ) ?: 'image.jpg' ),
        'tmp_name' => $tmp,
    ];

    $attachment_id = media_handle_sideload( $file_array, $product_id );
    if ( is_wp_error( $attachment_id ) ) {
        @unlink( $tmp );
        return null;
    }

    if ( $is_featured ) {
        set_post_thumbnail( $product_id, $attachment_id );
    }

    // Envoie immédiatement vers R2 et enregistre _miad_r2_url en base — sans
    // attendre le cron WordPress (qui ne se déclenche qu'à la prochaine
    // visite du site et pourrait laisser l'image en local un moment).
    if ( function_exists( 'miad_r2_sync_attachment' ) ) {
        miad_r2_sync_attachment( $attachment_id );
    }

    return $attachment_id;
}

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/create', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $name = sanitize_text_field( (string) $request->get_param( 'name' ) );
            if ( ! $name ) {
                return new WP_REST_Response( [ 'error' => 'Le champ "name" est requis.' ], 400 );
            }

            if ( ! class_exists( 'WC_Product_Simple' ) ) {
                return new WP_REST_Response( [ 'error' => 'WooCommerce non actif.' ], 500 );
            }

            $description       = wp_kses_post( (string) $request->get_param( 'description' ) );
            $short_description  = wp_kses_post( (string) $request->get_param( 'shortDescription' ) );
            $name_en             = sanitize_text_field( (string) ( $request->get_param( 'nameEn' ) ?? '' ) );
            $description_en      = wp_kses_post( (string) ( $request->get_param( 'descriptionEn' ) ?? '' ) );
            $short_description_en = wp_kses_post( (string) ( $request->get_param( 'shortDescriptionEn' ) ?? '' ) );
            $cost_price         = (float) ( $request->get_param( 'costPrice' ) ?? 0 );
            $markup_percent     = (float) ( $request->get_param( 'markupPercent' ) ?? 0 );
            $explicit_price     = $request->get_param( 'price' );
            $price              = $explicit_price !== null
                ? (float) $explicit_price
                : round( $cost_price * ( 1 + $markup_percent / 100 ), 2 );
            $stock_quantity     = $request->get_param( 'stockQuantity' );
            $sku                = sanitize_text_field( (string) ( $request->get_param( 'sku' ) ?? '' ) );
            $category           = sanitize_text_field( (string) ( $request->get_param( 'category' ) ?? '' ) );
            $images             = (array) ( $request->get_param( 'images' ) ?? [] );
            $status             = sanitize_text_field( (string) ( $request->get_param( 'status' ) ?? 'publish' ) );
            $vendor_id          = $request->get_param( 'vendorId' );
            $vendor_email       = sanitize_email( (string) ( $request->get_param( 'vendorEmail' ) ?? '' ) );
            if ( ! $vendor_id && $vendor_email ) {
                $vendor_id = miad_products_api_find_vendor_by_email( $vendor_email );
                if ( ! $vendor_id ) {
                    return new WP_REST_Response( [ 'error' => 'Aucun vendeur trouvé pour l\'email "' . esc_html( $vendor_email ) . '".' ], 404 );
                }
            }

            $product = new WC_Product_Simple();
            $product->set_name( $name );
            $product->set_status( in_array( $status, [ 'publish', 'draft', 'pending' ], true ) ? $status : 'publish' );
            $product->set_regular_price( (string) $price );
            $product->set_description( $description );
            $product->set_short_description( $short_description );
            if ( $sku ) $product->set_sku( $sku );

            if ( $stock_quantity !== null ) {
                $product->set_manage_stock( true );
                $product->set_stock_quantity( (int) $stock_quantity );
                $product->set_stock_status( (int) $stock_quantity > 0 ? 'instock' : 'outofstock' );
            }

            $category_id = $category ? miad_products_api_find_category( $category ) : null;
            if ( $category_id ) {
                $product->set_category_ids( [ $category_id ] );
            }

            $product_id = $product->save();

            if ( ! $product_id ) {
                return new WP_REST_Response( [ 'error' => 'Échec de la création du produit.' ], 500 );
            }

            miad_products_api_set_language_fr( $product_id );

            // Attribue le produit à un vendeur Dokan existant (= post_author) —
            // sans ça, le produit appartient au compte admin et n'apparaît pas
            // dans la boutique du vendeur. À faire après save() : set_props()
            // ne reconnaît pas post_author comme propriété WC standard.
            if ( $vendor_id && get_userdata( (int) $vendor_id ) ) {
                wp_update_post( [ 'ID' => $product_id, 'post_author' => (int) $vendor_id ] );
            }

            // Images : la première devient l'image vedette, les suivantes la galerie.
            $gallery_ids   = [];
            $image_results = [];
            foreach ( $images as $index => $image_url ) {
                $attachment_id = miad_products_api_attach_image( sanitize_text_field( $image_url ), $product_id, $index === 0 );
                if ( $attachment_id && $index > 0 ) $gallery_ids[] = $attachment_id;
                $image_results[] = [
                    'source_url'    => $image_url,
                    'attachment_id' => $attachment_id,
                    'r2_url'        => $attachment_id ? get_post_meta( $attachment_id, '_miad_r2_url', true ) : null,
                ];
            }
            if ( $gallery_ids ) {
                update_post_meta( $product_id, '_product_image_gallery', implode( ',', $gallery_ids ) );
            }

            // Traduction EN optionnelle — voir miad_products_api_create_translation_en().
            $product_en_id = $name_en
                ? miad_products_api_create_translation_en( $product_id, $name_en, $description_en, $short_description_en, $vendor_id ? (int) $vendor_id : null )
                : null;

            return new WP_REST_Response( [
                'ok'             => true,
                'product_id'     => $product_id,
                'permalink'      => get_permalink( $product_id ),
                'edit_link'      => admin_url( 'post.php?post=' . $product_id . '&action=edit' ),
                'price'          => $price,
                'category_found' => (bool) $category_id,
                'images_attached'=> count( $gallery_ids ) + ( ! empty( $images ) ? 1 : 0 ),
                'images'         => $image_results,
                'product_id_en'  => $product_en_id,
            ], 200 );
        },
        'args' => [
            'name'               => [ 'required' => true ],
            'description'        => [],
            'shortDescription'   => [],
            'nameEn'             => [],
            'descriptionEn'      => [],
            'shortDescriptionEn' => [],
            'costPrice'        => [],
            'markupPercent'    => [],
            'price'            => [],
            'stockQuantity'    => [],
            'sku'              => [],
            'category'         => [],
            'images'           => [],
            'status'           => [],
            'vendorId'         => [],
            'vendorEmail'      => [],
        ],
    ] );
} );

/**
 * Route dédiée au changement d'image vedette d'un produit existant, qui
 * CONTOURNE volontairement WC_Product->save() / woocommerce_update_product.
 *
 * Raison : certains produits sont des traductions WPML liées à un original
 * avec synchronisation automatique des médias. Sur ces produits, un appel
 * normal à wc/v3/products/{id} (PUT images) se voit immédiatement écrasé
 * dans la même requête par le hook de resynchronisation média de WPML —
 * l'image revient à l'ancienne valeur en moins d'une seconde, avant même
 * la vérification suivante. update_post_meta() seul ne déclenche pas
 * save_post_product ni woocommerce_update_product, donc ce hook WPML ne
 * se déclenche pas et le changement persiste réellement.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/set-image', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $product_id   = (int) $request->get_param( 'productId' );
            $image_url    = sanitize_text_field( (string) ( $request->get_param( 'imageUrl' ) ?? '' ) );
            $gallery_urls = array_map( 'sanitize_text_field', (array) ( $request->get_param( 'galleryUrls' ) ?? [] ) );

            if ( ! $product_id || ! get_post( $product_id ) ) {
                return new WP_REST_Response( [ 'error' => 'productId invalide.' ], 400 );
            }
            if ( ! $image_url && empty( $gallery_urls ) ) {
                return new WP_REST_Response( [ 'error' => 'imageUrl ou galleryUrls requis.' ], 400 );
            }

            $attachment_id = null;
            if ( $image_url ) {
                $attachment_id = miad_products_api_attach_image( $image_url, $product_id, false );
                if ( ! $attachment_id ) {
                    return new WP_REST_Response( [ 'error' => 'Échec du téléchargement/attachement de l\'image.' ], 500 );
                }
                // Écriture directe en base, sans passer par WC_Product->save() —
                // c'est ce qui évite le hook de resynchronisation média WPML.
                update_post_meta( $product_id, '_thumbnail_id', $attachment_id );
            }

            $gallery_ids = [];
            foreach ( $gallery_urls as $gallery_url ) {
                if ( ! $gallery_url ) continue;
                $gid = miad_products_api_attach_image( $gallery_url, $product_id, false );
                if ( $gid ) $gallery_ids[] = $gid;
            }
            if ( $gallery_ids ) {
                // update_post_meta() déclenche le hook updated_post_meta, que WPML
                // semble utiliser pour resynchroniser/vider _product_image_gallery
                // sur un produit déjà traduit (constaté le 2026-07-11 : galerie posée
                // avec succès — attachments bien parentés en base, confirmés via
                // wp/v2/media — mais absente de wc/v3/products/{id}.images juste
                // après, alors que _thumbnail_id posé la même façon persiste bien).
                // $wpdb->update() en direct ne déclenche aucun hook WP, donc rien à
                // resynchroniser côté WPML.
                global $wpdb;
                $gallery_value = implode( ',', $gallery_ids );
                $existing = $wpdb->get_var( $wpdb->prepare(
                    "SELECT meta_id FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = '_product_image_gallery'",
                    $product_id
                ) );
                if ( $existing ) {
                    $wpdb->update( $wpdb->postmeta, [ 'meta_value' => $gallery_value ], [ 'meta_id' => $existing ] );
                } else {
                    $wpdb->insert( $wpdb->postmeta, [ 'post_id' => $product_id, 'meta_key' => '_product_image_gallery', 'meta_value' => $gallery_value ] );
                }
                wp_cache_delete( $product_id, 'post_meta' );
            }

            wc_delete_product_transients( $product_id );
            clean_post_cache( $product_id );

            return new WP_REST_Response( [
                'ok'             => true,
                'product_id'     => $product_id,
                'attachment_id'  => $attachment_id,
                'r2_url'         => $attachment_id ? get_post_meta( $attachment_id, '_miad_r2_url', true ) : null,
                'gallery_ids'    => $gallery_ids,
            ], 200 );
        },
        'args' => [
            'productId'   => [ 'required' => true ],
            'imageUrl'    => [],
            'galleryUrls' => [],
        ],
    ] );
} );

/**
 * Route dédiée au prix des variantes d'un produit variable, qui CONTOURNE
 * elle aussi WC_Product_Variation->save() pour la même raison que
 * /set-image : sur les produits touchés par la resynchronisation WPML, un
 * appel normal à wc/v3/products/{id}/variations/batch voit ses prix
 * revenir à vide quelques secondes après l'écriture. update_post_meta()
 * direct sur _price/_regular_price, suivi d'un recalcul manuel du prix
 * min/max du produit parent, évite ce hook et persiste réellement.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/set-variation-price', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $variation_ids = (array) ( $request->get_param( 'variationIds' ) ?? [] );
            $price         = sanitize_text_field( (string) $request->get_param( 'price' ) );

            if ( empty( $variation_ids ) || $price === '' ) {
                return new WP_REST_Response( [ 'error' => 'variationIds et price requis.' ], 400 );
            }

            $product_id = null;
            foreach ( $variation_ids as $variation_id ) {
                $variation_id = (int) $variation_id;
                $variation = get_post( $variation_id );
                if ( ! $variation || $variation->post_type !== 'product_variation' ) continue;

                update_post_meta( $variation_id, '_price', $price );
                update_post_meta( $variation_id, '_regular_price', $price );
                $product_id = (int) $variation->post_parent;
            }

            if ( $product_id ) {
                // Recalcule le prix min/max affiché sur la fiche parente à partir
                // des variantes (WC_Product_Variable::sync ne se déclenche pas
                // automatiquement sans passer par save(), qu'on évite ici).
                if ( class_exists( 'WC_Product_Variable' ) ) {
                    WC_Product_Variable::sync( $product_id );
                }
                wc_delete_product_transients( $product_id );
                clean_post_cache( $product_id );
            }

            return new WP_REST_Response( [ 'ok' => true, 'product_id' => $product_id, 'updated' => count( $variation_ids ) ], 200 );
        },
        'args' => [
            'variationIds' => [ 'required' => true ],
            'price'        => [ 'required' => true ],
        ],
    ] );
} );

/**
 * Crée un produit VARIABLE WooCommerce avec des variations basées sur un
 * attribut personnalisé (ex: quantité de commande). Chaque variation a son
 * propre prix. Télécharge l'image vedette depuis une URL externe (R2 CDN).
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/create-variable', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            if ( ! class_exists( 'WC_Product_Variable' ) ) {
                return new WP_REST_Response( [ 'error' => 'WooCommerce non actif.' ], 500 );
            }

            $name             = sanitize_text_field( (string) $request->get_param( 'name' ) );
            $description      = wp_kses_post( (string) ( $request->get_param( 'description' ) ?? '' ) );
            $short_desc       = wp_kses_post( (string) ( $request->get_param( 'shortDescription' ) ?? '' ) );
            $name_en          = sanitize_text_field( (string) ( $request->get_param( 'nameEn' ) ?? '' ) );
            $description_en   = wp_kses_post( (string) ( $request->get_param( 'descriptionEn' ) ?? '' ) );
            $short_desc_en    = wp_kses_post( (string) ( $request->get_param( 'shortDescriptionEn' ) ?? '' ) );
            $variations_en_labels = (array) ( $request->get_param( 'variationsEnLabels' ) ?? [] );
            $category         = sanitize_text_field( (string) ( $request->get_param( 'category' ) ?? '' ) );
            $vendor_id        = (int) $request->get_param( 'vendorId' );
            $status           = sanitize_text_field( (string) ( $request->get_param( 'status' ) ?? 'publish' ) );
            $image_url        = sanitize_text_field( (string) ( $request->get_param( 'imageUrl' ) ?? '' ) );
            $attribute_name   = sanitize_text_field( (string) ( $request->get_param( 'attributeName' ) ?? 'Commande' ) );
            $variations_data  = (array) ( $request->get_param( 'variations' ) ?? [] );

            if ( ! $name || empty( $variations_data ) ) {
                return new WP_REST_Response( [ 'error' => '"name" et "variations" requis.' ], 400 );
            }

            $product = new WC_Product_Variable();
            $product->set_name( $name );
            $product->set_status( in_array( $status, [ 'publish', 'draft', 'pending' ], true ) ? $status : 'publish' );
            $product->set_description( $description );
            $product->set_short_description( $short_desc );

            $category_id = $category ? miad_products_api_find_category( $category ) : null;
            if ( $category_id ) $product->set_category_ids( [ $category_id ] );

            // Attribut local (non-taxonomie) pour les variations
            $attr_options = array_map( fn( $v ) => sanitize_text_field( $v['label'] ?? '' ), $variations_data );
            $attribute    = new WC_Product_Attribute();
            $attribute->set_name( $attribute_name );
            $attribute->set_options( $attr_options );
            $attribute->set_visible( true );
            $attribute->set_variation( true );
            $product->set_attributes( [ $attribute ] );

            $product_id = $product->save();
            if ( ! $product_id ) {
                return new WP_REST_Response( [ 'error' => 'Échec de la création du produit variable.' ], 500 );
            }

            miad_products_api_set_language_fr( $product_id );

            // Assigne au vendeur Dokan
            if ( $vendor_id && get_userdata( $vendor_id ) ) {
                wp_update_post( [ 'ID' => $product_id, 'post_author' => $vendor_id ] );
            }

            // Image vedette
            $attachment_id = null;
            if ( $image_url ) {
                $attachment_id = miad_products_api_attach_image( $image_url, $product_id, true );
            }

            // Crée chaque variation
            // Attribut LOCAL (non-taxonomie, cf. set_attributes() ci-dessus qui ne
            // fait pas de set_is_taxonomy(true)) : WC_Product_Attribute::get_variation_name()
            // construit la clé meta comme 'attribute_' . sanitize_title(nom), SANS
            // préfixe 'pa_' (réservé aux attributs globaux enregistrés en taxonomie).
            // Le préfixe 'pa_' ici cassait le rapprochement variation<->attribut parent :
            // /products/{id}/variations renvoyait 'attributes: []' pour chaque variation,
            // donc le frontend ne pouvait jamais résoudre activeVariation et affichait
            // "Veuillez sélectionner vos options avant d'acheter" quelle que soit l'option choisie.
            $variation_ids = [];
            $attr_key      = sanitize_title( $attribute_name );
            foreach ( $variations_data as $var ) {
                $label = sanitize_text_field( $var['label'] ?? '' );
                $price = (string) ( $var['price'] ?? 0 );
                if ( ! $label ) continue;

                $variation = new WC_Product_Variation();
                $variation->set_parent_id( $product_id );
                $variation->set_attributes( [ $attr_key => $label ] );
                $variation->set_regular_price( $price );
                $variation->set_status( 'publish' );
                $vid = $variation->save();
                if ( $vid ) $variation_ids[] = $vid;
            }

            WC_Product_Variable::sync( $product_id );
            wc_delete_product_transients( $product_id );
            clean_post_cache( $product_id );

            // Garde-fou : vérifie que chaque variation a bien été rapprochée de
            // l'attribut du parent — sans ça, WooCommerce affiche indéfiniment
            // "Veuillez sélectionner vos options avant d'acheter" côté frontend
            // (régression du bug 'pa_' du 2026-07-08). Ici on utilise
            // wc_get_product() fraîchement rechargé depuis la base (pas l'objet
            // $variation en mémoire) pour vérifier ce qui a réellement été
            // persisté, exactement ce que verrait /products/{id}/variations.
            $attributes_warning = [];
            foreach ( $variation_ids as $vid ) {
                $saved_variation = wc_get_product( $vid );
                if ( ! $saved_variation || ! $saved_variation->get_attributes() ) {
                    $attributes_warning[] = $vid;
                }
            }

            // Traduction EN optionnelle — voir miad_products_api_create_variable_translation_en().
            $product_en_id = $name_en
                ? miad_products_api_create_variable_translation_en( $product_id, $name_en, $description_en, $short_desc_en, $vendor_id ?: null, $attribute_name, $variations_en_labels )
                : null;

            return new WP_REST_Response( [
                'ok'                  => true,
                'product_id'          => $product_id,
                'variation_ids'       => $variation_ids,
                'attributes_ok'       => empty( $attributes_warning ),
                'attributes_warning'  => $attributes_warning,
                'attachment_id'       => $attachment_id,
                'r2_url'              => $attachment_id ? get_post_meta( $attachment_id, '_miad_r2_url', true ) : null,
                'product_id_en'       => $product_en_id,
            ], 200 );
        },
        'args' => [
            'name'               => [ 'required' => true ],
            'description'        => [],
            'shortDescription'   => [],
            'nameEn'             => [],
            'descriptionEn'      => [],
            'shortDescriptionEn' => [],
            'variationsEnLabels' => [],
            'category'      => [],
            'vendorId'      => [],
            'status'        => [],
            'imageUrl'      => [],
            'attributeName' => [],
            'variations'    => [ 'required' => true ],
        ],
    ] );
} );

/**
 * Route pour réassigner le post_author (vendeur Dokan) de plusieurs produits
 * en une seule requête. Utile pour transférer des produits d'une boutique
 * à une autre sans passer par le batch WooCommerce (qui ignore post_author).
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/set-author', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_products_api_secret();
            return hash_equals( $secret, (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $ids       = array_map( 'intval', (array) ( $request->get_param( 'ids' ) ?? [] ) );
            $author_id = (int) $request->get_param( 'authorId' );

            if ( empty( $ids ) || ! $author_id ) {
                return new WP_REST_Response( [ 'error' => 'ids[] et authorId requis.' ], 400 );
            }
            if ( ! get_userdata( $author_id ) ) {
                return new WP_REST_Response( [ 'error' => 'authorId invalide.' ], 404 );
            }

            $updated = 0;
            $errors  = [];
            foreach ( $ids as $product_id ) {
                if ( get_post_type( $product_id ) !== 'product' ) {
                    $errors[] = $product_id;
                    continue;
                }
                $result = wp_update_post( [ 'ID' => $product_id, 'post_author' => $author_id ], true );
                if ( is_wp_error( $result ) ) {
                    $errors[] = $product_id;
                } else {
                    $updated++;
                }
            }

            return new WP_REST_Response( [
                'ok'      => true,
                'updated' => $updated,
                'errors'  => $errors,
            ], 200 );
        },
        'args' => [
            'ids'      => [ 'required' => true ],
            'authorId' => [ 'required' => true ],
        ],
    ] );
} );

/**
 * Régénère les miniatures WordPress et synchronise TOUTES les tailles
 * (100x100, 150x150, 300x300, etc.) vers R2 pour une liste d'attachments.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/sync-thumbnails', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            require_once ABSPATH . 'wp-admin/includes/image.php';
            require_once ABSPATH . 'wp-admin/includes/media.php';
            require_once ABSPATH . 'wp-admin/includes/file.php';

            $attachment_ids = array_map( 'intval', (array) ( $request->get_param( 'attachmentIds' ) ?? [] ) );
            if ( empty( $attachment_ids ) ) {
                return new WP_REST_Response( [ 'error' => 'attachmentIds[] requis.' ], 400 );
            }

            $results = [];
            foreach ( $attachment_ids as $att_id ) {
                $r = miad_products_api_sync_attachment_sizes( $att_id );
                $results[] = [
                    'id'           => $r['att_id'],
                    'ok'           => $r['ok'],
                    'error'        => $r['error'] ?? null,
                    'r2_url'       => $r['r2_url'] ?? '',
                    'r2_state'     => $r['r2_state'] ?? '',
                    'sizes_synced' => $r['sizes_synced'] ?? 0,
                    'sizes'        => $r['sizes'] ?? [],
                ];
            }

            return new WP_REST_Response( [ 'ok' => true, 'results' => $results ], 200 );
        },
        'args' => [ 'attachmentIds' => [ 'required' => true ] ],
    ] );
} );

/**
 * Régénère toutes les tailles WordPress d'un attachment et les uploade vers
 * R2, en un seul endroit — utilisé par /sync-thumbnails (un attachment à la
 * fois) et /sync-product-images (image vedette + galerie d'un produit).
 */
function miad_products_api_sync_attachment_sizes( int $att_id ): array {
    $file = get_attached_file( $att_id );
    if ( ! $file || ! file_exists( $file ) ) {
        $r2_url = get_post_meta( $att_id, '_miad_r2_url', true );
        if ( $r2_url ) {
            $tmp = download_url( $r2_url, 30 );
            if ( ! is_wp_error( $tmp ) ) {
                $upload = wp_upload_dir();
                $dest   = $upload['path'] . '/' . basename( wp_parse_url( $r2_url, PHP_URL_PATH ) );
                @rename( $tmp, $dest );
                update_attached_file( $att_id, $dest );
                $file = $dest;
            }
        }
    }

    if ( ! $file || ! file_exists( $file ) ) {
        return [ 'att_id' => $att_id, 'ok' => false, 'error' => 'Fichier image introuvable' ];
    }

    $metadata = wp_generate_attachment_metadata( $att_id, $file );
    wp_update_attachment_metadata( $att_id, $metadata );

    $public_url    = function_exists( 'miad_r2_cfg' ) ? rtrim( miad_r2_cfg( 'public_url' ), '/' ) : '';
    $main_relative = get_post_meta( $att_id, '_wp_attached_file', true );
    $dir_relative  = dirname( $main_relative );
    $dir_local     = dirname( $file );
    $sizes_synced  = 0;
    $sizes_urls    = [];

    foreach ( $metadata['sizes'] ?? [] as $size_name => $size_info ) {
        $size_local = $dir_local . '/' . $size_info['file'];
        $size_rel   = $dir_relative . '/' . $size_info['file'];
        $size_cdn   = $public_url ? $public_url . '/' . $size_rel : '';

        if ( file_exists( $size_local ) && function_exists( 'miad_r2_execute_request' ) ) {
            $content  = file_get_contents( $size_local );
            $response = miad_r2_execute_request( $size_rel, 'PUT', $content );
            $code     = is_wp_error( $response ) ? 0 : wp_remote_retrieve_response_code( $response );
            if ( $code === 200 || $code === 201 ) {
                $sizes_synced++;
                @unlink( $size_local );
            }
        }
        $sizes_urls[ $size_name ] = $size_cdn;
    }

    $r2_state = '';
    if ( function_exists( 'miad_r2_sync_attachment' ) ) {
        $r2_state = miad_r2_sync_attachment( $att_id );
    }

    return [
        'att_id'       => $att_id,
        'ok'           => true,
        'r2_url'       => get_post_meta( $att_id, '_miad_r2_url', true ),
        'r2_state'     => $r2_state,
        'sizes_synced' => $sizes_synced,
        'sizes'        => $sizes_urls,
    ];
}

/**
 * Prend des IDs produits, trouve leur image vedette, régénère les miniatures,
 * les uploade sur R2/CDN et vide le cache WooCommerce — tout en un seul appel.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/sync-product-images', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            require_once ABSPATH . 'wp-admin/includes/image.php';
            require_once ABSPATH . 'wp-admin/includes/media.php';
            require_once ABSPATH . 'wp-admin/includes/file.php';

            $product_ids = array_map( 'intval', (array) ( $request->get_param( 'productIds' ) ?? [] ) );
            if ( empty( $product_ids ) ) {
                return new WP_REST_Response( [ 'error' => 'productIds[] requis.' ], 400 );
            }

            $results = [];

            foreach ( $product_ids as $product_id ) {
                $featured_id = (int) get_post_thumbnail_id( $product_id );

                // Galerie : _product_image_gallery contient les IDs des images
                // additionnelles séparés par des virgules — sans ça, seule
                // l'image vedette était synchronisée, jamais les suivantes.
                $gallery_raw = get_post_meta( $product_id, '_product_image_gallery', true );
                $gallery_ids = $gallery_raw ? array_filter( array_map( 'intval', explode( ',', $gallery_raw ) ) ) : [];

                $all_att_ids = array_values( array_unique( array_filter( array_merge( [ $featured_id ], $gallery_ids ) ) ) );

                if ( empty( $all_att_ids ) ) {
                    $results[] = [ 'product_id' => $product_id, 'ok' => false, 'error' => 'Pas d\'image vedette ni de galerie' ];
                    continue;
                }

                $image_results = [];
                $total_sizes_synced = 0;
                foreach ( $all_att_ids as $att_id ) {
                    $r = miad_products_api_sync_attachment_sizes( $att_id );
                    $r['is_featured'] = ( $att_id === $featured_id );
                    $image_results[] = $r;
                    if ( $r['ok'] ) $total_sizes_synced += $r['sizes_synced'];
                }

                // Vide le cache WooCommerce du produit
                wc_delete_product_transients( $product_id );
                clean_post_cache( $product_id );
                foreach ( $all_att_ids as $att_id ) clean_post_cache( $att_id );

                $featured_result = current( array_filter( $image_results, fn( $r ) => $r['is_featured'] ) ) ?: ( $image_results[0] ?? [] );

                $results[] = [
                    'product_id'      => $product_id,
                    'att_id'          => $featured_id,
                    'ok'              => true,
                    'r2_url'          => $featured_result['r2_url'] ?? '',
                    'r2_state'        => $featured_result['r2_state'] ?? '',
                    'sizes_synced'    => $total_sizes_synced,
                    'images_synced'   => count( array_filter( $image_results, fn( $r ) => $r['ok'] ) ),
                    'images_total'    => count( $all_att_ids ),
                    'thumbnail'       => $featured_result['sizes']['thumbnail'] ?? '',
                    'wc_thumbnail'    => $featured_result['sizes']['woocommerce_thumbnail'] ?? '',
                ];
            }

            return new WP_REST_Response( [ 'ok' => true, 'results' => $results ], 200 );
        },
        'args' => [ 'productIds' => [ 'required' => true ] ],
    ] );
} );

/** Vide les caches WooCommerce + WordPress pour une liste de produits. */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/clear-cache', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $ids = array_map( 'intval', (array) ( $request->get_param( 'ids' ) ?? [] ) );
            if ( empty( $ids ) ) return new WP_REST_Response( [ 'error' => 'ids[] requis.' ], 400 );
            foreach ( $ids as $id ) {
                wc_delete_product_transients( $id );
                clean_post_cache( $id );
                // Vide aussi le cache des attachments liés au produit
                $att_id = get_post_thumbnail_id( $id );
                if ( $att_id ) {
                    clean_post_cache( $att_id );
                    wp_cache_delete( $att_id, 'post_meta' );
                }
            }
            return new WP_REST_Response( [ 'ok' => true, 'cleared' => count( $ids ) ], 200 );
        },
        'args' => [ 'ids' => [ 'required' => true ] ],
    ] );
} );

/** Retourne les permaliens + image vedette pour une liste d'IDs produits. */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/permalinks', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $ids = array_map( 'intval', (array) ( $request->get_param( 'ids' ) ?? [] ) );
            if ( empty( $ids ) ) {
                return new WP_REST_Response( [ 'error' => 'ids[] requis.' ], 400 );
            }
            $results = [];
            foreach ( $ids as $id ) {
                $post = get_post( $id );
                if ( ! $post || $post->post_type !== 'product' ) {
                    $results[] = [ 'id' => $id, 'error' => 'introuvable' ];
                    continue;
                }
                $att_id  = get_post_thumbnail_id( $id );
                $r2_url  = $att_id ? get_post_meta( $att_id, '_miad_r2_url', true ) : null;
                $results[] = [
                    'id'        => $id,
                    'name'      => $post->post_title,
                    'permalink' => get_permalink( $id ),
                    'image'     => $r2_url ?: wp_get_attachment_url( $att_id ?: 0 ),
                ];
            }
            return new WP_REST_Response( [ 'ok' => true, 'products' => $results ], 200 );
        },
        'args' => [ 'ids' => [ 'required' => true ] ],
    ] );
} );

/**
 * Met à jour prix, stock et/ou description d'un ou plusieurs produits
 * SIMPLES existants (contourne WC_Product->save() pour le prix, même raison
 * que /set-variation-price — utiliser /set-variation-price pour les
 * variations d'un produit variable, pas cet endpoint).
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/update-product', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $updates = (array) ( $request->get_param( 'updates' ) ?? [] );
            if ( empty( $updates ) ) {
                return new WP_REST_Response( [ 'error' => 'updates[] requis : [{id, price?, stockQuantity?, description?, shortDescription?, category?, tags?}]' ], 400 );
            }
            $done = []; $errors = [];
            foreach ( $updates as $u ) {
                $id = (int) ( $u['id'] ?? 0 );
                if ( ! $id || ! get_post( $id ) ) { $errors[] = $u; continue; }

                if ( isset( $u['price'] ) && $u['price'] !== '' ) {
                    // Même contournement que /set-variation-price : écriture
                    // directe en base plutôt que WC_Product->save(), pour
                    // éviter le hook de resynchronisation WPML qui vide le
                    // prix quelques secondes après un save() classique.
                    $price = sanitize_text_field( (string) $u['price'] );
                    update_post_meta( $id, '_price', $price );
                    update_post_meta( $id, '_regular_price', $price );
                }

                if ( isset( $u['stockQuantity'] ) && $u['stockQuantity'] !== '' ) {
                    $qty = (int) $u['stockQuantity'];
                    update_post_meta( $id, '_manage_stock', 'yes' );
                    update_post_meta( $id, '_stock', $qty );
                    update_post_meta( $id, '_stock_status', $qty > 0 ? 'instock' : 'outofstock' );
                }

                if ( isset( $u['category'] ) && $u['category'] !== '' ) {
                    // wp_set_object_terms() en direct plutôt que
                    // WC_Product->set_category_ids()->save(), même logique que
                    // le prix ci-dessus : ->save() déclenche le hook de
                    // resynchronisation WPML qui peut écraser la valeur juste
                    // écrite sur la traduction courante.
                    $category_id = miad_products_api_find_category( sanitize_text_field( (string) $u['category'] ) );
                    if ( $category_id ) {
                        wp_set_object_terms( $id, [ $category_id ], 'product_cat', false );
                    } else {
                        $errors[] = [ 'id' => $id, 'error' => 'category not found: ' . $u['category'] ];
                    }
                }

                if ( isset( $u['tags'] ) && is_array( $u['tags'] ) ) {
                    // Contrairement aux catégories, les tags WooCommerce (taxonomie
                    // product_tag) n'ont pas de liste fermée à respecter — de nouveaux
                    // tags peuvent être créés à la volée, c'est le fonctionnement normal
                    // de cette taxonomie (pas de risque de doublons "Sacs"/"sacs" comme
                    // pour les catégories : WooCommerce affiche les tags tels quels,
                    // sans hiérarchie ni page dédiée par tag à maintenir).
                    $tags = array_values( array_filter( array_map( 'sanitize_text_field', $u['tags'] ) ) );
                    wp_set_object_terms( $id, $tags, 'product_tag', false );
                }

                $post_update = [ 'ID' => $id ];
                if ( isset( $u['description'] ) )      $post_update['post_content'] = wp_kses_post( $u['description'] );
                if ( isset( $u['shortDescription'] ) )  $post_update['post_excerpt'] = wp_kses_post( $u['shortDescription'] );
                if ( count( $post_update ) > 1 ) {
                    $r = wp_update_post( $post_update, true );
                    if ( is_wp_error( $r ) ) { $errors[] = $id; continue; }
                }

                wc_delete_product_transients( $id );
                clean_post_cache( $id );
                $done[] = $id;
            }

            // La vraie cause (identifiée le 2026-07-11) : miad-api-cache.php
            // met /wc/v3/products en cache brut 24h dans wp_options, purgé
            // uniquement sur les hooks woocommerce_update_product /
            // woocommerce_new_product / woocommerce_delete_product /
            // dokan_store_profile_saved / dokan_new_seller_created. Le
            // wp_set_object_terms() direct ci-dessus (volontaire, pour éviter
            // le hook de resync WPML déclenché par WC_Product->save()) ne
            // déclenche AUCUN de ces hooks, donc ce cache ne se purge jamais
            // tout seul après une recatégorisation en masse — d'où un GET par
            // ID à jour immédiatement mais une liste paginée périmée jusqu'à
            // 24h. On appelle directement la fonction de purge de ce plugin
            // (chargé dans le même runtime PHP en tant qu'autre Code Snippet).
            if ( ! empty( $done ) && function_exists( 'miad_api_cache_flush' ) ) {
                miad_api_cache_flush();
            }

            return new WP_REST_Response( [ 'ok' => true, 'updated' => count( $done ), 'errors' => $errors ], 200 );
        },
        'args' => [ 'updates' => [ 'required' => true ] ],
    ] );
} );

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/update-name', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $updates = (array) ( $request->get_param( 'updates' ) ?? [] );
            if ( empty( $updates ) ) {
                return new WP_REST_Response( [ 'error' => 'updates[] requis : [{id, name}]' ], 400 );
            }
            $done = []; $errors = [];
            foreach ( $updates as $u ) {
                $id   = (int) ( $u['id'] ?? 0 );
                $name = sanitize_text_field( $u['name'] ?? '' );
                if ( ! $id || ! $name ) { $errors[] = $u; continue; }
                $r = wp_update_post( [ 'ID' => $id, 'post_title' => $name, 'post_name' => sanitize_title( $name ) ], true );
                if ( is_wp_error( $r ) ) $errors[] = $id; else $done[] = $id;
            }
            return new WP_REST_Response( [ 'ok' => true, 'updated' => count( $done ), 'errors' => $errors ], 200 );
        },
        'args' => [ 'updates' => [ 'required' => true ] ],
    ] );
} );

/**
 * Restaure une copie locale d'un attachment déjà synchronisé sur R2, à son
 * chemin d'origine exact (_wp_attached_file). Sert à réparer un cas où une
 * URL externe (ex: le champ "gravatar" de Dokan, qui stocke une URL figée
 * plutôt que de la recalculer à chaque appel) continue de pointer vers
 * l'ancien fichier local après sa suppression par miad_r2_sync_attachment —
 * sans avoir besoin de connaître/modifier le schéma interne de Dokan.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/restore-local-copy', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';

            $attachment_id = (int) $request->get_param( 'attachmentId' );
            if ( ! $attachment_id ) {
                return new WP_REST_Response( [ 'error' => 'attachmentId requis.' ], 400 );
            }

            $r2_url = get_post_meta( $attachment_id, '_miad_r2_url', true );
            if ( empty( $r2_url ) ) {
                return new WP_REST_Response( [ 'error' => "Pas de _miad_r2_url pour l'attachment $attachment_id." ], 404 );
            }

            $relative = get_post_meta( $attachment_id, '_wp_attached_file', true );
            if ( empty( $relative ) ) {
                return new WP_REST_Response( [ 'error' => '_wp_attached_file introuvable pour cet attachment.' ], 404 );
            }

            $upload_dir = wp_upload_dir();
            $local_path = trailingslashit( $upload_dir['basedir'] ) . $relative;
            $local_dir  = dirname( $local_path );
            if ( ! file_exists( $local_dir ) ) {
                wp_mkdir_p( $local_dir );
            }

            $tmp = download_url( $r2_url, 30 );
            if ( is_wp_error( $tmp ) ) {
                return new WP_REST_Response( [ 'error' => 'Téléchargement CDN échoué : ' . $tmp->get_error_message() ], 502 );
            }

            $ok = copy( $tmp, $local_path );
            @unlink( $tmp );

            if ( ! $ok ) {
                return new WP_REST_Response( [ 'error' => "Échec de l'écriture locale à $local_path" ], 500 );
            }

            clean_post_cache( $attachment_id );

            return new WP_REST_Response( [
                'ok'         => true,
                'local_path' => $local_path,
                'r2_url'     => $r2_url,
            ], 200 );
        },
        'args' => [ 'attachmentId' => [ 'required' => true ] ],
    ] );
} );

/**
 * Diagnostic en lecture seule : renvoie les réglages bruts Dokan d'un vendeur
 * (dokan_profile_settings) pour comprendre où et comment est stocké le logo
 * (attachment ID vs URL figée) avant d'écrire quoi que ce soit dessus.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/vendor-store-info', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $vendor_id = (int) $request->get_param( 'vendorId' );
            if ( ! $vendor_id || ! get_userdata( $vendor_id ) ) {
                return new WP_REST_Response( [ 'error' => 'vendorId invalide.' ], 400 );
            }

            $settings = get_user_meta( $vendor_id, 'dokan_profile_settings', true );

            return new WP_REST_Response( [
                'ok'                     => true,
                'vendor_id'              => $vendor_id,
                'dokan_profile_settings' => $settings,
                'gravatar_meta'          => get_user_meta( $vendor_id, 'store_ppimg', true ),
                'banner_meta'            => get_user_meta( $vendor_id, 'banner', true ),
            ], 200 );
        },
        'args' => [ 'vendorId' => [ 'required' => true ] ],
    ] );
} );

/**
 * Renvoie les IDs des produits publiés d'un vendeur via une requête SQL
 * directe sur post_author — contourne /wp-json/dokan/v1/stores/{id}/products,
 * constaté cassé le 2026-07-10 : cet endpoint renvoyait exactement les mêmes
 * produits (ceux du vendeur 95) quel que soit le {id} demandé dans l'URL
 * (95, 137, 48 donnaient tous le même résultat), ce qui faisait apparaître
 * la quasi-totalité des boutiques du site comme vides ou avec 1-2 produits
 * seulement côté page boutique (app/VendorStorePage.tsx).
 *
 * Le frontend combine ceci avec wc/v3/products?include=id1,id2,... (filtre
 * par ID, documenté et fiable) pour récupérer les données complètes —
 * voir app/api/products/route.ts.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/vendor-product-ids', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            global $wpdb;
            $vendor_id = (int) $request->get_param( 'vendorId' );
            if ( ! $vendor_id ) {
                return new WP_REST_Response( [ 'error' => 'vendorId requis.' ], 400 );
            }

            $ids = $wpdb->get_col( $wpdb->prepare( "
                SELECT ID FROM {$wpdb->posts}
                WHERE post_type = 'product' AND post_status = 'publish' AND post_author = %d
                ORDER BY post_date DESC
            ", $vendor_id ) );

            return new WP_REST_Response( [ 'ok' => true, 'ids' => array_map( 'intval', $ids ) ], 200 );
        },
        'args' => [ 'vendorId' => [ 'required' => true ] ],
    ] );
} );

/**
 * Répare les variations créées AVANT le correctif du bug 'pa_' dans
 * /create-variable : la clé meta était écrite 'attribute_pa_<slug>' au lieu
 * de 'attribute_<slug>' pour un attribut LOCAL (non-taxonomie), donc
 * WooCommerce ne rapprochait jamais la variation de l'attribut du produit
 * parent (/products/{id}/variations renvoyait "attributes": []) — d'où le
 * message "Veuillez sélectionner vos options avant d'acheter" en boucle.
 *
 * Ne touche QUE les variations dont le parent a bien un attribut LOCAL
 * correspondant (is_taxonomy=0 dans _product_attributes) — un vrai
 * attribut global taxonomique (ex: pa_couleur défini dans Produits >
 * Attributs) utilise légitimement la clé 'attribute_pa_couleur' et n'est
 * jamais touché.
 *
 * dryRun=true (défaut) : ne fait qu'un état des lieux, aucune écriture.
 * dryRun=false : applique réellement la correction + resync du parent.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/repair-variable-attributes', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            global $wpdb;
            $dry_run = $request->get_param( 'dryRun' );
            $dry_run = $dry_run === null ? true : filter_var( $dry_run, FILTER_VALIDATE_BOOLEAN );

            $rows = $wpdb->get_results( "
                SELECT meta_id, post_id, meta_key, meta_value
                FROM {$wpdb->postmeta}
                WHERE meta_key LIKE 'attribute\_pa\_%'
            ", ARRAY_A );

            $repaired = [];
            $skipped  = [];
            $parents_to_sync = [];

            foreach ( $rows as $row ) {
                $variation_id = (int) $row['post_id'];
                $old_key      = $row['meta_key'];
                $slug         = substr( $old_key, strlen( 'attribute_pa_' ) );
                $new_key      = 'attribute_' . $slug;

                $parent_id = wp_get_post_parent_id( $variation_id );
                if ( ! $parent_id ) { $skipped[] = [ 'variation_id' => $variation_id, 'reason' => 'pas de parent' ]; continue; }

                $parent_attrs = maybe_unserialize( get_post_meta( $parent_id, '_product_attributes', true ) ) ?: [];
                $is_local_match = isset( $parent_attrs[ $slug ] ) && empty( $parent_attrs[ $slug ]['is_taxonomy'] );
                if ( ! $is_local_match ) {
                    $skipped[] = [ 'variation_id' => $variation_id, 'parent_id' => $parent_id, 'reason' => 'attribut taxonomique légitime (pa_' . $slug . '), non touché' ];
                    continue;
                }

                $existing_new = get_post_meta( $variation_id, $new_key, true );
                if ( $existing_new !== '' ) {
                    $skipped[] = [ 'variation_id' => $variation_id, 'parent_id' => $parent_id, 'reason' => "clé $new_key déjà présente" ];
                    continue;
                }

                if ( ! $dry_run ) {
                    update_post_meta( $variation_id, $new_key, $row['meta_value'] );
                    delete_post_meta( $variation_id, $old_key );
                    $parents_to_sync[ $parent_id ] = true;
                }

                $repaired[] = [ 'variation_id' => $variation_id, 'parent_id' => $parent_id, 'old_key' => $old_key, 'new_key' => $new_key, 'value' => $row['meta_value'] ];
            }

            if ( ! $dry_run && class_exists( 'WC_Product_Variable' ) ) {
                foreach ( array_keys( $parents_to_sync ) as $parent_id ) {
                    WC_Product_Variable::sync( $parent_id );
                    wc_delete_product_transients( $parent_id );
                    clean_post_cache( $parent_id );
                }
            }

            return new WP_REST_Response( [
                'ok'              => true,
                'dry_run'         => $dry_run,
                'repaired_count'  => count( $repaired ),
                'parents_synced'  => $dry_run ? 0 : count( $parents_to_sync ),
                'repaired'        => $repaired,
                'skipped'         => $skipped,
            ], 200 );
        },
        'args' => [ 'dryRun' => [] ],
    ] );
} );

/**
 * Pose la bannière et/ou la photo de profil (gravatar) d'une boutique Dokan,
 * à partir d'URLs déjà hébergées (CDN ou autre) — le script local upload
 * d'abord le fichier local sur R2 pour obtenir une URL, avant d'appeler cet
 * endpoint qui la télécharge côté serveur.
 *
 * Volontairement SANS miad_r2_sync_attachment() ici, contrairement à
 * miad_products_api_attach_image() utilisé pour les produits : l'incident du
 * 2026-07-04 (voir CLAUDE.md "Logos vendeurs Dokan — NE PAS migrer vers le
 * CDN") montre que dokan_profile_settings['gravatar'] ne se résout pas de
 * façon fiable une fois le fichier local supprimé par le sync R2. Cet
 * endpoint attache l'image normalement (media_handle_sideload) et la laisse
 * en local sur le serveur WP — exactement le fonctionnement Dokan standard
 * sans l'offload R2, donc aucun risque de 404 comme lors de l'incident.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/set-vendor-branding', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $vendor_id  = (int) $request->get_param( 'vendorId' );
            $banner_url = sanitize_text_field( (string) ( $request->get_param( 'bannerUrl' ) ?? '' ) );
            $photo_url  = sanitize_text_field( (string) ( $request->get_param( 'photoUrl' ) ?? '' ) );

            if ( ! $vendor_id || ! get_userdata( $vendor_id ) ) {
                return new WP_REST_Response( [ 'error' => 'vendorId invalide.' ], 400 );
            }
            if ( ! $banner_url && ! $photo_url ) {
                return new WP_REST_Response( [ 'error' => 'bannerUrl ou photoUrl requis.' ], 400 );
            }

            require_once ABSPATH . 'wp-admin/includes/media.php';
            require_once ABSPATH . 'wp-admin/includes/file.php';
            require_once ABSPATH . 'wp-admin/includes/image.php';

            $attach_local = function ( string $url ) use ( $vendor_id ) {
                $tmp = download_url( $url, 20 );
                if ( is_wp_error( $tmp ) ) return null;
                $file_array = [
                    'name'     => basename( wp_parse_url( $url, PHP_URL_PATH ) ?: 'image.jpg' ),
                    'tmp_name' => $tmp,
                ];
                // post_id 0 : l'image appartient à la boutique, pas à un produit précis.
                $attachment_id = media_handle_sideload( $file_array, 0 );
                if ( is_wp_error( $attachment_id ) ) { @unlink( $tmp ); return null; }
                update_post_meta( $attachment_id, '_miad_vendor_branding_for', $vendor_id );
                return $attachment_id;
            };

            $banner_id = $banner_url ? $attach_local( $banner_url ) : null;
            $photo_id  = $photo_url  ? $attach_local( $photo_url )  : null;

            if ( $banner_url && ! $banner_id ) {
                return new WP_REST_Response( [ 'error' => 'Échec du téléchargement de bannerUrl.' ], 500 );
            }
            if ( $photo_url && ! $photo_id ) {
                return new WP_REST_Response( [ 'error' => 'Échec du téléchargement de photoUrl.' ], 500 );
            }

            $settings = get_user_meta( $vendor_id, 'dokan_profile_settings', true );
            if ( ! is_array( $settings ) ) $settings = [];
            if ( $banner_id ) $settings['banner']   = $banner_id;
            if ( $photo_id )  $settings['gravatar'] = $photo_id;
            update_user_meta( $vendor_id, 'dokan_profile_settings', $settings );

            return new WP_REST_Response( [
                'ok'         => true,
                'vendor_id'  => $vendor_id,
                'banner_id'  => $banner_id,
                'photo_id'   => $photo_id,
            ], 200 );
        },
        'args' => [ 'vendorId' => [ 'required' => true ], 'bannerUrl' => [], 'photoUrl' => [] ],
    ] );
} );

/**
 * Corrige les produits déjà publiés dont la langue WPML n'est pas 'fr' —
 * conséquence du bug décrit sur miad_products_api_set_language_fr() : tout
 * produit créé via /create ou /create-variable avant le 2026-07-13 a été
 * assigné en langue 'en' par défaut par WPML, invisible pour la quasi-
 * totalité des requêtes front (lang=fr par défaut).
 *
 * Ne touche QUE les trid (groupe de traduction WPML) qui n'ont qu'UNE seule
 * ligne dans icl_translations — c'est-à-dire un produit autonome, jamais
 * traduit, pas une vraie paire fr/en volontaire. Si un trid a 2+ lignes
 * (vraie traduction existante), on laisse intact.
 *
 * dryRun=true (défaut) : état des lieux seul, aucune écriture.
 * dryRun=false : réécrit language_code='fr' directement dans icl_translations
 * (pas de hook WPML à contourner ici, cette table n'est lue par WPML qu'au
 * moment des requêtes suivantes — écrire dessus ne déclenche pas de resync).
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/fix-product-language', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            global $wpdb;
            $dry_run = $request->get_param( 'dryRun' );
            $dry_run = $dry_run === null ? true : filter_var( $dry_run, FILTER_VALIDATE_BOOLEAN );
            $table   = $wpdb->prefix . 'icl_translations';

            if ( $wpdb->get_var( "SHOW TABLES LIKE '{$table}'" ) !== $table ) {
                return new WP_REST_Response( [ 'error' => "Table {$table} introuvable — WPML non actif ?" ], 500 );
            }

            // trid dont la SEULE ligne est en langue != 'fr' → candidat sûr.
            $candidates = $wpdb->get_results( "
                SELECT t.translation_id, t.element_id, t.language_code
                FROM {$table} t
                INNER JOIN (
                    SELECT trid FROM {$table}
                    WHERE element_type = 'post_product'
                    GROUP BY trid
                    HAVING COUNT(*) = 1
                ) solo ON solo.trid = t.trid
                WHERE t.element_type = 'post_product' AND t.language_code != 'fr'
            ", ARRAY_A );

            $product_ids = array_map( fn( $r ) => (int) $r['element_id'], $candidates );

            $updated_ids = [];
            $skipped     = [];

            // Bug trouvé le 2026-07-25 : un seul UPDATE en masse (WHERE
            // translation_id IN (...)) échoue intégralement et silencieusement
            // dès qu'UNE seule ligne viole la contrainte unique (trid,
            // language_code) de icl_translations — ex: "Duplicate entry
            // '30885-fr'", un trid qui a déjà une ligne 'fr' pour un AUTRE
            // element_type (la contrainte n'est pas scopée par element_type).
            // MySQL/InnoDB annule alors tout le statement, donc AUCUNE des
            // 405 lignes n'était réellement corrigée malgré une réponse
            // "ok:true". Ligne par ligne : un conflit sur un trid n'empêche
            // plus la correction des 404 autres.
            if ( ! $dry_run ) {
                foreach ( $candidates as $row ) {
                    $translation_id = (int) $row['translation_id'];
                    $element_id     = (int) $row['element_id'];
                    $wpdb->query( "UPDATE {$table} SET language_code = 'fr' WHERE translation_id = {$translation_id}" );
                    if ( $wpdb->last_error ) {
                        $skipped[] = [ 'element_id' => $element_id, 'error' => $wpdb->last_error ];
                    } else {
                        $updated_ids[] = $element_id;
                    }
                }
                foreach ( $updated_ids as $pid ) {
                    clean_post_cache( $pid );
                }
                if ( $updated_ids && function_exists( 'miad_api_cache_flush' ) ) miad_api_cache_flush();
            }

            return new WP_REST_Response( [
                'ok'            => true,
                'dry_run'       => $dry_run,
                'fixed_count'   => count( $product_ids ),
                'product_ids'   => $product_ids,
                'updated_count' => count( $updated_ids ),
                'updated_ids'   => $updated_ids,
                'skipped'       => $skipped,
            ], 200 );
        },
        'args' => [ 'dryRun' => [] ],
    ] );
} );

/**
 * Liste les produits FR déjà publiés qui n'ont PAS encore de traduction
 * anglaise liée — demandé le 2026-07-26, pour traiter le reste du
 * catalogue avec miad_products_api_create_translation_en() (jusqu'ici
 * utilisée uniquement à la création d'un nouveau produit). Même critère
 * "solo trid" que /fix-product-language : un trid avec une seule ligne
 * post_product est un produit jamais traduit.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/products-missing-en', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function () {
            global $wpdb;
            $table = $wpdb->prefix . 'icl_translations';
            if ( $wpdb->get_var( "SHOW TABLES LIKE '{$table}'" ) !== $table ) {
                return new WP_REST_Response( [ 'error' => "Table {$table} introuvable — WPML non actif ?" ], 500 );
            }

            $rows = $wpdb->get_results( "
                SELECT t.element_id
                FROM {$table} t
                INNER JOIN (
                    SELECT trid FROM {$table}
                    WHERE element_type = 'post_product'
                    GROUP BY trid
                    HAVING COUNT(*) = 1
                ) solo ON solo.trid = t.trid
                WHERE t.element_type = 'post_product' AND t.language_code = 'fr'
            ", ARRAY_A );

            $ids = array_map( fn( $r ) => (int) $r['element_id'], $rows );
            if ( empty( $ids ) ) {
                return new WP_REST_Response( [ 'ok' => true, 'count' => 0, 'products' => [] ], 200 );
            }

            $placeholders = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
            $posts = $wpdb->get_results( $wpdb->prepare( "
                SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_status
                FROM {$wpdb->posts} p
                WHERE p.ID IN ({$placeholders}) AND p.post_type = 'product' AND p.post_status = 'publish'
                ORDER BY p.ID
            ", $ids ), ARRAY_A );

            $products = array_map( fn( $p ) => [
                'id'               => (int) $p['ID'],
                'name'             => $p['post_title'],
                'description'      => $p['post_content'],
                'shortDescription' => $p['post_excerpt'],
            ], $posts );

            return new WP_REST_Response( [ 'ok' => true, 'count' => count( $products ), 'products' => $products ], 200 );
        },
    ] );
} );

/**
 * Ajoute une traduction anglaise à un produit FR déjà EXISTANT (contrairement
 * à miad_products_api_create_translation_en(), appelée jusqu'ici seulement
 * juste après la création d'un nouveau produit via /create). Même mécanisme
 * WPML (trid partagé), simple wrapper pour un produit qui existe déjà.
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/add-translation-en', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $product_id            = (int) $request->get_param( 'productId' );
            $name_en               = sanitize_text_field( (string) ( $request->get_param( 'nameEn' ) ?? '' ) );
            $description_en        = wp_kses_post( (string) ( $request->get_param( 'descriptionEn' ) ?? '' ) );
            $short_description_en  = wp_kses_post( (string) ( $request->get_param( 'shortDescriptionEn' ) ?? '' ) );

            if ( ! $product_id || ! $name_en ) {
                return new WP_REST_Response( [ 'error' => 'productId et nameEn requis.' ], 400 );
            }
            if ( ! wc_get_product( $product_id ) ) {
                return new WP_REST_Response( [ 'error' => 'productId invalide.' ], 404 );
            }

            $vendor_id = (int) get_post_field( 'post_author', $product_id );
            $product_en_id = miad_products_api_create_translation_en( $product_id, $name_en, $description_en, $short_description_en, $vendor_id ?: null );

            if ( ! $product_en_id ) {
                return new WP_REST_Response( [ 'error' => 'Échec de la création de la traduction (trid introuvable, ou WPML non actif ?).' ], 500 );
            }

            return new WP_REST_Response( [ 'ok' => true, 'product_id' => $product_id, 'product_id_en' => $product_en_id ], 200 );
        },
        'args' => [
            'productId'          => [ 'required' => true ],
            'nameEn'             => [ 'required' => true ],
            'descriptionEn'      => [],
            'shortDescriptionEn' => [],
        ],
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   PAGE ADMIN — affiche la clé secrète à mettre dans .env.local
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_submenu_page( 'upload.php', 'MIAD Products API', '📦 MIAD Products API', 'manage_options', 'miad-products-api', 'miad_products_api_page' );
} );

function miad_products_api_page(): void {
    $secret = miad_products_api_secret();
    ?>
    <div class="wrap" style="max-width:700px">
        <h1>📦 MIAD Products API</h1>
        <p style="color:#555">Endpoint sécurisé pour créer des produits WooCommerce depuis un script externe.</p>
        <table class="form-table">
            <tr><th>Endpoint</th><td><code><?= esc_html( untrailingslashit( site_url() ) ) ?>/wp-json/miad-products/v1/create</code></td></tr>
            <tr><th>Clé secrète (header <code>X-Miad-Products-Secret</code>)</th>
                <td><input type="text" readonly value="<?= esc_attr( $secret ) ?>" class="regular-text" style="width:100%;max-width:500px;font-family:monospace;" onclick="this.select()"></td>
            </tr>
        </table>
        <p class="description">À mettre dans <code>.env.local</code> : <code>MIAD_PRODUCTS_SECRET=<?= esc_html( $secret ) ?></code></p>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   VÉRIFICATION SYSTÈME — endpoint + page WP Admin avec bouton
   Demandé le 2026-07-29 suite à une panne où TOUS les endpoints de ce
   fichier renvoyaient 404 (rest_no_route) sans qu'aucune erreur ne soit
   visible côté site — juste "aucun produit" sur chaque boutique. Ce
   contrôle teste les services dont dépend le site (WooCommerce, Dokan,
   WPML) pour repérer ce genre de panne en un clic, sans avoir à deviner
   quel endpoint casse.
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/system-check', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return miad_products_api_authorized( $request );
        },
        'callback' => function () {
            $checks = [];

            $wc = wp_remote_get( rest_url( 'wc/v3/products?per_page=1' ), [ 'timeout' => 8 ] );
            $checks[] = [
                'name' => 'API WooCommerce (produits)',
                'ok'   => ! is_wp_error( $wc ) && wp_remote_retrieve_response_code( $wc ) === 200,
            ];

            $dokan = wp_remote_get( rest_url( 'dokan/v1/stores?per_page=1' ), [ 'timeout' => 8 ] );
            $checks[] = [
                'name' => 'API Dokan (boutiques)',
                'ok'   => ! is_wp_error( $dokan ) && wp_remote_retrieve_response_code( $dokan ) === 200,
            ];

            global $wpdb;
            $table = $wpdb->prefix . 'icl_translations';
            $checks[] = [
                'name' => 'Table WPML (traductions FR/EN)',
                'ok'   => $wpdb->get_var( "SHOW TABLES LIKE '{$table}'" ) === $table,
            ];

            // Si ce callback s'exécute, ce fichier est bien chargé et actif —
            // mais on vérifie quand même qu'une route existante ailleurs dans
            // ce même fichier répond, pour détecter une panne partielle (ex:
            // une erreur PHP dans une fonction utilisée par une seule route,
            // qui ne casserait pas celle-ci).
            $vendor_ids = wp_remote_get(
                rest_url( 'miad-products/v1/vendor-product-ids?vendorId=48' ),
                [ 'timeout' => 8, 'headers' => [ 'x-miad-products-secret' => miad_products_api_secret() ] ]
            );
            $checks[] = [
                'name' => 'Endpoints MIAD Products API (auto-test)',
                'ok'   => ! is_wp_error( $vendor_ids ) && wp_remote_retrieve_response_code( $vendor_ids ) === 200,
            ];

            $all_ok = ! in_array( false, array_column( $checks, 'ok' ), true );

            return new WP_REST_Response( [
                'ok'         => $all_ok,
                'checks'     => $checks,
                'checked_at' => current_time( 'mysql' ),
            ], 200 );
        },
    ] );
} );

add_action( 'admin_menu', function () {
    add_submenu_page( 'upload.php', 'Vérifier le système MIAD', '✅ Vérifier le système', 'manage_options', 'miad-system-check', 'miad_system_check_page' );
} );

function miad_system_check_page(): void {
    $secret   = miad_products_api_secret();
    $endpoint = esc_url( rest_url( 'miad-products/v1/system-check' ) );
    ?>
    <div class="wrap" style="max-width:700px">
        <h1>✅ Vérifier le système MIAD</h1>
        <p style="color:#555">Teste en un clic les services dont dépend le site (WooCommerce, Dokan, WPML, ce plugin lui-même).</p>
        <button id="miad-check-btn" class="button button-primary button-hero">Vérifier maintenant</button>
        <div id="miad-check-result" style="margin-top:20px"></div>
    </div>
    <script>
    document.getElementById('miad-check-btn').addEventListener('click', function () {
        var btn = this;
        var resultDiv = document.getElementById('miad-check-result');
        btn.disabled = true;
        btn.textContent = 'Vérification…';
        resultDiv.innerHTML = '';
        fetch(<?php echo wp_json_encode( $endpoint ); ?>, {
            headers: { 'x-miad-products-secret': <?php echo wp_json_encode( $secret ); ?> }
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var html = '<table class="widefat"><thead><tr><th>Service</th><th>Statut</th></tr></thead><tbody>';
                (data.checks || []).forEach(function (c) {
                    html += '<tr><td>' + c.name + '</td><td>' + (c.ok ? '✅ OK' : '❌ En panne') + '</td></tr>';
                });
                html += '</tbody></table>';
                html += '<p style="margin-top:10px;font-weight:bold">' + (data.ok ? '✅ Tout fonctionne.' : '⚠️ Un ou plusieurs services sont en panne.') + '</p>';
                html += '<p style="color:#888;font-size:12px">Vérifié à : ' + data.checked_at + '</p>';
                resultDiv.innerHTML = html;
            })
            .catch(function () {
                resultDiv.innerHTML = '<p style="color:red">Erreur réseau lors de la vérification.</p>';
            })
            .finally(function () {
                btn.disabled = false;
                btn.textContent = 'Vérifier maintenant';
            });
    });
    </script>
    <?php
}
