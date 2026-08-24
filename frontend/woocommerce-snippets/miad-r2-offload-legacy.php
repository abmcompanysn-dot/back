<?php
/* ═══════════════════════════════════════════════════════════════════
   1. CORE, SIGNATURE AWS V4 & ACCÈS CLOUDFLARE R2
═══════════════════════════════════════════════════════════════════ */

/**
 * Récupère les options R2 enregistrées via la console
 */
function miad_r2_cfg( $key ) {
    if ( $key === 'account_id' ) {
        return '5e8fd042542e85a3f38cba06304ed5c0';
    }
    return get_option( "miad_r2_{$key}", '' );
}

function miad_r2_ready(): bool {
    return (
        ! empty( miad_r2_cfg( 'account_id' ) ) &&
        ! empty( miad_r2_cfg( 'bucket' ) ) &&
        ! empty( miad_r2_cfg( 'access_key' ) ) &&
        ! empty( miad_r2_cfg( 'secret_key' ) )
    );
}

/**
 * FILTRES D'AFFICHAGE GLOBAUX : Forcer l'URL R2 partout sur le site (Front et Back)
 */
add_filter( 'wp_get_attachment_url', 'miad_r2_filter_url', 10, 2 );
function miad_r2_filter_url( $url, $attachment_id ) {
    $r2_url = get_post_meta( $attachment_id, '_miad_r2_url', true );
    return ! empty( $r2_url ) ? $r2_url : $url;
}

add_filter( 'wp_get_attachment_image_src', function( $image, $attachment_id, $size, $icon ) {
    if ( ! $image ) return $image;
    $r2_url = get_post_meta( $attachment_id, '_miad_r2_url', true );
    if ( ! empty( $r2_url ) ) {
        $r2_base_dir = dirname( $r2_url );
        $filename = basename( $image[0] );
        $image[0] = $r2_base_dir . '/' . $filename;
    }
    return $image;
}, 10, 4 );

/**
 * Moteur de Requête AWS v4 REST pour Cloudflare R2
 */
function miad_r2_execute_request( $relative_path, $method = 'PUT', $content = '' ) {
    $account_id = miad_r2_cfg( 'account_id' );
    $bucket     = miad_r2_cfg( 'bucket' );
    $access_key = miad_r2_cfg( 'access_key' );
    $secret_key = miad_r2_cfg( 'secret_key' );

    $host     = "{$bucket}.{$account_id}.r2.cloudflarestorage.com";
    $endpoint = "https://{$host}/" . ltrim( $relative_path, '/' );

    $timestamp    = gmdate( 'Ymd\THis\Z' );
    $date_short   = substr( $timestamp, 0, 8 );
    $content_hash = hash( 'sha256', $content );

    $canonical_headers = "host:{$host}\nx-amz-content-sha256:{$content_hash}\nx-amz-date:{$timestamp}\n";
    $signed_headers    = "host;x-amz-content-sha256;x-amz-date";
    $canonical_request = "{$method}\n/" . str_replace( '%2F', '/', rawurlencode( $relative_path ) ) . "\n\n{$canonical_headers}\n{$signed_headers}\n{$content_hash}";

    $credential_scope = "{$date_short}/auto/s3/aws4_request";
    $string_to_sign   = "AWS4-HMAC-SHA256\n{$timestamp}\n{$credential_scope}\n" . hash( 'sha256', $canonical_request );

    $k_date    = hash_hmac( 'sha256', $date_short, "AWS4" . $secret_key, true );
    $k_region  = hash_hmac( 'sha256', 'auto', $k_date, true );
    $k_service = hash_hmac( 'sha256', 's3', $k_region, true );
    $k_signing = hash_hmac( 'sha256', 'aws4_request', $k_service, true );
    $signature = hash_hmac( 'sha256', $string_to_sign, $k_signing );

    $authorization = "AWS4-HMAC-SHA256 Credential={$access_key}/{$credential_scope}, SignedHeaders={$signed_headers}, Signature={$signature}";

    $args = [
        'method'    => $method,
        'timeout'   => 15,
        'sslverify' => true,
        'headers'   => [
            'Host'                 => $host,
            'Authorization'        => $authorization,
            'x-amz-date'           => $timestamp,
            'x-amz-content-sha256' => $content_hash,
        ]
    ];

    if ( $method === 'PUT' ) {
        $args['body'] = $content;
        $args['headers']['Content-Type']   = wp_check_filetype( $relative_path )['type'] ?: 'application/octet-stream';
        $args['headers']['Content-Length'] = strlen( $content );
    }

    return wp_remote_request( $endpoint, $args );
}

