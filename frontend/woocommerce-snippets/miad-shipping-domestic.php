<?php
/**
 * Plugin Name: MIAD Domestic Shipping (Sénégal)
 * Description: Calcul des frais de livraison nationale par tranche de
 *              distance (vendeur -> client), adresse d'expédition vendeur,
 *              statuts de livraison domestique. Système séparé de
 *              miad-shipping-rates.php (zones internationales par pays) —
 *              ce fichier ne touche pas aux tarifs internationaux existants.
 * Version: 1.0
 * Author: MIAD Market
 *
 * Cahier des charges reçu le 2026-08-17 (V1 Sénégal). Portée volontairement
 * limitée aux priorités listées section 17 du document : distance vendeur
 * -> client (à vol d'oiseau si pas de GPS des deux côtés, avec repli sur un
 * tableau de coordonnées des principales villes), tranches tarifaires
 * modifiables depuis l'admin sans redéploiement, prise en charge multi-
 * vendeur (chaque vendeur calculé séparément côté frontend), statuts de
 * livraison domestiques. Les évolutions listées section 16 (API
 * transporteurs, OTP, points relais, optimisation de tournées...) ne sont
 * PAS dans cette version — prévues explicitement comme suite par le document
 * lui-même.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// Référencer INTERNAL_API_SECRET sans garde plante en PHP 8+ (constante non
// définie = erreur fatale, pas juste un warning) si ce fichier charge avant
// wp-config.php ne l'a définie — même garde que miad-cart-recovery.php /
// miad-recommendations-api.php / miad-rep-api.php.
function miad_domestic_internal_secret(): ?string {
    return defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
}

/* ═══════════════════════════════════════════════════════════════════
   1. COORDONNÉES DES PRINCIPALES VILLES — repli si pas de GPS précis
═══════════════════════════════════════════════════════════════════ */

// Chef-lieux de région + quelques villes secondaires fréquemment vues dans
// les adresses vendeurs/clients actuels (Rufisque, Kaolack déjà citées dans
// le cahier des charges). Complétable depuis ce fichier au besoin — pas
// encore exposé à l'admin (la géocodification fine viendra avec une vraie
// intégration cartographique, section 6 du document).
function miad_domestic_city_coords(): array {
    return [
        'dakar'        => [ 14.6928, -17.4467 ],
        'pikine'       => [ 14.7549, -17.3900 ],
        'guediawaye'   => [ 14.7692, -17.3897 ],
        'rufisque'     => [ 14.7167, -17.2667 ],
        'thies'        => [ 14.7910, -16.9260 ],
        'mbour'        => [ 14.4198, -16.9646 ],
        'kaolack'      => [ 14.1520, -16.0728 ],
        'kaffrine'     => [ 14.1059, -15.5486 ],
        'fatick'       => [ 14.3390, -16.4110 ],
        'diourbel'     => [ 14.6559, -16.2331 ],
        'touba'        => [ 14.8500, -15.8833 ],
        'louga'        => [ 15.6170, -16.2240 ],
        'saint-louis'  => [ 16.0179, -16.4896 ],
        'saintlouis'   => [ 16.0179, -16.4896 ],
        'matam'        => [ 15.6559, -13.2548 ],
        'tambacounda'  => [ 13.7671, -13.6673 ],
        'kedougou'     => [ 12.5556, -12.1746 ],
        'kolda'        => [ 12.8939, -14.9412 ],
        'sedhiou'      => [ 12.7081, -15.5569 ],
        'ziguinchor'   => [ 12.5833, -16.2719 ],
    ];
}

