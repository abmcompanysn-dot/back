
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
/**
 * Construit l'URL R2 de l'original à partir du chemin relatif WordPress
 * (_wp_attached_file), en se basant sur l'URL publique configurée.
 */
function miad_r2_public_url_for( string $relative ): string {
    $public_url = miad_r2_cfg( 'public_url' );
    if ( empty( $public_url ) ) {
        $public_url = 'https://' . miad_r2_cfg( 'bucket' ) . '.' . miad_r2_cfg( 'account_id' ) . '.r2.cloudflarestorage.com';
    }
    return rtrim( $public_url, '/' ) . '/' . $relative;
}

/**
 * HEAD avec une nouvelle tentative immédiate en cas d'erreur de connexion
 * (coupure réseau passagère côté serveur — DNS, timeout, connexion refusée).
 * Sans ça, un simple hoquet réseau d'une fraction de seconde ferait passer
 * une image valide pour cassée jusqu'à l'expiration du cache (5 min).
 * Pas de délai entre les essais : on ne veut pas ralentir le chargement de
 * la page pour les visiteurs en attendant un retry.
 */
function miad_r2_http_check_ok( string $url, int $timeout = 3 ): bool {
    for ( $attempt = 1; $attempt <= 2; $attempt++ ) {
        $res = wp_remote_head( $url, [ 'timeout' => $timeout ] );
        if ( ! is_wp_error( $res ) ) {
            return wp_remote_retrieve_response_code( $res ) === 200;
        }
    }
    return false; // échec de connexion confirmé après 2 tentatives — pas juste un hoquet
}

/**
 * Vérifie que l'URL locale répond vraiment en HTTP 200 — file_exists() côté
 * PHP peut renvoyer vrai alors que le serveur web (Nginx) sert un 404 pour ce
 * même chemin (permissions, cache de stat, chemin disque différent du chemin
 * servi), donc on se base sur ce que les visiteurs reçoivent réellement.
 * Résultat mis en cache 1h (succès) ou 5 min (échec, pour retenter vite après
 * une éventuelle resynchro) afin de ne pas refaire cette requête à chaque vue.
 */
function miad_r2_local_url_works( string $url ): bool {
    $cache_key = 'miad_r2_local_ok_' . md5( $url );
    $cached = get_transient( $cache_key );
    if ( $cached !== false ) return $cached === '1';

    $ok = miad_r2_http_check_ok( $url );
    set_transient( $cache_key, $ok ? '1' : '0', $ok ? HOUR_IN_SECONDS : 5 * MINUTE_IN_SECONDS );
    return $ok;
}

/**
 * Vérifie (avec cache) qu'un chemin relatif existe déjà sur R2 — utilisé en
 * mode "Forcer R2" pour basculer même quand le fichier local fonctionne
 * encore, sans casser l'image si elle n'a pas encore été migrée là-bas.
 */
function miad_r2_remote_url_works( string $url ): bool {
    $cache_key = 'miad_r2_remote_ok_' . md5( $url );
    $cached = get_transient( $cache_key );
    if ( $cached !== false ) return $cached === '1';

    $ok = miad_r2_http_check_ok( $url );
    set_transient( $cache_key, $ok ? '1' : '0', $ok ? HOUR_IN_SECONDS : 5 * MINUTE_IN_SECONDS );
    return $ok;
}

/**
 * Filet de sécurité ET mode "Forcer R2" :
 *  - Si "Forcer R2" est activé et que la version R2 existe déjà, on la sert
 *    systématiquement (même si le fichier local fonctionne) pour décharger
 *    le serveur d'origine.
 *  - Sinon, on ne bascule que si l'URL locale ne répond pas réellement (404,
 *    fichier déplacé/supprimé, ou incohérence disque/serveur web) — pour ne
 *    jamais renvoyer un lien mort.
 */
function miad_r2_fallback_url( int $attachment_id, string $default_url ): string {
    $relative = get_post_meta( $attachment_id, '_wp_attached_file', true );

    if ( $relative && miad_r2_cfg( 'force_r2' ) === '1' ) {
        $candidate = miad_r2_public_url_for( $relative );
        if ( miad_r2_remote_url_works( $candidate ) ) return $candidate;
    }

    if ( miad_r2_local_url_works( $default_url ) ) return $default_url; // l'URL locale répond bien, rien à faire
    if ( ! $relative ) return $default_url;

    return miad_r2_public_url_for( $relative );
}

add_filter( 'wp_get_attachment_url', 'miad_r2_filter_url', 10, 2 );
function miad_r2_filter_url( $url, $attachment_id ) {
    $r2_url = get_post_meta( $attachment_id, '_miad_r2_url', true );
    if ( ! empty( $r2_url ) ) return $r2_url;
    return miad_r2_fallback_url( $attachment_id, $url );
}

