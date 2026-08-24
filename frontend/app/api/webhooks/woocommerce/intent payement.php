/**
 * MIAD Market - Stripe Payment Intent Endpoint (Optimisé)
 *
 * Contient aussi /confirm-stripe-order : vérifie un payment_intent et marque
 * la commande WooCommerce comme payée — appelé par Next.js après le retour
 * navigateur Stripe (return_url) via le secret partagé X-Headless-Secret.
 */
add_action('rest_api_init', function () {
    register_rest_route('miad/v1', '/create-payment-intent', [
        'methods'             => 'POST',
        'callback'            => 'miad_create_stripe_payment_intent',
        'permission_callback' => function (WP_REST_Request $request) {
            // 1. Vérifier le secret partagé (Header envoyé par ton serveur Next.js)
            $header_secret = $request->get_header('X-Headless-Secret');
            $internal_secret = defined('INTERNAL_API_SECRET') ? INTERNAL_API_SECRET : null; // secret obligatoire, doit etre defini dans wp-config.php
            
            if ($header_secret && $header_secret === $internal_secret) {
                return true;
            }
            
            // 2. Fallback : Autoriser si l'utilisateur est authentifié (via JWT)
            if (is_user_logged_in()) {
                return true;
            }

            return new WP_Error('rest_forbidden', 'Désolé, accès non autorisé au paiement.', ['status' => 403]);
        }
    ]);
});

/**
 * Résout la clé secrète Stripe (wp-config.php, sinon réglages du plugin
 * WooCommerce Stripe) — factorisé car dupliqué dans create-payment-intent
 * et confirm-stripe-order avant ce refactor.
 */
function miad_get_stripe_secret_key(): string {
    $sk = defined('STRIPE_SECRET_KEY') ? trim(STRIPE_SECRET_KEY) : '';
    if (empty($sk)) {
        $stripe_settings = get_option('woocommerce_stripe_settings');
        if (!empty($stripe_settings)) {
            $is_test_mode = isset($stripe_settings['testmode']) && 'yes' === $stripe_settings['testmode'];
            $sk = $is_test_mode ? ($stripe_settings['test_secret_key'] ?? '') : ($stripe_settings['secret_key'] ?? '');
        }
    }
    return $sk;
}

/**
 * Récupère le Stripe Customer d'un utilisateur MIAD (créé au premier
 * enregistrement de carte), ou le crée s'il n'existe pas encore. Stocké en
 * user meta WordPress (_miad_stripe_customer_id) — jamais dans wc/v3/customers
 * meta_data, qu'app/api/customer/route.ts relaie déjà assez brut au navigateur.
 *
 * Verrou transient best-effort contre la double-création en cas de double
 * soumission quasi simultanée (pas de verrou distribué disponible sur cet
 * hébergement sans D1/KV — ce n'est qu'une réduction de risque, pas une garantie).
 */
function miad_get_or_create_stripe_customer(int $user_id, string $email): ?string {
    $existing = get_user_meta($user_id, '_miad_stripe_customer_id', true);
    if ($existing) return $existing;

    $lock_key = 'miad_stripe_cust_lock_' . $user_id;
    if (get_transient($lock_key)) {
        usleep(300000);
        $existing = get_user_meta($user_id, '_miad_stripe_customer_id', true);
        if ($existing) return $existing;
    }
    set_transient($lock_key, 1, 10);

    $existing = get_user_meta($user_id, '_miad_stripe_customer_id', true);
    if ($existing) { delete_transient($lock_key); return $existing; }

    try {
        $customer = \Stripe\Customer::create([
            'email'    => $email,
            'metadata' => ['wp_user_id' => $user_id, 'source' => 'MIAD-Headless-Front'],
        ]);
        update_user_meta($user_id, '_miad_stripe_customer_id', $customer->id);
        delete_transient($lock_key);
        return $customer->id;
    } catch (Exception $e) {
        delete_transient($lock_key);
        return null;
    }
}

