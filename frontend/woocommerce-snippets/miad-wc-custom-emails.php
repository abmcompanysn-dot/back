<?php
/**
 * Plugin Name: MIAD Custom WC Emails
 * Description: 3 emails WooCommerce natifs — Tracking DHL, Livraison confirmée, Prise en charge représentant.
 *              Apparaissent dans WooCommerce → Réglages → Emails. Utilisent le CSS MIAD.
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   LIENS — Tous les liens "Voir ma commande" pointent vers le frontend MIAD
   Raison : site headless Next.js — le client ne doit jamais aller sur /wp/
═══════════════════════════════════════════════════════════════════ */

// "View order" → frontend client
add_filter( 'woocommerce_get_view_order_url', function ( string $url, WC_Order $order ): string {
    return 'https://www.miadmarket.com/account/orders/' . $order->get_id();
}, 10, 2 );

// "Mon compte" → frontend client
add_filter( 'woocommerce_get_myaccount_page_permalink', function (): string {
    return 'https://www.miadmarket.com/account';
} );

// "Pay for order" → frontend client (checkout/pay/{id}?key=...)
add_filter( 'woocommerce_get_checkout_payment_url', function ( string $url, WC_Order $order ): string {
    return 'https://www.miadmarket.com/checkout/pay/' . $order->get_id() . '?key=' . $order->get_order_key();
}, 10, 2 );

// Boutiques vendeurs Dokan → www.miadmarket.com/vendor/{slug} au lieu de
// api.miadmarket.com/store/{slug} — le frontend Next.js n'a pas de route
// /store/, seulement /vendor/.
add_filter( 'dokan_store_url', function ( string $url ): string {
    $url = str_replace( 'https://api.miadmarket.com', 'https://www.miadmarket.com', $url );
    return preg_replace( '#(https?://(?:www\.)?miadmarket\.com)/store/#i', '$1/vendor/', $url );
} );

/* ═══════════════════════════════════════════════════════════════════
   TRACKING DE LIENS — Désactivé
   Raison : FluentSMTP réécrit les liens via son proxy de suivi →
            Gmail reconnaît l'URL de tracking et bloque la livraison.
            Solution : couper le tracking + déshabiller les liens /store/.
═══════════════════════════════════════════════════════════════════ */

// Désactiver click-tracking + open-tracking FluentSMTP (Pro & Free)
add_filter( 'fluentmail_email_tracking_enabled',  '__return_false', 1 );
add_filter( 'fluentsmtp_email_tracking_enabled',  '__return_false', 1 );
add_filter( 'fluentmail_disable_email_tracking',  '__return_true',  1 );



/* ═══════════════════════════════════════════════════════════════════
   IMAGES PRODUITS — Désactivées dans TOUS les emails WooCommerce
   Raison : URLs Cloudflare R2 dans les emails → Gmail bloque.
   Le tableau produits reste complet (nom, qté, prix) sans les photos.
═══════════════════════════════════════════════════════════════════ */

// Désactiver le flag show_image
add_filter( 'woocommerce_email_order_items_args', function ( array $args ): array {
    $args['show_image'] = false;
    return $args;
} );

// Supprimer le tag <img> produit même si WC l'injecte quand même
add_filter( 'woocommerce_order_item_thumbnail', '__return_empty_string' );

// Supprimer la colonne image dans le tableau produits (CSS)
add_filter( 'woocommerce_email_styles', function ( string $css ): string {
    return $css . '
.order-items .product-thumbnail,
.email-order-details .product-thumbnail,
td.product-thumbnail { display:none !important; width:0 !important; padding:0 !important; }
';
}, 30 );

/* ═══════════════════════════════════════════════════════════════════
   ENREGISTREMENT DANS WOOCOMMERCE
═══════════════════════════════════════════════════════════════════ */

add_filter( 'woocommerce_email_classes', function ( array $email_classes ): array {
    if ( ! class_exists( 'MIAD_Email_Tracking_Ready' ) ) return $email_classes;
    $email_classes['MIAD_Email_Tracking_Ready'] = new MIAD_Email_Tracking_Ready();
    $email_classes['MIAD_Email_Delivered']      = new MIAD_Email_Delivered();
    $email_classes['MIAD_Email_Rep_Taken']      = new MIAD_Email_Rep_Taken();
    return $email_classes;
} );

if ( ! class_exists( 'WC_Email' ) ) return;

/* ═══════════════════════════════════════════════════════════════════
   EMAIL 1 — Colis en route (Tracking DHL)
   Trigger : do_action( 'miad_tracking_assigned', $order_id, $tracking_number, $carrier )
═══════════════════════════════════════════════════════════════════ */

