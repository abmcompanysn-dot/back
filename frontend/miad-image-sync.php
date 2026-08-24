<?php
/**
 * Plugin Name: MIAD Image Sync
 * Description: Synchronise les images des produits WooCommerce (produits + variations) entre leurs traductions (WPML / Polylang). Permet aussi d'ajouter une image directement depuis l'interface.
 * Version: 2.0
 * Author: MIAD Digital
 * Requires at least: 5.8
 * Requires PHP: 7.4
 */

if ( ! defined( 'ABSPATH' ) ) exit;
if ( class_exists( 'Miad_Image_Sync' ) ) return;

final class Miad_Image_Sync {

    private static ?self $instance = null;

    public static function instance(): self {
        if ( self::$instance === null ) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action( 'admin_menu',                  [ $this, 'add_menu' ] );
        add_action( 'admin_enqueue_scripts',       [ $this, 'enqueue' ] );
        add_action( 'wp_ajax_miad_sync_one',       [ $this, 'ajax_sync_one' ] );
        add_action( 'wp_ajax_miad_sync_all',       [ $this, 'ajax_sync_all' ] );
        add_action( 'wp_ajax_miad_sync_variation', [ $this, 'ajax_sync_variation' ] );
        add_action( 'wp_ajax_miad_set_image_url',  [ $this, 'ajax_set_image_url' ] );
    }

    // ── MENU ──────────────────────────────────────────────────────────────────

    public function add_menu(): void {
        add_menu_page(
            'MIAD Image Sync',
            '🖼️ Image Sync',
            'manage_woocommerce',
            'miad-image-sync',
            [ $this, 'page' ],
            '',
            58
        );
    }

    public function enqueue( string $hook ): void {
        if ( $hook !== 'toplevel_page_miad-image-sync' ) return;
        wp_enqueue_media();
        add_action( 'admin_footer', [ $this, 'print_js' ] );
    }

    // ── PAGE PRINCIPALE ───────────────────────────────────────────────────────

    public function page(): void {
        $tab = $_GET['tab'] ?? 'products';

        $products   = $this->get_products_without_image();
        $variations = $this->get_variations_without_image();
        $tp = count( $products );
        $tv = count( $variations );
        ?>
        <div class="wrap">
            <h1 style="display:flex;align-items:center;gap:10px;">
                🖼️ MIAD Image Sync
                <span style="font-size:13px;background:#f0f0f0;padding:4px 12px;border-radius:20px;font-weight:400;">
                    v2.0
                </span>
            </h1>

            <!-- Onglets -->
            <nav class="nav-tab-wrapper" style="margin-bottom:20px;">
                <a href="?page=miad-image-sync&tab=products" class="nav-tab <?= $tab === 'products'   ? 'nav-tab-active' : '' ?>">
                    📦 Produits sans image <span style="background:<?= $tp > 0 ? '#ef4444' : '#86efac' ?>;color:white;border-radius:12px;padding:1px 7px;font-size:11px;margin-left:4px;"><?= $tp ?></span>
                </a>
                <a href="?page=miad-image-sync&tab=variations" class="nav-tab <?= $tab === 'variations' ? 'nav-tab-active' : '' ?>">
                    🔀 Variations sans image <span style="background:<?= $tv > 0 ? '#f97316' : '#86efac' ?>;color:white;border-radius:12px;padding:1px 7px;font-size:11px;margin-left:4px;"><?= $tv ?></span>
                </a>
            </nav>

            <?php if ( $tab === 'products' ) : ?>
                <?php $this->render_products_tab( $products ); ?>
            <?php else : ?>
                <?php $this->render_variations_tab( $variations ); ?>
            <?php endif; ?>
        </div>
        <?php
    }

    // ── ONGLET PRODUITS ───────────────────────────────────────────────────────

