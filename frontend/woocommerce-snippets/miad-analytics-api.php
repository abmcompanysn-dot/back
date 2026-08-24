<?php
/**
 * Plugin Name: MIAD Analytics API
 * Description: Suivi léger du parcours client (vue produit, panier, checkout,
 *              paiement, recherche, référent) stocké dans une table dédiée,
 *              consommé par le dashboard KPI admin. Endpoint d'écriture public
 *              (aucune donnée sensible, juste des compteurs anonymes) protégé
 *              par une limite de débit ; endpoint de lecture protégé par le
 *              secret partagé MIAD_HEADLESS existant (même principe que les
 *              autres endpoints internes du site).
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'MIAD_ANALYTICS_TABLE', $GLOBALS['wpdb']->prefix . 'miad_analytics_events' );

/** Types d'événements autorisés — whitelist stricte pour éviter les entrées polluées. */
function miad_analytics_allowed_events(): array {
    return [
        'page_view', 'product_view', 'add_to_cart', 'remove_from_cart',
        'checkout_start', 'checkout_step', 'checkout_complete',
        'payment_attempt', 'payment_failed', 'payment_success', 'cart_abandoned',
        'search',
    ];
}

/**
 * Crée la table au premier chargement si elle n'existe pas encore (pas de hook
 * d'activation avec Code Snippets), et l'étend au passage de la v1 (funnel
 * basique : vue produit → achat) à la v2 (parcours détaillé : sessions
 * bloquées, échecs de paiement, paniers abandonnés) — dbDelta() sait ajouter
 * des colonnes/index à une table existante sans perdre les données déjà là,
 * pas besoin de DROP/recréer.
 */
function miad_analytics_ensure_table(): void {
    global $wpdb;
    if ( get_option( 'miad_analytics_table_version' ) === '3' ) return;

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $charset_collate = $wpdb->get_charset_collate();
    $table = MIAD_ANALYTICS_TABLE;

    // Colonnes explicites (plutôt qu'un unique JSON) pour rester agrégeable en
    // SQL simple (AVG, GROUP BY) sans dépendre de JSON_EXTRACT — pas garanti
    // disponible selon la version MySQL/MariaDB de l'hébergement mutualisé.
    // `metadata` reste en catch-all pour l'affichage détaillé (drill-down),
    // jamais pour l'agrégation. `country` ajouté en v3 (code ISO 2 lettres,
    // via l'en-tête cf-ipcountry capturé côté edge Next.js — pas de lookup IP
    // ici, cohérent avec l'esprit "aucune donnée sensible" de cet endpoint).
    $sql = "CREATE TABLE {$table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        event_type VARCHAR(32) NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        user_id BIGINT UNSIGNED NULL,
        product_id BIGINT UNSIGNED NULL,
        search_query VARCHAR(255) NULL,
        referrer VARCHAR(255) NULL,
        path VARCHAR(255) NULL,
        checkout_step_number SMALLINT UNSIGNED NULL,
        payment_failure_reason VARCHAR(100) NULL,
        device_type VARCHAR(16) NULL,
        cart_value DECIMAL(10,2) NULL,
        country VARCHAR(8) NULL,
        metadata TEXT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        KEY event_type_idx (event_type),
        KEY session_id_idx (session_id),
        KEY created_at_idx (created_at),
        KEY session_created_idx (session_id, created_at),
        KEY event_created_idx (event_type, created_at)
    ) {$charset_collate};";

    dbDelta( $sql );
    update_option( 'miad_analytics_table_version', '3' );
}
add_action( 'init', 'miad_analytics_ensure_table' );

