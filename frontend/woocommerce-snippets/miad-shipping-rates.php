<?php
/**
 * Plugin Name: MIAD Shipping Rates Admin
 * Description: Méthode de livraison WooCommerce native + panneau admin MIAD.
 *              Configure frais locaux, zone Afrique et zones internationales.
 *              Visible dans WooCommerce → Réglages → Livraison.
 *              Expose un endpoint REST pour le frontend Next.js.
 * Version: 2.0
 * Author: MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/* ═══════════════════════════════════════════════════════════════════
   0. SUPPRESSION DES EMAILS AUTOMATIQUES WooCommerce
   Le frontend headless gère lui-même les confirmations.
   On désactive les emails envoyés lors de la création de commande
   pour éviter les doublons (commande créée avant paiement confirmé).
═══════════════════════════════════════════════════════════════════ */

add_filter( 'woocommerce_email_enabled_new_order',              '__return_false' );
add_filter( 'woocommerce_email_enabled_customer_on_hold_order', '__return_false' );
// customer_processing_order et customer_new_account restent actifs (paiement confirmé + création compte)

/* ═══════════════════════════════════════════════════════════════════
   1. VALEURS PAR DÉFAUT
═══════════════════════════════════════════════════════════════════ */

function miad_shipping_defaults(): array {
    return [
        'local'          => 3,    // même pays
        'zone_africa'    => 6,    // même zone Afrique, pays différent
        'AF_standard'    => 12,
        'AF_express'     => 30,
        'EU_standard'    => 25,
        'EU_express'     => 45,
        'NA_standard'    => 25,
        'NA_express'     => 50,
        'SA_standard'    => 25,
        'SA_express'     => 55,
        'AS_standard'    => 25,
        'AS_express'     => 55,
        'OC_standard'    => 30,
        'OC_express'     => 60,
    ];
}

function miad_get_shipping_rates(): array {
    $saved    = get_option( 'miad_shipping_rates', [] );
    $defaults = miad_shipping_defaults();
    foreach ( $defaults as $k => $v ) {
        if ( ! isset( $saved[ $k ] ) ) $saved[ $k ] = $v;
    }
    return $saved;
}

/* ═══════════════════════════════════════════════════════════════════
   1b. TAUX DE CHANGE (base USD)
═══════════════════════════════════════════════════════════════════ */

function miad_currency_defaults(): array {
    return [
        'EUR' => 0.92,
        'FCFA'=> 600,
        'CAD' => 1.36,
        'GBP' => 0.79,
        'MAD' => 10.0,
        'GHS' => 12.5,
        'GNF' => 8600,
    ];
}

function miad_get_currency_rates(): array {
    $saved    = get_option( 'miad_currency_rates', [] );
    $defaults = miad_currency_defaults();
    foreach ( $defaults as $k => $v ) {
        if ( ! isset( $saved[ $k ] ) ) $saved[ $k ] = $v;
    }
    return $saved;
}