    private function render_products_tab( array $products ): void {
        $total = count( $products );
        ?>
        <p style="color:#555;margin-bottom:16px;">
            Produits publiés sans miniature. Synchronise depuis la traduction ou définit une image via URL.
        </p>

        <?php if ( $total === 0 ) : ?>
            <div style="background:#edfdf0;border:1px solid #86efac;border-radius:12px;padding:24px;text-align:center;">
                <span style="font-size:32px;">✅</span>
                <p style="font-size:16px;font-weight:600;margin:8px 0 0;">Tous les produits ont une image !</p>
            </div>
        <?php else : ?>
            <div style="margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <button id="miad-sync-all" class="button button-primary" style="height:38px;font-weight:600;">
                    ⚡ Tout synchroniser (<?= $total ?> produits)
                </button>
                <span id="miad-sync-status" style="color:#555;font-size:13px;display:none;"></span>
            </div>
            <div id="miad-progress-bar" style="display:none;height:6px;background:#e5e7eb;border-radius:3px;margin-bottom:20px;">
                <div id="miad-progress-fill" style="height:6px;background:#2563eb;border-radius:3px;width:0%;transition:width .3s;"></div>
            </div>

            <table class="widefat fixed striped" style="border-radius:12px;overflow:hidden;">
                <thead>
                    <tr>
                        <th style="width:50px;"></th>
                        <th>Produit</th>
                        <th style="width:90px;">ID</th>
                        <th style="width:80px;">Langue</th>
                        <th>Source trouvée</th>
                        <th style="width:90px;">SKU</th>
                        <th style="width:220px;">Action</th>
                    </tr>
                </thead>
                <tbody id="miad-product-list">
                <?php foreach ( $products as $p ) :
                    $source    = $this->find_image_source( $p['id'] );
                    $has_src   = ! empty( $source['thumbnail_id'] );
                    $edit_link = get_edit_post_link( $p['id'] );
                ?>
                    <tr id="row-<?= esc_attr( $p['id'] ) ?>" style="<?= ! $has_src ? 'opacity:.6' : '' ?>">
                        <td>
                            <?php if ( $has_src && ! empty( $source['thumb_url'] ) ) : ?>
                                <img src="<?= esc_url( $source['thumb_url'] ) ?>" style="width:40px;height:40px;object-fit:cover;border-radius:6px;" />
                            <?php else : ?>
                                <div style="width:40px;height:40px;background:#f3f4f6;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;">📦</div>
                            <?php endif; ?>
                        </td>
                        <td>
                            <strong><?= esc_html( $p['name'] ) ?></strong><br>
                            <a href="<?= esc_url( $edit_link ) ?>" target="_blank" style="font-size:11px;color:#2563eb;">Modifier dans WP →</a>
                        </td>
                        <td><code><?= esc_html( $p['id'] ) ?></code></td>
                        <td>
                            <span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;">
                                <?= esc_html( strtoupper( $p['lang'] ?? '?' ) ) ?>
                            </span>
                        </td>
                        <td>
                            <?php if ( $has_src ) : ?>
                                <span style="color:#16a34a;font-size:12px;">✓ <?= esc_html( $source['lang'] ) ?> (ID <?= esc_html( $source['post_id'] ) ?>)</span>
                            <?php else : ?>
                                <span style="color:#9ca3af;font-size:12px;">Aucune traduction</span>
                            <?php endif; ?>
                        </td>
                        <td><code style="font-size:11px;"><?= esc_html( $p['sku'] ) ?></code></td>
                        <td style="display:flex;gap:6px;flex-wrap:wrap;padding:8px;">
                            <?php if ( $has_src ) : ?>
                                <button class="button miad-sync-btn"
                                    data-product="<?= esc_attr( $p['id'] ) ?>"
                                    data-source="<?= esc_attr( $source['post_id'] ) ?>"
                                    style="font-weight:600;font-size:11px;"
                                >Sync traduction</button>
                            <?php endif; ?>
                            <button class="button miad-url-btn"
                                data-product="<?= esc_attr( $p['id'] ) ?>"
                                data-type="product"
                                style="font-size:11px;"
                            >+ URL image</button>
                            <button class="button miad-media-btn"
                                data-product="<?= esc_attr( $p['id'] ) ?>"
                                data-type="product"
                                style="font-size:11px;"
                            >+ Médiathèque</button>
                        </td>
                    </tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>
        <?php
    }

    // ── ONGLET VARIATIONS ─────────────────────────────────────────────────────