class MIAD_Email_Tracking_Ready extends WC_Email {

    public string $tracking_number = '';
    public string $carrier         = 'DHL';

    public function __construct() {
        $this->id             = 'miad_tracking_ready';
        $this->customer_email = true;
        $this->title          = 'MIAD — Colis en route (Tracking)';
        $this->description    = 'Envoyé au client lorsqu\'un numéro de suivi est assigné à sa commande.';
        $this->placeholders   = [
            '{order_number}' => '',
            '{order_date}'   => '',
            '{site_title}'   => $this->get_blogname(),
        ];
        add_action( 'miad_tracking_assigned', [ $this, 'trigger' ], 10, 3 );
        parent::__construct();
        $this->subject = $this->get_option( 'subject', '🚚 Votre colis est en route — Commande #{order_number}' );
        $this->heading = $this->get_option( 'heading', 'Votre colis a été expédié !' );
    }

    public function trigger( int $order_id, string $tracking_number, string $carrier = 'DHL' ): void {
        $this->setup_locale();
        $order = wc_get_order( $order_id );
        if ( ! $order ) { $this->restore_locale(); return; }

        $this->object          = $order;
        $this->tracking_number = $tracking_number;
        $this->carrier         = $carrier;
        $this->recipient       = $order->get_billing_email();
        $this->placeholders['{order_number}'] = $order->get_order_number();
        $this->placeholders['{order_date}']   = wc_format_datetime( $order->get_date_created() );

        // Sauvegarder tracking en meta
        $tracking_urls = [
            'DHL'        => 'https://www.dhl.com/fr-fr/home/tracking/tracking-express.html?submit=1&tracking-id=' . urlencode( $tracking_number ),
            'Chronopost' => 'https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=' . urlencode( $tracking_number ),
            'FedEx'      => 'https://www.fedex.com/fedextrack/?trknbr=' . urlencode( $tracking_number ),
            'UPS'        => 'https://www.ups.com/track?tracknum=' . urlencode( $tracking_number ),
        ];
        $tracking_url = $tracking_urls[ $carrier ] ?? '';
        $order->update_meta_data( '_tracking_number', sanitize_text_field( $tracking_number ) );
        $order->update_meta_data( '_tracking_carrier', sanitize_text_field( $carrier ) );
        $order->update_meta_data( '_tracking_url', esc_url_raw( $tracking_url ) );
        $order->save();

        if ( $this->is_enabled() && $this->get_recipient() ) {
            $this->send( $this->get_recipient(), $this->get_subject(), $this->get_content(), $this->get_headers(), $this->get_attachments() );
            $order->add_order_note( sprintf( '📧 Email tracking envoyé — %s : %s', esc_html( $carrier ), esc_html( $tracking_number ) ), false );
        }
        $this->restore_locale();
    }

    public function get_content_html(): string {
        $order           = $this->object;
        $tracking_number = $this->tracking_number;
        $carrier         = $this->carrier;
        $tracking_url    = $order->get_meta( '_tracking_url' ) ?: '';

        ob_start();
        wc_get_template( 'emails/email-header.php', [ 'email_heading' => $this->get_heading(), 'email' => $this ] );
        ?>
        <p>Bonjour <?= esc_html( $order->get_billing_first_name() ) ?>,</p>
        <p>Votre commande <strong>#<?= esc_html( $order->get_order_number() ) ?></strong> a été remise à <strong><?= esc_html( $carrier ) ?></strong> et est en route vers vous.</p>

        <div style="background:#eff6ff;border:2px solid #3b82f6;border-radius:10px;padding:20px;margin:20px 0;text-align:center">
            <p style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Numéro de suivi</p>
            <p style="font-size:28px;font-weight:900;color:#1d4ed8;letter-spacing:3px;font-family:monospace"><?= esc_html( $tracking_number ) ?></p>
            <?php if ( $tracking_url ): ?>
            <p style="margin-top:10px">
                <a href="<?= esc_url( $tracking_url ) ?>" class="button" style="background:#3b82f6;color:#fff;padding:10px 24px;border-radius:50px;text-decoration:none;font-weight:700;font-size:13px">Suivre mon colis →</a>
            </p>
            <?php endif; ?>
        </div>

        <p style="font-size:13px;color:#6b7280">Délai estimé : 2-5 jours ouvrés selon votre pays de livraison.</p>
        <?php
        do_action( 'woocommerce_email_order_details', $order, $this->sent_to_admin, $this->plain_text, $this );
        do_action( 'woocommerce_email_order_meta',    $order, $this->sent_to_admin, $this->plain_text, $this );
        do_action( 'woocommerce_email_customer_details', $order, $this->sent_to_admin, $this->plain_text, $this );
        wc_get_template( 'emails/email-footer.php', [ 'email' => $this ] );
        return ob_get_clean();
    }

