<?php
/**
 * MIAD Market - PayDunya Payment Endpoint (Mode Manuel sans SDK)
 * Pour les serveurs sans accès SSH / Composer
 *
 * MODIFIÉ : return_url et cancel_url pointent maintenant vers le frontend
 * Next.js (miadmarket.com) au lieu de l'API WordPress (api.miadmarket.com).
 * callback_url reste sur l'API car c'est le webhook serveur-à-serveur PayDunya.
 */
add_action('rest_api_init', function () {
    register_rest_route('miad/v1', '/create-paydunya-payment', [
        'methods'             => 'POST',
        'callback'            => 'miad_create_paydunya_invoice',
        'permission_callback' => 'miad_paydunya_permission_check'
    ]);

    register_rest_route('miad/v1', '/confirm-paydunya-payment', [
        'methods'             => 'POST',
        'callback'            => 'miad_confirm_paydunya_payment',
        'permission_callback' => 'miad_paydunya_permission_check'
    ]);
});

function miad_paydunya_permission_check(WP_REST_Request $request) {
    // 1. Vérifier le secret partagé (Header envoyé par ton serveur Next.js)
    // Pas de valeur de repli codée en dur ici : ce serait alors le secret réel
    // pour toute la frontière de confiance Next.js <-> WordPress, visible par
    // quiconque a accès à ce dépôt (voir cotewordpress.php pour le même principe).
    $header_secret = $request->get_header('X-Headless-Secret');
    $internal_secret = defined('INTERNAL_API_SECRET') ? INTERNAL_API_SECRET : null;

    if ($internal_secret && $header_secret && $header_secret === $internal_secret) {
        return true;
    }

    // 2. Fallback : Autoriser si l'utilisateur est authentifié (via JWT)
    if (is_user_logged_in()) {
        return true;
    }

    return new WP_Error('rest_forbidden', 'Désolé, accès non autorisé au paiement.', ['status' => 403]);
}

function miad_create_paydunya_invoice(WP_REST_Request $request) {
    $params = $request->get_json_params();

    // S'assurer que les paramètres de base sont présents
    $amount = isset($params['amount']) ? floatval($params['amount']) : 0;
    $currency = isset($params['currency']) ? $params['currency'] : 'cad';
    $order_id = isset($params['order_id']) ? $params['order_id'] : null;

    if ($amount <= 0) {
        return new WP_Error('invalid_amount', 'Le montant de la commande PayDunya est invalide.', ['status' => 400]);
    }

    // 1. Récupération des réglages du plugin MIAD PayDunya
    $paydunya_config = get_option('woocommerce_paydunya_miad_settings');
    if (!$paydunya_config) {
        return new WP_Error('config_not_found', 'Réglages PayDunya introuvables.', ['status' => 500]);
    }

    $master_key  = trim($paydunya_config['master_key'] ?? '');
    $public_key  = trim($paydunya_config['public_key'] ?? '');
    $private_key = trim($paydunya_config['private_key'] ?? '');
    $token       = trim($paydunya_config['token'] ?? '');
    $mode        = $paydunya_config['mode'] ?? 'test';
    $taux        = !empty($paydunya_config['taux_cad']) ? (float)$paydunya_config['taux_cad'] : 445;

    if (empty($master_key) || empty($public_key) || empty($private_key) || empty($token)) {
        return new WP_Error('paydunya_config_error', "Clés API PayDunya incomplètes dans WooCommerce.", ['status' => 500]);
    }

    // 2. Conversion CAD -> XOF
    $total_xof = (strtolower($currency) === 'cad') ? round($amount * $taux) : round($amount);

    // 3. Préparation de l'URL et du Payload API
    $endpoint = ($mode === 'live')
        ? 'https://app.paydunya.com/api/v1/checkout-invoice/create'
        : 'https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create';

    // Domaine du frontend headless Next.js (sans "api.")
    $frontend_base = 'https://miadmarket.com';

    $payload = [
        'invoice' => [
            'total_amount' => $total_xof,
            'description'  => "Règlement commande #$order_id sur MIAD Market",
        ],
        'store' => [
            'name' => get_bloginfo('name'),
        ],
        'actions' => [
            'cancel_url'   => $frontend_base . '/checkout?order_id=' . $order_id . '&status=cancelled',
            'return_url'   => $frontend_base . '/order-received?order_id=' . $order_id,
            'callback_url' => WC()->api_request_url('WC_Gateway_PayDunya_MIAD') // IPN serveur-à-serveur : reste sur l'API
        ],
        'custom_data' => [
            'order_id' => $order_id,
            'source'   => 'MIAD-Headless-Front'
        ]
    ];

    // 4. Appel API Manuel (via wp_remote_post)
    $response = wp_remote_post($endpoint, [
        'headers' => [
            'Content-Type'         => 'application/json',
            'PAYDUNYA-MASTER-KEY'  => $master_key,
            'PAYDUNYA-PUBLIC-KEY'  => $public_key,
            'PAYDUNYA-PRIVATE-KEY' => $private_key,
            'PAYDUNYA-TOKEN'       => $token,
        ],
        'body'    => json_encode($payload),
        'timeout' => 45,
    ]);

    if (is_wp_error($response)) {
        return new WP_Error('paydunya_error', $response->get_error_message(), ['status' => 500]);
    }

    $body = json_decode(wp_remote_retrieve_body($response), true);

    if (isset($body['response_code']) && $body['response_code'] === '00') {
        // Enregistre le montant XOF attendu sur la commande pour que
        // miad_confirm_paydunya_payment puisse le comparer au montant
        // réellement payé (empêche de confirmer une commande à partir
        // d'une facture créée/payée pour un montant inférieur).
        if ($order_id) {
            $order = wc_get_order($order_id);
            if ($order) {
                $order->update_meta_data('_paydunya_expected_xof', $total_xof);
                $order->save();
            }
        }

        return new WP_REST_Response([
            'success'       => true,
            'paydunyaToken' => $body['token'],
            'paydunyaUrl'   => $body['response_text'], // L'URL de paiement est ici
            'orderId'       => $order_id
        ], 200);
    }

    return new WP_Error('paydunya_fail', $body['response_text'] ?? 'Échec PayDunya', ['status' => 400]);
}

