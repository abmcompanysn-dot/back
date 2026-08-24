<?php
/**
 * Plugin Name: MIAD Quick Order Test
 * Description: Bouton dans la barre admin pour créer une commande test et vérifier les emails en 1 clic.
 * Version: 1.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ── Bouton dans la barre d'admin ─────────────────────────────────
add_action( 'admin_bar_menu', function ( WP_Admin_Bar $bar ) {
    if ( ! current_user_can( 'manage_options' ) ) return;
    $bar->add_node( [
        'id'    => 'miad-test-order',
        'title' => '🧪 Test commande',
        'href'  => '#',
        'meta'  => [
            'onclick' => 'miadTestOrder(); return false;',
            'title'   => 'Créer une commande test et vérifier les emails',
        ],
    ] );
}, 100 );

// ── CSS + JS injecté sur toutes les pages admin ──────────────────
add_action( 'admin_head', function () {
    if ( ! current_user_can( 'manage_options' ) ) return;
    ?>
    <style>
    #wp-admin-bar-miad-test-order > .ab-item {
        background: #7c3aed !important;
        color: #fff !important;
        border-radius: 6px;
        font-weight: 700 !important;
    }
    #wp-admin-bar-miad-test-order > .ab-item:hover { background: #6d28d9 !important; }
    #miad-toast {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        background: #0f172a; color: #e2e8f0;
        font-family: 'Courier New', monospace; font-size: 13px;
        border-radius: 12px; padding: 18px 22px; min-width: 340px;
        border: 1px solid #1e293b; box-shadow: 0 8px 32px rgba(0,0,0,.4);
        display: none; max-width: 440px;
    }
    #miad-toast .t-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
    #miad-toast .t-badge { background:#7c3aed; color:#fff; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:700; }
    #miad-toast .t-line { padding:3px 0; border-bottom:1px solid #1e293b; display:flex; gap:10px; }
    #miad-toast .t-line:last-child { border:none; }
    #miad-toast .t-time { color:#475569; min-width:55px; }
    #miad-toast .ok   { color:#10b981; }
    #miad-toast .info { color:#60a5fa; }
    #miad-toast .warn { color:#f59e0b; }
    #miad-toast .err  { color:#ef4444; }
    #miad-toast .t-actions { display:flex; gap:8px; margin-top:14px; }
    #miad-toast .t-btn { padding:6px 14px; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer; border:none; text-decoration:none; display:inline-block; }
    #miad-toast .t-btn.primary { background:#7c3aed; color:#fff; }
    #miad-toast .t-btn.ghost   { background:#1e293b; color:#94a3b8; }
    #miad-spinner { display:inline-block; width:14px; height:14px; border:2px solid #475569; border-top-color:#7c3aed; border-radius:50%; animation:miad-spin .6s linear infinite; }
    @keyframes miad-spin { to { transform:rotate(360deg); } }
    </style>
    <div id="miad-toast">
        <div class="t-head">
            <span class="t-badge">🧪 MIAD Test</span>
            <span id="miad-toast-title" style="font-weight:700">Création en cours…</span>
        </div>
        <div id="miad-toast-body"></div>
        <div class="t-actions" id="miad-toast-actions" style="display:none"></div>
    </div>
    <script>
    function miadLog(msg, cls) {
        const b = document.getElementById('miad-toast-body');
        const d = new Date(); const t = d.toTimeString().substring(0,8);
        b.innerHTML += `<div class="t-line"><span class="t-time">${t}</span><span class="${cls||'info'}">${msg}</span></div>`;
        b.scrollTop = b.scrollHeight;
    }
    function miadShowToast(title) {
        const el = document.getElementById('miad-toast');
        document.getElementById('miad-toast-title').textContent = title;
        document.getElementById('miad-toast-body').innerHTML = '';
        document.getElementById('miad-toast-actions').style.display = 'none';
        el.style.display = 'block';
    }
    function miadCloseToast() {
        document.getElementById('miad-toast').style.display = 'none';
    }
    function miadTestOrder() {
        miadShowToast('⏳ Création commande test…');
        miadLog('Envoi de la requête au serveur…', 'info');

        fetch('<?= admin_url('admin-ajax.php') ?>', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'action=miad_create_test_order&nonce=<?= wp_create_nonce('miad_test_nonce') ?>'
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                document.getElementById('miad-toast-title').textContent = '✅ Commande créée !';
                miadLog(`Commande #${data.order_id} créée`, 'ok');
                miadLog(`Produit : ${data.product}`, 'info');
                miadLog(`Total : ${data.total}`, 'info');
                miadLog('─────────────────────────────', 'info');
                if (data.email_sent) {
                    miadLog('✅ Email envoyé à ' + data.email_masked, 'ok');
                    miadLog('Vérifiez votre boîte mail !', 'ok');
                } else {
                    miadLog('⚠ Email non confirmé', 'warn');
                    miadLog('Vérifiez les Logs MIAD Emails', 'warn');
                }
                const act = document.getElementById('miad-toast-actions');
                act.style.display = 'flex';
                act.innerHTML = `
                    <a href="${data.order_url}" target="_blank" class="t-btn primary">→ Voir commande</a>
                    <a href="<?= admin_url('admin.php?page=miad-emails-activity') ?>" target="_blank" class="t-btn ghost">🖥 Activité</a>
                    <button onclick="miadCloseToast()" class="t-btn ghost">✕</button>
                `;
            } else {
                document.getElementById('miad-toast-title').textContent = '❌ Erreur';
                miadLog(data.message || 'Erreur inconnue', 'err');
                document.getElementById('miad-toast-actions').style.display = 'flex';
                document.getElementById('miad-toast-actions').innerHTML = '<button onclick="miadCloseToast()" class="t-btn ghost">✕ Fermer</button>';
            }
        })
        .catch(err => {
            document.getElementById('miad-toast-title').textContent = '❌ Erreur réseau';
            miadLog('Erreur : ' + err.message, 'err');
        });
    }
    // Fermer avec Echap
    document.addEventListener('keydown', e => { if(e.key==='Escape') miadCloseToast(); });
    </script>
    <?php
} );

// Injecter aussi sur le front si l'admin bar est visible
add_action( 'wp_head', function () {
    if ( ! is_admin_bar_showing() || ! current_user_can( 'manage_options' ) ) return;
    // Réutiliser le même CSS/JS via admin_head callback
    do_action( 'admin_head' );
} );

// ── AJAX Handler ─────────────────────────────────────────────────
add_action( 'wp_ajax_miad_create_test_order', 'miad_ajax_create_test_order' );

function miad_ajax_create_test_order(): void {
    check_ajax_referer( 'miad_test_nonce', 'nonce' );
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Accès refusé' ] );

    // Trouver le premier produit publiable
    $products = wc_get_products( [ 'status' => 'publish', 'limit' => 1 ] );
    if ( empty( $products ) ) {
        wp_send_json_error( [ 'message' => 'Aucun produit disponible' ] );
    }
    $product = $products[0];

    $admin     = wp_get_current_user();
    $email     = $admin->user_email;
    $full_name = $admin->display_name ?: $admin->user_login;
    $first     = explode( ' ', $full_name )[0];
    $last      = substr( $full_name, strlen( $first ) + 1 ) ?: 'Test';

    // Créer la commande WooCommerce
    $order = wc_create_order( [ 'customer_id' => $admin->ID ] );
    $order->add_product( $product, 1 );
    $order->set_billing_email( $email );
    $order->set_billing_first_name( $first );
    $order->set_billing_last_name( $last );
    $order->set_billing_address_1( 'Dakar Test' );
    $order->set_billing_city( 'Dakar' );
    $order->set_billing_country( 'SN' );
    $order->set_billing_phone( '+221770000000' );
    $order->set_shipping_first_name( $first );
    $order->set_shipping_last_name( $last );
    $order->set_shipping_address_1( 'Dakar Test' );
    $order->set_shipping_city( 'Dakar' );
    $order->set_shipping_country( 'SN' );
    $order->set_payment_method( 'bacs' );
    $order->set_payment_method_title( 'MIAD Quick Test' );
    $order->calculate_totals();
    $order->set_status( 'pending', 'Commande test créée depuis la barre admin MIAD', true );
    $order->save();
    $order->add_order_meta_data( '_miad_test_order', '1' );
    $order->save();

    $order_id = $order->get_id();

    // Déclencher les emails — WC va envoyer ses emails natifs qui déclencheront notre template
    // On force aussi notre fonction directement
    delete_transient( 'miad_notif_' . $order_id );
    delete_transient( 'miad_recv_' . $order_id );

    $email_sent = false;
    if ( function_exists( 'miad_send_new_order_emails' ) ) {
        miad_send_new_order_emails( $order_id );
        $email_sent = get_transient( 'miad_notif_' . $order_id ) === 1 ||
                      (bool) $order->get_meta( '_miad_new_order_notified' );
    }

    // Aussi déclencher l'email WC natif new_order (admin)
    WC()->mailer()->emails['WC_Email_New_Order']->trigger( $order_id );

    $masked = substr( $email, 0, 2 ) . '***@' . explode( '@', $email )[1];

    wp_send_json_success( [
        'order_id'     => $order_id,
        'product'      => $product->get_name(),
        'total'        => $order->get_formatted_order_total(),
        'email_masked' => $masked,
        'email_sent'   => $email_sent,
        'order_url'    => admin_url( 'post.php?post=' . $order_id . '&action=edit' ),
    ] );
}