/** Limite de débit par IP : évite qu'un client (ou bot) ne sature la table. */
function miad_analytics_is_rate_limited( string $ip ): bool {
    $key = 'miad_analytics_rl_' . md5( $ip );
    $count = (int) get_transient( $key );
    if ( $count >= 120 ) return true; // ~120 événements/minute/IP, large marge pour un vrai parcours
    set_transient( $key, $count + 1, MINUTE_IN_SECONDS );
    return false;
}

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/track', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true', // public : aucune donnée sensible, juste des compteurs anonymes
        'callback'            => function ( WP_REST_Request $request ) {
            global $wpdb;

            $ip = $request->get_header( 'x-forwarded-for' ) ?: ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' );
            $ip = trim( explode( ',', (string) $ip )[0] );
            if ( miad_analytics_is_rate_limited( $ip ) ) {
                return new WP_REST_Response( [ 'ok' => false, 'error' => 'rate_limited' ], 429 );
            }

            $event_type = sanitize_key( (string) $request->get_param( 'eventType' ) );
            if ( ! in_array( $event_type, miad_analytics_allowed_events(), true ) ) {
                return new WP_REST_Response( [ 'ok' => false, 'error' => 'invalid_event_type' ], 400 );
            }

            $session_id = sanitize_text_field( (string) $request->get_param( 'sessionId' ) );
            if ( strlen( $session_id ) < 8 || strlen( $session_id ) > 64 ) {
                return new WP_REST_Response( [ 'ok' => false, 'error' => 'invalid_session_id' ], 400 );
            }

            $product_id   = $request->get_param( 'productId' );
            $search_query = $request->get_param( 'searchQuery' );
            $referrer     = $request->get_param( 'referrer' );
            $path         = $request->get_param( 'path' );
            $user_id      = $request->get_param( 'userId' );
            $step_number  = $request->get_param( 'checkoutStepNumber' );
            $fail_reason  = $request->get_param( 'paymentFailureReason' );
            $device_type  = $request->get_param( 'deviceType' );
            $cart_value   = $request->get_param( 'cartValue' );
            $metadata     = $request->get_param( 'metadata' );
            $country      = $request->get_param( 'country' );

            // device_type en whitelist stricte plutôt qu'un sanitize_text_field
            // libre — sinon le GROUP BY du futur endpoint de répartition device
            // finit avec autant de variantes que de user-agents différents.
            if ( $device_type !== null && ! in_array( $device_type, [ 'mobile', 'tablet', 'desktop' ], true ) ) {
                $device_type = null;
            }

            $wpdb->insert( MIAD_ANALYTICS_TABLE, [
                'event_type'             => $event_type,
                'session_id'             => $session_id,
                'user_id'                => $user_id !== null ? (int) $user_id : null,
                'product_id'             => $product_id !== null ? (int) $product_id : null,
                'search_query'           => $search_query !== null ? sanitize_text_field( (string) $search_query ) : null,
                'referrer'               => $referrer !== null ? esc_url_raw( (string) $referrer ) : null,
                'path'                   => $path !== null ? sanitize_text_field( (string) $path ) : null,
                'checkout_step_number'   => $step_number !== null ? (int) $step_number : null,
                'payment_failure_reason' => $fail_reason !== null ? sanitize_text_field( (string) $fail_reason ) : null,
                'device_type'            => $device_type,
                'cart_value'             => $cart_value !== null ? (float) $cart_value : null,
                'country'                => $country !== null ? strtoupper( sanitize_text_field( (string) $country ) ) : null,
                // metadata : catch-all libre pour le drill-down (jamais agrégé en SQL),
                // tronqué pour empêcher un client malveillant de gonfler la table.
                'metadata'               => $metadata !== null ? mb_substr( wp_json_encode( $metadata ) ?: '', 0, 2000 ) : null,
                'created_at'             => current_time( 'mysql', true ),
            ] );

            return new WP_REST_Response( [ 'ok' => true ], 201 );
        },
        'args' => [
            'eventType'            => [ 'required' => true ],
            'sessionId'            => [ 'required' => true ],
            'productId'            => [],
            'searchQuery'          => [],
            'referrer'             => [],
            'path'                 => [],
            'userId'               => [],
            'checkoutStepNumber'   => [],
            'paymentFailureReason' => [],
            'deviceType'           => [],
            'cartValue'            => [],
            'metadata'             => [],
            'country'              => [],
        ],
    ] );
} );

