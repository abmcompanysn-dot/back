<?php
/**
 * Plugin Name: MIAD Email System
 * Description: Emails HTML premium pour WooCommerce — branding MIAD Market, anti-spam,
 *              sans images, anonymisation des logs pour confidentialité, compatible FluentSMTP.
 * Version: 2.2-secure
 * Author: MIAD Market
 *
 * INSTALLATION : Colle ce fichier dans Code Snippets (WordPress) ou dans functions.php.
 * NÉCESSITE    : miad-coins.php chargé en amont (pour les emails coins).
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTES
═══════════════════════════════════════════════════════════════════ */
define( 'MIAD_LOGO_URL',   'https://www.miadmarket.com/logo/logo.png' );
define( 'MIAD_GREEN',      '#005826' );
define( 'MIAD_GOLD',       '#F5A623' );
define( 'MIAD_SITE_URL',   'https://www.miadmarket.com' );
define( 'MIAD_FROM_EMAIL',    'noreply@miadmarket.com' );
define( 'MIAD_FROM_NAME',     'MIAD Market' );
define( 'MIAD_EMAIL_VERSION', '2.2-secure' );

/* ═══════════════════════════════════════════════════════════════════
   1. EXPÉDITEUR — anti-spam + identité professionnelle
═══════════════════════════════════════════════════════════════════ */

add_filter( 'wp_mail_from',                   fn() => MIAD_FROM_EMAIL, 999 );
add_filter( 'wp_mail_from_name',              fn() => MIAD_FROM_NAME,  999 );
add_filter( 'woocommerce_email_from_address', fn() => MIAD_FROM_EMAIL, 999 );
add_filter( 'woocommerce_email_from_name',    fn() => MIAD_FROM_NAME,  999 );

add_filter( 'wp_mail', function( array $args ): array {
    if ( ! isset( $args['headers'] ) ) $args['headers'] = [];
    if ( is_string( $args['headers'] ) ) $args['headers'] = [ $args['headers'] ];
    $args['headers'][] = 'Content-Type: text/html; charset=UTF-8';
    $args['headers'][] = 'X-Mailer: MIAD Market v2.2';
    $args['headers'][] = 'X-Priority: 3 (Normal)';
    return $args;
} );

// Version texte brut (multipart/alternative) — sans ça, Gmail/SpamAssassin
// penalisent via MIME_HTML_ONLY (mail "HTML only", pattern frequent chez le spam).
add_action( 'phpmailer_init', function ( $phpmailer ) {
    if ( ! empty( $phpmailer->AltBody ) ) return; // déjà fourni ailleurs, ne pas écraser
    if ( empty( $phpmailer->Body ) || stripos( $phpmailer->ContentType, 'html' ) === false ) return;
    $phpmailer->AltBody = trim( wp_strip_all_tags( str_replace( ['</p>', '<br>', '<br/>', '<br />'], "\n", $phpmailer->Body ) ) );
} );

/* ═══════════════════════════════════════════════════════════════════
   1b. CSS WOOCOMMERCE — Branding MIAD sur TOUS les emails WC natifs
   S'applique à : confirmation, processing, annulé, facture, note...
   Ne remplace aucun contenu — juste du CSS injecté dans le <style>.
═══════════════════════════════════════════════════════════════════ */

add_filter( 'woocommerce_email_styles', function ( string $css ): string {
    return $css . "
/* ─── MIAD Market — Branding ─── */
#template_container { box-shadow:0 4px 24px rgba(0,0,0,.10) !important; border-radius:12px !important; }
#template_header { background-color:#005826 !important; }
#template_header h1,
#template_header h1 a {
    color:#ffffff !important;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif !important;
    font-size:26px !important; font-weight:900 !important;
    letter-spacing:2px !important; text-decoration:none !important;
}
#header_wrapper { padding:28px 32px !important; text-align:center !important; }
#body_content_inner {
    color:#333333 !important;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif !important;
    font-size:15px !important; line-height:1.65 !important;
}
h1,h2 { color:#005826 !important; font-weight:800 !important; }
/* Tableau produits */
.td { border-color:#f0f0f0 !important; }
.email-order-details thead tr th,
.order_details thead tr th {
    background-color:#f0fdf4 !important; color:#005826 !important;
    border-bottom:2px solid #F5A623 !important;
    font-size:11px !important; text-transform:uppercase !important; letter-spacing:.5px !important;
}
/* Totaux */
.order-totals-total th,
.order-totals-total td { color:#005826 !important; font-weight:900 !important; font-size:16px !important; }
/* Adresses */
.address {
    background-color:#f0fdf4 !important; border-radius:8px !important;
    padding:12px 16px !important; border:1px solid #bbf7d0 !important;
}
.address-title { color:#005826 !important; font-size:11px !important; text-transform:uppercase !important; }
/* Bouton */
.button, a.button {
    background-color:#F5A623 !important; color:#111111 !important;
    font-weight:800 !important; border-radius:50px !important;
    text-transform:uppercase !important; letter-spacing:1px !important;
    padding:14px 28px !important;
}
/* Pied de page */
#template_footer { background-color:#005826 !important; border-top:4px solid #F5A623 !important; }
#template_footer td,
#template_footer #credit,
#template_footer p { color:rgba(255,255,255,.75) !important; font-size:12px !important; }
#template_footer a { color:rgba(255,255,255,.9) !important; }
@media only screen and (max-width:640px){
    #body_content_inner { padding:20px !important; }
    #header_wrapper { padding:20px !important; }
}
";
}, 20 );

// Capture d'erreur anonymisée pour respect de la confidentialité
add_action( 'wp_mail_failed', function ( WP_Error $error ) {
    $entry = [
        'date'    => current_time( 'mysql' ),
        'message' => sanitize_text_field( $error->get_error_message() ),
        'data'    => '[Données masquées pour confidentialité]',
    ];
    update_option( 'miad_last_mail_error', $entry );
} );

/* ═══════════════════════════════════════════════════════════════════
   2. MENU ADMIN
═══════════════════════════════════════════════════════════════════ */

// ── Journal d'activité (terminal log) ─────────────────────────────
function miad_activity_log( string $message, int $order_id = 0, string $level = 'info' ): void {
    $logs = get_option( 'miad_activity_logs', [] );
    $logs[] = [
        'time'     => current_time( 'mysql' ),
        'msg'      => $message,
        'order_id' => $order_id,
        'level'    => $level, // info | ok | warn | error
    ];
    if ( count( $logs ) > 150 ) array_shift( $logs );
    update_option( 'miad_activity_logs', $logs );
}

// ── REST endpoint : déclencher l'email de commande depuis Next.js ─
// POST /wp-json/miad/v1/order-notify/{id}  (X-Headless-Secret requis)
add_action( 'rest_api_init', function () {
    register_rest_route( 'miad/v1', '/order-notify/(?P<id>\d+)', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ): bool {
            // Voir miad_headless_secret_check() dans miad-rep-api.php pour le
            // détail : MIAD_INTERNAL_SECRET seul n'est jamais défini côté
            // wp-config.php, ce qui cassait cet endpoint en silence.
            $expected = defined( 'INTERNAL_API_SECRET' ) ? INTERNAL_API_SECRET
                : ( defined( 'MIAD_HEADLESS_SECRET' ) ? MIAD_HEADLESS_SECRET
                : ( defined( 'MIAD_INTERNAL_SECRET' ) ? MIAD_INTERNAL_SECRET : null ) );
            if ( ! $expected ) return false;
            return hash_equals( $expected, (string) $request->get_header( 'X-Headless-Secret' ) );
        },
        // Même logique que /miad/v1/otp/send : appel direct, synchrone, pas de hooks
        'callback' => function ( WP_REST_Request $request ): WP_REST_Response {
            $order_id = intval( $request->get_param( 'id' ) );
            if ( ! $order_id ) return rest_ensure_response( [ 'ok' => false, 'error' => 'ID invalide' ] );

            miad_activity_log( '📡 /order-notify appelé — envoi direct (comme OTP)', $order_id, 'info' );

            $order = wc_get_order( $order_id );
            if ( ! $order ) {
                miad_activity_log( '❌ Commande introuvable', $order_id, 'error' );
                return rest_ensure_response( [ 'ok' => false, 'error' => 'Commande introuvable' ] );
            }

            $email = $order->get_billing_email();
            if ( ! $email ) {
                miad_activity_log( '❌ Billing email vide', $order_id, 'error' );
                return rest_ensure_response( [ 'ok' => false, 'error' => 'Email client manquant' ] );
            }

            // Anti-doublon simple (comme OTP qui ne renvoie pas le même code deux fois)
            if ( get_transient( 'miad_notif_' . $order_id ) ) {
                miad_activity_log( '🔒 Déjà envoyé — skip (anti-doublon)', $order_id, 'warn' );
                return rest_ensure_response( [ 'ok' => true, 'already_sent' => true ] );
            }
            set_transient( 'miad_notif_' . $order_id, 1, 3600 );

            $settings = get_option( 'miad_email_settings', [] );
            $sent     = [];

            // Email client "Commande reçue"
            if ( ( $settings['miad_order_received']['enabled'] ?? 'yes' ) !== 'no' ) {
                $d  = miad_compose_order_email( 'miad_order_received', $order );
                $ok = miad_send_professional_email( $email, $d['subject'], $d['body'], $order, [ 'email_type' => 'miad_order_received' ] );
                $sent[] = ( $ok ? '✅' : '❌' ) . ' miad_order_received → client';
                miad_activity_log( ( $ok ? '✅' : '❌' ) . ' miad_order_received → ' . substr($email,0,3) . '***', $order_id, $ok ? 'ok' : 'error' );
            }

            // Email admin "Nouvelle commande"
            if ( ( $settings['new_order']['enabled'] ?? 'yes' ) !== 'no' ) {
                $d  = miad_compose_order_email( 'new_order', $order );
                $ok = miad_send_professional_email( get_option('admin_email'), $d['subject'], $d['body'], $order, [ 'email_type' => 'new_order' ] );
                $sent[] = ( $ok ? '✅' : '❌' ) . ' new_order → admin';
                miad_activity_log( ( $ok ? '✅' : '❌' ) . ' new_order → admin', $order_id, $ok ? 'ok' : 'error' );
            }

            $order->update_meta_data( '_miad_new_order_notified', '1' );
            $order->save();

            return rest_ensure_response( [ 'ok' => true, 'sent' => $sent ] );
        },
        'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
    ] );
} );