function miad_create_stripe_payment_intent(WP_REST_Request $request) {
    $params = $request->get_json_params();

    // S'assurer que le montant est présent et correct (Stripe veut des centimes)
    $amount = isset($params['amount']) ? floatval($params['amount']) : 0;
    $currency = isset($params['currency']) ? $params['currency'] : 'usd';
    $order_id = isset($params['order_id']) ? $params['order_id'] : null;
    $email = isset($params['email']) ? $params['email'] : '';
    $user_id = isset($params['user_id']) ? intval($params['user_id']) : 0;
    $save_payment_method = ! empty($params['savePaymentMethod']);
    $payment_method_id = isset($params['paymentMethodId']) ? sanitize_text_field($params['paymentMethodId']) : '';

    if ($amount <= 0) {
        return new WP_Error('invalid_amount', 'Le montant de la commande est invalide.', ['status' => 400]);
    }

    if ($save_payment_method && $payment_method_id) {
        return new WP_Error('invalid_params', 'savePaymentMethod et paymentMethodId sont mutuellement exclusifs.', ['status' => 400]);
    }

    if (!class_exists('\Stripe\Stripe')) {
        return new WP_Error('stripe_missing', 'Stripe PHP SDK non installé via Composer', ['status' => 500]);
    }

    $sk = miad_get_stripe_secret_key();
    if (empty($sk) || strpos($sk, 'VOTRE_CLE') !== false) {
        return new WP_Error('stripe_config_error', 'La clé secrète Stripe est introuvable. Vérifiez les réglages Stripe dans WooCommerce.', ['status' => 500]);
    }

    \Stripe\Stripe::setApiKey($sk);

    // Carte enregistrée : résout le Stripe Customer et NE crée jamais de
    // nouveau customer ici (seul savePaymentMethod peut en créer un) —
    // si l'utilisateur n'a pas encore de customer, payer avec un
    // paymentMethodId n'a de toute façon aucun sens.
    $customer_id = null;
    if ($user_id && ($save_payment_method || $payment_method_id)) {
        $customer_id = $save_payment_method
            ? miad_get_or_create_stripe_customer($user_id, $email)
            : get_user_meta($user_id, '_miad_stripe_customer_id', true);

        if ($payment_method_id) {
            if (! $customer_id) {
                return new WP_Error('no_customer', 'Aucun compte de paiement enregistré pour cet utilisateur.', ['status' => 404]);
            }
            try {
                $pm = \Stripe\PaymentMethod::retrieve($payment_method_id);
            } catch (Exception $e) {
                return new WP_Error('stripe_error', $e->getMessage(), ['status' => 500]);
            }
            // Empêche un client d'utiliser la carte enregistrée de quelqu'un
            // d'autre en devinant/rejouant un paymentMethodId.
            if (! $pm->customer || $pm->customer !== $customer_id) {
                return new WP_Error('forbidden', 'Cette carte ne vous appartient pas.', ['status' => 403]);
            }
        }
    }

    try {
        $intent_params = [
            'amount' => round($amount * 100),
            'currency' => strtolower($currency),
            'metadata' => [
                'order_id' => $order_id,
                'source' => 'MIAD-Headless-Front'
            ],
            'receipt_email' => $email,
        ];

        if ($payment_method_id) {
            // Carte déjà enregistrée : on attache customer + payment_method,
            // mais on ne confirme PAS ici (pas de confirm=true) — c'est
            // stripe.confirmCardPayment() côté client qui confirme, pour que
            // Stripe.js gère nativement un éventuel 3D Secure (next_action).
            $intent_params['customer'] = $customer_id;
            $intent_params['payment_method'] = $payment_method_id;
        } elseif ($save_payment_method && $customer_id) {
            $intent_params['customer'] = $customer_id;
            // on_session (pas off_session) : le client est toujours présent
            // au moment du paiement, c'est la recommandation Stripe pour ce cas.
            $intent_params['setup_future_usage'] = 'on_session';
            $intent_params['automatic_payment_methods'] = ['enabled' => true];
        } else {
            // Comportement historique inchangé (invité, ou pas de sauvegarde demandée).
            $intent_params['automatic_payment_methods'] = ['enabled' => true];
        }

        $paymentIntent = \Stripe\PaymentIntent::create(
            $intent_params,
            $order_id ? ['idempotency_key' => 'pi_order_' . $order_id] : []
        );

        // Stocker l'ID du payment intent sur la commande WC pour que le webhook
        // Stripe du plugin WooCommerce Stripe puisse retrouver la commande quand
        // il reçoit l'événement payment_intent.succeeded côté serveur.
        if ($order_id) {
            $order = wc_get_order(intval($order_id));
            if ($order) {
                $order->update_meta_data('_stripe_intent_id', $paymentIntent->id);
                $order->set_transaction_id($paymentIntent->id);
                $order->save();
            }
        }

        return new WP_REST_Response([
            'success' => true,
            'clientSecret' => $paymentIntent->client_secret,
            'id' => $paymentIntent->id,
            'orderId' => $order_id
        ], 200);

    } catch (Exception $e) {
        return new WP_Error('stripe_error', $e->getMessage(), ['status' => 500]);
    }
}

