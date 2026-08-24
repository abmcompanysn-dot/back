<?php
/**
 * Plugin Name: MIAD Email Blast API
 * Description: Endpoints headless pour l'onglet "Emails" du dashboard admin
 *              (statistiques, envoi unique, diffusion en masse). L'onglet
 *              existait côté Next.js (components/miad/EmailBlast.tsx) mais
 *              appelait des endpoints WordPress qui n'ont jamais été
 *              implémentés — 404 constaté le 2026-07-10 via le nouveau
 *              journal d'actions admin. Réutilise miad_send_professional_email()
 *              (miad-email-customizer.php, déjà chargé — même style/BCC/logs
 *              que les autres emails du site) et l'option miad_newsletter_subs
 *              déjà gérée par la page wp-admin "Abonnements Newsletter".
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

function miad_email_blast_permission_check( WP_REST_Request $request ): bool {
    $internal_secret = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET : null;
    if ( ! $internal_secret ) return false;
    return hash_equals( $internal_secret, (string) $request->get_header( 'x-headless-secret' ) );
}

/**
 * Emails à exclure du compteur/de la liste "Clients" — vendeurs Dokan et
 * administrateurs qui ont pu passer des commandes de test sur le site
 * réel (pas de compte "sandbox" séparé ici). Signalé le 2026-07-11 : le
 * compte "Clients WC" comptait tout le monde, y compris les boutiques
 * elles-mêmes et les admins.
 */
function miad_email_blast_excluded_emails(): array {
    $users = get_users( [
        'role__in' => [ 'administrator', 'seller', 'vendor' ],
        'fields'   => [ 'user_email' ],
    ] );
    return array_map( fn( $u ) => strtolower( $u->user_email ), $users );
}

/** Emails clients uniques (billing_email) à partir des vraies commandes payées → email => prénom. */
function miad_email_blast_customer_emails( int $limit = 3000 ): array {
    $orders = wc_get_orders( [
        'status'  => [ 'completed', 'processing', 'on-hold' ],
        'type'    => 'shop_order', // exclut shop_order_refund
        'limit'   => $limit,
        'orderby' => 'date',
        'order'   => 'DESC',
        'return'  => 'ids',
    ] );

    $excluded = miad_email_blast_excluded_emails();

    $emails = [];
    foreach ( $orders as $order_id ) {
        $order = wc_get_order( $order_id );
        // WC_Order_Refund peut se glisser dans le résultat malgré le filtre
        // 'type' selon la config HPOS — il n'a pas get_billing_email() (fatal
        // non catchable trouvé le 2026-07-11 dans miad-recommendations-api.php,
        // même pattern ici).
        if ( ! $order || ! is_a( $order, 'WC_Order' ) ) continue;
        $email = $order->get_billing_email();
        if ( ! $email || ! is_email( $email ) || isset( $emails[ $email ] ) ) continue;
        if ( in_array( strtolower( $email ), $excluded, true ) ) continue; // vendeur/admin — pas un vrai client
        $emails[ $email ] = $order->get_billing_first_name() ?: '';
    }
    return $emails;
}

/** Abonnés newsletter actifs (option miad_newsletter_subs) → email => prénom. */
function miad_email_blast_subscriber_emails(): array {
    $subs = get_option( 'miad_newsletter_subs', [] );
    $out  = [];
    foreach ( $subs as $email => $s ) {
        if ( ! empty( $s['active'] ) && is_email( $email ) ) {
            $out[ $email ] = $s['name'] ?? '';
        }
    }
    return $out;
}

/**
 * $include_recommendations ajoute, sous le message écrit par l'admin, les
 * produits que CE destinataire pourrait aimer (ses vraies commandes, même
 * moteur que l'email de recommandation dédié — miad-recommendations-api.php)
 * — demandé le 2026-07-11 : que la diffusion ne soit pas le même message
 * identique pour tout le monde.
 */
function miad_email_blast_send( string $to, string $subject, string $body, string $name = '', bool $include_recommendations = false, string $template = 'grid' ): bool {
    $personalized = str_replace( '{customer_name}', $name ?: 'Client', $body );

    if ( $include_recommendations && function_exists( 'miad_reco_get_recommendations_for_email' ) ) {
        $cards = miad_reco_get_recommendations_for_email( $to, 4, $template );
        if ( ! empty( $cards['html'] ) ) {
            $personalized .= '<div style="margin-top:28px;padding-top:20px;border-top:1px solid #e5e7eb">'
                . '<p style="margin:0 0 16px;font-size:13px;font-weight:800;color:#374151;text-transform:uppercase;letter-spacing:.04em">Vous pourriez aussi aimer</p>'
                . $cards['html']
                . '</div>';
        }
    }

    return function_exists( 'miad_send_professional_email' )
        ? miad_send_professional_email( $to, $subject, $personalized, null, [ 'email_type' => 'miad_admin_blast' ] )
        : (bool) wp_mail( $to, $subject, $personalized, [ 'Content-Type: text/html; charset=UTF-8' ] );
}