/* ═══════════════════════════════════════════════════════════════════
   2. MENU ADMIN
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_menu_page(
        'Tarifs Livraison MIAD',
        '🚚 Tarifs Livraison',
        'manage_options',
        'miad-shipping-rates',
        'miad_shipping_rates_page',
        'dashicons-airplane',
        56
    );
} );

function miad_shipping_rates_page(): void {
    if ( isset( $_POST['miad_save_rates'] ) && check_admin_referer( 'miad_shipping_rates' ) ) {
        // Livraison
        $rates = [];
        foreach ( array_keys( miad_shipping_defaults() ) as $k ) {
            $rates[ $k ] = isset( $_POST[ $k ] ) ? max( 0, floatval( $_POST[ $k ] ) ) : miad_shipping_defaults()[ $k ];
        }
        update_option( 'miad_shipping_rates', $rates );

        // Taux de change
        $fx = [];
        foreach ( array_keys( miad_currency_defaults() ) as $k ) {
            $val = isset( $_POST[ 'fx_' . $k ] ) ? floatval( $_POST[ 'fx_' . $k ] ) : miad_currency_defaults()[ $k ];
            $fx[ $k ] = max( 0.0001, $val );
        }
        update_option( 'miad_currency_rates', $fx );

        echo '<div class="notice notice-success"><p>✅ Tarifs et taux de change enregistrés.</p></div>';
    }

    $rates = miad_get_shipping_rates();

    // ── Détection des anciens flat-rates qui pourraient doubler la livraison ──
    $conflict_methods = [];
    if ( function_exists( 'WC' ) ) {
        $wc_zones = WC_Shipping_Zones::get_zones();
        $wc_zones[] = [ 'zone_id' => 0, 'shipping_methods' => WC_Shipping_Zones::get_zone( 0 )->get_shipping_methods() ];
        foreach ( $wc_zones as $zone_data ) {
            $methods = is_array( $zone_data['shipping_methods'] ) ? $zone_data['shipping_methods'] : [];
            foreach ( $methods as $method ) {
                if ( $method->id === 'flat_rate' && $method->is_enabled() ) {
                    $conflict_methods[] = [
                        'zone'  => $zone_data['zone_name'] ?? 'Zone par défaut',
                        'title' => $method->get_title(),
                        'cost'  => $method->get_option('cost', '?'),
                        'edit'  => admin_url( 'admin.php?page=wc-settings&tab=shipping&zone_id=' . ( $zone_data['zone_id'] ?? 0 ) ),
                    ];
                }
            }
        }
    }

    $zones = [
        'AF' => 'Afrique',
        'EU' => 'Europe',
        'NA' => 'Amérique du Nord',
        'SA' => 'Amérique du Sud',
        'AS' => 'Asie',
        'OC' => 'Océanie',
    ];
    ?>
    <div class="wrap" style="max-width:780px">
        <h1>🚚 Tarifs de Livraison MIAD</h1>
        <p style="color:#6b7280;margin-bottom:20px">
            Ces tarifs s'appliquent automatiquement selon le pays du produit et le pays de livraison du client.
        </p>

        <?php if ( ! empty( $conflict_methods ) ): ?>
        <div style="background:#fef2f2;border:2px solid #fca5a5;border-radius:10px;padding:20px;margin-bottom:24px">
            <h3 style="color:#b91c1c;margin:0 0 10px">⚠️ Conflit détecté — Anciens flat rates actifs</h3>
            <p style="color:#7f1d1d;font-size:13px;margin-bottom:12px">
                Les méthodes ci-dessous sont encore actives dans WooCommerce et peuvent écraser votre tarif intelligent (3$ local / 6$ zone Afrique).
                <strong>Désactivez-les pour que seule la méthode MIAD Livraison Intelligente soit utilisée.</strong>
            </p>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                    <tr style="background:#fee2e2">
                        <th style="padding:8px 10px;text-align:left">Zone WooCommerce</th>
                        <th style="padding:8px 10px;text-align:left">Méthode</th>
                        <th style="padding:8px 10px;text-align:left">Coût</th>
                        <th style="padding:8px 10px;text-align:left">Action</th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ( $conflict_methods as $m ): ?>
                    <tr style="border-top:1px solid #fca5a5">
                        <td style="padding:8px 10px"><?= esc_html( $m['zone'] ) ?></td>
                        <td style="padding:8px 10px;font-weight:700"><?= esc_html( $m['title'] ) ?></td>
                        <td style="padding:8px 10px;color:#b91c1c;font-weight:900"><?= esc_html( $m['cost'] ) ?> $</td>
                        <td style="padding:8px 10px">
                            <a href="<?= esc_url( $m['edit'] ) ?>" class="button button-secondary" style="font-size:12px">
                                ✏️ Modifier / Désactiver
                            </a>
                        </td>
                    </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>
        </div>
        <?php endif; ?>

        <form method="post">
            <?php wp_nonce_field( 'miad_shipping_rates' ); ?>

            <!-- Tarifs spéciaux -->
            <div style="background:#fff;border:2px solid #005826;border-radius:10px;padding:24px;margin-bottom:20px">
                <h2 style="color:#005826;margin-top:0">Tarifs préférentiels Afrique</h2>
                <table class="form-table">
                    <tr>
                        <th style="width:260px">
                            🏠 Livraison locale
                            <p class="description">Même pays vendeur & client</p>
                        </th>
                        <td>
                            <div style="display:flex;align-items:center;gap:8px">
                                <input type="number" name="local" value="<?= esc_attr( $rates['local'] ) ?>"
                                    min="0" step="0.5" style="width:100px;font-size:18px;font-weight:900;color:#005826">
                                <span style="font-weight:700;color:#6b7280">$</span>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <th>
                            🌍 Zone Afrique
                            <p class="description">Pays africains différents</p>
                        </th>
                        <td>
                            <div style="display:flex;align-items:center;gap:8px">
                                <input type="number" name="zone_africa" value="<?= esc_attr( $rates['zone_africa'] ) ?>"
                                    min="0" step="0.5" style="width:100px;font-size:18px;font-weight:900;color:#005826">
                                <span style="font-weight:700;color:#6b7280">$</span>
                            </div>
                        </td>
                    </tr>
                </table>
            </div>

            <!-- Tarifs par zone internationale -->
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;margin-bottom:20px">
                <h2 style="margin-top:0">Tarifs internationaux par zone</h2>
                <table class="wp-list-table widefat fixed striped" style="margin-top:12px">
                    <thead>
                        <tr>
                            <th>Zone</th>
                            <th>Standard ($)</th>
                            <th>Express / DHL ($)</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ( $zones as $code => $label ): ?>
                        <tr>
                            <td>
                                <strong><?= esc_html( $label ) ?></strong>
                                <span style="font-family:monospace;font-size:11px;color:#9ca3af;margin-left:6px"><?= $code ?></span>
                            </td>
                            <td>
                                <input type="number" name="<?= $code ?>_standard"
                                    value="<?= esc_attr( $rates[ $code . '_standard' ] ?? 0 ) ?>"
                                    min="0" step="0.5" style="width:90px">
                            </td>
                            <td>
                                <input type="number" name="<?= $code ?>_express"
                                    value="<?= esc_attr( $rates[ $code . '_express' ] ?? 0 ) ?>"
                                    min="0" step="0.5" style="width:90px">
                            </td>
                        </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            </div>

            <!-- Aperçu -->
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                <p style="font-size:13px;color:#166534;margin:0">
                    <strong>Endpoint REST :</strong>
                    <code style="background:#dcfce7;padding:2px 8px;border-radius:4px">
                        <?= esc_url( rest_url( 'miad/v1/shipping-rates' ) ) ?>
                    </code>
                    — utilisé par le frontend Next.js pour récupérer ces tarifs en temps réel.
                </p>
            </div>

            <!-- Taux de change -->
            <?php
            $fx      = miad_get_currency_rates();
            $fx_meta = [
                'EUR'  => [ 'label' => 'Euro',            'symbol' => '€',    'note' => '1 USD = x EUR' ],
                'FCFA' => [ 'label' => 'Franc CFA (XOF)', 'symbol' => 'XOF',  'note' => '1 USD = x XOF' ],
                'CAD'  => [ 'label' => 'Dollar canadien', 'symbol' => 'CA$',  'note' => '1 USD = x CAD' ],
                'GBP'  => [ 'label' => 'Livre sterling',  'symbol' => '£',    'note' => '1 USD = x GBP' ],
                'MAD'  => [ 'label' => 'Dirham marocain', 'symbol' => 'MAD',  'note' => '1 USD = x MAD' ],
                'GHS'  => [ 'label' => 'Cedi ghanéen',    'symbol' => 'GH₵',  'note' => '1 USD = x GHS' ],
                'GNF'  => [ 'label' => 'Franc guinéen',   'symbol' => 'GNF',  'note' => '1 USD = x GNF' ],
            ];
            ?>
            <div style="background:#fff;border:2px solid #F5A623;border-radius:10px;padding:24px;margin-bottom:20px">
                <h2 style="color:#92400e;margin-top:0">💱 Taux de change (base USD)</h2>
                <p style="font-size:12px;color:#6b7280;margin-bottom:16px">
                    Ces taux sont utilisés par le frontend Next.js pour afficher les prix dans la devise choisie par le client.
                    Mettez-les à jour en fonction du marché.
                </p>
                <table class="wp-list-table widefat fixed striped">
                    <thead>
                        <tr>
                            <th>Devise</th>
                            <th>Symbole</th>
                            <th>1 USD = ?</th>
                            <th style="color:#6b7280;font-weight:400">Aperçu (10 $)</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ( $fx_meta as $code => $meta ): ?>
                        <tr>
                            <td><strong><?= esc_html( $meta['label'] ) ?></strong> <span style="font-family:monospace;font-size:11px;color:#9ca3af"><?= $code ?></span></td>
                            <td style="font-size:18px;font-weight:900"><?= esc_html( $meta['symbol'] ) ?></td>
                            <td>
                                <div style="display:flex;align-items:center;gap:6px">
                                    <input type="number" name="fx_<?= $code ?>"
                                        value="<?= esc_attr( $fx[ $code ] ?? miad_currency_defaults()[ $code ] ) ?>"
                                        min="0.0001" step="0.0001" style="width:110px">
                                    <span style="color:#6b7280;font-size:12px"><?= esc_html( $meta['symbol'] ) ?></span>
                                </div>
                            </td>
                            <td style="color:#005826;font-weight:700">
                                <?php
                                $preview = 10 * floatval( $fx[ $code ] ?? miad_currency_defaults()[ $code ] );
                                if ( in_array( $code, ['FCFA','GNF'] ) ) {
                                    echo number_format( round( $preview ), 0, ',', ' ' ) . ' ' . esc_html( $code );
                                } else {
                                    echo esc_html( $meta['symbol'] ) . ' ' . number_format( $preview, 2 );
                                }
                                ?>
                            </td>
                        </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            </div>

            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                <p style="font-size:13px;color:#1e40af;margin:0">
                    <strong>💡 WooCommerce natif :</strong>
                    Ces tarifs sont appliqués automatiquement par la méthode de livraison
                    <strong>MIAD Livraison Intelligente</strong> dans
                    <a href="<?= admin_url('admin.php?page=wc-settings&tab=shipping') ?>">WooCommerce → Réglages → Livraison</a>.
                    Activez-la dans une zone de livraison WooCommerce pour qu'elle soit proposée à la caisse.
                </p>
            </div>

            <!-- Aperçu -->
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                <p style="font-size:13px;color:#166534;margin:0">
                    <strong>Endpoint REST :</strong>
                    <code style="background:#dcfce7;padding:2px 8px;border-radius:4px">
                        <?= esc_url( rest_url( 'miad/v1/shipping-rates' ) ) ?>
                    </code>
                    — utilisé par le frontend Next.js pour récupérer ces tarifs en temps réel.
                </p>
            </div>

            <p><input type="submit" name="miad_save_rates" class="button button-primary button-hero" value="💾 Enregistrer les tarifs"></p>
        </form>
    </div>
    <?php
}

/* ═══════════════════════════════════════════════════════════════════
   3. MÉTHODE WOOCOMMERCE NATIVE — "MIAD Livraison Intelligente"
   Visible dans WooCommerce → Réglages → Livraison → Zone → Ajouter méthode
═══════════════════════════════════════════════════════════════════ */