// ---------------------------------------------------------------------------
// /confirm-stripe-order — vérification côté serveur + mise à jour WC
// Appelé par Next.js après le retour navigateur Stripe (jamais côté client).
// ---------------------------------------------------------------------------
add_action('rest_api_init', function () {
    register_rest_route('miad/v1', '/confirm-stripe-order', [
        'methods'             => 'POST',
        'callback'            => 'miad_confirm_stripe_order',
        'permission_callback' => function (WP_REST_Request $request) {
            $header_secret   = $request->get_header('X-Headless-Secret');
            $internal_secret = defined('INTERNAL_API_SECRET') ? INTERNAL_API_SECRET : null;
            if ($header_secret && $internal_secret && $header_secret === $internal_secret) {
                return true;
            }
            return new WP_Error('rest_forbidden', 'Accès non autorisé.', ['status' => 403]);
        },
    ]);
});

function miad_confirm_stripe_order(WP_REST_Request $request) {
    $params            = $request->get_json_params();
    $payment_intent_id = isset($params['payment_intent_id']) ? sanitize_text_field($params['payment_intent_id']) : '';
    $order_id          = isset($params['order_id'])          ? intval($params['order_id'])                        : 0;

    if (!$payment_intent_id || !$order_id) {
        return new WP_Error('missing_params', 'payment_intent_id et order_id sont requis.', ['status' => 400]);
    }

    // Récupérer la clé secrète Stripe (même logique que create-payment-intent)
    $sk = miad_get_stripe_secret_key();
    if (empty($sk)) {
        return new WP_Error('stripe_config_error', 'Clé secrète Stripe introuvable.', ['status' => 500]);
    }

    // Vérifier le payment intent auprès de Stripe (serveur → serveur, jamais exposé au client)
    // expand[]=payment_method : récupère la marque/les 4 derniers chiffres de la
    // carte utilisée en un seul appel (pour affichage dans le dashboard client),
    // au lieu d'un second appel séparé à /v1/payment_methods/{id}.
    $stripe_response = wp_remote_get(
        'https://api.stripe.com/v1/payment_intents/' . $payment_intent_id . '?expand[]=payment_method',
        ['headers' => ['Authorization' => 'Bearer ' . $sk], 'timeout' => 15]
    );
    if (is_wp_error($stripe_response)) {
        return new WP_Error('stripe_unreachable', 'Impossible de contacter Stripe.', ['status' => 502]);
    }
    $intent = json_decode(wp_remote_retrieve_body($stripe_response), true);

    if (empty($intent['status']) || $intent['status'] !== 'succeeded') {
        return new WP_Error('not_paid', 'Le paiement Stripe n\'est pas confirmé.', ['status' => 402]);
    }

    // Vérification de sécurité : le metadata.order_id doit correspondre
    $meta_order_id = isset($intent['metadata']['order_id']) ? intval($intent['metadata']['order_id']) : 0;
    if ($meta_order_id !== $order_id) {
        return new WP_Error('order_mismatch', 'Ce paiement ne correspond pas à cette commande.', ['status' => 403]);
    }

    // Mettre à jour la commande WooCommerce
    $order = wc_get_order($order_id);
    if (!$order) {
        return new WP_Error('order_not_found', 'Commande introuvable.', ['status' => 404]);
    }

    // Idempotent : ne re-marquer que si pas encore payée
    if (!in_array($order->get_status(), ['processing', 'completed'], true)) {
        $order->payment_complete($payment_intent_id);
        $order->update_meta_data('_stripe_intent_id', $payment_intent_id);

        // Marque/4 derniers chiffres de la carte utilisée — affiché dans le
        // dashboard client ("Mes commandes"), à côté de chaque commande payée
        // par carte. $intent['payment_method'] est un objet complet grâce à
        // expand[]=payment_method plus haut (pas juste un ID).
        $card = $intent['payment_method']['card'] ?? null;
        if ($card) {
            $order->update_meta_data('_stripe_card_brand', sanitize_text_field($card['brand'] ?? ''));
            $order->update_meta_data('_stripe_card_last4', sanitize_text_field($card['last4'] ?? ''));
        }

        $order->save();
    }

    return new WP_REST_Response([
        'success'  => true,
        'orderId'  => $order_id,
        'status'   => $order->get_status(),
    ], 200);
}

/**
 * Permission callback partagé pour les routes de cartes enregistrées :
 * secret partagé UNIQUEMENT (pas de fallback is_user_logged_in comme sur
 * create-payment-intent) — ce sont des appels serveur-à-serveur internes
 * depuis Next.js, qui a déjà résolu et vérifié l'identité de l'appelant via
 * fetchWpUser() avant d'envoyer le user_id ici. Ne jamais faire confiance à
 * un user_id fourni directement par un navigateur.
 */
function miad_headless_secret_only_check(WP_REST_Request $request) {
    $header_secret   = $request->get_header('X-Headless-Secret');
    $internal_secret = defined('INTERNAL_API_SECRET') ? INTERNAL_API_SECRET : null;
    if ($header_secret && $internal_secret && $header_secret === $internal_secret) {
        return true;
    }
    return new WP_Error('rest_forbidden', 'Accès non autorisé.', ['status' => 403]);
}

