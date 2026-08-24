<?php
/**
 * Plugin Name: MIAD R2 Images
 * Description: Redirige automatiquement les URLs d'images vers Cloudflare R2. Corrige les images WooCommerce, filtre les produits sans image dans l'API. Inclut un outil de resynchronisation des miniatures manquantes.
 * Version: 1.5
 * Author: MIAD Digital
 * Requires at least: 5.8
 * Requires PHP: 7.4
 *
 * POUR ACTIVER LA RESYNCHRONISATION DES MINIATURES, AJOUTER DANS wp-config.php
 * (avant la ligne "That's all, stop editing!") :
 *
 *   define( 'MIAD_R2_ACCOUNT_ID',        'TON_ACCOUNT_ID' );
 *   define( 'MIAD_R2_ACCESS_KEY_ID',     'TA_CLE_ACCES' );
 *   define( 'MIAD_R2_SECRET_ACCESS_KEY', 'TON_SECRET' );
 *   define( 'MIAD_R2_BUCKET',            'NOM_DU_BUCKET' );
 *
 * Ces 4 valeurs viennent de Cloudflare Dashboard > R2 > Manage API Tokens >
 * Create API Token (permission "Object Read & Write" sur le bucket concerné).
 */

if ( ! defined( 'ABSPATH' ) ) exit;

if ( class_exists( 'Miad_R2_Images' ) ) return; // sécurité si chargé 2x

final class Miad_R2_Images {

    const OPTION = 'miad_r2_settings';

    /** @var array Cache des file_exists() sur la même requête */
    private array $file_cache = [];

    /** @var self|null */
    private static ?self $instance = null;

    public static function instance(): self {
        if ( self::$instance === null ) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        // Filtres attachements WordPress
        add_filter( 'wp_get_attachment_url',       [ $this, 'rewrite_url' ], 20 );
        add_filter( 'wp_get_attachment_image_src',  [ $this, 'rewrite_image_src' ], 20 );
        add_filter( 'wp_calculate_image_srcset',    [ $this, 'fix_srcset' ], 20 );
        add_filter( 'the_content',                  [ $this, 'fix_content_urls' ], 20 );

        // Filtres WooCommerce REST API (ne s'activent que si WooCommerce est actif)
        add_filter( 'woocommerce_rest_prepare_product_object',          [ $this, 'fix_product_response' ], 20, 3 );
        add_filter( 'woocommerce_rest_prepare_product_variation_object',[ $this, 'fix_variation_response' ], 20, 3 );
        add_filter( 'woocommerce_rest_product_object_query',            [ $this, 'filter_no_image_query' ], 20, 2 );

        // Admin
        add_action( 'admin_menu',  [ $this, 'add_menu' ] );
        add_action( 'admin_init',  [ $this, 'register_settings' ] );

        // Resync miniatures (AJAX)
        add_action( 'wp_ajax_miad_r2_resync_scan',  [ $this, 'ajax_resync_scan' ] );
        add_action( 'wp_ajax_miad_r2_resync_batch', [ $this, 'ajax_resync_batch' ] );
    }

    // ─── PARAMÈTRES ────────────────────────────────────────────────────────────

    public function cfg(): array {
        $cfg = wp_parse_args( get_option( self::OPTION, [] ), [
            'r2_base_url'       => 'https://cdn.miadmarket.com',
            'legacy_r2_bases'   => "https://pub-5830f37957e94da4a6855da37b632a3a.r2.dev",
            'wp_uploads_prefix' => '/wp-content/uploads/',
            'hide_no_image'     => '1',
            'force_r2'          => '0',
            'enabled'           => '1',
        ] );

        // Une constante définie dans wp-config.php a toujours priorité sur le
        // réglage en base — pratique pour fixer la valeur au niveau serveur
        // sans dépendre de la base de données, mais ça veut dire que tant que
        // cette constante existe, le champ "URL de base R2" de la page de
        // réglages est ignoré silencieusement.
        if ( defined( 'MIAD_R2_BASE_URL' ) ) {
            $cfg['r2_base_url'] = MIAD_R2_BASE_URL;
        }

        return $cfg;
    }