add_action( 'woocommerce_shipping_init', function () {
    if ( class_exists( 'WC_Shipping_Method' ) && ! class_exists( 'MIAD_Shipping_Method' ) ) {

        class MIAD_Shipping_Method extends WC_Shipping_Method {

            // Mapping zones MIAD
            private const COUNTRY_ZONE = [
                'SN'=>'AF','BJ'=>'AF','CI'=>'AF','TG'=>'AF','CM'=>'AF','NG'=>'AF','GA'=>'AF',
                'CG'=>'AF','CD'=>'AF','ML'=>'AF','NE'=>'AF','BF'=>'AF','GN'=>'AF','GW'=>'AF',
                'MR'=>'AF','GM'=>'AF','SL'=>'AF','LR'=>'AF','CV'=>'AF','GH'=>'AF','MA'=>'AF',
                'TN'=>'AF','DZ'=>'AF','LY'=>'AF','EG'=>'AF','KE'=>'AF','TZ'=>'AF','UG'=>'AF',
                'RW'=>'AF','ET'=>'AF','ZA'=>'AF','AO'=>'AF','MZ'=>'AF','ZM'=>'AF','ZW'=>'AF',
                'FR'=>'EU','BE'=>'EU','DE'=>'EU','NL'=>'EU','IT'=>'EU','ES'=>'EU','GB'=>'EU',
                'PT'=>'EU','CH'=>'EU','AT'=>'EU','IE'=>'EU','SE'=>'EU','NO'=>'EU','DK'=>'EU',
                'PL'=>'EU','RO'=>'EU','CZ'=>'EU','TR'=>'EU','RU'=>'EU',
                'CA'=>'NA','US'=>'NA','MX'=>'NA',
                'BR'=>'SA','AR'=>'SA','CO'=>'SA','CL'=>'SA','PE'=>'SA',
                'CN'=>'AS','JP'=>'AS','IN'=>'AS','KR'=>'AS','AE'=>'AS','SA'=>'AS','SG'=>'AS',
                'AU'=>'OC','NZ'=>'OC',
            ];

            public function __construct( $instance_id = 0 ) {
                $this->id                 = 'miad_smart_shipping';
                $this->instance_id        = absint( $instance_id );
                $this->method_title       = 'MIAD Livraison Intelligente';
                $this->method_description = 'Calcule automatiquement les frais selon le pays du vendeur et le pays de livraison (local 3$, zone Afrique 6$, tarifs zones internationaux).';
                $this->supports           = [ 'shipping-zones', 'instance-settings' ];
                $this->title              = $this->get_option( 'title', 'Livraison MIAD' );
                parent::__construct( $instance_id );
            }

            public function init_form_fields(): void {
                $this->instance_form_fields = [
                    'title' => [
                        'title'       => 'Titre affiché',
                        'type'        => 'text',
                        'default'     => 'Livraison MIAD',
                        'description' => 'Nom de la méthode visible par le client.',
                    ],
                    'mode' => [
                        'title'   => 'Mode',
                        'type'    => 'select',
                        'default' => 'standard',
                        'options' => [
                            'standard' => 'Standard',
                            'express'  => 'MIAD Express',
                        ],
                    ],
                ];
            }

            public function calculate_shipping( $package = [] ): void {
                $rates    = miad_get_shipping_rates();
                $dest     = strtoupper( $package['destination']['country'] ?? 'SN' );
                $dest_zone = self::COUNTRY_ZONE[ $dest ] ?? 'AF';
                $mode     = $this->get_option( 'mode', 'standard' );

                $total_cost = 0;

                foreach ( $package['contents'] as $item ) {
                    $product = $item['data'];
                    $qty     = $item['quantity'];

                    // Pays du produit / vendeur
                    $vendor_country = '';
                    $vendor_id = (int) get_post_field( 'post_author', $product->get_id() );
                    if ( $vendor_id && function_exists( 'dokan_get_store_info' ) ) {
                        $info = dokan_get_store_info( $vendor_id );
                        $vendor_country = strtoupper( $info['address']['country'] ?? '' );
                    }
                    if ( ! $vendor_country ) {
                        $vendor_country = strtoupper( get_post_meta( $product->get_id(), '_miad_vendor_country', true ) ?: 'SN' );
                    }

                    $prod_zone = self::COUNTRY_ZONE[ $vendor_country ] ?? 'AF';

                    if ( $vendor_country === $dest ) {
                        // Livraison locale
                        $unit = (float) $rates['local'];
                    } elseif ( $prod_zone === 'AF' && $dest_zone === 'AF' ) {
                        // Zone Afrique
                        $unit = (float) $rates['zone_africa'];
                    } else {
                        $key  = $dest_zone . '_' . $mode;
                        $unit = (float) ( $rates[ $key ] ?? $rates['AF_standard'] );
                    }

                    $total_cost += $unit * $qty;
                }

                $this->add_rate( [
                    'id'    => $this->get_rate_id(),
                    'label' => $this->title,
                    'cost'  => $total_cost,
                ] );
            }
        }
    }
} );