// Diagnostic temporaire (à retirer une fois le décalage de secret résolu) —
// ne révèle jamais la valeur du secret, seulement sa présence/longueur des
// deux côtés, pour savoir si wp-config.php et Cloudflare Pages sont désync.
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/secret-check', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function ( WP_REST_Request $request ) {
            $wp_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            $header    = (string) $request->get_header( 'x-headless-secret' );
            return new WP_REST_Response( [
                'wp_secret_defined' => $wp_secret !== null,
                'wp_secret_length'  => $wp_secret ? strlen( $wp_secret ) : 0,
                'header_received'   => $header !== '',
                'header_length'     => strlen( $header ),
                'match'             => $wp_secret ? hash_equals( $wp_secret, $header ) : false,
            ], 200 );
        },
    ] );
} );

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/summary', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( ! $internal_secret ) return false; // fail-closed : pas de secret configuré = pas d'accès
            return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            global $wpdb;
            $table = MIAD_ANALYTICS_TABLE;

            $days = max( 1, min( 90, (int) ( $request->get_param( 'days' ) ?? 7 ) ) );
            $since = gmdate( 'Y-m-d H:i:s', strtotime( "-{$days} days" ) );

            // Entonnoir d'achat : nombre de sessions distinctes ayant atteint chaque étape.
            // payment_attempt inséré entre checkout_start et checkout_complete — c'est
            // souvent LE point de blocage réel (échec/abandon de paiement), invisible
            // dans un entonnoir à 4 étapes qui saute directement de "checkout" à "payé".
            $funnel_steps = [ 'product_view', 'add_to_cart', 'checkout_start', 'payment_attempt', 'checkout_complete' ];
            $funnel = [];
            foreach ( $funnel_steps as $step ) {
                $funnel[ $step ] = (int) $wpdb->get_var( $wpdb->prepare(
                    "SELECT COUNT(DISTINCT session_id) FROM {$table} WHERE event_type = %s AND created_at >= %s",
                    $step, $since
                ) );
            }

            // Temps moyen (en secondes) entre chaque étape consécutive — calculé à
            // partir du premier événement de chaque type par session, en PHP plutôt
            // qu'en SQL pur pour rester lisible/portable entre versions MySQL/MariaDB.
            $step_placeholders = implode( ',', array_fill( 0, count( $funnel_steps ), '%s' ) );
            $step_rows = $wpdb->get_results( $wpdb->prepare(
                "SELECT session_id, event_type, MIN(created_at) AS first_at FROM {$table}
                 WHERE event_type IN ({$step_placeholders}) AND created_at >= %s
                 GROUP BY session_id, event_type",
                array_merge( $funnel_steps, [ $since ] )
            ), ARRAY_A );
            $by_session = [];
            foreach ( $step_rows as $row ) {
                $by_session[ $row['session_id'] ][ $row['event_type'] ] = strtotime( $row['first_at'] );
            }
            $avg_seconds_between_steps = [];
            for ( $i = 0; $i < count( $funnel_steps ) - 1; $i++ ) {
                $from = $funnel_steps[ $i ];
                $to   = $funnel_steps[ $i + 1 ];
                $deltas = [];
                foreach ( $by_session as $events ) {
                    if ( isset( $events[ $from ], $events[ $to ] ) && $events[ $to ] >= $events[ $from ] ) {
                        $deltas[] = $events[ $to ] - $events[ $from ];
                    }
                }
                $avg_seconds_between_steps["{$from}_to_{$to}"] = $deltas ? (int) round( array_sum( $deltas ) / count( $deltas ) ) : null;
            }

            // Raisons d'échec de paiement les plus fréquentes.
            $payment_failures = $wpdb->get_results( $wpdb->prepare(
                "SELECT payment_failure_reason AS reason, COUNT(*) AS count FROM {$table}
                 WHERE event_type = 'payment_failed' AND created_at >= %s AND payment_failure_reason IS NOT NULL AND payment_failure_reason != ''
                 GROUP BY payment_failure_reason ORDER BY count DESC LIMIT 20",
                $since
            ), ARRAY_A );

            // Recherches les plus fréquentes.
            $top_searches = $wpdb->get_results( $wpdb->prepare(
                "SELECT search_query AS query, COUNT(*) AS count FROM {$table}
                 WHERE event_type = 'search' AND created_at >= %s AND search_query IS NOT NULL AND search_query != ''
                 GROUP BY search_query ORDER BY count DESC LIMIT 20",
                $since
            ), ARRAY_A );

            // Produits les plus vus.
            $top_products = $wpdb->get_results( $wpdb->prepare(
                "SELECT product_id, COUNT(*) AS views FROM {$table}
                 WHERE event_type = 'product_view' AND created_at >= %s AND product_id IS NOT NULL
                 GROUP BY product_id ORDER BY views DESC LIMIT 20",
                $since
            ), ARRAY_A );

            // Origine du trafic : domaine du référent, regroupé (direct si vide).
            $raw_referrers = $wpdb->get_results( $wpdb->prepare(
                "SELECT referrer FROM {$table} WHERE event_type = 'page_view' AND created_at >= %s",
                $since
            ), ARRAY_A );
            $referrer_counts = [];
            foreach ( $raw_referrers as $row ) {
                $ref = $row['referrer'];
                $host = $ref ? ( wp_parse_url( $ref, PHP_URL_HOST ) ?: 'autre' ) : 'direct';
                $referrer_counts[ $host ] = ( $referrer_counts[ $host ] ?? 0 ) + 1;
            }
            arsort( $referrer_counts );

            // Visiteurs actifs "maintenant" : sessions distinctes avec un événement
            // dans les 5 dernières minutes — proxy simple d'un vrai temps réel, sans
            // websocket, juste une fenêtre glissante courte rafraîchie par polling.
            $active_since = gmdate( 'Y-m-d H:i:s', strtotime( '-5 minutes' ) );
            $active_now = (int) $wpdb->get_var( $wpdb->prepare(
                "SELECT COUNT(DISTINCT session_id) FROM {$table} WHERE created_at >= %s",
                $active_since
            ) );

            // Série quotidienne (vues de page) pour le graphique — jusqu'à 90 points.
            $daily_page_views = $wpdb->get_results( $wpdb->prepare(
                "SELECT DATE(created_at) AS date, COUNT(*) AS count FROM {$table}
                 WHERE event_type = 'page_view' AND created_at >= %s
                 GROUP BY DATE(created_at) ORDER BY date ASC",
                $since
            ), ARRAY_A );

            return new WP_REST_Response( [
                'ok'                    => true,
                'days'                  => $days,
                'funnel'                => $funnel,
                'avgSecondsBetweenSteps'=> $avg_seconds_between_steps,
                'paymentFailures'       => $payment_failures,
                'topSearches'           => $top_searches,
                'topProducts'           => $top_products,
                'trafficSources'        => array_slice( $referrer_counts, 0, 15, true ),
                'activeNow'             => $active_now,
                'dailyPageViews'        => $daily_page_views,
            ], 200 );
        },
        'args' => [
            'days' => [],
        ],
    ] );
} );