add_action( 'rest_api_init', function () {

    // GET /miad/v1/email/subscribers — stats pour l'onglet Emails du dashboard.
    register_rest_route( 'miad/v1', '/email/subscribers', [
        'methods'             => 'GET',
        'permission_callback' => 'miad_email_blast_permission_check',
        'callback'            => function () {
            $subscribers = miad_email_blast_subscriber_emails();
            $customers   = miad_email_blast_customer_emails();
            $all_unique  = array_unique( array_merge( array_keys( $subscribers ), array_keys( $customers ) ) );

            return new WP_REST_Response( [
                'subscribers_active' => count( $subscribers ),
                'customers'          => count( $customers ),
                'all_unique'         => count( $all_unique ),
            ], 200 );
        },
    ] );

    // POST /miad/v1/email/send — envoi à un destinataire précis.
    register_rest_route( 'miad/v1', '/email/send', [
        'methods'             => 'POST',
        'permission_callback' => 'miad_email_blast_permission_check',
        'callback'            => function ( WP_REST_Request $request ) {
            $p       = $request->get_json_params();
            $to      = sanitize_email( $p['to'] ?? '' );
            $subject = sanitize_text_field( $p['subject'] ?? '' );
            $body    = wp_kses_post( $p['body'] ?? '' );
            $include_recommendations = ! empty( $p['includeRecommendations'] );
            $template = in_array( $p['template'] ?? '', [ 'grid', 'list' ], true ) ? $p['template'] : 'grid';

            if ( ! is_email( $to ) || ! $subject || ! $body ) {
                return new WP_REST_Response( [ 'ok' => false, 'error' => 'Champs manquants ou email invalide' ], 400 );
            }

            $ok = miad_email_blast_send( $to, $subject, $body, '', $include_recommendations, $template );
            return new WP_REST_Response( [ 'ok' => $ok, 'to' => $to ], 200 );
        },
    ] );

    // POST /miad/v1/email/broadcast — diffusion en masse (abonnés / clients / tous).
    register_rest_route( 'miad/v1', '/email/broadcast', [
        'methods'             => 'POST',
        'permission_callback' => 'miad_email_blast_permission_check',
        'callback'            => function ( WP_REST_Request $request ) {
            // Même raisonnement que miad_reco_send_emails() : potentiellement
            // des milliers d'envois SMTP synchrones (+ maintenant une requête
            // commandes par destinataire si includeRecommendations), largement
            // au-delà du max_execution_time/memory_limit par défaut d'un
            // hébergement mutualisé.
            if ( function_exists( 'set_time_limit' ) ) { @set_time_limit( 0 ); }
            if ( function_exists( 'wp_raise_memory_limit' ) ) { wp_raise_memory_limit( 'admin' ); }

            $p        = $request->get_json_params();
            $subject  = sanitize_text_field( $p['subject'] ?? '' );
            $body     = wp_kses_post( $p['body'] ?? '' );
            $audience = in_array( $p['audience'] ?? '', [ 'subscribers', 'customers', 'all' ], true ) ? $p['audience'] : 'subscribers';
            $max      = max( 1, min( 5000, (int) ( $p['maxRecipients'] ?? 2000 ) ) );
            $include_recommendations = ! empty( $p['includeRecommendations'] );
            $template = in_array( $p['template'] ?? '', [ 'grid', 'list' ], true ) ? $p['template'] : 'grid';

            if ( ! $subject || ! $body ) {
                return new WP_REST_Response( [ 'ok' => false, 'error' => 'Sujet et corps requis' ], 400 );
            }

            $subscribers = ( $audience === 'subscribers' || $audience === 'all' ) ? miad_email_blast_subscriber_emails() : [];
            $customers   = ( $audience === 'customers'   || $audience === 'all' ) ? miad_email_blast_customer_emails()   : [];
            // '+' garde les clés du tableau de gauche en priorité — dédoublonne
            // par email sans écraser le prénom déjà connu côté abonné.
            $recipients = array_slice( $subscribers + $customers, 0, $max, true );

            // try/catch(\Throwable) — même raison que miad-recommendations-api.php
            // (2026-07-11) : includeRecommendations refait un wc_get_orders() par
            // destinataire, même risque de fatal non catchable qu'un try/catch(
            // \Exception) classique laisserait invisible dans le journal admin.
            try {
                $sent = 0; $failed = 0;
                foreach ( $recipients as $email => $name ) {
                    miad_email_blast_send( $email, $subject, $body, $name, $include_recommendations, $template ) ? $sent++ : $failed++;
                }
                return new WP_REST_Response( [ 'ok' => true, 'sent' => $sent, 'failed' => $failed, 'total' => count( $recipients ) ], 200 );
            } catch ( \Throwable $e ) {
                return new WP_REST_Response( [
                    'ok'    => false,
                    'error' => $e->getMessage(),
                    'file'  => $e->getFile() . ':' . $e->getLine(),
                ], 500 );
            }
        },
    ] );

} );