/**
 * Interroge R2 via HEAD pour savoir si l'image y réside déjà
 */
function miad_r2_file_exists_on_remote( $relative_path ): bool {
    $res = miad_r2_execute_request( $relative_path, 'HEAD' );
    if ( is_wp_error( $res ) ) return false;
    $code = wp_remote_retrieve_response_code( $res );
    return ( $code === 200 || $code === 204 );
}

/**
 * Synchronisation intelligente : lie la BDD si l'image existe sur R2
 */
function miad_r2_sync_attachment( $attachment_id ): string {
    $file_path = get_attached_file( $attachment_id );
    $relative_path = get_post_meta( $attachment_id, '_wp_attached_file', true );

    $public_url = miad_r2_cfg( 'public_url' );
    if ( empty( $public_url ) ) {
        $public_url = 'https://' . miad_r2_cfg( 'bucket' ) . '.' . miad_r2_cfg( 'account_id' ) . '.r2.cloudflarestorage.com';
    }
    $final_r2_url = rtrim( $public_url, '/' ) . '/' . $relative_path;

    // CAS IDÉAL (LIEN SEUL) : Si l'image est introuvable en local mais existe sur R2
    if ( ( ! $file_path || ! file_exists( $file_path ) ) && miad_r2_file_exists_on_remote( $relative_path ) ) {
        update_post_meta( $attachment_id, '_miad_r2_url', $final_r2_url );
        update_post_meta( $attachment_id, '_miad_r2_synced', time() );
        return 'EXISTED';
    }

    // CAS 2 : Si l'image existe en local et aussi sur R2, on met à jour la BDD et on vide le serveur local
    if ( miad_r2_file_exists_on_remote( $relative_path ) ) {
        update_post_meta( $attachment_id, '_miad_r2_url', $final_r2_url );
        update_post_meta( $attachment_id, '_miad_r2_synced', time() );
        if ( $file_path && file_exists( $file_path ) ) {
            @unlink( $file_path );
        }
        return 'EXISTED';
    }

    // Sécurité au cas où le fichier n'est nulle part
    if ( ! $file_path || ! file_exists( $file_path ) ) {
        update_post_meta( $attachment_id, '_miad_r2_synced', 'file_not_found' );
        return 'NOT_FOUND';
    }

    // TRANSMISSION REST SÉCURISÉE (Uniquement si absent sur R2)
    $file_content = file_get_contents( $file_path );
    $response = miad_r2_execute_request( $relative_path, 'PUT', $file_content );

    if ( is_wp_error( $response ) ) {
        return 'FAILED';
    }

    $code = wp_remote_retrieve_response_code( $response );
    if ( $code === 200 || $code === 201 ) {
        update_post_meta( $attachment_id, '_miad_r2_url', $final_r2_url );
        update_post_meta( $attachment_id, '_miad_r2_synced', time() );

        @unlink( $file_path );
        $meta = wp_get_attachment_metadata( $attachment_id );
        if ( ! empty( $meta['sizes'] ) ) {
            $dirname = dirname( $file_path );
            foreach ( $meta['sizes'] as $size_info ) {
                @unlink( $dirname . '/' . $size_info['file'] );
            }
        }
        return 'UPLOADED';
    }

    return 'FAILED';
}