    private function render_variations_tab( array $variations ): void {
        $total = count( $variations );
        ?>
        <p style="color:#555;margin-bottom:16px;">
            Variations de produits sans image propre. Vous pouvez synchroniser depuis la variation sœur ou définir une image via URL.
        </p>

        <?php if ( $total === 0 ) : ?>
            <div style="background:#edfdf0;border:1px solid #86efac;border-radius:12px;padding:24px;text-align:center;">
                <span style="font-size:32px;">✅</span>
                <p style="font-size:16px;font-weight:600;margin:8px 0 0;">Toutes les variations ont une image !</p>
            </div>
        <?php else : ?>
            <table class="widefat fixed striped" style="border-radius:12px;overflow:hidden;">
                <thead>
                    <tr>
                        <th style="width:50px;"></th>
                        <th>Variation</th>
                        <th style="width:90px;">ID variation</th>
                        <th>Produit parent</th>
                        <th style="width:90px;">SKU</th>
                        <th style="width:200px;">Action</th>
                    </tr>
                </thead>
                <tbody>
                <?php foreach ( $variations as $v ) :
                    $parent_link = get_edit_post_link( $v['parent_id'] );
                    $source_var  = $this->find_variation_image_source( $v['id'], $v['parent_id'] );
                    $has_src     = ! empty( $source_var );
                ?>
                    <tr id="varrow-<?= esc_attr( $v['id'] ) ?>">
                        <td>
                            <?php if ( $has_src ) : ?>
                                <img src="<?= esc_url( $source_var['thumb_url'] ) ?>" style="width:40px;height:40px;object-fit:cover;border-radius:6px;" />
                            <?php else : ?>
                                <div style="width:40px;height:40px;background:#f3f4f6;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;">🔀</div>
                            <?php endif; ?>
                        </td>
                        <td>
                            <strong style="font-size:12px;"><?= esc_html( $v['name'] ) ?></strong><br>
                            <span style="font-size:11px;color:#888;"><?= esc_html( implode( ' · ', $v['attributes'] ) ) ?></span>
                        </td>
                        <td><code><?= esc_html( $v['id'] ) ?></code></td>
                        <td>
                            <a href="<?= esc_url( $parent_link ) ?>" target="_blank" style="font-size:12px;color:#2563eb;">
                                <?= esc_html( $v['parent_name'] ) ?> →
                            </a>
                        </td>
                        <td><code style="font-size:11px;"><?= esc_html( $v['sku'] ) ?></code></td>
                        <td style="display:flex;gap:6px;flex-wrap:wrap;padding:8px;">
                            <?php if ( $has_src ) : ?>
                                <button class="button miad-sync-variation-btn"
                                    data-variation="<?= esc_attr( $v['id'] ) ?>"
                                    data-source="<?= esc_attr( $source_var['attachment_id'] ) ?>"
                                    style="font-size:11px;font-weight:600;"
                                >Sync sœur</button>
                            <?php endif; ?>
                            <button class="button miad-url-btn"
                                data-product="<?= esc_attr( $v['id'] ) ?>"
                                data-type="variation"
                                style="font-size:11px;"
                            >+ URL image</button>
                            <button class="button miad-media-btn"
                                data-product="<?= esc_attr( $v['id'] ) ?>"
                                data-type="variation"
                                style="font-size:11px;"
                            >+ Médiathèque</button>
                        </td>
                    </tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>
        <?php
    }

    // ── REQUÊTES SQL ──────────────────────────────────────────────────────────

