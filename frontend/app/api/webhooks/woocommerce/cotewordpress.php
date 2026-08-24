<?php
// Configuration de la passerelle MIAD
// On définit ici la liste des sites qui doivent recevoir les mises à jour
const MIAD_SYNC_URLS = [
    'https://miadmarket.abmcy.com/api/webhooks/woocommerce',
    'https://miadmarket.ca/api/webhooks/woocommerce'
];
// Le secret doit etre defini dans wp-config.php (define('INTERNAL_API_SECRET', '...'))
// AVANT que ce snippet ne s'execute. Ne jamais remettre de valeur en dur ici :
// elle servirait alors de secret reel pour toute la frontiere de confiance
// Next.js <-> WordPress, visible par quiconque a acces a ce depot.
if (!defined('INTERNAL_API_SECRET')) {
    error_log('[MIAD] INTERNAL_API_SECRET non defini dans wp-config.php — synchro produit desactivee');
    return;
}

/**
 * Envoie automatiquement les données du produit à Next.js lors de la sauvegarde
 */
add_action('woocommerce_update_product', 'miad_sync_product_to_nextjs', 10, 1);
function miad_sync_product_to_nextjs($product_id) {
    $product = wc_get_product($product_id);
    if (!$product) return;

    // Préparation des données de base
    $data = [
        'id'           => $product->get_id(),
        'name'         => $product->get_name(),
        'slug'         => $product->get_slug(),
        'description'  => $product->get_description(),
        'short_desc'   => $product->get_short_description(),
        'type'         => $product->get_type(),
        'status'       => $product->get_status(),
        'price'        => $product->get_price(),
        'regular_price'=> $product->get_regular_price(),
        'sku'          => $product->get_sku(),
        'stock_status' => $product->get_stock_status(),
        'stock_qty'    => $product->get_stock_quantity(),
        'image'        => wp_get_attachment_url($product->get_image_id()),
        'gallery'      => array_map(function($img_id) { 
            return wp_get_attachment_url($img_id); 
        }, $product->get_gallery_image_ids()),
        'categories'   => array_map(function($term) {
            return ['id' => $term->term_id, 'name' => $term->name, 'slug' => $term->slug];
        }, get_the_terms($product_id, 'product_cat') ?: []),
        'lang'         => function_exists('pll_get_post_language') ? pll_get_post_language($product_id) : 'fr',
        'variations'   => [],
        'attributes'   => array_map(function($attr) {
            return [
                'name' => $attr->get_name(),
                'options' => $attr->get_options(),
                'visible' => $attr->get_visible(),
                'variation' => $attr->get_variation()
            ];
        }, $product->get_attributes()),
        'vendor_id'    => get_post_field('post_author', $product_id), // Pour Dokan
        'action'       => 'product.updated'
    ];

    // Si c'est un produit variable, on récupère TOUTES les variations
    if ($product->is_type('variable')) {
        $variation_ids = $product->get_children();
        foreach ($variation_ids as $v_id) {
            $variation = wc_get_product($v_id);
            $data['variations'][] = [
                'id'         => $v_id,
                'sku'        => $variation->get_sku(),
                'price'      => $variation->get_price(),
                'stock'      => $variation->get_stock_status(),
                'attributes' => $variation->get_attributes(),
            ];
        }
    }

    // Envoi de la requête vers chaque destination configurée
    foreach (MIAD_SYNC_URLS as $url) {
        wp_remote_post($url, [
            'headers' => [
                'Content-Type'      => 'application/json',
                'X-Headless-Secret' => INTERNAL_API_SECRET,
                'X-WC-Webhook-Topic'=> 'product.updated'
            ],
            'body'    => json_encode($data),
            'timeout' => 15,
            'blocking' => false, // On ne bloque pas WordPress si un site est lent
        ]);
    }
}