    /** @return string[] Liste des anciens domaines R2 (un par ligne dans le réglage) */
    private function legacy_r2_bases(): array {
        $raw = $this->cfg()['legacy_r2_bases'] ?? '';
        return array_filter( array_map( 'trim', explode( "\n", $raw ) ) );
    }

    private function r2_write_configured(): bool {
        return defined( 'MIAD_R2_ACCOUNT_ID' ) && defined( 'MIAD_R2_ACCESS_KEY_ID' )
            && defined( 'MIAD_R2_SECRET_ACCESS_KEY' ) && defined( 'MIAD_R2_BUCKET' );
    }

    // ─── RÉÉCRITURE URL ────────────────────────────────────────────────────────

    public function rewrite_url( string $url ): string {
        $cfg = $this->cfg();
        if ( $cfg['enabled'] !== '1' || empty( $cfg['r2_base_url'] ) ) return $url;

        $r2 = untrailingslashit( $cfg['r2_base_url'] );

        // Déjà sur le bon domaine R2 → ne pas réécrire
        if ( str_starts_with( $url, $r2 ) ) return $url;

        // URL pointant vers un ancien domaine R2 (migration précédente) → migrer
        // vers le domaine actuellement configuré. Les URLs d'images sont souvent
        // stockées en dur dans la base (guid, _wp_attached_file) plutôt que
        // reconstruites à chaque requête : sans ceci, changer "URL de base R2"
        // n'a aucun effet sur les images déjà migrées vers un ancien bucket.
        foreach ( $this->legacy_r2_bases() as $legacy ) {
            $legacy = untrailingslashit( $legacy );
            if ( $legacy !== $r2 && str_starts_with( $url, $legacy ) ) {
                $relative = ltrim( substr( $url, strlen( $legacy ) ), '/' );
                return $this->resolve_r2_url( $r2, $relative );
            }
        }

        $local_base = untrailingslashit( site_url() ) . $cfg['wp_uploads_prefix'];
        if ( ! str_starts_with( $url, $local_base ) ) return $url;

        $relative = ltrim( substr( $url, strlen( $local_base ) ), '/' );

        // Mode adaptatif : si le fichier existe encore localement → garder l'URL WP
        if ( $cfg['force_r2'] !== '1' ) {
            if ( ! isset( $this->file_cache[ $relative ] ) ) {
                $basedir = trailingslashit( wp_upload_dir()['basedir'] );
                $this->file_cache[ $relative ] = file_exists( $basedir . $relative );
            }
            if ( $this->file_cache[ $relative ] ) return $url;
        }

        return $this->resolve_r2_url( $r2, $relative );
    }

    /**
     * Construit l'URL R2 finale en vérifiant que le fichier existe réellement dans
     * le bucket. La synchronisation vers R2 ne copie souvent que l'image originale,
     * pas les dérivées de taille générées par WordPress (ex: -100x100.avif) — sans
     * cette vérification, ces dérivées pointent vers des fichiers 404 (images
     * cassées dans les emails, l'admin, etc.). On ne vérifie que les chemins avec
     * un suffixe de taille ; les originaux sont supposés fiables.
     */
    private function resolve_r2_url( string $r2, string $relative ): string {
        $r2_url = $r2 . '/' . $relative;

        if ( ! preg_match( '/-\d+x\d+(?=\.[a-zA-Z0-9]+$)/', $relative ) ) {
            return $r2_url; // pas une dérivée de taille — pas de vérification nécessaire
        }

        $exists = $this->r2_object_exists( $r2, $relative );
        if ( $exists ) return $r2_url;

        // Dérivée absente sur R2 → on retombe sur l'image originale (sans suffixe de taille)
        $original_relative = preg_replace( '/-\d+x\d+(?=\.[a-zA-Z0-9]+$)/', '', $relative );
        return $r2 . '/' . $original_relative;
    }