// Distance à vol d'oiseau (formule de Haversine) — approximation volontaire
// tant qu'aucune API d'itinéraire routier n'est branchée (section 6 : "si
// la distance ne peut pas être calculée [par la route], prévoir une
// solution de secours" — c'est cette solution-là).
function miad_domestic_haversine_km( float $lat1, float $lng1, float $lat2, float $lng2 ): float {
    $earth_radius = 6371; // km
    $d_lat = deg2rad( $lat2 - $lat1 );
    $d_lng = deg2rad( $lng2 - $lng1 );
    $a = sin( $d_lat / 2 ) ** 2 + cos( deg2rad( $lat1 ) ) * cos( deg2rad( $lat2 ) ) * sin( $d_lng / 2 ) ** 2;
    $c = 2 * atan2( sqrt( $a ), sqrt( 1 - $a ) );
    return $earth_radius * $c;
}

function miad_domestic_resolve_city_coords( string $city ): ?array {
    $key = strtolower( trim( str_replace( [ 'é', 'è', 'ê', "'", '-' ], [ 'e', 'e', 'e', '', '' ], $city ) ) );
    $coords = miad_domestic_city_coords();
    return $coords[ $key ] ?? null;
}

/* ═══════════════════════════════════════════════════════════════════
   2. TRANCHES TARIFAIRES — option WP, modifiable depuis l'admin
═══════════════════════════════════════════════════════════════════ */

define( 'MIAD_DOMESTIC_TIERS_OPTION', 'miad_domestic_shipping_tiers' );
define( 'MIAD_DOMESTIC_FREE_THRESHOLD_OPTION', 'miad_domestic_free_shipping_threshold' );

// Les prix de la grille sont saisis et stockés en FCFA (comme le cahier des
// charges les exprime, et comme un vendeur/admin sénégalais raisonne
// naturellement pour un frais de livraison local) — alors que TOUT le reste
// du catalogue (prix produits, sous-total panier, seuil de livraison
// gratuite) est en USD réel (voir la règle "Prix des produits" de ce
// dépôt). miad_domestic_fcfa_to_usd() fait la conversion au moment du
// calcul, pour que le prix de livraison injecté dans shippingTotal côté
// checkout reste dans la même unité que tout le reste et ne fausse pas le
// total — sans ça un tarif "1500" (FCFA) traité comme 1500 USD aurait fait
// exploser le total affiché.
define( 'MIAD_DOMESTIC_FCFA_PER_USD', 600 );

function miad_domestic_fcfa_to_usd( float $fcfa ): float {
    return round( $fcfa / MIAD_DOMESTIC_FCFA_PER_USD, 2 );
}

// Grille initiale du cahier des charges (section 2) — "n'est pas définitive",
// modifiable ensuite entièrement depuis l'onglet admin sans toucher au code.
// Prix en FCFA.
function miad_domestic_default_tiers(): array {
    return [
        [ 'id' => 1, 'min_km' => 0,   'max_km' => 10,  'price' => 1500, 'eta_label' => '24-48h',  'active' => true ],
        [ 'id' => 2, 'min_km' => 10,  'max_km' => 20,  'price' => 2000, 'eta_label' => '24-48h',  'active' => true ],
        [ 'id' => 3, 'min_km' => 20,  'max_km' => 50,  'price' => 3000, 'eta_label' => '1-3 jours', 'active' => true ],
        [ 'id' => 4, 'min_km' => 50,  'max_km' => 100, 'price' => 4000, 'eta_label' => '1-3 jours', 'active' => true ],
        [ 'id' => 5, 'min_km' => 100, 'max_km' => 200, 'price' => 5000, 'eta_label' => '2-5 jours', 'active' => true ],
        [ 'id' => 6, 'min_km' => 200, 'max_km' => 350, 'price' => 6000, 'eta_label' => '2-5 jours', 'active' => true ],
        [ 'id' => 7, 'min_km' => 350, 'max_km' => 500, 'price' => 7000, 'eta_label' => '3-7 jours', 'active' => true ],
        [ 'id' => 8, 'min_km' => 500, 'max_km' => null,'price' => 8000, 'eta_label' => '3-7 jours', 'active' => true ],
    ];
}