add_action( 'admin_menu', function () {
    add_menu_page( 'MIAD Emails', 'MIAD Emails 📧', 'manage_options', 'miad-emails', 'miad_email_page_overview', 'dashicons-email-alt2', 57 );
    add_submenu_page( 'miad-emails', 'Templates',      'Templates',        'manage_options', 'miad-emails',             'miad_email_page_overview' );
    add_submenu_page( 'miad-emails', 'Prévisualiser', '👁 Prévisualiser', 'manage_options', 'miad-emails-preview',     'miad_email_page_preview'  );
    add_submenu_page( 'miad-emails', 'Abonnements',   'Abonnements',      'manage_options', 'miad-emails-subs',        'miad_email_page_subs'     );
    add_submenu_page( 'miad-emails', 'Logs',          'Logs',             'manage_options', 'miad-emails-logs',        'miad_email_page_logs'     );
    add_submenu_page( 'miad-emails', 'Test',          'Envoyer test',     'manage_options', 'miad-emails-test',        'miad_email_page_test'     );
    add_submenu_page( 'miad-emails', 'Activité',     '🖥 Activité',      'manage_options', 'miad-emails-activity',    'miad_email_page_activity' );
} );

/* ═══════════════════════════════════════════════════════════════════
   3. TEMPLATES DES EMAILS (ADMIN)
═══════════════════════════════════════════════════════════════════ */

const MIAD_EMAIL_TYPES = [
    'new_order'                 => ' Nouvelle commande (Admin)',
    'miad_order_received'       => ' Commande reçue (immédiat)',
    'customer_processing_order' => ' Paiement confirmé (Client)',
    'customer_completed_order'  => ' Commande complétée (Client)',
    'miad_order_cancelled'      => ' Commande annulée (Client)',
    'customer_invoice'          => ' Facture client',
    'customer_note'             => ' Note de commande',
    'miad_welcome'              => ' Bienvenue (inscription)',
    'miad_pending_payment'      => ' Paiement en attente',
    'miad_payment_reminder'     => 'Relance paiement (24h)',
    'miad_coins_earned'         => ' Coins gagnés',
    'miad_newsletter'           => ' Newsletter / Promo',
    'miad_rep_taken'            => '👤 Prise en charge (Représentant)',
    'miad_tracking_ready'       => '🚚 En route — Tracking créé',
    'miad_delivered'            => '🏠 Commande livrée',
];

