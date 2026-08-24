<?php
/**
 * MIAD Coins — Page Admin WordPress
 *
 * Ajoute un menu "MIAD Coins" dans le dashboard WordPress avec :
 *  - Vue d'ensemble (stats, coins en circulation)
 *  - Gestion des coins par utilisateur (ajouter / retirer)
 *  - Liste des transactions récentes
 *  - Gestion des coupons de réduction
 *  - Export CSV
 *
 * Nécessite : miad-coins.php (chargé en premier)
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   ENREGISTREMENT DU MENU
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {

    add_menu_page(
        'MIAD Coins',
        'MIAD Coins 🪙',
        'manage_woocommerce',
        'miad-coins',
        'miad_coins_page_overview',
        'dashicons-awards',
        56
    );

    add_submenu_page( 'miad-coins', 'Vue d\'ensemble', 'Vue d\'ensemble', 'manage_woocommerce', 'miad-coins',            'miad_coins_page_overview' );
    add_submenu_page( 'miad-coins', 'Utilisateurs',    'Utilisateurs',    'manage_woocommerce', 'miad-coins-users',       'miad_coins_page_users'    );
    add_submenu_page( 'miad-coins', 'Transactions',    'Transactions',    'manage_woocommerce', 'miad-coins-transactions','miad_coins_page_tx'       );
    add_submenu_page( 'miad-coins', 'Coupons',         'Coupons',         'manage_woocommerce', 'miad-coins-coupons',     'miad_coins_page_coupons'  );
} );

/* ═══════════════════════════════════════════════════════════════════
   STYLES COMMUNS
═══════════════════════════════════════════════════════════════════ */