/* ═══════════════════════════════════════════════════════════════════
   2. ENDPOINTS AJAX SECTORISÉS
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_submenu_page( 'upload.php', 'MIAD R2 Offload', '☁ MIAD R2', 'manage_options', 'miad-r2', 'miad_r2_admin_page' );
} );

add_action( 'wp_ajax_miad_r2_reset_flags', function() {
    global $wpdb;
    $wpdb->query( "DELETE FROM {$wpdb->postmeta} WHERE meta_key IN ('_miad_r2_url', '_miad_r2_synced')" );
    wp_send_json_success();
} );

add_action( 'wp_ajax_miad_r2_test_connection', function() {
    if ( ! miad_r2_ready() ) {
        wp_send_json_error( [ 'message' => 'Veuillez configurer vos accès R2.' ] );
    }
    $test_file = 'miad-r2-test.txt';
    $put_res   = miad_r2_execute_request( $test_file, 'PUT', 'Test' );
    if ( is_wp_error( $put_res ) || ! in_array( wp_remote_retrieve_response_code( $put_res ), [200, 201] ) ) {
        wp_send_json_error( [ 'message' => "Refus de liaison R2." ] );
    }
    miad_r2_execute_request( $test_file, 'DELETE' );
    wp_send_json_success( [ 'message' => "Liaison validée !" ] );
} );

add_action( 'wp_ajax_miad_r2_process_batch', function() {
    global $wpdb;
    if ( ! miad_r2_ready() ) wp_send_json_error( [ 'message' => 'Configuration non prête.' ] );

    $target = isset($_POST['target_type']) ? sanitize_text_field($_POST['target_type']) : 'products';
    $batch_size = 4; // Ajusté à 4 médias pour concilier rapidité de liaison et légèreté
    $ids = [];

    if ( $target === 'products' ) {
        $ids = $wpdb->get_col( "
            SELECT DISTINCT pm.post_id FROM {$wpdb->postmeta} pm
            INNER JOIN {$wpdb->posts} p ON pm.post_id = p.ID
            WHERE pm.meta_key = '_wp_attached_file' AND p.post_mime_type LIKE 'image/%'
            AND pm.post_id NOT IN (SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_synced')
            AND pm.post_id IN (SELECT DISTINCT meta_value FROM {$wpdb->postmeta} WHERE meta_key IN ('_thumbnail_id', '_product_image_gallery'))
            LIMIT {$batch_size}
        " );
    } elseif ( $target === 'dokan' ) {
        $ids = $wpdb->get_col( "
            SELECT pm.post_id FROM {$wpdb->postmeta} pm
            INNER JOIN {$wpdb->posts} p ON pm.post_id = p.ID
            WHERE pm.meta_key = '_wp_attached_file' AND p.post_mime_type LIKE 'image/%'
            AND pm.meta_value LIKE '%dokan%'
            AND pm.post_id NOT IN (SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_synced')
            LIMIT {$batch_size}
        " );
    } else {
        $ids = $wpdb->get_col( "
            SELECT p.ID FROM {$wpdb->posts} p
            INNER JOIN {$wpdb->postmeta} pm ON p.ID = pm.post_id AND pm.meta_key = '_wp_attached_file'
            WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE 'image/%'
            AND pm.meta_value NOT LIKE '%dokan%'
            AND p.ID NOT IN (SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_synced')
            AND p.ID NOT IN (
                SELECT DISTINCT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attached_file'
                AND post_id IN (SELECT DISTINCT meta_value FROM {$wpdb->postmeta} WHERE meta_key IN ('_thumbnail_id', '_product_image_gallery'))
            )
            LIMIT {$batch_size}
        " );
    }

    if ( empty( $ids ) ) {
        wp_send_json_success( [ 'status' => 'FINISHED' ] );
    }

    $uploaded = 0; $existed = 0; $failed = 0;
    foreach ( $ids as $id ) {
        $state = miad_r2_sync_attachment( (int) $id );
        if ( $state === 'UPLOADED' ) $uploaded++;
        elseif ( $state === 'EXISTED' ) $existed++;
        else $failed++;
    }

    wp_send_json_success( [
        'status'  => 'PROGRESS',
        'count'   => $uploaded + $existed + $failed,
        'message' => "Lot scanné : {$existed} liens rattachés à R2 (Déjà migrés). (Transférés : {$uploaded}, Échecs : {$failed})"
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   3. RENDU INTERFACE CONSOLE PRO MULTI-BOUTONS
═══════════════════════════════════════════════════════════════════ */
function miad_r2_admin_page(): void {
    global $wpdb;
    $notice = '';

    if ( isset( $_POST['miad_r2_save_config'] ) ) {
        foreach ( [ 'bucket', 'access_key', 'secret_key', 'public_url' ] as $key ) {
            update_option( "miad_r2_{$key}", sanitize_text_field( $_POST["miad_r2_{$key}"] ?? '' ) );
        }
        $notice = '<div class="notice notice-success"><p>✅ Configuration R2 enregistrée.</p></div>';
    }

    $rem_products = (int) $wpdb->get_var( "SELECT COUNT(DISTINCT pm.post_id) FROM {$wpdb->postmeta} pm INNER JOIN {$wpdb->posts} p ON pm.post_id = p.ID WHERE pm.meta_key = '_wp_attached_file' AND p.post_mime_type LIKE 'image/%' AND pm.post_id NOT IN (SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_synced') AND pm.post_id IN (SELECT DISTINCT meta_value FROM {$wpdb->postmeta} WHERE meta_key IN ('_thumbnail_id', '_product_image_gallery'))" );
    $rem_dokan = (int) $wpdb->get_var( "SELECT COUNT(pm.post_id) FROM {$wpdb->postmeta} pm INNER JOIN {$wpdb->posts} p ON pm.post_id = p.ID WHERE pm.meta_key = '_wp_attached_file' AND p.post_mime_type LIKE 'image/%' AND pm.meta_value LIKE '%dokan%' AND pm.post_id NOT IN (SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_synced')" );
    $rem_others = (int) $wpdb->get_var( "SELECT COUNT(p.ID) FROM {$wpdb->posts} p INNER JOIN {$wpdb->postmeta} pm ON p.ID = pm.post_id AND pm.meta_key = '_wp_attached_file' WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE 'image/%' AND pm.meta_value NOT LIKE '%dokan%' AND p.ID NOT IN (SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_synced') AND p.ID NOT IN (SELECT DISTINCT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attached_file' AND post_id IN (SELECT DISTINCT meta_value FROM {$wpdb->postmeta} WHERE meta_key IN ('_thumbnail_id', '_product_image_gallery')))" );
    $total_all = (int) wp_count_posts( 'attachment' )->inherit;

    echo $notice;
    ?>
    <div class="wrap" style="max-width:900px">
        <h1 style="margin-bottom:20px;">☁ MIAD R2 — Console de Synchronisation Séparée</h1>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px">
            <div style="background:#fffbeb;border:2px solid #b45309;border-radius:12px;padding:15px;text-align:center">
                <p id="stat-products" style="font-size:2.2rem;font-weight:900;color:#b45309;margin:0;"><?= number_format($rem_products) ?></p>
                <p style="font-size:.8rem;color:#6b7280;margin:5px 0;font-weight:700;text-transform:uppercase;">📦 Produits WooCommerce</p>
                <button type="button" class="button button-primary action-start" data-target="products" style="background:#b45309;border-color:#92400e;">Synchroniser WooCommerce</button>
            </div>
            <div style="background:#fff7ed;border:2px solid #ea580c;border-radius:12px;padding:15px;text-align:center">
                <p id="stat-dokan" style="font-size:2.2rem;font-weight:900;color:#ea580c;margin:0;"><?= number_format($rem_dokan) ?></p>
                <p style="font-size:.8rem;color:#6b7280;margin:5px 0;font-weight:700;text-transform:uppercase;">🏪 Boutiques Dokan</p>
                <button type="button" class="button button-primary action-start" data-target="dokan" style="background:#ea580c;border-color:#ca8a04;">Synchroniser Dokan</button>
            </div>
            <div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:12px;padding:15px;text-align:center">
                <p id="stat-others" style="font-size:2.2rem;font-weight:900;color:#16a34a;margin:0;"><?= number_format($rem_others) ?></p>
                <p style="font-size:.8rem;color:#6b7280;margin:5px 0;font-weight:700;text-transform:uppercase;">📂 Reste Bibliothèque</p>
                <button type="button" class="button button-primary action-start" data-target="others" style="background:#16a34a;border-color:#15803d;">Synchroniser le Reste</button>
            </div>
        </div>

        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;">
                <h2 style="margin:0;">🚀 Moniteur d'avancement en temps réel</h2>
                <button type="button" id="miad-stop" class="button button-secondary" disabled style="color:#dc2626;border-color:#ef4444;">🛑 Mettre en Pause</button>
            </div>
            <div id="miad-console" style="background:#0f172a;color:#38bdf8;font-family:monospace;padding:16px;border-radius:10px;height:200px;overflow-y:auto;font-size:13px;line-height:1.6;margin-bottom:15px;">
                [Système] Prêt. Total global bibliothèque : <?= number_format($total_all) ?> médias.<br>
            </div>
            <div style="display:flex;gap:12px;">
                <button type="button" id="miad-test-btn" class="button button-secondary">🔍 Tester la Connexion brute R2</button>
                <button type="button" id="miad-reset" class="button button-link-delete" style="color:#dc2626;">🗑️ Reset Métadonnées de Synchro</button>
            </div>
        </div>

        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;">
            <h2 style="margin-top:0">⚙️ Configuration Identifiants R2</h2>
            <form method="post">
                <table class="form-table">
                    <tr>
                        <th>Account ID Cloudflare</th>
                        <td><input type="text" class="regular-text" value="5e8fd042542e85a3f38cba06304ed5c0" disabled style="background:#f1f5f9;color:#64748b;font-family:monospace;"></td>
                    </tr>
                    <tr>
                        <th>Nom du Bucket R2</th>
                        <td><input type="text" name="miad_r2_bucket" value="<?= esc_attr( miad_r2_cfg('bucket') ) ?>" class="regular-text" style="font-family:monospace;"></td>
                    </tr>
                    <tr>
                        <th>Clé d'accès (Access Key)</th>
                        <td><input type="text" name="miad_r2_access_key" value="<?= esc_attr( miad_r2_cfg('access_key') ) ?>" class="regular-text" style="font-family:monospace;"></td>
                    </tr>
                    <tr>
                        <th>Clé secrète (Secret Key)</th>
                        <td><input type="password" name="miad_r2_secret_key" value="<?= esc_attr( miad_r2_cfg('secret_key') ) ?>" class="regular-text" style="font-family:monospace;"></td>
                    </tr>
                    <tr>
                        <th>URL Publique distribution</th>
                        <td><input type="url" name="miad_r2_public_url" value="<?= esc_attr( miad_r2_cfg('public_url') ) ?>" class="regular-text" style="width:100%;max-width:450px;font-family:monospace;"></td>
                    </tr>
                </table>
                <p style="margin-top:15px;"><button type="submit" name="miad_r2_save_config" class="button button-primary">💾 Sauvegarder les configurations</button></p>
            </form>
        </div>
    </div>

    <script type="text/javascript">
    jQuery(document).ready(function($) {
        var running = false; var activeTarget = '';
        function log(msg, color = '#38bdf8') {
            var time = new Date().toLocaleTimeString();
            $('#miad-console').append('<span style="color:'+color+'">['+time+'] '+msg+'</span><br>');
            $('#miad-console').scrollTop($('#miad-console')[0].scrollHeight);
        }
        function executeBatch() {
            if (!running) return;
            $.post(ajaxurl, { action: 'miad_r2_process_batch', target_type: activeTarget }, function(res) {
                if (res.success) {
                    if (res.data.status === 'FINISHED') {
                        log('🎉 Fin de traitement pour cette catégorie ! Tous les liens ont été synchronisés.', '#34d399'); running = false; resetInterface();
                    } else {
                        log(res.data.message, '#fbbf24');
                        var $span = $('#stat-' + activeTarget); var current = parseInt($span.text().replace(/,/g, ''));
                        $span.text(Math.max(0, current - res.data.count).toLocaleString());
                        setTimeout(executeBatch, 400);
                    }
                } else {
                    log('⚠️ Interruption : ' + res.data.message, '#f87171'); running = false; resetInterface();
                }
            }).fail(function() {
                log('⌛ Latence serveur. Reprise automatique dans 3 secondes...', '#60a5fa');
                setTimeout(executeBatch, 3000);
            });
        }
        $('.action-start').on('click', function() {
            if(running) return; running = true; activeTarget = $(this).data('target');
            $('.action-start').attr('disabled', true); $('#miad-stop').attr('disabled', false);
            log('🚀 Analyse et liaison ciblée sur [' + activeTarget.toUpperCase() + ']...', '#34d399'); executeBatch();
        });
        $('#miad-stop').on('click', function() { running = false; resetInterface(); log('⏸️ Suspendu.', '#f87171'); });
        function resetInterface() { $('.action-start').attr('disabled', false); $('#miad-stop').attr('disabled', true); }
        $('#miad-test-btn').on('click', function() {
            var $btn = $(this); $btn.attr('disabled', true); log('⌛ Test...', '#e2e8f0');
            $.post(ajaxurl, { action: 'miad_r2_test_connection' }, function(res) {
                if (res.success) log('✅ ' + res.data.message, '#34d399'); else log('❌ ' + res.data.message, '#f87171');
                $btn.attr('disabled', false);
            });
        });
        $('#miad-reset').on('click', function() { if (!confirm('Purger l\'historique de synchro pour reconstruire les liens ?')) return; $.post(ajaxurl, { action: 'miad_r2_reset_flags' }, function() { location.reload(); }); });
    });
    </script>
    <?php
}