// ---------------------------------------------------------------------------
// /stripe-payment-methods — liste les cartes enregistrées d'un utilisateur.
// ---------------------------------------------------------------------------
add_action('rest_api_init', function () {
    register_rest_route('miad/v1', '/stripe-payment-methods', [
        'methods'             => 'GET',
        'callback'            => 'miad_list_stripe_payment_methods',
        'permission_callback' => 'miad_headless_secret_only_check',
    ]);
});

function miad_list_stripe_payment_methods(WP_REST_Request $request) {
    $user_id = intval($request->get_param('user_id'));
    if (!$user_id) {
        return new WP_Error('missing_user', 'user_id requis.', ['status' => 400]);
    }

    $customer_id = get_user_meta($user_id, '_miad_stripe_customer_id', true);
    if (!$customer_id) {
        // Pas encore de customer Stripe pour cet utilisateur : pas la peine
        // d'appeler Stripe, la réponse est nécessairement vide.
        return new WP_REST_Response(['success' => true, 'paymentMethods' => []], 200);
    }

    if (!class_exists('\Stripe\Stripe')) {
        return new WP_Error('stripe_missing', 'Stripe PHP SDK non installé via Composer', ['status' => 500]);
    }
    $sk = miad_get_stripe_secret_key();
    if (empty($sk)) {
        return new WP_Error('stripe_config_error', 'Clé secrète Stripe introuvable.', ['status' => 500]);
    }
    \Stripe\Stripe::setApiKey($sk);

    try {
        $pms = \Stripe\PaymentMethod::all(['customer' => $customer_id, 'type' => 'card']);
    } catch (Exception $e) {
        return new WP_Error('stripe_error', $e->getMessage(), ['status' => 500]);
    }

    $out = array_map(function ($pm) {
        return [
            'id'       => $pm->id,
            'brand'    => $pm->card->brand,
            'last4'    => $pm->card->last4,
            'expMonth' => $pm->card->exp_month,
            'expYear'  => $pm->card->exp_year,
        ];
    }, $pms->data);

    return new WP_REST_Response(['success' => true, 'paymentMethods' => $out], 200);
}

// ---------------------------------------------------------------------------
// /stripe-payment-methods/detach — supprime une carte enregistrée. POST
// plutôt que DELETE pour rester cohérent avec le reste de ce fichier (et le
// reste du dépôt, cf. /rep-acknowledge, /confirm-stripe-order) et éviter tout
// souci de proxy/WAF filtrant sur le verbe HTTP.
// ---------------------------------------------------------------------------
add_action('rest_api_init', function () {
    register_rest_route('miad/v1', '/stripe-payment-methods/detach', [
        'methods'             => 'POST',
        'callback'            => 'miad_detach_stripe_payment_method',
        'permission_callback' => 'miad_headless_secret_only_check',
    ]);
});

function miad_detach_stripe_payment_method(WP_REST_Request $request) {
    $params  = $request->get_json_params();
    $user_id = isset($params['user_id']) ? intval($params['user_id']) : 0;
    $pm_id   = isset($params['paymentMethodId']) ? sanitize_text_field($params['paymentMethodId']) : '';

    if (!$user_id || !$pm_id) {
        return new WP_Error('missing_params', 'user_id et paymentMethodId sont requis.', ['status' => 400]);
    }

    $customer_id = get_user_meta($user_id, '_miad_stripe_customer_id', true);
    if (!$customer_id) {
        return new WP_Error('no_customer', 'Aucun compte de paiement enregistré pour cet utilisateur.', ['status' => 404]);
    }

    if (!class_exists('\Stripe\Stripe')) {
        return new WP_Error('stripe_missing', 'Stripe PHP SDK non installé via Composer', ['status' => 500]);
    }
    $sk = miad_get_stripe_secret_key();
    if (empty($sk)) {
        return new WP_Error('stripe_config_error', 'Clé secrète Stripe introuvable.', ['status' => 500]);
    }
    \Stripe\Stripe::setApiKey($sk);

    try {
        $pm = \Stripe\PaymentMethod::retrieve($pm_id);
    } catch (Exception $e) {
        return new WP_Error('stripe_error', $e->getMessage(), ['status' => 500]);
    }

    // Vérification d'appartenance — empêche de détacher la carte de
    // quelqu'un d'autre en devinant/rejouant un paymentMethodId.
    if (!$pm->customer || $pm->customer !== $customer_id) {
        return new WP_Error('forbidden', 'Cette carte ne vous appartient pas.', ['status' => 403]);
    }

    try {
        $pm->detach();
    } catch (Exception $e) {
        return new WP_Error('stripe_error', $e->getMessage(), ['status' => 500]);
    }

    return new WP_REST_Response(['success' => true], 200);
}
