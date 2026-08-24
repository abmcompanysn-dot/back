<?php
/**
 * Plugin Name: MIAD Admin Action Log
 * Description: Journal d'audit des actions admin/représentant déclenchées
 *              depuis le dashboard headless (Next.js) — qui a fait quoi,
 *              quand, et depuis où (IP/pays/navigateur). Écrit par
 *              lib/miad-admin-api.ts (callHeadlessAdmin) à chaque appel
 *              admin proxifié vers WordPress. Table dédiée, séparée de
 *              miad_analytics_events (celle-ci est publique/anonyme pour
 *              le funnel client — sémantique et garde d'accès différentes
 *              d'un journal d'audit admin authentifié).
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'MIAD_ADMIN_LOG_TABLE', $GLOBALS['wpdb']->prefix . 'miad_admin_action_log' );

function miad_admin_log_ensure_table(): void {
    global $wpdb;
    if ( get_option( 'miad_admin_log_table_version' ) === '1' ) return;

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $charset_collate = $wpdb->get_charset_collate();
    $table = MIAD_ADMIN_LOG_TABLE;

    $sql = "CREATE TABLE {$table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_id BIGINT UNSIGNED NOT NULL,
        actor_email VARCHAR(190) NOT NULL,
        actor_role VARCHAR(32) NOT NULL,
        action VARCHAR(64) NOT NULL,
        wp_endpoint VARCHAR(190) NOT NULL,
        status VARCHAR(16) NOT NULL,
        wp_status SMALLINT UNSIGNED NULL,
        ip VARCHAR(64) NULL,
        country VARCHAR(8) NULL,
        user_agent VARCHAR(255) NULL,
        metadata TEXT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        KEY actor_idx (actor_id),
        KEY created_at_idx (created_at),
        KEY action_idx (action)
    ) {$charset_collate};";

    dbDelta( $sql );
    update_option( 'miad_admin_log_table_version', '1' );
}
add_action( 'init', 'miad_admin_log_ensure_table' );

/** Même garde que les autres endpoints internes : secret partagé côté serveur uniquement. */
function miad_admin_log_permission_check( WP_REST_Request $request ): bool {
    $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
    if ( ! $internal_secret ) return false;
    return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
}

add_action( 'rest_api_init', function () {

    // POST /miad/v1/admin-action-log — écrit une ligne (appelé en tâche de
    // fond par callHeadlessAdmin(), jamais bloquant pour l'action admin).
    register_rest_route( 'miad/v1', '/admin-action-log', [
        [
            'methods'             => 'POST',
            'permission_callback' => 'miad_admin_log_permission_check',
            'callback'            => function ( WP_REST_Request $request ) {
                global $wpdb;
                $p = $request->get_json_params();

                $actor_id = (int) ( $p['actor_id'] ?? 0 );
                $action   = sanitize_text_field( $p['action'] ?? '' );
                if ( ! $actor_id || ! $action ) {
                    return new WP_REST_Response( [ 'ok' => false, 'error' => 'actor_id et action requis' ], 400 );
                }

                $wpdb->insert( MIAD_ADMIN_LOG_TABLE, [
                    'actor_id'    => $actor_id,
                    'actor_email' => sanitize_email( $p['actor_email'] ?? '' ),
                    'actor_role'  => sanitize_text_field( $p['actor_role'] ?? 'unknown' ),
                    'action'      => $action,
                    'wp_endpoint' => sanitize_text_field( $p['wp_endpoint'] ?? '' ),
                    'status'      => in_array( $p['status'] ?? '', [ 'success', 'error' ], true ) ? $p['status'] : 'error',
                    'wp_status'   => isset( $p['wp_status'] ) ? (int) $p['wp_status'] : null,
                    'ip'          => sanitize_text_field( $p['ip'] ?? '' ),
                    'country'     => sanitize_text_field( $p['country'] ?? '' ),
                    'user_agent'  => sanitize_text_field( mb_substr( (string) ( $p['user_agent'] ?? '' ), 0, 255 ) ),
                    // Corps de la réponse WP en erreur (tronqué) — sans ce champ le
                    // journal montre un code statut mais jamais la vraie cause.
                    'metadata'    => isset( $p['metadata'] ) ? mb_substr( (string) $p['metadata'], 0, 1500 ) : null,
                    'created_at'  => current_time( 'mysql', true ),
                ] );

                return new WP_REST_Response( [ 'ok' => true ], 200 );
            },
        ],
        // GET /miad/v1/admin-action-log — lecture paginée pour l'onglet
        // "Journal" du dashboard admin, filtrable par acteur/action/statut.
        [
            'methods'             => 'GET',
            'permission_callback' => 'miad_admin_log_permission_check',
            'callback'            => function ( WP_REST_Request $request ) {
                global $wpdb;

                $per_page = max( 1, min( 100, (int) ( $request->get_param( 'per_page' ) ?? 50 ) ) );
                $page     = max( 1, (int) ( $request->get_param( 'page' ) ?? 1 ) );
                $offset   = ( $page - 1 ) * $per_page;

                $where  = [ '1=1' ];
                $values = [];

                $actor_id = (int) $request->get_param( 'actor_id' );
                if ( $actor_id ) { $where[] = 'actor_id = %d'; $values[] = $actor_id; }

                $action = sanitize_text_field( (string) $request->get_param( 'action' ) );
                if ( $action ) { $where[] = 'action = %s'; $values[] = $action; }

                $status = sanitize_text_field( (string) $request->get_param( 'status' ) );
                if ( in_array( $status, [ 'success', 'error' ], true ) ) { $where[] = 'status = %s'; $values[] = $status; }

                $where_sql = implode( ' AND ', $where );
                $table = MIAD_ADMIN_LOG_TABLE;

                $total_sql = "SELECT COUNT(*) FROM {$table} WHERE {$where_sql}";
                $total = (int) ( $values ? $wpdb->get_var( $wpdb->prepare( $total_sql, $values ) ) : $wpdb->get_var( $total_sql ) );

                $rows_sql = "SELECT * FROM {$table} WHERE {$where_sql} ORDER BY created_at DESC LIMIT %d OFFSET %d";
                $rows_values = array_merge( $values, [ $per_page, $offset ] );
                $rows = $wpdb->get_results( $wpdb->prepare( $rows_sql, $rows_values ), ARRAY_A );

                return new WP_REST_Response( [
                    'ok'       => true,
                    'entries'  => $rows,
                    'total'    => $total,
                    'page'     => $page,
                    'per_page' => $per_page,
                ], 200 );
            },
        ],
    ] );

} );