add_filter( 'wp_get_attachment_image_src', function( $image, $attachment_id, $size, $icon ) {
    if ( ! $image ) return $image;
    $r2_url = get_post_meta( $attachment_id, '_miad_r2_url', true );
    if ( ! empty( $r2_url ) ) {
        $r2_base_dir = dirname( $r2_url );
        $filename = basename( $image[0] );
        $image[0] = $r2_base_dir . '/' . $filename;
        return $image;
    }
    $image[0] = miad_r2_fallback_url( $attachment_id, $image[0] );
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

        // Uploader chaque dérivée (miniatures 100x100, 150x150, etc.) sur R2
        // AVANT de supprimer le local — sans ça, les miniatures disparaissent
        // sans jamais avoir existé sur R2, créant des liens cassés.
        $meta = wp_get_attachment_metadata( $attachment_id );
        $dirname_relative = trailingslashit( dirname( $relative_path ) );
        if ( $dirname_relative === './' ) $dirname_relative = '';
        if ( ! empty( $meta['sizes'] ) ) {
            $dirname = dirname( $file_path );
            foreach ( $meta['sizes'] as $size_info ) {
                $size_local_path    = $dirname . '/' . $size_info['file'];
                $size_relative_path = $dirname_relative . $size_info['file'];
                if ( file_exists( $size_local_path ) ) {
                    $size_content  = file_get_contents( $size_local_path );
                    $size_response = miad_r2_execute_request( $size_relative_path, 'PUT', $size_content );
                    if ( ! is_wp_error( $size_response ) && in_array( wp_remote_retrieve_response_code( $size_response ), [ 200, 201 ], true ) ) {
                        @unlink( $size_local_path );
                    }
                }
            }
        }

        @unlink( $file_path );
        return 'UPLOADED';
    }

    return 'FAILED';
}

/**
 * Pour les pièces jointes non rattachées et sans fichier local : vérifie via
 * HEAD que l'URL R2 de secours répond bien, et si oui enregistre _miad_r2_url
 * en dur — fait passer l'image de "récupérée par le filet de sécurité" à
 * "officiellement rattachée", sans dépendre d'un re-calcul à chaque requête.
 */
function miad_r2_heal_one( int $attachment_id ): string {
    $r2_url = get_post_meta( $attachment_id, '_miad_r2_url', true );
    if ( ! empty( $r2_url ) ) return 'already_synced';

    $relative = get_post_meta( $attachment_id, '_wp_attached_file', true );
    if ( ! $relative ) return 'no_relative';

    // URL locale non filtrée (wp_get_attachment_url() repasserait par notre
    // propre filtre miad_r2_filter_url, ce qui fausserait la comparaison).
    $local_url = trailingslashit( wp_upload_dir()['baseurl'] ) . $relative;
    if ( miad_r2_local_url_works( $local_url ) ) return 'still_local';

    $candidate = miad_r2_public_url_for( $relative );
    $res = wp_remote_head( $candidate, [ 'timeout' => 5 ] );
    if ( is_wp_error( $res ) || wp_remote_retrieve_response_code( $res ) !== 200 ) {
        return 'still_broken';
    }

    update_post_meta( $attachment_id, '_miad_r2_url', $candidate );
    update_post_meta( $attachment_id, '_miad_r2_synced', time() );
    return 'healed';
}

/**
 * Diagnostic : classe chaque pièce jointe image en 3 catégories —
 * "synced" (_miad_r2_url déjà rattaché), "local" (pas rattaché mais le
 * fichier existe encore sur le serveur), "broken" (ni l'un ni l'autre —
 * lien mort avant le filet de sécurité miad_r2_fallback_url). Retourne
 * aussi un échantillon des liens cassés pour pouvoir les identifier.
 */