    /**
     * Vérifie (avec cache transient) qu'un chemin relatif existe sur R2, via le
     * point d'accès public en lecture (pas besoin des clés d'écriture pour ça).
     */
    private function r2_object_exists( string $r2, string $relative ): bool {
        $cache_key = 'miad_r2_exists_' . md5( $relative );
        $cached    = get_transient( $cache_key );
        if ( $cached !== false ) return $cached === '1';

        $response = wp_remote_head( $r2 . '/' . $relative, [ 'timeout' => 2 ] );
        $exists   = ! is_wp_error( $response ) && wp_remote_retrieve_response_code( $response ) === 200;
        // Cache 1h si absent (laisse le temps à une éventuelle synchro de rattraper),
        // 7 jours si présent (ne devrait plus changer).
        set_transient( $cache_key, $exists ? '1' : '0', $exists ? 7 * DAY_IN_SECONDS : HOUR_IN_SECONDS );
        return $exists;
    }

    public function rewrite_image_src( $src ) {
        if ( ! is_array( $src ) || empty( $src[0] ) ) return $src;
        $src[0] = $this->rewrite_url( $src[0] );
        return $src;
    }

    public function fix_srcset( $sources ) {
        if ( ! is_array( $sources ) ) return $sources;
        foreach ( $sources as &$source ) {
            if ( ! empty( $source['url'] ) ) {
                $source['url'] = $this->rewrite_url( $source['url'] );
            }
        }
        return $sources;
    }

    public function fix_content_urls( string $content ): string {
        $cfg = $this->cfg();
        if ( $cfg['enabled'] !== '1' || empty( $cfg['r2_base_url'] ) ) return $content;
        $local = untrailingslashit( site_url() ) . $cfg['wp_uploads_prefix'];
        $r2    = untrailingslashit( $cfg['r2_base_url'] ) . '/';
        return str_replace( $local, $r2, $content );
    }

    // ─── WOO REST : PRODUITS ───────────────────────────────────────────────────

    public function fix_product_response( $response, $object, $request ) {
        $data = $response->get_data();
        if ( ! empty( $data['images'] ) ) {
            foreach ( $data['images'] as &$img ) {
                if ( ! empty( $img['src'] ) ) {
                    $img['src'] = $this->rewrite_url( $img['src'] );
                }
            }
            $response->set_data( $data );
        }
        return $response;
    }

    // ─── WOO REST : VARIATIONS ────────────────────────────────────────────────

    public function fix_variation_response( $response, $object, $request ) {
        $data = $response->get_data();
        if ( ! empty( $data['image']['src'] ) ) {
            $data['image']['src'] = $this->rewrite_url( $data['image']['src'] );
            $response->set_data( $data );
        }
        return $response;
    }

    // ─── WOO REST : FILTRE SANS IMAGE ─────────────────────────────────────────

    public function filter_no_image_query( array $args, $request ): array {
        if ( $this->cfg()['hide_no_image'] !== '1' ) return $args;

        $extra = [
            [ 'key' => '_thumbnail_id', 'compare' => 'EXISTS' ],
            [ 'key' => '_thumbnail_id', 'value'   => '0', 'compare' => '!=' ],
        ];

        if ( empty( $args['meta_query'] ) ) {
            $args['meta_query'] = array_merge( [ 'relation' => 'AND' ], $extra );
        } else {
            $args['meta_query'] = [
                'relation' => 'AND',
                $args['meta_query'],
                [ 'relation' => 'AND', ...$extra ],
            ];
        }

        return $args;
    }

    // ─── ADMIN ────────────────────────────────────────────────────────────────

    public function add_menu(): void {
        add_submenu_page(
            'upload.php',
            'MIAD R2 Images',
            'MIAD R2 Images',
            'manage_options',
            'miad-r2',
            [ $this, 'settings_page' ]
        );
    }

    public function register_settings(): void {
        register_setting( self::OPTION, self::OPTION, [ 'sanitize_callback' => [ $this, 'sanitize' ] ] );
    }