/**
 * Parcours individuel : timeline chronologique complète d'une session
 * donnée. Sert le drill-down "sessions bloquées → voir le parcours".
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/session/(?P<sessionId>[a-zA-Z0-9]+)', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( ! $internal_secret ) return false;
            return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            global $wpdb;
            $table = MIAD_ANALYTICS_TABLE;
            $session_id = sanitize_text_field( (string) $request->get_param( 'sessionId' ) );

            $events = $wpdb->get_results( $wpdb->prepare(
                "SELECT event_type, product_id, search_query, path, checkout_step_number,
                        payment_failure_reason, device_type, cart_value, country, metadata, created_at
                 FROM {$table} WHERE session_id = %s ORDER BY created_at ASC LIMIT 500",
                $session_id
            ), ARRAY_A );

            foreach ( $events as &$event ) {
                $event['metadata'] = $event['metadata'] ? json_decode( $event['metadata'], true ) : null;
            }
            unset( $event );

            if ( empty( $events ) ) {
                return new WP_REST_Response( [ 'ok' => false, 'error' => 'session_introuvable' ], 404 );
            }

            // Durée de session et pays : calculés ici plutôt qu'agrégés en SQL —
            // un seul visiteur, pas besoin d'index dédié pour ça.
            $first = strtotime( $events[0]['created_at'] . ' UTC' );
            $last  = strtotime( $events[ count( $events ) - 1 ]['created_at'] . ' UTC' );
            $duration_seconds = max( 0, $last - $first );

            $country = null;
            foreach ( $events as $event ) {
                if ( ! empty( $event['country'] ) ) { $country = $event['country']; break; }
            }

            return new WP_REST_Response( [
                'ok'              => true,
                'sessionId'       => $session_id,
                'events'          => $events,
                'durationSeconds' => $duration_seconds,
                'country'         => $country,
            ], 200 );
        },
        'args' => [ 'sessionId' => [ 'required' => true ] ],
    ] );
} );

/**
 * Sessions bloquées : dernier événement de chaque session active dans la
 * fenêtre de lookback, filtré aux sessions dont ce dernier événement est une
 * étape intermédiaire du funnel (checkout_start/checkout_step/payment_attempt)
 * ET date d'au moins `minutesStuck` minutes — sinon un visiteur en train de
 * remplir son formulaire à l'instant apparaîtrait à tort comme "bloqué".
 */
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-analytics/v1', '/stuck-sessions', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
            if ( ! $internal_secret ) return false;
            return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            global $wpdb;
            $table = MIAD_ANALYTICS_TABLE;

            $minutes_stuck = max( 5, min( 1440, (int) ( $request->get_param( 'minutesStuck' ) ?? 30 ) ) );
            $lookback_days = max( 1, min( 7, (int) ( $request->get_param( 'lookbackDays' ) ?? 2 ) ) );
            $since        = gmdate( 'Y-m-d H:i:s', strtotime( "-{$lookback_days} days" ) );
            $stuck_before = gmdate( 'Y-m-d H:i:s', strtotime( "-{$minutes_stuck} minutes" ) );

            $last_events = $wpdb->get_results( $wpdb->prepare(
                "SELECT t1.session_id, t1.event_type, t1.checkout_step_number, t1.cart_value, t1.created_at
                 FROM {$table} t1
                 INNER JOIN (
                     SELECT session_id, MAX(created_at) AS max_created
                     FROM {$table}
                     WHERE created_at >= %s
                     GROUP BY session_id
                 ) t2 ON t1.session_id = t2.session_id AND t1.created_at = t2.max_created
                 WHERE t1.created_at <= %s
                 ORDER BY t1.created_at DESC
                 LIMIT 200",
                $since, $stuck_before
            ), ARRAY_A );

            $stuck_types = [ 'checkout_start', 'checkout_step', 'payment_attempt' ];
            $stuck = array_values( array_filter( $last_events, function ( $e ) use ( $stuck_types ) {
                return in_array( $e['event_type'], $stuck_types, true );
            } ) );

            return new WP_REST_Response( [ 'ok' => true, 'minutesStuck' => $minutes_stuck, 'sessions' => $stuck ], 200 );
        },
        'args' => [ 'minutesStuck' => [], 'lookbackDays' => [] ],
    ] );
} );