    public function get_content_plain(): string { return ''; }

    public function init_form_fields(): void {
        $this->form_fields = [
            'enabled'    => [ 'title' => 'Activer/Désactiver', 'type' => 'checkbox', 'label' => 'Activer cet email', 'default' => 'yes' ],
            'subject'    => [ 'title' => 'Sujet', 'type' => 'text', 'default' => '', 'placeholder' => $this->get_default_subject(), 'desc_tip' => true, 'description' => 'Disponible : {order_number}' ],
            'heading'    => [ 'title' => 'En-tête', 'type' => 'text', 'default' => '', 'placeholder' => $this->get_default_heading() ],
            'email_type' => [ 'title' => 'Type', 'type' => 'select', 'default' => 'html', 'class' => 'email_type wc-enhanced-select', 'options' => $this->get_email_type_options() ],
        ];
    }
}

/* ═══════════════════════════════════════════════════════════════════
   EMAIL 2 — Commande livrée
   Trigger : statut → completed, uniquement si tracking enregistré
═══════════════════════════════════════════════════════════════════ */

class MIAD_Email_Delivered extends WC_Email {

    public function __construct() {
        $this->id             = 'miad_delivered';
        $this->customer_email = true;
        $this->title          = 'MIAD — Commande livrée';
        $this->description    = 'Envoyé au client lorsque la commande passe à "Terminée" et qu\'un numéro de tracking existe.';
        $this->placeholders   = [
            '{order_number}' => '',
            '{order_date}'   => '',
            '{site_title}'   => $this->get_blogname(),
        ];
        add_action( 'woocommerce_order_status_completed', [ $this, 'trigger' ], 10, 2 );
        parent::__construct();
        $this->subject = $this->get_option( 'subject', '🏠 Votre commande #{order_number} est livrée — Merci !' );
        $this->heading = $this->get_option( 'heading', 'Votre commande est arrivée !' );
    }

    public function trigger( int $order_id, WC_Order $order = null ): void {
        $this->setup_locale();
        if ( ! $order ) $order = wc_get_order( $order_id );
        if ( ! $order ) { $this->restore_locale(); return; }
        // Seulement si un tracking existe — sinon WC envoie son email "Terminée" standard
        if ( ! $order->get_meta( '_tracking_number' ) ) { $this->restore_locale(); return; }

        $this->object    = $order;
        $this->recipient = $order->get_billing_email();
        $this->placeholders['{order_number}'] = $order->get_order_number();
        $this->placeholders['{order_date}']   = wc_format_datetime( $order->get_date_created() );

        if ( $this->is_enabled() && $this->get_recipient() ) {
            $this->send( $this->get_recipient(), $this->get_subject(), $this->get_content(), $this->get_headers(), $this->get_attachments() );
            $order->add_order_note( '🏠 Email "Commande livrée" envoyé au client.', false );
        }
        $this->restore_locale();
    }

    public function get_content_html(): string {
        $order = $this->object;
        ob_start();
        wc_get_template( 'emails/email-header.php', [ 'email_heading' => $this->get_heading(), 'email' => $this ] );
        ?>
        <p>Bonjour <?= esc_html( $order->get_billing_first_name() ) ?>,</p>
        <p>Nous espérons que vous êtes satisfait(e) de votre commande <strong>#<?= esc_html( $order->get_order_number() ) ?></strong>.</p>
        <div style="background:#fff8e1;border:2px dashed #F5A623;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
            <p style="font-weight:700;color:#005826">Laissez un avis sur notre boutique et gagnez 50 MIAD Coins supplémentaires ! 🌟</p>
        </div>
        <p>À bientôt sur MIAD Market — l'excellence africaine.</p>
        <?php
        do_action( 'woocommerce_email_order_details', $order, $this->sent_to_admin, $this->plain_text, $this );
        do_action( 'woocommerce_email_order_meta',    $order, $this->sent_to_admin, $this->plain_text, $this );
        wc_get_template( 'emails/email-footer.php', [ 'email' => $this ] );
        return ob_get_clean();
    }

    public function get_content_plain(): string { return ''; }

