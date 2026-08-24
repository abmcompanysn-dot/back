
/**
 * Plugin Name: MIAD Representative Manager
 * Description: Gestionnaire de représentants pays — chaîne de livraison complète
 *              (Vendeur → Représentant → Transport local → Transport international),
 *              notifications WhatsApp Twilio, tableau de bord dédié.
 * Version: 3.0
 * Author: MIAD Market
 *
 * INSTALLATION : Code Snippets (WordPress) ou functions.php
 * NÉCESSITE    : WooCommerce + Dokan (lite ou pro)
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   0. VÉRIFICATION DOKAN
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_init', function () {
    if ( is_plugin_active( 'dokan-lite/dokan.php' ) || is_plugin_active( 'dokan-pro/dokan-pro.php' ) ) return;
    add_action( 'admin_notices', function () {
        echo '<div class="error"><p><strong>MIAD Representative Manager</strong> nécessite le plugin <strong>Dokan</strong>.</p></div>';
    } );
} );

/* ═══════════════════════════════════════════════════════════════════
   1. RÔLE + REDIRECTIONS
═══════════════════════════════════════════════════════════════════ */

add_action( 'init', function () {
    add_role( 'miad_representative', 'Représentant Pays', [
        'read'         => true,
        'list_users'   => true,
        'upload_files' => true,
    ] );
    add_role( 'miad_super_rep', 'Super Représentant', [
        'read'           => true,
        'list_users'     => true,
        'upload_files'   => true,
        'miad_super_rep' => true, // capacité unique pour vérification rapide
    ] );
} );

add_action( 'admin_init', function () {
    if ( current_user_can( 'manage_options' ) || wp_doing_ajax() ) return;
    if ( ! current_user_can( 'miad_representative' ) && ! current_user_can( 'miad_super_rep' ) ) return;
    global $pagenow;
    if ( $pagenow === 'profile.php' ) return;
    wp_redirect( home_url( '/espace-representant/' ) );
    exit;
} );

add_filter( 'woocommerce_login_redirect', 'miad_rep_login_redirect', 999, 2 );
add_filter( 'login_redirect', function ( $r, $req, $user ) {
    return miad_rep_login_redirect( $r, $user );
}, 999, 3 );

function miad_rep_login_redirect( $redirect, $user ) {
    if ( is_a( $user, 'WP_User' ) && array_intersect( [ 'miad_representative', 'miad_super_rep' ], (array) $user->roles ) ) {
        return home_url( '/espace-representant/' );
    }
    return $redirect;
}

// Crée la page /espace-representant/ si absente
add_action( 'init', function () {
    if ( get_page_by_path( 'espace-representant' ) ) return;
    wp_insert_post( [
        'post_title'     => 'Espace Représentant',
        'post_name'      => 'espace-representant',
        'post_content'   => '[miad_rep_dashboard]',
        'post_status'    => 'publish',
        'post_type'      => 'page',
        'comment_status' => 'closed',
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   2. CHAÎNE DE LIVRAISON — étapes
═══════════════════════════════════════════════════════════════════ */

function miad_delivery_stages(): array {
    return [
        'vendor_confirmed' => [ 'label' => '✅ Vendeur a confirmé',              'color' => '#059669' ],
        'rep_received'     => [ 'label' => '📥 Représentant a réceptionné',      'color' => '#2563eb' ],
        'local_pickup'     => [ 'label' => '🚚 Transport local récupéré',        'color' => '#d97706' ],
        'intl_handoff'     => [ 'label' => '✈️ Remis transport international',   'color' => '#7c3aed' ],
        'delivered'        => [ 'label' => '🎉 Livré au client',                 'color' => '#005826' ],
    ];
}

function miad_get_delivery_stage( int $order_id ): string {
    return (string) get_post_meta( $order_id, '_miad_delivery_stage', true );
}

function miad_set_delivery_stage( int $order_id, string $stage ): void {
    $stages = miad_delivery_stages();
    if ( ! isset( $stages[ $stage ] ) ) return;
    update_post_meta( $order_id, '_miad_delivery_stage', $stage );
    $order = wc_get_order( $order_id );
    if ( $order ) $order->add_order_note( 'MIAD — Étape livraison : ' . $stages[ $stage ]['label'] );
}

/**
 * Jeton de suivi par commande — permet au client d'ouvrir sa page de suivi
 * directement depuis le lien WhatsApp/email, sans se reconnecter (comme
 * AliExpress), sans pour autant qu'un ID de commande devinable donne accès
 * à la commande de quelqu'un d'autre. HMAC dérivé du secret partagé déjà
 * utilisé par miad-products-api.php (pas de nouveau secret à gérer).
 */
function miad_order_tracking_token( int $order_id ): string {
    $secret = function_exists( 'miad_products_api_secret' ) ? miad_products_api_secret() : wp_salt();
    return substr( hash_hmac( 'sha256', (string) $order_id, $secret ), 0, 24 );
}

function miad_order_tracking_url( WC_Order $order ): string {
    return 'https://miadmarket.com/suivi/' . $order->get_id() . '/' . miad_order_tracking_token( $order->get_id() );
}

// Injecte l'URL de suivi dans meta_data de la réponse REST wc/v3/orders —
// calculée à la volée (pas stockée en meta), donc dispo pour toutes les
// commandes (anciennes et nouvelles) sans migration. Consommée par
// OrderDetailPanel.tsx (bordereau de livraison avec QR code, demandé le
// 2026-07-26) via la clé `_miad_tracking_url`.
add_filter( 'woocommerce_rest_prepare_shop_order_object', function ( $response, $order, $request ) {
    if ( $order instanceof WC_Order ) {
        $data = $response->get_data();
        $data['meta_data'][] = (object) [
            'id'    => 0,
            'key'   => '_miad_tracking_url',
            'value' => miad_order_tracking_url( $order ),
        ];
        $response->set_data( $data );
    }
    return $response;
}, 10, 3 );

/**
 * Points de passage géolocalisés — demandé le 2026-07-26 : le même
 * bordereau/QR code (voir OrderDetailPanel.tsx) accompagne physiquement le
 * colis tout au long de la chaîne (vendeur → représentant → transport local
 * → international → livraison), sans en réimprimer un nouveau à chaque
 * étape. Quiconque ouvre le lien de suivi peut appuyer sur "Confirmer un
 * point de passage" pour enregistrer sa position GPS à cet instant — un
 * historique qui s'accumule (append-only), affiché sur la page de suivi
 * client en plus des étapes manuelles (_miad_delivery_stage) et des
 * événements DHL. Pas d'authentification : sécurisé par le même token HMAC
 * que /order-tracking (miad_order_tracking_token), donc accessible à
 * quiconque a le lien physique (bordereau), comme demandé.
 */
function miad_scan_checkpoints_get( int $order_id ): array {
    $raw = get_post_meta( $order_id, '_miad_scan_checkpoints', true );
    $checkpoints = $raw ? json_decode( (string) $raw, true ) : [];
    return is_array( $checkpoints ) ? $checkpoints : [];
}

// Nominatim (OpenStreetMap) : pas de clé API à gérer, contrairement à Google
// Maps — un simple User-Agent identifiable suffit (exigé par leur politique
// d'usage). Reverse-géocodage fait côté serveur (le client n'envoie que
// lat/lng) pour ne pas dépendre d'une clé API côté navigateur.
function miad_reverse_geocode( float $lat, float $lng ): string {
    $url = add_query_arg( [
        'format' => 'jsonv2',
        'lat'    => $lat,
        'lon'    => $lng,
        'zoom'   => 14, // niveau ville/quartier — suffisant pour un point de passage logistique
    ], 'https://nominatim.openstreetmap.org/reverse' );

    $response = wp_remote_get( $url, [
        'headers' => [ 'User-Agent' => 'MIADMarket/1.0 (contact@miadmarket.com)' ],
        'timeout' => 8,
    ] );

    if ( is_wp_error( $response ) ) return '';
    $body = json_decode( wp_remote_retrieve_body( $response ), true );
    return is_array( $body ) ? (string) ( $body['display_name'] ?? '' ) : '';
}

function miad_scan_checkpoint_add( int $order_id, float $lat, float $lng ): array {
    $checkpoints = miad_scan_checkpoints_get( $order_id );
    $checkpoint  = [
        'timestamp' => current_time( 'mysql', true ),
        'lat'       => $lat,
        'lng'       => $lng,
        'address'   => miad_reverse_geocode( $lat, $lng ),
    ];
    $checkpoints[] = $checkpoint;
    // Plafonné à 50 points — largement suffisant pour un trajet de colis,
    // évite une croissance illimitée de la meta si le lien est scanné à répétition.
    if ( count( $checkpoints ) > 50 ) {
        $checkpoints = array_slice( $checkpoints, -50 );
    }
    update_post_meta( $order_id, '_miad_scan_checkpoints', wp_json_encode( $checkpoints ) );

    $order = wc_get_order( $order_id );
    if ( $order ) {
        $order->add_order_note( 'MIAD — Point de passage scanné' . ( $checkpoint['address'] ? ' : ' . $checkpoint['address'] : '' ) );
    }

    return $checkpoint;
}

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/scan-checkpoint', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true', // sécurisé par le token, comme /order-tracking
        'callback'            => function ( WP_REST_Request $request ) {
            $order_id = (int) $request->get_param( 'order_id' );
            $token    = (string) $request->get_param( 'token' );
            $lat      = $request->get_param( 'lat' );
            $lng      = $request->get_param( 'lng' );

            if ( ! $order_id || ! $token || ! hash_equals( miad_order_tracking_token( $order_id ), $token ) ) {
                return new WP_REST_Response( [ 'error' => 'Lien de suivi invalide ou expiré.' ], 403 );
            }
            if ( $lat === null || $lng === null ) {
                return new WP_REST_Response( [ 'error' => 'lat et lng requis.' ], 400 );
            }
            if ( ! wc_get_order( $order_id ) ) {
                return new WP_REST_Response( [ 'error' => 'Commande introuvable.' ], 404 );
            }

            $checkpoint = miad_scan_checkpoint_add( $order_id, (float) $lat, (float) $lng );

            return new WP_REST_Response( [ 'ok' => true, 'checkpoint' => $checkpoint ], 200 );
        },
        'args' => [
            'order_id' => [ 'required' => true ],
            'token'    => [ 'required' => true ],
            'lat'      => [ 'required' => true ],
            'lng'      => [ 'required' => true ],
        ],
    ] );
} );