    public function sanitize( $input ): array {
        $legacy_lines = array_filter( array_map( 'trim', explode( "\n", $input['legacy_r2_bases'] ?? '' ) ) );
        $legacy_lines = array_map( 'esc_url_raw', $legacy_lines );

        // Champ désactivé (et donc absent du POST) quand MIAD_R2_BASE_URL est définie
        // dans wp-config.php — on garde la valeur déjà enregistrée plutôt que de
        // l'écraser avec une chaîne vide.
        $r2_base_url = isset( $input['r2_base_url'] )
            ? esc_url_raw( trim( $input['r2_base_url'] ) )
            : ( $this->cfg()['r2_base_url'] ?? '' );

        return [
            'r2_base_url'       => $r2_base_url,
            'legacy_r2_bases'   => implode( "\n", $legacy_lines ),
            'wp_uploads_prefix' => sanitize_text_field( $input['wp_uploads_prefix'] ?? '/wp-content/uploads/' ),
            'hide_no_image'     => isset( $input['hide_no_image'] ) ? '1' : '0',
            'force_r2'          => isset( $input['force_r2'] )      ? '1' : '0',
            'enabled'           => isset( $input['enabled'] )        ? '1' : '0',
        ];
    }

    public function settings_page(): void {
        $cfg  = $this->cfg();
        $site = untrailingslashit( site_url() );
        $opt  = self::OPTION;

        $test_local = $site . $cfg['wp_uploads_prefix'] . '2024/01/exemple.jpg';
        $test_r2    = $this->rewrite_url( $test_local );
        $mode       = $cfg['force_r2'] === '1' ? 'R2 forcé' : 'Adaptatif (fallback local)';
        ?>
        <div class="wrap">
            <h1>⚙️ MIAD R2 Images</h1>
            <p style="color:#555">Redirige les images WP vers Cloudflare R2. Filtre les produits sans image dans l'API WooCommerce.</p>

            <?php if ( isset( $_GET['settings-updated'] ) ) : ?>
                <div class="notice notice-success is-dismissible"><p>✅ Paramètres enregistrés.</p></div>
            <?php endif; ?>

            <?php if ( defined( 'MIAD_R2_BASE_URL' ) ) : ?>
                <div class="notice notice-warning"><p>
                    ⚠️ La constante <code>MIAD_R2_BASE_URL</code> est définie dans <code>wp-config.php</code>
                    (valeur actuelle : <code><?= esc_html( MIAD_R2_BASE_URL ) ?></code>) et <strong>écrase le champ
                    "URL de base R2" ci-dessous</strong> — le modifier ici n'aura aucun effet tant que cette
                    constante existe. Retire-la de <code>wp-config.php</code> si tu veux piloter l'URL depuis
                    cette page.
                </p></div>
            <?php endif; ?>

            <form method="post" action="options.php">
                <?php settings_fields( $opt ); ?>
                <table class="form-table" role="presentation">

                    <tr>
                        <th><label for="r2_enabled">Activer</label></th>
                        <td>
                            <input type="checkbox" id="r2_enabled" name="<?= esc_attr( $opt ) ?>[enabled]" value="1" <?= checked( '1', $cfg['enabled'], false ) ?> />
                            <p class="description">Décocher pour désactiver sans perdre la configuration.</p>
                        </td>
                    </tr>

                    <tr>
                        <th><label for="r2_base_url">URL de base R2</label></th>
                        <td>
                            <input type="url" id="r2_base_url" name="<?= esc_attr( $opt ) ?>[r2_base_url]"
                                   value="<?= esc_attr( $cfg['r2_base_url'] ) ?>" class="regular-text"
                                   placeholder="https://pub-xxx.r2.dev" <?= defined( 'MIAD_R2_BASE_URL' ) ? 'disabled' : '' ?> />
                            <p class="description">URL publique du bucket R2 (sans slash final).</p>
                        </td>
                    </tr>

                    <tr>
                        <th><label for="r2_legacy">Anciens domaines R2</label></th>
                        <td>
                            <textarea id="r2_legacy" name="<?= esc_attr( $opt ) ?>[legacy_r2_bases]" rows="3" class="large-text"
                                      placeholder="https://pub-ancien-bucket.r2.dev"><?= esc_textarea( $cfg['legacy_r2_bases'] ) ?></textarea>
                            <p class="description">
                                Un domaine par ligne. Les URLs déjà stockées en base (anciennes migrations) pointant
                                vers l'un de ces domaines seront automatiquement réécrites vers l'URL de base R2 actuelle.
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <th><label for="r2_prefix">Préfixe uploads WP</label></th>
                        <td>
                            <input type="text" id="r2_prefix" name="<?= esc_attr( $opt ) ?>[wp_uploads_prefix]"
                                   value="<?= esc_attr( $cfg['wp_uploads_prefix'] ) ?>" class="regular-text" />
                            <p class="description">Généralement <code>/wp-content/uploads/</code></p>
                        </td>
                    </tr>

                    <tr>
                        <th><label for="r2_force">Mode R2 forcé</label></th>
                        <td>
                            <input type="checkbox" id="r2_force" name="<?= esc_attr( $opt ) ?>[force_r2]" value="1" <?= checked( '1', $cfg['force_r2'], false ) ?> />
                            <p class="description">
                                <strong>Décoché</strong> — Mode adaptatif : si l'image existe encore sur le serveur WP, elle s'affiche depuis WP. Sinon depuis R2.<br>
                                <strong>Coché</strong> — Toujours R2, même si le fichier est présent localement (CDN pur).
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <th><label for="r2_hide">Masquer produits sans image</label></th>
                        <td>
                            <input type="checkbox" id="r2_hide" name="<?= esc_attr( $opt ) ?>[hide_no_image]" value="1" <?= checked( '1', $cfg['hide_no_image'], false ) ?> />
                            <p class="description">Exclut les produits sans miniature des réponses API WooCommerce.</p>
                        </td>
                    </tr>

                </table>
                <?php submit_button( 'Enregistrer' ); ?>
            </form>

            <hr>
            <h2>🔍 Test en live</h2>
            <table class="form-table">
                <tr><th>Mode</th><td><strong><?= esc_html( $mode ) ?></strong></td></tr>
                <tr><th>URL locale</th><td><code><?= esc_html( $test_local ) ?></code></td></tr>
                <tr>
                    <th>URL résultante</th>
                    <td>
                        <code><?= esc_html( $test_r2 ) ?></code>
                        <?php if ( $test_r2 === $test_local ) : ?>
                            <span style="color:darkorange;font-weight:bold"> ⚠️ Fichier local présent → URL WP conservée</span>
                        <?php elseif ( str_starts_with( $test_r2, $cfg['r2_base_url'] ) ) : ?>
                            <span style="color:green;font-weight:bold"> ✅ Réécriture R2 OK</span>
                        <?php else : ?>
                            <span style="color:red;font-weight:bold"> ❌ Vérifiez la configuration</span>
                        <?php endif; ?>
                    </td>
                </tr>
            </table>

            <hr>
            <h2>☁️ Resynchronisation des miniatures manquantes</h2>
            <p style="color:#555">
                Régénère en JPEG (format universel, compatible Gmail) toute dérivée de taille manquante sur R2,
                puis la téléverse. Ne touche pas aux images originales ni à leur affichage sur le site.
            </p>

            <?php if ( ! $this->r2_write_configured() ) : ?>
                <div class="notice notice-error" style="margin-left:0"><p>
                    ⚠️ Constantes R2 manquantes dans <code>wp-config.php</code> pour l'écriture (MIAD_R2_ACCOUNT_ID,
                    MIAD_R2_ACCESS_KEY_ID, MIAD_R2_SECRET_ACCESS_KEY, MIAD_R2_BUCKET) — voir l'en-tête de ce fichier.
                </p></div>
            <?php else : ?>
                <div id="miad-r2-scan-box" style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-bottom:16px;max-width:700px">
                    <button id="miad-r2-scan-btn" class="button button-primary">🔍 Scanner les produits</button>
                    <span id="miad-r2-scan-status" style="margin-left:10px;color:#555"></span>
                </div>