function miad_domestic_get_tiers(): array {
    $tiers = get_option( MIAD_DOMESTIC_TIERS_OPTION, null );
    return is_array( $tiers ) && ! empty( $tiers ) ? $tiers : miad_domestic_default_tiers();
}

function miad_domestic_find_tier( float $distance_km ): ?array {
    foreach ( miad_domestic_get_tiers() as $tier ) {
        if ( empty( $tier['active'] ) ) continue;
        $min = (float) $tier['min_km'];
        $max = $tier['max_km'] === null || $tier['max_km'] === '' ? null : (float) $tier['max_km'];
        if ( $distance_km >= $min && ( $max === null || $distance_km < $max ) ) return $tier;
    }
    return null;
}

/* ═══════════════════════════════════════════════════════════════════
   3. ADRESSE D'EXPÉDITION VENDEUR
═══════════════════════════════════════════════════════════════════ */

define( 'MIAD_VENDOR_SHIP_ADDRESS_META', '_miad_vendor_shipping_address' );

function miad_domestic_get_vendor_address( int $vendor_id ): ?array {
    $raw = get_user_meta( $vendor_id, MIAD_VENDOR_SHIP_ADDRESS_META, true );
    if ( ! $raw ) return null;
    $data = json_decode( (string) $raw, true );
    return is_array( $data ) ? $data : null;
}

/* ═══════════════════════════════════════════════════════════════════
   4. STATUTS DE LIVRAISON DOMESTIQUE (distincts des étapes internationales
      de miad-representative.php, qui supposent un représentant pays +
      transporteur international — sans objet pour une livraison Dakar ->
      Thiès. Voir cahier des charges section 12.)
═══════════════════════════════════════════════════════════════════ */

function miad_domestic_delivery_stages(): array {
    return [
        'confirmed'         => 'Commande confirmée',
        'preparing'         => 'En préparation chez le vendeur',
        'ready_for_pickup'  => 'Prête pour récupération',
        'picked_up'         => 'Récupérée',
        'in_transit'        => 'En cours de livraison',
        'delivered'         => 'Livrée',
        'failed'            => 'Échec de livraison',
        'returned'          => 'Retournée / annulée',
    ];
}

define( 'MIAD_DOMESTIC_STAGE_META', '_miad_domestic_delivery_stage' );
define( 'MIAD_DOMESTIC_FAILURE_REASON_META', '_miad_domestic_failure_reason' );

// Exposé sur GET wc/v3/orders au même titre que _miad_tracking_url
// (miad-representative.php) — permet au client/vendeur de lire le statut
// domestique sans endpoint dédié supplémentaire.
add_filter( 'woocommerce_rest_prepare_shop_order_object', function ( $response, $order, $request ) {
    if ( $order instanceof WC_Order ) {
        $stage = $order->get_meta( MIAD_DOMESTIC_STAGE_META );
        if ( $stage ) {
            $data = $response->get_data();
            $stages = miad_domestic_delivery_stages();
            $data['meta_data'][] = (object) [
                'id' => 0, 'key' => '_miad_domestic_stage', 'value' => $stage,
            ];
            $data['meta_data'][] = (object) [
                'id' => 0, 'key' => '_miad_domestic_stage_label', 'value' => $stages[ $stage ] ?? $stage,
            ];
            $response->set_data( $data );
        }
    }
    return $response;
}, 10, 3 );