// Endpoint public (pas d'auth WP — sécurisé par le token dans l'URL, comme
// un lien de suivi AliExpress) consommé par app/api/order-tracking/route.ts.
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/order-tracking', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $request ) {
            $order_id = (int) $request->get_param( 'order_id' );
            $token    = (string) $request->get_param( 'token' );
            if ( ! $order_id || ! $token || ! hash_equals( miad_order_tracking_token( $order_id ), $token ) ) {
                return new WP_REST_Response( [ 'error' => 'Lien de suivi invalide ou expiré.' ], 403 );
            }
            $order = wc_get_order( $order_id );
            if ( ! $order ) return new WP_REST_Response( [ 'error' => 'Commande introuvable.' ], 404 );

            $stage  = miad_get_delivery_stage( $order_id );
            $stages = miad_delivery_stages();
            $items  = [];
            foreach ( $order->get_items() as $item ) {
                $items[] = [ 'name' => $item->get_name(), 'quantity' => $item->get_quantity() ];
            }

            // Événements DHL réels (checkpoints) quand un numéro de suivi
            // existe — le tracking devient "automatique" (demandé le
            // 2026-07-20) au lieu de dépendre uniquement des étapes posées
            // à la main par le représentant. Défini dans integration-dhl.php
            // (chargé comme snippet séparé) — appel protégé par
            // function_exists() si ce fichier n'est pas actif.
            $tracking_number = $order->get_meta( '_miad_dhl_tracking_number' ) ?: '';
            $dhl_events = [];
            $dhl_status = '';
            if ( $tracking_number && function_exists( 'miad_dhl_get_tracking_info' ) ) {
                $dhl_result = miad_dhl_get_tracking_info( $tracking_number );
                if ( is_array( $dhl_result ) && empty( $dhl_result['error'] ) && ! empty( $dhl_result['events'] ) ) {
                    $dhl_status = $dhl_result['status']['description'] ?? '';
                    foreach ( $dhl_result['events'] as $event ) {
                        $dhl_events[] = [
                            'timestamp'   => $event['timestamp'] ?? '',
                            'description' => $event['description'] ?? '',
                            'location'    => $event['location']['address']['addressLocality'] ?? '',
                        ];
                    }
                }
            }

            return new WP_REST_Response( [
                'ok'              => true,
                'order_number'    => $order->get_order_number(),
                'status'          => $order->get_status(),
                'delivery_stage'  => $stage,
                'stage_label'     => ( $stage && isset( $stages[ $stage ] ) ) ? $stages[ $stage ]['label'] : null,
                'shipping_method' => $order->get_shipping_method() ?: 'MIAD Standard',
                'tracking_number' => $tracking_number,
                'dhl_status'      => $dhl_status,
                'dhl_events'      => $dhl_events,
                'total'           => miad_order_total_plain( $order ),
                'date'            => $order->get_date_created() ? $order->get_date_created()->date( 'Y-m-d H:i' ) : '',
                'client_name'     => $order->get_billing_first_name(),
                'items'           => $items,
                'scan_checkpoints'=> miad_scan_checkpoints_get( $order_id ),
            ], 200 );
        },
        'args' => [ 'order_id' => [ 'required' => true ], 'token' => [ 'required' => true ] ],
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   3. MENU ADMIN
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_menu_page( 'Représentants MIAD', 'Représentants', 'manage_options', 'miad-rep', 'miad_rep_admin_page', 'dashicons-groups', 26 );
    add_menu_page( 'Points de passage MIAD', '📍 Points de passage', 'manage_options', 'miad-scan-checkpoints', 'miad_scan_checkpoints_admin_page', 'dashicons-location-alt', 27 );
} );

