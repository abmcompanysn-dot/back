<?php
add_action('rest_api_init', function() {
    register_rest_route('miad/v1', '/order-notify/(?P<id>\d+)', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback' => function($request) {
            $oid   = intval($request->get_param('id'));
            $order = wc_get_order($oid);
            if (!$order) return rest_ensure_response(['ok'=>false,'error'=>'not found']);

            $email = $order->get_billing_email();
            if (!$email) return rest_ensure_response(['ok'=>false,'error'=>'no email']);

            $lock = 'miad_n_' . $oid;
            if (get_transient($lock)) return rest_ensure_response(['ok'=>true,'skip'=>true]);
            set_transient($lock, 1, 3600);

            $headers = array('Content-Type: text/html; charset=UTF-8');
            $num     = $order->get_order_number();
            $total   = html_entity_decode(wp_strip_all_tags($order->get_formatted_order_total()));
            $name    = $order->get_formatted_billing_full_name();
            $date    = '';
            $d       = $order->get_date_created();
            if ($d) { $date = $d->date_i18n('d/m/Y'); }

            $s    = get_option('miad_email_settings', array());
            $subj = isset($s['miad_order_received']['subject']) && $s['miad_order_received']['subject'] ? $s['miad_order_received']['subject'] : '📦 Commande #'.$num.' reçue — MIAD Market';
            $body = isset($s['miad_order_received']['body']) && $s['miad_order_received']['body'] ? $s['miad_order_received']['body'] : '<h2 style="color:#005826">Merci '.esc_html($name).' !</h2><p>Votre commande <strong>#'.$num.'</strong> du '.$date.' pour <strong>'.$total.'</strong> est enregistrée.</p>';

            $find    = array('{customer_name}','{order_number}','{order_date}','{order_total}');
            $replace = array($name,$num,$date,$total);
            $subj = str_replace($find,$replace,$subj);
            $body = str_replace($find,$replace,$body);

            $html = '<html><head><meta charset="UTF-8"></head><body style="background:#f0f0f0;font-family:Arial,sans-serif;padding:20px"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden"><div style="background:#005826;padding:24px;text-align:center"><h1 style="color:#fff;margin:0">MIAD MARKET</h1></div><div style="padding:32px">'.$body.'</div><div style="background:#005826;padding:16px;text-align:center;color:rgba(255,255,255,.7);font-size:12px">MIAD Market — L\'excellence africaine.</div></div></body></html>';

            $ok1 = wp_mail($email, $subj, $html, $headers);
            wp_mail(get_option('admin_email'), '🔔 Nouvelle commande #'.$num.' — '.$total, '<html><body style="font-family:Arial"><p>Commande <strong>#'.$num.'</strong> de '.esc_html($name).' — <strong>'.$total.'</strong></p></body></html>', $headers);

            return rest_ensure_response(array('ok'=>true,'email_sent'=>$ok1,'order'=>$num));
        },
        'args' => array('id' => array('type'=>'integer')),
    ]);
});