function miad_r2_scan_links( int $limit = 1000 ): array {
    global $wpdb;
    $ids = $wpdb->get_col( $wpdb->prepare( "
        SELECT p.ID FROM {$wpdb->posts} p
        WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE 'image/%%'
        ORDER BY p.ID DESC
        LIMIT %d
    ", $limit ) );

    $synced = 0; $local = 0; $broken = 0; $broken_samples = []; $synced_samples = [];

    foreach ( $ids as $id ) {
        $id = (int) $id;
        $r2_url = get_post_meta( $id, '_miad_r2_url', true );
        if ( ! empty( $r2_url ) ) {
            $synced++;
            if ( count( $synced_samples ) < 30 ) {
                $synced_samples[] = [
                    'id'   => $id,
                    'name' => get_the_title( $id ) ?: ( 'ID ' . $id ),
                    'url'  => $r2_url,
                ];
            }
            continue;
        }

        $file_path = get_attached_file( $id );
        if ( $file_path && file_exists( $file_path ) ) { $local++; continue; }

        $broken++;
        if ( count( $broken_samples ) < 30 ) {
            $broken_samples[] = [
                'id'   => $id,
                'name' => get_the_title( $id ) ?: ( 'ID ' . $id ),
                'url'  => wp_get_attachment_url( $id ),
            ];
        }
    }

    return [
        'total'          => count( $ids ),
        'synced'         => $synced,
        'local'          => $local,
        'broken'         => $broken,
        'samples'        => $broken_samples,
        'synced_samples' => $synced_samples,
    ];
}

/**
 * Reprend les images produits (vedette + galerie) qui n'ont pas encore
 * _miad_r2_url, et vérifie directement sur R2 si le fichier y existe déjà
 * (souvent le cas après une migration de bucket externe) — si oui, on relie
 * juste la métadonnée (rapide, pas de re-upload) ; sinon on uploade pour de
 * vrai. Contourne le drapeau _miad_r2_synced qui peut être resté à tort.
 */
function miad_r2_product_images_to_check( int $limit = 20 ): array {
    global $wpdb;
    // _product_image_gallery stocke une liste d'IDs séparés par des virgules
    // (ex: "123,456,789") — FIND_IN_SET() est nécessaire pour y chercher un ID
    // précis ; un simple match exact (REGEXP '^[0-9]+$') ratait toute galerie
    // contenant plus d'une image.
    return $wpdb->get_col( $wpdb->prepare( "
        SELECT DISTINCT pm.post_id FROM {$wpdb->postmeta} pm
        INNER JOIN {$wpdb->posts} p ON pm.post_id = p.ID
        WHERE pm.meta_key = '_wp_attached_file' AND p.post_mime_type LIKE 'image/%%'
        AND pm.post_id NOT IN ( SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_url' )
        AND (
            pm.post_id IN ( SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_thumbnail_id' AND meta_value REGEXP '^[0-9]+$' )
            OR EXISTS (
                SELECT 1 FROM {$wpdb->postmeta} pm2
                WHERE pm2.meta_key = '_product_image_gallery' AND FIND_IN_SET( pm.post_id, pm2.meta_value ) > 0
            )
        )
        ORDER BY pm.post_id DESC
        LIMIT %d
    ", $limit ) );
}

/**
 * Recherche une pièce jointe par nom de fichier (ou URL complète collée par
 * l'utilisateur) et la fait vérifier/uploader/lier vers R2 à la demande —
 * pour traiter au cas par cas une image précise (logo, bannière, etc.) sans
 * attendre qu'elle passe par le scan produits automatique.
 */
function miad_r2_check_by_name( string $input ): array {
    global $wpdb;

    // Accepte un nom de fichier seul, un chemin relatif, ou une URL complète
    $name = trim( $input );
    $name = preg_replace( '#^https?://[^/]+/(?:wp-content/uploads/)?#i', '', $name );
    $name = ltrim( $name, '/' );
    if ( ! $name ) return [ 'ok' => false, 'error' => 'Nom vide' ];

    $like = '%' . $wpdb->esc_like( basename( $name ) ) . '%';
    $attachment_id = (int) $wpdb->get_var( $wpdb->prepare( "
        SELECT post_id FROM {$wpdb->postmeta}
        WHERE meta_key = '_wp_attached_file' AND meta_value LIKE %s
        ORDER BY post_id DESC LIMIT 1
    ", $like ) );

    if ( $attachment_id ) {
        $state = miad_r2_check_or_sync_one( $attachment_id );
        $relative = get_post_meta( $attachment_id, '_wp_attached_file', true );
        return [
            'ok'            => in_array( $state, [ 'linked', 'uploaded' ], true ),
            'attachment_id' => $attachment_id,
            'state'         => $state,
            'r2_url'        => miad_r2_public_url_for( $relative ),
        ];
    }

    // Aucune pièce jointe WordPress correspondante — on tente quand même un
    // upload direct si l'entrée ressemble à un chemin relatif exploitable
    // (ex: collé depuis une URL "wp-content/uploads/...").
    $relative = preg_replace( '#^.*?uploads/#i', '', $input );
    if ( $relative === $input || ! $relative ) {
        return [ 'ok' => false, 'error' => 'Aucune pièce jointe trouvée pour "' . esc_html( $name ) . '"' ];
    }

    $local_url = trailingslashit( wp_upload_dir()['baseurl'] ) . $relative;
    $res = wp_remote_get( $local_url, [ 'timeout' => 15 ] );
    if ( is_wp_error( $res ) || wp_remote_retrieve_response_code( $res ) !== 200 ) {
        return [ 'ok' => false, 'error' => 'Fichier introuvable nulle part (ni base WP, ni serveur local)' ];
    }

    $put = miad_r2_execute_request( $relative, 'PUT', wp_remote_retrieve_body( $res ) );
    if ( is_wp_error( $put ) || ! in_array( wp_remote_retrieve_response_code( $put ), [ 200, 201 ], true ) ) {
        return [ 'ok' => false, 'error' => 'Upload R2 échoué' ];
    }

    return [ 'ok' => true, 'attachment_id' => 0, 'state' => 'uploaded_no_db', 'r2_url' => miad_r2_public_url_for( $relative ) ];
}

/**
 * Recherche un produit par son nom (titre WooCommerce) et traite toutes ses
 * images (vedette + galerie) en une fois — utile quand on veut s'assurer
 * qu'un produit précis est entièrement migré, sans connaître les noms de
 * fichiers de ses images une par une.
 */
function miad_r2_check_by_product_name( string $name ): array {
    $products = get_posts( [
        'post_type'      => 'product',
        'post_status'    => 'publish',
        's'              => $name,
        'posts_per_page' => 5,
    ] );

    if ( empty( $products ) ) {
        return [ 'ok' => false, 'error' => 'Aucun produit trouvé pour "' . esc_html( $name ) . '"' ];
    }

    $product = $products[0]; // le plus pertinent (WordPress trie déjà par pertinence sur "s")
    $thumbnail_id = (int) get_post_meta( $product->ID, '_thumbnail_id', true );
    $gallery_raw  = get_post_meta( $product->ID, '_product_image_gallery', true );
    $gallery_ids  = $gallery_raw ? array_map( 'intval', array_filter( explode( ',', $gallery_raw ) ) ) : [];

    $attachment_ids = array_unique( array_filter( array_merge( [ $thumbnail_id ], $gallery_ids ) ) );

    if ( empty( $attachment_ids ) ) {
        return [ 'ok' => false, 'error' => 'Produit "' . esc_html( $product->post_title ) . '" trouvé, mais aucune image associée.' ];
    }

    $linked = 0; $uploaded = 0; $failed = 0; $results = [];
    foreach ( $attachment_ids as $id ) {
        $state = miad_r2_check_or_sync_one( $id );
        if ( $state === 'linked' ) $linked++;
        elseif ( $state === 'uploaded' ) $uploaded++;
        else $failed++;
        $results[] = [ 'attachment_id' => $id, 'state' => $state ];
    }

    return [
        'ok'            => $failed < count( $attachment_ids ),
        'product_id'    => $product->ID,
        'product_name'  => $product->post_title,
        'total_images'  => count( $attachment_ids ),
        'linked'        => $linked,
        'uploaded'      => $uploaded,
        'failed'        => $failed,
        'results'       => $results,
    ];
}

function miad_r2_check_or_sync_one( int $attachment_id ): string {
    $relative = get_post_meta( $attachment_id, '_wp_attached_file', true );
    if ( ! $relative ) return 'no_relative';

    // Déjà présent sur R2 (ex: copié par migration externe de bucket) → on relie sans re-uploader
    if ( miad_r2_file_exists_on_remote( $relative ) ) {
        $final_r2_url = miad_r2_public_url_for( $relative );
        update_post_meta( $attachment_id, '_miad_r2_url', $final_r2_url );
        update_post_meta( $attachment_id, '_miad_r2_synced', time() );
        return 'linked';
    }

    // Absent de R2 → upload réel
    $state = miad_r2_sync_attachment( $attachment_id );
    return $state === 'UPLOADED' ? 'uploaded' : 'failed';
}

/* ═══════════════════════════════════════════════════════════════════
   1ter. SYNCHRONISATION AUTOMATIQUE DES NOUVEAUX UPLOADS
   Dès qu'un vendeur (ou l'admin) ajoute un produit avec une image,
   WordPress génère ses miniatures puis déclenche ce hook — l'original ET
   toutes ses tailles (100x100, 150x150, 300x300, grande taille...) partent
   alors automatiquement sur R2, sans attendre un script de migration.
═══════════════════════════════════════════════════════════════════ */

add_filter( 'wp_generate_attachment_metadata', function ( array $metadata, int $attachment_id ): array {
    // wp_generate_attachment_metadata ne se déclenche que pour les images —
    // pas besoin de vérifier le mime-type ici.
    if ( ! miad_r2_ready() ) return $metadata; // pas de clés R2 configurées, on laisse en local

    // Différé en tâche planifiée immédiate plutôt qu'en synchrone : l'upload
    // R2 ne doit jamais ralentir la réponse "produit créé" envoyée au vendeur.
    wp_schedule_single_event( time(), 'miad_r2_auto_sync_event', [ $attachment_id ] );

    return $metadata;
}, 20, 2 );

add_action( 'miad_r2_auto_sync_event', function ( int $attachment_id ) {
    miad_r2_sync_attachment( $attachment_id );
} );

/* ═══════════════════════════════════════════════════════════════════
   1bis. ENDPOINT REST POUR SCRIPT EXTERNE (traitement fait sur un autre
   ordinateur — celui-ci télécharge l'original, l'uploade lui-même sur R2,
   puis vient juste enregistrer le lien final ici, sans solliciter le
   serveur WordPress pour le téléchargement/upload).
═══════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', function () {
    register_rest_route( 'miad-r2/v1', '/link', [
        'methods'             => 'POST',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_r2_cfg( 'link_secret' );
            return ! empty( $secret ) && hash_equals( $secret, (string) $request->get_header( 'x-miad-r2-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $attachment_id = (int) $request->get_param( 'attachment_id' );
            $r2_url        = sanitize_text_field( (string) $request->get_param( 'r2_url' ) );

            if ( ! $attachment_id || ! $r2_url || get_post_type( $attachment_id ) !== 'attachment' ) {
                return new WP_REST_Response( [ 'error' => 'attachment_id ou r2_url invalide' ], 400 );
            }

            update_post_meta( $attachment_id, '_miad_r2_url', $r2_url );
            update_post_meta( $attachment_id, '_miad_r2_synced', time() );

            return new WP_REST_Response( [ 'ok' => true, 'attachment_id' => $attachment_id, 'r2_url' => $r2_url ], 200 );
        },
    ] );

    // Liste paginée des images produits pas encore liées à R2, avec leur chemin
    // relatif et leur URL locale — pour que le script externe sache quoi traiter
    // sans avoir besoin d'un accès direct à la base de données.
    register_rest_route( 'miad-r2/v1', '/pending', [
        'methods'             => 'GET',
        'permission_callback' => function ( WP_REST_Request $request ) {
            $secret = miad_r2_cfg( 'link_secret' );
            return ! empty( $secret ) && hash_equals( $secret, (string) $request->get_header( 'x-miad-r2-secret' ) );
        },
        'callback' => function ( WP_REST_Request $request ) {
            $limit = max( 1, min( 200, (int) $request->get_param( 'limit' ) ?: 50 ) );
            $ids   = miad_r2_product_images_to_check( $limit );

            $items = [];
            foreach ( $ids as $id ) {
                $id       = (int) $id;
                $relative = get_post_meta( $id, '_wp_attached_file', true );
                if ( ! $relative ) continue;
                $items[] = [
                    'attachment_id' => $id,
                    'relative_path' => $relative,
                    'local_url'     => trailingslashit( wp_upload_dir()['baseurl'] ) . $relative,
                ];
            }

            return new WP_REST_Response( $items, 200 );
        },
    ] );
} );

/* ═══════════════════════════════════════════════════════════════════
   2. ENDPOINTS AJAX SECTORISÉS
═══════════════════════════════════════════════════════════════════ */

add_action( 'admin_menu', function () {
    add_submenu_page( 'upload.php', 'MIAD R2 Offload', '☁ MIAD R2', 'manage_options', 'miad-r2', 'miad_r2_admin_page' );
} );

add_action( 'wp_ajax_miad_r2_scan_links', function() {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );
    wp_send_json_success( miad_r2_scan_links() );
} );

add_action( 'wp_ajax_miad_r2_check_products', function() {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );
    if ( ! miad_r2_ready() ) wp_send_json_error( [ 'message' => 'Configuration R2 non prête.' ] );

    $ids = miad_r2_product_images_to_check( 15 );
    if ( empty( $ids ) ) {
        wp_send_json_success( [ 'status' => 'FINISHED', 'linked' => 0, 'uploaded' => 0, 'failed' => 0 ] );
    }

    $linked = 0; $uploaded = 0; $failed = 0;
    foreach ( $ids as $id ) {
        $state = miad_r2_check_or_sync_one( (int) $id );
        if ( $state === 'linked' ) $linked++;
        elseif ( $state === 'uploaded' ) $uploaded++;
        else $failed++;
    }

    wp_send_json_success( [ 'status' => 'PROGRESS', 'linked' => $linked, 'uploaded' => $uploaded, 'failed' => $failed ] );
} );

add_action( 'wp_ajax_miad_r2_check_by_name', function() {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );
    if ( ! miad_r2_ready() ) wp_send_json_error( [ 'message' => 'Configuration R2 non prête.' ] );

    $input = sanitize_text_field( $_POST['name'] ?? '' );
    if ( ! $input ) wp_send_json_error( [ 'message' => 'Nom ou URL manquant.' ] );

    $result = miad_r2_check_by_name( $input );
    if ( $result['ok'] ) wp_send_json_success( $result );
    else wp_send_json_error( $result );
} );

add_action( 'wp_ajax_miad_r2_check_by_product', function() {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );
    if ( ! miad_r2_ready() ) wp_send_json_error( [ 'message' => 'Configuration R2 non prête.' ] );

    $name = sanitize_text_field( $_POST['product_name'] ?? '' );
    if ( ! $name ) wp_send_json_error( [ 'message' => 'Nom de produit manquant.' ] );

    $result = miad_r2_check_by_product_name( $name );
    if ( $result['ok'] ) wp_send_json_success( $result );
    else wp_send_json_error( $result );
} );

add_action( 'wp_ajax_miad_r2_heal_batch', function() {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );

    global $wpdb;
    $batch_size = 10;
    $ids = $wpdb->get_col( $wpdb->prepare( "
        SELECT p.ID FROM {$wpdb->posts} p
        WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE 'image/%%'
        AND p.ID NOT IN ( SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_miad_r2_url' )
        ORDER BY p.ID DESC
        LIMIT %d
    ", $batch_size * 5 ) ); // marge car certains seront 'still_local', pas comptés dans le lot utile

    $healed = 0; $still_broken = 0; $still_local = 0; $processed = 0;

    foreach ( $ids as $id ) {
        $state = miad_r2_heal_one( (int) $id );
        if ( $state === 'still_local' ) { $still_local++; continue; }
        $processed++;
        if ( $state === 'healed' ) $healed++;
        elseif ( $state === 'still_broken' ) $still_broken++;
        if ( $processed >= $batch_size ) break;
    }

    wp_send_json_success( [
        'status'       => $processed < $batch_size ? 'FINISHED' : 'PROGRESS',
        'healed'       => $healed,
        'still_broken' => $still_broken,
    ] );
} );

add_action( 'wp_ajax_miad_r2_reset_flags', function() {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( [ 'message' => 'Unauthorized' ], 403 );
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
        foreach ( [ 'bucket', 'access_key', 'secret_key', 'public_url', 'link_secret' ] as $key ) {
            update_option( "miad_r2_{$key}", sanitize_text_field( $_POST["miad_r2_{$key}"] ?? '' ) );
        }
        update_option( 'miad_r2_force_r2', isset( $_POST['miad_r2_force_r2'] ) ? '1' : '0' );
        $notice = '<div class="notice notice-success"><p>✅ Configuration R2 enregistrée.</p></div>';
    }

    if ( empty( miad_r2_cfg( 'link_secret' ) ) ) {
        update_option( 'miad_r2_link_secret', wp_generate_password( 40, false ) );
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
                <button type="button" id="miad-scan-btn" class="button button-secondary">🩺 Diagnostiquer les liens</button>
                <button type="button" id="miad-reset" class="button button-link-delete" style="color:#dc2626;">🗑️ Reset Métadonnées de Synchro</button>
            </div>
        </div>

        <div id="miad-scan-box" style="display:none;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;margin-bottom:24px;">
            <h2 style="margin-top:0">🩺 Diagnostic des liens images</h2>
            <div id="miad-scan-summary" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px"></div>
            <div id="miad-synced-samples" style="font-family:monospace;font-size:12px;max-height:300px;overflow:auto;background:#0f172a;color:#4ade80;border-radius:8px;padding:12px;margin-bottom:16px"></div>
            <div id="miad-scan-samples" style="font-family:monospace;font-size:12px;max-height:300px;overflow:auto;background:#0f172a;color:#f87171;border-radius:8px;padding:12px;margin-bottom:16px"></div>
            <button type="button" id="miad-heal-btn" class="button button-primary">🔗 Rattacher automatiquement les liens récupérés</button>
            <span id="miad-heal-status" style="margin-left:10px;color:#555"></span>
            <br><br>
            <button type="button" id="miad-check-products-btn" class="button button-primary">🔄 Vérifier &amp; synchroniser les images produits</button>
            <span id="miad-check-products-status" style="margin-left:10px;color:#555"></span>
            <p class="description">Pour chaque image produit pas encore liée à R2 : vérifie si elle y est déjà (cas d'une migration de bucket externe — lie juste le lien) sinon l'uploade pour de vrai.</p>
            <br>
            <h3 style="margin:0 0 8px">🔎 Traiter une image précise (logo, bannière, etc.)</h3>
            <input type="text" id="miad-check-name-input" placeholder="ex: logo-2-300x300.png ou une URL complète" class="regular-text" style="font-family:monospace">
            <button type="button" id="miad-check-name-btn" class="button button-secondary">Vérifier / Uploader / Lier</button>
            <p id="miad-check-name-result" style="margin-top:8px;font-family:monospace;font-size:13px"></p>
            <br>
            <h3 style="margin:0 0 8px">📦 Traiter toutes les images d'un produit (par son nom)</h3>
            <input type="text" id="miad-check-product-input" placeholder="ex: Sac en cuir africain" class="regular-text" style="font-family:monospace">
            <button type="button" id="miad-check-product-btn" class="button button-secondary">Vérifier / Uploader / Lier tout</button>
            <p id="miad-check-product-result" style="margin-top:8px;font-family:monospace;font-size:13px"></p>
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
                    <tr>
                        <th>Forcer R2</th>
                        <td>
                            <label>
                                <input type="checkbox" name="miad_r2_force_r2" value="1" <?= checked( '1', miad_r2_cfg('force_r2'), false ) ?> />
                                Servir depuis R2 dès que la version existe là-bas, même si le fichier local fonctionne encore
                            </label>
                            <p class="description">Décharge le serveur d'origine (évite les saturations de connexions sur les pages avec beaucoup d'images).</p>
                        </td>
                    </tr>
                </table>
                <p style="margin-top:15px;"><button type="submit" name="miad_r2_save_config" class="button button-primary">💾 Sauvegarder les configurations</button></p>
            </form>
        </div>

        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;margin-top:24px;">
            <h2 style="margin-top:0">💻 Traitement externe (script sur ton ordinateur)</h2>
            <p class="description">
                Clé secrète à mettre dans le fichier <code>.env.local</code> du script Node
                (<code>MIAD_LINK_SECRET=...</code>), avec <code>MIAD_LINK_API=<?= esc_html( untrailingslashit( site_url() ) ) ?>/wp-json/miad-r2/v1</code>.
                Ne la partage avec personne d'autre — elle permet d'écrire dans la base de données.
            </p>
            <input type="text" readonly value="<?= esc_attr( miad_r2_cfg('link_secret') ) ?>" class="regular-text" style="width:100%;max-width:500px;font-family:monospace;" onclick="this.select()">
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

        $('#miad-scan-btn').on('click', function() {
            var $btn = $(this); $btn.attr('disabled', true).text('🩺 Scan en cours…');
            $.post(ajaxurl, { action: 'miad_r2_scan_links' }, function(res) {
                $btn.attr('disabled', false).text('🩺 Diagnostiquer les liens');
                if (!res.success) { alert('Erreur : ' + (res.data && res.data.message ? res.data.message : 'inconnue')); return; }
                var d = res.data;
                $('#miad-scan-box').show();
                $('#miad-scan-summary').html(
                    '<div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:10px;padding:12px;text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#16a34a">' + d.synced.toLocaleString() + '</div><div style="font-size:.75rem;color:#6b7280;font-weight:700;text-transform:uppercase">✅ Rattachées R2</div></div>' +
                    '<div style="background:#fffbeb;border:2px solid #b45309;border-radius:10px;padding:12px;text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#b45309">' + d.local.toLocaleString() + '</div><div style="font-size:.75rem;color:#6b7280;font-weight:700;text-transform:uppercase">📁 Encore en local</div></div>' +
                    '<div style="background:#fef2f2;border:2px solid #dc2626;border-radius:10px;padding:12px;text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#dc2626">' + d.broken.toLocaleString() + '</div><div style="font-size:.75rem;color:#6b7280;font-weight:700;text-transform:uppercase">❌ Liens cassés</div></div>'
                );
                if (d.synced_samples && d.synced_samples.length) {
                    var html2 = '<strong>Échantillon de liens rattachés (max 30) :</strong><br>';
                    d.synced_samples.forEach(function(s) { html2 += '#' + s.id + ' — ' + s.name + ' — ' + s.url + '<br>'; });
                    $('#miad-synced-samples').html(html2);
                } else {
                    $('#miad-synced-samples').html('<span style="color:#9ca3af">Aucun lien rattaché pour l\'instant.</span>');
                }
                if (d.samples.length) {
                    var html = '<strong>Échantillon de liens cassés (max 30) :</strong><br>';
                    d.samples.forEach(function(s) { html += '#' + s.id + ' — ' + s.name + ' — ' + s.url + '<br>'; });
                    $('#miad-scan-samples').html(html);
                } else {
                    $('#miad-scan-samples').html('<span style="color:#4ade80">Aucun lien cassé détecté 🎉</span>');
                }
            }).fail(function() {
                $btn.attr('disabled', false).text('🩺 Diagnostiquer les liens');
                alert('Erreur réseau pendant le scan.');
            });
        });

        $('#miad-heal-btn').on('click', function() {
            var $btn = $(this); $btn.attr('disabled', true);
            var totalHealed = 0, totalBroken = 0;
            function step() {
                $('#miad-heal-status').text('Rattachement en cours… (' + totalHealed + ' rattachées, ' + totalBroken + ' toujours cassées)');
                $.post(ajaxurl, { action: 'miad_r2_heal_batch' }, function(res) {
                    if (!res.success) { $('#miad-heal-status').text('❌ Erreur : ' + (res.data && res.data.message || 'inconnue')); $btn.attr('disabled', false); return; }
                    totalHealed += res.data.healed; totalBroken += res.data.still_broken;
                    if (res.data.status === 'FINISHED') {
                        $('#miad-heal-status').html('<strong style="color:#16a34a">✅ Terminé</strong> — ' + totalHealed + ' rattachées, ' + totalBroken + ' toujours cassées (à investiguer manuellement).');
                        $btn.attr('disabled', false);
                    } else {
                        setTimeout(step, 200);
                    }
                }).fail(function() {
                    $('#miad-heal-status').text('⌛ Latence serveur, reprise dans 3s…');
                    setTimeout(step, 3000);
                });
            }
            step();
        });

        $('#miad-check-products-btn').on('click', function() {
            var $btn = $(this); $btn.attr('disabled', true);
            var totalLinked = 0, totalUploaded = 0, totalFailed = 0;
            function step() {
                $('#miad-check-products-status').text('En cours… (' + totalLinked + ' liées direct, ' + totalUploaded + ' uploadées, ' + totalFailed + ' échecs)');
                $.post(ajaxurl, { action: 'miad_r2_check_products' }, function(res) {
                    if (!res.success) { $('#miad-check-products-status').text('❌ Erreur : ' + (res.data && res.data.message || 'inconnue')); $btn.attr('disabled', false); return; }
                    totalLinked += res.data.linked; totalUploaded += res.data.uploaded; totalFailed += res.data.failed;
                    if (res.data.status === 'FINISHED') {
                        $('#miad-check-products-status').html('<strong style="color:#16a34a">✅ Terminé</strong> — ' + totalLinked + ' liées directement (déjà sur R2), ' + totalUploaded + ' uploadées, ' + totalFailed + ' échecs.');
                        $btn.attr('disabled', false);
                    } else {
                        setTimeout(step, 200);
                    }
                }).fail(function() {
                    $('#miad-check-products-status').text('⌛ Latence serveur, reprise dans 3s…');
                    setTimeout(step, 3000);
                });
            }
            step();
        });

        $('#miad-check-name-btn').on('click', function() {
            var name = $('#miad-check-name-input').val().trim();
            if (!name) { alert('Entre un nom de fichier ou une URL.'); return; }
            var $btn = $(this); $btn.attr('disabled', true);
            $('#miad-check-name-result').text('⌛ Vérification…');
            $.post(ajaxurl, { action: 'miad_r2_check_by_name', name: name }, function(res) {
                $btn.attr('disabled', false);
                var d = res.data;
                if (res.success) {
                    $('#miad-check-name-result').html('<span style="color:#16a34a">✅ ' + d.state + (d.attachment_id ? ' (#' + d.attachment_id + ')' : '') + '</span> — ' + d.r2_url);
                } else {
                    $('#miad-check-name-result').html('<span style="color:#dc2626">❌ ' + (d && d.error || 'Erreur inconnue') + '</span>');
                }
            }).fail(function() {
                $btn.attr('disabled', false);
                $('#miad-check-name-result').html('<span style="color:#dc2626">❌ Erreur réseau</span>');
            });
        });

        $('#miad-check-product-btn').on('click', function() {
            var name = $('#miad-check-product-input').val().trim();
            if (!name) { alert('Entre le nom d\'un produit.'); return; }
            var $btn = $(this); $btn.attr('disabled', true);
            $('#miad-check-product-result').text('⌛ Recherche et vérification…');
            $.post(ajaxurl, { action: 'miad_r2_check_by_product', product_name: name }, function(res) {
                $btn.attr('disabled', false);
                var d = res.data;
                if (res.success) {
                    $('#miad-check-product-result').html(
                        '<span style="color:#16a34a">✅ "' + d.product_name + '" (#' + d.product_id + ')</span> — ' +
                        d.total_images + ' image(s) : ' + d.linked + ' liée(s) direct, ' + d.uploaded + ' uploadée(s), ' + d.failed + ' échec(s)'
                    );
                } else {
                    $('#miad-check-product-result').html('<span style="color:#dc2626">❌ ' + (d && d.error || 'Erreur inconnue') + '</span>');
                }
            }).fail(function() {
                $btn.attr('disabled', false);
                $('#miad-check-product-result').html('<span style="color:#dc2626">❌ Erreur réseau</span>');
            });
        });
    });
    </script>
    <?php
}