// Section dédiée demandée le 2026-07-26 : vue d'ensemble de tous les points
// de passage géolocalisés (voir miad_scan_checkpoint_add ci-dessus),
// commande par commande, les plus récents en premier.
function miad_scan_checkpoints_admin_page(): void {
    global $wpdb;
    $rows = $wpdb->get_results( "
        SELECT post_id, meta_value FROM {$wpdb->postmeta}
        WHERE meta_key = '_miad_scan_checkpoints' AND meta_value != ''
    ", ARRAY_A );

    $all_checkpoints = [];
    foreach ( $rows as $row ) {
        $order_id    = (int) $row['post_id'];
        $checkpoints = json_decode( (string) $row['meta_value'], true );
        if ( ! is_array( $checkpoints ) ) continue;
        $order = wc_get_order( $order_id );
        foreach ( $checkpoints as $cp ) {
            $all_checkpoints[] = [
                'order_id'     => $order_id,
                'order_number' => $order ? $order->get_order_number() : $order_id,
                'timestamp'    => $cp['timestamp'] ?? '',
                'lat'          => $cp['lat'] ?? null,
                'lng'          => $cp['lng'] ?? null,
                'address'      => $cp['address'] ?? '',
            ];
        }
    }
    usort( $all_checkpoints, fn( $a, $b ) => strcmp( $b['timestamp'], $a['timestamp'] ) );

    echo '<div class="wrap"><h1>📍 Points de passage — Suivi colis</h1>';
    echo '<p style="color:#555">Chaque ligne correspond à un scan du QR code du bordereau (voir OrderDetailPanel.tsx) — géolocalisation capturée sur le téléphone de la personne qui a scanné.</p>';
    echo '<table class="wp-list-table widefat fixed striped"><thead><tr><th>Commande</th><th>Date/heure (UTC)</th><th>Adresse</th><th>Coordonnées</th></tr></thead><tbody>';
    if ( empty( $all_checkpoints ) ) {
        echo '<tr><td colspan="4">Aucun point de passage enregistré pour l\'instant.</td></tr>';
    } else {
        foreach ( $all_checkpoints as $cp ) {
            $edit_link = admin_url( 'post.php?post=' . $cp['order_id'] . '&action=edit' );
            $maps_link = ( $cp['lat'] !== null && $cp['lng'] !== null )
                ? sprintf( 'https://www.google.com/maps?q=%s,%s', $cp['lat'], $cp['lng'] )
                : '';
            printf(
                '<tr><td><a href="%s">#%s</a></td><td>%s</td><td>%s</td><td>%s</td></tr>',
                esc_url( $edit_link ), esc_html( $cp['order_number'] ), esc_html( $cp['timestamp'] ),
                esc_html( $cp['address'] ?: '—' ),
                $maps_link ? '<a href="' . esc_url( $maps_link ) . '" target="_blank" rel="noopener">' . esc_html( $cp['lat'] . ', ' . $cp['lng'] ) . '</a>' : '—'
            );
        }
    }
    echo '</tbody></table></div>';
}

function miad_rep_admin_page(): void {
    $tab = sanitize_key( $_GET['tab'] ?? 'list' );
    $tabs = [ 'list' => 'Liste', 'add' => 'Ajouter', 'config' => 'WhatsApp', 'templates' => 'Templates', 'test' => 'Tester', 'logs' => 'Logs' ];
    echo '<div class="wrap"><h1>Gestion des Représentants</h1><nav class="nav-tab-wrapper">';
    foreach ( $tabs as $t => $l ) {
        printf( '<a href="?page=miad-rep&tab=%s" class="nav-tab %s">%s</a>', $t, $tab === $t ? 'nav-tab-active' : '', $l );
    }
    echo '</nav><div style="margin-top:20px">';
    if ( $tab === 'add' )           miad_rep_tab_add();
    elseif ( $tab === 'config' )    miad_rep_tab_config();
    elseif ( $tab === 'templates' ) miad_rep_tab_templates();
    elseif ( $tab === 'test' )      miad_rep_tab_test();
    elseif ( $tab === 'logs' )      miad_rep_tab_logs();
    else                            miad_rep_tab_list();
    echo '</div></div>';
}

function miad_rep_tab_list(): void {
    $reps = get_users( [ 'role' => 'miad_representative' ] );
    echo '<table class="wp-list-table widefat fixed striped"><thead><tr><th>Nom</th><th>Email</th><th>Pays assigné</th><th>WhatsApp</th><th>Action</th></tr></thead><tbody>';
    if ( empty( $reps ) ) {
        echo '<tr><td colspan="5">Aucun représentant.</td></tr>';
    } else {
        foreach ( $reps as $rep ) {
            $cc   = get_user_meta( $rep->ID, 'miad_assigned_country', true );
            $wa   = get_user_meta( $rep->ID, 'miad_rep_whatsapp', true );
            $cname = class_exists( 'WC_Countries' ) ? ( ( new WC_Countries() )->countries[ $cc ] ?? $cc ) : $cc;
            printf( '<tr><td>%s</td><td>%s</td><td><strong>%s</strong></td><td>%s</td><td><a href="%s" class="button">Modifier</a></td></tr>',
                esc_html( $rep->display_name ), esc_html( $rep->user_email ),
                esc_html( $cname ), esc_html( $wa ), get_edit_user_link( $rep->ID ) );
        }
    }
    echo '</tbody></table>';
}

function miad_rep_tab_add(): void {
    if ( isset( $_POST['miad_create_rep'] ) && check_admin_referer( 'miad_create_rep' ) ) {
        $email   = sanitize_email( $_POST['rep_email'] );
        $name    = sanitize_text_field( $_POST['rep_name'] );
        $country = sanitize_text_field( $_POST['rep_country'] );
        $wa      = sanitize_text_field( $_POST['rep_whatsapp'] );
        if ( email_exists( $email ) ) {
            echo '<div class="error"><p>Cet email est déjà utilisé.</p></div>';
        } else {
            $pass    = wp_generate_password( 12, false );
            $user_id = wp_create_user( $email, $pass, $email );
            if ( ! is_wp_error( $user_id ) ) {
                ( new WP_User( $user_id ) )->set_role( 'miad_representative' );
                wp_update_user( [ 'ID' => $user_id, 'display_name' => $name ] );
                update_user_meta( $user_id, 'miad_assigned_country', $country );
                update_user_meta( $user_id, 'miad_rep_whatsapp', $wa );
                wp_mail( $email, 'Vos accès Représentant MIAD',
                    "Bonjour {$name},\n\nIdentifiant : {$email}\nMot de passe : {$pass}\n\nConnectez-vous : " . home_url( '/espace-representant/' ) );
                echo '<div class="updated"><p>Représentant créé. Identifiants envoyés par email.</p></div>';
            } else {
                echo '<div class="error"><p>Erreur : ' . esc_html( $user_id->get_error_message() ) . '</p></div>';
            }
        }
    }
    $countries = class_exists( 'WC_Countries' ) ? ( new WC_Countries() )->get_countries() : [];
    ?>
    <div class="card" style="max-width:600px;padding:20px">
    <form method="post">
        <?php wp_nonce_field( 'miad_create_rep' ); ?>
        <h3>Nouveau Représentant</h3>
        <p><label>Nom : <input type="text" name="rep_name" required style="width:100%"></label></p>
        <p><label>Email : <input type="email" name="rep_email" required style="width:100%"></label></p>
        <p><label>Pays assigné :
            <select name="rep_country" required style="width:100%">
                <option value="">-- Sélectionner --</option>
                <?php foreach ( $countries as $code => $cname ): ?>
                <option value="<?= esc_attr( $code ) ?>"><?= esc_html( $cname ) ?></option>
                <?php endforeach; ?>
            </select>
        </label></p>
        <p><label>WhatsApp : <input type="text" name="rep_whatsapp" placeholder="+221771234567" style="width:100%"></label></p>
        <p><button type="submit" name="miad_create_rep" class="button button-primary">Créer le compte</button></p>
    </form></div>
    <?php
}

function miad_rep_tab_config(): void {
    if ( isset( $_POST['miad_save_config'] ) && check_admin_referer( 'miad_config' ) ) {
        foreach ( [ 'miad_twilio_sid', 'miad_twilio_token', 'miad_twilio_from', 'miad_twilio_admin_whatsapp', 'miad_commercial_contact_phone' ] as $k ) {
            update_option( $k, sanitize_text_field( $_POST[ $k ] ?? '' ) );
        }
        foreach ( [ 'miad_twilio_enable_rep', 'miad_twilio_enable_admin', 'miad_twilio_enable_client' ] as $k ) {
            update_option( $k, isset( $_POST[ $k ] ) ? 'yes' : 'no' );
        }
        echo '<div class="updated"><p>Configuration enregistrée.</p></div>';
    }
    ?>
    <div class="card" style="max-width:700px;padding:20px">
    <form method="post">
        <?php wp_nonce_field( 'miad_config' ); ?>
        <h3>Configuration Twilio (WhatsApp uniquement)</h3>
        <?php foreach ( [
            [ 'miad_twilio_sid',              'Account SID',               'text',     'AC...' ],
            [ 'miad_twilio_token',            'Auth Token',                'password', '' ],
            [ 'miad_twilio_from',             'Numéro WhatsApp Business',  'text',     '+14155238886' ],
            [ 'miad_twilio_admin_whatsapp',   'Numéros Admin (virgule)',    'text',     '+221..., +336...' ],
            [ 'miad_commercial_contact_phone','Contact Commercial',         'text',     '+221...' ],
        ] as $f ): ?>
        <p><label><strong><?= $f[1] ?></strong><br>
            <input type="<?= $f[2] ?>" name="<?= $f[0] ?>" value="<?= esc_attr( get_option( $f[0] ) ) ?>" style="width:100%" placeholder="<?= $f[3] ?>">
        </label></p>
        <?php endforeach; ?>
        <hr>
        <h4>Activer les notifications WhatsApp</h4>
        <?php foreach ( [
            [ 'miad_twilio_enable_rep',   'Représentants (nouvelle commande dans leur zone)' ],
            [ 'miad_twilio_enable_admin', 'Administrateur (toutes les commandes)' ],
            [ 'miad_twilio_enable_client','Clients (confirmation + expédition)' ],
        ] as $f ): ?>
        <p><label><input type="checkbox" name="<?= $f[0] ?>" value="yes" <?php checked( get_option( $f[0], 'no' ), 'yes' ) ?>> <?= $f[1] ?></label></p>
        <?php endforeach; ?>
        <hr>
        <p><strong>Webhook entrant :</strong> <code><?= esc_url( home_url( '/wp-json/miad-whatsapp/v1/incoming' ) ) ?></code></p>
        <p><button type="submit" name="miad_save_config" class="button button-primary">Enregistrer</button></p>
    </form></div>
    <?php
}

function miad_rep_tab_templates(): void {
    $fields = [
        'miad_template_rep_new_order'   => 'Template SID — Représentant (nouvelle commande)',
        'miad_template_client_confirm'  => 'Template SID — Client (confirmation paiement)',
        'miad_template_client_shipped'  => 'Template SID — Client (expédition)',
        'miad_template_admin_new_order' => 'Template SID — Admin (nouvelle commande)',
    ];
    if ( isset( $_POST['miad_save_templates'] ) && check_admin_referer( 'miad_templates' ) ) {
        foreach ( $fields as $k => $l ) update_option( $k, sanitize_text_field( $_POST[ $k ] ?? '' ) );
        echo '<div class="updated"><p>Templates enregistrés.</p></div>';
    }
    ?>
    <div class="card" style="max-width:700px;padding:20px">
    <form method="post">
        <?php wp_nonce_field( 'miad_templates' ); ?>
        <h3>Templates WhatsApp (Content SID Twilio)</h3>
        <p class="description">Créez vos templates approuvés dans la console Twilio et copiez leur SID (commence par HX...).</p>
        <?php foreach ( $fields as $k => $l ): ?>
        <p><label><strong><?= $l ?></strong><br>
            <input type="text" name="<?= $k ?>" value="<?= esc_attr( get_option( $k ) ) ?>" style="width:100%" placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
        </label></p>
        <?php endforeach; ?>
        <p><button type="submit" name="miad_save_templates" class="button button-primary">Enregistrer</button></p>
    </form></div>
    <?php
}

// Renvoie manuellement la notification (email + WhatsApp) d'une commande déjà
// existante, sans recréer de commande de test — demandé le 2026-07-17 pour
// vérifier le contenu (ex: mode de livraison) sans repasser une vraie commande.
function miad_rep_tab_test(): void {
    if ( isset( $_POST['miad_resend_notif'] ) && check_admin_referer( 'miad_resend_notif' ) ) {
        $order_id = (int) ( $_POST['miad_test_order_id'] ?? 0 );
        $order    = $order_id ? wc_get_order( $order_id ) : false;
        if ( ! $order ) {
            echo '<div class="error"><p>Commande #' . esc_html( (string) $order_id ) . ' introuvable.</p></div>';
        } else {
            miad_notify_rep_new_order( $order_id );
            echo '<div class="updated"><p>Notification renvoyée pour la commande #' . esc_html( $order->get_order_number() )
                . ' (mode de livraison : ' . esc_html( $order->get_shipping_method() ?: 'MIAD Standard' ) . ').</p></div>';
        }
    }
    ?>
    <div class="card" style="max-width:600px;padding:20px">
    <form method="post">
        <?php wp_nonce_field( 'miad_resend_notif' ); ?>
        <h3>Renvoyer la notification d'une commande existante</h3>
        <p class="description">Redéclenche l'email + WhatsApp représentant/super-représentant/admin
        pour une commande déjà passée, sans en créer une nouvelle — utile pour vérifier le contenu
        du message (ex: après un changement de template ou de contenu).</p>
        <p><label>ID de la commande : <input type="number" name="miad_test_order_id" required style="width:100%"></label></p>
        <p><button type="submit" name="miad_resend_notif" class="button button-primary">Renvoyer la notification</button></p>
    </form></div>
    <?php
}

function miad_rep_tab_logs(): void {
    $log_file = WP_CONTENT_DIR . '/miad-whatsapp-log.txt';
    if ( isset( $_POST['miad_clear_logs'] ) ) {
        file_put_contents( $log_file, '' );
        echo '<div class="updated"><p>Logs effacés.</p></div>';
    }
    $logs = file_exists( $log_file ) ? file_get_contents( $log_file ) : 'Aucun log.';
    ?>
    <textarea style="width:100%;height:500px;font-family:monospace;font-size:.78rem;background:#f9fafb;padding:10px" readonly><?= esc_textarea( $logs ) ?></textarea>
    <form method="post" style="margin-top:10px">
        <button type="submit" name="miad_clear_logs" class="button">Vider les logs</button>
        <a href="" class="button button-primary">Rafraîchir</a>
    </form>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   4. PROFIL — champs pays + WhatsApp
═══════════════════════════════════════════════════════════════════ */

add_action( 'show_user_profile', 'miad_rep_profile_fields' );
add_action( 'edit_user_profile', 'miad_rep_profile_fields' );
add_action( 'personal_options_update', 'miad_rep_save_profile' );
add_action( 'edit_user_profile_update', 'miad_rep_save_profile' );

function miad_rep_profile_fields( WP_User $user ): void {
    if ( ! in_array( 'miad_representative', (array) $user->roles ) ) return;
    $countries = class_exists( 'WC_Countries' ) ? ( new WC_Countries() )->get_countries() : [];
    $assigned  = get_user_meta( $user->ID, 'miad_assigned_country', true );
    $wa        = get_user_meta( $user->ID, 'miad_rep_whatsapp', true );
    $is_admin  = current_user_can( 'manage_options' );
    ?>
    <h3>Représentant MIAD</h3>
    <table class="form-table">
        <tr>
            <th>Pays assigné</th>
            <td>
                <select name="miad_assigned_country" <?= $is_admin ? '' : 'disabled' ?>>
                    <option value="">-- Sélectionner --</option>
                    <?php foreach ( $countries as $code => $cname ): ?>
                    <option value="<?= esc_attr( $code ) ?>" <?php selected( $assigned, $code ) ?>><?= esc_html( $cname ) ?></option>
                    <?php endforeach; ?>
                </select>
                <?php if ( ! $is_admin ): ?>
                <p class="description">Seul un administrateur peut modifier votre pays.</p>
                <?php endif; ?>
            </td>
        </tr>
        <tr>
            <th>Numéro WhatsApp</th>
            <td><input type="text" name="miad_rep_whatsapp" value="<?= esc_attr( $wa ) ?>" class="regular-text" placeholder="+221771234567"></td>
        </tr>
    </table>
    <?php
}

function miad_rep_save_profile( int $user_id ): void {
    if ( ! current_user_can( 'edit_user', $user_id ) ) return;
    if ( current_user_can( 'manage_options' ) && isset( $_POST['miad_assigned_country'] ) ) {
        update_user_meta( $user_id, 'miad_assigned_country', sanitize_text_field( $_POST['miad_assigned_country'] ) );
    }
    if ( isset( $_POST['miad_rep_whatsapp'] ) ) {
        update_user_meta( $user_id, 'miad_rep_whatsapp', sanitize_text_field( $_POST['miad_rep_whatsapp'] ) );
    }
}

/* ═══════════════════════════════════════════════════════════════════
   5. NOTIFICATIONS AUTOMATIQUES
   Chaîne : Vendeur confirme → Représentant notifié → Transport local
            → Transport international → Client notifié
═══════════════════════════════════════════════════════════════════ */

// Nouvelle commande en traitement → notification représentant + admin
add_action( 'woocommerce_order_status_processing', 'miad_notify_rep_new_order', 15 );

function miad_notify_rep_new_order( int $order_id ): void {
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $notified = [];

    // Méthode de livraison choisie par le client (Standard/Express) — ajoutée
    // le 2026-07-17 aux notifications rep/admin, absente jusque-là alors que
    // le titre est déjà posé sur la commande (voir app/api/orders/route.ts,
    // shipping_lines[0].method_title).
    $delivery_method = $order->get_shipping_method() ?: 'MIAD Standard';

    foreach ( $order->get_items() as $item ) {
        $vendor_id  = (int) get_post_field( 'post_author', $item->get_product_id() );
        $store_info = function_exists( 'dokan_get_store_info' ) ? dokan_get_store_info( $vendor_id ) : [];
        $v_country  = isset( $store_info['address']['country'] ) ? $store_info['address']['country'] : '';
        if ( ! $v_country ) continue;

        $reps = get_users( [ 'role' => 'miad_representative', 'meta_key' => 'miad_assigned_country', 'meta_value' => $v_country ] );
        foreach ( $reps as $rep ) {
            if ( in_array( $rep->ID, $notified ) ) continue;
            $notified[] = $rep->ID;

            $plain_total = miad_order_total_plain( $order );

            // Adresse de livraison checkout → utilisée pour {{5}} WhatsApp
            $raw_addr   = $order->get_formatted_shipping_address() ?: $order->get_formatted_billing_address();
            $plain_addr = $raw_addr
                ? wp_strip_all_tags( preg_replace( '/<br\s*\/?>/i', "\n", $raw_addr ) )
                : '';

            // Email format natif WooCommerce — inclut liens produits, adresse, totaux
            wp_mail(
                $rep->user_email,
                '🔔 Commande #' . $order->get_order_number() . ' — ' . $plain_total . ' — Zone ' . $v_country,
                miad_wc_order_email_html( $order, '🔔 Nouvelle commande #' . $order->get_order_number() ),
                'Content-Type: text/html; charset=UTF-8'
            );

            // WhatsApp représentant
            $rep_wa = get_user_meta( $rep->ID, 'miad_rep_whatsapp', true );
            if ( $rep_wa && get_option( 'miad_twilio_enable_rep', 'yes' ) === 'yes' ) {
                $sid = get_option( 'miad_template_rep_new_order' );
                if ( $sid ) {
                    // Mode de livraison ajouté à la suite de l'adresse plutôt qu'en
                    // variable séparée : pas besoin de retoucher le template Twilio
                    // approuvé (demandé le 2026-07-17).
                    $plain_addr_wa = ( $plain_addr ? str_replace( "\n", ', ', trim( $plain_addr ) ) : 'N/A' ) . ' — Livraison : ' . $delivery_method;
                    $products_parts = [];
                    foreach ( $order->get_items() as $wi ) {
                        $products_parts[] = $wi->get_name() . ' x' . $wi->get_quantity();
                    }
                    $products_wa = implode( ' | ', $products_parts );
                    miad_send_whatsapp( $rep_wa, '', $sid, [
                        '1' => '#' . $order->get_order_number() . ' — ' . $products_wa,
                        '2' => isset( $store_info['store_name'] ) ? $store_info['store_name'] : 'Vendeur',
                        '3' => $plain_total,
                        '4' => $order->get_formatted_billing_full_name(),
                        '5' => $plain_addr_wa,
                        '6' => $products_wa,
                    ] );
                } else {
                    // Fallback sans template — message texte propre
                    $fallback = "🛒 *Nouvelle commande #" . $order->get_order_number() . "*\n" .
                        "Client : " . $order->get_formatted_billing_full_name() . "\n" .
                        "Montant : *" . $plain_total . "*\n" .
                        "Livraison : " . $delivery_method . "\n" .
                        "Date : " . current_time( 'd/m/Y H:i' ) . "\n" .
                        "Tableau de bord : " . home_url( '/espace-representant/' );
                    miad_send_whatsapp( $rep_wa, $fallback );
                }
            }
        }
    }

    // ── Notification Super Représentants (toutes zones) ───────────
    $super_reps = get_users( [ 'role' => 'miad_super_rep' ] );
    if ( ! empty( $super_reps ) ) {
        $plain_total_sr = miad_order_total_plain( $order );

        // Vendeurs + produits + adresse pour WhatsApp
        $all_vendor_names = [];
        $products_parts_sr = [];
        foreach ( $order->get_items() as $sr_item ) {
            $sr_vid   = (int) get_post_field( 'post_author', $sr_item->get_product_id() );
            $sr_sinfo = function_exists( 'dokan_get_store_info' ) ? dokan_get_store_info( $sr_vid ) : [];
            if ( ! empty( $sr_sinfo['store_name'] ) && ! in_array( $sr_sinfo['store_name'], $all_vendor_names, true ) ) {
                $all_vendor_names[] = $sr_sinfo['store_name'];
            }
            $products_parts_sr[] = $sr_item->get_name() . ' x' . $sr_item->get_quantity();
        }
        $vendors_label  = implode( ', ', $all_vendor_names ) ?: 'Vendeur';
        $products_sr_wa = implode( ' | ', $products_parts_sr );

        $raw_addr_sr      = $order->get_formatted_shipping_address() ?: $order->get_formatted_billing_address();
        $plain_addr_sr_wa = ( $raw_addr_sr
            ? str_replace( "\n", ', ', trim( wp_strip_all_tags( preg_replace( '/<br\s*\/?>/i', "\n", $raw_addr_sr ) ) ) )
            : 'N/A' ) . ' — Livraison : ' . $delivery_method;

        foreach ( $super_reps as $srep ) {
            // Email format natif WooCommerce (liens produits, détails complets)
            wp_mail(
                $srep->user_email,
                '🌍 Commande #' . $order->get_order_number() . ' — ' . $plain_total_sr . ' — Toutes zones',
                miad_wc_order_email_html( $order, '🌍 Nouvelle commande #' . $order->get_order_number() . ' — Toutes zones' ),
                'Content-Type: text/html; charset=UTF-8'
            );

            // WhatsApp super représentant — même template que les représentants normaux
            $srep_wa = get_user_meta( $srep->ID, 'miad_rep_whatsapp', true );
            if ( $srep_wa && get_option( 'miad_twilio_enable_rep', 'yes' ) === 'yes' ) {
                $sid_sr = get_option( 'miad_template_rep_new_order' );
                if ( $sid_sr ) {
                    miad_send_whatsapp( $srep_wa, '', $sid_sr, [
                        '1' => '#' . $order->get_order_number() . ' — ' . $products_sr_wa,
                        '2' => $vendors_label,
                        '3' => $plain_total_sr,
                        '4' => $order->get_formatted_billing_full_name(),
                        '5' => $plain_addr_sr_wa,
                        '6' => $products_sr_wa,
                    ] );
                } else {
                    $fallback_sr = "🌍 *Nouvelle commande #" . $order->get_order_number() . "* [Toutes zones]\n" .
                        "Client : " . $order->get_formatted_billing_full_name() . "\n" .
                        "Montant : *" . $plain_total_sr . "*\n" .
                        "Livraison : " . $delivery_method . "\n" .
                        "Tableau de bord : " . home_url( '/espace-representant/' );
                    miad_send_whatsapp( $srep_wa, $fallback_sr );
                }
            }
        }
    }

    // Admin WhatsApp
    if ( get_option( 'miad_twilio_enable_admin', 'no' ) === 'yes' ) {
        $phones           = array_filter( array_map( 'trim', explode( ',', get_option( 'miad_twilio_admin_whatsapp', '' ) ) ) );
        $plain_total      = miad_order_total_plain( $order );
        $sid              = get_option( 'miad_template_admin_new_order' );
        $raw_addr_admin   = $order->get_formatted_shipping_address() ?: $order->get_formatted_billing_address();
        $plain_addr_admin = ( $raw_addr_admin
            ? str_replace( "\n", ', ', trim( wp_strip_all_tags( preg_replace( '/<br\s*\/?>/i', "\n", $raw_addr_admin ) ) ) )
            : 'N/A' ) . ' — Livraison : ' . $delivery_method;
        $order_date_admin = $order->get_date_created()
            ? $order->get_date_created()->date_i18n( 'd/m/Y à H:i' )
            : current_time( 'd/m/Y H:i' );
        foreach ( $phones as $phone ) {
            if ( $sid ) {
                miad_send_whatsapp( $phone, '', $sid, [
                    '1' => $order->get_order_number(),
                    '2' => $order->get_formatted_billing_full_name(),
                    '3' => $plain_total,
                    '4' => $order_date_admin,
                    '5' => $plain_addr_admin,
                ] );
            } else {
                $fallback = "📦 *Commande #" . $order->get_order_number() . "* — " .
                    $order->get_formatted_billing_full_name() . " — *" . $plain_total . "* — Livraison : " . $delivery_method;
                miad_send_whatsapp( $phone, $fallback );
            }
        }
    }

    // Marquer comme "vendeur confirmé" automatiquement dès processing
    miad_set_delivery_stage( $order_id, 'vendor_confirmed' );
}

// Changement de statut → notification client
add_action( 'woocommerce_order_status_changed', 'miad_notify_client_on_status', 10, 4 );

function miad_notify_client_on_status( int $order_id, string $from, string $to, WC_Order $order ): void {
    if ( get_option( 'miad_twilio_enable_client', 'no' ) !== 'yes' ) return;
    $phone = miad_format_whatsapp_phone( $order->get_billing_phone(), $order->get_billing_country() );
    if ( ! $phone ) return;

    // Lien de suivi unique à cette commande (voir miad_order_tracking_url) —
    // ouvre directement le suivi sans reconnexion, comme AliExpress.
    $tracking_link = miad_order_tracking_url( $order );

    if ( $to === 'processing' ) {
        $sid = get_option( 'miad_template_client_confirm' );
        if ( $sid ) {
            miad_send_whatsapp( $phone, '', $sid, [
                '1' => $order->get_billing_first_name(),
                '2' => $order->get_order_number(),
                '3' => get_bloginfo( 'name' ),
            ] );
        } else {
            // Pas de template configuré → jusqu'ici rien n'était envoyé du tout.
            // Message de confirmation + remerciement + lien de suivi dès la
            // première confirmation, pas seulement aux étapes suivantes
            // (demandé le 2026-07-17).
            miad_send_whatsapp( $phone, "🙏 Merci " . $order->get_billing_first_name() . " pour votre commande #"
                . $order->get_order_number() . " sur " . get_bloginfo( 'name' ) . " !\nNous la préparons avec soin."
                . "\nSuivre ma commande : " . $tracking_link );
        }
        $order->add_order_note( 'WhatsApp confirmation envoyée au client.' );
    } elseif ( $to === 'completed' || $to === 'shipped' ) {
        $sid = get_option( 'miad_template_client_shipped' );
        if ( $sid ) {
            miad_send_whatsapp( $phone, '', $sid, [
                '1' => $order->get_billing_first_name(),
                '2' => $order->get_order_number(),
                '3' => $order->get_meta( '_miad_dhl_tracking_number' ) ?: 'N/A',
            ] );
        } else {
            miad_send_whatsapp( $phone, "🚚 " . $order->get_billing_first_name() . ", votre commande #"
                . $order->get_order_number() . " est en route !\nSuivre ma commande : " . $tracking_link );
        }
        $order->add_order_note( 'WhatsApp expédition envoyée au client.' );
    }
}

function miad_format_whatsapp_phone( string $phone, string $country = '' ): string {
    if ( ! $phone ) return '';
    if ( strpos( $phone, '+' ) === 0 ) return $phone;
    if ( $country && class_exists( 'WC_Countries' ) ) {
        $code = WC()->countries->get_country_calling_code( $country );
        if ( $code ) return '+' . $code . ltrim( $phone, '0' );
    }
    return '';
}

/* ═══════════════════════════════════════════════════════════════════
   6. AJAX — Mise à jour étape livraison + méta tracking
═══════════════════════════════════════════════════════════════════ */

add_action( 'wp_ajax_miad_update_delivery_stage', function () {
    check_ajax_referer( 'miad_rep_nonce' );
    if ( ! current_user_can( 'miad_representative' ) && ! current_user_can( 'miad_super_rep' ) && ! current_user_can( 'manage_options' ) ) {
        wp_send_json_error( 'Non autorisé' );
    }
    $order_id = (int) ( $_POST['order_id'] ?? 0 );
    $stage    = sanitize_key( $_POST['stage'] ?? '' );
    if ( ! $order_id || ! $stage ) wp_send_json_error( 'Paramètres invalides' );

    wp_send_json_success( miad_process_delivery_stage_update( $order_id, $stage ) );
} );

/**
 * Logique partagée entre l'action AJAX ci-dessus (dashboard représentant,
 * session WP) et l'endpoint REST /order/set-stage (dashboard admin headless,
 * demandé le 2026-07-20) — change l'étape de livraison d'une commande et
 * déclenche les mêmes notifications client/vendeur dans les deux cas.
 */
if ( ! function_exists( 'miad_process_delivery_stage_update' ) ) {
    function miad_process_delivery_stage_update( int $order_id, string $stage ): array {
    miad_set_delivery_stage( $order_id, $stage );
    $stages = miad_delivery_stages();

    // Le client est notifié à chaque étape de la chaîne (pas seulement au
    // passage transporteur international comme avant) — demandé le
    // 2026-07-17 : "vendeur récupéré", "transport local", "international" et
    // "livré" doivent tous déclencher un message, avec un lien vers son
    // suivi de commande (déjà affiché dans ClientDashboard.tsx via
    // _miad_delivery_stage — voir OrderDeliveryProgress).
    $client_stage_messages = [
        'rep_received' => fn( WC_Order $o ) => "📥 Bonjour " . $o->get_billing_first_name() . ", votre commande #" . $o->get_order_number() . " a été réceptionnée par notre représentant local.",
        'local_pickup' => fn( WC_Order $o ) => "🚚 Bonjour " . $o->get_billing_first_name() . ", votre commande #" . $o->get_order_number() . " a été prise en charge par le transporteur local.",
        'intl_handoff' => fn( WC_Order $o ) => "✈️ Bonjour " . $o->get_billing_first_name() . ", votre commande #" . $o->get_order_number() . " est remise au transporteur international. Suivi : " . ( $o->get_meta( '_miad_dhl_tracking_number' ) ?: 'bientôt disponible' ) . ".",
        'delivered'    => fn( WC_Order $o ) => "🎉 Bonjour " . $o->get_billing_first_name() . ", votre commande #" . $o->get_order_number() . " a été livrée. Merci pour votre confiance !",
    ];

    if ( isset( $client_stage_messages[ $stage ] ) ) {
        $order = wc_get_order( $order_id );
        if ( $order ) {
            $tracking_link = miad_order_tracking_url( $order );
            $text_body     = $client_stage_messages[ $stage ]( $order ) . "\nSuivre ma commande : " . $tracking_link;

            // Email — indépendant du réglage WhatsApp, envoyé à chaque étape
            // même si Twilio n'est pas configuré (demandé le 2026-07-17 :
            // le client ne recevait ces mises à jour par aucun canal fiable
            // tant que WhatsApp n'était pas branché).
            $client_email = $order->get_billing_email();
            if ( $client_email ) {
                wp_mail(
                    $client_email,
                    $stages[ $stage ]['label'] . ' — Commande #' . $order->get_order_number(),
                    nl2br( esc_html( $text_body ) ) . '<p><a href="' . esc_url( $tracking_link ) . '">Suivre ma commande</a></p>',
                    'Content-Type: text/html; charset=UTF-8'
                );
            }

            // WhatsApp — toujours soumis au réglage "Clients" (WP Admin →
            // Représentants → WhatsApp), silencieux si Twilio n'est pas
            // configuré ou si la case n'est pas cochée.
            if ( get_option( 'miad_twilio_enable_client', 'no' ) === 'yes' ) {
                $phone = miad_format_whatsapp_phone( $order->get_billing_phone(), $order->get_billing_country() );
                if ( $phone ) {
                    // Étape internationale : garde le template Twilio approuvé s'il
                    // existe déjà (comportement historique) ; sinon, comme les
                    // autres étapes, message texte simple avec lien de suivi.
                    $sid = $stage === 'intl_handoff' ? get_option( 'miad_template_client_shipped' ) : '';
                    if ( $sid ) {
                        miad_send_whatsapp( $phone, '', $sid, [
                            '1' => $order->get_billing_first_name(),
                            '2' => $order->get_order_number(),
                            '3' => $order->get_meta( '_miad_dhl_tracking_number' ) ?: 'N/A',
                        ] );
                    } else {
                        miad_send_whatsapp( $phone, $text_body );
                    }
                }
            }

            // Le vendeur est aussi notifié quand le représentant confirme
            // avoir réceptionné le colis chez lui — demandé le 2026-07-20 :
            // "confirmer au vendeur que je récupère [son colis]". Une
            // commande peut avoir plusieurs vendeurs (panier multi-boutique) ;
            // on notifie chacun une seule fois.
            if ( $stage === 'rep_received' && function_exists( 'dokan_get_store_info' ) ) {
                $notified_vendors = [];
                foreach ( $order->get_items() as $vendor_item ) {
                    $vendor_id = (int) get_post_field( 'post_author', $vendor_item->get_product_id() );
                    if ( ! $vendor_id || in_array( $vendor_id, $notified_vendors, true ) ) continue;
                    $notified_vendors[] = $vendor_id;

                    $vendor_user = get_userdata( $vendor_id );
                    $store_info  = dokan_get_store_info( $vendor_id );
                    $store_name  = $store_info['store_name'] ?? ( $vendor_user->display_name ?? 'Vendeur' );
                    $vendor_body = "📥 Bonjour " . $store_name . ", notre représentant confirme avoir bien récupéré votre colis pour la commande #"
                        . $order->get_order_number() . ". Merci pour votre confiance !";

                    if ( $vendor_user && $vendor_user->user_email ) {
                        wp_mail(
                            $vendor_user->user_email,
                            '📥 Colis récupéré — Commande #' . $order->get_order_number(),
                            nl2br( esc_html( $vendor_body ) ),
                            'Content-Type: text/html; charset=UTF-8'
                        );
                    }
                    if ( get_option( 'miad_twilio_enable_rep', 'yes' ) === 'yes' ) {
                        $vendor_phone = miad_format_whatsapp_phone(
                            $store_info['phone'] ?? '',
                            $store_info['address']['country'] ?? ''
                        );
                        if ( $vendor_phone ) {
                            miad_send_whatsapp( $vendor_phone, $vendor_body );
                        }
                    }
                }
            }
        }
    }

    return [
        'label' => isset( $stages[ $stage ] ) ? $stages[ $stage ]['label'] : $stage,
        'color' => isset( $stages[ $stage ] ) ? $stages[ $stage ]['color'] : '#888',
    ];
    }
}

// Endpoint REST — change l'étape de livraison d'une commande depuis le
// dashboard admin headless (demandé le 2026-07-20 : "voir/changer l'étape
// de livraison d'une commande" sans passer par le dashboard représentant).
// Protégé par le même secret partagé que miad-products-api.php.
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-products/v1', '/order/set-stage', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            if ( ! function_exists( 'miad_products_api_secret' ) ) return false;
            return hash_equals( miad_products_api_secret(), (string) $request->get_header( 'x-miad-products-secret' ) );
        },
        'callback'            => function ( WP_REST_Request $request ) {
            $order_id = (int) $request->get_param( 'order_id' );
            $stage    = sanitize_key( (string) $request->get_param( 'stage' ) );
            $stages   = miad_delivery_stages();
            if ( ! $order_id || ! wc_get_order( $order_id ) ) {
                return new WP_REST_Response( [ 'error' => 'Commande introuvable.' ], 404 );
            }
            if ( ! isset( $stages[ $stage ] ) ) {
                return new WP_REST_Response( [ 'error' => 'Étape invalide.' ], 400 );
            }
            $result = miad_process_delivery_stage_update( $order_id, $stage );
            return new WP_REST_Response( array_merge( [ 'ok' => true ], $result ), 200 );
        },
        'args' => [ 'order_id' => [ 'required' => true ], 'stage' => [ 'required' => true ] ],
    ] );
} );