    private function get_products_without_image(): array {
        global $wpdb;
        $rows = $wpdb->get_results( "
            SELECT p.ID, p.post_title, pm_sku.meta_value AS sku
            FROM {$wpdb->posts} p
            LEFT JOIN {$wpdb->postmeta} pm_thumb ON pm_thumb.post_id = p.ID AND pm_thumb.meta_key = '_thumbnail_id'
            LEFT JOIN {$wpdb->postmeta} pm_sku   ON pm_sku.post_id   = p.ID AND pm_sku.meta_key   = '_sku'
            WHERE p.post_type  = 'product'
              AND p.post_status = 'publish'
              AND (pm_thumb.meta_value IS NULL OR pm_thumb.meta_value = '' OR pm_thumb.meta_value = '0')
            ORDER BY p.post_title
            LIMIT 300
        ", ARRAY_A );

        $out = [];
        foreach ( $rows as $r ) {
            $out[] = [
                'id'   => (int) $r['ID'],
                'name' => $r['post_title'],
                'sku'  => $r['sku'] ?? '',
                'lang' => $this->get_post_lang( (int) $r['ID'] ),
            ];
        }
        return $out;
    }

    private function get_variations_without_image(): array {
        global $wpdb;
        $rows = $wpdb->get_results( "
            SELECT v.ID, v.post_parent, v.post_title, pm_img.meta_value AS image_id, pm_sku.meta_value AS sku,
                   p.post_title AS parent_name
            FROM {$wpdb->posts} v
            JOIN  {$wpdb->posts} p ON p.ID = v.post_parent
            LEFT JOIN {$wpdb->postmeta} pm_img ON pm_img.post_id = v.ID AND pm_img.meta_key = '_thumbnail_id'
            LEFT JOIN {$wpdb->postmeta} pm_sku ON pm_sku.post_id = v.ID AND pm_sku.meta_key = '_sku'
            WHERE v.post_type   = 'product_variation'
              AND v.post_status  = 'publish'
              AND (pm_img.meta_value IS NULL OR pm_img.meta_value = '' OR pm_img.meta_value = '0')
            ORDER BY p.post_title, v.menu_order
            LIMIT 300
        ", ARRAY_A );

        $out = [];
        foreach ( $rows as $r ) {
            $attrs = wc_get_product_variation_attributes( (int) $r['ID'] );
            $labels = [];
            foreach ( $attrs as $key => $val ) {
                $tax = str_replace( 'attribute_', '', $key );
                $term = get_term_by( 'slug', $val, $tax );
                $labels[] = $term ? $term->name : $val;
            }
            $out[] = [
                'id'          => (int) $r['ID'],
                'parent_id'   => (int) $r['post_parent'],
                'parent_name' => $r['parent_name'],
                'name'        => $r['post_title'] ?: ( $r['parent_name'] . ' — variation' ),
                'sku'         => $r['sku'] ?? '',
                'attributes'  => $labels,
            ];
        }
        return $out;
    }

    // ── SOURCE IMAGE (produit) ────────────────────────────────────────────────

    private function find_image_source( int $product_id ): array {
        foreach ( $this->get_translations( $product_id ) as $lang => $trans_id ) {
            if ( $trans_id === $product_id ) continue;
            $thumb_id = (int) get_post_meta( $trans_id, '_thumbnail_id', true );
            if ( $thumb_id > 0 ) {
                return [
                    'post_id'      => $trans_id,
                    'lang'         => $lang,
                    'thumbnail_id' => $thumb_id,
                    'thumb_url'    => wp_get_attachment_image_url( $thumb_id, 'thumbnail' ) ?: '',
                    'gallery'      => get_post_meta( $trans_id, '_product_image_gallery', true ) ?: '',
                ];
            }
        }
        return [];
    }

    // ── SOURCE IMAGE (variation) ──────────────────────────────────────────────

    private function find_variation_image_source( int $variation_id, int $parent_id ): array {
        // Cherche une autre variation du même parent qui a une image
        $siblings = get_posts( [
            'post_type'   => 'product_variation',
            'post_parent' => $parent_id,
            'post_status' => 'publish',
            'numberposts' => 50,
            'exclude'     => [ $variation_id ],
        ] );

        foreach ( $siblings as $s ) {
            $tid = (int) get_post_meta( $s->ID, '_thumbnail_id', true );
            if ( $tid > 0 ) {
                return [
                    'variation_id'  => $s->ID,
                    'attachment_id' => $tid,
                    'thumb_url'     => wp_get_attachment_image_url( $tid, 'thumbnail' ) ?: '',
                ];
            }
        }

        // Sinon, prend l'image du produit parent
        $parent_thumb = (int) get_post_meta( $parent_id, '_thumbnail_id', true );
        if ( $parent_thumb > 0 ) {
            return [
                'variation_id'  => $parent_id,
                'attachment_id' => $parent_thumb,
                'thumb_url'     => wp_get_attachment_image_url( $parent_thumb, 'thumbnail' ) ?: '',
            ];
        }

        return [];
    }

    // ── POLYLANG / WPML ───────────────────────────────────────────────────────

    private function get_post_lang( int $post_id ): string {
        if ( function_exists( 'pll_get_post_language' ) ) return pll_get_post_language( $post_id ) ?: '?';
        if ( defined( 'ICL_LANGUAGE_CODE' ) ) {
            global $sitepress;
            if ( isset( $sitepress ) ) {
                $info = $sitepress->get_element_language_details( $post_id, 'post_product' );
                return $info->language_code ?? '?';
            }
        }
        return '?';
    }

    private function get_translations( int $post_id ): array {
        if ( function_exists( 'pll_get_post_translations' ) ) {
            $tr = pll_get_post_translations( $post_id );
            return is_array( $tr ) ? $tr : [];
        }
        if ( function_exists( 'icl_object_id' ) ) {
            global $sitepress;
            if ( ! isset( $sitepress ) ) return [];
            $out = [];
            foreach ( $sitepress->get_active_languages() as $code => $_ ) {
                $tr_id = (int) icl_object_id( $post_id, 'product', false, $code );
                if ( $tr_id > 0 ) $out[ $code ] = $tr_id;
            }
            return $out;
        }
        return [];
    }

    // ── AJAX : SYNC PRODUIT (traduction) ──────────────────────────────────────

    public function ajax_sync_one(): void {
        check_ajax_referer( 'miad_image_sync', 'nonce' );
        if ( ! current_user_can( 'manage_woocommerce' ) ) wp_send_json_error( 'Unauthorized', 403 );

        $product_id = (int) ( $_POST['product_id'] ?? 0 );
        $source_id  = (int) ( $_POST['source_id']  ?? 0 );
        if ( ! $product_id || ! $source_id ) wp_send_json_error( 'IDs manquants' );

        $r = $this->copy_product_images( $source_id, $product_id );
        if ( is_wp_error( $r ) ) wp_send_json_error( $r->get_error_message() );
        wp_send_json_success( [ 'product_id' => $product_id ] );
    }

    // ── AJAX : SYNC TOUS ──────────────────────────────────────────────────────

    public function ajax_sync_all(): void {
        check_ajax_referer( 'miad_image_sync', 'nonce' );
        if ( ! current_user_can( 'manage_woocommerce' ) ) wp_send_json_error( 'Unauthorized', 403 );

        $synced = 0; $skipped = 0;
        foreach ( $this->get_products_without_image() as $p ) {
            $src = $this->find_image_source( $p['id'] );
            if ( empty( $src['thumbnail_id'] ) ) { $skipped++; continue; }
            if ( ! is_wp_error( $this->copy_product_images( $src['post_id'], $p['id'] ) ) ) $synced++;
        }
        wp_send_json_success( [ 'synced' => $synced, 'skipped' => $skipped ] );
    }

    // ── AJAX : SYNC VARIATION ─────────────────────────────────────────────────

    public function ajax_sync_variation(): void {
        check_ajax_referer( 'miad_image_sync', 'nonce' );
        if ( ! current_user_can( 'manage_woocommerce' ) ) wp_send_json_error( 'Unauthorized', 403 );

        $variation_id = (int) ( $_POST['variation_id'] ?? 0 );
        $source_att   = (int) ( $_POST['source_att']   ?? 0 );
        if ( ! $variation_id || ! $source_att ) wp_send_json_error( 'IDs manquants' );

        update_post_meta( $variation_id, '_thumbnail_id', $source_att );
        wc_delete_product_transients( $variation_id );
        $thumb_url = wp_get_attachment_image_url( $source_att, 'thumbnail' ) ?: '';
        wp_send_json_success( [ 'variation_id' => $variation_id, 'thumb_url' => $thumb_url ] );
    }

    // ── AJAX : DÉFINIR IMAGE PAR URL ──────────────────────────────────────────

    public function ajax_set_image_url(): void {
        check_ajax_referer( 'miad_image_sync', 'nonce' );
        if ( ! current_user_can( 'manage_woocommerce' ) ) wp_send_json_error( 'Unauthorized', 403 );

        $post_id  = (int)    ( $_POST['post_id']  ?? 0 );
        $type     = sanitize_text_field( $_POST['type'] ?? 'product' );
        $media_id = (int)    ( $_POST['media_id'] ?? 0 );
        $img_url  = esc_url_raw( $_POST['img_url'] ?? '' );

        if ( ! $post_id ) wp_send_json_error( 'post_id manquant' );

        $attachment_id = 0;

        if ( $media_id > 0 ) {
            // Depuis la médiathèque
            $attachment_id = $media_id;
        } elseif ( $img_url ) {
            // Importer depuis une URL externe
            require_once ABSPATH . 'wp-admin/includes/media.php';
            require_once ABSPATH . 'wp-admin/includes/file.php';
            require_once ABSPATH . 'wp-admin/includes/image.php';

            $tmp   = download_url( $img_url );
            if ( is_wp_error( $tmp ) ) wp_send_json_error( $tmp->get_error_message() );

            $file_array = [
                'name'     => basename( parse_url( $img_url, PHP_URL_PATH ) ) ?: 'image.jpg',
                'tmp_name' => $tmp,
            ];
            $id = media_handle_sideload( $file_array, $post_id );
            if ( is_wp_error( $id ) ) { @unlink( $tmp ); wp_send_json_error( $id->get_error_message() ); }
            $attachment_id = $id;
        } else {
            wp_send_json_error( 'Fournissez media_id ou img_url' );
        }

        update_post_meta( $post_id, '_thumbnail_id', $attachment_id );
        wc_delete_product_transients( $post_id );
        $thumb_url = wp_get_attachment_image_url( $attachment_id, 'thumbnail' ) ?: '';
        wp_send_json_success( [ 'post_id' => $post_id, 'attachment_id' => $attachment_id, 'thumb_url' => $thumb_url ] );
    }

    // ── COPIE IMAGES PRODUIT ──────────────────────────────────────────────────

    private function copy_product_images( int $from_id, int $to_id ) {
        $thumb_id = (int) get_post_meta( $from_id, '_thumbnail_id', true );
        if ( $thumb_id <= 0 ) return new \WP_Error( 'no_thumb', 'Pas de miniature source' );
        update_post_meta( $to_id, '_thumbnail_id', $thumb_id );
        $gallery = get_post_meta( $from_id, '_product_image_gallery', true );
        if ( ! empty( $gallery ) ) update_post_meta( $to_id, '_product_image_gallery', $gallery );
        wc_delete_product_transients( $to_id );
        return true;
    }

    // ── JAVASCRIPT ────────────────────────────────────────────────────────────

    public function print_js(): void {
        $nonce = wp_create_nonce( 'miad_image_sync' );
        ?>
        <style>
            tr.miad-synced td { background: #f0fdf4 !important; }
            tr.miad-synced .miad-sync-btn,
            tr.miad-synced .miad-sync-variation-btn { display:none; }
            .miad-ok { color:#16a34a;font-weight:600;font-size:12px; }
            #miad-url-modal { display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;align-items:center;justify-content:center; }
            #miad-url-modal.open { display:flex; }
            #miad-url-box { background:#fff;border-radius:16px;padding:28px;width:440px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,.25); }
        </style>

        <!-- Modal saisie URL -->
        <div id="miad-url-modal">
            <div id="miad-url-box">
                <h3 style="margin:0 0 16px;font-size:16px;">Définir une image par URL</h3>
                <input id="miad-img-url-input" type="url" class="regular-text" placeholder="https://example.com/image.jpg" style="width:100%;margin-bottom:12px;" />
                <p style="font-size:12px;color:#888;margin:0 0 16px;">L'image sera téléchargée et ajoutée à la médiathèque WordPress.</p>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button id="miad-url-cancel" class="button">Annuler</button>
                    <button id="miad-url-confirm" class="button button-primary">Enregistrer</button>
                </div>
            </div>
        </div>

        <script>
        (function($) {
            const nonce = <?= json_encode( $nonce ) ?>;
            let _pendingPostId = 0, _pendingType = '';

            // ── Sync produit (traduction) ─────────────────────────────────
            $(document).on('click', '.miad-sync-btn', function() {
                const btn = $(this), pid = btn.data('product'), src = btn.data('source');
                btn.prop('disabled', true).text('En cours…');
                $.post(ajaxurl, { action:'miad_sync_one', nonce, product_id:pid, source_id:src }, function(res) {
                    if ( res.success ) {
                        $('#row-' + pid).addClass('miad-synced');
                        btn.replaceWith('<span class="miad-ok">✅ Synchronisé</span>');
                    } else { btn.prop('disabled',false).text('Réessayer'); alert(res.data||'Erreur'); }
                });
            });

            // ── Sync tout ─────────────────────────────────────────────────
            $('#miad-sync-all').on('click', function() {
                if ( ! confirm('Synchroniser tous les produits manquants ?') ) return;
                const btn = $(this);
                btn.prop('disabled',true).text('Synchronisation…');
                $('#miad-sync-status').show().text('En cours…');
                $('#miad-progress-bar').show();
                $('#miad-progress-fill').css('width','10%');
                $.post(ajaxurl, { action:'miad_sync_all', nonce }, function(res) {
                    $('#miad-progress-fill').css('width','100%');
                    if ( res.success ) {
                        const d = res.data;
                        $('#miad-sync-status').html('<strong style="color:#16a34a">✅ '+d.synced+' synchronisé(s)</strong>'+(d.skipped?' · '+d.skipped+' ignoré(s)':''));
                        $('.miad-sync-btn').each(function(){
                            const r = $('#row-' + $(this).data('product'));
                            r.addClass('miad-synced');
                            $(this).replaceWith('<span class="miad-ok">✅</span>');
                        });
                        btn.text('✅ Terminé');
                    } else { alert(res.data||'Erreur'); btn.prop('disabled',false).text('Réessayer'); }
                });
            });

            // ── Sync variation ────────────────────────────────────────────
            $(document).on('click', '.miad-sync-variation-btn', function() {
                const btn = $(this), vid = btn.data('variation'), src = btn.data('source');
                btn.prop('disabled',true).text('En cours…');
                $.post(ajaxurl, { action:'miad_sync_variation', nonce, variation_id:vid, source_att:src }, function(res) {
                    if ( res.success ) {
                        const row = $('#varrow-' + vid);
                        row.addClass('miad-synced');
                        if ( res.data.thumb_url ) row.find('td:first').html('<img src="'+res.data.thumb_url+'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;">');
                        btn.replaceWith('<span class="miad-ok">✅ Synchronisé</span>');
                    } else { btn.prop('disabled',false).text('Réessayer'); alert(res.data||'Erreur'); }
                });
            });

            // ── Modal URL ─────────────────────────────────────────────────
            $(document).on('click', '.miad-url-btn', function() {
                _pendingPostId = $(this).data('product');
                _pendingType   = $(this).data('type');
                $('#miad-img-url-input').val('');
                $('#miad-url-modal').addClass('open');
            });
            $('#miad-url-cancel').on('click', () => $('#miad-url-modal').removeClass('open'));
            $('#miad-url-confirm').on('click', function() {
                const url = $('#miad-img-url-input').val().trim();
                if ( ! url ) return;
                $(this).prop('disabled',true).text('Téléchargement…');
                $.post(ajaxurl, { action:'miad_set_image_url', nonce, post_id:_pendingPostId, type:_pendingType, img_url:url }, function(res) {
                    $('#miad-url-confirm').prop('disabled',false).text('Enregistrer');
                    $('#miad-url-modal').removeClass('open');
                    if ( res.success ) {
                        const rowSel = _pendingType === 'variation' ? '#varrow-' : '#row-';
                        const row = $(rowSel + _pendingPostId);
                        row.addClass('miad-synced');
                        if ( res.data.thumb_url ) row.find('td:first').html('<img src="'+res.data.thumb_url+'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;">');
                    } else { alert(res.data||'Erreur'); }
                });
            });

            // ── Médiathèque WP ────────────────────────────────────────────
            $(document).on('click', '.miad-media-btn', function() {
                const postId = $(this).data('product');
                const type   = $(this).data('type');
                const frame  = wp.media({ title:'Choisir une image', multiple:false, library:{ type:'image' }, button:{ text:'Utiliser cette image' } });
                frame.on('select', function() {
                    const att = frame.state().get('selection').first().toJSON();
                    $.post(ajaxurl, { action:'miad_set_image_url', nonce, post_id:postId, type, media_id:att.id }, function(res) {
                        if ( res.success ) {
                            const rowSel = type === 'variation' ? '#varrow-' : '#row-';
                            const row = $(rowSel + postId);
                            row.addClass('miad-synced');
                            const img = att.sizes?.thumbnail?.url || att.url;
                            if ( img ) row.find('td:first').html('<img src="'+img+'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;">');
                        } else { alert(res.data||'Erreur'); }
                    });
                });
                frame.open();
            });

        })(jQuery);
        </script>
        <?php
    }
}

Miad_Image_Sync::instance();
