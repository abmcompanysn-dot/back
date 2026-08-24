<?php
/**
 * Plugin Name: MIAD JWT Config
 * Description: Définit JWT_AUTH_SECRET_KEY et JWT_AUTH_CORS_ENABLE si absents
 *              de wp-config.php — corrige le 403 "jwt_auth_bad_config".
 * Version: 1.0
 * Author: MIAD Market
 *
 * INSTALLATION : Code Snippets → coller ce fichier → Activer → "Run everywhere"
 *
 * POURQUOI : Le plugin JWT Authentication for WP REST API retourne 403 si
 *   JWT_AUTH_SECRET_KEY n'est pas défini dans wp-config.php.
 *   Ce snippet le définit automatiquement à partir de AUTH_SALT (déjà présent
 *   dans wp-config.php sur toutes les installations WordPress).
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// Définit la clé secrète JWT à partir du sel WordPress (unique par site)
if ( ! defined( 'JWT_AUTH_SECRET_KEY' ) ) {
    define( 'JWT_AUTH_SECRET_KEY', 'miad-jwt-' . ( defined( 'AUTH_SALT' ) ? md5( AUTH_SALT ) : md5( site_url() . 'miad2024' ) ) );
}

// Active le support CORS pour les requêtes cross-origin (Next.js ↔ WordPress)
if ( ! defined( 'JWT_AUTH_CORS_ENABLE' ) ) {
    define( 'JWT_AUTH_CORS_ENABLE', true );
}