/* ═══════════════════════════════════════════════════════════════════
   5. ENDPOINTS REST
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {

    // ── Adresse d'expédition vendeur ────────────────────────────────
    // Sécurité : le Next.js resout et verifie deja l'identite du vendeur
    // (fetchWpUser sur son propre token) avant d'appeler cet endpoint avec
    // le secret partage + le vendorId resolu — meme principe que le reste
    // de l'API (miad-representative.php : "le user.id resolu cote Next.js
    // est le SEUL identifiant transmis a WP, jamais un id fourni par le
    // client final").
    register_rest_route( 'miad-products/v1', '/vendor-shipping-address', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            if ( ! function_exists( 'miad_headless_secret_check' ) ) return false;
            return miad_headless_secret_check( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $vendor_id = (int) $request->get_param( 'vendorId' );
            if ( ! $vendor_id || ! get_userdata( $vendor_id ) ) {
                return new WP_REST_Response( [ 'error' => 'vendorId invalide.' ], 400 );
            }

            $address = [
                'region'   => sanitize_text_field( (string) ( $request->get_param( 'region' ) ?? '' ) ),
                'city'     => sanitize_text_field( (string) ( $request->get_param( 'city' ) ?? '' ) ),
                'quartier' => sanitize_text_field( (string) ( $request->get_param( 'quartier' ) ?? '' ) ),
                'address'  => sanitize_text_field( (string) ( $request->get_param( 'address' ) ?? '' ) ),
                'phone'    => sanitize_text_field( (string) ( $request->get_param( 'phone' ) ?? '' ) ),
                'lat'      => $request->get_param( 'lat' ) !== null ? (float) $request->get_param( 'lat' ) : null,
                'lng'      => $request->get_param( 'lng' ) !== null ? (float) $request->get_param( 'lng' ) : null,
            ];

            if ( ! $address['city'] ) {
                return new WP_REST_Response( [ 'error' => 'city requis.' ], 400 );
            }

            update_user_meta( $vendor_id, MIAD_VENDOR_SHIP_ADDRESS_META, wp_json_encode( $address ) );

            return new WP_REST_Response( [ 'ok' => true, 'vendorId' => $vendor_id, 'address' => $address ], 200 );
        },
    ] );

    register_rest_route( 'miad-products/v1', '/vendor-shipping-address', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            if ( ! function_exists( 'miad_headless_secret_check' ) ) return false;
            return miad_headless_secret_check( $request );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $vendor_id = (int) $request->get_param( 'vendorId' );
            if ( ! $vendor_id ) return new WP_REST_Response( [ 'error' => 'vendorId requis.' ], 400 );
            $address = miad_domestic_get_vendor_address( $vendor_id );
            return new WP_REST_Response( [ 'ok' => true, 'address' => $address ], 200 );
        },
    ] );

    // ── Tranches tarifaires (admin) ─────────────────────────────────
    register_rest_route( 'miad/v1', '/shipping-domestic/tiers', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return (string) miad_domestic_internal_secret() !== '' && hash_equals( (string) miad_domestic_internal_secret(), (string) $request->get_header( 'X-Headless-Secret' ) );
        },
        'callback' => function () {
            return new WP_REST_Response( [
                'ok'               => true,
                'tiers'            => miad_domestic_get_tiers(),
                'free_threshold'   => (float) get_option( MIAD_DOMESTIC_FREE_THRESHOLD_OPTION, 0 ),
            ], 200 );
        },
    ] );

    register_rest_route( 'miad/v1', '/shipping-domestic/tiers', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return (string) miad_domestic_internal_secret() !== '' && hash_equals( (string) miad_domestic_internal_secret(), (string) $request->get_header( 'X-Headless-Secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $tiers = $request->get_param( 'tiers' );
            if ( ! is_array( $tiers ) ) {
                return new WP_REST_Response( [ 'error' => 'tiers (array) requis.' ], 400 );
            }
            $clean = [];
            foreach ( $tiers as $i => $t ) {
                $clean[] = [
                    'id'        => (int) ( $t['id'] ?? ( $i + 1 ) ),
                    'min_km'    => (float) ( $t['min_km'] ?? 0 ),
                    'max_km'    => ( $t['max_km'] === null || $t['max_km'] === '' ) ? null : (float) $t['max_km'],
                    'price'     => (float) ( $t['price'] ?? 0 ),
                    'eta_label' => sanitize_text_field( (string) ( $t['eta_label'] ?? '' ) ),
                    'active'    => ! empty( $t['active'] ),
                ];
            }
            update_option( MIAD_DOMESTIC_TIERS_OPTION, $clean );

            if ( $request->get_param( 'free_threshold' ) !== null ) {
                update_option( MIAD_DOMESTIC_FREE_THRESHOLD_OPTION, (float) $request->get_param( 'free_threshold' ) );
            }

            return new WP_REST_Response( [ 'ok' => true, 'tiers' => $clean ], 200 );
        },
    ] );

    // ── Calcul du prix (public — appelé en direct au checkout, comme
    //    /wp-json/miad/v1/shipping-rates pour les zones internationales) ──
    register_rest_route( 'miad/v1', '/shipping-domestic/calculate', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback' => function ( WP_REST_Request $request ) {
            $vendor_id  = (int) $request->get_param( 'vendorId' );
            $buyer_city = sanitize_text_field( (string) ( $request->get_param( 'buyerCity' ) ?? '' ) );
            $buyer_lat  = $request->get_param( 'buyerLat' ) !== null ? (float) $request->get_param( 'buyerLat' ) : null;
            $buyer_lng  = $request->get_param( 'buyerLng' ) !== null ? (float) $request->get_param( 'buyerLng' ) : null;

            if ( ! $vendor_id ) {
                return new WP_REST_Response( [ 'error' => 'vendorId requis.' ], 400 );
            }

            $vendor_address = miad_domestic_get_vendor_address( $vendor_id );

            // Résolution des coordonnées vendeur : GPS enregistré en priorité,
            // sinon ville de son adresse d'expédition, sinon ville de sa
            // boutique Dokan (le seul champ toujours disponible aujourd'hui).
            $origin = null;
            $origin_source = 'none';
            if ( $vendor_address && $vendor_address['lat'] && $vendor_address['lng'] ) {
                $origin = [ $vendor_address['lat'], $vendor_address['lng'] ];
                $origin_source = 'vendor_gps';
            } elseif ( $vendor_address && ! empty( $vendor_address['city'] ) ) {
                $origin = miad_domestic_resolve_city_coords( $vendor_address['city'] );
                if ( $origin ) $origin_source = 'vendor_city';
            }
            if ( ! $origin && function_exists( 'dokan_get_store_info' ) ) {
                $store_info = dokan_get_store_info( $vendor_id );
                $dokan_city = $store_info['address']['city'] ?? '';
                if ( $dokan_city ) {
                    $origin = miad_domestic_resolve_city_coords( $dokan_city );
                    if ( $origin ) $origin_source = 'dokan_city';
                }
            }

            // Résolution des coordonnées client : GPS transmis en priorité,
            // sinon la ville tapée dans le formulaire.
            $dest = null;
            $dest_source = 'none';
            if ( $buyer_lat && $buyer_lng ) {
                $dest = [ $buyer_lat, $buyer_lng ];
                $dest_source = 'buyer_gps';
            } elseif ( $buyer_city ) {
                $dest = miad_domestic_resolve_city_coords( $buyer_city );
                if ( $dest ) $dest_source = 'buyer_city';
            }

            // Solution de secours (section 6 du cahier des charges) : si la
            // distance ne peut vraiment pas être déterminée (aucune ville
            // reconnue, pas de GPS), on applique la tranche médiane plutôt
            // que de bloquer le checkout — mieux vaut un tarif approximatif
            // affiché clairement que pas de tarif du tout.
            if ( ! $origin || ! $dest ) {
                $tiers = array_values( array_filter( miad_domestic_get_tiers(), fn( $t ) => ! empty( $t['active'] ) ) );
                $fallback_tier = $tiers[ intdiv( count( $tiers ), 2 ) ] ?? null;
                $fallback_fcfa = $fallback_tier ? (float) $fallback_tier['price'] : 3000;
                return new WP_REST_Response( [
                    'ok'             => true,
                    'distance_km'    => null,
                    'price'          => miad_domestic_fcfa_to_usd( $fallback_fcfa ),
                    'price_fcfa'     => $fallback_fcfa,
                    'tier_label'     => $fallback_tier ? ( $fallback_tier['min_km'] . '-' . ( $fallback_tier['max_km'] ?? '∞' ) . ' km' ) : 'estimation',
                    'eta_label'      => $fallback_tier['eta_label'] ?? null,
                    'resolved_from'  => 'fallback_default',
                    'origin_source'  => $origin_source,
                    'dest_source'    => $dest_source,
                ], 200 );
            }

            $distance = miad_domestic_haversine_km( $origin[0], $origin[1], $dest[0], $dest[1] );
            $tier = miad_domestic_find_tier( $distance );

            if ( ! $tier ) {
                // Distance hors de toutes les tranches actives (ex: toutes
                // désactivées sauf les petites, et distance très grande) :
                // repli sur la tranche la plus élevée disponible.
                $tiers = array_values( array_filter( miad_domestic_get_tiers(), fn( $t ) => ! empty( $t['active'] ) ) );
                $tier = end( $tiers ) ?: null;
            }

            $free_threshold = (float) get_option( MIAD_DOMESTIC_FREE_THRESHOLD_OPTION, 0 );
            $cart_total = (float) ( $request->get_param( 'cartTotal' ) ?? 0 ); // USD, comme le sous-total panier
            $price_fcfa = $tier ? (float) $tier['price'] : 3000;
            $price_usd  = miad_domestic_fcfa_to_usd( $price_fcfa );
            $free  = $free_threshold > 0 && $cart_total >= $free_threshold;

            return new WP_REST_Response( [
                'ok'            => true,
                'distance_km'   => round( $distance, 1 ),
                'price'         => $free ? 0 : $price_usd,
                'price_fcfa'    => $free ? 0 : $price_fcfa,
                'original_price'=> $price_usd,
                'free_shipping' => $free,
                'tier_label'    => $tier ? ( $tier['min_km'] . '-' . ( $tier['max_km'] ?? '∞' ) . ' km' ) : null,
                'eta_label'     => $tier['eta_label'] ?? null,
                'resolved_from' => 'calculated',
                'origin_source' => $origin_source,
                'dest_source'   => $dest_source,
            ], 200 );
        },
    ] );

    // ── Statut de livraison domestique (admin) ──────────────────────
    register_rest_route( 'miad/v1', '/shipping-domestic/order-stage', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            return (string) miad_domestic_internal_secret() !== '' && hash_equals( (string) miad_domestic_internal_secret(), (string) $request->get_header( 'X-Headless-Secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $order_id = (int) $request->get_param( 'orderId' );
            $stage    = sanitize_key( (string) $request->get_param( 'stage' ) );
            $reason   = sanitize_text_field( (string) ( $request->get_param( 'reason' ) ?? '' ) );
            $stages   = miad_domestic_delivery_stages();

            $order = wc_get_order( $order_id );
            if ( ! $order ) return new WP_REST_Response( [ 'error' => 'Commande introuvable.' ], 404 );
            if ( ! isset( $stages[ $stage ] ) ) return new WP_REST_Response( [ 'error' => 'Étape invalide.' ], 400 );

            $order->update_meta_data( MIAD_DOMESTIC_STAGE_META, $stage );
            if ( in_array( $stage, [ 'failed', 'returned' ], true ) && $reason ) {
                $order->update_meta_data( MIAD_DOMESTIC_FAILURE_REASON_META, $reason );
            }
            $order->add_order_note( 'MIAD Livraison Sénégal — ' . $stages[ $stage ] . ( $reason ? ' (' . $reason . ')' : '' ) );
            $order->save();

            return new WP_REST_Response( [ 'ok' => true, 'orderId' => $order_id, 'stage' => $stage, 'label' => $stages[ $stage ] ], 200 );
        },
    ] );
} );