function miad_email_page_overview(): void {
    if ( isset( $_POST['miad_save'] ) && check_admin_referer( 'miad_email_save' ) ) {
        $settings  = get_option( 'miad_email_settings', [] );
        $saved_tab = sanitize_key( $_POST['miad_current_tab'] ?? 'new_order' );

        // Ne sauvegarder QUE l'onglet actif — les autres restent inchangés
        // (le foreach précédent écrasait tous les onglets avec enabled:no car les champs n'étaient pas dans le POST)
        if ( array_key_exists( $saved_tab, MIAD_EMAIL_TYPES ) ) {
            $settings[ $saved_tab ] = [
                'enabled' => ! empty( $_POST[ "enable_{$saved_tab}" ] ) ? 'yes' : 'no',
                'subject' => sanitize_text_field( $_POST[ "subject_{$saved_tab}" ] ?? '' ),
                'body'    => wp_kses_post( $_POST[ "body_{$saved_tab}" ] ?? '' ),
            ];
        }
        update_option( 'miad_email_settings', $settings );
        update_option( 'miad_email_footer_promo', wp_kses_post( $_POST['footer_promo'] ?? '' ) );
        update_option( 'miad_admin_bcc_emails', sanitize_text_field( $_POST['admin_bcc_emails'] ?? '' ) );
        echo '<div class="notice notice-success"><p>✅ Template "' . esc_html( MIAD_EMAIL_TYPES[ $saved_tab ] ?? $saved_tab ) . '" enregistré.</p></div>';
    }

    $settings      = get_option( 'miad_email_settings', [] );
    $footer_promo  = get_option( 'miad_email_footer_promo', '🔥 Profitez de -65% sur vos prochaines expéditions DHL avec MIAD Market !' );
    $admin_bcc     = get_option( 'miad_admin_bcc_emails', '' );
    $tab           = sanitize_key( $_GET['tab'] ?? 'new_order' );
    if ( ! array_key_exists( $tab, MIAD_EMAIL_TYPES ) ) $tab = 'new_order';
    ?>
    <div class="wrap" style="max-width:900px">
        <h1>📧 MIAD Email Templates</h1>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
            <span style="background:#dcfce7;border:1px solid #86efac;border-radius:20px;padding:4px 14px;font-size:.78rem;font-weight:700;color:#166534">✅ Version <?= MIAD_EMAIL_VERSION ?></span>
            <span style="background:#e0f2fe;border:1px solid #7dd3fc;border-radius:20px;padding:4px 14px;font-size:.78rem;font-weight:700;color:#0369a1">📬 Flux FluentSMTP sécurisé</span>
        </div>

        <h2 class="nav-tab-wrapper">
            <?php foreach ( MIAD_EMAIL_TYPES as $id => $label ): ?>
                <a href="?page=miad-emails&tab=<?= $id ?>" class="nav-tab <?= $tab === $id ? 'nav-tab-active' : '' ?>"><?= $label ?></a>
            <?php endforeach; ?>
        </h2>

        <form method="post" style="margin-top:20px">
            <?php wp_nonce_field( 'miad_email_save' ); ?>
            <input type="hidden" name="miad_current_tab" value="<?= esc_attr( $tab ) ?>">
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;margin-bottom:16px">
                <label style="display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:16px">
                    <input type="checkbox" name="enable_<?= $tab ?>" value="yes" <?php checked( $settings[ $tab ]['enabled'] ?? 'no', 'yes' ) ?>> Activer cet email
                </label>
                <table class="form-table">
                    <tr><th>Sujet</th><td><input type="text" name="subject_<?= $tab ?>" value="<?= esc_attr( $settings[ $tab ]['subject'] ?? '' ) ?>" class="large-text"></td></tr>
                    <tr><th>Corps (HTML)</th><td><?php wp_editor( $settings[ $tab ]['body'] ?? '', "body_{$tab}", [ 'textarea_rows' => 10 ] ); ?></td></tr>
                </table>
            </div>
            <div style="background:#fff8e1;border:2px dashed #F5A623;border-radius:8px;padding:20px;margin-bottom:16px">
                <strong>Zone promo / signature (bas des emails)</strong>
                <textarea name="footer_promo" style="width:100%;height:70px;margin-top:10px"><?= esc_textarea( $footer_promo ) ?></textarea>
            </div>
            <div style="background:#f0fdf4;border:2px solid #005826;border-radius:8px;padding:20px;margin-bottom:16px">
                <strong style="color:#005826">📬 Admins en copie (BCC)</strong>
                <input type="text" name="admin_bcc_emails" value="<?= esc_attr( $admin_bcc ) ?>" class="large-text" style="margin-top:10px">
            </div>
            <p><input type="submit" name="miad_save" class="button button-primary button-hero" value="Enregistrer"></p>
        </form>

        <!-- Référence des shortcodes disponibles -->
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-top:8px">
            <details>
                <summary style="cursor:pointer;font-weight:800;font-size:13px;color:#1a1a2e;padding:4px 0">
                    📋 Shortcodes disponibles — cliquez pour afficher la liste complète
                </summary>
                <div style="margin-top:16px">
                    <p style="font-size:12px;color:#6b7280;margin-bottom:12px">
                        Copiez-collez ces codes dans le <strong>Sujet</strong> et le <strong>Corps</strong> de vos templates.
                        Ils seront remplacés automatiquement par les vraies valeurs à l'envoi.
                    </p>
                    <?php
                    $groups = [
                        '👤 Client'        => ['{customer_name}','{customer_first_name}','{customer_last_name}','{customer_email}','{customer_phone}'],
                        '📦 Commande'      => ['{order_number}','{order_date}','{order_total}','{order_status}','{order_link}','{payment_method}','{items_count}','{items_list}'],
                        '📍 Adresses'      => ['{shipping_address}','{billing_address}','{shipping_country}','{shipping_city}'],
                        '🚚 Logistique'    => ['{tracking_number}','{carrier}','{tracking_url}','{rep_name}'],
                        '🌍 Site & Divers' => ['{site_name}','{site_url}','{current_year}','{coins_earned}','{coins_balance}'],
                    ];
                    $all = miad_shortcodes_list();
                    foreach ( $groups as $group_label => $codes ):
                    ?>
                    <div style="margin-bottom:14px">
                        <p style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#374151;margin-bottom:8px"><?= esc_html($group_label) ?></p>
                        <div style="display:flex;flex-wrap:wrap;gap:6px">
                        <?php foreach ( $codes as $code ): ?>
                            <span
                                title="<?= esc_attr($all[$code]??$code) ?>"
                                onclick="navigator.clipboard.writeText('<?= esc_attr($code) ?>');this.style.background='#d1fae5';setTimeout(()=>this.style.background='',1000)"
                                style="cursor:pointer;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:4px 10px;font-family:monospace;font-size:12px;font-weight:700;color:#7c3aed;white-space:nowrap"
                                title="<?= esc_attr($all[$code]??'') ?> — Cliquer pour copier"
                            ><?= esc_html($code) ?></span>
                        <?php endforeach; ?>
                        </div>
                        <p style="font-size:11px;color:#9ca3af;margin-top:4px">
                        <?php foreach ( $codes as $code ): ?>
                            <span style="margin-right:12px"><code><?= esc_html($code) ?></code> → <?= esc_html($all[$code]??'') ?></span>
                        <?php endforeach; ?>
                        </p>
                    </div>
                    <?php endforeach; ?>
                </div>
            </details>
        </div>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   4. PAGE ABONNEMENTS (newsletter / opt-in)
═══════════════════════════════════════════════════════════════════ */

function miad_email_page_subs(): void {
    if ( isset( $_POST['miad_add_sub'] ) && check_admin_referer( 'miad_subs' ) ) {
        $email = sanitize_email( $_POST['sub_email'] );
        $name  = sanitize_text_field( $_POST['sub_name'] );
        if ( is_email( $email ) ) {
            $subs = get_option( 'miad_newsletter_subs', [] );
            $subs[ $email ] = [ 'name' => $name, 'date' => current_time( 'mysql' ), 'active' => 1 ];
            update_option( 'miad_newsletter_subs', $subs );
        }
    }
    if ( isset( $_GET['unsub'] ) && check_admin_referer( 'miad_unsub' ) ) {
        $subs = get_option( 'miad_newsletter_subs', [] );
        $email = sanitize_email( urldecode( $_GET['unsub'] ) );
        if ( isset( $subs[ $email ] ) ) { $subs[ $email ]['active'] = 0; update_option( 'miad_newsletter_subs', $subs ); }
    }

    $subs = get_option( 'miad_newsletter_subs', [] );
    ?>
    <div class="wrap" style="max-width:900px">
        <h1>📣 Abonnements Newsletter</h1>
        <form method="post" style="display:flex;gap:8px;margin-bottom:20px">
            <?php wp_nonce_field('miad_subs'); ?>
            <input type="text" name="sub_name" placeholder="Nom">
            <input type="email" name="sub_email" placeholder="Email" required style="width:240px">
            <button type="submit" name="miad_add_sub" class="button button-primary">Ajouter</button>
        </form>
        <table class="wp-list-table widefat fixed striped">
            <thead><tr><th>Email (Anonymisé)</th><th>Date</th><th>Statut</th><th>Action</th></tr></thead>
            <tbody>
            <?php foreach ( $subs as $email => $s ): 
                $split = explode('@', $email);
                $masked_email = substr($split[0], 0, 3) . '***@' . ($split[1] ?? '');
            ?>
            <tr>
                <td><?= esc_html( $masked_email ) ?></td>
                <td><?= esc_html( $s['date'] ?? '' ) ?></td>
                <td><?= ! empty( $s['active'] ) ? '<span style="color:#059669;font-weight:700">Actif</span>' : '<span style="color:#9ca3af">Désabonné</span>' ?></td>
                <td>
                    <?php if ( ! empty( $s['active'] ) ): ?>
                    <a href="<?= wp_nonce_url( admin_url( 'admin.php?page=miad-emails-subs&unsub=' . urlencode($email) ), 'miad_unsub' ) ?>" class="button button-small">Désabonner</a>
                    <?php endif; ?>
                </td>
            </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   5. PAGE LOGS — Respect strict de la confidentialité
═══════════════════════════════════════════════════════════════════ */

function miad_email_page_logs(): void {
    if ( isset( $_POST['miad_clear_logs'] ) && check_admin_referer( 'miad_clear_logs' ) ) {
        update_option( 'miad_email_logs', [] );
        update_option( 'miad_last_mail_error', null );
        echo "<div class='notice notice-success'><p>✅ Logs vidés.</p></div>";
    }

    $logs      = array_reverse( get_option( 'miad_email_logs', [] ) );
    $last_err  = get_option( 'miad_last_mail_error', null );
    $total     = count( $logs );
    $success   = count( array_filter( $logs, fn($l) => !empty($l['ok']) ) );
    $failed    = $total - $success;

    $source_labels = [
        'auto'      => ['🤖 Auto (hook WP)',   '#d1fae5','#065f46'],
        'rest-api'  => ['🌐 REST API',          '#dbeafe','#1e40af'],
        'rest-hook' => ['⚡ REST Hook',          '#ede9fe','#5b21b6'],
        'checkout'  => ['🛒 Checkout natif',    '#fef3c7','#92400e'],
        'test-admin'=> ['🧪 Test admin',        '#f3f4f6','#374151'],
        'unknown'   => ['❓ Inconnu',            '#f9fafb','#6b7280'],
    ];
    ?>
    <div class="wrap" style="max-width:1200px">
        <h1>📋 Logs d'envoi MIAD Emails</h1>

        <?php if ( $last_err ): ?>
        <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:14px 18px;margin-bottom:16px">
            <p style="font-weight:700;color:#991b1b;margin:0 0 4px">⚠️ Dernière erreur d'envoi détectée</p>
            <p style="font-size:13px;color:#991b1b;margin:0;font-family:monospace"><?= esc_html( $last_err['message'] ?? '' ) ?></p>
            <p style="font-size:11px;color:#9ca3af;margin:4px 0 0"><?= esc_html( $last_err['date'] ?? '' ) ?></p>
        </div>
        <?php endif; ?>

        <!-- Statistiques rapides -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
            <?php foreach ([
                ['Total emails', $total, '#f9fafb','#374151'],
                ['Succès', $success, '#d1fae5','#065f46'],
                ['Échecs', $failed, $failed>0?'#fee2e2':'#f9fafb', $failed>0?'#991b1b':'#374151'],
                ['Depuis (jours)', $logs ? max(1, (int)ceil((time()-strtotime($logs[count($logs)-1]['date']??'now'))/86400)) : 0, '#dbeafe','#1e40af'],
            ] as [$lbl,$val,$bg,$col]): ?>
            <div style="background:<?= $bg ?>;border-radius:10px;padding:14px 18px;text-align:center">
                <p style="font-size:22px;font-weight:900;color:<?= $col ?>;margin:0"><?= $val ?></p>
                <p style="font-size:11px;font-weight:700;color:<?= $col ?>;margin:2px 0 0;opacity:.7"><?= esc_html($lbl) ?></p>
            </div>
            <?php endforeach; ?>
        </div>

        <table class="wp-list-table widefat fixed striped" style="margin-top:0;font-size:13px">
            <thead>
                <tr>
                    <th width="130">Date</th>
                    <th width="140">Destinataire</th>
                    <th>Sujet / Type</th>
                    <th width="90">Commande</th>
                    <th width="130">Source</th>
                    <th width="80">Statut</th>
                </tr>
            </thead>
            <tbody>
            <?php if ( empty( $logs ) ): ?>
                <tr><td colspan="6" style="text-align:center;padding:20px;color:#9ca3af">Aucun log enregistré.</td></tr>
            <?php else: ?>
                <?php foreach ( $logs as $l ):
                    $src    = $l['source'] ?? 'unknown';
                    [$src_label,$src_bg,$src_col] = $source_labels[$src] ?? $source_labels['unknown'];
                ?>
                <tr style="<?= empty($l['ok']) ? 'background:#fff5f5' : '' ?>">
                    <td style="font-size:12px;color:#6b7280"><?= esc_html( substr($l['date']??'',0,16) ) ?></td>
                    <td><code style="font-size:11px"><?= esc_html( $l['to'] ?? '—' ) ?></code></td>
                    <td>
                        <span style="font-size:12px"><?= esc_html( $l['subject'] ?? '' ) ?></span>
                        <?php if ( !empty($l['type']) && $l['type'] !== 'unknown' ): ?>
                        <br><span style="font-size:10px;color:#9ca3af;font-family:monospace"><?= esc_html($l['type']) ?></span>
                        <?php endif; ?>
                        <?php if ( !empty($l['error']) ): ?>
                        <br><span style="font-size:10px;color:#dc2626">⚠ <?= esc_html($l['error']) ?></span>
                        <?php endif; ?>
                    </td>
                    <td><?= ($l['order_id']??0) ? '<a href="' . admin_url('post.php?post='.(int)$l['order_id'].'&action=edit') . '" style="font-weight:700">#'.(int)$l['order_id'].'</a>' : '<span style="color:#9ca3af">—</span>' ?></td>
                    <td>
                        <span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:<?= $src_bg ?>;color:<?= $src_col ?>">
                            <?= esc_html($src_label) ?>
                        </span>
                    </td>
                    <td>
                        <?php if ( !empty($l['ok']) ): ?>
                            <span style="color:#059669;font-weight:700">✓ Envoyé</span>
                        <?php else: ?>
                            <span style="color:#dc2626;font-weight:700">✗ Échec</span>
                        <?php endif; ?>
                    </td>
                </tr>
                <?php endforeach; ?>
            <?php endif; ?>
            </tbody>
        </table>

        <form method="post" style="margin-top:14px">
            <?php wp_nonce_field( 'miad_clear_logs' ); ?>
            <button type="submit" name="miad_clear_logs" class="button">🗑 Vider les logs</button>
            <span style="font-size:12px;color:#9ca3af;margin-left:12px">Les logs sont conservés jusqu'à 200 entrées.</span>
        </form>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   6. PAGE TEST
═══════════════════════════════════════════════════════════════════ */

function miad_email_page_test(): void {

    // ── Test flux automatique sur une vraie commande ──────────────
    $flux_result = null;
    if ( isset( $_POST['miad_test_flux'] ) && check_admin_referer( 'miad_test_flux' ) ) {
        $order_id  = intval( $_POST['flux_order_id'] ?? 0 );
        $flux_type = sanitize_key( $_POST['flux_type'] ?? 'new_order' );
        $order     = $order_id ? wc_get_order( $order_id ) : null;

        if ( ! $order && ! $order_id ) {
            // Prendre la dernière commande disponible
            $orders = wc_get_orders( [ 'limit' => 1, 'orderby' => 'date', 'order' => 'DESC' ] );
            $order  = $orders[0] ?? null;
        }

        if ( ! $order ) {
            $flux_result = [ 'ok' => false, 'msg' => 'Aucune commande trouvée.' ];
        } else {
            $before_logs = count( get_option( 'miad_email_logs', [] ) );

            switch ( $flux_type ) {
                case 'new_order':
                    // Réinitialiser le flag pour pouvoir retester
                    $order->delete_meta_data( '_miad_new_order_notified' );
                    $order->save();
                    miad_send_new_order_emails( $order->get_id() );
                    $label = 'Commande reçue (client) + Notification admin';
                    break;
                case 'processing':
                    $d = miad_compose_order_email( 'customer_processing_order', $order );
                    miad_send_professional_email( $order->get_billing_email(), $d['subject'], $d['body'], $order, [ 'email_type' => 'customer_processing_order' ] );
                    $label = 'Paiement confirmé';
                    break;
                case 'rep_taken':
                    miad_send_flow_email( 'miad_rep_taken', $order, [ 'rep_name' => 'Représentant Test' ] );
                    $label = 'Prise en charge représentant';
                    break;
                case 'tracking':
                    do_action( 'miad_tracking_assigned', $order->get_id(), 'TEST123456789', 'DHL' );
                    $label = 'Tracking DHL assigné';
                    break;
                case 'delivered':
                    miad_send_flow_email( 'miad_delivered', $order );
                    $label = 'Commande livrée';
                    break;
                case 'cancelled':
                    $d = miad_compose_order_email( 'miad_order_cancelled', $order );
                    miad_send_professional_email( $order->get_billing_email(), $d['subject'], $d['body'], $order, [ 'email_type' => 'miad_order_cancelled' ] );
                    $label = 'Commande annulée';
                    break;
                default:
                    $label = '?';
            }

            $after_logs = count( get_option( 'miad_email_logs', [] ) );
            $sent_count = $after_logs - $before_logs;
            $flux_result = [
                'ok'       => $sent_count > 0,
                'order_id' => $order->get_id(),
                'email'    => $order->get_billing_email(),
                'label'    => $label,
                'sent'     => $sent_count,
            ];
        }
    }

    // ── Test email HTML libre ─────────────────────────────────────
    if ( isset( $_POST['miad_test_send'] ) && check_admin_referer( 'miad_test' ) ) {
        $to      = sanitize_email( $_POST['test_to'] );
        $subject = sanitize_text_field( $_POST['test_subject'] );
        $body    = wp_kses_post( $_POST['test_body'] );
        $orders  = wc_get_orders( [ 'limit' => 1 ] );
        $ok      = miad_send_professional_email( $to, $subject, $body, $orders[0] ?? null );
        echo $ok ? "<div class='notice notice-success'><p>✅ Email envoyé.</p></div>" : "<div class='notice notice-error'><p>❌ Échec.</p></div>";
    }

    // ── Récupérer les 5 dernières commandes pour le sélecteur ────
    $recent_orders = wc_get_orders( [ 'limit' => 5, 'orderby' => 'date', 'order' => 'DESC' ] );
    ?>
    <div class="wrap" style="max-width:900px">
        <h1>🧪 Tests emails MIAD</h1>

        <!-- SECTION 1 : Test flux automatique -->
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:24px">
            <h2 style="font-size:15px;font-weight:800;margin:0 0 6px">⚡ Tester le déclenchement automatique</h2>
            <p style="font-size:13px;color:#6b7280;margin:0 0 18px">Simule exactement ce qui se passe en production sur une vraie commande. Vérifie que l'email part bien.</p>

            <?php if ( $flux_result ): ?>
            <div style="padding:14px 18px;border-radius:8px;margin-bottom:16px;<?= $flux_result['ok'] ? 'background:#d1fae5;border:1px solid #6ee7b7;color:#065f46' : 'background:#fee2e2;border:1px solid #fca5a5;color:#991b1b' ?>">
                <?php if ( $flux_result['ok'] ): ?>
                    ✅ <strong><?= esc_html( $flux_result['sent'] ) ?> email(s) envoyé(s)</strong> — <?= esc_html( $flux_result['label'] ) ?><br>
                    <small>Commande #<?= intval( $flux_result['order_id'] ) ?> → <?= esc_html( substr( $flux_result['email'], 0, 3 ) ) ?>***</small>
                <?php else: ?>
                    ❌ <?= esc_html( $flux_result['msg'] ?? 'Erreur inconnue' ) ?>
                <?php endif; ?>
            </div>
            <?php endif; ?>

            <form method="post" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
                <?php wp_nonce_field( 'miad_test_flux' ); ?>
                <input type="hidden" name="miad_test_flux" value="1">
                <div>
                    <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">Commande (vide = dernière)</label>
                    <select name="flux_order_id" style="height:36px;padding:0 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">
                        <option value="0">Dernière commande auto</option>
                        <?php foreach ( $recent_orders as $o ): ?>
                        <option value="<?= $o->get_id() ?>">#<?= $o->get_order_number() ?> — <?= esc_html( $o->get_billing_first_name().' '.$o->get_billing_last_name() ) ?> (<?= $o->get_status() ?>)</option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div>
                    <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">Étape du flux</label>
                    <select name="flux_type" style="height:36px;padding:0 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">
                        <option value="new_order">1. Commande créée (client + admin)</option>
                        <option value="processing">2. Paiement confirmé</option>
                        <option value="rep_taken">3. Prise en charge représentant</option>
                        <option value="tracking">4. Tracking DHL créé</option>
                        <option value="delivered">5. Commande livrée</option>
                        <option value="cancelled">Annulation</option>
                    </select>
                </div>
                <button type="submit" class="button button-primary" style="height:36px">🚀 Tester maintenant</button>
            </form>

            <!-- Indicateur de santé du système -->
            <div style="margin-top:18px;padding:12px 16px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
                <p style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#374151;margin:0 0 10px">État du système</p>
                <div style="display:flex;gap:16px;flex-wrap:wrap">
                    <?php
                    $checks = [
                        'wp_mail disponible'          => function_exists('wp_mail'),
                        'WooCommerce actif'            => class_exists('WooCommerce'),
                        'Hook checkout actif'          => has_action('woocommerce_checkout_order_created') !== false,
                        'Hook REST after_insert actif' => has_action('woocommerce_rest_after_insert_order_object') !== false,
                        'Hook pending fallback actif'  => has_action('woocommerce_order_status_pending') !== false,
                        'Hook payment_complete actif'  => has_action('woocommerce_payment_complete') !== false,
                        'Endpoint order-notify actif'  => ( rest_url('miad/v1/order-notify/1') !== '' ),
                    ];
                    foreach ( $checks as $label => $ok ):
                    ?>
                    <span style="font-size:12px;font-weight:600;color:<?= $ok ? '#059669' : '#dc2626' ?>">
                        <?= $ok ? '✅' : '❌' ?> <?= esc_html( $label ) ?>
                    </span>
                    <?php endforeach; ?>
                </div>
            </div>
        </div>

        <!-- SECTION 2 : Email HTML libre -->
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px">
            <h2 style="font-size:15px;font-weight:800;margin:0 0 16px">✉️ Envoyer un email HTML libre</h2>
            <form method="post">
                <?php wp_nonce_field( 'miad_test' ); ?>
                <input type="email" name="test_to" required placeholder="email@test.com" class="regular-text"><br><br>
                <input type="text" name="test_subject" value="[Test] Rendu MIAD" class="large-text"><br><br>
                <?php wp_editor( '<p>Test de rendu email MIAD Market.</p>', 'test_body' ); ?><br>
                <input type="submit" name="miad_test_send" class="button button-primary" value="Envoyer">
            </form>
        </div>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   7. TEMPLATE HTML PREMIUM (SANS IMAGES PRODUITS)
═══════════════════════════════════════════════════════════════════ */

function miad_get_email_html( string $body_html, ?WC_Order $order = null, array $extra = [] ): string {
    $footer_promo = get_option( 'miad_email_footer_promo', '' );
    $coins_earned = $extra['coins_earned'] ?? 0;
    $year         = date( 'Y' );

    ob_start(); ?>
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing:border-box; margin:0; padding:0 }
  body { background:#f0f0f0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; color:#1a1a1a }
  .wrap { max-width:620px; margin:24px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.12) }
  .header { background:<?= MIAD_GREEN ?>; padding:28px 32px; text-align:center }
  .header h1 { color: #fff; font-size: 1.5rem; letter-spacing: 2px; }
  .body { padding:36px 32px; font-size:15px; line-height:1.65; color:#333 }
  .body h1, .body h2 { font-size:1.25rem; font-weight:800; color:<?= MIAD_GREEN ?>; margin-bottom:12px }
  .divider { height:1px; background:#f0f0f0; margin:20px 0 }
  .products { width:100%; border-collapse:collapse; margin:20px 0 }
  .products th { background:#f9fafb; padding:10px 12px; text-align:left; font-size:.75rem; text-transform:uppercase; color:#6b7280; border-bottom:2px solid <?= MIAD_GOLD ?> }
  .products td { padding:12px; border-bottom:1px solid #f0f0f0; font-size:.9rem }
  .products tfoot td { padding-top:16px; font-weight:800; color:<?= MIAD_GREEN ?> }
  .coins-box { background:linear-gradient(135deg,#1A0A00,#3D1A00,#F5A623); border-radius:10px; padding:16px 20px; margin:20px 0; color:#fff }
  .btn { display:inline-block; background:<?= MIAD_GOLD ?>; color:#111!important; font-weight:800; padding:14px 28px; border-radius:50px; text-decoration:none; font-size:.85rem; text-transform:uppercase }
  .promo { background:#fff8e1; border:2px dashed <?= MIAD_GOLD ?>; border-radius:8px; padding:14px 18px; margin-top:20px; font-weight:700; color:<?= MIAD_GREEN ?>; text-align:center }
  .footer { background:<?= MIAD_GREEN ?>; color:rgba(255,255,255,.75); padding:28px 32px; text-align:center; font-size:.75rem; border-top:4px solid <?= MIAD_GOLD ?> }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>MIAD MARKET</h1>
  </div>

  <div class="body">
    <?= wpautop( $body_html ) ?>

    <?php if ( $order ): ?>
    <div class="divider"></div>
    <h2>Récapitulatif de commande</h2>
    <table class="products">
      <thead>
        <tr><th>Désignation Produit</th><th style="text-align:center;">Qté</th><th>Prix</th></tr>
      </thead>
      <tbody>
        <?php foreach ( $order->get_items() as $item ):
            $product = $item->get_product();
        ?>
        <tr>
          <td>
              <strong><?= esc_html( $item->get_name() ) ?></strong>
              <?php if ( $product && $product->get_sku() ): ?>
                <br><small style="color:#9ca3af">Réf : <?= esc_html( $product->get_sku() ) ?></small>
              <?php endif; ?>
          </td>
          <td style="text-align:center;"><?= (int) $item->get_quantity() ?></td>
          <td><?= $order->get_formatted_line_subtotal( $item ) ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
      <tfoot>
        <?php foreach ( $order->get_order_item_totals() as $total ): ?>
        <tr>
          <td colspan="2" style="text-align:right; padding: 6px; color:#6b7280; font-size:.85rem;"><?= $total['label'] ?></td>
          <td style="padding: 6px; font-weight:bold;"><?= $total['value'] ?></td>
        </tr>
        <?php endforeach; ?>
      </tfoot>
    </table>
    <?php endif; ?>

    <?php if ( $coins_earned > 0 ): ?>
    <div class="coins-box">
        <strong>+<?= number_format( $coins_earned ) ?> MIAD Coins gagnés !</strong>
        <p style="font-size:.85rem; margin-top:4px;">Disponibles sur votre espace client.</p>
    </div>
    <?php endif; ?>

    <?php if ( $footer_promo ): ?>
    <div class="promo"><?= esc_html( $footer_promo ) ?></div>
    <?php endif; ?>

    <div style="text-align:center;margin-top:24px">
      <a href="<?= MIAD_SITE_URL ?>" class="btn">Retour sur la boutique</a>
    </div>
  </div>

  <div class="footer">
    <p><strong>MIAD Market</strong> — L'excellence africaine partagée avec le monde.</p>
    <p style="margin-top:12px;opacity:.55">© <?= $year ?> MIAD Market. Flux transactionnel sécurisé.</p>
  </div>
</div>
</body>
</html>
<?php
    return ob_get_clean();
}

/* ═══════════════════════════════════════════════════════════════════
   8. ROUTAGE — WooCommerce déclenche, MIAD applique le template
═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   8b. ACTIONS DE STATUTS WOOCOMMERCE
═══════════════════════════════════════════════════════════════════ */

function miad_email_defaults(): array {
    return [
        'miad_order_received' => [
            'subject' => '📦 Commande #{order_number} bien reçue — MIAD Market',
            'body'    => '<h2>Merci pour votre commande, {customer_name} !</h2><p>Votre commande <strong>#{order_number}</strong> du {order_date} a été enregistrée pour un total de <strong>{order_total}</strong>.</p><p>Vous recevrez une confirmation dès validation du paiement.</p>',
        ],
        'miad_welcome' => [
            'subject' => '🎉 Bienvenue sur MIAD Market, {customer_name} !',
            'body'    => '<h2>Bienvenue, {customer_name} !</h2><p>Votre compte <strong>MIAD Market</strong> a été créé avec succès. L\'excellence africaine est maintenant à portée de clic.</p><div style="background:#f0fdf4;border-left:4px solid #005826;border-radius:6px;padding:16px 20px;margin:20px 0"><p style="font-weight:700;color:#005826;margin-bottom:10px">Avec votre compte vous pouvez :</p><ul style="margin:0;padding-left:20px;color:#374151;line-height:2"><li>Passer et suivre toutes vos commandes</li><li>Cumuler des <strong>MIAD Coins</strong> à chaque achat</li><li>Gérer vos adresses de livraison</li><li>Consulter l\'historique complet de vos achats</li></ul></div><p style="font-size:.85rem;color:#6b7280">Si vous n\'avez pas créé ce compte, contactez-nous à <a href="mailto:support@miadmarket.com" style="color:#005826;font-weight:700">support@miadmarket.com</a></p>',
        ],
        'miad_pending_payment' => [
            'subject' => '⏳ Paiement attendu — Commande #{order_number}',
            'body'    => '<h2>Action requise, {customer_name}</h2><p>La commande <strong>#{order_number}</strong> du {order_date} ({order_total}) est en attente de paiement.</p><p>Finalisez votre paiement pour que nous traitions votre commande rapidement.</p>',
        ],
        'miad_order_cancelled' => [
            'subject' => '❌ Commande #{order_number} annulée — MIAD Market',
            'body'    => '<h2>Votre commande a été annulée, {customer_name}</h2><p>La commande <strong>#{order_number}</strong> du {order_date} d\'un montant de <strong>{order_total}</strong> a été annulée.</p><div style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:6px;padding:16px 20px;margin:20px 0"><p style="margin:0;color:#991b1b">Si vous n\'avez pas demandé cette annulation ou si vous avez des questions, contactez-nous à <a href="mailto:support@miadmarket.com" style="color:#991b1b;font-weight:700">support@miadmarket.com</a></p></div><p>Si vous souhaitez repasser une commande, nos produits vous attendent sur notre boutique.</p>',
        ],
        'customer_processing_order' => [
            'subject' => '✅ Paiement validé — Commande #{order_number}',
            'body'    => '<h2>Bonjour {customer_name},</h2><p>Votre paiement a été validé pour la commande <strong>#{order_number}</strong> du {order_date}.</p><p>Notre équipe prépare l\'expédition de vos articles.</p>',
        ],
        'customer_completed_order' => [
            'subject' => '🎉 Commande #{order_number} expédiée',
            'body'    => '<h2>Votre colis est prêt, {customer_name} !</h2><p>La commande <strong>#{order_number}</strong> a été finalisée et remise au transporteur.</p>',
        ],
        'new_order' => [
            'subject' => '🔔 Notification — Nouvelle commande #{order_number}',
            'body'    => '<h2>Nouvelle vente</h2><p>Une commande <strong>#{order_number}</strong> ({order_total}) a été enregistrée.</p>',
        ],
        'miad_rep_taken' => [
            'subject' => '👤 Votre commande #{order_number} est prise en charge',
            'body'    => '<h2>Bonne nouvelle, {customer_name} !</h2><p>Votre commande <strong>#{order_number}</strong> du {order_date} est désormais prise en charge par notre représentant MIAD.</p><div style="background:#f0fdf4;border-left:4px solid #005826;border-radius:6px;padding:16px 20px;margin:20px 0"><p style="font-weight:700;color:#005826;margin-bottom:6px">Prochaines étapes :</p><ul style="margin:0;padding-left:20px;color:#374151;line-height:2"><li>Votre colis est en cours de préparation</li><li>Vous recevrez le numéro de suivi DHL dès l\'expédition</li><li>Notre équipe reste disponible pour toute question</li></ul></div><p>Merci de faire confiance à MIAD Market.</p>',
        ],
        'miad_tracking_ready' => [
            'subject' => '🚚 Votre colis est en route — Commande #{order_number}',
            'body'    => '<h2>Votre colis a été expédié, {customer_name} !</h2><p>Votre commande <strong>#{order_number}</strong> a été remise à <strong>{carrier}</strong> et est en route vers vous.</p><div style="background:#eff6ff;border:2px solid #3b82f6;border-radius:10px;padding:20px;margin:20px 0;text-align:center"><p style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Numéro de suivi</p><p style="font-size:28px;font-weight:900;color:#1d4ed8;letter-spacing:3px;font-family:monospace">{tracking_number}</p><p style="margin-top:10px"><a href="{tracking_url}" style="background:#3b82f6;color:#fff;padding:10px 24px;border-radius:50px;text-decoration:none;font-weight:700;font-size:13px">Suivre mon colis →</a></p></div><p style="font-size:13px;color:#6b7280">Délai estimé : 2-5 jours ouvrés selon votre pays de livraison.</p>',
        ],
        'miad_delivered' => [
            'subject' => '🏠 Commande #{order_number} livrée — Merci !',
            'body'    => '<h2>Votre commande est arrivée, {customer_name} !</h2><p>Nous espérons que vous êtes satisfait(e) de votre commande <strong>#{order_number}</strong>.</p><div style="background:#fff8e1;border:2px dashed #F5A623;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center"><p style="font-weight:700;color:#005826">Laissez un avis sur notre boutique et gagnez 50 MIAD Coins supplémentaires ! 🌟</p></div><p>À bientôt sur MIAD Market — l\'excellence africaine.</p>',
        ],
    ];
}

/**
 * Retourne la liste complète des shortcodes disponibles avec leur description.
 * Utilisé à la fois pour le remplacement et pour l'affichage de l'aide admin.
 */
function miad_shortcodes_list(): array {
    return [
        // Client
        '{customer_name}'      => 'Nom complet du client (prénom + nom)',
        '{customer_first_name}'=> 'Prénom du client',
        '{customer_last_name}' => 'Nom de famille du client',
        '{customer_email}'     => 'Adresse email du client',
        '{customer_phone}'     => 'Téléphone de facturation',
        // Commande
        '{order_number}'       => 'Numéro de commande WooCommerce',
        '{order_date}'         => 'Date de la commande (jj/mm/aaaa)',
        '{order_total}'        => 'Montant total de la commande',
        '{order_status}'       => 'Statut actuel de la commande',
        '{order_link}'         => 'Lien de suivi côté client',
        '{payment_method}'     => 'Méthode de paiement utilisée',
        // Adresses
        '{shipping_address}'   => 'Adresse de livraison complète',
        '{billing_address}'    => 'Adresse de facturation complète',
        '{shipping_country}'   => 'Pays de livraison',
        '{shipping_city}'      => 'Ville de livraison',
        // Produits
        '{items_count}'        => 'Nombre d\'articles commandés',
        '{items_list}'         => 'Liste des produits (noms, quantités)',
        // Logistique & Tracking
        '{tracking_number}'    => 'Numéro de suivi transporteur',
        '{carrier}'            => 'Nom du transporteur (DHL, FedEx…)',
        '{tracking_url}'       => 'URL de suivi du colis',
        '{rep_name}'           => 'Nom du représentant MIAD assigné',
        // Site
        '{site_name}'          => 'Nom du site (MIAD Market)',
        '{site_url}'           => 'URL du site',
        '{current_year}'       => 'Année en cours',
        // Fidélité
        '{coins_earned}'       => 'Coins MIAD gagnés sur cette commande',
        '{coins_balance}'      => 'Solde total Coins du client',
    ];
}

/**
 * Remplace tous les shortcodes dans une chaîne.
 * Fonctionne sur subject et body, avec ou sans commande WC.
 */
function miad_replace_shortcodes( string $text, ?WC_Order $order = null, array $extra = [] ): string {
    if ( ! $text ) return $text;

    // ── Valeurs de base (toujours disponibles) ────────────────────
    $vars = [
        '{site_name}'    => get_bloginfo('name'),
        '{site_url}'     => MIAD_SITE_URL,
        '{current_year}' => date('Y'),
        '{carrier}'           => $extra['carrier']         ?? 'DHL',
        '{tracking_number}'   => $extra['tracking_number'] ?? '',
        '{tracking_url}'      => $extra['tracking_url']    ?? '',
        '{rep_name}'          => $extra['rep_name']        ?? 'MIAD Market',
        '{coins_earned}'      => isset($extra['coins_earned']) ? number_format((int)$extra['coins_earned']) : '0',
        '{coins_balance}'     => $extra['coins_balance']   ?? '',
    ];

    // ── Valeurs liées à la commande ───────────────────────────────
    if ( $order instanceof WC_Order ) {
        $date_obj    = $order->get_date_created();
        $plain_total = html_entity_decode( wp_strip_all_tags( $order->get_formatted_order_total() ), ENT_QUOTES | ENT_HTML5 );

        // Adresse de livraison formatée sur une ligne
        $ship = $order->get_address('shipping');
        $shipping_parts = array_filter([$ship['address_1']??'',$ship['address_2']??'',$ship['city']??'',$ship['state']??'',$ship['postcode']??'',$ship['country']??'']);
        $shipping_str   = implode(', ', $shipping_parts);

        $bill = $order->get_address('billing');
        $billing_parts = array_filter([$bill['address_1']??'',$bill['address_2']??'',$bill['city']??'',$bill['state']??'',$bill['postcode']??'',$bill['country']??'']);
        $billing_str   = implode(', ', $billing_parts);

        // Liste des articles
        $items_names = [];
        foreach ( $order->get_items() as $item ) {
            $items_names[] = $item->get_name() . ' × ' . $item->get_quantity();
        }

        $vars = array_merge($vars, [
            '{customer_name}'       => $order->get_formatted_billing_full_name(),
            '{customer_first_name}' => $order->get_billing_first_name(),
            '{customer_last_name}'  => $order->get_billing_last_name(),
            '{customer_email}'      => $order->get_billing_email(),
            '{customer_phone}'      => $order->get_billing_phone(),
            '{order_number}'        => $order->get_order_number(),
            '{order_date}'          => $date_obj ? $date_obj->date_i18n('d/m/Y') : '',
            '{order_total}'         => $plain_total,
            '{order_status}'        => wc_get_order_status_name( $order->get_status() ),
            '{order_link}'          => $order->get_view_order_url(),
            '{payment_method}'      => $order->get_payment_method_title(),
            '{shipping_address}'    => $shipping_str,
            '{billing_address}'     => $billing_str,
            '{shipping_country}'    => $order->get_shipping_country(),
            '{shipping_city}'       => $order->get_shipping_city(),
            '{items_count}'         => (string) $order->get_item_count(),
            '{items_list}'          => implode(' | ', $items_names),
        ]);
    }

    $text = str_replace( array_keys($vars), array_values($vars), $text );

    // ── Nettoyage anti-spam ───────────────────────────────────────
    // 1. Supprimer tout shortcode non résolu {xxx} — Gmail/Outlook les flaggent comme phishing
    $text = preg_replace('/\{[a-z_]+\}/i', '', $text);
    // 2. Supprimer les liens avec href vide ou "#" — déclenchent les filtres anti-spam Google
    $text = preg_replace('/<a(\s[^>]*)href=["\'](\s*#?\s*)["\']([^>]*)>(.*?)<\/a>/si', '$4', $text);
    // 3. Nettoyer les espaces multiples laissés par les suppressions
    $text = preg_replace('/\s{3,}/', ' ', $text);

    return $text;
}

function miad_compose_order_email( string $email_id, WC_Order $order, array $extra = [] ): array {
    $settings = get_option( 'miad_email_settings', [] );
    $defaults = miad_email_defaults();

    $body    = ! empty( $settings[ $email_id ]['body'] )    ? $settings[ $email_id ]['body']    : ( $defaults[ $email_id ]['body']    ?? '' );
    $subject = ! empty( $settings[ $email_id ]['subject'] ) ? $settings[ $email_id ]['subject'] : ( $defaults[ $email_id ]['subject'] ?? '' );

    return [
        'subject' => miad_replace_shortcodes( $subject, $order, $extra ),
        'body'    => miad_replace_shortcodes( $body,    $order, $extra ),
    ];
}

// ── Sujets personnalisés sur les emails WC natifs ──
foreach ( [ 'new_order', 'customer_processing_order', 'customer_completed_order', 'customer_invoice', 'customer_on_hold_order' ] as $_eid ) {
    add_filter( "woocommerce_email_subject_{$_eid}", function ( $subject, $order ) use ( $_eid ) {
        $settings = get_option( 'miad_email_settings', [] );
        $custom   = $settings[ $_eid ]['subject'] ?? '';
        if ( ! $custom ) return $subject;
        return miad_replace_shortcodes( $custom, $order );
    }, 10, 2 );
}

/* ═══════════════════════════════════════════════════════════════════
   8c. DÉCLENCHEURS — COMMANDE / INSCRIPTION / PAIEMENT EN ATTENTE
═══════════════════════════════════════════════════════════════════ */

function miad_send_new_order_emails( int $order_id ): void {
    if ( ! $order_id ) return;

    // Détecter le hook déclencheur pour le log
    $trigger = 'unknown';
    if ( doing_action('woocommerce_rest_after_insert_order_object') ) $trigger = 'rest_after_insert';
    elseif ( doing_action('woocommerce_checkout_order_created') )     $trigger = 'checkout_created';
    elseif ( doing_action('woocommerce_order_status_pending') )       $trigger = 'status_pending';
    elseif ( doing_action('woocommerce_payment_complete') )           $trigger = 'payment_complete';
    elseif ( defined('REST_REQUEST') && REST_REQUEST )                $trigger = 'rest_endpoint';

    miad_activity_log( "⚡ miad_send_new_order_emails appelé (trigger: {$trigger})", $order_id, 'info' );

    $lock = 'miad_notif_' . $order_id;
    if ( get_transient( $lock ) ) {
        miad_activity_log( '🔒 Verrou actif — déjà traité, skip', $order_id, 'warn' );
        return;
    }
    set_transient( $lock, 1, 600 );
    miad_activity_log( '🔓 Verrou posé — traitement en cours', $order_id, 'info' );

    $order = wc_get_order( $order_id );
    if ( ! $order ) {
        miad_activity_log( '❌ wc_get_order() retourne null', $order_id, 'error' );
        return;
    }
    if ( $order->get_status() === 'checkout-draft' ) {
        miad_activity_log( '⏭ Statut checkout-draft — skip', $order_id, 'warn' );
        return;
    }

    $billing_email = $order->get_billing_email();
    miad_activity_log( "📧 Billing email: " . ( $billing_email ?: '(vide)' ), $order_id, $billing_email ? 'info' : 'warn' );

    if ( $billing_email === '' ) {
        for ( $i = 0; $i < 3; $i++ ) {
            sleep( 1 );
            $order         = wc_get_order( $order_id );
            $billing_email = $order ? $order->get_billing_email() : '';
            miad_activity_log( "🔄 Retry #{$i} billing email: " . ( $billing_email ?: '(vide)' ), $order_id, 'warn' );
            if ( $billing_email !== '' ) break;
        }
    }
    if ( $billing_email === '' ) {
        miad_activity_log( '❌ Billing email toujours vide après 3 retries — abandon', $order_id, 'error' );
        return;
    }

    $settings = get_option( 'miad_email_settings', [] );

    if ( ( $settings['miad_order_received']['enabled'] ?? 'yes' ) !== 'no' ) {
        $d = miad_compose_order_email( 'miad_order_received', $order );
        $ok = miad_send_professional_email( $billing_email, $d['subject'], $d['body'], $order, [ 'email_type' => 'miad_order_received' ] );
        miad_activity_log( ( $ok ? '✅' : '❌' ) . ' miad_order_received → ' . substr($billing_email,0,3) . '***', $order_id, $ok ? 'ok' : 'error' );
    }
    if ( ( $settings['new_order']['enabled'] ?? 'yes' ) !== 'no' ) {
        $d  = miad_compose_order_email( 'new_order', $order );
        $ok = miad_send_professional_email( get_option('admin_email'), $d['subject'], $d['body'], $order, [ 'email_type' => 'new_order' ] );
        miad_activity_log( ( $ok ? '✅' : '❌' ) . ' new_order → admin', $order_id, $ok ? 'ok' : 'error' );
    }

    $order->update_meta_data( '_miad_new_order_notified', '1' );
    $order->save();
    miad_activity_log( '✅ Traitement terminé', $order_id, 'ok' );
}

// Hook 1 — checkout WooCommerce natif
add_action( 'woocommerce_checkout_order_created', fn( WC_Order $o ) => miad_send_new_order_emails( $o->get_id() ) );

// Hook 2 — REST API (après que billing/meta soient sauvegardés)
add_action( 'woocommerce_rest_after_insert_order_object', function ( WC_Order $order, WP_REST_Request $request, bool $creating ) {
    if ( ! $creating ) return;
    miad_send_new_order_emails( $order->get_id() );
}, 10, 3 );

// Hook 3 — Fallback pending : commande récente qui arrive en pending (< 3 min)
add_action( 'woocommerce_order_status_pending', function ( int $order_id ) {
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $created = $order->get_date_created();
    if ( ! $created || ( time() - $created->getTimestamp() ) > 180 ) return;
    miad_send_new_order_emails( $order_id );
} );

// Hook 5 — Paiement confirmé : si l'email initial n'a pas été envoyé, l'envoyer maintenant
add_action( 'woocommerce_payment_complete', function ( int $order_id ) {
    if ( ! get_transient( 'miad_notif_' . $order_id ) ) {
        miad_send_new_order_emails( $order_id );
    }
} );

// Hook 6 — Statut processing : même logique que payment_complete pour PayDunya/Wave
add_action( 'woocommerce_order_status_processing', function ( int $order_id ) {
    if ( ! get_transient( 'miad_notif_' . $order_id ) ) {
        $order = wc_get_order( $order_id );
        if ( ! $order ) return;
        $created = $order->get_date_created();
        if ( ! $created || ( time() - $created->getTimestamp() ) > 3600 ) return;
        miad_send_new_order_emails( $order_id );
    }
} );

// "Commande annulée" — email client avec récapitulatif complet
add_action( 'woocommerce_order_status_cancelled', function ( int $order_id ) {
    $settings = get_option( 'miad_email_settings', [] );
    if ( ( $settings['miad_order_cancelled']['enabled'] ?? 'yes' ) === 'no' ) return;
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $d = miad_compose_order_email( 'miad_order_cancelled', $order );
    miad_send_professional_email( $order->get_billing_email(), $d['subject'], $d['body'], $order, [ 'email_type' => 'miad_order_cancelled' ] );
} );

// "Paiement en attente" uniquement sur changement de statut vers pending (pas à la création)
add_action( 'woocommerce_order_status_changed', function ( int $order_id, string $from, string $to ) {
    if ( $to !== 'pending' ) return;
    if ( in_array( $from, [ 'checkout-draft', 'pending', '' ], true ) ) return;
    $settings = get_option( 'miad_email_settings', [] );
    if ( ( $settings['miad_pending_payment']['enabled'] ?? 'yes' ) === 'no' ) return;
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $d = miad_compose_order_email( 'miad_pending_payment', $order );
    miad_send_professional_email( $order->get_billing_email(), $d['subject'], $d['body'], $order, [ 'email_type' => 'miad_pending_payment' ] );
}, 10, 3 );

// Fonction partagée d'envoi du mail de bienvenue
function miad_send_welcome_email( int $customer_id, string $email = '', string $name = '' ): void {
    $settings = get_option( 'miad_email_settings', [] );
    if ( ( $settings['miad_welcome']['enabled'] ?? 'yes' ) === 'no' ) return;
    $user    = get_userdata( $customer_id );
    $email   = $email ?: ( $user ? $user->user_email : '' );
    $name    = $name  ?: ( $user ? ( $user->display_name ?: $user->user_login ) : '' );
    if ( ! is_email( $email ) ) return;
    $defaults = miad_email_defaults();
    $body    = ( ! empty( $settings['miad_welcome']['body'] ) )    ? $settings['miad_welcome']['body']    : ( $defaults['miad_welcome']['body']    ?? '' );
    $subject = ( ! empty( $settings['miad_welcome']['subject'] ) ) ? $settings['miad_welcome']['subject'] : ( $defaults['miad_welcome']['subject'] ?? '' );
    $body    = str_replace( [ '{customer_name}', '{customer_email}' ], [ esc_html( $name ), esc_html( $email ) ], $body );
    $subject = str_replace( '{customer_name}', esc_html( $name ), $subject );
    miad_send_professional_email( $email, $subject, $body, null, [ 'email_type' => 'miad_welcome' ] );
}

// Bienvenue — inscription WooCommerce (caisse)
add_action( 'woocommerce_created_customer', function ( int $customer_id, array $new_customer_data ) {
    miad_send_welcome_email( $customer_id, $new_customer_data['user_email'] ?? '', '' );
}, 10, 2 );

// Bienvenue — inscription via l'app (OTP / Firebase)
add_action( 'miad_new_customer_registered', function ( int $customer_id, string $email, string $name ) {
    miad_send_welcome_email( $customer_id, $email, $name );
}, 10, 3 );

// Redirection automatique vers la page "Commande reçue" après paiement confirmé
add_filter( 'woocommerce_payment_successful_result', function ( array $result, int $order_id ): array {
    $order = wc_get_order( $order_id );
    if ( $order ) {
        $result['redirect'] = $order->get_checkout_order_received_url();
    }
    return $result;
}, 10, 2 );

/* ═══════════════════════════════════════════════════════════════════
   12. FONCTION EXPÉDITION (Logs masqués / anonymisés)
═══════════════════════════════════════════════════════════════════ */

/**
 * Retire tout lien <a> vide (href="", href="#") ou pointant vers un domaine
 * placeholder (example.com/org) en ne gardant que le texte du lien. Ces liens
 * morts sont un signal anti-spam fort chez Gmail (règles SpamAssassin
 * HREF_EMPTY_* et URI_WP_HACKED_2) — point de contrôle unique car certains
 * emails (panier abandonné, etc.) construisent leur corps sans passer par
 * miad_replace_shortcodes().
 */
function miad_strip_dead_links( string $html ): string {
    // Liens sans destination réelle : href="", href="#", href="   "
    $html = preg_replace( '/<a(\s[^>]*)?href=["\'](\s*#?\s*)["\']([^>]*)>(.*?)<\/a>/si', '$4', $html );
    // Liens vers des domaines placeholder oubliés dans un template
    $html = preg_replace( '/<a(\s[^>]*)?href=["\']https?:\/\/(www\.)?example\.(com|org|net)[^"\']*["\']([^>]*)>(.*?)<\/a>/si', '$5', $html );
    // Filet de sécurité : toute URL "wp-content" ayant échappé à la réécriture R2
    // (règle SpamAssassin URI_WP_HACKED_2 — détecte les chemins wp-content/* dans
    // les emails comme signature de site WordPress compromis). On la convertit
    // vers le CDN public R2 plutôt que de l'exposer telle quelle.
    $cfg = function_exists( 'get_option' ) ? get_option( 'miad_r2_settings', [] ) : [];
    $r2_base = untrailingslashit( $cfg['r2_base_url'] ?? 'https://pub-5830f37957e94da4a6855da37b632a3a.r2.dev' );
    $html = preg_replace( '#https?://(?:api\.)?miadmarket\.com/wp-content/uploads/#i', $r2_base . '/', $html );

    // Filet de sécurité final : tout lien restant vers api.miadmarket.com (boutique
    // vendeur, produit, etc. — quel que soit le code qui l'a généré : Dokan, WC
    // core, un template oublié) bascule vers le frontend headless. Le client ne
    // doit jamais atterrir sur le backend WordPress/API.
    $html = preg_replace( '#https?://api\.miadmarket\.com/#i', 'https://www.miadmarket.com/', $html );

    // Dokan génère ses liens boutique en /store/{slug}, mais le frontend Next.js
    // n'a pas cette route — seulement /vendor/{slug}. Sans cette réécriture, le
    // domaine est correct mais la page n'existe pas (404).
    $html = preg_replace( '#(https?://(?:www\.)?miadmarket\.com)/store/#i', '$1/vendor/', $html );

    return $html;
}

// Applique le nettoyage aussi aux emails WooCommerce natifs (Processing, Completed,
// Invoice, et nos 3 classes custom dans miad-wc-custom-emails.php) qui passent par
// WC_Email::send() directement plutôt que par miad_send_professional_email().
add_filter( 'woocommerce_mail_content', 'miad_strip_dead_links' );

function miad_send_professional_email( string $to, string $subject, string $body, ?WC_Order $order = null, array $extra = [] ): bool {
    // Format WooCommerce natif — branding via woocommerce_email_styles
    $html = ( function_exists( 'WC' ) && WC()->mailer() )
        ? WC()->mailer()->wrap_message( $subject, wpautop( $body ) )
        : $body;
    $html    = miad_strip_dead_links( $html );
    $headers = [ 'Content-Type: text/html; charset=UTF-8' ];

    $bcc_raw = get_option( 'miad_admin_bcc_emails', '' );
    if ( $bcc_raw ) {
        $bccs = array_filter( array_map( 'sanitize_email', array_map( 'trim', explode( ',', $bcc_raw ) ) ) );
        foreach ( $bccs as $bcc ) { if ( $bcc !== $to ) $headers[] = "Bcc: {$bcc}"; }
    }

    $ok = (bool) wp_mail( $to, $subject, $html, $headers );

    // Masquage de l'adresse destinataire pour protection de la confidentialité
    $split_to = explode('@', $to);
    $masked_to = substr($split_to[0], 0, 2) . '***@' . ($split_to[1] ?? 'domain.com');

    // Détecter la source de déclenchement (hook, test admin, REST API)
    $source = 'auto';
    if ( isset( $_POST['miad_test_flux'] ) || isset( $_POST['miad_test_send'] ) ) {
        $source = 'test-admin';
    } elseif ( defined('REST_REQUEST') && REST_REQUEST ) {
        $source = 'rest-api';
    } elseif ( doing_action('woocommerce_checkout_order_created') ) {
        $source = 'checkout';
    } elseif ( doing_action('woocommerce_rest_after_insert_order_object') ) {
        $source = 'rest-hook';
    }

    $logs = get_option( 'miad_email_logs', [] );
    $logs[] = [
        'date'       => current_time( 'mysql' ),
        'to'         => $masked_to,
        'subject'    => $subject,
        'ok'         => $ok ? 1 : 0,
        'order_id'   => $order ? $order->get_id() : 0,
        'type'       => $extra['email_type'] ?? 'unknown',
        'source'     => $source,
        'error'      => $ok ? '' : ( get_option('miad_last_mail_error')['message'] ?? 'Échec wp_mail' ),
    ];
    if ( count( $logs ) > 200 ) array_shift( $logs );
    update_option( 'miad_email_logs', $logs );

    return $ok;
}

/* ═══════════════════════════════════════════════════════════════════
   13. FLUX COMPLET — STATUT CUSTOM + HOOKS AUTOMATIQUES
   ────────────────────────────────────────────────────────────────
   Chaque étape de la vie d'une commande déclenche un email client :
   créée → paiement → prise en charge rep → tracking DHL → livraison
═══════════════════════════════════════════════════════════════════ */

// ── Statut WooCommerce personnalisé : "Prise en charge" ───────────
add_action( 'init', function () {
    register_post_status( 'wc-miad-rep-charge', [
        'label'                     => 'Prise en charge',
        'public'                    => true,
        'exclude_from_search'       => false,
        'show_in_admin_all_list'    => true,
        'show_in_admin_status_list' => true,
        'label_count'               => _n_noop( 'Prise en charge (%s)', 'Prises en charge (%s)' ),
    ] );
} );

add_filter( 'wc_order_statuses', function ( array $statuses ): array {
    $statuses['wc-miad-rep-charge'] = 'Prise en charge';
    return $statuses;
} );

// ── Helper : composer et envoyer un email de flux ─────────────────
function miad_send_flow_email( string $email_id, WC_Order $order, array $extra = [] ): void {
    $settings = get_option( 'miad_email_settings', [] );
    if ( ( $settings[ $email_id ]['enabled'] ?? 'yes' ) === 'no' ) return;

    $defaults = miad_email_defaults();
    $body     = ! empty( $settings[ $email_id ]['body'] )    ? $settings[ $email_id ]['body']    : ( $defaults[ $email_id ]['body']    ?? '' );
    $subject  = ! empty( $settings[ $email_id ]['subject'] ) ? $settings[ $email_id ]['subject'] : ( $defaults[ $email_id ]['subject'] ?? '' );

    $subject = miad_replace_shortcodes( $subject, $order, $extra );
    $body    = miad_replace_shortcodes( $body,    $order, $extra );

    miad_send_professional_email( $order->get_billing_email(), $subject, $body, $order, $extra );
}

// ── Étape 3 : Prise en charge par représentant ────────────────────
// Déclenché quand le statut passe à "miad-rep-charge"
add_action( 'woocommerce_order_status_changed', function ( int $order_id, string $from, string $to ) {
    if ( $to !== 'miad-rep-charge' ) return;
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    miad_send_flow_email( 'miad_rep_taken', $order );
    $order->add_order_note( '👤 Email "Prise en charge représentant" envoyé au client.', false );
}, 10, 3 );

// ── Étape 4 : Tracking DHL créé — action déclenchée par le dashboard ou le système ──
// Appelez do_action('miad_tracking_assigned', $order_id, $tracking_number, $carrier)
// depuis n'importe quel plugin (test dashboard, WooCommerce shipment manager, etc.)
add_action( 'miad_tracking_assigned', function ( int $order_id, string $tracking_number, string $carrier = 'DHL' ) {
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;

    // Construire l'URL de suivi selon le transporteur
    $tracking_urls = [
        'DHL'        => 'https://www.dhl.com/fr-fr/home/tracking/tracking-express.html?submit=1&tracking-id=' . urlencode( $tracking_number ),
        'Chronopost' => 'https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=' . urlencode( $tracking_number ),
        'FedEx'      => 'https://www.fedex.com/fedextrack/?trknbr=' . urlencode( $tracking_number ),
        'UPS'        => 'https://www.ups.com/track?tracknum=' . urlencode( $tracking_number ),
        'La Poste'   => 'https://www.laposte.fr/outils/suivre-vos-envois?code=' . urlencode( $tracking_number ),
    ];
    $tracking_url = $tracking_urls[ $carrier ] ?? '';

    // Sauvegarder le tracking en meta WooCommerce
    $order->update_meta_data( '_tracking_number', sanitize_text_field( $tracking_number ) );
    $order->update_meta_data( '_tracking_carrier', sanitize_text_field( $carrier ) );
    $order->update_meta_data( '_tracking_url', esc_url_raw( $tracking_url ) );
    $order->save();

    // Changer le statut vers "in-transit" si ce n'est pas déjà completed
    if ( ! in_array( $order->get_status(), ['completed','cancelled','refunded'], true ) ) {
        $order->update_status( 'on-hold', sprintf( '🚚 %s tracking %s assigné.', $carrier, $tracking_number ) );
    }

    // Envoyer l'email avec les détails de livraison
    miad_send_flow_email( 'miad_tracking_ready', $order, [
        'tracking_number' => $tracking_number,
        'carrier'         => $carrier,
        'tracking_url'    => $tracking_url,
    ] );

    $order->add_order_note( sprintf( '📧 Email tracking envoyé au client — %s : %s', $carrier, $tracking_number ), false );
}, 10, 3 );

// ── Étape 5 : Livraison confirmée ────────────────────────────────
// Quand le statut passe à "completed" et que c'était en transit
add_action( 'woocommerce_order_status_changed', function ( int $order_id, string $from, string $to ) {
    if ( $to !== 'completed' ) return;
    // On n'envoie l'email "livré" que si la commande avait un tracking (= vraie livraison)
    $order = wc_get_order( $order_id );
    if ( ! $order ) return;
    $has_tracking = $order->get_meta( '_tracking_number' );
    if ( ! $has_tracking ) return; // Laisse le hook existant customer_completed_order gérer les autres cas
    miad_send_flow_email( 'miad_delivered', $order );
    $order->add_order_note( '🏠 Email "Commande livrée" envoyé au client.', false );
}, 10, 3 );

// ── Résumé complet du flux pour référence ────────────────────────
// 1. woocommerce_checkout_order_created → miad_order_received      (commande créée)
// 2. woocommerce_order_status_processing → customer_processing_order (paiement confirmé)
// 3. woocommerce_order_status_changed → miad-rep-charge → miad_rep_taken (prise en charge)
// 4. do_action('miad_tracking_assigned', $id, $num, $carrier) → miad_tracking_ready (en route)
// 5. woocommerce_order_status_changed → completed + tracking → miad_delivered (livré)

function miad_email_page_activity(): void {
    if ( ! current_user_can('manage_options') ) wp_die('Accès refusé');

    if ( isset($_POST['clear_activity']) && check_admin_referer('miad_activity') ) {
        update_option( 'miad_activity_logs', [] );
        echo '<div class="notice notice-success"><p>✅ Journal vidé.</p></div>';
    }

    $logs = array_reverse( get_option( 'miad_activity_logs', [] ) );

    // Grouper par commande pour afficher un arbre par ordre
    $by_order = [];
    foreach ( $logs as $l ) {
        $key = $l['order_id'] ? '#' . $l['order_id'] : 'system';
        $by_order[$key][] = $l;
    }

    $level_colors = [
        'ok'    => '#10b981', // vert
        'info'  => '#60a5fa', // bleu
        'warn'  => '#f59e0b', // orange
        'error' => '#ef4444', // rouge
    ];
    ?>
    <div class="wrap" style="max-width:1100px">
        <h1>🖥 Journal d'activité — Commandes & Emails</h1>
        <p style="color:#6b7280;font-size:13px;margin-bottom:16px">Chaque commande entrante est tracée : endpoint appelé → verrou → billing email → emails déclenchés</p>

        <form method="post" style="margin-bottom:16px">
            <?php wp_nonce_field('miad_activity'); ?>
            <button type="submit" name="clear_activity" class="button">🗑 Vider le journal</button>
            <button type="button" onclick="location.reload()" class="button" style="margin-left:8px">↻ Actualiser</button>
            <span style="font-size:12px;color:#9ca3af;margin-left:12px"><?= count($logs) ?> événements enregistrés</span>
        </form>

        <?php if ( empty($by_order) ): ?>
        <div style="background:#1a1a2e;border-radius:12px;padding:32px;text-align:center;color:#475569">
            <p style="font-family:monospace;font-size:14px">Aucun événement enregistré.</p>
            <p style="font-size:12px;margin-top:8px">Les événements apparaîtront ici dès qu'une commande sera traitée.</p>
        </div>
        <?php else: ?>

        <?php foreach ( $by_order as $order_key => $events ): ?>
        <div style="background:#0f172a;border-radius:12px;margin-bottom:16px;overflow:hidden;border:1px solid #1e293b">

            <!-- En-tête de la commande -->
            <div style="background:#1e293b;padding:10px 18px;display:flex;align-items:center;gap:12px">
                <span style="background:#3b82f6;color:#fff;font-family:monospace;font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px"><?= esc_html($order_key) ?></span>
                <span style="color:#94a3b8;font-size:11px;font-family:monospace"><?= esc_html( $events[count($events)-1]['time'] ?? '' ) ?></span>
                <?php
                // Statut global de la commande
                $has_ok    = count( array_filter($events, fn($e) => $e['level'] === 'ok') ) > 0;
                $has_error = count( array_filter($events, fn($e) => $e['level'] === 'error') ) > 0;
                $status_badge = $has_error ? ['❌ Erreur','#ef4444'] : ($has_ok ? ['✅ Traité','#10b981'] : ['⏳ En cours','#f59e0b']);
                ?>
                <span style="background:<?= $status_badge[1] ?>22;color:<?= $status_badge[1] ?>;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:auto">
                    <?= $status_badge[0] ?>
                </span>
                <?php if ( $order_key !== 'system' ): ?>
                <a href="<?= admin_url('post.php?post=' . intval(substr($order_key,1)) . '&action=edit') ?>"
                   style="color:#60a5fa;font-size:11px;text-decoration:none" target="_blank">→ Voir commande</a>
                <?php endif; ?>
            </div>

            <!-- Logs terminal -->
            <div style="padding:14px 18px;font-family:'Courier New',monospace;font-size:12px;line-height:1.8">
                <?php foreach ( array_reverse($events) as $e ):
                    $color = $level_colors[ $e['level'] ?? 'info' ] ?? '#94a3b8';
                    $time  = substr( $e['time'] ?? '', 11, 8 ); // HH:MM:SS
                ?>
                <div style="display:flex;gap:12px;border-bottom:1px solid #1e293b;padding:2px 0">
                    <span style="color:#475569;min-width:60px;flex-shrink:0"><?= esc_html($time) ?></span>
                    <span style="color:<?= $color ?>"><?= esc_html( $e['msg'] ?? '' ) ?></span>
                </div>
                <?php endforeach; ?>
            </div>
        </div>
        <?php endforeach; ?>

        <?php endif; ?>
    </div>

    <script>
    // Auto-refresh toutes les 10 secondes si la page est ouverte
    setTimeout(() => location.reload(), 10000);
    </script>
    <?php
}

function miad_email_page_preview(): void {
    $settings = get_option( 'miad_email_settings', [] );
    $tab      = sanitize_key( $_GET['type'] ?? 'customer_completed_order' );
    $orders   = wc_get_orders( [ 'limit' => 1 ] );
    $order    = $orders[0] ?? null;

    $body = $settings[ $tab ]['body'] ?? '<h2>Gabarit transactionnel</h2><p>Contenu générique de test.</p>';
    $html = miad_get_email_html( $body, $order, [ 'coins_earned' => 250 ] );
    ?>
    <div class="wrap" style="max-width:1100px">
        <h1>👁 Aperçu sans images (Optimisé anti-spam)</h1>
        <iframe srcdoc="<?= esc_attr( $html ) ?>" style="width:100%;height:700px;border:1px solid #ddd;background:#f0f0f0"></iframe>
    </div>
    <?php
}