function miad_admin_style(): void { ?>
<style>
.miad-wrap { max-width:1100px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
.miad-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:16px; margin:20px 0 }
.miad-card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:20px; }
.miad-card-gold { border-top:4px solid #F5A623; }
.miad-card .val { font-size:2rem; font-weight:900; color:#1a1a1a; line-height:1.1 }
.miad-card .lbl { font-size:.75rem; color:#6b7280; margin-top:4px; text-transform:uppercase; letter-spacing:.05em }
.miad-card .sub { font-size:.8rem; color:#F5A623; font-weight:700; margin-top:2px }
.miad-table { width:100%; border-collapse:collapse; background:#fff; border-radius:12px; overflow:hidden; border:1px solid #e5e7eb }
.miad-table th { background:#f9fafb; padding:10px 14px; text-align:left; font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color:#6b7280; border-bottom:1px solid #e5e7eb }
.miad-table td { padding:10px 14px; border-bottom:1px solid #f3f4f6; font-size:.85rem; vertical-align:middle }
.miad-table tr:last-child td { border-bottom:none }
.miad-table tr:hover td { background:#fafafa }
.miad-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.7rem; font-weight:700 }
.badge-earn  { background:#d1fae5; color:#065f46 }
.badge-spend { background:#fee2e2; color:#991b1b }
.badge-pct   { background:#fef3c7; color:#92400e }
.badge-fixed { background:#dbeafe; color:#1e40af }
.miad-btn    { display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;font-size:.8rem;font-weight:700;cursor:pointer;border:none;text-decoration:none }
.miad-btn-gold   { background:#F5A623;color:#fff }
.miad-btn-gold:hover { background:#E09010;color:#fff }
.miad-btn-red    { background:#ef4444;color:#fff }
.miad-btn-red:hover { background:#dc2626;color:#fff }
.miad-btn-gray   { background:#f3f4f6;color:#374151 }
.miad-btn-gray:hover { background:#e5e7eb }
.miad-section-title { font-size:1.05rem;font-weight:800;margin:24px 0 12px;display:flex;align-items:center;gap:8px }
.miad-form { background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:20px }
.miad-form label { display:block;font-size:.8rem;font-weight:600;margin-bottom:4px;color:#374151 }
.miad-form input, .miad-form select, .miad-form textarea {
    width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:.85rem;
    box-sizing:border-box;margin-bottom:12px
}
.miad-form input:focus, .miad-form select:focus { outline:2px solid #F5A623;border-color:#F5A623 }
.miad-coin-icon { display:inline-flex;width:32px;height:32px;border-radius:50%;
    background:radial-gradient(circle at 35% 30%,#FFE566,#F5A623,#8B5E00);
    border:2px solid #DAA520;align-items:center;justify-content:center;
    font-weight:900;font-size:.6rem;color:#5C3800;font-family:Georgia,serif }
.miad-notice { padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:.85rem }
.miad-notice-ok  { background:#d1fae5;color:#065f46;border:1px solid #6ee7b7 }
.miad-notice-err { background:#fee2e2;color:#991b1b;border:1px solid #fca5a5 }
</style>
<?php }

/* ═══════════════════════════════════════════════════════════════════
   PAGE 1 — VUE D'ENSEMBLE
═══════════════════════════════════════════════════════════════════ */

function miad_coins_page_overview(): void {
    miad_admin_style();

    // Total coins en circulation
    global $wpdb;
    $total_coins = (int) $wpdb->get_var(
        "SELECT SUM(meta_value+0) FROM {$wpdb->usermeta} WHERE meta_key='_miad_coins_balance'"
    );
    $total_users_with_coins = (int) $wpdb->get_var(
        "SELECT COUNT(*) FROM {$wpdb->usermeta} WHERE meta_key='_miad_coins_balance' AND meta_value+0 > 0"
    );

    $stats = function_exists('miad_get_stats') ? miad_get_stats() : [];
    $usd_value = round( $total_coins * MIAD_COINS_VALUE_USD, 2 );
    $fcfa_value = number_format( $total_coins * MIAD_COINS_VALUE_USD * MIAD_USD_TO_FCFA, 0, ',', ' ' );

    // Top 5 users
    $top_users = get_users([
        'meta_key'   => '_miad_coins_balance',
        'orderby'    => 'meta_value_num',
        'order'      => 'DESC',
        'number'     => 5,
    ]);
    ?>
    <div class="wrap miad-wrap">
        <h1 style="display:flex;align-items:center;gap:10px">
            <span class="miad-coin-icon">M</span>
            MIAD Coins — Vue d'ensemble
        </h1>

        <div class="miad-grid">
            <div class="miad-card miad-card-gold">
                <div class="val"><?= number_format($total_coins) ?></div>
                <div class="lbl">Coins en circulation</div>
                <div class="sub"><?= $usd_value ?> USD · <?= $fcfa_value ?> FCFA</div>
            </div>
            <div class="miad-card">
                <div class="val"><?= number_format($total_users_with_coins) ?></div>
                <div class="lbl">Utilisateurs avec coins</div>
            </div>
            <?php if ($stats): ?>
            <div class="miad-card">
                <div class="val"><?= number_format($stats['visits_today']) ?></div>
                <div class="lbl">Visites aujourd'hui</div>
                <div class="sub"><?= number_format($stats['visits_30d']) ?> sur 30j</div>
            </div>
            <div class="miad-card">
                <div class="val"><?= $stats['conversion_rate'] ?></div>
                <div class="lbl">Taux de conversion</div>
                <div class="sub"><?= $stats['orders_30d'] ?> commandes / 30j</div>
            </div>
            <?php endif; ?>
            <div class="miad-card">
                <div class="val"><?= number_format(MIAD_COINS_PER_ORDER) ?></div>
                <div class="lbl">Coins / commande</div>
            </div>
            <div class="miad-card">
                <div class="val"><?= number_format(MIAD_COINS_DAILY) ?></div>
                <div class="lbl">Coins / connexion</div>
            </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:8px">
            <!-- Règles en vigueur -->
            <div class="miad-card">
                <div class="miad-section-title">⚙️ Règles actives</div>
                <table class="miad-table">
                    <tr><th>Action</th><th>Coins</th></tr>
                    <tr><td>Commande complétée</td><td><strong>+<?= MIAD_COINS_PER_ORDER ?></strong></td></tr>
                    <tr><td>Connexion quotidienne</td><td><strong>+<?= MIAD_COINS_DAILY ?></strong></td></tr>
                    <tr><td>Partager un produit</td><td><strong>+<?= MIAD_COINS_PER_SHARE ?></strong></td></tr>
                    <tr><td>Avis approuvé</td><td><strong>+<?= MIAD_COINS_PER_REVIEW ?></strong></td></tr>
                    <tr><td>Parrainage</td><td><strong>+<?= MIAD_COINS_REFERRAL ?></strong></td></tr>
                    <tr><td colspan="2" style="font-size:.75rem;color:#9ca3af">
                        1 coin = <?= MIAD_COINS_VALUE_USD ?> USD = <?= MIAD_COINS_VALUE_USD * MIAD_USD_TO_FCFA ?> FCFA
                    </td></tr>
                </table>
            </div>

            <!-- Top 5 -->
            <div class="miad-card">
                <div class="miad-section-title">🏆 Top 5 utilisateurs</div>
                <table class="miad-table">
                    <tr><th>#</th><th>Utilisateur</th><th>Coins</th><th>FCFA</th></tr>
                    <?php foreach ( $top_users as $i => $u ):
                        $bal  = miad_get_coins( $u->ID );
                        $fcfa = number_format( $bal * MIAD_COINS_VALUE_USD * MIAD_USD_TO_FCFA, 0 );
                    ?>
                    <tr>
                        <td><?= $i+1 ?></td>
                        <td><a href="<?= get_edit_user_link($u->ID) ?>"><?= esc_html($u->display_name) ?></a></td>
                        <td><strong style="color:#F5A623"><?= number_format($bal) ?></strong></td>
                        <td style="color:#6b7280"><?= $fcfa ?></td>
                    </tr>
                    <?php endforeach; ?>
                </table>
            </div>
        </div>

        <div style="margin-top:20px;display:flex;gap:10px">
            <a href="<?= admin_url('admin.php?page=miad-coins-users') ?>" class="miad-btn miad-btn-gold">👥 Gérer les utilisateurs</a>
            <a href="<?= admin_url('admin.php?page=miad-coins-coupons') ?>" class="miad-btn miad-btn-gray">🎟️ Gérer les coupons</a>
            <a href="<?= admin_url('admin.php?page=miad-coins-transactions') ?>" class="miad-btn miad-btn-gray">📋 Transactions</a>
        </div>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   PAGE 2 — UTILISATEURS & COINS
═══════════════════════════════════════════════════════════════════ */

function miad_coins_page_users(): void {
    miad_admin_style();
    $notice = '';

    // Traitement formulaire ajout/retrait
    if ( isset($_POST['miad_user_action']) && check_admin_referer('miad_user_coins') ) {
        $uid    = (int) $_POST['miad_uid'];
        $amount = (int) $_POST['miad_amount'];
        $reason = sanitize_text_field( $_POST['miad_reason'] );
        $action = sanitize_text_field( $_POST['miad_user_action'] );

        if ( $uid && $amount > 0 ) {
            if ( $action === 'add' ) {
                miad_add_coins( $uid, $amount, $reason ?: 'Ajout manuel (admin)' );
                $notice = "<div class='miad-notice miad-notice-ok'>✅ +{$amount} coins ajoutés à l'utilisateur #{$uid}.</div>";
            } elseif ( $action === 'remove' ) {
                $result = miad_spend_coins( $uid, $amount, $reason ?: 'Retrait manuel (admin)' );
                $notice = $result !== false
                    ? "<div class='miad-notice miad-notice-ok'>✅ -{$amount} coins retirés à l'utilisateur #{$uid}.</div>"
                    : "<div class='miad-notice miad-notice-err'>❌ Solde insuffisant.</div>";
            }
        }
    }

    // Recherche utilisateur
    $search = sanitize_text_field( $_GET['s'] ?? '' );
    $users  = get_users([
        'meta_key'   => '_miad_coins_balance',
        'orderby'    => 'meta_value_num',
        'order'      => 'DESC',
        'number'     => 30,
        'search'     => $search ? '*' . $search . '*' : '',
    ]);
    ?>
    <div class="wrap miad-wrap">
        <h1>👥 Gestion des coins — Utilisateurs</h1>
        <?= $notice ?>

        <!-- Formulaire ajout/retrait -->
        <div class="miad-form">
            <div class="miad-section-title">➕ Ajouter / Retirer des coins</div>
            <form method="post">
                <?php wp_nonce_field('miad_user_coins'); ?>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:12px;align-items:end">
                    <div>
                        <label>ID ou Email utilisateur</label>
                        <input type="text" name="miad_uid" placeholder="ID WordPress" required>
                    </div>
                    <div>
                        <label>Montant (coins)</label>
                        <input type="number" name="miad_amount" min="1" placeholder="500" required>
                    </div>
                    <div>
                        <label>Raison</label>
                        <input type="text" name="miad_reason" placeholder="Bonus manuel">
                    </div>
                    <div>
                        <label>Action</label>
                        <select name="miad_user_action">
                            <option value="add">Ajouter</option>
                            <option value="remove">Retirer</option>
                        </select>
                    </div>
                    <div>
                        <button type="submit" class="miad-btn miad-btn-gold" style="height:36px">Valider</button>
                    </div>
                </div>
            </form>
        </div>

        <!-- Recherche -->
        <form method="get" style="margin-bottom:12px;display:flex;gap:8px">
            <input type="hidden" name="page" value="miad-coins-users">
            <input type="search" name="s" value="<?= esc_attr($search) ?>" placeholder="Rechercher un utilisateur…"
                style="padding:7px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:.85rem;width:260px">
            <button type="submit" class="miad-btn miad-btn-gray">Chercher</button>
        </form>

        <!-- Tableau utilisateurs -->
        <table class="miad-table">
            <thead>
                <tr>
                    <th>ID</th><th>Utilisateur</th><th>Email</th>
                    <th>Coins</th><th>USD</th><th>FCFA</th><th>Actions</th>
                </tr>
            </thead>
            <tbody>
            <?php foreach ( $users as $u ):
                $bal  = miad_get_coins( $u->ID );
                $usd  = round( $bal * MIAD_COINS_VALUE_USD, 4 );
                $fcfa = number_format( $bal * MIAD_COINS_VALUE_USD * MIAD_USD_TO_FCFA, 0 );
                $badge = $bal >= 500000 ? '💎' : ($bal >= 200000 ? '🥇' : ($bal >= 50000 ? '🥈' : ($bal >= 10000 ? '🥉' : '')));
            ?>
            <tr>
                <td style="color:#9ca3af"><?= $u->ID ?></td>
                <td>
                    <a href="<?= get_edit_user_link($u->ID) ?>"><?= esc_html($u->display_name) ?></a>
                    <?= $badge ?>
                </td>
                <td style="color:#6b7280"><?= esc_html($u->user_email) ?></td>
                <td><strong style="color:<?= $bal > 0 ? '#F5A623' : '#9ca3af' ?>"><?= number_format($bal) ?></strong></td>
                <td style="color:#6b7280"><?= $usd ?></td>
                <td style="color:#6b7280"><?= $fcfa ?></td>
                <td>
                    <a href="<?= admin_url('admin.php?page=miad-coins-users&uid='.$u->ID) ?>"
                        class="miad-btn miad-btn-gray" style="font-size:.7rem;padding:4px 8px">Voir</a>
                </td>
            </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   PAGE 3 — TRANSACTIONS RÉCENTES
═══════════════════════════════════════════════════════════════════ */

function miad_coins_page_tx(): void {
    miad_admin_style();

    // Récupère les 200 dernières transactions toutes personnes confondues
    global $wpdb;
    $rows = $wpdb->get_results(
        "SELECT user_id, meta_value FROM {$wpdb->usermeta}
         WHERE meta_key='_miad_coins_history'
         ORDER BY umeta_id DESC LIMIT 100"
    );

    $all_tx = [];
    foreach ( $rows as $row ) {
        $history = maybe_unserialize( $row->meta_value );
        if ( ! is_array($history) ) continue;
        foreach ( $history as $tx ) {
            $tx['user_id'] = $row->user_id;
            $all_tx[] = $tx;
        }
    }
    usort( $all_tx, fn($a,$b) => strcmp($b['date'], $a['date']) );
    $all_tx = array_slice( $all_tx, 0, 100 );
    ?>
    <div class="wrap miad-wrap">
        <h1>📋 Transactions récentes</h1>
        <table class="miad-table" style="margin-top:16px">
            <thead>
                <tr>
                    <th>Date</th><th>Utilisateur</th><th>Type</th>
                    <th>Montant</th><th>Raison</th>
                </tr>
            </thead>
            <tbody>
            <?php foreach ($all_tx as $tx):
                $user = get_userdata( $tx['user_id'] ?? 0 );
                $uname = $user ? $user->display_name : 'Invité';
                $is_earn = ($tx['type'] ?? '') === 'earn';
            ?>
            <tr>
                <td style="color:#9ca3af;white-space:nowrap">
                    <?= isset($tx['date']) ? date('d/m/Y H:i', strtotime($tx['date'])) : '—' ?>
                </td>
                <td><?= esc_html($uname) ?></td>
                <td>
                    <span class="miad-badge <?= $is_earn ? 'badge-earn' : 'badge-spend' ?>">
                        <?= $is_earn ? 'Gain' : 'Dépense' ?>
                    </span>
                </td>
                <td>
                    <strong style="color:<?= $is_earn ? '#059669' : '#dc2626' ?>">
                        <?= $is_earn ? '+' : '-' ?><?= number_format((int)($tx['amount']??0)) ?>
                    </strong>
                </td>
                <td style="color:#6b7280"><?= esc_html($tx['reason'] ?? '') ?></td>
            </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   PAGE 4 — COUPONS
═══════════════════════════════════════════════════════════════════ */

function miad_coins_page_coupons(): void {
    miad_admin_style();
    $notice = '';
    $option_key = 'miad_custom_coupons';

    // Coupon par défaut si vide
    $default_coupons = [
        ['code'=>'MIAD10',    'type'=>'percent','value'=>10,   'min'=>30,    'currency'=>'USD',  'expiry'=>'2026-12-31','active'=>1],
        ['code'=>'MIAD5',     'type'=>'fixed',  'value'=>5,    'min'=>20,    'currency'=>'USD',  'expiry'=>'2026-12-31','active'=>1],
        ['code'=>'AFRICA20',  'type'=>'percent','value'=>20,   'min'=>80,    'currency'=>'USD',  'expiry'=>'2026-12-31','active'=>1],
        ['code'=>'BIENVENUE', 'type'=>'percent','value'=>15,   'min'=>0,     'currency'=>'USD',  'expiry'=>'2026-12-31','active'=>1],
        ['code'=>'MIAD3000',  'type'=>'fixed',  'value'=>3000, 'min'=>10000, 'currency'=>'FCFA', 'expiry'=>'2026-12-31','active'=>1],
    ];

    $coupons = get_option($option_key, $default_coupons);
    if (!$coupons) { $coupons = $default_coupons; }

    // Création d'un nouveau coupon
    if ( isset($_POST['miad_create_coupon']) && check_admin_referer('miad_coupons') ) {
        $new = [
            'code'     => strtoupper(sanitize_text_field($_POST['coupon_code'])),
            'type'     => sanitize_key($_POST['coupon_type']),
            'value'    => (float)$_POST['coupon_value'],
            'min'      => (float)$_POST['coupon_min'],
            'currency' => sanitize_text_field($_POST['coupon_currency']),
            'expiry'   => sanitize_text_field($_POST['coupon_expiry']),
            'active'   => 1,
        ];
        if ($new['code'] && $new['value'] > 0) {
            $coupons[] = $new;
            update_option($option_key, $coupons);
            $notice = "<div class='miad-notice miad-notice-ok'>✅ Coupon <strong>{$new['code']}</strong> créé.</div>";
        }
    }

    // Désactiver un coupon
    if ( isset($_GET['deactivate']) && check_admin_referer('deactivate_coupon') ) {
        $idx = (int)$_GET['deactivate'];
        if (isset($coupons[$idx])) { $coupons[$idx]['active'] = 0; update_option($option_key, $coupons); }
        $notice = "<div class='miad-notice miad-notice-ok'>✅ Coupon désactivé.</div>";
    }

    // Supprimer un coupon
    if ( isset($_GET['delete_coupon']) && check_admin_referer('delete_coupon') ) {
        $idx = (int)$_GET['delete_coupon'];
        if (isset($coupons[$idx])) { array_splice($coupons, $idx, 1); update_option($option_key, $coupons); }
        $notice = "<div class='miad-notice miad-notice-ok'>✅ Coupon supprimé.</div>";
    }
    ?>
    <div class="wrap miad-wrap">
        <h1>🎟️ Gestion des Coupons de réduction</h1>
        <?= $notice ?>

        <!-- Formulaire nouveau coupon -->
        <div class="miad-form">
            <div class="miad-section-title">➕ Créer un nouveau coupon</div>
            <form method="post">
                <?php wp_nonce_field('miad_coupons'); ?>
                <div style="display:grid;grid-template-columns:repeat(6,1fr) auto;gap:12px;align-items:end">
                    <div>
                        <label>Code</label>
                        <input type="text" name="coupon_code" placeholder="PROMO20" required style="text-transform:uppercase">
                    </div>
                    <div>
                        <label>Type</label>
                        <select name="coupon_type">
                            <option value="percent">% Réduction</option>
                            <option value="fixed">Montant fixe</option>
                        </select>
                    </div>
                    <div>
                        <label>Valeur</label>
                        <input type="number" name="coupon_value" step="0.01" min="0.01" placeholder="10" required>
                    </div>
                    <div>
                        <label>Achat minimum</label>
                        <input type="number" name="coupon_min" step="0.01" min="0" placeholder="0">
                    </div>
                    <div>
                        <label>Devise</label>
                        <select name="coupon_currency">
                            <option value="USD">USD ($)</option>
                            <option value="FCFA">FCFA</option>
                        </select>
                    </div>
                    <div>
                        <label>Expire le</label>
                        <input type="date" name="coupon_expiry" value="2026-12-31">
                    </div>
                    <div>
                        <button type="submit" name="miad_create_coupon" class="miad-btn miad-btn-gold" style="height:36px">
                            Créer
                        </button>
                    </div>
                </div>
            </form>
        </div>

        <!-- Liste des coupons -->
        <table class="miad-table">
            <thead>
                <tr>
                    <th>Code</th><th>Type</th><th>Valeur</th><th>Minimum</th>
                    <th>Devise</th><th>Expiry</th><th>Statut</th><th>Actions</th>
                </tr>
            </thead>
            <tbody>
            <?php foreach ($coupons as $i => $c):
                $expired = !empty($c['expiry']) && strtotime($c['expiry']) < time();
                $active  = !empty($c['active']) && !$expired;
            ?>
            <tr style="opacity:<?= $active ? 1 : .5 ?>">
                <td><strong style="font-family:monospace;color:#1a1a1a"><?= esc_html($c['code']) ?></strong></td>
                <td>
                    <span class="miad-badge <?= $c['type']==='percent' ? 'badge-pct' : 'badge-fixed' ?>">
                        <?= $c['type']==='percent' ? 'Pourcentage' : 'Montant fixe' ?>
                    </span>
                </td>
                <td><strong><?= $c['type']==='percent' ? $c['value'].'%' : $c['value'].' '.$c['currency'] ?></strong></td>
                <td><?= $c['min'] > 0 ? 'Dès '.$c['min'].' '.$c['currency'] : 'Aucun' ?></td>
                <td><?= esc_html($c['currency']) ?></td>
                <td><?= !empty($c['expiry']) ? date('d/m/Y', strtotime($c['expiry'])) : '∞' ?></td>
                <td>
                    <?php if ($expired): ?>
                        <span class="miad-badge badge-spend">Expiré</span>
                    <?php elseif ($active): ?>
                        <span class="miad-badge badge-earn">Actif</span>
                    <?php else: ?>
                        <span class="miad-badge" style="background:#f3f4f6;color:#6b7280">Désactivé</span>
                    <?php endif; ?>
                </td>
                <td style="display:flex;gap:6px">
                    <?php if ($active): ?>
                    <a href="<?= wp_nonce_url(admin_url('admin.php?page=miad-coins-coupons&deactivate='.$i), 'deactivate_coupon') ?>"
                        class="miad-btn miad-btn-gray" style="font-size:.7rem;padding:4px 8px"
                        onclick="return confirm('Désactiver ce coupon ?')">Désactiver</a>
                    <?php endif; ?>
                    <a href="<?= wp_nonce_url(admin_url('admin.php?page=miad-coins-coupons&delete_coupon='.$i), 'delete_coupon') ?>"
                        class="miad-btn miad-btn-red" style="font-size:.7rem;padding:4px 8px"
                        onclick="return confirm('Supprimer définitivement ?')">Supprimer</a>
                </td>
            </tr>
            <?php endforeach; ?>
            </tbody>
        </table>

        <p style="margin-top:12px;font-size:.78rem;color:#9ca3af">
            💡 Ces coupons sont synchronisés avec le front Next.js via l'endpoint
            <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">/wp-json/miad/v1/coupons</code>
        </p>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   REST — Exposer les coupons actifs au front Next.js
═══════════════════════════════════════════════════════════════════ */

add_action('rest_api_init', function () {
    register_rest_route('miad/v1', '/coupons', [
        'methods'             => 'GET',
        'callback'            => function () {
            $coupons = get_option('miad_custom_coupons', []);
            $active  = array_filter($coupons, fn($c) =>
                !empty($c['active']) && ( empty($c['expiry']) || strtotime($c['expiry']) >= time() )
            );
            return rest_ensure_response(array_values($active));
        },
        'permission_callback' => '__return_true',
    ]);

    // POST — valider un code au checkout
    register_rest_route('miad/v1', '/coupons/validate', [
        'methods'             => 'POST',
        'callback'            => function (WP_REST_Request $req) {
            $code     = strtoupper(sanitize_text_field($req->get_param('code') ?? ''));
            $subtotal = (float)($req->get_param('subtotal') ?? 0);
            $coupons  = get_option('miad_custom_coupons', []);

            foreach ($coupons as $c) {
                if ( strtoupper($c['code']) !== $code ) continue;
                if ( empty($c['active']) ) return new WP_Error('invalid','Code désactivé',['status'=>400]);
                if ( !empty($c['expiry']) && strtotime($c['expiry']) < time() )
                    return new WP_Error('expired','Code expiré',['status'=>400]);

                $min = (float)($c['min'] ?? 0);
                $fcfa_subtotal = $subtotal * MIAD_USD_TO_FCFA;
                if ( $c['currency'] === 'FCFA' && $fcfa_subtotal < $min )
                    return new WP_Error('min','Montant minimum non atteint',['status'=>400]);
                if ( $c['currency'] !== 'FCFA' && $subtotal < $min )
                    return new WP_Error('min','Montant minimum non atteint',['status'=>400]);

                $discount = $c['type'] === 'percent'
                    ? ($subtotal * $c['value'] / 100)
                    : ($c['currency'] === 'FCFA' ? ($c['value'] / MIAD_USD_TO_FCFA) : $c['value']);

                return rest_ensure_response(['valid'=>true,'discount'=>round($discount,2),'coupon'=>$c]);
            }
            return new WP_Error('not_found','Code invalide',['status'=>404]);
        },
        'permission_callback' => '__return_true',
    ]);
});
