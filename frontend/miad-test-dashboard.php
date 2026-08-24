<?php
/**
 * Plugin Name: MIAD Test Dashboard
 * Description: Panneau de test complet — commandes, OTP, représentants, DHL, logistique.
 * Version:     2.0.0
 * Author:      MIAD Market
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ═══════════════════════════════════════════════════════════════════
// MENUS
// ═══════════════════════════════════════════════════════════════════

add_action( 'admin_menu', function () {
    add_menu_page( 'MIAD Test', '🧪 MIAD Test', 'manage_options', 'miad-test', 'miad_page_dashboard', 'dashicons-chart-bar', 3 );
    add_submenu_page( 'miad-test', 'Dashboard',      'Dashboard',      'manage_options', 'miad-test',          'miad_page_dashboard' );
    add_submenu_page( 'miad-test', 'Flux Achat',     'Flux Achat',     'manage_options', 'miad-test-checkout', 'miad_page_checkout' );
    add_submenu_page( 'miad-test', 'Commandes',      'Commandes',      'manage_options', 'miad-test-orders',   'miad_page_orders' );
    add_submenu_page( 'miad-test', 'OTP & Emails',   'OTP & Emails',   'manage_options', 'miad-test-otp',      'miad_page_otp' );
    add_submenu_page( 'miad-test', 'Representants',  'Representants',  'manage_options', 'miad-test-rep',      'miad_page_rep' );
    add_submenu_page( 'miad-test', 'DHL Logistique', 'DHL Logistique', 'manage_options', 'miad-test-dhl',      'miad_page_dhl' );
    add_submenu_page( 'miad-test', 'Health Check',   'Health Check',   'manage_options', 'miad-test-health',   'miad_page_health' );
} );

// ═══════════════════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════════════════

add_action( 'admin_head', function () {
    $s = get_current_screen();
    if ( ! $s || strpos( $s->id, 'miad-test' ) === false ) return;
    echo '<style>
    #wpcontent{background:#f0f2f5}
    .mw{max-width:1100px;margin:20px auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .mh h1{font-size:20px;font-weight:900;letter-spacing:-.5px;color:#1a1a2e;margin:0 0 4px}
    .mh p{font-size:12px;color:#666;margin:0 0 22px}
    .mgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .mgrid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
    .mc{background:#fff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden;margin-bottom:16px}
    .mch{padding:12px 18px;border-bottom:1px solid #f0f0f0;background:#fafafa}
    .mch h2{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin:0;color:#374151}
    .mcb{padding:18px}
    .mb{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700}
    .mb.ok{background:#d1fae5;color:#065f46}
    .mb.err{background:#fee2e2;color:#991b1b}
    .mb.warn{background:#fef3c7;color:#92400e}
    .mb.info{background:#dbeafe;color:#1e40af}
    .mb.pur{background:#ede9fe;color:#5b21b6}
    .mr{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f3f4f6;font-size:13px}
    .mr:last-child{border-bottom:none}
    .mr .lb{font-weight:600;color:#374151}
    .mr .vl{color:#111;font-family:monospace;font-size:12px;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mbtn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;text-decoration:none}
    .mbtn:hover{opacity:.85}.mbtn.p{background:#7c3aed;color:#fff}.mbtn.g{background:#f3f4f6;color:#374151}
    .mbtn.t{background:#0d9488;color:#fff}.mbtn.b{background:#2563eb;color:#fff}
    .mi{width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;box-sizing:border-box}
    .mi:focus{outline:none;border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.12)}
    .mn{padding:12px 16px;border-radius:10px;font-size:13px;font-weight:600;margin-bottom:16px}
    .mn.s{background:#d1fae5;color:#065f46;border:1px solid #6ee7b7}
    .mn.e{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
    .mn.i{background:#dbeafe;color:#1e40af;border:1px solid #93c5fd}
    table.mt{width:100%;border-collapse:collapse;font-size:13px}
    table.mt th{text-align:left;padding:8px 12px;background:#f9fafb;color:#6b7280;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #e5e7eb}
    table.mt td{padding:9px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle}
    table.mt tr:last-child td{border-bottom:none}
    .lb2{font-size:12px;font-weight:700;display:block;margin-bottom:5px;color:#374151}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .fil{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
    </style>';
} );

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function miad_url()  { return rtrim( get_option('siteurl','https://api.miadmarket.com'), '/' ); }
function miad_keys() { return ['ck'=>get_option('miad_ck',''),'cs'=>get_option('miad_cs','')]; }

function miad_woo( $ep, $method='GET', $body=null ) {
    $k   = miad_keys();
    $sep = strpos($ep,'?')!==false?'&':'?';
    $url = miad_url().'/wp-json/wc/v3/'.ltrim($ep,'/').$sep."consumer_key={$k['ck']}&consumer_secret={$k['cs']}";
    $args= ['method'=>$method,'timeout'=>15,'sslverify'=>false];
    if ($body){$args['headers']=['Content-Type'=>'application/json'];$args['body']=json_encode($body);}
    $r = wp_remote_request($url,$args);
    return is_wp_error($r)?['code'=>0,'body'=>null,'error'=>$r->get_error_message()]:['code'=>wp_remote_retrieve_response_code($r),'body'=>json_decode(wp_remote_retrieve_body($r),true)];
}

function miad_api( $ep, $method='GET', $body=null ) {
    $url = miad_url().'/wp-json/'.ltrim($ep,'/');
    $args= ['method'=>$method,'timeout'=>15,'sslverify'=>false,'headers'=>['Content-Type'=>'application/json']];
    if ($body) $args['body']=json_encode($body);
    $r = wp_remote_request($url,$args);
    return is_wp_error($r)?['code'=>0,'body'=>null,'error'=>$r->get_error_message()]:['code'=>wp_remote_retrieve_response_code($r),'body'=>json_decode(wp_remote_retrieve_body($r),true)];
}

function mbd($cls,$txt){ echo '<span class="mb '.esc_attr($cls).'">'.esc_html($txt).'</span>'; }

function mst($st){
    $m=['completed'=>'ok','processing'=>'info','pending'=>'warn','on-hold'=>'warn','cancelled'=>'err','refunded'=>'pur','shipped'=>'info'];
    mbd($m[$st]??'info',$st);
}

function mhead($t,$s=''){
    echo '<div class="mh"><h1>'.esc_html($t).'</h1>'.($s?'<p>'.esc_html($s).'</p>':'').'</div>';
}

// ═══════════════════════════════════════════════════════════════════
// PAGE 1 — DASHBOARD
// ═══════════════════════════════════════════════════════════════════

function miad_page_dashboard(){
    if(!current_user_can('manage_options'))wp_die('Accès refusé');
    if(isset($_POST['save_keys'])&&check_admin_referer('miad_cfg')){
        update_option('miad_ck',sanitize_text_field($_POST['miad_ck']??''));
        update_option('miad_cs',sanitize_text_field($_POST['miad_cs']??''));
        echo '<div class="mn s">Cles sauvegardees.</div>';
    }
    $u=wp_get_current_user();$k=miad_keys();
    $op=miad_woo('orders?per_page=1');$pp=miad_woo('products?per_page=1&status=publish');$cp=miad_woo('customers?per_page=1');
    echo '<div class="mw">';
    mhead('MIAD Test Dashboard','Supervision complete · '.date('d/m/Y H:i'));
    echo '<div class="mgrid3">';
    foreach([
        ['Commandes',isset($op['body'])&&is_array($op['body'])?'OK':'—',$op['code']==200?'ok':'err'],
        ['Produits',isset($pp['body'])&&is_array($pp['body'])&&count($pp['body'])>0?'Disponibles':'—',$pp['code']==200?'ok':'err'],
        ['API Clients',$cp['code']==200?'OK':'Cles manquantes',$cp['code']==200?'ok':'err'],
    ] as [$lbl,$val,$cls]){
        echo '<div class="mc"><div class="mcb" style="text-align:center;padding:20px">';
        echo '<div style="font-size:12px;color:#6b7280;font-weight:700;margin-bottom:6px">'.esc_html($lbl).'</div>';
        mbd($cls,$val);
        echo '</div></div>';
    }
    echo '</div><div class="mgrid">';
    // Session
    echo '<div class="mc"><div class="mch"><h2>Session Admin WP</h2></div><div class="mcb">';
    foreach([
        ['Utilisateur',$u->display_name.' (#'.$u->ID.')'],
        ['Email',$u->user_email],
        ['Roles',implode(', ',(array)$u->roles)],
        ['Site',miad_url()],
        ['WooCommerce',defined('WC_VERSION')?'v'.WC_VERSION:'Non installe'],
    ] as [$lb,$vl])
        echo '<div class="mr"><span class="lb">'.esc_html($lb).'</span><span class="vl">'.esc_html($vl).'</span></div>';
    echo '</div></div>';
    // Config
    echo '<div class="mc"><div class="mch"><h2>Cles API WooCommerce</h2></div><div class="mcb">';
    echo '<form method="post">'.wp_nonce_field('miad_cfg',false,true,false);
    echo '<input type="hidden" name="save_keys" value="1">';
    echo '<label class="lb2">Consumer Key (ck_)</label><input class="mi" name="miad_ck" value="'.esc_attr($k['ck']).'" placeholder="ck_xxx" style="margin-bottom:10px">';
    echo '<label class="lb2">Consumer Secret (cs_)</label><input class="mi" name="miad_cs" value="'.esc_attr($k['cs']).'" placeholder="cs_xxx" style="margin-bottom:12px">';
    echo '<button class="mbtn p" type="submit">Sauvegarder</button></form>';
    echo '</div></div></div>';
    // Derniers clients
    $cu=miad_woo('customers?per_page=6&orderby=registered_date&order=desc');
    echo '<div class="mc"><div class="mch"><h2>Derniers Clients WooCommerce</h2></div><div class="mcb">';
    if($cu['code']==200&&is_array($cu['body'])){
        echo '<table class="mt"><tr><th>ID</th><th>Nom</th><th>Email</th><th>Pays</th><th>Date</th></tr>';
        foreach($cu['body'] as $c)
            echo '<tr><td>#'.esc_html($c['id']).'</td><td>'.esc_html($c['first_name'].' '.$c['last_name']).'</td><td>'.esc_html($c['email']).'</td><td>'.esc_html($c['billing']['country']??'-').'</td><td>'.esc_html(substr($c['date_created']??'',0,10)).'</td></tr>';
        echo '</table>';
    } else mbd('warn','Cles API manquantes ou invalides');
    echo '</div></div></div>';
}

// ═══════════════════════════════════════════════════════════════════
// PAGE 2 — FLUX ACHAT COMPLET
// ═══════════════════════════════════════════════════════════════════

function miad_page_checkout(){
    if(!current_user_can('manage_options'))wp_die('Accès refusé');
    $or=null;$emails=[];
    if(isset($_POST['create_order'])&&check_admin_referer('miad_co')){
        $pid=intval($_POST['product_id']??0);$cid=intval($_POST['customer_id']??0);
        $em=sanitize_email($_POST['test_email']??'');$qty=max(1,intval($_POST['qty']??1));
        if(!$pid){$pr=miad_woo('products?per_page=1&status=publish');$pid=$pr['body'][0]['id']??0;}
        if($pid){
            $r=miad_woo('orders','POST',[
                'customer_id'=>$cid,'status'=>'pending','payment_method'=>'bacs','payment_method_title'=>'MIAD Test',
                'line_items'=>[['product_id'=>$pid,'quantity'=>$qty]],
                'billing'=>['first_name'=>'Test','last_name'=>'MIAD','address_1'=>'Dakar Test','city'=>'Dakar','country'=>'SN','email'=>$em?:wp_get_current_user()->user_email,'phone'=>'+221770000000'],
                'shipping'=>['first_name'=>'Test','last_name'=>'MIAD','address_1'=>'Dakar Test','city'=>'Dakar','country'=>'SN'],
                'meta_data'=>[['key'=>'_miad_test_order','value'=>'1']],
            ]);
            $or=$r;
            if($r['code']===201&&isset($r['body']['id'])&&class_exists('WC')){
                $oid=$r['body']['id'];$wco=wc_get_order($oid);
                if($wco){
                    $ml=WC()->mailer();
                    $ml->emails['WC_Email_New_Order']->trigger($oid);
                    $emails[]='Admin : Email nouvelle commande envoye';
                    $ml->emails['WC_Email_Customer_Processing_Order']->trigger($oid);
                    $emails[]='Client : Confirmation envoyee a '.$r['body']['billing']['email'];
                }
            }
        }
    }
    echo '<div class="mw">';
    mhead('Flux Achat Complet','Creer une commande test · verifier paiement · confirmer emails');
    if($or){
        if($or['code']===201){
            $o=$or['body'];
            echo '<div class="mn s">Commande <strong>#'.intval($o['id']).'</strong> creee !<br>';
            echo 'Produit : '.esc_html($o['line_items'][0]['name']??'?').' x '.intval($o['line_items'][0]['quantity']??1).'<br>';
            echo 'Total : <strong>'.esc_html($o['total']).' '.strtoupper($o['currency']).'</strong> · Statut : '.esc_html($o['status']).'<br>';
            if($emails) echo implode('<br>',array_map('esc_html',$emails));
            echo '</div>';
        } else echo '<div class="mn e">Erreur '.intval($or['code']).' : '.esc_html(json_encode($or['body'])).'</div>';
    }
    echo '<div class="mgrid">';
    echo '<div class="mc"><div class="mch"><h2>Creer une commande de test</h2></div><div class="mcb">';
    echo '<form method="post">'.wp_nonce_field('miad_co',false,true,false);
    echo '<input type="hidden" name="create_order" value="1">';
    echo '<div class="row2"><div><label class="lb2">ID Produit (vide = 1er dispo)</label><input class="mi" name="product_id" type="number" placeholder="ex: 142"></div>';
    echo '<div><label class="lb2">Quantite</label><input class="mi" name="qty" type="number" value="1" min="1"></div></div>';
    echo '<label class="lb2">ID Client WC (0 = invite)</label><input class="mi" name="customer_id" type="number" value="0" style="margin-bottom:10px">';
    echo '<label class="lb2">Email confirmation</label><input class="mi" name="test_email" type="email" value="'.esc_attr(wp_get_current_user()->user_email).'" style="margin-bottom:14px">';
    echo '<button class="mbtn p" type="submit" style="width:100%;justify-content:center">Creer + Envoyer emails</button></form>';
    echo '</div></div>';
    // 5 dernieres commandes
    echo '<div class="mc"><div class="mch"><h2>5 Dernieres commandes</h2></div><div class="mcb">';
    $re=miad_woo('orders?per_page=5&orderby=date&order=desc');
    if($re['code']===200&&is_array($re['body'])){
        foreach($re['body'] as $o){
            $b=$o['billing']??[];
            echo '<div class="mr"><span class="lb">#'.esc_html($o['id']).' '.esc_html(trim(($b['first_name']??'').' '.($b['last_name']??''))).'</span>';
            echo '<span class="vl" style="display:flex;gap:8px;align-items:center">';mst($o['status']);
            echo ' '.esc_html($o['total']).' '.strtoupper(esc_html($o['currency'])).'</span></div>';
        }
    } else mbd('warn','Cles API manquantes');
    echo '</div></div></div></div>';
}

// ═══════════════════════════════════════════════════════════════════
// PAGE 3 — COMMANDES
// ═══════════════════════════════════════════════════════════════════

function miad_page_orders(){
    if(!current_user_can('manage_options'))wp_die('Accès refusé');
    if(isset($_POST['chg_st'])&&check_admin_referer('miad_ord')){
        $oid=intval($_POST['order_id']);$ns=sanitize_text_field($_POST['new_status']);
        $r=miad_woo('orders/'.$oid,'PUT',['status'=>$ns]);
        echo $r['code']===200?'<div class="mn s">Commande #'.$oid.' → '.esc_html($ns).'</div>':'<div class="mn e">Erreur '.esc_html(json_encode($r['body'])).'</div>';
    }
    $sf=sanitize_text_field($_GET['sf']??'');
    $sts=[''=>'Toutes','pending'=>'En attente','processing'=>'En cours','on-hold'=>'En pause','completed'=>'Terminee','cancelled'=>'Annulee','refunded'=>'Rembourse'];
    echo '<div class="mw">';mhead('Commandes WooCommerce','Suivi · filtres · changement statut');
    echo '<div class="fil">';
    foreach($sts as $s=>$l) echo '<a href="'.esc_url(admin_url('admin.php?page=miad-test-orders'.($s?'&sf='.$s:''))).'" class="mbtn '.($sf===$s?'p':'g').'">'.esc_html($l).'</a>';
    echo '</div>';
    $r=miad_woo('orders?per_page=30&orderby=date&order=desc'.($sf?'&status='.$sf:''));
    echo '<div class="mc"><div class="mch"><h2>Liste des commandes</h2></div><div class="mcb">';
    if($r['code']===200&&is_array($r['body'])&&count($r['body'])>0){
        echo '<table class="mt"><tr><th>ID</th><th>Client</th><th>Email</th><th>Total</th><th>Statut</th><th>Date</th><th>Action</th></tr>';
        foreach($r['body'] as $o){
            $b=$o['billing']??[];
            echo '<tr><td><strong>#'.esc_html($o['id']).'</strong></td><td>'.esc_html(trim(($b['first_name']??'').' '.($b['last_name']??''))).'</td>';
            echo '<td>'.esc_html($b['email']??'-').'</td><td><strong>'.esc_html($o['total']).' '.strtoupper(esc_html($o['currency'])).'</strong></td>';
            echo '<td>';mst($o['status']);echo '</td><td>'.esc_html(substr($o['date_created']??'',0,10)).'</td>';
            echo '<td><form method="post" style="display:flex;gap:6px;align-items:center">'.wp_nonce_field('miad_ord',false,true,false);
            echo '<input type="hidden" name="chg_st" value="1"><input type="hidden" name="order_id" value="'.intval($o['id']).'">';
            echo '<select name="new_status" style="padding:4px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:11px">';
            foreach(array_filter(array_keys($sts)) as $s) echo '<option value="'.esc_attr($s).'"'.selected($o['status'],$s,false).'>'.esc_html($s).'</option>';
            echo '</select><button class="mbtn g" type="submit" style="padding:4px 10px;font-size:11px">OK</button></form></td></tr>';
        }
        echo '</table>';
    } elseif($r['code']===200) echo '<p style="color:#6b7280;font-size:13px">Aucune commande trouvee.</p>';
    else mbd('err','Erreur '.($r['code']??0).' — Verifiez les cles API');
    echo '</div></div></div>';
}

// ═══════════════════════════════════════════════════════════════════
// PAGE 4 — OTP & EMAILS
// ═══════════════════════════════════════════════════════════════════

function miad_page_otp(){
    if(!current_user_can('manage_options'))wp_die('Accès refusé');
    $sr=$vr=null;
    if(isset($_POST['send_otp'])&&check_admin_referer('miad_otp')){
        $em=sanitize_email($_POST['otp_email']??'');
        $r=miad_api('miad/v1/otp/send','POST',['email'=>$em]);
        $sr=['ok'=>($r['code']===200||!empty($r['body']['success'])),'code'=>$r['code'],'body'=>$r['body'],'em'=>$em];
    }
    if(isset($_POST['verify_otp'])&&check_admin_referer('miad_otp')){
        $em=sanitize_email($_POST['ver_email']??'');$cod=sanitize_text_field($_POST['ver_code']??'');
        $r=miad_api('miad/v1/otp/verify','POST',['email'=>$em,'code'=>$cod]);
        $vr=['ok'=>($r['code']===200&&!empty($r['body']['token'])),'code'=>$r['code'],'body'=>$r['body']];
    }
    echo '<div class="mw">';mhead('OTP & Emails','Test connexion sans mot de passe · verification codes');
    echo '<div class="mgrid">';
    echo '<div class="mc"><div class="mch"><h2>Envoyer un code OTP</h2></div><div class="mcb">';
    if($sr) echo '<div class="mn '.($sr['ok']?'s':'e').'">'.($sr['ok']?'OK':'ERREUR').' HTTP '.$sr['code'].' — '.esc_html($sr['em']).'<br><small>'.esc_html(json_encode($sr['body'])).'</small></div>';
    echo '<form method="post">'.wp_nonce_field('miad_otp',false,true,false);
    echo '<input type="hidden" name="send_otp" value="1"><label class="lb2">Email</label>';
    echo '<input class="mi" name="otp_email" type="email" value="'.esc_attr(wp_get_current_user()->user_email).'" style="margin-bottom:12px">';
    echo '<button class="mbtn p" type="submit">Envoyer le code OTP</button></form></div></div>';
    echo '<div class="mc"><div class="mch"><h2>Verifier le code recu</h2></div><div class="mcb">';
    if($vr){
        echo '<div class="mn '.($vr['ok']?'s':'e').'">';
        echo $vr['ok']?'Token JWT recu !<br><small style="font-family:monospace">'.esc_html(substr($vr['body']['token'],0,60)).'</small>':'Echec HTTP '.$vr['code'].' : '.esc_html(json_encode($vr['body']));
        echo '</div>';
    }
    echo '<form method="post">'.wp_nonce_field('miad_otp',false,true,false);
    echo '<input type="hidden" name="verify_otp" value="1"><label class="lb2">Email</label><input class="mi" name="ver_email" type="email" style="margin-bottom:10px">';
    echo '<label class="lb2">Code 6 chiffres</label><input class="mi" name="ver_code" placeholder="123456" maxlength="6" style="margin-bottom:12px;letter-spacing:8px;font-size:20px;text-align:center">';
    echo '<button class="mbtn p" type="submit">Verifier le code</button></form></div></div></div>';
    global $wpdb;
    $otps=$wpdb->get_results("SELECT option_name,option_value FROM {$wpdb->options} WHERE option_name LIKE '_transient_miad_otp_%' ORDER BY option_id DESC LIMIT 20");
    echo '<div class="mc"><div class="mch"><h2>OTPs actifs en base</h2></div><div class="mcb">';
    if($otps){
        echo '<table class="mt"><tr><th>Email</th><th>Code stocke</th></tr>';
        foreach($otps as $row) echo '<tr><td>'.esc_html(str_replace('_transient_miad_otp_','',$row->option_name)).'</td><td><code>'.esc_html($row->option_value).'</code></td></tr>';
        echo '</table>';
    } else echo '<p style="color:#6b7280;font-size:13px">Aucun OTP actif (expirent automatiquement).</p>';
    echo '</div></div></div>';
}

// ═══════════════════════════════════════════════════════════════════
// PAGE 5 — REPRESENTANTS
// ═══════════════════════════════════════════════════════════════════

function miad_page_rep(){
    if(!current_user_can('manage_options'))wp_die('Accès refusé');
    $tr=null;
    if(isset($_POST['add_track'])&&check_admin_referer('miad_rep')){
        $oid=intval($_POST['track_oid']);$carrier=sanitize_text_field($_POST['carrier']??'DHL');
        $num=sanitize_text_field($_POST['track_num']??'');$zone=sanitize_text_field($_POST['rep_zone']??'SN');
        // Changer le statut vers "prise en charge" + sauvegarder la zone
        $r=miad_woo('orders/'.$oid,'PUT',[
            'status'=>'miad-rep-charge',
            'meta_data'=>[['key'=>'_rep_zone','value'=>$zone],['key'=>'_rep_carrier','value'=>$carrier]],
        ]);
        if($r['code']===200&&class_exists('WC_Order')){
            $wco=wc_get_order($oid);
            if($wco){
                // Déclencher l'action tracking → envoie email automatiquement via miad-email-customizer.php
                do_action('miad_tracking_assigned', $oid, $num, $carrier);
                $tr=['ok'=>true,'oid'=>$oid,'carrier'=>$carrier,'num'=>$num,'email'=>$wco->get_billing_email()];
            }
        } else $tr=['ok'=>false,'err'=>json_encode($r['body'])];
    }
    $sf=sanitize_text_field($_GET['sf']??'');$zone=sanitize_text_field($_GET['zone']??'');
    $zones=['SN'=>'Senegal','CI'=>"Cote d'Ivoire",'CM'=>'Cameroun','GN'=>'Guinee','BJ'=>'Benin','ML'=>'Mali','BF'=>'Burkina Faso','GH'=>'Ghana','NG'=>'Nigeria'];
    $reps=get_users(['role__in'=>['miad_representative','miad_representant','representant','miad_rep'],'number'=>50]);
    echo '<div class="mw">';mhead('Espace Representants','Commandes par zone · Tracking · Filtres statut');
    if($tr){
        echo $tr['ok']?'<div class="mn s">Tracking ajoute commande #'.intval($tr['oid']).'<br>'.esc_html($tr['carrier'].': '.$tr['num']).'<br>Email envoye a '.esc_html($tr['email']).'</div>':'<div class="mn e">Erreur : '.esc_html($tr['err']).'</div>';
    }
    echo '<div class="mgrid">';
    echo '<div class="mc"><div class="mch"><h2>Representants enregistres</h2></div><div class="mcb">';
    if($reps){
        echo '<table class="mt"><tr><th>Nom</th><th>Email</th><th>Zone</th></tr>';
        foreach($reps as $ru) echo '<tr><td>'.esc_html($ru->display_name).'</td><td>'.esc_html($ru->user_email).'</td><td>'.esc_html(get_user_meta($ru->ID,'miad_zone',true)?:'Non definie').'</td></tr>';
        echo '</table>';
    } else { mbd('info','Aucun representant trouve');echo '<br><small style="color:#6b7280;font-size:12px">Roles requis : miad_representative, representant, miad_rep</small>'; }
    echo '</div></div>';
    echo '<div class="mc"><div class="mch"><h2>Ajouter un numero de tracking</h2></div><div class="mcb">';
    echo '<form method="post">'.wp_nonce_field('miad_rep',false,true,false);
    echo '<input type="hidden" name="add_track" value="1"><label class="lb2">ID Commande WooCommerce</label><input class="mi" name="track_oid" type="number" placeholder="ex: 342" style="margin-bottom:10px">';
    echo '<div class="row2"><div><label class="lb2">Transporteur</label><select class="mi" name="carrier"><option value="DHL">DHL Express</option><option value="Chronopost">Chronopost</option><option value="FedEx">FedEx</option><option value="UPS">UPS</option></select></div>';
    echo '<div><label class="lb2">Zone</label><select class="mi" name="rep_zone">';
    foreach($zones as $c=>$n) echo '<option value="'.esc_attr($c).'">'.esc_html($n).'</option>';
    echo '</select></div></div><label class="lb2">Numero de suivi</label><input class="mi" name="track_num" placeholder="ex: 1234567890" style="margin-bottom:14px">';
    echo '<button class="mbtn t" type="submit" style="width:100%;justify-content:center">Sauvegarder + Notifier client</button></form>';
    echo '</div></div></div>';
    // Commandes filtrees
    echo '<div class="mc"><div class="mch"><h2>Commandes par Zone &amp; Statut</h2></div><div class="mcb">';
    echo '<div class="fil">';
    foreach([''=>'Toutes','pending'=>'En attente','processing'=>'En cours','completed'=>'Terminee','cancelled'=>'Annulee'] as $s=>$l)
        echo '<a href="'.esc_url(admin_url('admin.php?page=miad-test-rep'.($s?'&sf='.$s:'').($zone?'&zone='.$zone:''))).'" class="mbtn '.($sf===$s?'p':'g').'" style="font-size:12px;padding:5px 12px">'.esc_html($l).'</a>';
    echo '</div>';
    $r=miad_woo('orders?per_page=25&orderby=date&order=desc'.($sf?'&status='.$sf:''));
    if($r['code']===200&&is_array($r['body'])&&count($r['body'])>0){
        echo '<table class="mt"><tr><th>ID</th><th>Client</th><th>Pays</th><th>Total</th><th>Statut</th><th>Tracking</th><th>Date</th></tr>';
        foreach($r['body'] as $o){
            $b=$o['billing']??[];
            if($zone&&strtoupper($b['country']??'')!==strtoupper($zone))continue;
            $tk=$tc='';
            if($o['id']&&class_exists('WC_Order')){$wo=wc_get_order($o['id']);if($wo){$tk=$wo->get_meta('_tracking_number');$tc=$wo->get_meta('_tracking_carrier');}}
            echo '<tr><td><strong>#'.esc_html($o['id']).'</strong></td><td>'.esc_html(trim(($b['first_name']??'').' '.($b['last_name']??''))).'</td>';
            echo '<td>'.esc_html($b['country']??'-').'</td><td><strong>'.esc_html($o['total']).' '.strtoupper(esc_html($o['currency'])).'</strong></td>';
            echo '<td>';mst($o['status']);echo '</td><td style="font-size:11px">'.esc_html($tc&&$tk?$tc.': '.$tk:'—').'</td>';
            echo '<td>'.esc_html(substr($o['date_created']??'',0,10)).'</td></tr>';
        }
        echo '</table>';
    } else echo '<p style="color:#6b7280;font-size:13px">Aucune commande trouvee.</p>';
    echo '</div></div></div>';
}

// ═══════════════════════════════════════════════════════════════════
// PAGE 6 — DHL LOGISTIQUE TEST
// ═══════════════════════════════════════════════════════════════════

function miad_page_dhl(){
    if(!current_user_can('manage_options'))wp_die('Accès refusé');
    $rr=$sr=null;
    if(isset($_POST['test_rate'])&&check_admin_referer('miad_dhl')){
        $r=miad_api('miad/v1/dhl/rate','POST',['from_country'=>sanitize_text_field($_POST['from']??'SN'),'to_country'=>sanitize_text_field($_POST['to']??'FR'),'weight'=>floatval($_POST['w']??1),'test_mode'=>true]);
        $rr=['code'=>$r['code'],'body'=>$r['body']];
    }
    if(isset($_POST['create_ship'])&&check_admin_referer('miad_dhl')){
        $oid=intval($_POST['dhl_oid']??0);$w=floatval($_POST['dhl_w']??0.5);$desc=sanitize_text_field($_POST['dhl_desc']??'Produit artisanal africain');
        $r=miad_api('miad/v1/dhl/create-shipment','POST',['order_id'=>$oid,'weight'=>$w,'description'=>$desc,'test_mode'=>true]);
        $sr=['code'=>$r['code'],'body'=>$r['body'],'oid'=>$oid];
        if($r['code']===200&&isset($r['body']['tracking_number'])&&$oid&&class_exists('WC_Order')){
            $wco=wc_get_order($oid);
            if($wco){
                $wco->update_meta_data('_tracking_number',$r['body']['tracking_number']);
                $wco->update_meta_data('_tracking_carrier','DHL');$wco->save();
                $wco->add_order_note('DHL Test : Expedition creee. Tracking : '.$r['body']['tracking_number'],1);
                if(class_exists('WC')) WC()->mailer()->emails['WC_Email_Customer_Processing_Order']->trigger($oid);
                $sr['email']=$wco->get_billing_email();
            }
        }
    }
    echo '<div class="mw">';mhead('DHL Logistique Test','Mode sandbox · Creer expedition · Tracking · Emails confirmes');
    echo '<div class="mgrid">';
    echo '<div class="mc"><div class="mch"><h2>Tarification DHL (Sandbox)</h2></div><div class="mcb">';
    if($rr){
        if($rr['code']===200&&isset($rr['body']['rates'])){
            echo '<div class="mn s">Tarifs DHL recus !</div>';
            echo '<table class="mt"><tr><th>Service</th><th>Delai</th><th>Prix</th><th>Devise</th></tr>';
            foreach($rr['body']['rates'] as $rt) echo '<tr><td>'.esc_html($rt['service']??'-').'</td><td>'.esc_html($rt['days']??'-').' j</td><td><strong>'.esc_html($rt['amount']??'-').'</strong></td><td>'.esc_html($rt['currency']??'USD').'</td></tr>';
            echo '</table>';
        } else echo '<div class="mn '.($rr['code']===200?'i':'e').'">HTTP '.$rr['code'].' : '.esc_html(json_encode($rr['body'])).'<br><small>Endpoint requis : /wp-json/miad/v1/dhl/rate</small></div>';
    }
    echo '<form method="post">'.wp_nonce_field('miad_dhl',false,true,false);
    echo '<input type="hidden" name="test_rate" value="1"><div class="row2">';
    echo '<div><label class="lb2">Pays depart</label><select class="mi" name="from"><option value="SN">Senegal</option><option value="CI">Cote Ivoire</option><option value="CM">Cameroun</option><option value="NG">Nigeria</option></select></div>';
    echo '<div><label class="lb2">Pays destination</label><select class="mi" name="to"><option value="FR">France</option><option value="US">USA</option><option value="GB">UK</option><option value="BE">Belgique</option><option value="DE">Allemagne</option></select></div></div>';
    echo '<label class="lb2">Poids (kg)</label><input class="mi" name="w" type="number" step="0.1" value="1" min="0.1" style="margin-bottom:12px">';
    echo '<button class="mbtn b" type="submit">Obtenir tarifs DHL</button></form></div></div>';
    echo '<div class="mc"><div class="mch"><h2>Creer une expedition DHL Test</h2></div><div class="mcb">';
    if($sr){
        if($sr['code']===200&&isset($sr['body']['tracking_number'])){
            echo '<div class="mn s">Expedition DHL creee !<br>Tracking : <strong>'.esc_html($sr['body']['tracking_number']).'</strong>';
            if(isset($sr['body']['label_url'])) echo '<br><a href="'.esc_url($sr['body']['label_url']).'" target="_blank">Telecharger etiquette</a>';
            if(isset($sr['email'])) echo '<br>Email envoye a : '.esc_html($sr['email']);
            echo '</div>';
        } else echo '<div class="mn '.($sr['code']===200?'i':'e').'">HTTP '.$sr['code'].' : '.esc_html(json_encode($sr['body'])).'<br><small>Endpoint requis : /wp-json/miad/v1/dhl/create-shipment</small></div>';
    }
    echo '<form method="post">'.wp_nonce_field('miad_dhl',false,true,false);
    echo '<input type="hidden" name="create_ship" value="1"><label class="lb2">ID Commande WooCommerce</label><input class="mi" name="dhl_oid" type="number" placeholder="ex: 342" style="margin-bottom:10px">';
    echo '<div class="row2"><div><label class="lb2">Poids (kg)</label><input class="mi" name="dhl_w" type="number" step="0.1" value="0.5"></div>';
    echo '<div><label class="lb2">Description colis</label><input class="mi" name="dhl_desc" value="Produit artisanal africain"></div></div>';
    echo '<button class="mbtn t" type="submit" style="width:100%;justify-content:center;margin-top:10px">Creer expedition TEST + Email client</button></form></div></div></div>';
    // Commandes avec tracking
    global $wpdb;
    $tracked=$wpdb->get_results("SELECT p.ID,pm.meta_value as tn,pm2.meta_value as tc FROM {$wpdb->posts} p LEFT JOIN {$wpdb->postmeta} pm ON pm.post_id=p.ID AND pm.meta_key='_tracking_number' LEFT JOIN {$wpdb->postmeta} pm2 ON pm2.post_id=p.ID AND pm2.meta_key='_tracking_carrier' WHERE p.post_type='shop_order' AND pm.meta_value IS NOT NULL AND pm.meta_value!='' ORDER BY p.ID DESC LIMIT 15");
    echo '<div class="mc"><div class="mch"><h2>Commandes avec suivi</h2></div><div class="mcb">';
    if($tracked){
        echo '<table class="mt"><tr><th>Commande</th><th>Transporteur</th><th>Tracking</th><th>Lien</th></tr>';
        foreach($tracked as $t){
            $url=$t->tc==='DHL'?'https://www.dhl.com/fr-fr/home/tracking/tracking-express.html?submit=1&tracking-id='.urlencode($t->tn):'#';
            echo '<tr><td><a href="'.admin_url('post.php?post='.$t->ID.'&action=edit').'">#'.esc_html($t->ID).'</a></td>';
            echo '<td>'.esc_html($t->tc??'DHL').'</td><td><code>'.esc_html($t->tn).'</code></td>';
            echo '<td><a href="'.esc_url($url).'" target="_blank" class="mbtn g" style="padding:3px 10px;font-size:11px">Suivre</a></td></tr>';
        }
        echo '</table>';
    } else echo '<p style="color:#6b7280;font-size:13px">Aucune commande avec tracking.</p>';
    echo '</div></div></div>';
}

// ═══════════════════════════════════════════════════════════════════
// PAGE 7 — HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════

function miad_page_health(){
    if(!current_user_can('manage_options'))wp_die('Accès refusé');
    $k=miad_keys();
    $eps=[
        ['WooCommerce API',     miad_url().'/wp-json/wc/v3/products?per_page=1&consumer_key='.$k['ck'].'&consumer_secret='.$k['cs'],'GET'],
        ['WP REST users/me',    miad_url().'/wp-json/wp/v2/users/me','GET'],
        ['MIAD OTP Send',       miad_url().'/wp-json/miad/v1/otp/send','POST'],
        ['MIAD Auth Firebase',  miad_url().'/wp-json/miad/v1/auth/firebase','POST'],
        ['MIAD Payment Intent', miad_url().'/wp-json/miad/v1/create-payment-intent','POST'],
        ['MIAD DHL Rate',       miad_url().'/wp-json/miad/v1/dhl/rate','POST'],
        ['MIAD DHL Shipment',   miad_url().'/wp-json/miad/v1/dhl/create-shipment','POST'],
        ['Categories WC',       miad_url().'/wp-json/wc/v3/products/categories?per_page=3&consumer_key='.$k['ck'].'&consumer_secret='.$k['cs'],'GET'],
        ['Commandes WC',        miad_url().'/wp-json/wc/v3/orders?per_page=1&consumer_key='.$k['ck'].'&consumer_secret='.$k['cs'],'GET'],
    ];
    echo '<div class="mw">';mhead('Health Check','Etat de tous les endpoints · Temps de reponse');
    echo '<div class="mc"><div class="mch"><h2>Resultats</h2></div><div class="mcb">';
    echo '<table class="mt"><tr><th>Endpoint</th><th>Methode</th><th>HTTP</th><th>Reponse</th><th>Temps</th></tr>';
    foreach($eps as [$lbl,$url,$m]){
        $args=['timeout'=>8,'sslverify'=>false,'method'=>$m];
        if($m==='POST'){$args['headers']=['Content-Type'=>'application/json'];$args['body']='{}';}
        $t0=microtime(true);$res=wp_remote_request($url,$args);$ms=round((microtime(true)-$t0)*1000);
        $code=is_wp_error($res)?0:wp_remote_retrieve_response_code($res);
        $body=is_wp_error($res)?$res->get_error_message():substr(wp_remote_retrieve_body($res),0,60);
        $ok=in_array($code,[200,201]);$warn=in_array($code,[400,401,405]);
        echo '<tr><td><strong>'.esc_html($lbl).'</strong></td><td><code>'.esc_html($m).'</code></td>';
        echo '<td>';mbd($ok?'ok':($warn?'warn':'err'),$ok?'OK '.$code:($warn?'WARN '.$code:'ERR '.($code?:'?')));
        echo '</td><td style="font-size:11px;color:#6b7280;font-family:monospace;max-width:200px;overflow:hidden;text-overflow:ellipsis">'.esc_html($body).'</td>';
        echo '<td>'.esc_html($ms).' ms</td></tr>';
    }
    echo '</table></div></div>';
    $infos=['WordPress'=>get_bloginfo('version'),'WooCommerce'=>defined('WC_VERSION')?'v'.WC_VERSION:'Non installe','PHP'=>PHP_VERSION,'Memoire PHP'=>ini_get('memory_limit'),'Max exec time'=>ini_get('max_execution_time').'s','Plugins actifs'=>count(get_option('active_plugins',[])).' plugins','CK configuree'=>$k['ck']?'Oui':'Non','CS configuree'=>$k['cs']?'Oui':'Non','WC Mailer'=>class_exists('WC_Mailer')?'OK':'Manquant','JWT Auth plugin'=>is_plugin_active('jwt-authentication-for-wp-rest-api/jwt-auth.php')?'Actif':'Inactif'];
    echo '<div class="mc" style="margin-top:16px"><div class="mch"><h2>Informations Systeme</h2></div><div class="mcb"><div class="mgrid">';
    $i=0;echo '<div>';
    foreach($infos as $k2=>$v){if($i===5)echo '</div><div>';echo '<div class="mr"><span class="lb">'.esc_html($k2).'</span><span class="vl">'.esc_html($v).'</span></div>';$i++;}
    echo '</div></div></div></div></div>';
}