add_action( 'wp_ajax_miad_save_order_meta', function () {
    check_ajax_referer( 'miad_rep_nonce' );
    if ( ! current_user_can( 'miad_representative' ) && ! current_user_can( 'miad_super_rep' ) && ! current_user_can( 'manage_options' ) ) {
        wp_send_json_error();
    }
    $order_id = (int) ( $_POST['order_id'] ?? 0 );
    $key      = sanitize_key( $_POST['meta_key'] ?? '' );
    $val      = sanitize_text_field( $_POST['meta_val'] ?? '' );
    $allowed  = [ '_miad_dhl_tracking_number', '_miad_local_transporter', '_miad_intl_transporter' ];
    if ( ! $order_id || ! in_array( $key, $allowed, true ) ) wp_send_json_error();
    update_post_meta( $order_id, $key, $val );
    wp_send_json_success();
} );

/* ═══════════════════════════════════════════════════════════════════
   7. TABLEAU DE BORD REPRÉSENTANT (Shortcode)
═══════════════════════════════════════════════════════════════════ */

add_shortcode( 'miad_rep_dashboard', 'miad_render_rep_dashboard' );

function miad_render_rep_dashboard(): string {
    if ( ! is_user_logged_in() ) {
        return '<p>Veuillez vous <a href="' . esc_url( wp_login_url( get_permalink() ) ) . '">connecter</a>.</p>';
    }
    $user         = wp_get_current_user();
    $is_super_rep = in_array( 'miad_super_rep', (array) $user->roles );
    if ( ! in_array( 'miad_representative', (array) $user->roles ) && ! $is_super_rep && ! current_user_can( 'administrator' ) ) {
        return '<p style="color:red">Accès refusé — espace réservé aux Représentants MIAD.</p>';
    }

    $country_code = $is_super_rep ? '' : (string) get_user_meta( $user->ID, 'miad_assigned_country', true );
    $country_name = $is_super_rep ? 'Tous les pays' : '';
    if ( ! $is_super_rep && class_exists( 'WC_Countries' ) ) {
        $all_countries = ( new WC_Countries() )->countries;
        $country_name  = isset( $all_countries[ $country_code ] ) ? $all_countries[ $country_code ] : $country_code;
    }
    $stages = miad_delivery_stages();
    $tab    = sanitize_key( isset( $_GET['rep_tab'] ) ? $_GET['rep_tab'] : 'orders' );

    // Toutes les commandes (super rep = toutes zones, représentant = sa zone uniquement)
    $orders_in_zone = $is_super_rep ? miad_get_all_orders() : miad_get_orders_for_country( $country_code );

    // Stats
    $pending_count   = 0;
    $transit_count   = 0;
    $delivered_count = 0;
    foreach ( $orders_in_zone as $o ) {
        $s = miad_get_delivery_stage( $o->get_id() );
        if ( ! $s || $s === 'vendor_confirmed' ) $pending_count++;
        elseif ( in_array( $s, [ 'rep_received', 'local_pickup', 'intl_handoff' ], true ) ) $transit_count++;
        elseif ( $s === 'delivered' ) $delivered_count++;
    }

    // Export CSV
    if ( isset( $_POST['miad_export_rep'] ) && check_admin_referer( 'miad_export_nonce' ) ) {
        miad_export_rep_csv( $country_code, sanitize_key( $_POST['export_status'] ?? 'all' ) );
    }

    ob_start();
    wp_enqueue_script( 'jquery' );
    ?>
    <style>
    .miad-rep { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:#131921; max-width:1100px; margin:0 auto }
    .miad-rep .rep-hdr { background:linear-gradient(135deg,#005826,#007a35); color:#fff; padding:22px 28px; border-radius:12px; margin-bottom:20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px }
    .miad-rep .rep-hdr h2 { margin:0; font-size:1.35rem }
    .miad-rep .rep-hdr small { opacity:.75; font-size:.82rem }
    .rep-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:20px }
    .rep-stat { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:18px; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,.06) }
    .rep-stat .n { font-size:2rem; font-weight:900; color:#005826 }
    .rep-stat .l { font-size:.78rem; color:#6b7280; margin-top:3px }
    .rep-tabs { display:flex; gap:6px; margin-bottom:18px; border-bottom:2px solid #e5e7eb }
    .rep-tab { padding:9px 18px; border-radius:8px 8px 0 0; text-decoration:none; font-weight:600; color:#6b7280; background:#f9fafb; font-size:.82rem; border:1px solid #e5e7eb; border-bottom:none; cursor:pointer }
    .rep-tab.active { background:#fff; color:#005826; border-bottom:2px solid #fff; margin-bottom:-2px }
    .rep-tbl { width:100%; border-collapse:collapse; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.08) }
    .rep-tbl th { background:#f9fafb; padding:9px 13px; text-align:left; font-size:.72rem; text-transform:uppercase; color:#6b7280; border-bottom:2px solid #F5A623 }
    .rep-tbl td { padding:11px 13px; border-bottom:1px solid #f3f4f6; font-size:.84rem; vertical-align:middle }
    .rep-tbl tr:hover td { background:#fafafa }
    .miad-badge { display:inline-block; padding:2px 9px; border-radius:20px; font-size:.7rem; font-weight:700; color:#fff; white-space:nowrap }
    .miad-stage-sel { padding:4px 7px; border:1px solid #d1d5db; border-radius:6px; font-size:.78rem; cursor:pointer; max-width:200px }
    .miad-meta-in { padding:4px 7px; border:1px solid #d1d5db; border-radius:5px; font-size:.78rem; width:130px }
    .miad-card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:22px; margin-bottom:16px }
    @media(max-width:640px){ .rep-stats{grid-template-columns:repeat(2,1fr)} .rep-hdr{flex-direction:column} }
    </style>

    <div class="miad-rep">

        <!-- Header -->
        <div class="rep-hdr">
            <div>
                <h2>🌍 Espace Représentant — <?= esc_html( $country_name ) ?></h2>
                <small>Connecté : <?= esc_html( $user->display_name ) ?></small>
            </div>
            <div style="text-align:right;font-size:.8rem">
                <?= date( 'd/m/Y H:i' ) ?>
                <br><a href="<?= esc_url( wp_logout_url( home_url() ) ) ?>" style="color:rgba(255,255,255,.7);font-size:.75rem">Déconnexion</a>
            </div>
        </div>

        <!-- Stats -->
        <div class="rep-stats">
            <?php foreach ( [
                [ count( $orders_in_zone ), 'Total commandes',   '#005826' ],
                [ $pending_count,           '⏳ Action requise', '#d97706' ],
                [ $transit_count,           '🚚 En transit',     '#2563eb' ],
                [ $delivered_count,         '✅ Livrées',        '#059669' ],
            ] as $s ): ?>
            <div class="rep-stat">
                <div class="n" style="color:<?= $s[2] ?>"><?= $s[0] ?></div>
                <div class="l"><?= $s[1] ?></div>
            </div>
            <?php endforeach; ?>
        </div>

        <!-- Navigation onglets -->
        <div class="rep-tabs">
            <?php foreach ( [
                'orders'  => '📦 Commandes',
                'transit' => '🚚 En transit',
                'vendors' => '🏪 Vendeurs',
                'export'  => '📊 Export CSV',
            ] as $t => $l ): ?>
            <a href="?rep_tab=<?= $t ?>" class="rep-tab <?= $tab === $t ? 'active' : '' ?>"><?= $l ?></a>
            <?php endforeach; ?>
        </div>

        <?php if ( $tab === 'orders' ): ?>
        <!-- ── ONGLET COMMANDES ── -->
        <table class="rep-tbl">
            <thead><tr>
                <th>#</th><th>Date</th><th>Client</th><th>Montant</th>
                <th>Statut WC</th><th>Étape livraison</th><th>Mettre à jour</th>
            </tr></thead>
            <tbody>
            <?php if ( empty( $orders_in_zone ) ): ?>
            <tr><td colspan="7" style="text-align:center;padding:30px;color:#9ca3af">Aucune commande dans votre zone.</td></tr>
            <?php else: ?>
            <?php foreach ( array_slice( $orders_in_zone, 0, 60 ) as $order ):
                $sk    = miad_get_delivery_stage( $order->get_id() );
                $sinfo = isset( $stages[ $sk ] ) ? $stages[ $sk ] : null;
            ?>
            <tr>
                <td><strong>#<?= esc_html( $order->get_order_number() ) ?></strong></td>
                <td style="color:#9ca3af;white-space:nowrap"><?= $order->get_date_created()->date( 'd/m/Y' ) ?></td>
                <td>
                    <?= esc_html( $order->get_formatted_billing_full_name() ) ?>
                    <br><small style="color:#9ca3af"><?= esc_html( $order->get_billing_phone() ) ?></small>
                </td>
                <td><strong><?= $order->get_formatted_order_total() ?></strong></td>
                <td><span class="miad-badge" style="background:#6b7280"><?= esc_html( wc_get_order_status_name( $order->get_status() ) ) ?></span></td>
                <td>
                    <span class="miad-badge miad-stage-<?= $order->get_id() ?>" style="background:<?= $sinfo ? esc_attr( $sinfo['color'] ) : '#9ca3af' ?>">
                        <?= $sinfo ? esc_html( $sinfo['label'] ) : '— Non démarré' ?>
                    </span>
                </td>
                <td>
                    <select class="miad-stage-sel" data-order="<?= $order->get_id() ?>" onchange="miadUpdateStage(this)">
                        <option value="">-- Étape --</option>
                        <?php foreach ( $stages as $stk => $stv ): ?>
                        <option value="<?= esc_attr( $stk ) ?>" <?php selected( $sk, $stk ) ?>><?= esc_html( $stv['label'] ) ?></option>
                        <?php endforeach; ?>
                    </select>
                </td>
            </tr>
            <?php endforeach; ?>
            <?php endif; ?>
            </tbody>
        </table>

        <?php elseif ( $tab === 'transit' ): ?>
        <!-- ── ONGLET EN TRANSIT ── -->
        <?php
        $transit_orders = array_filter( $orders_in_zone, function ( $o ) {
            return in_array( miad_get_delivery_stage( $o->get_id() ), [ 'rep_received', 'local_pickup', 'intl_handoff' ], true );
        } );
        ?>
        <table class="rep-tbl">
            <thead><tr>
                <th>#</th><th>Client</th><th>Pays dest.</th>
                <th>Étape</th><th>Transporteur local</th><th>N° tracking</th><th>Mettre à jour</th>
            </tr></thead>
            <tbody>
            <?php if ( empty( $transit_orders ) ): ?>
            <tr><td colspan="7" style="text-align:center;padding:30px;color:#9ca3af">Aucune commande en transit.</td></tr>
            <?php else: ?>
            <?php foreach ( $transit_orders as $order ):
                $sk    = miad_get_delivery_stage( $order->get_id() );
                $sinfo = isset( $stages[ $sk ] ) ? $stages[ $sk ] : null;
            ?>
            <tr>
                <td><strong>#<?= esc_html( $order->get_order_number() ) ?></strong></td>
                <td><?= esc_html( $order->get_formatted_billing_full_name() ) ?></td>
                <td><?= esc_html( $order->get_shipping_country() ?: $order->get_billing_country() ) ?></td>
                <td><span class="miad-badge" style="background:<?= $sinfo ? esc_attr( $sinfo['color'] ) : '#888' ?>"><?= $sinfo ? esc_html( $sinfo['label'] ) : '—' ?></span></td>
                <td>
                    <input class="miad-meta-in" type="text"
                        placeholder="Transporteur local..."
                        value="<?= esc_attr( $order->get_meta( '_miad_local_transporter' ) ) ?>"
                        onblur="miadSaveMeta(<?= $order->get_id() ?>, '_miad_local_transporter', this.value)">
                </td>
                <td>
                    <input class="miad-meta-in" type="text"
                        placeholder="DHL / FedEx..."
                        value="<?= esc_attr( $order->get_meta( '_miad_dhl_tracking_number' ) ) ?>"
                        onblur="miadSaveMeta(<?= $order->get_id() ?>, '_miad_dhl_tracking_number', this.value)">
                </td>
                <td>
                    <select class="miad-stage-sel" data-order="<?= $order->get_id() ?>" onchange="miadUpdateStage(this)">
                        <option value="">-- Étape --</option>
                        <?php foreach ( $stages as $stk => $stv ): ?>
                        <option value="<?= esc_attr( $stk ) ?>" <?php selected( $sk, $stk ) ?>><?= esc_html( $stv['label'] ) ?></option>
                        <?php endforeach; ?>
                    </select>
                </td>
            </tr>
            <?php endforeach; ?>
            <?php endif; ?>
            </tbody>
        </table>

        <?php elseif ( $tab === 'vendors' ): ?>
        <!-- ── ONGLET VENDEURS ── -->
        <?php $vendors = miad_get_vendors_in_country( $country_code ); ?>
        <table class="rep-tbl">
            <thead><tr><th>Boutique</th><th>Vendeur</th><th>Email</th><th>Tél.</th><th>Cmds actives</th></tr></thead>
            <tbody>
            <?php if ( empty( $vendors ) ): ?>
            <tr><td colspan="5" style="text-align:center;padding:30px;color:#9ca3af">Aucun vendeur dans votre zone.</td></tr>
            <?php else: ?>
            <?php foreach ( $vendors as $vendor ):
                $info    = function_exists( 'dokan_get_store_info' ) ? dokan_get_store_info( $vendor->ID ) : [];
                $vname   = isset( $info['store_name'] ) ? $info['store_name'] : $vendor->display_name;
                $vphone  = isset( $info['phone'] ) ? $info['phone'] : get_user_meta( $vendor->ID, 'billing_phone', true );
                $v_cmds  = wc_get_orders( [ 'limit' => -1, 'status' => 'processing' ] );
                $active  = 0;
                foreach ( $v_cmds as $vc ) {
                    foreach ( $vc->get_items() as $vi ) {
                        if ( (int) get_post_field( 'post_author', $vi->get_product_id() ) === $vendor->ID ) { $active++; break; }
                    }
                }
            ?>
            <tr>
                <td><strong><?= esc_html( $vname ) ?></strong></td>
                <td><?= esc_html( $vendor->display_name ) ?></td>
                <td><?= esc_html( $vendor->user_email ) ?></td>
                <td><?= esc_html( $vphone ) ?></td>
                <td><span class="miad-badge" style="background:#005826"><?= $active ?></span></td>
            </tr>
            <?php endforeach; ?>
            <?php endif; ?>
            </tbody>
        </table>

        <?php elseif ( $tab === 'export' ): ?>
        <!-- ── ONGLET EXPORT ── -->
        <div class="miad-card">
            <h3>Exporter les commandes de ma zone (<?= esc_html( $country_name ) ?>)</h3>
            <form method="post">
                <?php wp_nonce_field( 'miad_export_nonce' ); ?>
                <p>
                    <label><strong>Statut :</strong>
                    <select name="export_status" style="margin-left:8px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px">
                        <option value="all">Tous</option>
                        <option value="processing">En cours</option>
                        <option value="completed">Complétées</option>
                    </select></label>
                </p>
                <p><button type="submit" name="miad_export_rep" class="button button-primary">📥 Télécharger CSV</button></p>
            </form>
        </div>
        <?php endif; ?>

    </div><!-- .miad-rep -->

    <script>
    (function($){
        var nonce = '<?= wp_create_nonce( 'miad_rep_nonce' ) ?>';
        var ajaxUrl = '<?= esc_url( admin_url( 'admin-ajax.php' ) ) ?>';

        window.miadUpdateStage = function(sel) {
            var orderId = sel.dataset.order;
            var stage   = sel.value;
            if (!stage) return;
            $.post(ajaxUrl, {
                action: 'miad_update_delivery_stage',
                order_id: orderId,
                stage: stage,
                _ajax_nonce: nonce
            }, function(res) {
                if (res.success) {
                    var badge = document.querySelector('.miad-stage-' + orderId);
                    if (badge) {
                        badge.textContent  = res.data.label;
                        badge.style.background = res.data.color;
                    }
                }
            });
        };

        window.miadSaveMeta = function(orderId, metaKey, val) {
            $.post(ajaxUrl, {
                action: 'miad_save_order_meta',
                order_id: orderId,
                meta_key: metaKey,
                meta_val: val,
                _ajax_nonce: nonce
            });
        };
    })(jQuery);
    </script>
    <?php
    return ob_get_clean();
}

/* ═══════════════════════════════════════════════════════════════════
   8. HELPERS — requêtes
═══════════════════════════════════════════════════════════════════ */

function miad_get_vendors_in_country( string $country_code ): array {
    if ( ! $country_code || ! function_exists( 'dokan_get_store_info' ) ) return [];
    $vendors = get_users( [ 'role__in' => [ 'seller', 'administrator' ], 'number' => 300 ] );
    return array_values( array_filter( $vendors, function ( $v ) use ( $country_code ) {
        $info = dokan_get_store_info( $v->ID );
        return isset( $info['address']['country'] ) && $info['address']['country'] === $country_code;
    } ) );
}

function miad_get_orders_for_country( string $country_code ): array {
    if ( ! $country_code ) return [];
    $vendors = miad_get_vendors_in_country( $country_code );
    if ( empty( $vendors ) ) return [];

    $vendor_ids = array_map( function ( $v ) { return $v->ID; }, $vendors );
    $all_orders = wc_get_orders( [
        'limit'   => 100,
        'status'  => [ 'processing', 'on-hold', 'completed' ],
        'orderby' => 'date',
        'order'   => 'DESC',
    ] );

    $result = [];
    foreach ( $all_orders as $order ) {
        foreach ( $order->get_items() as $item ) {
            $vid = (int) get_post_field( 'post_author', $item->get_product_id() );
            if ( in_array( $vid, $vendor_ids, true ) ) {
                $result[ $order->get_id() ] = $order;
                break;
            }
        }
    }
    return array_values( $result );
}

function miad_get_all_orders(): array {
    return wc_get_orders( [
        'limit'   => 200,
        'status'  => [ 'processing', 'on-hold', 'completed' ],
        'orderby' => 'date',
        'order'   => 'DESC',
    ] );
}

/* ═══════════════════════════════════════════════════════════════════
   9. EXPORT CSV
═══════════════════════════════════════════════════════════════════ */

function miad_export_rep_csv( string $country_code, string $filter_status ): void {
    $orders  = $country_code ? miad_get_orders_for_country( $country_code ) : miad_get_all_orders();
    $stages  = miad_delivery_stages();
    if ( $filter_status !== 'all' ) {
        $orders = array_filter( $orders, function ( $o ) use ( $filter_status ) {
            return $o->get_status() === $filter_status;
        } );
    }
    if ( ob_get_level() ) ob_end_clean();
    header( 'Content-Type: text/csv; charset=utf-8' );
    header( 'Content-Disposition: attachment; filename=miad_zone_' . $country_code . '_' . date( 'Y-m-d' ) . '.csv' );
    $out = fopen( 'php://output', 'w' );
    fputs( $out, "\xEF\xBB\xBF" );
    fputcsv( $out, [ '#Commande', 'Date', 'Statut WC', 'Étape livraison', 'Client', 'Email', 'Téléphone', 'Montant', 'Transporteur local', 'N° Tracking' ] );
    foreach ( $orders as $order ) {
        $sk = miad_get_delivery_stage( $order->get_id() );
        fputcsv( $out, [
            $order->get_order_number(),
            $order->get_date_created()->date( 'Y-m-d H:i' ),
            wc_get_order_status_name( $order->get_status() ),
            isset( $stages[ $sk ] ) ? $stages[ $sk ]['label'] : '—',
            $order->get_formatted_billing_full_name(),
            $order->get_billing_email(),
            $order->get_billing_phone(),
            html_entity_decode( strip_tags( $order->get_formatted_order_total() ) ),
            $order->get_meta( '_miad_local_transporter' ),
            $order->get_meta( '_miad_dhl_tracking_number' ),
        ] );
    }
    fclose( $out );
    exit;
}

add_action( 'init', function () {
    if ( ! isset( $_POST['miad_export_rep'] ) || ! check_admin_referer( 'miad_export_nonce' ) ) return;
    if ( ! is_user_logged_in() ) return;
    $user = wp_get_current_user();
    $is_super_rep = in_array( 'miad_super_rep', (array) $user->roles );
    if ( ! in_array( 'miad_representative', (array) $user->roles ) && ! $is_super_rep && ! current_user_can( 'administrator' ) ) return;
    $country_code = $is_super_rep ? '' : (string) get_user_meta( $user->ID, 'miad_assigned_country', true );
    miad_export_rep_csv( $country_code, sanitize_key( $_POST['export_status'] ?? 'all' ) );
} );

/* ═══════════════════════════════════════════════════════════════════
   10. WHATSAPP TWILIO — fonction centrale
═══════════════════════════════════════════════════════════════════ */

/**
 * Génère un email au format natif WooCommerce (template admin-new-order).
 * Inclut liens produits, adresse de livraison, totaux — identique à l'email admin WC.
 */
if ( ! function_exists( 'miad_wc_order_email_html' ) ) {
    function miad_wc_order_email_html( WC_Order $order, string $heading = '' ): string {
        if ( ! function_exists( 'wc_get_template_html' ) || ! WC()->mailer() ) return '';
        if ( ! $heading ) $heading = 'Nouvelle commande #' . $order->get_order_number();
        $mailer = WC()->mailer();
        $email  = isset( $mailer->emails['WC_Email_New_Order'] ) ? $mailer->emails['WC_Email_New_Order'] : null;
        // admin-new-order.php appelle déjà woocommerce_email_header/footer → HTML complet.
        // Ne pas appeler wrap_message() qui ajouterait un second header/footer.
        return (string) wc_get_template_html(
            'emails/admin-new-order.php',
            [
                'order'         => $order,
                'email_heading' => $heading,
                'sent_to_admin' => true,
                'plain_text'    => false,
                'email'         => $email,
            ],
            '',
            WC()->plugin_path() . '/templates/'
        );
    }
}

/**
 * Retourne le total WooCommerce en texte brut, sans aucune balise HTML.
 * À utiliser partout où le montant doit aller dans un SMS / WhatsApp / email plain-text.
 */
if ( ! function_exists( 'miad_order_total_plain' ) ) {
    function miad_order_total_plain( WC_Order $order ): string {
        return html_entity_decode( wp_strip_all_tags( $order->get_formatted_order_total() ), ENT_QUOTES | ENT_HTML5 );
    }
}

if ( ! function_exists( 'miad_send_whatsapp' ) ) {
    function miad_send_whatsapp( string $to, string $body_fallback, string $template_sid = '', array $template_vars = [] ): void {
        $sid   = get_option( 'miad_twilio_sid' );
        $token = get_option( 'miad_twilio_token' );
        $from  = get_option( 'miad_twilio_from' );
        if ( ! $sid || ! $token || ! $from ) return;

        // Sécurité : supprimer tout HTML résiduel du body avant envoi
        $body_fallback = html_entity_decode( wp_strip_all_tags( $body_fallback ), ENT_QUOTES | ENT_HTML5 );

        $to_wa   = ( strpos( $to,   'whatsapp:' ) === 0 ) ? $to   : 'whatsapp:' . $to;
        $from_wa = ( strpos( $from, 'whatsapp:' ) === 0 ) ? $from : 'whatsapp:' . $from;

        // Sanitize every template variable — WooCommerce values can carry HTML entities
        foreach ( $template_vars as $k => $v ) {
            $template_vars[ $k ] = html_entity_decode( wp_strip_all_tags( (string) $v ), ENT_QUOTES | ENT_HTML5 );
        }

        $params = [ 'From' => $from_wa, 'To' => $to_wa ];
        if ( $template_sid ) {
            $params['ContentSid'] = $template_sid;
            if ( $template_vars ) $params['ContentVariables'] = wp_json_encode( $template_vars );
        } else {
            $params['Body'] = $body_fallback;
        }

        $resp = wp_remote_post( "https://api.twilio.com/2010-04-01/Accounts/{$sid}/Messages.json", [
            'headers' => [ 'Authorization' => 'Basic ' . base64_encode( "{$sid}:{$token}" ) ],
            'body'    => $params,
        ] );

        if ( is_wp_error( $resp ) ) {
            miad_wa_log( '[WA ERR] ' . $to_wa . ' — ' . $resp->get_error_message() );
        } else {
            miad_wa_log( '[WA OUT] ' . $to_wa . ' | tpl:' . $template_sid . ' | ' . wp_remote_retrieve_body( $resp ) );
        }
    }
}

// Alias rétrocompatible
if ( ! function_exists( 'miad_send_whatsapp_notification' ) ) {
    function miad_send_whatsapp_notification( string $to, string $log, string $sid = '', array $vars = [] ): void {
        miad_send_whatsapp( $to, $log, $sid, $vars );
    }
}

if ( ! function_exists( 'miad_wa_log' ) ) {
    function miad_wa_log( string $msg ): void {
        file_put_contents( WP_CONTENT_DIR . '/miad-whatsapp-log.txt', '[' . date( 'Y-m-d H:i:s' ) . '] ' . $msg . "\n", FILE_APPEND );
    }
}

// Alias rétrocompatible
if ( ! function_exists( 'miad_log_whatsapp_message' ) ) {
    function miad_log_whatsapp_message( string $msg ): void {
        miad_wa_log( $msg );
    }
}