/**
 * Confirme le statut d'une facture PayDunya (appelé depuis la page /order-received
 * du front Next.js juste après le retour de l'acheteur) et marque la commande
 * WooCommerce comme payée si — et seulement si — PayDunya confirme le paiement.
 */
function miad_confirm_paydunya_payment(WP_REST_Request $request) {
    $params   = $request->get_json_params();
    $token    = isset($params['token']) ? trim($params['token']) : '';
    $order_id = isset($params['order_id']) ? absint($params['order_id']) : 0;

    if (empty($token)) {
        return new WP_Error('invalid_token', 'Token PayDunya manquant.', ['status' => 400]);
    }

    $paydunya_config = get_option('woocommerce_paydunya_miad_settings');
    if (!$paydunya_config) {
        return new WP_Error('config_not_found', 'Réglages PayDunya introuvables.', ['status' => 500]);
    }

    $master_key  = trim($paydunya_config['master_key'] ?? '');
    $public_key  = trim($paydunya_config['public_key'] ?? '');
    $private_key = trim($paydunya_config['private_key'] ?? '');
    $api_token   = trim($paydunya_config['token'] ?? '');
    $mode        = $paydunya_config['mode'] ?? 'test';

    if (empty($master_key) || empty($public_key) || empty($private_key) || empty($api_token)) {
        return new WP_Error('paydunya_config_error', 'Clés API PayDunya incomplètes dans WooCommerce.', ['status' => 500]);
    }

    $endpoint = ($mode === 'live')
        ? "https://app.paydunya.com/api/v1/checkout-invoice/confirm/$token"
        : "https://app.paydunya.com/sandbox-api/v1/checkout-invoice/confirm/$token";

    $response = wp_remote_get($endpoint, [
        'headers' => [
            'Content-Type'         => 'application/json',
            'PAYDUNYA-MASTER-KEY'  => $master_key,
            'PAYDUNYA-PUBLIC-KEY'  => $public_key,
            'PAYDUNYA-PRIVATE-KEY' => $private_key,
            'PAYDUNYA-TOKEN'       => $api_token,
        ],
        'timeout' => 45,
    ]);

    if (is_wp_error($response)) {
        return new WP_Error('paydunya_error', $response->get_error_message(), ['status' => 500]);
    }

    $body = json_decode(wp_remote_retrieve_body($response), true);
    $status = $body['status'] ?? null; // 'completed' | 'pending' | 'cancelled'

    // Sécurité : le order_id transmis par le front doit correspondre à celui
    // enregistré côté PayDunya lors de la création de la facture (custom_data).
    $invoice_order_id = absint($body['custom_data']['order_id'] ?? 0);
    if ($order_id && $invoice_order_id && $order_id !== $invoice_order_id) {
        return new WP_Error('order_mismatch', 'Ce token ne correspond pas à cette commande.', ['status' => 403]);
    }

    $final_order_id = $invoice_order_id ?: $order_id;
    $order = $final_order_id ? wc_get_order($final_order_id) : null;

    // Sécurité : le montant réellement facturé/payé sur PayDunya doit
    // correspondre au montant XOF calculé lors de la création de la facture
    // (stocké en meta) — empêche de confirmer le paiement complet d'une
    // commande à partir d'une facture créée puis payée pour un montant moindre.
    if ($status === 'completed' && $order) {
        $expected_xof = $order->get_meta('_paydunya_expected_xof');
        $paid_xof     = isset($body['invoice']['total_amount']) ? (float) $body['invoice']['total_amount'] : null;

        if ($expected_xof !== '' && $expected_xof !== null && $paid_xof !== null) {
            if (abs($paid_xof - (float) $expected_xof) > 1) { // tolérance d'arrondi de 1 XOF
                return new WP_Error(
                    'amount_mismatch',
                    'Le montant payé ne correspond pas au montant attendu pour cette commande.',
                    ['status' => 403]
                );
            }
        }
    }

    if ($status === 'completed') {
        if ($order && !$order->is_paid()) {
            $order->payment_complete($token);
            $order->add_order_note("Paiement PayDunya confirmé (token: $token).");
        }
        return new WP_REST_Response([
            'success'  => true,
            'status'   => 'completed',
            'orderId'  => $final_order_id,
            'total'    => $order ? $order->get_total() : null,
        ], 200);
    }

    if ($status === 'pending') {
        return new WP_REST_Response([
            'success' => false,
            'status'  => 'pending',
            'orderId' => $final_order_id,
        ], 200);
    }

    return new WP_REST_Response([
        'success' => false,
        'status'  => $status ?? 'cancelled',
        'orderId' => $final_order_id,
    ], 200);
}