// Enregistrement de la méthode dans WooCommerce
add_filter( 'woocommerce_shipping_methods', function ( array $methods ): array {
    $methods['miad_smart_shipping'] = 'MIAD_Shipping_Method';
    return $methods;
} );

/* ═══════════════════════════════════════════════════════════════════
   4. ENDPOINT REST — GET /wp-json/miad/v1/shipping-rates
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad/v1', '/shipping-rates', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true', // Public — pas de données sensibles
        'callback'            => function (): WP_REST_Response {
            $rates = miad_get_shipping_rates();
            // Structuré pour le frontend
            $fx = miad_get_currency_rates();
            return new WP_REST_Response( [
                'local'       => (float) $rates['local'],
                'zone_africa' => (float) $rates['zone_africa'],
                'zones' => [
                    'AF' => [ 'standard' => (float) $rates['AF_standard'], 'express' => (float) $rates['AF_express'] ],
                    'EU' => [ 'standard' => (float) $rates['EU_standard'], 'express' => (float) $rates['EU_express'] ],
                    'NA' => [ 'standard' => (float) $rates['NA_standard'], 'express' => (float) $rates['NA_express'] ],
                    'SA' => [ 'standard' => (float) $rates['SA_standard'], 'express' => (float) $rates['SA_express'] ],
                    'AS' => [ 'standard' => (float) $rates['AS_standard'], 'express' => (float) $rates['AS_express'] ],
                    'OC' => [ 'standard' => (float) $rates['OC_standard'], 'express' => (float) $rates['OC_express'] ],
                ],
                'currency_rates' => array_map( 'floatval', $fx ),
            ], 200, [
                'Cache-Control' => 'public, max-age=300', // Cache 5 min côté client
            ] );
        },
    ] );
} );