                <div id="miad-r2-progress-box" style="display:none;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;max-width:700px">
                    <div style="height:8px;background:#e5e7eb;border-radius:4px;margin-bottom:12px">
                        <div id="miad-r2-bar" style="height:8px;background:#005826;border-radius:4px;width:0%;transition:width .3s"></div>
                    </div>
                    <p id="miad-r2-progress-text" style="font-size:13px;color:#555">—</p>
                    <div id="miad-r2-log" style="max-height:300px;overflow:auto;font-family:monospace;font-size:12px;background:#0f172a;color:#94a3b8;border-radius:8px;padding:12px;margin-top:12px"></div>
                </div>

                <script>
                (function($){
                    const nonce = <?= json_encode( wp_create_nonce( 'miad_r2_resync' ) ) ?>;
                    let queue = [], total = 0, done = 0, fixed = 0, failed = 0;

                    function log(msg, color) {
                        const $l = $('#miad-r2-log');
                        $l.append('<div style="color:'+(color||'#94a3b8')+'">'+msg+'</div>');
                        $l.scrollTop($l[0].scrollHeight);
                    }

                    $('#miad-r2-scan-btn').on('click', function() {
                        $(this).prop('disabled', true).text('Scan en cours…');
                        $('#miad-r2-scan-status').text('Recherche des miniatures manquantes…');
                        $.post(ajaxurl, { action: 'miad_r2_resync_scan', nonce }, function(res) {
                            if (!res.success) { alert(res.data || 'Erreur'); $('#miad-r2-scan-btn').prop('disabled', false).text('🔍 Scanner les produits'); return; }
                            queue = res.data.missing;
                            total = queue.length;
                            $('#miad-r2-scan-status').text(total + ' miniature(s) manquante(s) trouvée(s) sur ' + res.data.checked + ' vérifiée(s).');
                            if (total === 0) { $('#miad-r2-scan-btn').prop('disabled', false).text('🔍 Scanner les produits'); return; }
                            $('#miad-r2-progress-box').show();
                            $('#miad-r2-scan-btn').text('Correction en cours…');
                            processNext();
                        });
                    });

                    function processNext() {
                        if (queue.length === 0) {
                            $('#miad-r2-progress-text').html('<strong style="color:#16a34a">✅ Terminé</strong> — ' + fixed + ' corrigée(s), ' + failed + ' échec(s) sur ' + total);
                            $('#miad-r2-scan-btn').prop('disabled', false).text('🔍 Re-scanner');
                            return;
                        }
                        const batch = queue.splice(0, 5);
                        $.post(ajaxurl, { action: 'miad_r2_resync_batch', nonce, attachment_ids: batch }, function(res) {
                            if (res.success) {
                                res.data.results.forEach(r => {
                                    done++;
                                    if (r.ok) { fixed++; log('✅ #' + r.id + ' — ' + r.name, '#4ade80'); }
                                    else { failed++; log('❌ #' + r.id + ' — ' + r.name + ' : ' + r.error, '#f87171'); }
                                });
                            } else {
                                failed += batch.length; done += batch.length;
                                log('❌ Erreur de lot : ' + (res.data || 'inconnue'), '#f87171');
                            }
                            $('#miad-r2-bar').css('width', Math.round(done/total*100) + '%');
                            $('#miad-r2-progress-text').text(done + ' / ' + total + ' traité(s) — ' + fixed + ' corrigée(s), ' + failed + ' échec(s)');
                            processNext();
                        });
                    }
                })(jQuery);
                </script>
            <?php endif; ?>
        </div>
        <?php
    }

    // ─── AJAX : SCAN DES MINIATURES MANQUANTES ────────────────────────────────

    public function ajax_resync_scan(): void {
        check_ajax_referer( 'miad_r2_resync', 'nonce' );
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( 'Unauthorized', 403 );

        global $wpdb;
        $rows = $wpdb->get_results( "
            SELECT pm_thumb.meta_value AS thumb_id
            FROM {$wpdb->posts} p
            INNER JOIN {$wpdb->postmeta} pm_thumb ON pm_thumb.post_id = p.ID AND pm_thumb.meta_key = '_thumbnail_id'
            WHERE p.post_type = 'product' AND p.post_status = 'publish'
              AND pm_thumb.meta_value != '' AND pm_thumb.meta_value != '0'
            LIMIT 500
        ", ARRAY_A );

        $missing = [];
        $checked = 0;
        $cfg     = $this->cfg();
        $r2_base = untrailingslashit( $cfg['r2_base_url'] );

        foreach ( $rows as $row ) {
            $thumb_id = (int) $row['thumb_id'];
            $checked++;

            $url = wp_get_attachment_image_url( $thumb_id, 'thumbnail' );
            if ( ! $url || ! str_starts_with( $url, $r2_base ) ) continue; // pas sur R2, rien à faire

            $relative = ltrim( substr( $url, strlen( $r2_base ) ), '/' );
            if ( ! $this->r2_object_exists( $r2_base, $relative ) ) {
                $missing[] = $thumb_id;
            }
        }

        wp_send_json_success( [ 'missing' => $missing, 'checked' => $checked ] );
    }

    // ─── AJAX : TRAITEMENT D'UN LOT ────────────────────────────────────────────

    public function ajax_resync_batch(): void {
        check_ajax_referer( 'miad_r2_resync', 'nonce' );
        if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( 'Unauthorized', 403 );
        if ( ! $this->r2_write_configured() ) wp_send_json_error( 'R2 non configuré' );

        $ids = array_map( 'intval', (array) ( $_POST['attachment_ids'] ?? [] ) );
        $results = [];

        foreach ( $ids as $attachment_id ) {
            $name = get_the_title( $attachment_id ) ?: ( 'ID ' . $attachment_id );
            $r = $this->fix_one_thumbnail( $attachment_id );
            $results[] = [
                'id'    => $attachment_id,
                'name'  => $name,
                'ok'    => ! is_wp_error( $r ),
                'error' => is_wp_error( $r ) ? $r->get_error_message() : '',
            ];
        }

        wp_send_json_success( [ 'results' => $results ] );
    }

    /**
     * Régénère la dérivée "thumbnail" d'une pièce jointe en JPEG et la téléverse sur R2.
     * Source : fichier local si présent, sinon téléchargement depuis l'URL R2 de l'original.
     */
    private function fix_one_thumbnail( int $attachment_id ) {
        $local_path = get_attached_file( $attachment_id );
        $tmp_source = null;

        if ( ! $local_path || ! file_exists( $local_path ) ) {
            // Télécharger l'original depuis R2 pour pouvoir le redimensionner
            $original_url = wp_get_attachment_url( $attachment_id );
            if ( ! $original_url ) return new WP_Error( 'no_url', 'URL originale introuvable' );

            require_once ABSPATH . 'wp-admin/includes/file.php';
            $tmp_source = download_url( $original_url, 15 );
            if ( is_wp_error( $tmp_source ) ) return $tmp_source;
            $local_path = $tmp_source;
        }

        $editor = wp_get_image_editor( $local_path );
        if ( is_wp_error( $editor ) ) {
            if ( $tmp_source ) @unlink( $tmp_source );
            return new WP_Error( 'decode_failed', 'Format source non décodable par le serveur (AVIF/WebP non supporté ?) : ' . $editor->get_error_message() );
        }

        $w    = (int) get_option( 'thumbnail_size_w', 150 ) ?: 150;
        $h    = (int) get_option( 'thumbnail_size_h', 150 ) ?: 150;
        $crop = (bool) get_option( 'thumbnail_crop', 1 );
        $editor->resize( $w, $h, $crop );

        $tmp_out = wp_tempnam( 'miad-r2-thumb.jpg' );
        $saved   = $editor->save( $tmp_out, 'image/jpeg' );
        if ( $tmp_source ) @unlink( $tmp_source );

        if ( is_wp_error( $saved ) ) {
            @unlink( $tmp_out );
            return $saved;
        }

        $bytes = file_get_contents( $saved['path'] );
        @unlink( $saved['path'] );
        if ( $bytes === false ) return new WP_Error( 'read_failed', 'Impossible de lire le fichier généré' );

        // Construire le chemin relatif R2 (convention WordPress : nom-WxH.ext)
        $attached_relative = get_post_meta( $attachment_id, '_wp_attached_file', true );
        if ( ! $attached_relative ) return new WP_Error( 'no_relative', 'Chemin relatif introuvable' );
        $dir    = trailingslashit( dirname( $attached_relative ) );
        $base   = pathinfo( $attached_relative, PATHINFO_FILENAME );
        $r2_key = ( $dir === './' ? '' : $dir ) . $base . '-' . $saved['width'] . 'x' . $saved['height'] . '.jpg';

        $put = $this->r2_put_object( $r2_key, $bytes, 'image/jpeg' );
        if ( is_wp_error( $put ) ) return $put;

        // Mettre à jour les métadonnées pour que WordPress pointe vers ce nouveau fichier
        $meta = wp_get_attachment_metadata( $attachment_id );
        if ( is_array( $meta ) ) {
            $meta['sizes']['thumbnail'] = [
                'file'      => basename( $r2_key ),
                'width'     => $saved['width'],
                'height'    => $saved['height'],
                'mime-type' => 'image/jpeg',
            ];
            wp_update_attachment_metadata( $attachment_id, $meta );
        }

        // Purger le cache d'existence pour ce chemin
        delete_transient( 'miad_r2_exists_' . md5( $r2_key ) );

        return true;
    }

    // ─── SIGNATURE S3 (AWS SigV4) POUR CLOUDFLARE R2 ──────────────────────────

    /**
     * PUT d'un objet sur R2 via l'API compatible S3, signé en AWS Signature V4.
     * R2 n'a pas de notion de région — "auto" est la valeur attendue par Cloudflare.
     */
    private function r2_put_object( string $key, string $body, string $content_type ) {
        $account = MIAD_R2_ACCOUNT_ID;
        $bucket  = MIAD_R2_BUCKET;
        $access  = MIAD_R2_ACCESS_KEY_ID;
        $secret  = MIAD_R2_SECRET_ACCESS_KEY;
        $region  = 'auto';
        $service = 's3';
        $host    = "{$account}.r2.cloudflarestorage.com";
        $key     = ltrim( $key, '/' );
        $path    = '/' . $bucket . '/' . str_replace( '%2F', '/', rawurlencode( $key ) );

        $now         = time();
        $amzdate     = gmdate( 'Ymd\THis\Z', $now );
        $datestamp   = gmdate( 'Ymd', $now );
        $payloadHash = hash( 'sha256', $body );

        $canonicalHeaders = "host:{$host}\nx-amz-content-sha256:{$payloadHash}\nx-amz-date:{$amzdate}\n";
        $signedHeaders    = 'host;x-amz-content-sha256;x-amz-date';

        $canonicalRequest = "PUT\n{$path}\n\n{$canonicalHeaders}\n{$signedHeaders}\n{$payloadHash}";

        $credentialScope = "{$datestamp}/{$region}/{$service}/aws4_request";
        $stringToSign    = "AWS4-HMAC-SHA256\n{$amzdate}\n{$credentialScope}\n" . hash( 'sha256', $canonicalRequest );

        $kDate     = hash_hmac( 'sha256', $datestamp, 'AWS4' . $secret, true );
        $kRegion   = hash_hmac( 'sha256', $region, $kDate, true );
        $kService  = hash_hmac( 'sha256', $service, $kRegion, true );
        $kSigning  = hash_hmac( 'sha256', 'aws4_request', $kService, true );
        $signature = hash_hmac( 'sha256', $stringToSign, $kSigning );

        $authorization = "AWS4-HMAC-SHA256 Credential={$access}/{$credentialScope}, SignedHeaders={$signedHeaders}, Signature={$signature}";

        $response = wp_remote_request( "https://{$host}{$path}", [
            'method'  => 'PUT',
            'timeout' => 20,
            'headers' => [
                'Host'                 => $host,
                'x-amz-date'           => $amzdate,
                'x-amz-content-sha256' => $payloadHash,
                'Authorization'        => $authorization,
                'Content-Type'         => $content_type,
            ],
            'body' => $body,
        ] );

        if ( is_wp_error( $response ) ) return $response;

        $code = wp_remote_retrieve_response_code( $response );
        if ( $code < 200 || $code >= 300 ) {
            return new WP_Error( 'r2_put_failed', "R2 a refusé l'upload (HTTP {$code}) : " . wp_remote_retrieve_body( $response ) );
        }

        return true;
    }
}

Miad_R2_Images::instance();
