<?php
/**
 * Outil admin : créer une commande de test (produit + email au choix) et
 * déclencher l'envoi du vrai email "commande terminée" à cette adresse —
 * pour vérifier visuellement le rendu des images/liens produit dans les
 * emails sans devoir attendre une vraie commande client.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'admin_menu', function () {
    add_submenu_page(
        'woocommerce',
        'Test Email Commande',
        '✉️ Test Email Commande',
        'manage_woocommerce',
        'miad-test-order-email',
        'miad_test_order_email_page'
    );
} );

function miad_test_order_email_page(): void {
    $notice = '';

    if ( isset( $_POST['miad_test_order_submit'] ) && check_admin_referer( 'miad_test_order_email' ) ) {
        $product_id = (int) ( $_POST['miad_product_id'] ?? 0 );
        $email      = sanitize_email( $_POST['miad_test_email'] ?? '' );

        if ( ! $product_id || ! is_email( $email ) ) {
            $notice = '<div class="notice notice-error"><p>❌ Choisis un produit et entre une adresse email valide.</p></div>';
        } else {
            $product = wc_get_product( $product_id );
            if ( ! $product ) {
                $notice = '<div class="notice notice-error"><p>❌ Produit introuvable.</p></div>';
            } else {
                $order = wc_create_order();
                $order->add_product( $product, 1 );
                $order->set_address( [
                    'first_name' => 'Test',
                    'last_name'  => 'MIAD',
                    'email'      => $email,
                ], 'billing' );
                $order->set_billing_email( $email );
                $order->calculate_totals();
                $order->update_status( 'completed', 'Commande de test générée pour vérifier le rendu email.' );
                $order->save();

                // Déclenche l'email "commande terminée" (celui que reçoit réellement un client)
                WC()->mailer()->emails['WC_Email_Customer_Completed_Order']->trigger( $order->get_id() );

                $notice = '<div class="notice notice-success"><p>✅ Commande #' . $order->get_id() . ' créée et email envoyé à <strong>' . esc_html( $email ) . '</strong>. Vérifie la boîte de réception (et les spams).</p></div>';
            }
        }
    }

    $products = get_posts( [
        'post_type'      => 'product',
        'post_status'    => 'publish',
        'posts_per_page' => 200,
        'orderby'        => 'title',
        'order'          => 'ASC',
    ] );

    echo $notice;
    ?>
    <div class="wrap">
        <h1>✉️ Test Email de Commande</h1>
        <p style="color:#555;max-width:600px">
            Crée une commande de test avec le produit choisi, la marque "terminée", et envoie le vrai email
            "commande terminée" à l'adresse indiquée — pour vérifier le rendu des images et des liens produit
            tels qu'un client les recevrait réellement.
        </p>

        <form method="post" style="max-width:500px">
            <?php wp_nonce_field( 'miad_test_order_email' ); ?>
            <table class="form-table">
                <tr>
                    <th><label for="miad_product_id">Produit</label></th>
                    <td>
                        <select name="miad_product_id" id="miad_product_id" class="regular-text" required>
                            <option value="">— Choisir un produit —</option>
                            <?php foreach ( $products as $p ) : ?>
                                <option value="<?= esc_attr( $p->ID ) ?>"><?= esc_html( $p->post_title ) ?> (#<?= $p->ID ?>)</option>
                            <?php endforeach; ?>
                        </select>
                    </td>
                </tr>
                <tr>
                    <th><label for="miad_test_email">Adresse email</label></th>
                    <td>
                        <input type="email" name="miad_test_email" id="miad_test_email" class="regular-text"
                               placeholder="toi@exemple.com" required />
                    </td>
                </tr>
            </table>
            <p>
                <button type="submit" name="miad_test_order_submit" class="button button-primary">
                    📨 Créer la commande et envoyer l'email
                </button>
            </p>
        </form>
    </div>
    <?php
}