    public function init_form_fields(): void {
        $this->form_fields = [
            'enabled'    => [ 'title' => 'Activer/Désactiver', 'type' => 'checkbox', 'label' => 'Activer cet email', 'default' => 'yes' ],
            'subject'    => [ 'title' => 'Sujet', 'type' => 'text', 'default' => '', 'placeholder' => $this->get_default_subject(), 'desc_tip' => true, 'description' => 'Disponible : {order_number}' ],
            'heading'    => [ 'title' => 'En-tête', 'type' => 'text', 'default' => '', 'placeholder' => $this->get_default_heading() ],
            'email_type' => [ 'title' => 'Type', 'type' => 'select', 'default' => 'html', 'class' => 'email_type wc-enhanced-select', 'options' => $this->get_email_type_options() ],
        ];
    }
}

/* ═══════════════════════════════════════════════════════════════════
   EMAIL 3 — Prise en charge représentant
   Trigger : statut → wc-miad-rep-charge
═══════════════════════════════════════════════════════════════════ */

class MIAD_Email_Rep_Taken extends WC_Email {

    public function __construct() {
        $this->id             = 'miad_rep_taken';
        $this->customer_email = true;
        $this->title          = 'MIAD — Prise en charge représentant';
        $this->description    = 'Envoyé au client lorsque le statut de la commande passe à "Prise en charge".';
        $this->placeholders   = [
            '{order_number}' => '',
            '{order_date}'   => '',
            '{site_title}'   => $this->get_blogname(),
        ];
        // Le statut WooCommerce 'wc-miad-rep-charge' déclenche cette action
        add_action( 'woocommerce_order_status_miad-rep-charge', [ $this, 'trigger' ], 10, 2 );
        parent::__construct();
        $this->subject = $this->get_option( 'subject', '👤 Votre commande #{order_number} est prise en charge' );
        $this->heading = $this->get_option( 'heading', 'Bonne nouvelle !' );
    }

    public function trigger( int $order_id, WC_Order $order = null ): void {
        $this->setup_locale();
        if ( ! $order ) $order = wc_get_order( $order_id );
        if ( ! $order ) { $this->restore_locale(); return; }

        $this->object    = $order;
        $this->recipient = $order->get_billing_email();
        $this->placeholders['{order_number}'] = $order->get_order_number();
        $this->placeholders['{order_date}']   = wc_format_datetime( $order->get_date_created() );

        if ( $this->is_enabled() && $this->get_recipient() ) {
            $this->send( $this->get_recipient(), $this->get_subject(), $this->get_content(), $this->get_headers(), $this->get_attachments() );
            $order->add_order_note( '👤 Email "Prise en charge représentant" envoyé au client.', false );
        }
        $this->restore_locale();
    }

    public function get_content_html(): string {
        $order = $this->object;
        ob_start();
        wc_get_template( 'emails/email-header.php', [ 'email_heading' => $this->get_heading(), 'email' => $this ] );
        ?>
        <p>Bonjour <?= esc_html( $order->get_billing_first_name() ) ?>,</p>
        <p>Votre commande <strong>#<?= esc_html( $order->get_order_number() ) ?></strong> est désormais prise en charge par notre représentant MIAD.</p>
        <div style="background:#f0fdf4;border-left:4px solid #005826;border-radius:6px;padding:16px 20px;margin:20px 0">
            <p style="font-weight:700;color:#005826;margin-bottom:6px">Prochaines étapes :</p>
            <ul style="margin:0;padding-left:20px;color:#374151;line-height:2">
                <li>Votre colis est en cours de préparation</li>
                <li>Vous recevrez le numéro de suivi dès l'expédition</li>
                <li>Notre équipe reste disponible pour toute question</li>
            </ul>
        </div>
        <p>Merci de faire confiance à MIAD Market.</p>
        <?php
        do_action( 'woocommerce_email_order_details', $order, $this->sent_to_admin, $this->plain_text, $this );
        wc_get_template( 'emails/email-footer.php', [ 'email' => $this ] );
        return ob_get_clean();
    }

    public function get_content_plain(): string { return ''; }

    public function init_form_fields(): void {
        $this->form_fields = [
            'enabled'    => [ 'title' => 'Activer/Désactiver', 'type' => 'checkbox', 'label' => 'Activer cet email', 'default' => 'yes' ],
            'subject'    => [ 'title' => 'Sujet', 'type' => 'text', 'default' => '', 'placeholder' => $this->get_default_subject(), 'desc_tip' => true, 'description' => 'Disponible : {order_number}' ],
            'heading'    => [ 'title' => 'En-tête', 'type' => 'text', 'default' => '', 'placeholder' => $this->get_default_heading() ],
            'email_type' => [ 'title' => 'Type', 'type' => 'select', 'default' => 'html', 'class' => 'email_type wc-enhanced-select', 'options' => $this->get_email_type_options() ],
        ];
    }
}
