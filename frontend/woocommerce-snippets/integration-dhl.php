

if (!defined('ABSPATH')) exit;

// Define the log file path
if (!defined('MIAD_DHL_LOG_FILE')) {
    $upload_dir = wp_upload_dir();
    define('MIAD_DHL_LOG_FILE', $upload_dir['basedir'] . '/miad_dhl_debug.log');
}

// --- 1. MENU D'ADMINISTRATION (CONFIGURATION) ---
add_action('admin_menu', 'miad_dhl_add_menu');
function miad_dhl_add_menu() {
    add_menu_page(
        'Configuration DHL',          // Titre de la page
        'DHL Config',                 // Titre du menu
        'manage_options',             // Capacité requise (Admin)
        'miad-dhl-config',            // Slug URL
        'miad_dhl_render_admin_page', // Fonction d'affichage
        'dashicons-location',         // Icône
        59                            // Position
    );
    
    // AJOUT : Sous-menu "Tableau de Bord" (NOUVEAU)
    add_submenu_page(
        'miad-dhl-config',
        'Tableau de Bord',
        'Tableau de Bord',
        'manage_options',
        'miad-dhl-dashboard',
        'miad_dhl_render_dashboard_page'
    );

    // AJOUT : Sous-menu "Configuration" (pour garder le lien principal)
    add_submenu_page(
        'miad-dhl-config',
        'Configuration',
        'Configuration',
        'manage_options',
        'miad-dhl-config',
        'miad_dhl_render_admin_page'
    );
}

// --- 1.1 INSTALLATION TABLE HISTORIQUE TESTS ---
add_action('admin_init', 'miad_dhl_check_install_test_table');
function miad_dhl_check_install_test_table() {
    global $wpdb;
    $table_name = $wpdb->prefix . 'miad_dhl_tests';
    
    if($wpdb->get_var("SHOW TABLES LIKE '$table_name'") != $table_name) {
        $charset_collate = $wpdb->get_charset_collate();
        $sql = "CREATE TABLE $table_name (
            id mediumint(9) NOT NULL AUTO_INCREMENT,
            time datetime DEFAULT CURRENT_TIMESTAMP NOT NULL,
            test_type varchar(50) NOT NULL,
            reference varchar(100) NOT NULL,
            status varchar(20) NOT NULL,
            environment varchar(20) NOT NULL,
            result_summary text NOT NULL,
            PRIMARY KEY  (id)
        ) $charset_collate;";
        require_once(ABSPATH . 'wp-admin/includes/upgrade.php');
        dbDelta($sql);
    }
}

// --- 1.2 HELPER : HEADERS API DHL (Authentification) ---
if (!function_exists('miad_dhl_get_headers')) {
    function miad_dhl_get_headers($site_id, $password) {
        return [
            'Authorization' => 'Basic ' . base64_encode($site_id . ':' . $password),
            'Content-Type' => 'application/json',
            'Accept' => 'application/json'
        ];
    }
}

// --- 1.2B HELPER : DATE D'EXPÉDITION INTELLIGENTE ---
if (!function_exists('miad_dhl_get_next_shipping_date')) {
    function miad_dhl_get_next_shipping_date() {
        // Utilise le fuseau horaire de WordPress pour être cohérent
        $shippingDate = new DateTime('now', wp_timezone()); 
        $dayOfWeek = (int) $shippingDate->format('w'); // 0 for Sunday, 6 for Saturday
        $hour = (int) $shippingDate->format('H');

        if ($dayOfWeek === 6) { // Saturday
            $shippingDate->modify('+2 days');
        } elseif ($dayOfWeek === 0) { // Sunday
            $shippingDate->modify('+1 day');
        } elseif ($dayOfWeek === 5 && $hour >= 17) { // Friday after 5 PM
            $shippingDate->modify('+3 days');
        } else {
            $shippingDate->modify('+1 day'); // Default next day
        }
        
        return $shippingDate->format('Y-m-d');
    }
}

// Helper function to read the tail of a file
if (!function_exists('miad_dhl_read_log_tail')) {
    /**
     * Reads the last N lines or last X bytes of a file.
     *
     * @param string $filepath The full path to the log file.
     * @param int $max_lines Maximum number of lines to read.
     * @param int $max_bytes Maximum number of bytes to read (approximate).
     * @return string The truncated log content, with a truncation message if applicable.
     */
    function miad_dhl_read_log_tail($filepath, $max_lines = 500, $max_bytes = 1048576) { // 1MB
        if (!file_exists($filepath)) {
            return '';
        }

        $file_size = filesize($filepath);
        $log_content = '';
        $truncated_message = '';

        if ($file_size > $max_bytes) {
            $truncated_message = "\n--- LOG TRUNCATED (Showing last " . round($max_bytes / 1024) . "KB of " . round($file_size / 1024) . "KB) ---\n";
            $f = fopen($filepath, 'r');
            if ($f) {
                fseek($f, -$max_bytes, SEEK_END);
                $log_content = fread($f, $max_bytes);
                fclose($f);
                // Ensure we start from a new line if truncated in the middle of one
                $first_newline = strpos($log_content, "\n");
                if ($first_newline !== false) {
                    $log_content = substr($log_content, $first_newline + 1);
                }
            }
        } else {
            $log_content = file_get_contents($filepath);
        }
        return $truncated_message . $log_content;
    }
}

function miad_dhl_render_dashboard_page() {
    $view = isset($_GET['view']) ? sanitize_text_field($_GET['view']) : 'orders';
    
    echo '<div class="wrap"><h1><span class="dashicons dashicons-chart-area" style="font-size:30px; width:30px; height:30px;"></span> Tableau de Bord DHL</h1>';
    
    // Onglets
    echo '<h2 class="nav-tab-wrapper">';
    echo '<a href="?page=miad-dhl-dashboard&view=orders" class="nav-tab ' . ($view === 'orders' ? 'nav-tab-active' : '') . '">Commandes Clients</a>';
    echo '<a href="?page=miad-dhl-dashboard&view=tests" class="nav-tab ' . ($view === 'tests' ? 'nav-tab-active' : '') . '">Historique Tests API</a>';
    echo '<a href="?page=miad-dhl-dashboard&view=logs" class="nav-tab ' . ($view === 'logs' ? 'nav-tab-active' : '') . '">Logs API (Requêtes/Réponses)</a>';
    echo '</h2>';

    if ($view === 'orders') {
        $paged = isset($_GET['paged']) ? max(1, intval($_GET['paged'])) : 1;
        $limit = 50; // Augmenté pour voir plus d'éléments

        // Requête pour récupérer les commandes avec un numéro de suivi DHL
        $args = [
            'post_type' => 'shop_order',
            'post_status' => array_keys(wc_get_order_statuses()),
            'meta_query' => [
                [
                    'key' => '_miad_dhl_tracking_number',
                    'compare' => 'EXISTS'
                ]
            ],
            'posts_per_page' => $limit,
            'paged' => $paged,
            'orderby' => 'date',
            'order' => 'DESC'
        ];
        
        $query = new WP_Query($args);
        
        // Stats rapides
        $total_shipments = $query->found_posts;
        echo '<div style="background:#fff; padding:15px; border-left:4px solid #d40511; margin:20px 0; box-shadow:0 1px 1px rgba(0,0,0,0.04); display:flex; justify-content:space-between; align-items:center;">';
        echo '<span><strong>Total Expéditions : </strong> ' . $total_shipments . '</span>';
        echo '<button type="button" class="button" id="miad-refresh-statuses"><span class="dashicons dashicons-update"></span> Rafraîchir les statuts</button>';
        echo '</div>';

        echo '<table class="wp-list-table widefat fixed striped">';
        echo '<thead><tr>
                <th width="80">Commande</th>
                <th width="120">Date</th>
                <th>Client</th>
                <th>Tracking DHL</th>
                <th>Statut Livraison</th>
                <th>Documents (Téléchargement)</th>
                <th>Statut Commande</th>
                <th width="120">Actions</th>
              </tr></thead>';
        echo '<tbody>';
        
        if ($query->have_posts()) {
            while ($query->have_posts()) {
                $query->the_post();
                $order_id = get_the_ID();
                $order = wc_get_order($order_id);
                
                if (!$order) continue;

                $tn = $order->get_meta('_miad_dhl_tracking_number');
                $label_url = $order->get_meta('_miad_dhl_label_url');
                $waybill_doc_url = $order->get_meta('_miad_dhl_waybill_doc_url');
                $invoice_url = $order->get_meta('_miad_dhl_invoice_url');
                
                echo '<tr>';
                echo '<td><a href="' . get_edit_post_link($order_id) . '"><strong>#' . $order->get_order_number() . '</strong></a></td>';
                echo '<td>' . $order->get_date_created()->date_i18n('d/m/Y H:i') . '</td>';
                echo '<td>' . $order->get_formatted_billing_full_name() . '<br><small>' . $order->get_billing_email() . '</small></td>';
                echo '<td><span style="font-family:monospace; font-size:14px; color:#d40511;">' . esc_html($tn) . '</span></td>';
                echo '<td><span class="miad-dhl-live-status" data-tracking="' . esc_attr($tn) . '"><span class="dashicons dashicons-update" style="color:#ccc;"></span></span></td>';
                echo '<td>';
                if ($label_url) echo '<a href="' . esc_url($label_url) . '" class="button button-secondary" target="_blank" download><span class="dashicons dashicons-media-document"></span> Étiquette</a> ';
                if ($waybill_doc_url) echo '<a href="' . esc_url($waybill_doc_url) . '" class="button button-secondary" target="_blank" download><span class="dashicons dashicons-media-text"></span> Waybill Doc</a> ';
                if ($invoice_url) echo '<a href="' . esc_url($invoice_url) . '" class="button button-secondary" target="_blank" download><span class="dashicons dashicons-media-spreadsheet"></span> Facture</a>';
                if (!$label_url && !$invoice_url && !$waybill_doc_url) echo '<span style="color:#ccc;">Aucun document</span>';
                echo '</td>';
                echo '<td><mark class="order-status status-' . $order->get_status() . '"><span>' . wc_get_order_status_name($order->get_status()) . '</span></mark></td>';
                echo '<td>';
                $track_url = 'https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=' . $tn;
                echo '<a href="' . esc_url($track_url) . '" target="_blank" class="button button-primary">Suivre</a>';
                echo '</td>';
                echo '</tr>';
            }
        } else {
            echo '<tr><td colspan="7">Aucune expédition DHL trouvée.</td></tr>';
        }
        
        echo '</tbody></table>';
        
        // Pagination
        if ($query->max_num_pages > 1) {
            echo '<div class="tablenav bottom"><div class="tablenav-pages">';
            echo paginate_links([
                'base' => add_query_arg('paged', '%#%'),
                'format' => '',
                'current' => $paged,
                'total' => $query->max_num_pages
            ]);
            echo '</div></div>';
        }
        wp_reset_postdata();

        // JS pour charger les statuts en arrière-plan (évite de ralentir la page)
        ?>
        <script>
        jQuery(document).ready(function($) {
            function runStatusQueue() {
                var queue = [];
                $('.miad-dhl-live-status').each(function() {
                    $(this).html('<span class="dashicons dashicons-update" style="color:#ccc;"></span>'); // Reset
                    queue.push($(this));
                });

                var max_concurrent = 4;
                var running = 0;

                function runNext() {
                    if (queue.length === 0 && running === 0) return;
                    
                    while(running < max_concurrent && queue.length > 0) {
                        running++;
                        var elem = queue.shift();
                        var tn = elem.data('tracking');
                        
                        $.post(ajaxurl, {
                            action: 'miad_dhl_get_dashboard_status',
                            tracking_number: tn
                        }, function(res) {
                            if (res.success) {
                                elem.html(res.data.html);
                            } else {
                                elem.html('<span style="color:#ccc;">Non dispo</span>');
                            }
                        }).always(function() {
                            running--;
                            runNext();
                        });
                    }
                }
                runNext();
            }

            // Lancement initial
            runStatusQueue();

            // Lancement sur clic
            $('#miad-refresh-statuses').on('click', function() {
                $(this).find('.dashicons').addClass('dashicons-spin');
                runStatusQueue();
                setTimeout(() => { $(this).find('.dashicons').removeClass('dashicons-spin'); }, 2000);
            });
        });
        </script>
        <?php

    } elseif ($view === 'tests') {
        // VUE HISTORIQUE TESTS
        global $wpdb;
        $table_name = $wpdb->prefix . 'miad_dhl_tests';
        $paged = isset($_GET['paged']) ? max(1, intval($_GET['paged'])) : 1;
        $limit = 50;
        $offset = ($paged - 1) * $limit;

        // Vérification existence table
        if($wpdb->get_var("SHOW TABLES LIKE '$table_name'") != $table_name) {
            echo '<div class="notice notice-warning"><p>La table d\'historique des tests n\'existe pas encore. Lancez un test pour l\'initialiser.</p></div>';
            return;
        }

        $total_items = $wpdb->get_var("SELECT COUNT(id) FROM $table_name");
        $tests = $wpdb->get_results($wpdb->prepare("SELECT * FROM $table_name ORDER BY time DESC LIMIT %d OFFSET %d", $limit, $offset));

        echo '<p>Historique des appels API effectués depuis l\'onglet "Tests & Validation".</p>';
        
        echo '<table class="wp-list-table widefat fixed striped">';
        echo '<thead><tr>
                <th width="150">Date</th>
                <th width="100">Type</th>
                <th width="100">Env.</th>
                <th>Référence / Tracking</th>
                <th>Statut</th>
                <th>Détails / Erreur</th>
              </tr></thead>';
        echo '<tbody>';
        
        if ($tests) {
            foreach ($tests as $test) {
                $status_color = ($test->status === 'SUCCESS') ? 'green' : 'red';
                $env_badge = ($test->environment === 'production') ? '<span style="background:#d40511; color:#fff; padding:2px 5px; border-radius:3px; font-size:10px;">PROD</span>' : '<span style="background:#eee; color:#333; padding:2px 5px; border-radius:3px; font-size:10px;">TEST</span>';
                
                echo '<tr>';
                echo '<td>' . $test->time . '</td>';
                echo '<td><strong>' . esc_html($test->test_type) . '</strong></td>';
                echo '<td>' . $env_badge . '</td>';
                echo '<td>' . esc_html($test->reference) . '</td>';
                echo '<td style="color:' . $status_color . '; font-weight:bold;">' . esc_html($test->status) . '</td>';
                echo '<td>' . esc_html(mb_strimwidth($test->result_summary, 0, 100, '...')) . '</td>';
                echo '</tr>';
            }
        } else {
            echo '<tr><td colspan="6">Aucun test enregistré.</td></tr>';
        }
        echo '</tbody></table>';

        // Pagination Tests
        $total_pages = ceil($total_items / $limit);
        if ($total_pages > 1) {
            echo '<div class="tablenav bottom"><div class="tablenav-pages">';
            echo paginate_links([
                'base' => add_query_arg('paged', '%#%'),
                'format' => '',
                'current' => $paged,
                'total' => $total_pages
            ]);
            echo '</div></div>';
        }
    } elseif ($view === 'logs') {
        // VUE LOGS API
        $log_file = MIAD_DHL_LOG_FILE;
        echo '<div style="margin-top:20px;">';
        echo '<p>Journal des interactions brutes avec l\'API DHL (Dernières entrées).</p>';
        echo '<form method="post"><input type="hidden" name="miad_clear_log" value="1"><button type="submit" class="button">Vider le journal</button></form>';
        
        if (isset($_POST['miad_clear_log']) && file_exists($log_file)) {
            file_put_contents($log_file, '');
            echo '<div class="updated notice"><p>Journal vidé.</p></div>';
        }

        if (file_exists($log_file)) {
            $content = file_get_contents($log_file);
            // Découpage par séparateur
            $entries = explode("--------------------------------------------------", $content);
            $entries = array_reverse($entries); // Plus récent en premier

            echo '<table class="wp-list-table widefat fixed striped" style="margin-top:10px;">';
            echo '<thead><tr><th width="180">Date</th><th>Détails (Requête / Réponse)</th></tr></thead><tbody>';
            
            foreach ($entries as $entry) {
                if (trim($entry) == '') continue;
                // Extraction date [YYYY-MM-DD HH:MM:SS]
                preg_match('/^\[(.*?)\] (.*)/s', trim($entry), $matches);
                $date = isset($matches[1]) ? $matches[1] : '-';
                $msg = isset($matches[2]) ? $matches[2] : $entry;

                echo '<tr>';
                echo '<td style="vertical-align:top;">' . esc_html($date) . '</td>';
                echo '<td><pre style="white-space: pre-wrap; font-size:11px; max-height:200px; overflow-y:auto; background:#f0f0f0; padding:5px;">' . esc_html($msg) . '</pre></td>';
                echo '</tr>';
            }
            echo '</tbody></table>';
        } else {
            echo '<p>Aucun fichier de log trouvé.</p>';
        }
        echo '</div>';
    }
    
    echo '</div>';
}

function miad_dhl_render_admin_page() {
    $active_tab = isset($_GET['tab']) ? sanitize_text_field($_GET['tab']) : 'api_settings';

    // Sauvegarde
    if (isset($_POST['miad_dhl_save'])) {
        update_option('miad_dhl_api_key', sanitize_text_field($_POST['api_key']));
        update_option('miad_dhl_api_mode', sanitize_text_field($_POST['api_mode']));
        update_option('miad_dhl_site_id', trim(sanitize_text_field($_POST['site_id'])));
        update_option('miad_dhl_password', trim(sanitize_text_field($_POST['password'])));
        update_option('miad_dhl_account_number', trim(sanitize_text_field($_POST['account_number'])));
        update_option('miad_dhl_incoterm', sanitize_text_field($_POST['dhl_incoterm']));
        update_option('miad_dhl_shipper_country', sanitize_text_field($_POST['shipper_country']));
        update_option('miad_dhl_shipper_city', sanitize_text_field($_POST['shipper_city']));
        update_option('miad_dhl_shipper_zip', sanitize_text_field($_POST['shipper_zip']));
        update_option('miad_dhl_whatsapp_number', sanitize_text_field($_POST['whatsapp_number']));
        update_option('miad_dhl_tracking_page_url', esc_url_raw($_POST['tracking_page_url']));
        update_option('miad_dhl_email_subject', sanitize_text_field($_POST['email_subject']));
        update_option('miad_dhl_email_body', wp_kses_post($_POST['email_body']));
        update_option('miad_dhl_city_mapping', sanitize_textarea_field($_POST['city_mapping']));
        update_option('miad_dhl_global_calc_method', sanitize_text_field($_POST['global_calc_method']));
        update_option('miad_dhl_shipping_matrix', sanitize_textarea_field($_POST['shipping_matrix']));
        update_option('miad_dhl_fuel_surcharge', floatval($_POST['fuel_surcharge']));
        update_option('miad_dhl_insurance_rate', floatval($_POST['insurance_rate']));
        update_option('miad_dhl_global_margin_pct', floatval($_POST['global_margin_pct']));

        // Sauvegarde des codes HS
        if (isset($_POST['miad_hs_codes'])) {
            $hs_codes_data = [];
            foreach ($_POST['miad_hs_codes'] as $key => $data) {
                if (is_array($data)) {
                    $type = sanitize_text_field($data['type']);
                    $code = preg_replace('/[^0-9.]/', '', sanitize_text_field($data['code'])); // Validation
                    if (!empty($type)) {
                        $hs_codes_data[$type] = ['type' => $type, 'code' => $code];
                    }
                }
            }
            update_option('miad_dhl_hs_codes', $hs_codes_data);
        }

        // Sauvegarde des boîtes personnalisées (Si onglet actif)
        if ($active_tab === 'boxes') {
            $custom_boxes = [];
            if (isset($_POST['custom_boxes']) && is_array($_POST['custom_boxes'])) {
                foreach ($_POST['custom_boxes'] as $id => $box) {
                    $box['vol'] = (float)$box['l'] * (float)$box['w'] * (float)$box['h'];
                    $custom_boxes[$id] = array_map('sanitize_text_field', $box);
                }
            }
            update_option('miad_dhl_custom_boxes', $custom_boxes);
        }

        echo '<div class="updated notice is-dismissible"><p>Configuration DHL sauvegardée avec succès.</p></div>';
    }

    // Test de Connexion
    if (isset($_POST['miad_dhl_test'])) {
        $test_result = miad_dhl_test_connection();
        if ($test_result['success']) {
            echo '<div class="updated notice"><p><strong>✅ Connexion Réussie !</strong> DHL a répondu correctement. (Tarif test : ' . $test_result['message'] . ')</p></div>';
        } else {
            echo '<div class="error notice"><p><strong>❌ Échec de la connexion :</strong> ' . $test_result['message'] . '</p><p>Vérifiez votre Site ID, Mot de passe et Numéro de compte.</p></div>';
        }
    }
    
    $api_key = get_option('miad_dhl_api_key', '');
    $api_mode = get_option('miad_dhl_api_mode', 'production');
    $site_id = get_option('miad_dhl_site_id', '');
    $password = get_option('miad_dhl_password', '');
    $account_number = get_option('miad_dhl_account_number', '');
    $dhl_incoterm = get_option('miad_dhl_incoterm', 'DAP');
    $shipper_country = get_option('miad_dhl_shipper_country', 'SN');
    $shipper_city = get_option('miad_dhl_shipper_city', 'Dakar');
    $shipper_zip = get_option('miad_dhl_shipper_zip', '');
    $whatsapp_number = get_option('miad_dhl_whatsapp_number', '');
    $tracking_page_url = get_option('miad_dhl_tracking_page_url', '');
    $email_subject = get_option('miad_dhl_email_subject', 'Votre commande #{order_id} a été expédiée !');
    $email_body = get_option('miad_dhl_email_body', "Bonjour {customer_name},\n\nBonne nouvelle ! Votre commande #{order_id} a été expédiée et est maintenant en route.\n\nVotre numéro de suivi DHL est : <strong>{tracking_number}</strong>\n\n<a href='{tracking_link}' style='display:inline-block; padding:12px 20px; background-color:#d40511; color:#ffffff; text-decoration:none; border-radius:4px; margin-top:15px; margin-bottom:15px; font-weight:bold;'>Suivre mon colis DHL</a>\n\nMerci pour votre confiance.\n\nCordialement,\nL'équipe {site_name}");
    $city_mapping = get_option('miad_dhl_city_mapping', "SN:Dakar\nGN:Conakry\nCI:Abidjan\nML:Bamako\nBJ:Cotonou\nTG:Lome\nBF:Ouagadougou\nNE:Niamey\nNG:Lagos\nGH:Accra\nCM:Douala\nGA:Libreville\nCG:Brazzaville\nCD:Kinshasa\nMA:Casablanca\nDZ:Alger\nTN:Tunis\nCA:Toronto\nUS:New York\nFR:Paris\nGB:London");
    $global_calc_method = get_option('miad_dhl_global_calc_method', 'api');
    $shipping_matrix = get_option('miad_dhl_shipping_matrix', "0.5:40000\n2:62500\n5:100000\n10:155000\n20:250000");
    $fuel_surcharge = get_option('miad_dhl_fuel_surcharge', '20');
    $global_margin_pct = get_option('miad_dhl_global_margin_pct', '60');
    $insurance_rate = get_option('miad_dhl_insurance_rate', '1');
    ?>
    <div class="wrap">
        <h1>Configuration DHL (Suivi de Colis)</h1>

        <nav class="nav-tab-wrapper">
            <a href="?page=miad-dhl-config&tab=api_settings" class="nav-tab <?php echo $active_tab == 'api_settings' ? 'nav-tab-active' : ''; ?>">Paramètres API</a>
            <a href="?page=miad-dhl-config&tab=email_settings" class="nav-tab <?php echo $active_tab == 'email_settings' ? 'nav-tab-active' : ''; ?>">Emails & Notifications</a>
            <a href="?page=miad-dhl-config&tab=hs_codes" class="nav-tab <?php echo $active_tab == 'hs_codes' ? 'nav-tab-active' : ''; ?>">Codes Douaniers (HS)</a>
            <a href="?page=miad-dhl-config&tab=boxes" class="nav-tab <?php echo $active_tab == 'boxes' ? 'nav-tab-active' : ''; ?>">Gestion des Boîtes</a>
            <a href="?page=miad-dhl-config&tab=tools" class="nav-tab <?php echo $active_tab == 'tools' ? 'nav-tab-active' : ''; ?>">Outils d'Automatisation</a>
            <a href="?page=miad-dhl-config&tab=logs" class="nav-tab <?php echo $active_tab == 'logs' ? 'nav-tab-active' : ''; ?>">Logs & Debug</a>
            <a href="?page=miad-dhl-config&tab=tests" class="nav-tab <?php echo $active_tab == 'tests' ? 'nav-tab-active' : ''; ?>">Tests & Validation 🔴</a>
        </nav>

        <form method="post">
            <?php if ($active_tab === 'api_settings'): ?>
            <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:700px; margin-top:20px;">
                <h3>Paramètres API</h3>

                <!-- NOUVEAU : TOGGLE MATRICE VS API -->
                <div style="background:#f0f6fc; padding:15px; border-left:4px solid #0073aa; margin-bottom:20px;">
                    <p><label><strong>Mode de calcul des frais (Client) :</strong></label><br>
                    <select name="global_calc_method" style="width:100%; font-weight:bold; color:#005826;">
                        <option value="api" <?php selected($global_calc_method, 'api'); ?>>API DHL (Temps réel - Plus lent)</option>
                        <option value="matrix" <?php selected($global_calc_method, 'matrix'); ?>>Matrice MIAD Africa (Poids/Surcharges - Recommandé)</option>
                    </select></p>
                    <span class="description">Le mode <strong>Matrice</strong> évite les appels API au panier, garantissant un site rapide. L'API DHL reste disponible pour créer les étiquettes.</span>
                </div>

                <div class="miad-matrix-settings" style="<?php echo ($global_calc_method === 'matrix') ? '' : 'display:none;'; ?>">
                    <h4>Configuration de la Matrice</h4>
                    <p>
                        <label><strong>Paliers de prix (Poids:Prix) :</strong></label><br>
                        <textarea name="shipping_matrix" rows="5" style="width:100%; font-family:monospace;"><?php echo esc_textarea($shipping_matrix); ?></textarea>
                        <span class="description">Format: <code>poids_max:prix_fcfa</code> (un par ligne). Ex: <code>0.5:40000</code></span>
                    </p>
                    <div style="display:flex; gap:10px;">
                        <p style="flex:1;">
                            <label><strong>Surcharge Carburant (%) :</strong></label><br>
                            <input type="number" name="fuel_surcharge" value="<?php echo esc_attr($fuel_surcharge); ?>" style="width:100%;">
                        </p>
                        <p style="flex:1;">
                            <label><strong>Taux Assurance (%) :</strong></label><br>
                            <input type="number" name="insurance_rate" value="<?php echo esc_attr($insurance_rate); ?>" style="width:100%;">
                        </p>
                        <p style="flex:1;">
                            <label><strong>Marge MIAD Express (%) :</strong></label><br>
                            <input type="number" name="global_margin_pct" value="<?php echo esc_attr($global_margin_pct); ?>" style="width:100%;">
                            <span class="description" style="font-size:11px;">Utilisez une valeur négative (ex: -10) pour appliquer une réduction.</span>
                        </p>
                    </div>
                </div>
                <script>
                    jQuery('select[name="global_calc_method"]').on('change', function() {
                        jQuery('.miad-matrix-settings').toggle(this.value === 'matrix');
                    });
                </script>
                <hr>

                <p>
                    <label><strong>Numéro WhatsApp (Achat Rapide) :</strong></label><br>
                    <input type="text" name="whatsapp_number" value="<?php echo esc_attr($whatsapp_number); ?>" style="width:100%; margin-top:5px;" placeholder="Ex: 221771234567">
                    <span class="description" style="display:block; margin-top:5px; color:#666;">
                        Si rempli, remplace l'estimation des frais de port sur la fiche produit par un bouton "Acheter sur WhatsApp".
                    </span>
                </p>
                <p>
                    <label><strong>Clé API DHL (Consumer Key) :</strong></label><br>
                    <input type="text" name="api_key" value="<?php echo esc_attr($api_key); ?>" style="width:100%; margin-top:5px;" placeholder="Ex: XXXXXXXXXXXXXXXXXXXXXXXXX">
                    <span class="description" style="display:block; margin-top:5px; color:#666;">
                        Obtenez cette clé sur <a href="https://developer.dhl.com/" target="_blank">developer.dhl.com</a> en activant l'API "Shipment Tracking".
                    </span>
                </p>
                <hr>
                <h4>Calcul des Frais (Rate API)</h4>
                <p>
                    <label><strong>Mode de Connexion :</strong></label><br>
                    <select name="api_mode" style="width:100%; margin-top:5px;">
                        <option value="production" <?php selected($api_mode, 'production'); ?>>Production (Réel)</option>
                        <option value="test" <?php selected($api_mode, 'test'); ?>>Test (Sandbox)</option>
                    </select>
                    <span class="description" style="color:#666; font-size:12px;">Si votre Site ID commence par <code>v62xml</code>, c'est souvent le mode <strong>Test</strong>.</span>
                </p>
                <p>
                    <label><strong>Site ID (XML PI) :</strong></label><br>
                    <input type="text" name="site_id" value="<?php echo esc_attr($site_id); ?>" style="width:100%; margin-top:5px;">
                    <span class="description" style="color:#666; font-size:12px;">Identifiant technique reçu par email (ex: v62xml...). Ce n'est PAS votre email de connexion.</span>
                </p>
                <p>
                    <label><strong>Mot de passe API :</strong></label><br>
                    <input type="password" name="password" value="<?php echo esc_attr($password); ?>" style="width:100%; margin-top:5px;">
                    <span class="description" style="color:#666; font-size:12px;">Mot de passe associé au Site ID (souvent long et complexe).</span>
                </p>
                <p>
                    <label><strong>Numéro de Compte Export (Account Number) :</strong></label><br>
                    <input type="text" name="account_number" value="<?php echo esc_attr($account_number); ?>" style="width:100%; margin-top:5px;" placeholder="Ex: 961234567">
                    <span class="description" style="color:#666; font-size:12px;">Utilisez votre compte <strong>Export (970725468)</strong>. Pour les tests, assurez-vous que ce compte est autorisé en Sandbox par DHL.</span>
                </p>
                <p>
                    <label><strong>Incoterm par défaut :</strong></label><br>
                    <select name="dhl_incoterm" style="width:100%; margin-top:5px;">
                        <option value="DAP" <?php selected($dhl_incoterm, 'DAP'); ?>>DAP - Delivered At Place (Client paie les taxes)</option>
                        <option value="DDP" <?php selected($dhl_incoterm, 'DDP'); ?>>DDP - Delivered Duty Paid (MIAD paie les taxes)</option>
                    </select>
                    <span class="description" style="color:#666; font-size:12px;">Détermine qui est responsable du paiement des droits et taxes de douane.</span>
                </p>
                <p class="description" style="color:#005826;">
                    <strong>Note :</strong> Les liens de connexion sont intégrés automatiquement :<br>
                    - Test : <code>https://xmlpitest-ea.dhl.com/XMLShippingServlet</code><br>
                    - Production : <code>https://xmlpi-ea.dhl.com/XMLShippingServlet</code>
                </p>                
            </div>
            <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:700px; margin-top:20px;">
                <div style="display:flex; gap:10px;">
                    <p style="flex:1;"><label><strong>Pays Expéditeur :</strong></label><br>
                    <input type="text" name="shipper_country" value="<?php echo esc_attr($shipper_country); ?>" style="width:100%;" placeholder="Ex: SN"></p>
                    <p style="flex:1;"><label><strong>Ville Expéditeur :</strong></label><br>
                    <input type="text" name="shipper_city" value="<?php echo esc_attr($shipper_city); ?>" style="width:100%;" placeholder="Ex: Dakar"></p>
                    <p style="flex:1;"><label><strong>Code Postal :</strong></label><br>
                    <input type="text" name="shipper_zip" value="<?php echo esc_attr($shipper_zip); ?>" style="width:100%;"></p>
                </div>
                <p>
                    <label><strong>Villes par défaut (Capitales) :</strong></label><br>
                    <textarea name="city_mapping" rows="5" style="width:100%; font-family:monospace;"><?php echo esc_textarea($city_mapping); ?></textarea>
                    <span class="description" style="color:#666; font-size:12px;">Format: <code>CODE_PAYS:Ville</code> (un par ligne). Utilisé pour forcer la ville de départ (ex: Vendeur sans ville ou pour éviter les erreurs de localité).</span>
                </p>
            </div>
            <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:700px; margin-top:20px;">
                <p>
                    <label><strong>URL de la page de suivi :</strong></label><br>
                    <input type="text" name="tracking_page_url" value="<?php echo esc_attr($tracking_page_url); ?>" style="width:100%; margin-top:5px;" placeholder="Ex: https://votresite.com/suivi-colis">
                    <span class="description" style="display:block; margin-top:5px; color:#666;">
                        La page où vous avez mis le shortcode <code>[miad_dhl_track]</code>. Nécessaire pour le bouton "Suivre" dans "Mon Compte".
                    </span>
                </p>
                <p>
                    <strong>Note pour l'expédition :</strong><br>
                    Pour configurer les tarifs de livraison DHL, allez dans <a href="<?php echo admin_url('admin.php?page=wc-settings&tab=shipping'); ?>">WooCommerce > Réglages > Expédition</a> et ajoutez la méthode "MIAD DHL Express".
                </p>
            </div>
            <?php elseif ($active_tab === 'email_settings'): ?>
            <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:700px; margin-top:20px;">
                <h3>Personnalisation de l'Email de Suivi</h3>
                <p>
                    <label><strong>Sujet de l'email :</strong></label><br>
                    <input type="text" name="email_subject" value="<?php echo esc_attr($email_subject); ?>" style="width:100%; margin-top:5px;">
                </p>
                <p>
                    <label><strong>Contenu de l'email (HTML autorisé) :</strong></label><br>
                    <textarea name="email_body" rows="10" style="width:100%; margin-top:5px; font-family:monospace;"><?php echo esc_textarea($body_template); ?></textarea>
                    <textarea name="email_body" rows="10" style="width:100%; margin-top:5px; font-family:monospace;"><?php echo esc_textarea($email_body); ?></textarea>
                </p>
                <p class="description">
                    <strong>Variables disponibles :</strong><br>
                    <code>{customer_name}</code> - Nom du client<br>
                    <code>{order_id}</code> - Numéro de commande<br>
                    <code>{tracking_number}</code> - Numéro de suivi DHL<br>
                    <code>{tracking_link}</code> - Lien de suivi direct<br>
                    <code>{site_name}</code> - Nom de votre site
                </p>
            </div>
            <?php elseif ($active_tab === 'hs_codes'): ?>
                <?php miad_dhl_render_hs_codes_tab(); ?>
            <?php elseif ($active_tab === 'boxes'): ?>
                <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:900px; margin-top:20px;">
                    <h3>Gestion des Boîtes Personnalisées</h3>
                    <p>Ajoutez vos propres formats de boîtes. Si vous assignez une boîte à un produit, ses dimensions seront automatiquement appliquées au produit.</p>
                    
                    <table class="wp-list-table widefat fixed striped" id="miad-boxes-table">
                        <thead><tr><th>ID (Interne)</th><th>Nom de la Boîte</th><th>L (cm)</th><th>l (cm)</th><th>H (cm)</th><th>Poids Max (kg)</th><th>Action</th></tr></thead>
                        <tbody>
                            <?php 
                            $custom_boxes = get_option('miad_dhl_custom_boxes', []);
                            foreach ($custom_boxes as $id => $box): ?>
                            <tr>
                                <td><input type="hidden" name="custom_boxes[<?php echo esc_attr($id); ?>][id]" value="<?php echo esc_attr($id); ?>"><?php echo esc_html($id); ?></td>
                                <td><input type="text" name="custom_boxes[<?php echo esc_attr($id); ?>][name]" value="<?php echo esc_attr($box['name']); ?>" style="width:100%"></td>
                                <td><input type="number" step="0.1" name="custom_boxes[<?php echo esc_attr($id); ?>][l]" value="<?php echo esc_attr($box['l']); ?>" style="width:60px"></td>
                                <td><input type="number" step="0.1" name="custom_boxes[<?php echo esc_attr($id); ?>][w]" value="<?php echo esc_attr($box['w']); ?>" style="width:60px"></td>
                                <td><input type="number" step="0.1" name="custom_boxes[<?php echo esc_attr($id); ?>][h]" value="<?php echo esc_attr($box['h']); ?>" style="width:60px"></td>
                                <td><input type="number" step="0.1" name="custom_boxes[<?php echo esc_attr($id); ?>][max_weight]" value="<?php echo esc_attr($box['max_weight']); ?>" style="width:60px"></td>
                                <td><button type="button" class="button button-link-delete" onclick="this.closest('tr').remove()">Supprimer</button></td>
                            </tr>
                            <?php endforeach; ?>
                        </tbody>
                    </table>
                    <button type="button" class="button" id="miad-add-box" style="margin-top:10px;">Ajouter une boîte</button>
                    <script>jQuery('#miad-add-box').click(function(){ var id='BOX_'+Date.now(); jQuery('#miad-boxes-table tbody').append('<tr><td>'+id+'<input type="hidden" name="custom_boxes['+id+'][id]" value="'+id+'"></td><td><input type="text" name="custom_boxes['+id+'][name]" value="Nouvelle Boîte" style="width:100%"></td><td><input type="number" step="0.1" name="custom_boxes['+id+'][l]" value="10" style="width:60px"></td><td><input type="number" step="0.1" name="custom_boxes['+id+'][w]" value="10" style="width:60px"></td><td><input type="number" step="0.1" name="custom_boxes['+id+'][h]" value="10" style="width:60px"></td><td><input type="number" step="0.1" name="custom_boxes['+id+'][max_weight]" value="2" style="width:60px"></td><td><button type="button" class="button button-link-delete" onclick="this.closest(\'tr\').remove()">Supprimer</button></td></tr>'); });</script>
                </div>
            <?php elseif ($active_tab === 'tools'): ?>
                <?php miad_dhl_render_tools_tab(); ?>
            <?php elseif ($active_tab === 'logs'): ?>
                <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:100%; margin-top:20px;">
                    <h3>Journal des interactions API (Logs)</h3>
                    <p>Consultez ici les requêtes envoyées à DHL et les réponses reçues pour vérifier le bon fonctionnement du système.</p>
                    
                    <form method="post">
                        <input type="hidden" name="miad_clear_log" value="1">
                        <button type="submit" class="button">Vider le journal</button>
                        <a href="<?php echo admin_url('admin-ajax.php?action=miad_dhl_get_logs&_ajax_nonce='.wp_create_nonce('miad_dhl_log_nonce')); ?>" target="_blank" class="button">Voir brut</a>
                    </form>
                    
                    <?php
                    if (isset($_POST['miad_clear_log'])) {
                        file_put_contents(MIAD_DHL_LOG_FILE, '');
                        echo '<div class="updated notice"><p>Journal vidé.</p></div>';
                    }
                    
                    $log_content = file_exists(MIAD_DHL_LOG_FILE) ? miad_dhl_read_log_tail(MIAD_DHL_LOG_FILE) : '';
                    
                    if (empty($log_content)) {
                        echo '<p><em>Aucun log disponible pour le moment. Lancez un test ou simulez un achat pour générer des logs.</em></p>';
                    } else {
                        $entries = explode("--------------------------------------------------", $log_content);
                        $entries = array_reverse($entries);
                        echo '<div style="margin-top:15px; max-height:600px; overflow-y:auto; border:1px solid #ddd;">';
                        echo '<table class="wp-list-table widefat fixed striped">';
                        echo '<thead><tr><th style="width:160px;">Date</th><th>Détails (Requête / Réponse)</th></tr></thead><tbody>';
                        foreach ($entries as $entry) {
                            if (trim($entry) == '') continue;
                            preg_match('/^\[(.*?)\] (.*)/s', trim($entry), $matches);
                            $date = isset($matches[1]) ? $matches[1] : '-';
                            $msg = isset($matches[2]) ? $matches[2] : $entry;
                            echo '<tr><td style="vertical-align:top;">' . esc_html($date) . '</td><td><pre style="white-space: pre-wrap; font-size:11px; margin:0; overflow-x:auto;">' . esc_html($msg) . '</pre></td></tr>';
                        }
                        echo '</tbody></table></div>';
                    }
                    ?>
                </div>
            <?php elseif ($active_tab === 'tests'): ?>
                <?php miad_dhl_render_tests_tab(); ?>
            <?php endif; ?>

            <p style="margin-top:20px;"><input type="submit" name="miad_dhl_save" class="button button-primary" value="Enregistrer la Configuration"></p>
            <p><input type="submit" name="miad_dhl_test" class="button button-secondary" value="Tester la Connexion API (Rate)"></p>
        </form>
        
        <h3>Comment utiliser le suivi ?</h3>
        <p>Utilisez le shortcode <code>[miad_dhl_track]</code> sur une page (ex: "Suivre mon colis") pour afficher le formulaire de recherche.</p>
    </div>
    <?php
}

// --- 1.5 ADMIN : CHAMP TRACKING DANS COMMANDE WOOCOMMERCE ---
add_action('add_meta_boxes', 'miad_dhl_add_order_meta_box');
function miad_dhl_add_order_meta_box() {
    add_meta_box('miad_dhl_actions', 'Actions DHL', 'miad_dhl_render_order_meta_box', 'shop_order', 'side', 'high');
}

function miad_dhl_render_order_meta_box($post) {
    $tracking_number = get_post_meta($post->ID, '_miad_dhl_tracking_number', true);
    $label_url = get_post_meta($post->ID, '_miad_dhl_label_url', true);
    $waybill_doc_url = get_post_meta($post->ID, '_miad_dhl_waybill_doc_url', true);
    $invoice_url = get_post_meta($post->ID, '_miad_dhl_invoice_url', true);
    $pickup_confirmation = get_post_meta($post->ID, '_miad_dhl_pickup_confirmation', true);

    echo '<p><label for="miad_dhl_tracking_number">Numéro de suivi DHL :</label><br>';
    echo '<input type="text" id="miad_dhl_tracking_number" name="miad_dhl_tracking_number" value="' . esc_attr($tracking_number) . '" style="width:100%"></p>';
    
    echo '<div id="miad-dhl-actions" style="display:flex; flex-direction:column; gap:10px;">';
    if (empty($tracking_number)) {
        echo '<label><input type="checkbox" id="miad_dhl_plt" value="1" checked> <strong>Paperless Trade (WY)</strong></label>';
        echo '<button type="button" class="button button-primary" id="miad-create-shipment-btn" onclick="miadCreateShipment(' . $post->ID . ')">Créer une expédition DHL</button>';
    } else {
        if ($label_url) {
            echo '<a href="' . esc_url($label_url) . '" target="_blank" class="button">📄 Étiquette</a> ';
        }
        if ($waybill_doc_url) {
            echo '<a href="' . esc_url($waybill_doc_url) . '" target="_blank" class="button">📄 Waybill Doc (Archive)</a> ';
        }
        if ($invoice_url) {
            echo '<a href="' . esc_url($invoice_url) . '" target="_blank" class="button">📄 Facture</a>';
        }
        if (!$pickup_confirmation) {
            echo '<button type="button" class="button" id="miad-request-pickup-btn" onclick="miadOpenPickupModal(' . $post->ID . ')">Demander un enlèvement</button>';
        } else {
            echo '<p style="font-size:12px; color:green;">✓ Enlèvement confirmé: ' . esc_html($pickup_confirmation) . '</p>';
            echo '<button type="button" class="button button-small" onclick="miadCancelPickup(' . $post->ID . ')">Annuler l\'enlèvement</button>';
        }
    }
    echo '</div>';
    echo '<div id="miad-dhl-spinner" style="display:none; margin:10px auto;" class="spinner is-active"></div>';
    echo '<div id="miad-dhl-response" style="margin-top:10px; font-size:12px; line-height:1.4;"></div>';

    // Modal Pickup
    ?>
    <div id="miad-pickup-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:99999; align-items:center; justify-content:center;">
        <div style="background:#fff; padding:20px; width:400px; max-width:90%; border-radius:5px; box-shadow:0 0 10px rgba(0,0,0,0.3);">
            <h3 style="margin-top:0;">Planifier l'enlèvement (Pickup)</h3>
            <p>
                <label>Date :</label><br>
                <input type="date" id="pickup_date" value="<?php echo miad_dhl_get_next_shipping_date(); ?>" style="width:100%">
            </p>
            <p>
                <label>Heure de mise à dispo (HH:MM) :</label><br>
                <input type="time" id="pickup_time" value="10:00" style="width:100%">
            </p>
            <p>
                <label>Heure de fermeture (HH:MM) :</label><br>
                <input type="time" id="pickup_close_time" value="17:00" style="width:100%">
            </p>
            <p>
                <label>Lieu (ex: Réception) :</label><br>
                <input type="text" id="pickup_location" value="Reception" style="width:100%">
            </p>
            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:15px;">
                <button type="button" class="button" onclick="document.getElementById('miad-pickup-modal').style.display='none'">Annuler</button>
                <button type="button" class="button button-primary" onclick="miadRequestPickup()">Confirmer</button>
            </div>
        </div>
    </div>
    <?php

    // JS pour les appels AJAX
    ?>
    <script>
    var currentOrderId = 0;
    function miadOpenPickupModal(orderId) {
        currentOrderId = orderId;
        document.getElementById('miad-pickup-modal').style.display = 'flex';
    }

    function miadCreateShipment(orderId) {
        var plt = document.getElementById('miad_dhl_plt') ? (document.getElementById('miad_dhl_plt').checked ? 1 : 0) : 1;
        if (!confirm("Créer une expédition DHL pour cette commande ?")) return;
        document.getElementById('miad-dhl-spinner').style.display = 'block';
        document.getElementById('miad-dhl-response').innerHTML = 'Création en cours...';
        jQuery.post(ajaxurl, { action: 'miad_dhl_create_shipment', order_id: orderId, plt: plt }, function(res) {
            document.getElementById('miad-dhl-spinner').style.display = 'none';
            if (res.success) {
                document.getElementById('miad-dhl-response').innerHTML = '<span style="color:green;">' + res.data.message + '</span>';
                window.location.reload();
            } else {
                document.getElementById('miad-dhl-response').innerHTML = '<span style="color:red;">Erreur: ' + res.data.message + '</span>';
            }
        });
    }
    
    function miadRequestPickup() {
        var orderId = currentOrderId;
        var date = document.getElementById('pickup_date').value;
        var time = document.getElementById('pickup_time').value;
        var closeTime = document.getElementById('pickup_close_time').value;
        var location = document.getElementById('pickup_location').value;

        document.getElementById('miad-pickup-modal').style.display = 'none';
        document.getElementById('miad-dhl-spinner').style.display = 'block';
        document.getElementById('miad-dhl-response').innerHTML = 'Demande d\'enlèvement en cours...';

        jQuery.post(ajaxurl, { 
            action: 'miad_dhl_request_pickup', 
            order_id: orderId,
            date: date,
            time: time,
            close_time: closeTime,
            location: location
        }, function(res) {
            document.getElementById('miad-dhl-spinner').style.display = 'none';
            if (res.success) {
                document.getElementById('miad-dhl-response').innerHTML = '<span style="color:green;">' + res.data.message + '</span>';
                setTimeout(function(){ window.location.reload(); }, 1500);
            } else {
                document.getElementById('miad-dhl-response').innerHTML = '<span style="color:red;">Erreur: ' + res.data.message + '</span>';
            }
        });
    }

    function miadCancelPickup(orderId) {
        if(!confirm("Annuler cet enlèvement ?")) return;
        // Logique d'annulation à implémenter si l'API le permet ou simplement reset en base
        alert("Fonctionnalité d'annulation API à venir. Contactez DHL pour annuler.");
    }
    </script>
    <?php
}

add_action('save_post', 'miad_dhl_save_order_meta_box');
/**
 * Fait avancer automatiquement l'étape de livraison MIAD (_miad_delivery_stage,
 * défini dans miad-representative.php) dès qu'un numéro de suivi DHL est posé
 * sur une commande — un numéro de suivi DHL signifie concrètement que le
 * colis vient d'être remis au transporteur international. Sans ça, poser un
 * tracking DHL ne faisait jamais avancer /suivi/{id}/{token} sur le site
 * (demandé le 2026-07-20 : "je veux que le tracking soit automatique").
 * Ne recule jamais une commande déjà plus avancée (ex: déjà "livré").
 */
if (!function_exists('miad_dhl_maybe_advance_stage')) {
    function miad_dhl_maybe_advance_stage($order_id) {
        if (!function_exists('miad_set_delivery_stage') || !function_exists('miad_get_delivery_stage') || !function_exists('miad_delivery_stages')) return;
        $stage_order = array_keys(miad_delivery_stages());
        $target_idx  = array_search('intl_handoff', $stage_order, true);
        $current     = miad_get_delivery_stage($order_id);
        $current_idx = $current ? array_search($current, $stage_order, true) : -1;
        if ($target_idx !== false && $current_idx < $target_idx) {
            miad_set_delivery_stage($order_id, 'intl_handoff');
        }
    }
}

function miad_dhl_save_order_meta_box($post_id) {
    // Vérifie si c'est une commande
    if (get_post_type($post_id) !== 'shop_order') return;
    // Vérifie si c'est une sauvegarde auto
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;

    if (isset($_POST['miad_dhl_tracking_number'])) {
        $new_tn = sanitize_text_field($_POST['miad_dhl_tracking_number']);
        $old_tn = get_post_meta($post_id, '_miad_dhl_tracking_number', true);

        // Si le numéro a changé et n'est pas vide, on met à jour et on notifie
        if ($new_tn !== $old_tn) {
            update_post_meta($post_id, '_miad_dhl_tracking_number', $new_tn);
            if (!empty($new_tn)) {
                miad_dhl_send_notification($post_id, $new_tn);
                miad_dhl_maybe_advance_stage($post_id);
            }
        }
    }
}

// --- 1.9 COLONNE WAYBILL DANS LA LISTE DES COMMANDES ---
add_filter('manage_edit-shop_order_columns', 'miad_dhl_add_order_column');
function miad_dhl_add_order_column($columns) {
    $new_columns = [];
    foreach ($columns as $key => $column) {
        $new_columns[$key] = $column;
        if ($key === 'order_status') {
            $new_columns['miad_dhl_waybill'] = 'DHL Waybill';
                $new_columns['miad_dhl_docs'] = 'Docs';
        }
    }
    return $new_columns;
}

add_action('manage_shop_order_posts_custom_column', 'miad_dhl_order_column_content', 10, 2);
function miad_dhl_order_column_content($column, $post_id) {
    if ($column === 'miad_dhl_waybill') {
        $tn = get_post_meta($post_id, '_miad_dhl_tracking_number', true);
        if ($tn) {
            echo '<a href="https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=' . esc_attr($tn) . '" target="_blank" style="font-weight:bold; color:#d40511;">' . esc_html($tn) . '</a>';
        } else {
            echo '<span style="color:#ccc;">-</span>';
        }
    }
    if ($column === 'miad_dhl_docs') {
        $label = get_post_meta($post_id, '_miad_dhl_label_url', true);
        $waybill = get_post_meta($post_id, '_miad_dhl_waybill_doc_url', true);
        $invoice = get_post_meta($post_id, '_miad_dhl_invoice_url', true);
        
        if ($label) echo '<a href="'.esc_url($label).'" target="_blank" title="Étiquette" style="text-decoration:none; margin-right:5px;"><span class="dashicons dashicons-tag"></span></a>';
        if ($waybill) echo '<a href="'.esc_url($waybill).'" target="_blank" title="Waybill Doc (Archive)" style="text-decoration:none; margin-right:5px; color:#d40511;"><span class="dashicons dashicons-media-text"></span></a>';
        if ($invoice) echo '<a href="'.esc_url($invoice).'" target="_blank" title="Facture Douane" style="text-decoration:none;"><span class="dashicons dashicons-media-spreadsheet"></span></a>';
    }
}

// --- 1.6 FONCTION D'ENVOI D'EMAIL ---
function miad_dhl_send_notification($order_id, $tracking_number) {
    if (!function_exists('wc_get_order') || !class_exists('WC_Emails')) return;
    $order = wc_get_order($order_id);
    if (!$order) return;

    // Récupération des templates personnalisés depuis les options
    $subject_template = get_option('miad_dhl_email_subject', 'Votre commande #{order_id} a été expédiée !');
    $body_template = get_option('miad_dhl_email_body', "Bonjour {customer_name},\n\nBonne nouvelle ! Votre commande #{order_id} a été expédiée et est maintenant en route.\n\nVotre numéro de suivi DHL est : <strong>{tracking_number}</strong>\n\n<a href='{tracking_link}' style='display:inline-block; padding:12px 20px; background-color:#d40511; color:#ffffff; text-decoration:none; border-radius:4px; margin-top:15px; margin-bottom:15px; font-weight:bold;'>Suivre mon colis DHL</a>\n\nMerci pour votre confiance.\n\nCordialement,\nL'équipe {site_name}");

    $to = $order->get_billing_email();
    
    // Création du lien de suivi
    $tracking_link = 'https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=' . $tracking_number;
    
    // Remplacement des variables
    $replacements = [
        '{customer_name}'   => $order->get_billing_first_name(),
        '{order_id}'        => $order->get_order_number(), // Utiliser get_order_number() est plus propre
        '{tracking_number}' => $tracking_number,
        '{tracking_link}'   => esc_url($tracking_link),
        '{site_name}'       => get_bloginfo('name'),
    ];

    $subject = str_replace(array_keys($replacements), array_values($replacements), $subject_template);
    $body = str_replace(array_keys($replacements), array_values($replacements), $body_template);

    // Pour un rendu HTML propre, on convertit les sauts de ligne en <br>
    $message_html = nl2br($body);

    // On utilise le template WooCommerce pour un email plus professionnel
    $mailer = WC()->mailer();
    $email_heading = str_replace('{order_id}', $order->get_order_number(), 'Votre commande #{order_id} est en route !');
    $email_content = $mailer->wrap_message($email_heading, $message_html);

    $headers = "Content-Type: text/html\r\n";    // Utilisation de la fonction mail de WC pour la compatibilité
    $mailer->send($to, $subject, $email_content, $headers, []);
    
    $order->add_order_note('Notification de suivi DHL envoyée au client (' . $tracking_number . ').');
}

// --- NOUVEAU : 1.5B ADMIN : CHAMP CODE DOUANIER (HS) SUR FICHE PRODUIT ---
add_action( 'woocommerce_product_options_shipping', 'miad_dhl_add_custom_shipping_fields' );
function miad_dhl_add_custom_shipping_fields() {
    echo '<div class="options_group">';
    woocommerce_wp_text_input(
        array(
            'id'          => '_miad_hs_code',
            'label'       => __( 'Code Douanier (HS Code)', 'miad-dhl' ),
            'placeholder' => 'Ex: 6109.10',
            'desc_tip'    => 'true',
            'description' => __( 'Le code du Système Harmonisé pour le dédouanement international.', 'miad-dhl' ),
        )
    );

    woocommerce_wp_select(
        array(
            'id'      => '_miad_origin_country',
            'label'   => __( 'Pays d\'Origine (Fabrication)', 'miad-dhl' ),
            'options' => array_merge( array( '' => __( 'Défaut (Pays du vendeur)', 'miad-dhl' ) ), WC()->countries->get_countries() ),
            'desc_tip' => true,
            'description' => __( 'Pays où le produit a été fabriqué. Important pour la douane.', 'miad-dhl' ),
        )
    );

    // NOUVEAU : Sélecteur de Boîte DHL
    woocommerce_wp_select(
        array(
            'id'      => '_miad_preferred_box',
            'label'   => __( 'Emballage DHL Recommandé', 'miad-dhl' ),
            'options' => array_merge(
                array('' => 'Automatique (Selon poids/dim)'),
                Miad_DHL_Box_Packer::get_box_list()
            ),
            'desc_tip' => true,
            'description' => __( 'Force l\'utilisation de ce type de boîte (ou plus grand) pour ce produit.', 'miad-dhl' ),
        )
    );

    echo '</div>';
}

add_action( 'woocommerce_process_product_meta', 'miad_dhl_save_custom_shipping_fields' );
function miad_dhl_save_custom_shipping_fields( $post_id ) {
    $hs_code = isset( $_POST['_miad_hs_code'] ) ? sanitize_text_field( $_POST['_miad_hs_code'] ) : '';
    // Validation : Chiffres et points uniquement
    $hs_code = preg_replace('/[^0-9.]/', '', $hs_code);
    update_post_meta( $post_id, '_miad_hs_code', $hs_code );
    $origin_country = isset( $_POST['_miad_origin_country'] ) ? sanitize_text_field( $_POST['_miad_origin_country'] ) : '';
    update_post_meta( $post_id, '_miad_origin_country', $origin_country );
    $pref_box = isset( $_POST['_miad_preferred_box'] ) ? sanitize_text_field( $_POST['_miad_preferred_box'] ) : '';
    update_post_meta( $post_id, '_miad_preferred_box', $pref_box );

    // NOUVEAU : Appliquer les dimensions de la boîte au produit si une boîte est sélectionnée
    if (!empty($pref_box) && class_exists('Miad_DHL_Box_Packer')) {
        $packer = new Miad_DHL_Box_Packer();
        $box = $packer->get_box($pref_box);
        if ($box) {
            $product = wc_get_product($post_id);
            $product->set_length($box['l']);
            $product->set_width($box['w']);
            $product->set_height($box['h']);
            $product->save();
        }
    }
}

// --- NOUVEAU : 1.5C ADMIN : ONGLET GESTION CODES HS ---
function miad_dhl_render_hs_codes_tab() {
    $hs_codes = get_option('miad_dhl_hs_codes', []);
    ?>
    <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:700px; margin-top:20px;">
        <h3>Gestion des Codes Douaniers (HS)</h3>
        <p>Centralisez ici les codes HS pour vos types de produits courants. Ils apparaîtront en suggestion sur la fiche produit.</p>
        
        <div class="notice notice-info inline" style="margin: 10px 0 20px 0; padding: 10px; border-left-color: #0073aa;">
            <p><strong>🔍 Comment trouver le bon code ?</strong></p>
            <p>Les codes HS (Système Harmonisé) sont universels (6 premiers chiffres). Voici des outils pour les trouver :</p>
            <ul style="list-style: disc; margin-left: 20px; margin-top: 5px;">
                <li><a href="https://tas.dhl.com/" target="_blank">DHL Trade Automation Services</a> (Recommandé)</li>
                <li><a href="https://www.tariffnumber.com/" target="_blank">TariffNumber.com</a> (Recherche rapide par mot-clé)</li>
            </ul>
        </div>

        <table class="wp-list-table widefat" id="miad-hs-table">
            <thead><tr><th>Type de Produit (Ex: T-shirt Coton)</th><th>Code HS (Ex: 6109.10)</th><th>Action</th></tr></thead>
            <tbody>
                <?php foreach ($hs_codes as $type => $code): if(empty($type)) continue; ?>
                <tr>
                    <td><input type="text" name="miad_hs_codes[<?php echo esc_attr($type); ?>][type]" value="<?php echo esc_attr($type); ?>" class="large-text"></td>
                    <td><input type="text" name="miad_hs_codes[<?php echo esc_attr($type); ?>][code]" value="<?php echo esc_attr(is_array($code) ? $code['code'] : $code); ?>" class="regular-text miad-hs-input"></td>
                    <td><button type="button" class="button button-link-delete" onclick="this.closest('tr').remove()">Supprimer</button></td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <button type="button" class="button" id="miad-add-hs-row" style="margin-top:10px;">Ajouter une ligne</button>
        
        <script>
        jQuery(document).ready(function($){
            // Validation JS en temps réel
            $(document).on('input', '.miad-hs-input', function() {
                this.value = this.value.replace(/[^0-9.]/g, '');
            });
            
            $('#miad-add-hs-row').click(function(){
                var row = '<tr><td><input type="text" name="miad_hs_codes[new_'+Date.now()+'][type]" class="large-text"></td><td><input type="text" name="miad_hs_codes[new_'+Date.now()+'][code]" class="regular-text miad-hs-input"></td><td><button type="button" class="button button-link-delete" onclick="this.closest(\'tr\').remove()">Supprimer</button></td></tr>';
                $('#miad-hs-table tbody').append(row);
            });
        });
        </script>
    </div>
    <?php
}

// --- 1.7 API DHL RATE (CALCUL PRIX) avec gestion douane ---
function miad_dhl_get_rate_api($weight, $length, $width, $height, $value, $hs_code, $to_country, $to_city, $to_zip, $from_country = null, $from_city = null, $from_zip = null, $return_all = false, $env = null) {
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $api_mode = $env ?: get_option('miad_dhl_api_mode', 'production');
    $account = get_option('miad_dhl_account_number');
    
    // Règle d'or #3 : Calcul du poids volumétrique pour information et débogage
    $volumetric_weight = ($length * $width * $height) / 5000;
    miad_dhl_log("RATE API: Actual Weight: {$weight}kg, Volumetric Weight: {$volumetric_weight}kg. DHL will charge based on the greater value.");

    // Gestion intelligente de l'origine (Vendeur vs Admin)
    $def_country = get_option('miad_dhl_shipper_country', 'SN');
    if (empty($def_country)) $def_country = 'SN'; // Sécurité anti-bug
    $def_city = get_option('miad_dhl_shipper_city', 'Dakar');
    $def_zip = get_option('miad_dhl_shipper_zip', '');

    // Chargement du mapping (Capitales) pour Origine ET Destination
    $mapping_raw = get_option('miad_dhl_city_mapping', "SN:Dakar\nGN:Conakry\nCI:Abidjan\nML:Bamako\nBJ:Cotonou\nTG:Lome\nBF:Ouagadougou\nNE:Niamey\nNG:Lagos\nGH:Accra\nCM:Douala\nGA:Libreville\nCG:Brazzaville\nCD:Kinshasa\nMA:Casablanca\nDZ:Alger\nTN:Tunis\nCA:Toronto\nUS:New York\nFR:Paris\nGB:London");
    $capitals = [];
    foreach(explode("\n", $mapping_raw) as $line) {
        $parts = explode(':', $line);
        if(count($parts) == 2) {
            $capitals[trim(strtoupper($parts[0]))] = trim($parts[1]);
        }
    }

    if ($from_country) $from_country = trim(strtoupper($from_country));
    if ($to_country) $to_country = trim(strtoupper($to_country));

    // --- NOUVELLE LOGIQUE ORIGINE (CORRIGÉE) ---
    if (empty($from_country)) {
        // Cas 1: Pas de pays d'origine (ex: produit admin), on utilise les réglages par défaut.
        $from_country = $def_country;
        $from_city = $def_city;
        $from_zip = $def_zip;
    } else {
        // Cas 2: Le pays du vendeur est connu.
        if (empty($from_city)) { // Si la ville du vendeur n'est pas renseignée...
            if (isset($capitals[$from_country])) {
                // ...on utilise la capitale mappée pour ce pays pour éviter une incohérence.
                $from_city = $capitals[$from_country];
            }
        }
    }

    // Correction Destination : Si la ville est manquante (ex: Panier), on tente de deviner la capitale
    if (empty($to_city) && isset($capitals[$to_country])) {
        $to_city = $capitals[$to_country];
    }

    // SÉCURITÉ : L'API DHL (GET /rates) requiert une ville de destination ('destinationCityName').
    // Si ce champ est vide (par ex. si le client n'a pas encore rempli la ville au checkout),
    // l'appel API échouera. On interrompt la fonction ici pour éviter une erreur.
    // WooCommerce affichera alors "Aucun mode d'expédition...", invitant le client à compléter son adresse.
    if (empty($to_city)) {
        miad_dhl_log("RATE API ABORTED: Destination city is missing for country " . $to_country);
        return false;
    }

    // --- NOUVEAU : GESTION DU CACHE POUR LA VITESSE ---
    // Crée une clé unique pour cette combinaison de paramètres
    $cache_key = 'dhl_rate_v2_' . md5(json_encode(func_get_args()));
    /* CACHE DÉSACTIVÉ SUR DEMANDE (Panier & Rating)
    $cached_rate = get_transient($cache_key);
    if ($cached_rate !== false) {
        miad_dhl_log("RATE API CACHE HIT for key: $cache_key");
        return $cached_rate;
    }
    */

    if (!$site_id || !$password || !$account) return false;

    $date = miad_dhl_get_next_shipping_date();
    $is_dutiable = ($from_country !== $to_country);
    
    // NOUVEAU : Boucle de tentatives pour gérer l'erreur 996 (service non disponible)
    for ($i = 0; $i < 5; $i++) { // On essaie jusqu'à 5 jours plus tard
        $current_date = date('Y-m-d', strtotime($date . " +$i days"));

        // --- CONSTRUCTION REQUÊTE JSON (GET /rates) ---
        $url = ($api_mode === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/rates' : 'https://express.api.dhl.com/mydhlapi/rates';

        $params = [
            'accountNumber' => $account,
            'originCountryCode' => $from_country,
            'originCityName' => $from_city,
            'destinationCountryCode' => $to_country,
            'destinationCityName' => $to_city,
            'weight' => ($weight ?: 0.5),
            'length' => ($length ?: 10),
            'width' => ($width ?: 10),
            'height' => ($height ?: 10),
            'plannedShippingDate' => $current_date,
            'isCustomsDeclarable' => $is_dutiable ? 'true' : 'false',
            'unitOfMeasurement' => 'metric'
        ];

        if ($from_zip) $params['originPostalCode'] = $from_zip;
        if ($to_zip) $params['destinationPostalCode'] = $to_zip;

        if ($is_dutiable && $value > 0) {
            $params['declaredValue'] = $value;
            $params['declaredValueCurrency'] = function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : 'XOF';
        }

        $query_url = add_query_arg($params, $url);
        miad_dhl_log("RATE API REQUEST (JSON) to $query_url");

        $response = wp_remote_get($query_url, [
            'timeout' => 90,
            'sslverify' => false,
            'headers' => miad_dhl_get_headers($site_id, $password)
        ]);

        if (is_wp_error($response)) {
            miad_dhl_log("RATE API ERROR: " . $response->get_error_message());
            return false; // Erreur réseau, on arrête
        }

        $body = wp_remote_retrieve_body($response);
        miad_dhl_log("RATE API RESPONSE (JSON):\n" . $body);
        
        $data = json_decode($body, true);

        // Gestion erreur 996 (Aucun service)
        $is_error_996 = false;
        if (isset($data['detail']) && strpos($data['detail'], '996:') !== false) {
            $is_error_996 = true;
        }

        if ($is_error_996) {
            miad_dhl_log("Error 996 on $current_date. Retrying for next day...");
            if ($i < 4) {
                continue; // On passe au jour suivant
            } else {
                // Après 5 tentatives, on abandonne
                return ['error_code' => '996', 'message' => 'Aucun service disponible pour cette date. Veuillez essayer un jour ouvré.'];
            }
        }

        // Si la réponse est valide (pas d'erreur 996), on traite et on sort de la boucle
        if (isset($data['products']) && !empty($data['products'])) {
            break;
        } else {
            // Autre type d'erreur, on arrête
            return false;
        }
    }

    if (isset($data) && isset($data['products']) && !empty($data['products'])) {
        // Règle d'or #2 : FILTRAGE DES PRODUITS (Exclusion des services prioritaires coûteux)
        $valid_products = [];
        $forbidden_codes = ['Q', 'K', 'T', 'L', 'M', 'E', 'Y']; // Services prioritaires (9h, 10h30, 12h, Medical)
        $excluded_names = ['DOMESTIC EXPRESS', 'EXPRESS EASY']; // Noms à exclure en plus

        foreach ($data['products'] as $product) {
            $product_code = isset($product['productCode']) ? strtoupper($product['productCode']) : '';
            $product_name = isset($product['productName']) ? strtoupper($product['productName']) : '';

            // Règle 1: Exclure par code produit
            if (in_array($product_code, $forbidden_codes)) {
                miad_dhl_log("Product excluded by code: $product_code ($product_name)");
                continue;
            }

            // Règle 2: Exclure par nom
            $is_excluded_by_name = false;
            foreach ($excluded_names as $excluded) {
                if (strpos($product_name, $excluded) !== false) {
                    miad_dhl_log("Product excluded by name: $product_name");
                    $is_excluded_by_name = true;
                    break;
                }
            }
            if ($is_excluded_by_name) continue;

            $cost = 0;
            $currency = '';
            if (isset($product['totalPrice'])) {
                // Recherche intelligente du prix (BILLC > WEB > BASEC)
                $prices_map = [];
                foreach ($product['totalPrice'] as $price) {
                    if (isset($price['currencyType'])) {
                        $prices_map[$price['currencyType']] = $price;
                    }
                }

                // Fonction locale pour extraire le prix (supporte breakdown)
                $extract_price = function($p_obj) {
                    if (isset($p_obj['price']) && $p_obj['price'] > 0) return $p_obj['price'];
                    if (isset($p_obj['breakdown']) && !empty($p_obj['breakdown'])) {
                        foreach($p_obj['breakdown'] as $bd) {
                            if (isset($bd['price']) && $bd['price'] > 0) return $bd['price'];
                        }
                    }
                    return 0;
                };

                // Priorité des devises
                $target_type = isset($prices_map['BILLC']) ? 'BILLC' : (isset($prices_map['WEB']) ? 'WEB' : (isset($prices_map['BASEC']) ? 'BASEC' : ''));
                
                if ($target_type) {
                    $cost = $extract_price($prices_map[$target_type]);
                    $currency = $prices_map[$target_type]['priceCurrency'];
                }
            }

            if ($cost > 0) {
                $date = $product['deliveryCapabilities']['deliveryDateAndTime'] ?? ($product['deliveryCapabilities']['estimatedDeliveryDateAndTime'] ?? '');
                $p_name = $product['productName'] ?? $product['productCode'];
                $p_code = $product['productCode'] ?? '';
                $valid_products[] = ['name' => $p_name, 'cost' => $cost, 'date' => $date, 'code' => $p_code, 'currency' => $currency];
                miad_dhl_log("Product accepted: $p_name - Cost: $cost $currency");
            } else {
                miad_dhl_log("Product skipped (Zero Cost): " . ($product['productName'] ?? 'Unknown'));
            }
        }

        // Tri par prix croissant
        usort($valid_products, function($a, $b) { return $a['cost'] <=> $b['cost']; });

        if ($return_all) {
             // set_transient($cache_key, $valid_products, 1 * HOUR_IN_SECONDS); // Cache désactivé
             return $valid_products;
        }

        if (!empty($valid_products)) {
            $best = $valid_products[0];
            $result = array('cost' => $best['cost'], 'date' => $best['date']);
            // set_transient($cache_key, $result, 1 * HOUR_IN_SECONDS); // Cache désactivé
            miad_dhl_log("RATE API CACHE SET for key: $cache_key");
            return $result;
        }
    }
    
    return false;
}

// --- 1.7.1 FONCTION DE TEST CONNEXION ---
function miad_dhl_test_connection() {
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $api_mode = 'test'; // On teste toujours sur l'environnement de test par défaut
    $account = get_option('miad_dhl_account_number');
    
    if (!$site_id || !$password || !$account) {
        return ['success' => false, 'message' => 'Veuillez d\'abord remplir et enregistrer le Site ID, le Mot de passe et le Numéro de compte.'];
    }

    // Récupération des infos expéditeur avec fallback strict pour le test
    $s_country = get_option('miad_dhl_shipper_country'); if(empty($s_country)) $s_country = 'SN';
    $s_city = get_option('miad_dhl_shipper_city'); if(empty($s_city)) $s_city = 'Dakar';
    $s_zip = get_option('miad_dhl_shipper_zip', '');

    // --- TEST CONNEXION VIA JSON (GET /rates) ---
    $url = ($api_mode === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/rates' : 'https://express.api.dhl.com/mydhlapi/rates';

    $params = [
        'accountNumber' => $account,
        'originCountryCode' => $s_country,
        'originCityName' => $s_city,
        'destinationCountryCode' => 'US',
        'destinationCityName' => 'New York',
        'destinationPostalCode' => '10001',
        'weight' => 1,
        'length' => 10, 'width' => 10, 'height' => 10, // These are test values
        'plannedShippingDate' => miad_dhl_get_next_shipping_date(),
        'isCustomsDeclarable' => 'false',
        'unitOfMeasurement' => 'metric'
    ];
    if ($s_zip) $params['originPostalCode'] = $s_zip;

    $query_url = add_query_arg($params, $url);

    miad_dhl_log("TEST CONNECTION REQUEST (JSON) to $query_url");

    $response = wp_remote_get($query_url, [
        'timeout' => 90,
        'sslverify' => false,
        'headers' => miad_dhl_get_headers($site_id, $password)
    ]);

    if (is_wp_error($response)) {
        miad_dhl_log("TEST CONNECTION ERROR: " . $response->get_error_message());
        return ['success' => false, 'message' => $response->get_error_message()];
    }

    $code = wp_remote_retrieve_response_code($response);
    if ($code === 429) {
        return ['success' => false, 'message' => '⛔ Trop de tentatives (Erreur 429). DHL bloque temporairement les requêtes. Attendez 15-30 minutes ou passez en mode Production.'];
    }
    if ($code >= 500) {
        return ['success' => false, 'message' => '⚠️ Serveur DHL en maintenance ou surchargé (' . $code . '). Réessayez plus tard.'];
    }

    $body = wp_remote_retrieve_body($response);
    miad_dhl_log("TEST CONNECTION RESPONSE (JSON):\n" . $body);
    
    $data = json_decode($body, true);

    if (isset($data['products'])) {
        return ['success' => true, 'message' => '✅ Connexion OK ! (Produits trouvés)'];
    }
    
    if (isset($data['detail'])) {
        return ['success' => false, 'message' => 'DHL Erreur : ' . $data['detail']];
    }
    if (isset($data['title'])) {
        return ['success' => false, 'message' => 'DHL Erreur : ' . $data['title']];
    }

    return ['success' => false, 'message' => 'Réponse vide ou invalide de DHL. Vérifiez votre connexion internet ou le mode (Test/Prod).'];
}

// --- 1.7.2 FONCTION DE LOG ---
function miad_dhl_log($message) {
    $upload_dir = wp_upload_dir();
    $file = $upload_dir['basedir'] . '/miad_dhl_debug.log';
    $time = current_time('mysql');
    file_put_contents($file, "[$time] $message\n--------------------------------------------------\n", FILE_APPEND);
}

add_action('wp_ajax_miad_get_dhl_rate', 'miad_ajax_get_dhl_rate');
add_action('wp_ajax_nopriv_miad_get_dhl_rate', 'miad_ajax_get_dhl_rate');

// Handler pour sauvegarder l'adresse
add_action('wp_ajax_miad_dhl_save_address', 'miad_dhl_save_address_handler');
function miad_dhl_save_address_handler() {
    if (!is_user_logged_in()) wp_send_json_error('Non connecté');
    $user_id = get_current_user_id();
    $customer = new WC_Customer($user_id);
    $address = [
        'address_1'  => sanitize_text_field($_POST['address_1']),
        'city'       => sanitize_text_field($_POST['city']),
        'postcode'   => sanitize_text_field($_POST['postcode']),
        'country'    => sanitize_text_field($_POST['country']),
        'phone'      => sanitize_text_field($_POST['phone']),
    ];
    $customer->set_props([
        'shipping_address_1' => $address['address_1'], 'shipping_city' => $address['city'], 'shipping_postcode' => $address['postcode'], 'shipping_country' => $address['country'],
        'billing_address_1' => $address['address_1'], 'billing_city' => $address['city'], 'billing_postcode' => $address['postcode'], 'billing_country' => $address['country'], 'billing_phone' => $address['phone']
    ]);
    $customer->save();
    wp_send_json_success();
}

function miad_ajax_get_dhl_rate() {
    $product_id = intval($_POST['product_id']);
    $product = wc_get_product($product_id);
    if (!$product) wp_send_json_error();

    $country = isset($_POST['country']) ? sanitize_text_field($_POST['country']) : '';
    $city = isset($_POST['city']) ? sanitize_text_field($_POST['city']) : '';
    $zip = isset($_POST['zip']) ? sanitize_text_field($_POST['zip']) : '';

    if (empty($country)) {
        if (isset($_SERVER['HTTP_CF_IPCOUNTRY']) && strlen($_SERVER['HTTP_CF_IPCOUNTRY']) === 2 && $_SERVER['HTTP_CF_IPCOUNTRY'] !== 'XX') {
            $country = sanitize_text_field($_SERVER['HTTP_CF_IPCOUNTRY']);
        } elseif (WC()->customer && WC()->customer->get_shipping_country()) {
            $country = WC()->customer->get_shipping_country();
        } else {
            $country = wc_get_base_location()['country'];
        }
    }
    
    $weight = (float) $product->get_weight();
    $length = (float) $product->get_length();
    $width = (float) $product->get_width();
    $height = (float) $product->get_height();
    $value = (float) $product->get_price();
    $hs_code = get_post_meta($product_id, '_miad_hs_code', true);

    $origin_country = null;
    $origin_city = null;
    $origin_zip = null;
    
    if (function_exists('dokan_get_store_info')) {
        $vendor_id = get_post_field('post_author', $product_id);
        $store_info = dokan_get_store_info($vendor_id);
        $origin_country = $store_info['address']['country'] ?? null;
        $origin_city = $store_info['address']['city'] ?? null;
        $origin_zip = $store_info['address']['zip'] ?? null;
    }

    // NOUVEAU : GESTION LIVRAISON LOCALE (Même pays)
    if ($origin_country && $origin_country === $country) {
        $local_html = '<strong>Livraison Locale</strong>';
        $local_html .= '<br><small style="color:#333;">Veuillez contacter le vendeur ou un livreur local pour organiser la livraison.</small>';
        wp_send_json_success(['html' => $local_html]);
        return;
    }

    $rate_info = miad_dhl_get_rate_api($weight, $length, $width, $height, $value, $hs_code, $country, $city, $zip, $origin_country, $origin_city, $origin_zip, true, 'production');

    $global_margin_pct = (float) get_option('miad_dhl_global_margin_pct', 60);

    // Gestion erreur 996
    if (isset($rate_info['error_code']) && $rate_info['error_code'] === '996') {
        wp_send_json_success(['html' => '<div class="miad-dhl-error" style="color:#d40511; padding:10px; border:1px solid #d40511; border-radius:4px; background:#fff5f5;">' . esc_html($rate_info['message']) . '</div>']);
        return;
    }

    // Appliquer la marge globale sur tous les tarifs retournés
    if ($rate_info && is_array($rate_info) && $global_margin_pct != 0) {
        foreach ($rate_info as $k => $v) {
            $rate_info[$k]['cost'] += $v['cost'] * ($global_margin_pct / 100);
            if ($rate_info[$k]['cost'] < 0) $rate_info[$k]['cost'] = 0;
        }
    }

    $is_fr = (strpos(get_locale(), 'fr') === 0);

    if ($rate_info && is_array($rate_info) && !empty($rate_info) && isset($rate_info[0]['cost'])) {
        
        usort($rate_info, function($a, $b) {
            return $a['cost'] <=> $b['cost'];
        });

        $cheapest = $rate_info[0];
        
        $cost = $cheapest['cost'];
        $date_str = $cheapest['date'];
        $formatted_cost = wc_price($cost);
        $country_name = WC()->countries->countries[$country] ?? $country;
        
        $delivery_text = "";
        if ($date_str) {
            $delivery_timestamp = strtotime($date_str . ' +2 days');
            $date_format = $is_fr ? 'l j F' : 'l, F j';
            $date_formatted = date_i18n($date_format, $delivery_timestamp);
            $delivered_label = $is_fr ? 'Livré le' : 'Delivered on';
            $delivery_text = "<br><small style='color:#d40511; font-weight:bold;'>$delivered_label $date_formatted</small>";
            $delivery_text .= "<br><small style='color:#666;'>Expédié par DHL Express. Suivi inclus.</small>";
        }
        $express_label = $is_fr ? 'Livraison vers' : 'Delivery to';
        $html = "$express_label <strong>$country_name</strong> : <span style='color:#d40511; font-weight:bold;'>$formatted_cost</span>$delivery_text";

        if (count($rate_info) > 1) {
            $modal_id = 'miad-shipping-modal-' . uniqid();
            $html .= ' <a href="#" onclick="event.preventDefault(); document.getElementById(\''.$modal_id.'\').style.display=\'flex\';" style="font-size:11px; color:#0073aa; text-decoration:none; margin-left:5px;">' . ($is_fr ? 'Autres options' : 'More options') . '</a>';
            
            $modal_html = '<div id="'.$modal_id.'" class="miad-shipping-modal">';
            $modal_html .= '<div class="miad-modal-content">';
            $modal_html .= '<span class="miad-modal-close" onclick="this.parentElement.parentElement.style.display=\'none\'">&times;</span>';
            $modal_html .= '<h4>' . ($is_fr ? 'Choisissez une option de livraison' : 'Choose a delivery option') . '</h4>';
            $modal_html .= '<div class="miad-shipping-options-list">';

            foreach ($rate_info as $index => $option) {
                $opt_cost = wc_price($option['cost']);
                $opt_date_str = $option['date'];
                $opt_date_formatted = '';
                if ($opt_date_str) {
                    $opt_delivery_timestamp = strtotime($opt_date_str . ' +2 days');
                    $opt_date_formatted = date_i18n($is_fr ? 'l j F' : 'l, F j', $opt_delivery_timestamp);
                }
                
                $modal_html .= '<div class="miad-dhl-option-card" style="border-bottom:1px solid #eee; padding:15px 0; display:flex; justify-content:space-between; align-items:center;">';
                $modal_html .= '<div>';
                $modal_html .= '<div style="font-weight:bold; font-size:15px; color:#333;">' . esc_html($option['name']) . '</div>';
                $modal_html .= '<div style="color:#666; font-size:13px;">' . ($opt_date_formatted ? 'Livraison estimée : ' . $opt_date_formatted : '') . '</div>';
                $modal_html .= '<div style="color:#d40511; font-weight:bold; font-size:14px; margin-top:4px;">' . $opt_cost . '</div>';
                $modal_html .= '</div>';
                $modal_html .= '<button type="button" class="button" style="background:#0073aa; color:#fff; border:none;" onclick="miadSelectShippingOption(\''.esc_js($option['code']).'\', \''.$option['cost'].'\', \''.esc_js(strip_tags($opt_cost)).'\', \''.esc_js($opt_date_formatted).'\', \''.esc_js($option['name']).'\', \''.$modal_id.'\')">Sélectionner</button>';
                $modal_html .= '</div>';
            }

            $modal_html .= '</div>';
            $modal_html .= '</div></div>';
            
            $html .= $modal_html;
        }

        wp_send_json_success(['html' => $html]);

    } else {
        $avail_label = $is_fr ? 'Livraison disponible vers' : 'Delivery available to';
        $calc_label = $is_fr ? 'Prix calculé au panier.' : 'Price calculated at checkout.';
        $html = "$avail_label <strong>" . (WC()->countries->countries[$country] ?? $country) . "</strong>. $calc_label";
        wp_send_json_success(['html' => $html]);
    }
}

// --- 2. FONCTION DE REQUÊTE API DHL ---
function miad_dhl_get_tracking_info($tracking_number, $env = null) {
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $api_mode = $env ?: get_option('miad_dhl_api_mode', 'production');

    if ($site_id && $password) {
        // Utilisation MyDHL API (Express) - Recommandé
        $base_url = ($api_mode === 'test') ? 'https://express.api.dhl.com/mydhlapi/test' : 'https://express.api.dhl.com/mydhlapi';

        $tracking_numbers = array_map('trim', explode(',', $tracking_number));
        $params = [];

        $is_piece_id = false;
        foreach ($tracking_numbers as $tn_single) {
            if (strlen($tn_single) > 11) {
                $is_piece_id = true;
                break;
            }
        }

        if (count($tracking_numbers) > 1 || $is_piece_id) {
            $url = $base_url . '/tracking';
            $param_name = $is_piece_id ? 'pieceTrackingNumber' : 'shipmentTrackingNumber';
            $params[$param_name] = implode(',', $tracking_numbers);
            $url = add_query_arg($params, $url);
        } else {
            $url = $base_url . '/shipments/' . urlencode($tracking_numbers[0]) . '/tracking';
        }
        
        $args = [
            'headers' => miad_dhl_get_headers($site_id, $password),
            'timeout' => 15
        ];
    } else {
        // Fallback Unified Tracking (Ancien)
        $api_key = get_option('miad_dhl_api_key');
        if (!$api_key) return ['error' => 'Erreur : Credentials DHL manquants.'];
        
        $url = 'https://api-eu.dhl.com/track/shipments?trackingNumber=' . urlencode($tracking_number);
        $args = [
            'headers' => ['DHL-API-Key' => $api_key, 'Accept' => 'application/json'],
            'timeout' => 15
        ];
    }

    $response = wp_remote_get($url, $args);

    if (is_wp_error($response)) {
        return ['error' => 'Erreur de connexion : ' . $response->get_error_message()];
    }

    $code = wp_remote_retrieve_response_code($response);
    $body = wp_remote_retrieve_body($response);
    $data = json_decode($body, true);

    if ($code !== 200) {
        // Gestion des erreurs DHL (ex: 404 Not Found)
        if (isset($data['detail'])) return ['error' => $data['detail']];
        if (isset($data['title'])) return ['error' => $data['title']];
        return ['error' => 'Impossible de récupérer les informations (Code ' . $code . ').'];
    }

    if (isset($data['shipments']) && !empty($data['shipments'])) {
        return $data['shipments'][0];
    }
    // MyDHL API structure
    if (isset($data['shipments'])) {
        return $data['shipments'][0];
    }
    
    return ['error' => 'Aucun colis trouvé avec ce numéro.'];
}

// --- 4. FONCTIONS DE RENDU (RÉUTILISABLES) ---

/**
 * Génère le HTML de la timeline de suivi.
 */
function miad_dhl_render_timeline_html($result) {
    ob_start();
    ?>
    <div class="miad-dhl-result">
        <?php if (isset($result['error'])): ?>
            <div class="miad-dhl-error">
                <i class="fas fa-exclamation-circle"></i> <?php echo esc_html($result['error']); ?>
            </div>
        <?php elseif (empty($result['status']) || empty($result['events'])): ?>
             <div class="miad-dhl-error" style="color:#005826; background:#e8f5e9; border-left-color:#00a32a;">
                <i class="fas fa-info-circle"></i> Les informations de suivi ne sont pas encore disponibles. Veuillez réessayer plus tard.
            </div>
        <?php else: 
            // Logique de progression (Stepper Style AliExpress)
            $status_code = isset($result['status']['statusCode']) ? strtolower($result['status']['statusCode']) : '';
            $step = 1;
            if ($status_code == 'delivered') $step = 4;
            elseif (strpos($status_code, 'delivery') !== false || strpos($status_code, 'arrived') !== false) $step = 3;
            elseif ($status_code == 'transit' || $status_code == 'picked_up' || strpos($status_code, 'departed') !== false) $step = 2;
            
            $steps = [
                1 => 'Commande',
                2 => 'Expédié',
                3 => 'En livraison',
                4 => 'Livré'
            ];
            ?>
            
            <!-- STEPPER VISUEL -->
            <div class="miad-track-stepper">
                <?php foreach($steps as $k => $label): 
                    $active = ($k <= $step) ? 'active' : '';
                ?>
                <div class="step-item <?php echo $active; ?>">
                    <div class="step-circle"><i class="fas fa-check"></i></div>
                    <div class="step-label"><?php echo $label; ?></div>
                    <?php if($k < 4): ?><div class="step-line"></div><?php endif; ?>
                </div>
                <?php endforeach; ?>
            </div>

            <div class="miad-dhl-status-header">
                <div class="status-icon">
                    <?php if($step == 4): ?><i class="fas fa-box-open"></i><?php else: ?><i class="fas fa-shipping-fast"></i><?php endif; ?>
                </div>
                <div class="status-text">
                    <span class="status-val"><?php echo esc_html($result['status']['statusCode']); ?></span>
                    <p class="status-desc"><?php echo esc_html($result['status']['description']); ?></p>
                </div>
            </div>
            
            <ul class="miad-dhl-timeline">
                <?php foreach ($result['events'] as $index => $event): 
                    $is_first = ($index === 0) ? 'latest' : '';
                ?>
                    <li class="<?php echo $is_first; ?>">
                        <div class="event-left">
                            <div class="event-time">
                                <span class="time-hour"><?php echo date_i18n('H:i', strtotime($event['timestamp'])); ?></span>
                                <span class="time-date"><?php echo date_i18n('d M', strtotime($event['timestamp'])); ?></span>
                            </div>
                        </div>
                        <div class="event-marker-wrapper">
                            <div class="event-marker"></div>
                        </div>
                        <div class="event-info">
                            <div class="event-desc"><?php echo esc_html($event['description']); ?></div>
                            <?php if(isset($event['location']['address']['addressLocality'])): ?>
                                <span class="event-loc"><i class="fas fa-map-marker-alt"></i> <?php echo esc_html($event['location']['address']['addressLocality']); ?></span>
                            <?php endif; ?>
                        </div>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>
    </div>
    <?php
    return ob_get_clean();
}

/**
 * Affiche le CSS pour la timeline (une seule fois par page).
 */
function miad_dhl_print_timeline_styles() {
    // Vérifie si les styles ont déjà été affichés pour éviter les doublons.
    if (did_action('miad_dhl_styles_printed')) {
        return;
    }
    ?>
    <style>
        .miad-dhl-dashboard-wrapper { max-width: 1100px; margin: 0 auto; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
        .miad-dhl-dashboard { display: flex; gap: 30px; flex-wrap: wrap; }
        
        /* AliExpress Style Tracking */
        .miad-dhl-result-container { background: #fff; padding: 30px; border-radius: 12px; border: 1px solid #eee; box-shadow: 0 5px 20px rgba(0,0,0,0.05); }

        /* Stepper */
        .miad-track-stepper { display: flex; justify-content: space-between; margin-bottom: 40px; position: relative; padding: 0 10px; }
        .step-item { flex: 1; text-align: center; position: relative; z-index: 1; }
        .step-circle { width: 30px; height: 30px; background: #e0e0e0; border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; transition: 0.3s; }
        .step-label { font-size: 12px; color: #999; font-weight: 600; }
        .step-line { position: absolute; top: 15px; left: 50%; width: 100%; height: 3px; background: #e0e0e0; z-index: -1; }
        
        .step-item.active .step-circle { background: #ff4747; box-shadow: 0 0 0 4px rgba(255, 71, 71, 0.1); }
        .step-item.active .step-label { color: #333; }
        .step-item.active .step-line { background: #ff4747; }
        .step-item:last-child .step-line { display: none; }

        /* Sidebar */
        .miad-dhl-sidebar { flex: 1; min-width: 280px; max-width: 320px; background: #fff; border-radius: 8px; border: 1px solid #e0e0e0; padding: 20px; height: fit-content; box-shadow: 0 2px 10px rgba(0,0,0,0.03); }
        .miad-sb-title { margin-top: 0; font-size: 16px; color: #333; border-bottom: 2px solid #f0f0f0; padding-bottom: 10px; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.5px; }
        .miad-shipment-list { display: flex; flex-direction: column; gap: 10px; max-height: 500px; overflow-y: auto; }
        .miad-shipment-link { display: block; padding: 12px; background: #f9f9f9; border: 1px solid #eee; border-radius: 6px; text-decoration: none; color: #333; transition: 0.2s; border-left: 3px solid transparent; }
        .miad-shipment-link:hover { background: #fff; border-color: #ddd; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
        .miad-shipment-link.active { background: #fff; border-color: #d40511; border-left-color: #d40511; box-shadow: 0 2px 8px rgba(212, 5, 17, 0.1); }
        .miad-shipment-tn { font-weight: 700; display: block; color: #d40511; font-size: 14px; margin-bottom: 3px; }
        .miad-shipment-meta { font-size: 12px; color: #333; display: block; }
        .miad-shipment-date { font-size: 11px; color: #888; display: block; margin-top: 3px; }

        /* Main Content */
        .miad-dhl-main { flex: 3; min-width: 300px; }
        .miad-dhl-search-box { background: #fff; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0; box-shadow: 0 2px 10px rgba(0,0,0,0.03); margin-bottom: 20px; }

        .miad-dhl-title { margin-top: 0; color: #d40511; /* Rouge DHL */ font-size: 20px; border-bottom: 2px solid #f0f0f0; padding-bottom: 15px; margin-bottom: 20px; }
        
        .miad-dhl-form { display: flex; gap: 10px; margin-bottom: 0; }
        .miad-dhl-form input { flex: 1; padding: 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 16px; }
        .miad-dhl-form button { padding: 12px 25px; background: #ff4747; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 16px; transition: 0.3s; }
        .miad-dhl-form button:hover { background: #e03e3e; }

        .miad-dhl-error { color: #d63638; background: #fff8e5; padding: 15px; border-left: 4px solid #d63638; }
        
        .miad-dhl-status-header { display: flex; align-items: center; gap: 20px; background: #fff5f5; padding: 20px; border-radius: 8px; margin-bottom: 30px; border: 1px solid #ffe0e0; }
        .status-icon { font-size: 30px; color: #ff4747; }
        .status-val { font-size: 18px; font-weight: 800; color: #333; display: block; text-transform: uppercase; }
        .status-desc { margin: 0; color: #666; font-size: 14px; }

        .miad-dhl-timeline { list-style: none; padding: 0; margin: 0; position: relative; }
        .miad-dhl-timeline::before { content: ''; position: absolute; top: 15px; bottom: 0; left: 85px; width: 2px; background: #f0f0f0; }
        
        .miad-dhl-timeline li { display: flex; margin-bottom: 30px; position: relative; }
        .miad-dhl-timeline li:last-child { margin-bottom: 0; }
        
        .event-left { width: 70px; text-align: right; padding-right: 15px; }
        .time-hour { display: block; font-size: 14px; font-weight: 700; color: #333; }
        .time-date { display: block; font-size: 11px; color: #999; text-transform: uppercase; margin-top: 2px; }
        
        .event-marker-wrapper { width: 30px; display: flex; justify-content: center; position: relative; }
        .event-marker { width: 10px; height: 10px; background: #ddd; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 0 1px #ddd; position: relative; z-index: 2; margin-top: 3px; }
        
        .miad-dhl-timeline li.latest .event-marker { width: 14px; height: 14px; background: #ff4747; box-shadow: 0 0 0 4px rgba(255, 71, 71, 0.2); border-color: #fff; }
        .miad-dhl-timeline li.latest .time-hour { color: #ff4747; }
        
        .event-info { flex: 1; padding-left: 10px; padding-top: 0; }
        .event-desc { font-size: 14px; color: #333; line-height: 1.4; margin-bottom: 5px; }
        .miad-dhl-timeline li.latest .event-desc { font-weight: 700; font-size: 15px; }
        .event-loc { font-size: 12px; color: #888; display: inline-block; background: #f9f9f9; padding: 2px 8px; border-radius: 4px; }

        .miad-dhl-placeholder { text-align: center; padding: 50px 20px; color: #999; background: #fff; border-radius: 8px; border: 1px dashed #ddd; }
        .miad-dhl-placeholder i { font-size: 48px; margin-bottom: 15px; color: #eee; }
        
        @media (max-width: 768px) {
            .miad-dhl-dashboard { flex-direction: column; }
            .miad-dhl-sidebar { max-width: 100%; }
        }
    </style>
    <?php
    // Marque les styles comme affichés.
    do_action('miad_dhl_styles_printed');
}

// --- 5. SHORTCODE FRONTEND [miad_dhl_track] ---
add_shortcode('miad_dhl_track', 'miad_dhl_render_shortcode');
function miad_dhl_render_shortcode($atts) {
    ob_start();
    $result = null;
    $track_id = '';
    $user_shipments = [];
    
    // 1. Récupération automatique (Client & Représentant)
    if (is_user_logged_in()) {
        $user_id = get_current_user_id();
        
        // CAS REPRÉSENTANT : Voir les colis de sa zone
        if (current_user_can('miad_representative')) {
             $country_code = get_user_meta($user_id, 'miad_assigned_country', true);
             if ($country_code) {
                 $args = [
                     'limit' => 20,
                     'orderby' => 'date',
                     'order' => 'DESC',
                     'meta_key' => '_miad_dhl_tracking_number',
                     'meta_compare' => 'EXISTS',
                     'status' => ['wc-processing', 'wc-completed', 'wc-shipped']
                 ];
                 $orders = wc_get_orders($args);
                 
                 foreach($orders as $order) {
                     // Filtre manuel par pays du vendeur (car pas possible directement dans wc_get_orders)
                     $belongs_to_rep = false;
                     foreach ($order->get_items() as $item) {
                        $vendor_id = get_post_field('post_author', $item->get_product_id());
                        if (function_exists('dokan_get_store_info')) {
                            $store_info = dokan_get_store_info($vendor_id);
                            if (isset($store_info['address']['country']) && $store_info['address']['country'] === $country_code) {
                                $belongs_to_rep = true;
                                break;
                            }
                        }
                     }
                     
                     if ($belongs_to_rep) {
                         $tn = $order->get_meta('_miad_dhl_tracking_number');
                         if($tn) {
                            $user_shipments[] = [
                                'id' => $order->get_id(), 
                                'tn' => $tn, 
                                'date' => $order->get_date_created()->date('d/m/Y'),
                                'info' => 'Client: ' . $order->get_formatted_billing_full_name()
                            ];
                         }
                     }
                 }
            }
        } 
        // CAS CLIENT STANDARD
        elseif (function_exists('wc_get_orders')) {
            $orders = wc_get_orders([
                'customer' => $user_id,
                'limit' => 10,
                'orderby' => 'date',
                'order' => 'DESC',
                'meta_key' => '_miad_dhl_tracking_number',
                'meta_compare' => 'EXISTS'
            ]);
            foreach($orders as $order) {
                $tn = $order->get_meta('_miad_dhl_tracking_number');
                if($tn) {
                    $user_shipments[] = [
                        'id' => $order->get_id(), 
                        'tn' => $tn, 
                        'date' => $order->get_date_created()->date('d/m/Y'),
                        'info' => 'Commande #' . $order->get_order_number()
                    ];
                }
            }
        }
    }

    // 2. Détermination du ID à suivre
    if (isset($_GET['track_id'])) {
        $track_id = sanitize_text_field($_GET['track_id']);
    } elseif (!empty($user_shipments)) {
        // Par défaut, le plus récent
        $track_id = $user_shipments[0]['tn'];
    }

    // 3. Requête API (avec cache)
    if (!empty($track_id)) {
        $transient_key = 'dhl_track_' . md5($track_id);
        $cached_result = get_transient($transient_key);

        if (false === $cached_result) {
            $result = miad_dhl_get_tracking_info($track_id);
            $cache_duration = isset($result['error']) ? 5 * MINUTE_IN_SECONDS : 1 * HOUR_IN_SECONDS;
            set_transient($transient_key, $result, $cache_duration);
        } else {
            $result = $cached_result;
        }
    }
    ?>
    <div class="miad-dhl-dashboard-wrapper">
        <div class="miad-dhl-dashboard">
            
            <!-- COLONNE GAUCHE : LISTE (Si connecté et colis existants) -->
            <?php if (!empty($user_shipments)): ?>
            <div class="miad-dhl-sidebar">
                <h4 class="miad-sb-title"><i class="fas fa-history"></i> <?php echo current_user_can('miad_representative') ? 'Colis de la Zone' : 'Vos Colis'; ?></h4>
                <div class="miad-shipment-list">
                    <?php foreach ($user_shipments as $ship): 
                        $active_class = ($track_id == $ship['tn']) ? 'active' : '';
                    ?>
                        <a href="?track_id=<?php echo esc_attr($ship['tn']); ?>" class="miad-shipment-link <?php echo $active_class; ?>">
                            <span class="miad-shipment-tn"><i class="fas fa-truck"></i> <?php echo esc_html($ship['tn']); ?></span>
                            <span class="miad-shipment-meta"><?php echo esc_html($ship['info']); ?></span>
                            <span class="miad-shipment-date"><?php echo esc_html($ship['date']); ?></span>
                        </a>
                    <?php endforeach; ?>
                </div>
            </div>
            <?php endif; ?>

            <!-- COLONNE DROITE : RECHERCHE & RÉSULTAT -->
            <div class="miad-dhl-main">
                <div class="miad-dhl-search-box">
                    <form method="get" class="miad-dhl-form">
                        <input type="text" name="track_id" placeholder="Numéro de suivi DHL..." value="<?php echo esc_attr($track_id); ?>" required>
                        <button type="submit"><i class="fas fa-search"></i> Tracer</button>
                    </form>
                </div>

                <?php if ($result): ?>
                    <div class="miad-dhl-result-container">
                        <?php echo miad_dhl_render_timeline_html($result); ?>
                    </div>
                <?php elseif(empty($user_shipments)): ?>
                    <div class="miad-dhl-placeholder">
                        <i class="fas fa-shipping-fast"></i>
                        <p>Entrez un numéro de suivi pour voir l'état de votre colis en temps réel.</p>
                    </div>
                <?php endif; ?>
            </div>
        </div>
    </div>

    <?php 
    // Affiche le CSS
    miad_dhl_print_timeline_styles();
    return ob_get_clean();
}

// --- 6. INTÉGRATION EXPÉDITION WOOCOMMERCE (CALCUL DES FRAIS) ---
add_action('woocommerce_shipping_init', 'miad_dhl_shipping_init');

function miad_dhl_shipping_init() {
    if (!class_exists('WC_Shipping_Method')) return;

    class WC_Miad_DHL_Shipping_Method extends WC_Shipping_Method {
        public function __construct($instance_id = 0) {
            $this->id                 = 'miad_dhl_shipping';
            $this->instance_id        = $instance_id;
            $this->method_title       = __('MIAD DHL Express', 'miad-dhl');
            $this->method_description = __('Calcul des frais MIAD Express, Standard et Promo basé sur l\'API DHL.', 'miad-dhl');
            $this->supports           = array(
                'shipping-zones',
                'instance-settings',
                'settings'
            );

            $this->init();
        }

        public function init() {
            $this->init_form_fields();
            $this->init_settings();

            $this->title = $this->get_option('title');
            $this->enabled = $this->get_option('enabled');

            add_action('woocommerce_update_options_shipping_' . $this->id, array($this, 'process_admin_options'));
        }

        public function init_form_fields() {
            $this->form_fields = array(
                'enabled' => array(
                    'title'   => __('Activer', 'miad-dhl'),
                    'type'    => 'checkbox',
                    'label'   => __('Activer ce mode de livraison', 'miad-dhl'),
                    'default' => 'yes'
                ),
                'title' => array(
                    'title'       => __('Titre Principal (Express)', 'miad-dhl'),
                    'type'        => 'text',
                    'description' => __('Titre affiché au client. Remplacez "DHL Express" par "MIAD Express" pour masquer le transporteur.', 'miad-dhl'),
                    'default'     => __('MIAD Express', 'miad-dhl'),
                    'desc_tip'    => true,
                ),
                'local_shipping_title' => array(
                    'title'       => __('Titre (Livraison Locale)', 'miad-dhl'),
                    'type'        => 'text',
                    'description' => __('Titre affiché pour la livraison dans le même pays que le vendeur. Ex: MIAD EXPRESS (estimé 4-5 CAD, payable à la livraison)', 'miad-dhl'),
                    'default'     => 'MIAD EXPRESS LOCALE (Paiement à la livraison)',
                    'desc_tip'    => true,
                ),
                'local_shipping_cost' => array(
                    'title'       => __('Coût (Livraison Locale)', 'miad-dhl'),
                    'type'        => 'number',
                    'description' => __('Prix fixe ajouté au panier pour la livraison locale. Laissez à 0 si le paiement se fait séparément à la livraison.', 'miad-dhl'),
                    'default'     => '0',
                    'desc_tip'    => true,
                    'custom_attributes' => array( 'step' => '0.01' ),
                ),
                'base_cost' => array(
                    'title'       => __('Coût de base', 'miad-dhl'),
                    'type'        => 'number',
                    'description' => __('(Obsolète si API activée) Coût fixe de départ pour un colis.', 'miad-dhl'),
                    'default'     => '5',
                    'desc_tip'    => true,
                ),
                'calculation_method' => array(
                    'title'   => __('Méthode de calcul', 'miad-dhl'),
                    'type'    => 'select',
                    'default' => 'api',
                    'options' => array(
                        'api'    => __('API DHL (Temps réel)', 'miad-dhl'),
                        'manual' => __('Manuel (Poids simple)', 'miad-dhl'),
                        'matrix' => __('Matrice MIAD (Poids/Surcharges)', 'miad-dhl'),
                    ),
                ),
                'shipping_matrix' => array(
                    'title'       => __('Configuration de la Matrice', 'miad-dhl'),
                    'type'        => 'textarea',
                    'description' => __('Format: poids_max:prix_fcfa (un par ligne). Ex: 0.5:40000', 'miad-dhl'),
                    'default'     => "0.5:40000\n2:62500\n5:100000\n10:155000\n20:250000",
                    'desc_tip'    => true,
                ),
                'fuel_surcharge' => array(
                    'title'       => __('Surcharge Carburant (%)', 'miad-dhl'),
                    'type'        => 'number',
                    'default'     => '20',
                ),
                'insurance_rate' => array(
                    'title'       => __('Taux Assurance (%)', 'miad-dhl'),
                    'type'        => 'number',
                    'default'     => '1',
                    'description' => __('Appliqué sur la valeur totale déclarée du panier.', 'miad-dhl'),
                ),
                'api_enabled' => array(
                    'title'   => __('Utiliser API DHL', 'miad-dhl'),
                    'type'    => 'checkbox',
                    'label'   => __('Obsolète - Utilisez "Méthode de calcul" ci-dessus', 'miad-dhl'),
                    'default' => 'no'
                ),
                'margin_type' => array(
                    'title'   => __('Marge sur Express (Principal)', 'miad-dhl'),
                    'type'    => 'select',
                    'default' => 'none',
                    'options' => array(
                        'none'    => __('Aucune', 'miad-dhl'),
                        'fixed'   => __('Montant Fixe (+)', 'miad-dhl'),
                        'percent' => __('Pourcentage (+%)', 'miad-dhl'),
                    ),
                ),
                'margin_amount' => array(
                    'title'       => __('Valeur Marge Express', 'miad-dhl'),
                    'type'        => 'number',
                    'description' => __('Montant ou pourcentage à ajouter (+) ou déduire (-) au tarif DHL.', 'miad-dhl'),
                    'default'     => '0',
                    'desc_tip'    => true,
                ),
                
                // --- STANDARD ---
                'enable_standard' => array(
                    'title'   => __('Option Standard', 'miad-dhl'),
                    'type'    => 'checkbox',
                    'label'   => __('Activer l\'option Standard', 'miad-dhl'),
                    'default' => 'no'
                ),
                'standard_title' => array(
                    'title'       => __('Titre Standard', 'miad-dhl'),
                    'type'        => 'text',
                    'default'     => 'Livraison Standard'
                ),
                'standard_type' => array(
                    'title'   => __('Type Ajustement Standard', 'miad-dhl'),
                    'type'    => 'select',
                    'default' => 'percent',
                    'options' => array(
                        'percent' => __('Pourcentage (%)', 'miad-dhl'),
                        'fixed'   => __('Montant Fixe (Devise)', 'miad-dhl'),
                    ),
                    'description' => 'Ajustement par rapport au prix de base DHL.'
                ),
                'standard_amount' => array(
                    'title'       => __('Valeur Ajustement Standard', 'miad-dhl'),
                    'type'        => 'number',
                    'description' => __('Ex: -30 pour réduire de 30% ou de 30$.', 'miad-dhl'),
                    'default'     => '-30'
                ),
                'standard_days' => array(
                    'title'       => __('Jours supplémentaires', 'miad-dhl'),
                    'type'        => 'number',
                    'description' => __('Nombre de jours à ajouter à l\'estimation DHL Express pour l\'option Standard.', 'miad-dhl'),
                    'default'     => '5'
                ),

                // --- PROMO ---
                'enable_promo' => array(
                    'title'   => __('Option Promo', 'miad-dhl'),
                    'type'    => 'checkbox',
                    'label'   => __('Activer l\'option Promo', 'miad-dhl'),
                    'default' => 'no'
                ),
                'promo_title' => array(
                    'title'       => __('Titre Promo', 'miad-dhl'),
                    'type'        => 'text',
                    'default'     => 'MIAD Promo (Offre Spéciale)'
                ),
                'promo_type' => array(
                    'title'   => __('Type Ajustement Promo', 'miad-dhl'),
                    'type'    => 'select',
                    'default' => 'percent',
                    'options' => array(
                        'percent' => __('Pourcentage (%)', 'miad-dhl'),
                        'fixed'   => __('Montant Fixe (Devise)', 'miad-dhl'),
                    ),
                ),
                'promo_amount' => array(
                    'title'       => __('Valeur Ajustement Promo', 'miad-dhl'),
                    'type'        => 'number',
                    'description' => __('Ex: -50 pour réduire de 50%.', 'miad-dhl'),
                    'default'     => '-50'
                ),
                'promo_days' => array(
                    'title'       => __('Jours supplémentaires (Promo)', 'miad-dhl'),
                    'type'        => 'number',
                    'default'     => '7'
                ),
            );
        }

        public function calculate_shipping($package = array()) {
            $weight = 0;
            $total_value = 0;
            $base_cost = (float) $this->get_option('base_cost');
            $calc_method = $this->get_option('calculation_method', 'api');
            $matrix_raw = get_option('miad_dhl_shipping_matrix', $this->get_option('shipping_matrix'));
            $fuel_pct = (float) get_option('miad_dhl_fuel_surcharge', 20);
            $ins_pct = (float) get_option('miad_dhl_insurance_rate', 1);
            $global_margin_pct = (float) get_option('miad_dhl_global_margin_pct', 60);
            $cost_per_kg = (float) $this->get_option('cost_per_kg', 2);
            
            $margin_type = $this->get_option('margin_type');
            $margin_amount = (float) $this->get_option('margin_amount');
            
            // Options Standard & Promo
            $enable_standard = $this->get_option('enable_standard');
            $standard_title = $this->get_option('standard_title');
            $standard_type = $this->get_option('standard_type', 'percent');
            $standard_amount = (float)$this->get_option('standard_amount', -30);
            $standard_days = (int)$this->get_option('standard_days');
            
            $enable_promo = $this->get_option('enable_promo');
            $promo_title = $this->get_option('promo_title');
            $promo_type = $this->get_option('promo_type', 'percent');
            $promo_amount = (float)$this->get_option('promo_amount', -50);
            $promo_days = (int)$this->get_option('promo_days', 7);
            
            $cost = 0;

            // DEBUG LOG
            miad_dhl_log("--- CALCULATE SHIPPING START ---");
            miad_dhl_log("Calculation Method: " . $calc_method);

            // NOUVEAU: Récupération des options de livraison locale
            $local_shipping_title = $this->get_option('local_shipping_title', 'MIAD EXPRESS LOCALE (Paiement à la livraison)');
            $local_shipping_cost = (float) $this->get_option('local_shipping_cost', 0);

            $dest_country = $package['destination']['country'];
            $dest_city = $package['destination']['city'];
            $dest_postcode = $package['destination']['postcode'];
            
            if (empty($dest_country)) {
                miad_dhl_log("ABORT: No destination country set in cart.");
                return;
            }

            // 1. Regroupement par Origine (Pays/Ville) pour gérer les expéditions multiples
            $groups = [];
            $default_origin_country = get_option('miad_dhl_shipper_country', 'SN');
            if (empty($default_origin_country)) $default_origin_country = 'SN'; // Sécurité anti-bug
            $default_origin_city = get_option('miad_dhl_shipper_city', 'Dakar');
            $default_origin_zip = get_option('miad_dhl_shipper_zip', '');

            foreach ($package['contents'] as $item_id => $values) {
                $_product = $values['data'];
                $qty = $values['quantity'];
                
                $origin_country = $default_origin_country;
                $origin_city = $default_origin_city;
                $origin_zip = $default_origin_zip;

                if (function_exists('dokan_get_store_info')) {
                    $vendor_id = get_post_field('post_author', $_product->get_id());
                    $store_info = dokan_get_store_info($vendor_id);
                    if (!empty($store_info['address']['country'])) {
                        $origin_country = $store_info['address']['country'];
                        $origin_city = !empty($store_info['address']['city']) ? $store_info['address']['city'] : '';
                        $origin_zip = !empty($store_info['address']['zip']) ? $store_info['address']['zip'] : '';
                    }
                }

                $key = $origin_country . '_' . $origin_city;
                if (!isset($groups[$key])) {
                    $groups[$key] = [
                        'origin_country' => $origin_country,
                        'origin_city' => $origin_city,
                        'origin_zip' => $origin_zip,
                        'items' => [],
                        'total_value' => 0,
                        'hs_code' => ''
                    ];
                }
                $groups[$key]['items'][] = ['data' => $_product, 'quantity' => $qty];
                $groups[$key]['total_value'] += (float) $_product->get_price() * $qty;
                if (empty($groups[$key]['hs_code'])) {
                    $groups[$key]['hs_code'] = get_post_meta($_product->get_id(), '_miad_hs_code', true);
                }
            }

            // 2. Calcul des frais pour chaque groupe (Origine)
            $total_shipping_cost = 0;
            $is_all_local = true;
            $valid_rates_found = false;

            foreach ($groups as $group) {
                // Livraison Locale
                if ($group['origin_country'] === $dest_country) {
                    $total_shipping_cost += $local_shipping_cost;
                    continue;
                }
                $is_all_local = false;

                // Emballage (Tetris) par groupe d'origine
                $packer = new Miad_DHL_Box_Packer();
                foreach ($group['items'] as $item) {
                    $packer->add_item($item['data'], $item['quantity']);
                }
                $box = $packer->pack();

                if ($calc_method === 'api') {
                    $rates = miad_dhl_get_rate_api(
                        $box['total_weight'], 
                        $box['l'], $box['w'], $box['h'], 
                        $group['total_value'], 
                        $group['hs_code'], 
                        $dest_country, $dest_city, $dest_postcode, 
                        $group['origin_country'], $group['origin_city'], $group['origin_zip'], 
                        true
                    );

                    if ($rates && is_array($rates) && !isset($rates['error_code'])) {
                        // On prend le tarif le moins cher pour ce segment
                        $cheapest = $rates[0];
                        $total_shipping_cost += $cheapest['cost'];
                        $valid_rates_found = true;
                    } else {
                        miad_dhl_log("Failed to get rate for group " . $group['origin_country']);
                        // Fallback Professionnel : Si l'API échoue pour ce groupe spécifique (ex: erreur adresse), 
                        // on applique le tarif manuel au poids pour ne pas perdre d'argent sur ce segment.
                        $total_shipping_cost += $base_cost + ($box['total_weight'] * $cost_per_kg);
                        $valid_rates_found = true;
                    }
                } elseif ($calc_method === 'matrix') {
                    // Calcul Poids Volumétrique (L*W*H)/5000
                    $vol_weight = ($box['l'] * $box['w'] * $box['h']) / 5000;
                    $chargeable_weight = max($box['total_weight'], $vol_weight);
                    
                    $matrix_cost = $this->calculate_matrix_cost($chargeable_weight, $matrix_raw);
                    
                    // Ajout des Surcharges (Carburant + Assurance)
                    $fuel_fee = $matrix_cost * ($fuel_pct / 100);
                    $insurance_fee = $group['total_value'] * ($ins_pct / 100);
                    
                    $total_shipping_cost += ($matrix_cost + $fuel_fee + $insurance_fee);
                    $valid_rates_found = true;
                    miad_dhl_log("Matrix Calculation: Base=$matrix_cost, Fuel=$fuel_fee, Ins=$insurance_fee, Weight=$chargeable_weight");
                } else {
                    // Fallback manuel
                    $total_shipping_cost += $base_cost + ($box['total_weight'] * $cost_per_kg);
                    $valid_rates_found = true;
                }
            }

            // 3. Ajout du tarif final
            if ($is_all_local) {
                $this->add_rate(array(
                    'id'    => 'miad_local_shipping',
                    'label' => $local_shipping_title,
                    'cost'  => $total_shipping_cost,
                    'calc_tax' => 'per_item'
                ));
            } elseif ($valid_rates_found || $api_enabled !== 'yes') {
                // 1. Tarif EXPRESS (Principal)
                $express_cost = $total_shipping_cost;

                // Appliquer la Marge Globale MIAD configurée (Défaut 60%)
                if ($global_margin_pct != 0) {
                    $express_cost += $express_cost * ($global_margin_pct / 100);
                }

                if ($margin_type === 'fixed' && $margin_amount != 0) {
                    $express_cost += $margin_amount;
                } elseif ($margin_type === 'percent' && $margin_amount != 0) {
                    $express_cost += $express_cost * ($margin_amount / 100);
                }

                if ($express_cost > 0) {
                    $this->add_rate(array(
                        'id'    => $this->id . '_express',
                        'label' => $this->title,
                        'cost'  => $express_cost,
                        'calc_tax' => 'per_item'
                    ));
                }
                
                // 2. Tarif STANDARD (Optionnel)
                if ($enable_standard === 'yes' && $total_shipping_cost > 0) {
                    $std_cost = $total_shipping_cost;
                    if ($standard_type === 'fixed') {
                        $std_cost += $standard_amount;
                    } else {
                        $std_cost += $std_cost * ($standard_amount / 100);
                    }
                    
                    if ($std_cost > 0) {
                        $this->add_rate(array(
                            'id'    => $this->id . '_standard',
                            'label' => $standard_title . ' (+' . $standard_days . ' jours)',
                            'cost'  => $std_cost,
                            'calc_tax' => 'per_item'
                        ));
                    }
                }

                // 3. Tarif PROMO (Optionnel)
                if ($enable_promo === 'yes' && $total_shipping_cost > 0) {
                    $promo_cost = $total_shipping_cost;
                    if ($promo_type === 'fixed') {
                        $promo_cost += $promo_amount;
                    } else {
                        $promo_cost += $promo_cost * ($promo_amount / 100);
                    }
                    
                    if ($promo_cost > 0) {
                        $this->add_rate(array(
                            'id'    => $this->id . '_promo',
                            'label' => $promo_title . ' (+' . $promo_days . ' jours)',
                            'cost'  => $promo_cost,
                            'calc_tax' => 'per_item'
                        ));
                    }
                }
            } else {
                miad_dhl_log("No valid rates found for any group.");
            }
        }

        private function calculate_matrix_cost($weight, $matrix_raw) {
            $lines = explode("\n", $matrix_raw);
            $matrix = [];
            foreach ($lines as $line) {
                $parts = explode(':', $line);
                if (count($parts) == 2) {
                    $matrix[(float)trim($parts[0])] = (float)trim($parts[1]);
                }
            }
            if (empty($matrix)) return 0;
            ksort($matrix);

            $cost = 0;
            $found = false;
            foreach ($matrix as $max_weight => $price) {
                if ($weight <= $max_weight) {
                    $cost = $price;
                    $found = true;
                    break;
                }
            }

            if (!$found) {
                $max_w = max(array_keys($matrix));
                $max_p = $matrix[$max_w];
                $cost = $max_p + (($weight - $max_w) * ($max_p / $max_w));
            }
            return $cost;
        }
    }
}

add_filter('woocommerce_shipping_methods', 'miad_dhl_add_shipping_method');
function miad_dhl_add_shipping_method($methods) {
    $methods['miad_dhl_shipping'] = 'WC_Miad_DHL_Shipping_Method';
    return $methods;
}

// --- NOUVEAU : CLASSE MATRICIELLE D'EMBALLAGE (SMART PACKING) ---
if (!class_exists('Miad_DHL_Box_Packer')) {
    class Miad_DHL_Box_Packer {
        private $items = [];
        
        // Configuration unique : Flyer Souple (No rigid boxes)
        private $boxes = [
            'DHL_FLYER' => [
                'id' => 'DHL_FLYER', 
                'name' => 'DHL Flyer (Souple)', 
                'l' => 30, 
                'w' => 20, 
                'h' => 2, 
                'max_weight' => 999.0, // Illimité pour tout accepter
                'vol' => 1200
            ]
        ];

        public function get_all_boxes() {
            // On ignore les custom boxes pour forcer le Flyer
            return $this->boxes;
        }

        public function get_box($id) {
            // Toujours retourner le Flyer peu importe l'ID demandé
            return $this->boxes['DHL_FLYER'];
        }

        public static function get_box_list() {
            return ['DHL_FLYER' => 'DHL Flyer (Souple - 30x20x2)'];
        }

        public function add_item($product, $qty) {
            $weight = (float) $product->get_weight();
            $weight = ($weight > 0) ? $weight : 0.5; // Poids min par défaut
            
            for($i=0; $i<$qty; $i++) {
                $this->items[] = ['weight' => $weight];
            }
        }

        public function pack() {
            $total_weight = 0;

            foreach ($this->items as $item) {
                $total_weight += $item['weight'];
            }

            // Retourne systématiquement le profil DHL_FLYER avec le poids réel calculé
            $box = $this->boxes['DHL_FLYER'];
            $box['total_weight'] = ($total_weight > 0) ? $total_weight : 0.5;
            
            return $box;
        }
    }
}

// --- NOUVEAU : 7. CRÉATION D'EXPÉDITION ---

add_action('wp_ajax_miad_dhl_create_shipment', 'miad_ajax_create_dhl_shipment');
function miad_ajax_create_dhl_shipment() {
    $order_id = intval($_POST['order_id']);
    $plt = isset($_POST['plt']) ? (bool) $_POST['plt'] : true;
    $result = miad_dhl_process_shipment_creation($order_id, $plt);
    if ($result['success']) {
        wp_send_json_success(['message' => $result['message']]);
    } else {
        wp_send_json_error(['message' => $result['message']]);
    }
}

/**
 * Logique partagée entre l'action AJAX ci-dessus (WP Admin, meta box commande)
 * et l'endpoint REST /dhl/create-shipment (dashboard "Logistique DHL" du
 * headless, demandé le 2026-07-20) — extraite pour ne pas dupliquer la
 * sauvegarde des PDFs / la note de commande / la notification client /
 * l'avancement automatique de l'étape de livraison.
 */
if (!function_exists('miad_dhl_process_shipment_creation')) {
    function miad_dhl_process_shipment_creation(int $order_id, bool $plt = true, ?array $override = null): array {
        $order = wc_get_order($order_id);
        if (!$order) {
            return ['success' => false, 'message' => 'Commande introuvable.'];
        }

        $result = miad_dhl_create_shipment_api($order, $plt, $override);

        if (!$result['success']) {
            $order->add_order_note('Échec de la création d\'expédition DHL : ' . $result['message']);
            return ['success' => false, 'message' => $result['message']];
        }

        // 1. Sauvegarder le numéro de suivi
        update_post_meta($order_id, '_miad_dhl_tracking_number', $result['tracking_number']);

        // 2. Sauvegarder l'étiquette PDF
        $upload_dir = wp_upload_dir();
        $label_dir = $upload_dir['basedir'] . '/dhl-labels';
        if (!file_exists($label_dir)) {
            wp_mkdir_p($label_dir);
        }
        $label_filename = 'dhl-label-' . $order_id . '-' . $result['tracking_number'] . '.pdf';
        $label_path = $label_dir . '/' . $label_filename;
        file_put_contents($label_path, base64_decode($result['label_data']));

        $label_url = $upload_dir['baseurl'] . '/dhl-labels/' . $label_filename;
        update_post_meta($order_id, '_miad_dhl_label_url', $label_url);

        // 2b. Sauvegarder le Waybill Doc PDF (Si disponible)
        $waybill_doc_url = '';
        if (!empty($result['waybill_doc_data'])) {
            $waybill_doc_filename = 'dhl-waybilldoc-' . $order_id . '-' . $result['tracking_number'] . '.pdf';
            $waybill_doc_path = $label_dir . '/' . $waybill_doc_filename;
            file_put_contents($waybill_doc_path, base64_decode($result['waybill_doc_data']));
            $waybill_doc_url = $upload_dir['baseurl'] . '/dhl-labels/' . $waybill_doc_filename;
            update_post_meta($order_id, '_miad_dhl_waybill_doc_url', $waybill_doc_url);
        }

        // 2c. Sauvegarder la facture PDF (Si disponible)
        $invoice_url = '';
        if (!empty($result['invoice_data'])) {
            $invoice_filename = 'dhl-invoice-' . $order_id . '-' . $result['tracking_number'] . '.pdf';
            $invoice_path = $label_dir . '/' . $invoice_filename;
            file_put_contents($invoice_path, base64_decode($result['invoice_data']));
            $invoice_url = $upload_dir['baseurl'] . '/dhl-labels/' . $invoice_filename;
            update_post_meta($order_id, '_miad_dhl_invoice_url', $invoice_url);
        }

        // 3. Ajouter une note à la commande
        $order->add_order_note('Expédition DHL créée. Tracking: ' . $result['tracking_number'] . '. <a href="'.$label_url.'" target="_blank">Étiquette</a>' . ($waybill_doc_url ? ' | <a href="'.$waybill_doc_url.'" target="_blank">Waybill Doc</a>' : '') . ($invoice_url ? ' | <a href="'.$invoice_url.'" target="_blank">Facture</a>' : '') . '.');

        // 4. Envoyer la notification au client + avancer l'étape de livraison
        miad_dhl_send_notification($order_id, $result['tracking_number']);
        miad_dhl_maybe_advance_stage($order_id);

        return [
            'success'          => true,
            'message'          => 'Expédition créée avec succès ! Tracking: ' . $result['tracking_number'],
            'tracking_number'  => $result['tracking_number'],
            'label_url'        => $label_url,
            'waybill_doc_url'  => $waybill_doc_url,
            'invoice_url'      => $invoice_url,
        ];
    }
}

/**
 * $override permet au dashboard admin headless de corriger le poids et les
 * dimensions avant l'envoi réel (demandé le 2026-07-20 : pouvoir changer les
 * dimensions, recalculer le tarif, puis confirmer l'expédition avec ces
 * valeurs) — sans override, le comportement est identique à avant (poids
 * auto-calculé depuis les fiches produits, colis 20x20x20 par défaut).
 */
function miad_dhl_create_shipment_api($order, $is_plt = true, ?array $override = null) {
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $account = get_option('miad_dhl_account_number');
    $api_mode = get_option('miad_dhl_api_mode', 'production');
    $incoterm = get_option('miad_dhl_incoterm', 'DAP');

    $accounts = [
        ["typeCode" => "shipper", "number" => $account],
        ["typeCode" => "payer", "number" => $account]
    ];
    // Si DDP, l'expéditeur (nous) paie les taxes.
    if ($incoterm === 'DDP') {
        $accounts[] = ["typeCode" => "duties-taxes", "number" => $account];
    }

    if (!$site_id || !$password || !$account) {
        return ['success' => false, 'message' => 'Credentials API manquants.'];
    }

    // --- 1. Infos Expéditeur (Shipper) ---
    // On prend l'adresse du vendeur Dokan s'il existe, sinon l'adresse de base du plugin
    $shipper = [];
    $first_item = reset($order->get_items());
    if (function_exists('dokan_get_store_info') && $first_item) {
        $vendor_id = get_post_field('post_author', $first_item->get_product_id());
        $store_info = dokan_get_store_info($vendor_id);
        $shipper = [
            "postalAddress" => [
                "postalCode" => $store_info['address']['zip'] ?? get_option('miad_dhl_shipper_zip'),
                "cityName" => $store_info['address']['city'] ?? get_option('miad_dhl_shipper_city'),
                "countryCode" => $store_info['address']['country'] ?? get_option('miad_dhl_shipper_country'),
                "addressLine1" => $store_info['address']['street_1'] ?? 'Adresse Vendeur'
            ],
            "contactInformation" => [
                "companyName" => $store_info['store_name'] ?? get_bloginfo('name'),
                "fullName" => $store_info['store_name'] ?? get_bloginfo('name'),
                "phone" => preg_replace('/\s+/', '', $store_info['phone'] ?? '123456789')
            ]
        ];
    } else {
        $shipper_country_code = get_option('miad_dhl_shipper_country');
        $shipper = [
            "postalAddress" => [
                "postalCode" => get_option('miad_dhl_shipper_zip'),
                "cityName" => get_option('miad_dhl_shipper_city'),
                "countryCode" => $shipper_country_code,
                "addressLine1" => 'Adresse par défaut'
            ],
            "contactInformation" => [
                "companyName" => get_bloginfo('name'),
                "fullName" => get_bloginfo('name'),
                "phone" => '123456789'
            ]
        ];
    }

    // --- 2. Infos Destinataire (Consignee) ---
    $consignee = [
        "postalAddress" => [
            "postalCode" => $order->get_billing_postcode(),
            "cityName" => $order->get_billing_city(),
            "countryCode" => $order->get_billing_country(),
            "addressLine1" => $order->get_billing_address_1()
        ],
        "contactInformation" => [
            "companyName" => $order->get_billing_company() ?: $order->get_formatted_billing_full_name(),
            "fullName" => $order->get_formatted_billing_full_name(),
            "phone" => preg_replace('/\s+/', '', $order->get_billing_phone()),
            "email" => $order->get_billing_email()
        ]
    ];

    // --- 3. Infos Colis (Package) ---
    $total_weight = 0;
    $total_value = 0;
    $currency = $order->get_currency();
    $contents_desc = [];
    $line_items = [];
    $item_number = 1;

    foreach ($order->get_items() as $item) {
        $product = $item->get_product();
        $qty = $item->get_quantity();
        $weight = ($product->get_weight() ?: 0.5) * $qty;
        $total_weight += $weight;
        
        $price = $product->get_price();
        $total_value += $price * $qty;
        
        $contents_desc[] = $item->get_name() . ' (x' . $qty . ')';
        
        // Données Douane (HS Code & Origine) — le code HS corrigé depuis le
        // panneau admin (override['hs_code']) prime sur celui de la fiche produit.
        $hs_code = !empty($override['hs_code']) ? $override['hs_code'] : (get_post_meta($product->get_id(), '_miad_hs_code', true) ?: '85444290');
        $origin = get_post_meta($product->get_id(), '_miad_origin_country', true) ?: 'CN';

        $line_items[] = [
            'number' => $item_number++,
            'description' => substr($item->get_name(), 0, 35), // DHL limite souvent la description ligne
            'price' => round($price, 2),
            'quantity' => ['value' => $qty, 'unitOfMeasurement' => 'PCS'],
            'commodityCodes' => [
                [
                    'typeCode' => 'outbound',
                    'value' => $hs_code
                ]
            ],
            'exportReasonType' => 'permanent',
            'manufacturerCountry' => $origin,
            'weight' => ['netValue' => round($weight/$qty, 3), 'grossValue' => round($weight/$qty, 3)]
        ];
    }
    if ($total_weight == 0) $total_weight = 1; // Poids minimum

    // Correction manuelle depuis le dashboard admin, le cas échéant
    if (!empty($override['weight'])) $total_weight = (float) $override['weight'];
    $pkg_length = !empty($override['length']) ? (float) $override['length'] : 20;
    $pkg_width  = !empty($override['width'])  ? (float) $override['width']  : 20;
    $pkg_height = !empty($override['height']) ? (float) $override['height'] : 20;

    // --- 4. Construction JSON (REST API) ---
    $url = ($api_mode === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/shipments' : 'https://express.api.dhl.com/mydhlapi/shipments';

    $json_payload = [
        "plannedShippingDateAndTime" => miad_dhl_get_next_shipping_date() . 'T10:00:00 GMT+00:00',
        "pickup" => ["isRequested" => false],
        "productCode" => "P", // Express Worldwide (Non-Doc)
        "accounts" => $accounts,
        "customerDetails" => [
            "shipperDetails" => $shipper,
            "receiverDetails" => $consignee
        ],
        "content" => [
            "packages" => [
                [
                    "weight" => $total_weight,
                    "dimensions" => ["length" => $pkg_length, "width" => $pkg_width, "height" => $pkg_height]
                ]
            ],
            "isCustomsDeclarable" => true,
            "declaredValue" => round($total_value, 2),
            "declaredValueCurrency" => $currency,
            "exportDeclaration" => [
                "lineItems" => $line_items
            ],
            "description" => substr(implode(', ', $contents_desc), 0, 70), // Max 70 chars
            "incoterm" => $incoterm,
            "unitOfMeasurement" => "metric"
        ],
        "outputImageProperties" => [
            "imageOptions" => [
                ["typeCode" => "label", "templateName" => "ECOM26_84_001"],
                ["typeCode" => "waybillDoc", "isRequested" => true],
                ["typeCode" => "invoice", "templateName" => "COMMERCIAL_INVOICE_P_10", "invoiceType" => "commercial"]
            ]
        ]
    ];

    $body_json = json_encode($json_payload);

    miad_dhl_log("SHIPMENT REQUEST (JSON) to $url:\n" . $body_json);

    $response = wp_remote_post($url, [
        'body' => $body_json,
        'timeout' => 90,
        'sslverify' => false,
        'headers' => miad_dhl_get_headers($site_id, $password)
    ]);

    if (is_wp_error($response)) {
        miad_dhl_log("SHIPMENT ERROR: " . $response->get_error_message());
        return ['success' => false, 'message' => $response->get_error_message()];
    }

    $body = wp_remote_retrieve_body($response);
    miad_dhl_log("SHIPMENT RESPONSE (JSON):\n" . $body);

    $data = json_decode($body, true);

    if (isset($data['shipmentTrackingNumber'])) {
        $label_data = '';
        $invoice_data = '';
        $waybill_doc_data = '';
        if (isset($data['documents'])) {
            foreach ($data['documents'] as $doc) {
                if ($doc['typeCode'] === 'label') {
                    $label_data = $doc['content'];
                } elseif ($doc['typeCode'] === 'invoice') {
                    $invoice_data = $doc['content'];
                } elseif ($doc['typeCode'] === 'waybillDoc') {
                    $waybill_doc_data = $doc['content'];
                }
            }
        }
        return [
            'success' => true,
            'tracking_number' => $data['shipmentTrackingNumber'],
            'label_data' => $label_data,
            'invoice_data' => $invoice_data,
            'waybill_doc_data' => $waybill_doc_data
        ];
    } else {
        $error_msg = $data['detail'] ?? ($data['title'] ?? 'Erreur inconnue de DHL.');
        return ['success' => false, 'message' => $error_msg];
    }
}

// --- NOUVEAU : 8. DEMANDE D'ENLÈVEMENT (SQUELETTE) ---

add_action('wp_ajax_miad_dhl_request_pickup', 'miad_ajax_request_dhl_pickup');
function miad_ajax_request_dhl_pickup() {
    $order_id = intval($_POST['order_id']);
    $order = wc_get_order($order_id);
    if (!$order) wp_send_json_error(['message' => 'Commande introuvable.']);

    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $account = get_option('miad_dhl_account_number');
    $api_mode = get_option('miad_dhl_api_mode', 'production');

    $date = sanitize_text_field($_POST['date']); // YYYY-MM-DD
    $time = sanitize_text_field($_POST['time']); // HH:MM
    $close_time = sanitize_text_field($_POST['close_time']); // HH:MM
    $location = sanitize_text_field($_POST['location']);

    $s_zip = get_option('miad_dhl_shipper_zip'); if(empty($s_zip)) $s_zip = '10001';
    $s_city = get_option('miad_dhl_shipper_city'); if(empty($s_city)) $s_city = 'Dakar';
    $s_country = get_option('miad_dhl_shipper_country'); if(empty($s_country)) $s_country = 'SN';

    // --- JSON PICKUP REQUEST ---
    $url = ($api_mode === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/pickups' : 'https://express.api.dhl.com/mydhlapi/pickups';

    $json_payload = [
        "plannedPickupDateAndTime" => $date . "T" . $time . ":00",
        "closeTime" => $close_time,
        "location" => $location,
        "locationType" => "business",
        "accounts" => [
            ["typeCode" => "shipper", "number" => $account]
        ],
        "shipmentDetails" => [
            [
                "productCode" => "P",
                "isCustomsDeclarable" => false,
                "unitOfMeasurement" => "metric",
                "packages" => [
                    ["weight" => 1.0, "dimensions" => ["length" => 20, "width" => 20, "height" => 20]]
                ]
            ]
        ],
        "customerDetails" => [
            "shipperDetails" => [
                "postalAddress" => [
                    "postalCode" => $s_zip,
                    "cityName" => $s_city,
                    "countryCode" => $s_country,
                    "addressLine1" => "Adresse Pickup"
                ],
                "contactInformation" => [
                    "companyName" => get_bloginfo('name'),
                    "fullName" => "Expediteur",
                    "phone" => "123456789",
                    "email" => get_option('admin_email')
                ]
            ],
            "bookingRequestorDetails" => [
                "postalAddress" => [
                    "postalCode" => get_option('miad_dhl_shipper_zip', '10001'),
                    "cityName" => get_option('miad_dhl_shipper_city', 'Dakar'),
                    "countryCode" => get_option('miad_dhl_shipper_country', 'SN'),
                    "addressLine1" => "Siege Social"
                ],
                "contactInformation" => [
                    "companyName" => get_bloginfo('name'),
                    "fullName" => "Responsable Logistique",
                    "phone" => "1234567890",
                    "email" => get_option('admin_email')
                ]
            ]
        ]
    ];

    // --- APPEL RÉEL API PICKUP ---
    $body_json = json_encode($json_payload);
    miad_dhl_log("PICKUP REQUEST (JSON) to $url:\n" . $body_json);

    $response = wp_remote_post($url, [
        'body' => $body_json,
        'timeout' => 90,
        'sslverify' => false,
        'headers' => miad_dhl_get_headers($site_id, $password)
    ]);

    if (is_wp_error($response)) {
        wp_send_json_error(['message' => 'Erreur connexion DHL: ' . $response->get_error_message()]);
    }

    $body = wp_remote_retrieve_body($response);
    miad_dhl_log("PICKUP RESPONSE (JSON):\n" . $body);
    $data = json_decode($body, true);
    
    if (isset($data['dispatchConfirmationNumbers'])) {
        $confirmation_number = $data['dispatchConfirmationNumbers'][0];
        update_post_meta($order_id, '_miad_dhl_pickup_confirmation', $confirmation_number);
        $order->add_order_note('Demande d\'enlèvement DHL RÉUSSIE. Confirmation : ' . $confirmation_number);
        wp_send_json_success(['message' => 'Enlèvement planifié ! Numéro : ' . $confirmation_number]);
    } else {
        $err = $data['detail'] ?? ($data['title'] ?? 'Erreur inconnue');
        wp_send_json_error(['message' => 'Erreur DHL: ' . $err]);
    }
}

// --- NOUVEAU : 9. ONGLET OUTILS D'AUTOMATISATION ---
function miad_dhl_render_tools_tab() {
    ?>
    <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:700px; margin-top:20px;">
        <h3>Automatisation des Codes Douaniers (HS)</h3>
        <p>Cet outil va tenter d'assigner automatiquement un code HS à vos produits en se basant sur leur catégorie principale et la table de correspondance que vous avez définie dans l'onglet "Codes Douaniers".</p>
        <button type="button" id="miad-auto-assign-hs" class="button button-primary">Lancer l'assignation des Codes HS</button>
        <div id="miad-hs-progress" style="display:none; margin-top:15px; padding:10px; background:#f1f1f1; border-left:3px solid #0073aa; max-height:200px; overflow-y:auto;"></div>
    </div>

    <div style="background:#fff; padding:20px; border:1px solid #ccc; max-width:700px; margin-top:20px;">
        <h3>Génération Automatique des SKUs</h3>
        <p>Cet outil va générer un SKU unique pour tous les produits qui n'en ont pas. Le format sera : <code>CAT-NOM-ID</code>.</p>
        <button type="button" id="miad-auto-assign-sku" class="button button-primary">Générer les SKUs manquants</button>
        <div id="miad-sku-progress" style="display:none; margin-top:15px; padding:10px; background:#f1f1f1; border-left:3px solid #0073aa; max-height:200px; overflow-y:auto;"></div>
    </div>

    <!-- NOUVEAU : Éditeur en masse -->
    <div class="card" style="max-width:100%; margin-top:20px;">
        <h2 style="padding: 0 20px;">Éditeur en Masse Logistique (Poids, Dimensions, Douane)</h2>
        <p style="padding: 0 20px;">Attribuez rapidement les infos manquantes pour que le Rating fonctionne. Vous pouvez aussi définir une <strong>Marge (%)</strong> de sécurité pour le calcul du prix sur le site.</p>
        
        <?php
        // Traitement de la sauvegarde
        if (isset($_POST['miad_bulk_save_logistics']) && isset($_POST['products']) && check_admin_referer('miad_bulk_logistics_nonce')) {
            $products_data = $_POST['products'];
            $updated_count = 0;
            foreach ($products_data as $pid => $data) {
                $product = wc_get_product($pid);
                if ($product) {
                    if (isset($data['weight'])) $product->set_weight(wc_clean($data['weight']));
                    if (isset($data['length'])) $product->set_length(wc_clean($data['length']));
                    if (isset($data['width'])) $product->set_width(wc_clean($data['width']));
                    if (isset($data['height'])) $product->set_height(wc_clean($data['height']));
                    if (isset($data['hs_code'])) update_post_meta($pid, '_miad_hs_code', wc_clean($data['hs_code']));
                    if (isset($data['margin'])) update_post_meta($pid, '_miad_shipping_margin', wc_clean($data['margin']));
                    
                    if (isset($data['pref_box'])) {
                        $box_id = wc_clean($data['pref_box']);
                        update_post_meta($pid, '_miad_preferred_box', $box_id);
                        // NOUVEAU : Appliquer les dimensions de la boîte au produit
                        if (!empty($box_id) && class_exists('Miad_DHL_Box_Packer')) {
                            $packer = new Miad_DHL_Box_Packer();
                            $box = $packer->get_box($box_id);
                            if ($box) {
                                $product->set_length($box['l']); $product->set_width($box['w']); $product->set_height($box['h']);
                            }
                        }
                    }
                    
                    $product->save();
                    $updated_count++;
                }
            }
            echo '<div class="notice notice-success is-dismissible" style="margin: 0 20px 20px;"><p>' . $updated_count . ' produits mis à jour (Logistique).</p></div>';
        }

        $paged_hs = isset($_GET['paged_hs']) ? absint($_GET['paged_hs']) : 1;
        $search_hs = isset($_GET['s_hs']) ? sanitize_text_field($_GET['s_hs']) : '';
        $cat_filter = isset($_GET['cat_filter']) ? intval($_GET['cat_filter']) : 0;
        $filter_missing = isset($_GET['filter_missing']) ? sanitize_text_field($_GET['filter_missing']) : '';

        $args = [
            'post_type' => 'product',
            'posts_per_page' => 20,
            'paged' => $paged_hs,
            'post_status' => ['publish', 'draft', 'pending'],
            'suppress_filters' => true // Force l'affichage de toutes les langues (WPML &LANG=ALL)
        ];
        if ($search_hs) {
            $args['s'] = $search_hs;
        }
        if ($cat_filter > 0) {
            $args['tax_query'] = [['taxonomy' => 'product_cat', 'field' => 'term_id', 'terms' => $cat_filter]];
        }
        if ($filter_missing === 'yes') {
             $args['meta_query'] = [
                'relation' => 'OR',
                ['key' => '_weight', 'value' => '', 'compare' => '='],
                ['key' => '_weight', 'compare' => 'NOT EXISTS']
             ];
        }

        $query = new WP_Query($args);

        $hs_codes_map = get_option('miad_dhl_hs_codes', []);
        $hs_codes_list = [];
        if (!empty($hs_codes_map)) {
            foreach($hs_codes_map as $item) {
                if (!empty($item['code'])) {
                    $hs_codes_list[] = $item['code'];
                }
            }
            $hs_codes_list = array_unique($hs_codes_list);
        }
        ?>
        <form method="get" style="padding: 0 20px 20px;">
            <input type="hidden" name="page" value="miad-dhl-config">
            <input type="hidden" name="tab" value="tools">
            <input type="search" name="s_hs" value="<?php echo esc_attr($search_hs); ?>" placeholder="Rechercher un produit...">
            
            <?php wp_dropdown_categories(['taxonomy' => 'product_cat', 'name' => 'cat_filter', 'selected' => $cat_filter, 'show_option_all' => '-- Toutes Catégories --', 'hide_empty' => 0]); ?>
            
            <select name="filter_missing">
                <option value="">-- Tous les produits --</option>
                <option value="yes" <?php selected($filter_missing, 'yes'); ?>>⚠️ Sans Poids/Dimensions (À corriger)</option>
            </select>

            <input type="submit" class="button" value="Rechercher">
        </form>

        <form method="post">
            <?php wp_nonce_field('miad_bulk_logistics_nonce'); ?>
            <table class="wp-list-table widefat fixed striped">
                <thead>
                    <tr>
                        <th width="50">Img</th>
                        <th>Produit</th>
                        <th width="80">Poids (kg)</th>
                        <th width="140">Dim (L x l x h) cm</th>
                        <th width="120">Code HS</th>
                        <th width="150">Box DHL</th>
                        <th width="80">Marge %</th>
                    </tr>
                </thead>
                <tbody>
                    <?php if ($query->have_posts()): while ($query->have_posts()): $query->the_post(); 
                        $product = wc_get_product(get_the_ID());
                        $pid = $product->get_id();
                        $current_hs = get_post_meta($product->get_id(), '_miad_hs_code', true);
                        $current_box = get_post_meta($product->get_id(), '_miad_preferred_box', true);
                        $current_margin = get_post_meta($product->get_id(), '_miad_shipping_margin', true);
                    ?>
                    <tr>
                        <td><?php echo $product->get_image([40,40]); ?></td>
                        <td><a href="<?php echo get_edit_post_link(); ?>" target="_blank"><?php the_title(); ?></a></td>
                        <td><input type="number" step="0.01" name="products[<?php echo $pid; ?>][weight]" value="<?php echo esc_attr($product->get_weight()); ?>" style="width:100%;" placeholder="0.5"></td>
                        <td>
                            <div style="display:flex; gap:2px;">
                                <input type="number" name="products[<?php echo $pid; ?>][length]" value="<?php echo esc_attr($product->get_length()); ?>" style="width:40px;" placeholder="L">
                                <input type="number" name="products[<?php echo $pid; ?>][width]" value="<?php echo esc_attr($product->get_width()); ?>" style="width:40px;" placeholder="W">
                                <input type="number" name="products[<?php echo $pid; ?>][height]" value="<?php echo esc_attr($product->get_height()); ?>" style="width:40px;" placeholder="H">
                            </div>
                        </td>
                        <td><input type="text" name="products[<?php echo $pid; ?>][hs_code]" value="<?php echo esc_attr($current_hs); ?>" list="hs-code-suggestions" style="width:100%;" class="miad-hs-input"></td>
                        <td>
                            <select name="products[<?php echo $pid; ?>][pref_box]" style="width:100%;">
                                <option value="">Auto</option>
                                <?php foreach(Miad_DHL_Box_Packer::get_box_list() as $k => $v): ?><option value="<?php echo esc_attr($k); ?>" <?php selected($current_box, $k); ?>><?php echo esc_html($v); ?></option><?php endforeach; ?>
                            </select>
                        </td>
                        <td><input type="number" step="1" name="products[<?php echo $pid; ?>][margin]" value="<?php echo esc_attr($current_margin); ?>" style="width:100%;" placeholder="0"></td>
                    </tr>
                    <?php endwhile; else: ?><tr><td colspan="3">Aucun produit trouvé.</td></tr><?php endif; ?>
                </tbody>
            </table>
            <?php if (!empty($hs_codes_list)): ?><datalist id="hs-code-suggestions"><?php foreach($hs_codes_list as $code): ?><option value="<?php echo esc_attr($code); ?>"><?php endforeach; ?></datalist><?php endif; ?>
            <div class="tablenav bottom"><div class="alignleft actions"><button type="submit" name="miad_bulk_save_logistics" class="button button-primary">Sauvegarder Tout</button></div>
                <div class="tablenav-pages"><?php echo paginate_links(['base' => add_query_arg('paged_hs', '%#%'),'format' => '','current' => $paged_hs,'total' => $query->max_num_pages]); ?></div>
            </div>
        </form>
        <?php wp_reset_postdata(); ?>
    </div>

    <script>
    jQuery(document).ready(function($){
        // Validation JS en temps réel
        $(document).on('input', '.miad-hs-input', function() {
            this.value = this.value.replace(/[^0-9.]/g, '');
        });

        // Assignation HS Codes
        $('#miad-auto-assign-hs').on('click', function(){
            if(!confirm("Lancer l'assignation automatique des codes HS ? Cela peut prendre du temps.")) return;
            
            var btn = $(this);
            var progress = $('#miad-hs-progress');
            btn.prop('disabled', true).text('Traitement...');
            progress.show().html('Recherche des produits sans code HS...');

            $.post(ajaxurl, { action: 'miad_dhl_auto_assign_hs', _ajax_nonce: '<?php echo wp_create_nonce("miad_tools_nonce"); ?>' }, function(res){
                if(res.success) {
                    progress.html(res.data.message);
                } else {
                    progress.html('<span style="color:red;">Erreur: ' + res.data.message + '</span>');
                }
                btn.prop('disabled', false).text("Lancer l'assignation des Codes HS");
            });
        });

        // Génération SKUs
        $('#miad-auto-assign-sku').on('click', function(){
            if(!confirm("Lancer la génération des SKUs pour les produits qui n'en ont pas ?")) return;
            
            var btn = $(this);
            var progress = $('#miad-sku-progress');
            btn.prop('disabled', true).text('Traitement...');
            progress.show().html('Recherche des produits sans SKU...');

            $.post(ajaxurl, { action: 'miad_dhl_auto_assign_sku', _ajax_nonce: '<?php echo wp_create_nonce("miad_tools_nonce"); ?>' }, function(res){
                if(res.success) {
                    progress.html(res.data.message);
                } else {
                    progress.html('<span style="color:red;">Erreur: ' + res.data.message + '</span>');
                }
                btn.prop('disabled', false).text("Générer les SKUs manquants");
            });
        });
    });
    </script>
    <?php
}

// --- NOUVEAU : 10. AJAX HANDLERS POUR LES OUTILS ---

add_action('wp_ajax_miad_dhl_auto_assign_hs', 'miad_ajax_auto_assign_hs');
function miad_ajax_auto_assign_hs() {
    check_ajax_referer('miad_tools_nonce');

    $hs_map_raw = get_option('miad_dhl_hs_codes', []);
    if (empty($hs_map_raw)) {
        wp_send_json_error(['message' => 'Aucune règle de correspondance de code HS n\'a été définie dans l\'onglet "Codes Douaniers".']);
    }
    
    $hs_map = [];
    foreach($hs_map_raw as $item) {
        if (!empty($item['type']) && !empty($item['code'])) {
            $hs_map[strtolower($item['type'])] = $item['code'];
        }
    }

    $args = [
        'post_type' => 'product',
        'posts_per_page' => -1,
        'post_status' => 'publish',
        'meta_query' => [ 'relation' => 'OR',
            [ 'key' => '_miad_hs_code', 'compare' => 'NOT EXISTS' ],
            [ 'key' => '_miad_hs_code', 'value' => '', 'compare' => '=' ]
        ],
        'suppress_filters' => true // Force l'affichage de toutes les langues (WPML &LANG=ALL)
    ];
    $posts = get_posts($args);

    if (empty($posts)) {
        wp_send_json_success(['message' => '✅ Tous les produits ont déjà un code HS.']);
    }

    $updated_count = 0;
    foreach ($posts as $post) {
        $product = wc_get_product($post->ID);
        if (!$product) continue;

        $categories = $product->get_category_ids();
        if (!empty($categories)) {
            $main_cat_term = get_term($categories[0], 'product_cat');
            if ($main_cat_term) {
                $main_cat_name = strtolower($main_cat_term->name);
                foreach($hs_map as $type => $code) {
                    if (stripos($main_cat_name, $type) !== false) {
                        update_post_meta($product->get_id(), '_miad_hs_code', $code);
                        $updated_count++;
                        break;
                    }
                }
            }
        }
    }

    wp_send_json_success(['message' => 'Opération terminée. ' . $updated_count . ' produits ont été mis à jour.']);
}

add_action('wp_ajax_miad_dhl_auto_assign_sku', 'miad_ajax_auto_assign_sku');
function miad_ajax_auto_assign_sku() {
    check_ajax_referer('miad_tools_nonce');
    $products = wc_get_products(['limit' => -1, 'status' => ['publish', 'draft', 'pending'], 'sku' => '']);
    if (empty($products)) {
        wp_send_json_success(['message' => '✅ Tous les produits ont déjà un SKU.']);
    }
    $updated_count = 0;
    foreach ($products as $product) {
        $id = $product->get_id();
        $name = $product->get_name();
        $categories = $product->get_category_ids();
        $cat_prefix = 'GEN';
        if (!empty($categories)) {
            $main_cat_term = get_term($categories[0], 'product_cat');
            if ($main_cat_term) {
                $cat_prefix = strtoupper(substr(preg_replace('/[^a-zA-Z0-9]/', '', $main_cat_term->name), 0, 4));
            }
        }
        $name_part = strtoupper(substr(preg_replace('/[^a-zA-Z0-9]/', '', $name), 0, 8));
        $sku = $cat_prefix . '-' . $name_part . '-' . $id;
        $product->set_sku($sku);
        $product->save();
        $updated_count++;
    }
    wp_send_json_success(['message' => 'Opération terminée. ' . $updated_count . ' SKUs ont été générés.']);
}
// --- NOUVEAU : 11. ONGLET TESTS & VALIDATION ---
function miad_dhl_render_tests_tab() {
    ?>
    <div style="background:#fff; padding:20px; border:1px solid #ccc; margin-top:20px;">
        <h3>Tableau de Bord de Tests API DHL</h3>
        <p>Utilisez cette interface pour valider vos cas de test (Shipment, Pickup, Tracking) sans créer de commandes WooCommerce.</p>

        <div style="display:flex; gap:20px; flex-wrap:wrap;">
            <!-- COLONNE GAUCHE : FORMULAIRES -->
            <div style="flex:1; min-width:400px;">
                
                <!-- 1. TEST EXPÉDITION -->
                <div class="postbox">
                    <div class="postbox-header"><h2 class="hndle">1. Test Création Expédition (Shipment)</h2></div>
                    <div class="inside">
                        <form id="miad-test-shipment-form">
                            <table class="form-table">
                                <tr>
                                    <th><label>Test Case ID</label></th>
                                    <td><input type="text" name="test_case_id" placeholder="ex: TC-001" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Environnement</label></th>
                                    <td>
                                        <select name="env" class="miad-env-selector">
                                            <option value="test">Test (Sandbox)</option>
                                            <option value="production">Production</option>
                                        </select>
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Date d'Expédition</label></th>
                                    <td><input type="date" name="planned_shipping_date" value="<?php echo miad_dhl_get_next_shipping_date(); ?>" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Compte DHL (Account)</label></th>
                                    <td><input type="text" name="account_number" placeholder="Laisser vide pour défaut" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Expéditeur (Shipper)</label></th>
                                    <td>
                                        <input type="text" name="shipper_name" placeholder="Nom / Société" value="MIAD MARKET REPRESENTENT MASM" style="width:100%; margin-bottom:5px;">
                                        <input type="text" name="shipper_country" placeholder="Pays (ex: CA)" style="width:60px;" value="CA">
                                        <input type="text" name="shipper_zip" placeholder="Zip" style="width:80px;" value="H4Y1H4">
                                        <input type="text" name="shipper_city" placeholder="Ville" value="Montreal">
                                        <br><input type="text" name="shipper_address" placeholder="Adresse (Rue)" value="123 Shipper St" style="width:100%; margin-top:5px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Destinataire (Receiver)</label></th>
                                    <td>
                                        <input type="text" name="receiver_name" placeholder="Nom Client" value="Client Test" style="width:100%; margin-bottom:5px;">
                                        <input type="text" name="receiver_email" placeholder="Email" value="client@test.com" style="width:48%;">
                                        <input type="text" name="receiver_phone" placeholder="Téléphone" value="1234567890" style="width:48%;">
                                        <input type="text" name="receiver_country" placeholder="Pays (ex: US)" style="width:60px;" value="US">
                                        <input type="text" name="receiver_province" placeholder="Prov" style="width:50px;">
                                        <input type="text" name="receiver_zip" placeholder="Zip" style="width:80px;" value="10001">
                                        <input type="text" name="receiver_city" placeholder="Ville" value="New York">
                                        <br><input type="text" name="receiver_address" placeholder="Adresse (Rue)" value="123 Receiver St" style="width:100%; margin-top:5px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Produit / Douane</label></th>
                                    <td>
                                        <select name="product_code">
                                            <option value="P">P - EXPRESS WORLDWIDE (Non-Doc)</option>
                                            <option value="D">D - EXPRESS WORLDWIDE (Doc)</option>
                                            <option value="N">N - DOMESTIC EXPRESS</option>
                                            <option value="T">T - EXPRESS 12:00 (Doc)</option>
                                            <option value="Y">Y - EXPRESS 12:00 (Non-Doc)</option>
                                            <option value="K">K - EXPRESS 9:00 (Doc)</option>
                                            <option value="E">E - EXPRESS 9:00 (Non-Doc)</option>
                                            <option value="M">M - EXPRESS 10:30 (Doc)</option>
                                            <option value="L">L - EXPRESS 10:30 (Non-Doc)</option>
                                        </select>
                                        <label><input type="checkbox" name="is_declarable" value="1" checked> Dutiable (Douane)</label>
                                        <label><input type="checkbox" name="is_plt" value="1" checked> Paperless Trade (PLT)</label>
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Valeur Déclarée</label></th>
                                    <td><input type="number" name="declared_value" value="50" step="0.01"> <input type="text" name="currency" value="USD" style="width:50px;"></td>
                                </tr>
                                <tr>
                                    <th><label>Facture (Douane)</label></th>
                                    <td>
                                        <input type="text" name="invoice_number" placeholder="N° Facture" class="regular-text" style="width:120px;">
                                        <input type="date" name="invoice_date" value="<?php echo date('Y-m-d'); ?>" style="width:140px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Special Service 1</label></th>
                                    <td>
                                        <select name="special_service_1" onchange="miadCheckInsurance()">
                                            <option value="">-- Aucun --</option>
                                            <option value="WY">WY - Paperless Trade</option>
                                            <option value="II">II - Insurance</option>
                                            <option value="NN">NN - Neutral Delivery</option>
                                            <option value="AA">AA - Saturday Delivery</option>
                                            <option value="PT">PT - Data Staging</option>
                                        </select>
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Special Service 2</label></th>
                                    <td>
                                        <select name="special_service_2" onchange="miadCheckInsurance()">
                                            <option value="">-- Aucun --</option>
                                            <option value="WY">WY - Paperless Trade</option>
                                            <option value="II">II - Insurance</option>
                                            <option value="NN">NN - Neutral Delivery</option>
                                            <option value="AA">AA - Saturday Delivery</option>
                                            <option value="PT">PT - Data Staging</option>
                                        </select>
                                    </td>
                                </tr>
                                <tr id="miad-insurance-row" style="display:none;">
                                    <th><label>Valeur Assurance (II)</label></th>
                                    <td><input type="number" name="insurance_value" placeholder="Montant" step="0.01" class="regular-text" style="width:100px;"> <span style="font-size:12px;">(Devise: même que déclarée)</span></td>
                                </tr>
                                <tr>
                                    <th><label>Shipment & Customs</label></th>
                                    <td>
                                        Incoterm: <select name="incoterm" style="width:auto;">
                                            <option value="DAP">DAP (Client paie taxes)</option>
                                            <option value="DDP">DDP (MIAD paie taxes)</option>
                                        </select>
                                        Export Reason: <input type="text" name="export_reason_type" value="permanent" style="width:100px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Customer Reference</label></th>
                                    <td><input type="text" name="customer_reference" placeholder="Order ID, etc." class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Line Item</label></th>
                                    <td>
                                        Description: <input type="text" name="content_desc" value="Test Shipment Content" style="width:200px;" title="Description for customs line item"><br>
                                        Qty: <input type="number" name="line_item_quantity" value="1" style="width:60px;">
                                        UOM: <input type="text" name="line_item_uom" value="PCS" style="width:60px;">
                                        HS Code: <input type="text" name="hs_code" value="85444290" style="width:80px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Manufacturer Country</label></th>
                                    <td><input type="text" name="manufacturer_country" placeholder="ex: CN" class="regular-text" style="width:60px;" value="CN"></td>
                                </tr>
                                <tr>
                                    <th><label>Remplir depuis Produit</label></th>
                                    <td><input type="number" id="ship_product_id" placeholder="ID Produit" style="width:80px;"> <button type="button" class="button" onclick="miadFillProductInfo('shipment')">Appliquer</button></td>
                                </tr>
                                <tr>
                                    <th><label>Total Packages per Waybill</label></th>
                                    <td>
                                        <input type="number" name="total_packages" value="1" min="1" style="width:60px;" readonly>
                                        <button type="button" class="button" onclick="miadAddPackageRow()">+ Ajouter un colis</button>
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Unit System</label></th>
                                    <td><select name="unit" onchange="miadUpdateUnitLabels()">
                                        <option value="metric">Metric (cm/kg)</option>
                                        <option value="imperial">Imperial (in/lb)</option>
                                    </select></td>
                                </tr>
                                <tbody id="miad-packages-container">
                                    <!-- Les champs pour chaque colis seront générés ici par JavaScript -->
                                </tbody>
                                <tr>
                                </tr>
                                <tr>
                                    <th><label>Documents</label></th>
                                    <td>
                                        <label><input type="checkbox" name="request_waybill_doc" value="1" checked> <strong>Demander Waybill Doc</strong> (Archive)</label>
                                    </td>
                                </tr>
                            </table>
                            <p><button type="button" class="button button-primary" onclick="miadRunTest('shipment')">Lancer le Test Shipment</button></p>
                        </form>
                    </div>
                </div>

                <!-- 2. TEST TRACKING -->
                <div class="postbox">
                    <div class="postbox-header"><h2 class="hndle">2. Test Suivi (Tracking)</h2></div>
                    <div class="inside">
                        <form id="miad-test-tracking-form">
                            <table class="form-table">
                                <tr>
                                    <th><label>Environnement</label></th>
                                    <td>
                                        <select name="env" class="miad-env-selector"><option value="test">Test (Sandbox)</option><option value="production">Production</option></select>
                                    </td>
                                </tr>
                            </table>
                            <table class="form-table">
                                <tr>
                                    <th><label>Numéros de Suivi (AWB)</label></th>
                                    <td><textarea name="tracking_number" placeholder="1234567890, 0987654321" class="regular-text" style="width:100%; height:60px;"></textarea>
                                    <p class="description">Séparez les numéros par des virgules pour en suivre plusieurs.</p></td>
                                </tr>
                                <tr>
                                    <th><label>Tracking View</label></th>
                                    <td>
                                        <select name="tracking_view">
                                            <option value="last-checkpoint">Last Checkpoint</option>
                                            <option value="all-checkpoints">All Checkpoints</option>
                                            <option value="shipment-details-only">Shipment Details Only</option>
                                            <option value="bbx-children">BBX Children</option>
                                        </select>
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Level Of Detail</label></th>
                                    <td>
                                        <select name="level_of_detail">
                                            <option value="all">All</option>
                                            <option value="shipment">Shipment</option>
                                            <option value="piece">Piece</option>
                                            <option value="remarks">Remarks</option>
                                        </select>
                                    </td>
                                </tr>
                            </table>
                            <p><button type="button" class="button button-secondary" onclick="miadRunTest('tracking')">Tracer</button></p>
                        </form>
                    </div>
                </div>

                <!-- 3. TEST PICKUP -->
                <div class="postbox">
                    <div class="postbox-header"><h2 class="hndle">3. Test Enlèvement (Pickup)</h2></div>
                    <div class="inside">
                        <form id="miad-test-pickup-form">
                            <table class="form-table">
                                <tr>
                                    <th><label>Environnement</label></th>
                                    <td>
                                        <select name="env" class="miad-env-selector"><option value="test">Test (Sandbox)</option><option value="production">Production</option></select>
                                    </td>
                                </tr>
                            </table>
                            <p class="description">Pour un "Remote Pickup" (enlèvement dans un autre pays), changez simplement le pays de l'expéditeur ci-dessous.</p>
                            <table class="form-table">
                                <tr>
                                    <th><label>Date d'enlèvement</label></th>
                                    <td><input type="date" name="pickup_date" value="<?php echo miad_dhl_get_next_shipping_date(); ?>" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Heure de mise à dispo</label></th>
                                    <td><input type="time" name="ready_time" value="10:00" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Heure de fermeture</label></th>
                                    <td><input type="time" name="close_time" value="18:00" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Lieu (Location)</label></th>
                                    <td><input type="text" name="location" value="Reception Test" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Détails Expéditeur (Shipper)</label></th>
                                    <td>
                                        <input type="text" name="pickup_shipper_company" placeholder="Société" value="MIAD MARKET" style="width:48%;">
                                        <input type="text" name="pickup_shipper_name" placeholder="Nom complet" value="Brunel Atekossi" style="width:48%;"><br>
                                        <input type="email" name="pickup_shipper_email" placeholder="Email" value="abmcompanysn@gmail.com" style="width:48%; margin-top:5px;">
                                        <input type="tel" name="pickup_shipper_phone" placeholder="Téléphone" value="1234567890" style="width:48%; margin-top:5px;"><br>
                                        <input type="text" name="pickup_shipper_address" placeholder="Adresse" value="Test Address" style="width:100%; margin-top:5px;"><br>
                                        <input type="text" name="pickup_shipper_city" placeholder="Ville" value="Dakar" style="width:48%; margin-top:5px;">
                                        <input type="text" name="pickup_shipper_zip" placeholder="Code Postal" value="10000" style="width:20%; margin-top:5px;">
                                        <input type="text" name="pickup_shipper_country" placeholder="Pays (SN)" value="SN" style="width:20%; margin-top:5px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Détails Destinataire (Receiver)</label></th>
                                    <td>
                                        <input type="text" name="pickup_receiver_company" placeholder="Société" value="Client Final" style="width:48%;">
                                        <input type="text" name="pickup_receiver_name" placeholder="Nom complet" value="Jean Dupont" style="width:48%;"><br>
                                        <input type="email" name="pickup_receiver_email" placeholder="Email" value="client@test.com" style="width:48%; margin-top:5px;">
                                        <input type="tel" name="pickup_receiver_phone" placeholder="Téléphone" value="0987654321" style="width:48%; margin-top:5px;"><br>
                                        <input type="text" name="pickup_receiver_address" placeholder="Adresse" value="123 Receiver St" style="width:100%; margin-top:5px;"><br>
                                        <input type="text" name="pickup_receiver_city" placeholder="Ville" value="New York" style="width:48%; margin-top:5px;">
                                        <input type="text" name="pickup_receiver_zip" placeholder="Code Postal" value="10001" style="width:20%; margin-top:5px;">
                                        <input type="text" name="pickup_receiver_country" placeholder="Pays (US)" value="US" style="width:20%; margin-top:5px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Détails Demandeur (Requestor)</label></th>
                                    <td>
                                        <input type="text" name="pickup_requestor_company" placeholder="Société" value="<?php echo esc_attr(get_bloginfo('name')); ?>" style="width:48%;">
                                        <input type="text" name="pickup_requestor_name" placeholder="Nom complet" value="Responsable Logistique" style="width:48%;"><br>
                                        <input type="email" name="pickup_requestor_email" placeholder="Email" value="<?php echo esc_attr(get_option('admin_email')); ?>" style="width:48%; margin-top:5px;">
                                        <input type="tel" name="pickup_requestor_phone" placeholder="Téléphone" value="1234567890" style="width:48%; margin-top:5px;"><br>
                                        <input type="text" name="pickup_requestor_address" placeholder="Adresse" value="Siege Social" style="width:100%; margin-top:5px;"><br>
                                        <input type="text" name="pickup_requestor_city" placeholder="Ville" value="<?php echo esc_attr(get_option('miad_dhl_shipper_city', 'Dakar')); ?>" style="width:48%; margin-top:5px;">
                                        <input type="text" name="pickup_requestor_zip" placeholder="Code Postal" value="<?php echo esc_attr(get_option('miad_dhl_shipper_zip', '10001')); ?>" style="width:20%; margin-top:5px;">
                                        <input type="text" name="pickup_requestor_country" placeholder="Pays (SN)" value="<?php echo esc_attr(get_option('miad_dhl_shipper_country', 'SN')); ?>" style="width:20%; margin-top:5px;">
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Instructions Spéciales</label></th>
                                    <td><input type="text" name="pickup_instructions" placeholder="ex: Appeler avant d'arriver" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Remarque</label></th>
                                    <td><textarea name="pickup_remark" placeholder="ex: Colis fragile" class="regular-text" rows="2"></textarea></td>
                                </tr>
                                <tr>
                                    <th><label>Colis (Poids/Dim)</label></th>
                                    <td>
                                        <input type="number" name="weight" placeholder="kg" value="1" style="width:60px;"> kg
                                        <input type="number" name="length" placeholder="L" value="20" style="width:50px;"> x 
                                        <input type="number" name="width" placeholder="W" value="20" style="width:50px;"> x 
                                        <input type="number" name="height" placeholder="H" value="20" style="width:50px;"> cm
                                    </td>
                                </tr>
                            </table>
                            <p><button type="button" class="button button-secondary" onclick="miadRunTest('pickup')">Lancer Test Pickup</button></p>
                        </form>
                    </div>
                </div>

                <!-- 3.5 LIST PICKUPS -->
                <div class="postbox">
                    <div class="postbox-header"><h2 class="hndle">3.5. Lister les Enlèvements Programmés</h2></div>
                    <div class="inside">
                        <form id="miad-test-list-pickup-form">
                            <table class="form-table">
                                <tr>
                                    <th><label>Environnement</label></th>
                                    <td>
                                        <select name="env" class="miad-env-selector"><option value="test">Test (Sandbox)</option><option value="production">Production</option></select>
                                    </td>
                                </tr>
                            </table>
                            <p>Récupère la liste des enlèvements pour une période donnée (pour le compte configuré).</p>
                            <table class="form-table">
                                <tr>
                                    <th><label>Date de début</label></th>
                                    <td><input type="date" name="list_start_date" value="<?php echo miad_dhl_get_next_shipping_date(); ?>" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Date de fin</label></th>
                                    <td><input type="date" name="list_end_date" value="<?php echo date('Y-m-d', strtotime('+7 days')); ?>" class="regular-text"></td>
                                </tr>
                            </table>
                            <p><button type="button" class="button button-secondary" onclick="miadRunTest('list_pickups')">Lister les Enlèvements</button></p>
                        </form>
                    </div>
                </div>

                <!-- 3.6 CANCEL PICKUP -->
                <div class="postbox">
                    <div class="postbox-header"><h2 class="hndle">3.6. Annuler un Enlèvement</h2></div>
                    <div class="inside">
                        <form id="miad-test-cancel-pickup-form">
                            <table class="form-table">
                                <tr>
                                    <th><label>Environnement</label></th>
                                    <td>
                                        <select name="env" class="miad-env-selector"><option value="test">Test (Sandbox)</option><option value="production">Production</option></select>
                                    </td>
                                </tr>
                            </table>
                            <p>Annule une demande d'enlèvement en utilisant son numéro de confirmation.</p>
                            <table class="form-table">
                                <tr>
                                    <th><label>Numéro de Confirmation</label></th>
                                    <td><input type="text" name="cancel_confirmation_number" placeholder="ex: CBJ2009160000001" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Nom du Demandeur</label></th>
                                    <td><input type="text" name="cancel_requestor_name" value="<?php echo esc_attr(wp_get_current_user()->display_name); ?>" class="regular-text"></td>
                                </tr>
                                <tr>
                                    <th><label>Raison de l'annulation</label></th>
                                    <td><select name="cancel_reason"><option value="001">001 - Pickup Cancelled by Customer</option><option value="002">002 - Goods Not Ready</option><option value="007">007 - Other</option></select></td>
                                </tr>
                            </table>
                            <p><button type="button" class="button button-danger" onclick="miadRunTest('cancel_pickup')">Annuler l'Enlèvement</button></p>
                        </form>
                    </div>
                </div>

                <!-- 5. TEST RATING (NOUVEAU) -->
                <div class="postbox">
                    <div class="postbox-header"><h2 class="hndle">5. Test Rating (Calcul Tarif - GET /rates)</h2></div>
                    <div class="inside">
                        <form id="miad-test-rating-form">
                            <table class="form-table">
                                <tr>
                                    <th><label>Environnement</label></th>
                                    <td>
                                        <select name="env" class="miad-env-selector"><option value="test">Test (Sandbox)</option><option value="production">Production</option></select>
                                    </td>
                                </tr>
                            </table>
                            <p>Simule le calcul de frais de port tel qu'il apparaît dans le panier WooCommerce.</p>
                            <table class="form-table">
                                <tr>
                                    <th><label>Produit (ID)</label></th>
                                    <td>
                                        <input type="number" id="rate_product_id" placeholder="ID Produit" class="regular-text" style="width:100px;">
                                        <button type="button" class="button" onclick="miadFillProductInfo('rating')">Remplir Infos</button>
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Poids / Dimensions</label></th>
                                    <td>
                                        <input type="text" name="weight" placeholder="kg" style="width:60px;"> kg
                                        <input type="text" name="length" placeholder="L" style="width:50px;"> x
                                        <input type="text" name="width" placeholder="W" style="width:50px;"> x
                                        <input type="text" name="height" placeholder="H" style="width:50px;"> cm
                                    </td>
                                </tr>
                                <tr>
                                    <th><label>Destination</label></th>
                                    <td>
                                        <input type="text" name="to_country" placeholder="Pays (ex: US)" value="US" style="width:60px;">
                                        <input type="text" name="to_city" placeholder="Ville" value="New York">
                                        <input type="text" name="to_zip" placeholder="Zip" value="10001">
                                    </td>
                                </tr>
                            </table>
                            <p><button type="button" class="button button-primary" onclick="miadRunTest('rating_simple')">Calculer le Tarif</button></p>
                        </form>
                    </div>
                </div>

                <!-- 4. TEST EN MASSE (CSV) -->
                <div class="postbox">
                    <div class="postbox-header"><h2 class="hndle">4. Test en Masse (CSV)</h2></div>
                    <div class="inside">
                        <form id="miad-test-bulk-form" enctype="multipart/form-data">
                            <p>Téléversez un fichier CSV pour tester plusieurs expéditions d'un coup.</p>
                            <p>
                                <label>Environnement :</label>
                                <select name="env">
                                    <option value="test">Test (Sandbox)</option>
                                    <option value="production">Production</option>
                                </select>
                            </p>
                            <p><input type="file" name="csv_file" accept=".csv" required></p>
                            <p>
                                <button type="button" class="button button-primary" onclick="miadRunBulkTest()">Lancer le Test en Masse</button>
                                <button type="button" class="button" onclick="miadDownloadTemplate()">Télécharger Modèle CSV</button>
                            </p>
                        </form>
                    </div>
                </div>

            </div>

            <!-- COLONNE DROITE : RÉSULTATS -->
            <div style="flex:1; min-width:400px;">
                <div class="postbox" style="min-height: 500px; background: #23282d; color: #fff;">
                    <div class="postbox-header" style="border-bottom: 1px solid #444;"><h2 class="hndle" style="color:#fff;">Console de Résultat</h2></div>
                    <div class="inside">
                        <div id="miad-test-spinner" style="display:none; text-align:center; padding:20px;"><span class="spinner is-active" style="float:none;"></span> Traitement...</div>
                        <pre id="miad-test-output" style="white-space: pre-wrap; word-wrap: break-word; font-family: monospace; font-size: 12px; color: #00f900; padding: 10px;">En attente d'un test...</pre>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <style>
        .miad-env-selector { background: #fff3cd; border-color: #ffc107; font-weight: bold; }
        .miad-env-selector option[value="production"] { background: #f8d7da; color: #721c24; }
    </style>

    <script>
    function miadFillProductInfo(type) {
        var pid = (type === 'shipment') ? document.getElementById('ship_product_id').value : document.getElementById('rate_product_id').value;
        if(!pid) { alert('Entrez un ID produit'); return; }
        
        var btn = event.target;
        btn.innerText = '...';
        
        jQuery.post(ajaxurl, { action: 'miad_dhl_get_product_info', product_id: pid }, function(res) {
            btn.innerText = 'Appliquer';
            if(res.success) {
                var d = res.data;
                var formId = (type === 'shipment') ? 'miad-test-shipment-form' : 'miad-test-rating-form';
                var form = document.getElementById(formId);
                
                if(form.querySelector('[name="weight"]')) form.querySelector('[name="weight"]').value = d.weight || 1;
                if(form.querySelector('[name="length"]')) form.querySelector('[name="length"]').value = d.length || 10;
                if(form.querySelector('[name="width"]')) form.querySelector('[name="width"]').value = d.width || 10;
                if(form.querySelector('[name="height"]')) form.querySelector('[name="height"]').value = d.height || 10;
                
                if(type === 'shipment') {
                    if(form.querySelector('[name="declared_value"]')) form.querySelector('[name="declared_value"]').value = d.price || 50;
                    if(form.querySelector('[name="content_desc"]')) form.querySelector('[name="content_desc"]').value = d.name;
                }
            } else { alert(res.data.message); }
        });
    }

    function miadRunTest(type) {
        var output = document.getElementById('miad-test-output');
        var spinner = document.getElementById('miad-test-spinner');
        var data = {};

        if (type === 'shipment') {
            var form = document.getElementById('miad-test-shipment-form');
            data = {
                action: 'miad_dhl_run_test_shipment',
                test_case_id: form.querySelector('[name="test_case_id"]').value,
                planned_shipping_date: form.querySelector('[name="planned_shipping_date"]').value,
                env: form.querySelector('[name="env"]').value,
                account_number: form.querySelector('[name="account_number"]').value,
                shipper_name: form.querySelector('[name="shipper_name"]').value,
                shipper_country: form.querySelector('[name="shipper_country"]').value,
                shipper_zip: form.querySelector('[name="shipper_zip"]').value,
                shipper_city: form.querySelector('[name="shipper_city"]').value,
                shipper_address: form.querySelector('[name="shipper_address"]').value,
                receiver_country: form.querySelector('[name="receiver_country"]').value,
                    receiver_province: form.querySelector('[name="receiver_province"]').value,
                receiver_zip: form.querySelector('[name="receiver_zip"]').value,
                receiver_city: form.querySelector('[name="receiver_city"]').value,
                receiver_address: form.querySelector('[name="receiver_address"]').value,
                receiver_name: form.querySelector('[name="receiver_name"]').value,
                receiver_email: form.querySelector('[name="receiver_email"]').value,
                receiver_phone: form.querySelector('[name="receiver_phone"]').value,
                product_code: form.querySelector('[name="product_code"]').value,
                is_declarable: form.querySelector('[name="is_declarable"]').checked ? 1 : 0,
                is_plt: form.querySelector('[name="is_plt"]').checked ? 1 : 0,
                declared_value: form.querySelector('[name="declared_value"]').value,
                invoice_number: form.querySelector('[name="invoice_number"]').value,
                invoice_date: form.querySelector('[name="invoice_date"]').value,
                currency: form.querySelector('[name="currency"]').value,
                special_service_1: form.querySelector('[name="special_service_1"]').value,
                special_service_2: form.querySelector('[name="special_service_2"]').value,
                insurance_value: form.querySelector('[name="insurance_value"]').value,
                content_desc: form.querySelector('[name="content_desc"]').value,
                incoterm: form.querySelector('[name="incoterm"]').value,
                export_reason_type: form.querySelector('[name="export_reason_type"]').value,
                customer_reference: form.querySelector('[name="customer_reference"]').value,
                line_item_quantity: form.querySelector('[name="line_item_quantity"]').value,
                line_item_uom: form.querySelector('[name="line_item_uom"]').value,
                hs_code: form.querySelector('[name="hs_code"]').value,
                manufacturer_country: form.querySelector('[name="manufacturer_country"]').value,
                total_packages: form.querySelector('[name="total_packages"]').value,
                unit: form.querySelector('[name="unit"]').value,
                request_waybill_doc: form.querySelector('[name="request_waybill_doc"]').checked ? 1 : 0
            };

            // Récupérer les données de chaque colis
            var totalPackages = parseInt(form.querySelector('[name="total_packages"]').value, 10);
            var packages = [];
            for (var i = 1; i <= totalPackages; i++) {
                packages.push({
                    weight: form.querySelector('[name="weight_' + i + '"]').value,
                    length: form.querySelector('[name="length_' + i + '"]').value,
                    width: form.querySelector('[name="width_' + i + '"]').value,
                    height: form.querySelector('[name="height_' + i + '"]').value,
                });
            }
            data.packages = packages;

        } else if (type === 'tracking') {
            var form = document.getElementById('miad-test-tracking-form');
            data = {
                action: 'miad_dhl_run_test_tracking',
                env: form.querySelector('[name="env"]').value,
                tracking_number: form.querySelector('[name="tracking_number"]').value,
                tracking_view: form.querySelector('[name="tracking_view"]').value,
                level_of_detail: form.querySelector('[name="level_of_detail"]').value
            };
        } else if (type === 'rating_simple') {
            var form = document.getElementById('miad-test-rating-form');
            data = {
                action: 'miad_dhl_run_test_rating',
                env: form.querySelector('[name="env"]').value,
                weight: form.querySelector('[name="weight"]').value,
                length: form.querySelector('[name="length"]').value,
                width: form.querySelector('[name="width"]').value,
                height: form.querySelector('[name="height"]').value,
                to_country: form.querySelector('[name="to_country"]').value,
                to_city: form.querySelector('[name="to_city"]').value,
                to_zip: form.querySelector('[name="to_zip"]').value
            };
        } else if (type === 'pickup') {
            var form = document.getElementById('miad-test-pickup-form');
            data = { 
                action: 'miad_dhl_run_test_pickup',
                env: form.querySelector('[name="env"]').value,
                pickup_date: form.querySelector('[name="pickup_date"]').value,
                ready_time: form.querySelector('[name="ready_time"]').value,
                close_time: form.querySelector('[name="close_time"]').value,
                location: form.querySelector('[name="location"]').value,
                pickup_shipper_company: form.querySelector('[name="pickup_shipper_company"]').value,
                pickup_shipper_name: form.querySelector('[name="pickup_shipper_name"]').value,
                pickup_shipper_email: form.querySelector('[name="pickup_shipper_email"]').value,
                pickup_shipper_phone: form.querySelector('[name="pickup_shipper_phone"]').value,
                pickup_shipper_address: form.querySelector('[name="pickup_shipper_address"]').value,
                pickup_shipper_city: form.querySelector('[name="pickup_shipper_city"]').value,
                pickup_shipper_zip: form.querySelector('[name="pickup_shipper_zip"]').value,
                pickup_shipper_country: form.querySelector('[name="pickup_shipper_country"]').value,
                pickup_receiver_company: form.querySelector('[name="pickup_receiver_company"]').value,
                pickup_receiver_name: form.querySelector('[name="pickup_receiver_name"]').value,
                pickup_receiver_email: form.querySelector('[name="pickup_receiver_email"]').value,
                pickup_receiver_phone: form.querySelector('[name="pickup_receiver_phone"]').value,
                pickup_receiver_address: form.querySelector('[name="pickup_receiver_address"]').value,
                pickup_receiver_city: form.querySelector('[name="pickup_receiver_city"]').value,
                pickup_receiver_zip: form.querySelector('[name="pickup_receiver_zip"]').value,
                pickup_receiver_country: form.querySelector('[name="pickup_receiver_country"]').value,
                pickup_requestor_company: form.querySelector('[name="pickup_requestor_company"]').value,
                pickup_requestor_name: form.querySelector('[name="pickup_requestor_name"]').value,
                pickup_requestor_email: form.querySelector('[name="pickup_requestor_email"]').value,
                pickup_requestor_phone: form.querySelector('[name="pickup_requestor_phone"]').value,
                pickup_requestor_address: form.querySelector('[name="pickup_requestor_address"]').value,
                pickup_requestor_city: form.querySelector('[name="pickup_requestor_city"]').value,
                pickup_requestor_zip: form.querySelector('[name="pickup_requestor_zip"]').value,
                pickup_requestor_country: form.querySelector('[name="pickup_requestor_country"]').value,
                pickup_instructions: form.querySelector('[name="pickup_instructions"]').value,
                pickup_remark: form.querySelector('[name="pickup_remark"]').value,
                weight: form.querySelector('[name="weight"]').value,
                length: form.querySelector('[name="length"]').value,
                width: form.querySelector('[name="width"]').value,
                height: form.querySelector('[name="height"]').value
            };
        } else if (type === 'list_pickups') {
            var form = document.getElementById('miad-test-list-pickup-form');
            data = {
                action: 'miad_dhl_run_test_list_pickups',
                env: form.querySelector('[name="env"]').value,
                start_date: form.querySelector('[name="list_start_date"]').value,
                end_date: form.querySelector('[name="list_end_date"]').value,
            };
        } else if (type === 'cancel_pickup') {
            var form = document.getElementById('miad-test-cancel-pickup-form');
            data = {
                action: 'miad_dhl_run_test_cancel_pickup',
                env: form.querySelector('[name="env"]').value,
                confirmation_number: form.querySelector('[name="cancel_confirmation_number"]').value,
                requestor_name: form.querySelector('[name="cancel_requestor_name"]').value,
                reason: form.querySelector('[name="cancel_reason"]').value,
            };
        }

        data._ajax_nonce = '<?php echo wp_create_nonce("miad_test_nonce"); ?>';

        miadExecuteTestAjax(data, output, spinner);
    }

    function miadExecuteTestAjax(data, output, spinner) {
        output.innerHTML = '';
        spinner.style.display = 'block';

        jQuery.post(ajaxurl, data, function(response) {
            spinner.style.display = 'none';
            if (response.success) {
                if (response.data.Status === 'ERROR') {
                    var outputHtml = "❌ ERREUR API DHL :\n" + JSON.stringify(response.data, null, 4);
                    if (response.data['Error Message'] && response.data['Error Message'].includes('8009')) {
                        outputHtml += "\n\n💡 CONSEIL : L'erreur 8009 indique que ce numéro de compte n'est pas activé pour l'environnement de Test (Sandbox). Si vous faites une certification, assurez-vous que DHL a bien whitelisted ce compte pour le test, sinon utilisez la Production.";
                    }
                    output.innerHTML = outputHtml;
                    output.style.color = '#d63638';
                } else {
                    // Nettoyage pour l'affichage (On cache les gros blocs de données binaires)
                    var displayData = JSON.parse(JSON.stringify(response.data)); // Clone
                    if(displayData.Label_Base64) displayData.Label_Base64 = "(Données binaires masquées - Voir bouton ci-dessous)";
                    if(displayData.Label_URL) displayData.Label_URL = "(URL masquée)";
                    if(displayData.Invoice_Base64) displayData.Invoice_Base64 = "(Données binaires masquées - Voir bouton ci-dessous)";
                    if(displayData.Invoice_URL) displayData.Invoice_URL = "(URL masquée)";
                    if(displayData['Shipment Request (JSON)']) displayData['Shipment Request (JSON)'] = "(Voir bouton JSON Req)";
                    if(displayData['Shipment Response']) displayData['Shipment Response'] = "(Voir bouton JSON Res)";
                    if(displayData['Rating Request (JSON)']) displayData['Rating Request (JSON)'] = "(Voir bouton Rating Req)";
                    if(displayData['Rating Response']) displayData['Rating Response'] = "(Voir bouton Rating Res)";
                    if(displayData['Tracking Request (JSON)']) displayData['Tracking Request (JSON)'] = "(Voir bouton Track Req)";
                    if(displayData['Tracking Response']) displayData['Tracking Response'] = "(Voir bouton Track Res)";

                    // Stockage global pour téléchargement (évite les chaînes trop longues dans le HTML)
                    window.miad_last_test_result = response.data;

                    var emailInfoHtml = "";
                    if (response.data.Email_Info) {
                        emailInfoHtml = "<div style='background:#e8f5e9; color:#005826; padding:10px; border-left:4px solid #00a32a; margin-bottom:10px;'>" + response.data.Email_Info + "</div>";
                        delete displayData.Email_Info;
                    }

                    var outputHtml = emailInfoHtml + "✅ SUCCÈS :\n" + JSON.stringify(displayData, null, 4);
                    
                    // Boutons de téléchargement (Rating)
                    if (response.data['Rating Request (JSON)']) {
                        outputHtml += '\n\n<strong>Fichiers Rate (Tarif) :</strong><br>';
                        outputHtml += '<button class="button" onclick="miadDownloadFile(\'Rating_Req.json\', \'' + encodeURIComponent(response.data['Rating Request (JSON)']) + '\', false)">📥 Rate Req</button> ';
                        outputHtml += '<button class="button" onclick="miadDownloadFile(\'Rating_Res.json\', \'' + encodeURIComponent(response.data['Rating Response']) + '\', false)">📥 Rate Res</button>';
                    }

                    // Boutons de téléchargement (Tracking)
                    if (response.data['Tracking Request (JSON)']) {
                        outputHtml += '\n\n<strong>Fichiers Tracking :</strong><br>';
                        outputHtml += '<button class="button" onclick="miadDownloadFile(\'Tracking_Req.json\', \'' + encodeURIComponent(response.data['Tracking Request (JSON)']) + '\', false)">📥 Track Req</button> ';
                        outputHtml += '<button class="button" onclick="miadDownloadFile(\'Tracking_Res.json\', \'' + encodeURIComponent(response.data['Tracking Response']) + '\', false)">📥 Track Res</button>';
                    }

                    // Boutons de téléchargement (Shipment)
                    outputHtml += '\n\n<strong>Fichiers Shipment (Expédition) :</strong><br>';
                    if (response.data.Label_URL) {
                        outputHtml += '<button class="button button-primary" onclick="miadDownloadFile(\'Label.pdf\', window.miad_last_test_result.Label_Base64, true)">📄 Étiquette</button> ';
                    }
                    if (response.data.Invoice_URL) {
                        outputHtml += '<button class="button button-secondary" onclick="miadDownloadFile(\'Invoice.pdf\', window.miad_last_test_result.Invoice_Base64, true)">📄 Facture Douane</button> ';
                    }
                    if (response.data.WaybillDoc_URL) {
                        outputHtml += '<button class="button button-secondary" onclick="miadDownloadFile(\'WaybillDoc.pdf\', window.miad_last_test_result.WaybillDoc_Base64, true)">📄 Waybill Doc</button> ';
                    }
                    // Ajout des boutons de téléchargement JSON
                    if (response.data['Shipment Request (JSON)']) {
                        outputHtml += '<button class="button" onclick="miadDownloadFile(\'Shipment_Req.json\', \'' + encodeURIComponent(response.data['Shipment Request (JSON)']) + '\', false)">📥 Ship Req</button> ';
                    }
                    if (response.data['Shipment Response']) {
                        outputHtml += '<button class="button" onclick="miadDownloadFile(\'Shipment_Res.json\', \'' + encodeURIComponent(response.data['Shipment Response']) + '\', false)">📥 Ship Res</button>';
                    }
                    
                    // BOUTON ZIP GLOBAL
                    outputHtml += '<br><br><button class="button button-primary button-large" onclick="miadDownloadTestZip()">📦 Télécharger Tout (ZIP)</button>';

                    output.innerHTML = outputHtml;
                    output.style.color = '#00a32a';
                }
            } else {
                output.innerHTML = "❌ ÉCHEC :\n" + JSON.stringify(response.data, null, 4);
                output.style.color = '#d63638';
            }
        }).fail(function(xhr) {
            spinner.style.display = 'none';
            output.innerHTML = "❌ ERREUR AJAX :\n" + xhr.responseText;
            output.style.color = '#d63638';
        });
    }

    function miadDownloadFile(filename, content, isBase64) {
        var element = document.createElement('a');
        if (isBase64) {
            element.setAttribute('href', 'data:application/pdf;base64,' + content);
        } else {
            element.setAttribute('href', 'data:text/plain;charset=utf-8,' + decodeURIComponent(content));
        }
        element.setAttribute('download', filename);
        element.style.display = 'none';
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
    }

    function miadDownloadTestZip() {
        var data = window.miad_last_test_result;
        if(!data) { alert("Aucune donnée à télécharger."); return; }

        var form = document.createElement('form');
        form.method = 'POST';
        form.action = ajaxurl;
        
        var fields = {
            'action': 'miad_dhl_download_zip',
            'waybill': data['Waybill Number'] || 'Test',
            'rating_req': data['Rating Request (JSON)'],
            'rating_res': data['Rating Response'],
            'shipment_req': data['Shipment Request (JSON)'],
            'shipment_res': data['Shipment Response'],
            'tracking_req': data['Tracking Request (JSON)'],
            'tracking_res': data['Tracking Response'],
            'generic_req': data['Request'],
            'generic_res': data['Response'],
            'label_b64': data.Label_Base64,
            'invoice_b64': data.Invoice_Base64,
            'waybilldoc_b64': data.WaybillDoc_Base64
        };

        for (var key in fields) {
            if (fields[key]) {
                var input = document.createElement('input');
                input.type = 'hidden';
                input.name = key;
                input.value = fields[key];
                form.appendChild(input);
            }
        }
        
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
    }

    function miadRunBulkTest() {
        var output = document.getElementById('miad-test-output');
        var spinner = document.getElementById('miad-test-spinner');
        var form = document.getElementById('miad-test-bulk-form');
        var formData = new FormData(form);
        
        formData.append('action', 'miad_dhl_run_bulk_test_shipment');
        formData.append('_ajax_nonce', '<?php echo wp_create_nonce("miad_test_nonce"); ?>');

        output.innerHTML = '';
        spinner.style.display = 'block';

        jQuery.ajax({
            url: ajaxurl,
            type: 'POST',
            data: formData,
            processData: false,
            contentType: false,
            success: function(response) {
                spinner.style.display = 'none';
                if (response.success) {
                    var outputHtml = "<h3>✅ RÉSULTATS EN MASSE</h3><table class='wp-list-table widefat fixed striped'>";
                    outputHtml += "<thead><tr><th>ID</th><th>Status</th><th>Waybill</th><th>Documents & Logs</th></tr></thead><tbody>";
                    
                    response.data.forEach(function(row, index) {
                        var statusIcon = row.Status === 'SUCCESS' ? '✅' : '❌';
                        outputHtml += "<tr>";
                        outputHtml += "<td><strong>" + row.ID + "</strong></td>";
                        outputHtml += "<td>" + statusIcon + " " + row.Status + (row.Error ? "<br><small style='color:red'>" + row.Error + "</small>" : "") + "</td>";
                        outputHtml += "<td>" + row.Waybill + "</td>";
                        outputHtml += "<td>";
                        
                        // Boutons de téléchargement
                        if (row.Files) {
                            var f = row.Files;
                            // Stocker les données dans des variables globales temporaires ou data attributes pour éviter les problèmes de quotes
                            // Pour simplifier ici, on utilise une approche directe avec onclick
                            window['miad_files_' + index] = f;
                            
                            outputHtml += "<button class='button button-small' onclick='miadDownloadFile(\"" + row.ID + "_Rating_Req.xml\", window[\"miad_files_" + index + "\"].Rating_Req, false)'>Rating Req</button> ";
                            outputHtml += "<button class='button button-small' onclick='miadDownloadFile(\"" + row.ID + "_Rating_Res.xml\", window[\"miad_files_" + index + "\"].Rating_Res, false)'>Rating Res</button><br>";
                            outputHtml += "<button class='button button-small' onclick='miadDownloadFile(\"" + row.ID + "_Shipment_Req.xml\", window[\"miad_files_" + index + "\"].Shipment_Req, false)'>Shipment Req</button> ";
                            outputHtml += "<button class='button button-small' onclick='miadDownloadFile(\"" + row.ID + "_Shipment_Res.xml\", window[\"miad_files_" + index + "\"].Shipment_Res, false)'>Shipment Res</button><br>";
                            
                            if (f.Label) outputHtml += "<button class='button button-small button-primary' onclick='miadDownloadFile(\"" + row.ID + "_Label.pdf\", window[\"miad_files_" + index + "\"].Label, true)'>📄 Label</button> ";
                            if (f.Invoice) outputHtml += "<button class='button button-small button-secondary' onclick='miadDownloadFile(\"" + row.ID + "_Invoice.pdf\", window[\"miad_files_" + index + "\"].Invoice, true)'>📄 Invoice</button>";
                        }
                        outputHtml += "</td></tr>";
                    });
                    outputHtml += "</tbody></table>";
                    output.innerHTML = outputHtml;
                } else {
                    output.innerHTML = "❌ ÉCHEC :\n" + response.data.message;
                }
            },
            error: function(xhr) {
                spinner.style.display = 'none';
                output.innerHTML = "❌ ERREUR AJAX :\n" + xhr.responseText;
            }
        });
    }

    function miadDownloadTemplate() {
        var headers = ["test_case_id", "shipper_country", "shipper_zip", "shipper_city", "receiver_country", "receiver_zip", "receiver_city", "product_code", "is_declarable", "declared_value", "currency", "weight"];
        var row = ["TC-001", "US", "10001", "New York", "CA", "M5V2T6", "Toronto", "P", "1", "50", "USD", "0.5"];
        var csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n" + row.join(",");
        var encodedUri = encodeURI(csvContent);
        var link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "dhl_bulk_test_template.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function miadAddPackageRow() {
        var container = document.getElementById('miad-packages-container');
        if (!container) return;
        
        var rowCount = container.children.length + 1;
        var unitSelect = document.querySelector('select[name="unit"]');
        var unit = unitSelect ? unitSelect.value : 'metric';
        var wUnit = (unit === 'imperial') ? 'lb' : 'kg';
        var dUnit = (unit === 'imperial') ? 'in' : 'cm';

        var tr = document.createElement('tr');
        tr.innerHTML = '<th><label>Package ' + rowCount + ' (' + wUnit + '/' + dUnit + ')</label></th>' +
            '<td>' +
                '<input type="number" name="weight_' + rowCount + '" placeholder="Poids" value="0.5" step="0.1" style="width:70px;"> ' +
                '<input type="number" name="length_' + rowCount + '" placeholder="L" value="10" style="width:50px;"> x ' +
                '<input type="number" name="width_' + rowCount + '" placeholder="l" value="10" style="width:50px;"> x ' +
                '<input type="number" name="height_' + rowCount + '" placeholder="H" value="10" style="width:50px;">' +
                (rowCount > 1 ? ' <button type="button" class="button button-small" onclick="miadRemovePackageRow(this)" style="color:red; margin-left:5px;">X</button>' : '') +
            '</td>';
        container.appendChild(tr);
        document.querySelector('[name="total_packages"]').value = rowCount;
    }

    function miadRemovePackageRow(btn) {
        var row = btn.closest('tr');
        row.parentNode.removeChild(row);
        miadUpdateUnitLabels(); // Re-index and update labels
    }

    function miadUpdateUnitLabels() {
        var container = document.getElementById('miad-packages-container');
        if(!container) return;
        var rows = container.querySelectorAll('tr');
        var unitSelect = document.querySelector('select[name="unit"]');
        var unit = unitSelect ? unitSelect.value : 'metric';
        var wUnit = (unit === 'imperial') ? 'lb' : 'kg';
        var dUnit = (unit === 'imperial') ? 'in' : 'cm';
        
        for(var i=0; i<rows.length; i++) {
            var idx = i + 1;
            var r = rows[i];
            r.querySelector('th label').innerText = 'Package ' + idx + ' (' + wUnit + '/' + dUnit + ')';
            var inputs = r.querySelectorAll('input');
            if(inputs.length >= 4) {
                inputs[0].name = 'weight_' + idx;
                inputs[1].name = 'length_' + idx;
                inputs[2].name = 'width_' + idx;
                inputs[3].name = 'height_' + idx;
            }
        }
        document.querySelector('[name="total_packages"]').value = rows.length;
    }

    function miadCheckInsurance() {
        var s1 = document.querySelector('[name="special_service_1"]').value;
        var s2 = document.querySelector('[name="special_service_2"]').value;
        var row = document.getElementById('miad-insurance-row');
        if (row) {
            row.style.display = (s1 === 'II' || s2 === 'II') ? 'table-row' : 'none';
        }
    }

    // Génération initiale des champs de colis au chargement de la page
    document.addEventListener('DOMContentLoaded', function() {
        if(document.getElementById('miad-packages-container')) {
            miadAddPackageRow();
        }
    });
    </script>
    <?php
}

// --- AJAX HANDLERS POUR LES TESTS ---

function miad_dhl_execute_test_shipment($p) {
    // Credentials
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $account = !empty($p['account_number']) ? sanitize_text_field($p['account_number']) : get_option('miad_dhl_account_number');
    
    if (!$site_id || !$password || !$account) {
        return ['Status' => 'ERROR', 'Error Message' => 'Credentials API manquants dans la configuration.'];
    }

    // CACHE: Check if result exists (Optimisation CPU/API)
    $cache_key = 'miad_dhl_test_exec_' . md5(json_encode($p) . $site_id);
    $cached_result = get_transient($cache_key);
    if ($cached_result !== false) {
        return $cached_result;
    }

    // Environnement
    $env = isset($p['env']) ? sanitize_text_field($p['env']) : 'test';

    $date = !empty($p['planned_shipping_date']) ? sanitize_text_field($p['planned_shipping_date']) : miad_dhl_get_next_shipping_date();
    $time = date('Y-m-d\TH:i:s');
    $message_ref = md5(uniqid() . time());

    // Récupération des infos de l'admin connecté (Expéditeur réel pour le test)
    $current_user = wp_get_current_user();
    $admin_email = $current_user->user_email;
    $admin_phone = get_user_meta($current_user->ID, 'billing_phone', true);
    if (empty($admin_phone)) {
        $admin_phone = '1234567890'; // Fallback
    }
    $admin_phone = preg_replace('/\s+/', '', $admin_phone); // Suppression des espaces

    // Données Expédition
    $shipper_name = !empty($p['shipper_name']) ? sanitize_text_field($p['shipper_name']) : 'MIAD MARKET REPRESENTENT MASM';
    $shipper_country = sanitize_text_field($p['shipper_country']);
    $shipper_zip = sanitize_text_field($p['shipper_zip']);
    $shipper_city = sanitize_text_field($p['shipper_city']);
    $shipper_address = !empty($p['shipper_address']) ? sanitize_text_field($p['shipper_address']) : '123 Shipper St';
    
    $receiver_name = !empty($p['receiver_name']) ? sanitize_text_field($p['receiver_name']) : 'Test Receiver';
    $receiver_email = !empty($p['receiver_email']) ? sanitize_email($p['receiver_email']) : 'test@test.com';
    $receiver_phone = !empty($p['receiver_phone']) ? sanitize_text_field($p['receiver_phone']) : '0987654321';
    $receiver_phone = preg_replace('/\s+/', '', $receiver_phone); // Suppression des espaces
    $receiver_country = sanitize_text_field($p['receiver_country']);
    $receiver_zip = sanitize_text_field($p['receiver_zip']);
    $receiver_city = sanitize_text_field($p['receiver_city']);
    $receiver_address = !empty($p['receiver_address']) ? sanitize_text_field($p['receiver_address']) : '123 Receiver St';
    $receiver_province = !empty($p['receiver_province']) ? sanitize_text_field($p['receiver_province']) : '';
    
    $product_code = sanitize_text_field($p['product_code']);
    $is_dutiable = (isset($p['is_declarable']) && $p['is_declarable'] == 1);
    $is_plt = (isset($p['is_plt']) && $p['is_plt'] == 1);
    if ($product_code === 'D') $is_dutiable = false; // Force non-dutiable for documents

    $declared_value = round(floatval($p['declared_value']), 2);
    $currency = sanitize_text_field($p['currency']);
    $content_desc = !empty($p['content_desc']) ? sanitize_text_field($p['content_desc']) : 'Test Shipment Content';
    $manufacturer_country = !empty($p['manufacturer_country']) ? sanitize_text_field($p['manufacturer_country']) : $shipper_country;
    $incoterm = !empty($p['incoterm']) ? sanitize_text_field($p['incoterm']) : 'DAP';
    $export_reason_type = !empty($p['export_reason_type']) ? sanitize_text_field($p['export_reason_type']) : 'permanent';
    $customer_reference = !empty($p['customer_reference']) ? sanitize_text_field($p['customer_reference']) : '';
    $line_item_quantity = !empty($p['line_item_quantity']) ? intval($p['line_item_quantity']) : 1;
    $line_item_uom = !empty($p['line_item_uom']) ? sanitize_text_field(strtoupper($p['line_item_uom'])) : 'PCS';
    $hs_code = !empty($p['hs_code']) ? sanitize_text_field($p['hs_code']) : '85444290';
    $invoice_number = !empty($p['invoice_number']) ? sanitize_text_field($p['invoice_number']) : 'INV-' . time();
    $invoice_date = !empty($p['invoice_date']) ? sanitize_text_field($p['invoice_date']) : date('Y-m-d');

    // Units
    $unit_sys = isset($p['unit']) ? $p['unit'] : 'metric';
    // For ShipmentRequest (C/I, K/L)
    $weight_unit = ($unit_sys === 'imperial') ? 'L' : 'K'; 
    $dim_unit = ($unit_sys === 'imperial') ? 'I' : 'C';
    // For DCTRequest (GetQuote) (CM/IN, KG/LB)
    // JSON API uses 'metric' or 'imperial' string
    $measurement_unit = ($unit_sys === 'imperial') ? 'imperial' : 'metric';
    
    // Services Spéciaux
    $req_waybill_doc = isset($p['request_waybill_doc']) && $p['request_waybill_doc'] == 1;
    $special_services = [];
    $insurance_value = !empty($p['insurance_value']) ? floatval($p['insurance_value']) : 0;
    
    if ($is_plt) {
        $special_services[] = ["serviceCode" => "WY"];
    }

    if (!empty($p['special_service_1'])) {
        $code = sanitize_text_field($p['special_service_1']);
        $service = ["serviceCode" => $code];
        if ($code === 'II' && $insurance_value > 0) { $service['value'] = $insurance_value; $service['currency'] = $currency; }
        $special_services[] = $service;
    }
    if (!empty($p['special_service_2'])) {
        $code = sanitize_text_field($p['special_service_2']);
        $service = ["serviceCode" => $code];
        if ($code === 'II' && $insurance_value > 0) { $service['value'] = $insurance_value; $service['currency'] = $currency; }
        $special_services[] = $service;
    }

    $total_weight_for_customs = 0;
    // Packages (Multiple)
    $packages = [];
    if (isset($p['packages']) && is_array($p['packages'])) {
        foreach ($p['packages'] as $pkg_data) {
            $pkg_weight = !empty($pkg_data['weight']) ? floatval($pkg_data['weight']) : 0.5;
            $total_weight_for_customs += $pkg_weight;
            $packages[] = [
                "weight" => $pkg_weight,
                "dimensions" => [
                    "length" => !empty($pkg_data['length']) ? intval($pkg_data['length']) : 10,
                    "width" => !empty($pkg_data['width']) ? intval($pkg_data['width']) : 10,
                    "height" => !empty($pkg_data['height']) ? intval($pkg_data['height']) : 10
                ]
            ];
        }
    }

    // Accounts (Override)
    $accounts = [];
    if (isset($p['accounts']) && is_array($p['accounts'])) {
        $accounts = $p['accounts'];
    } else {
        $accounts = [
            ["typeCode" => "shipper", "number" => $account],
            ["typeCode" => "payer", "number" => $account]
        ];
        
        // NOUVEAU : Gestion du compte pour les taxes en fonction de l'incoterm
        if ($incoterm === 'DDP') {
            $accounts[] = [
                "typeCode" => "duties-taxes",
                "number" => $account
            ];
        }
        // Si DAP, on ne spécifie pas de compte pour les taxes, le destinataire paiera.
    }

    // Receiver Address Object
    $receiver_addr = ["postalCode" => $receiver_zip, "cityName" => $receiver_city, "countryCode" => $receiver_country, "addressLine1" => $receiver_address];
    if($receiver_province) $receiver_addr['provinceCode'] = $receiver_province;

    // --- CONSTRUCTION DE LA REQUÊTE JSON (REST API) ---
    
    // URL de l'API REST (MyDHL API)
    $url = ($env === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/shipments' : 'https://express.api.dhl.com/mydhlapi/shipments';

    $json_payload = [
        "plannedShippingDateAndTime" => (new DateTime($date . " 10:00:00"))->format('Y-m-d\TH:i:s \G\M\T+00:00'),

        "pickup" => [
            "isRequested" => false
        ],
        "productCode" => $product_code,
        "accounts" => $accounts,
        "customerDetails" => [
            "shipperDetails" => [
                "postalAddress" => [
                    "postalCode" => $shipper_zip,
                    "cityName" => $shipper_city,
                    "countryCode" => $shipper_country,
                    "addressLine1" => $shipper_address
                ],
                "contactInformation" => [
                    "companyName" => $shipper_name,
                    "fullName" => $shipper_name,
                    "phone" => $admin_phone,
                    "email" => $admin_email
                ]
            ],
            "receiverDetails" => [
                "postalAddress" => $receiver_addr,
                "contactInformation" => [
                    "companyName" => $receiver_name,
                    "fullName" => $receiver_name,
                    "phone" => $receiver_phone,
                    "email" => $receiver_email
                ]
            ]
        ],
        "content" => [
            "packages" => $packages,
            "isCustomsDeclarable" => $is_dutiable,
            "description" => $content_desc,
            "incoterm" => $incoterm,
            "unitOfMeasurement" => $measurement_unit
        ],
        "outputImageProperties" => [
            "imageOptions" => [
                [
                    "typeCode" => "label",
                    "templateName" => "ECOM26_84_001"
                ]
            ]
        ]
    ];

    if ($is_plt) {
        $json_payload['valueAddedServices'] = [
            ['serviceCode' => 'WY']
        ];
    }

    if (!empty($customer_reference)) {
        $json_payload['customerReferences'] = [
            [
                "value" => $customer_reference,
                "typeCode" => "CU" // CU = Customer Reference
            ]
        ];
    }

    if ($req_waybill_doc) {
        $json_payload['outputImageProperties']['imageOptions'][] = [
            "typeCode" => "waybillDoc",
            "isRequested" => true
        ];
    }

    if (!empty($special_services)) {
        $json_payload['valueAddedServices'] = $special_services;
    }

    if ($is_dutiable) {
        $json_payload['content']['declaredValue'] = $declared_value;
        $json_payload['content']['declaredValueCurrency'] = $currency;
        
        // Ajout de la déclaration d'export pour générer la facture (Invoice)
        $json_payload['content']['exportDeclaration'] = [
            'invoice' => [
                'number' => $invoice_number,
                'date' => $invoice_date
            ],
            'lineItems' => [
                [
                    'number' => 1,
                    'description' => $content_desc,
                    'price' => $declared_value,
                    'quantity' => [
                        'value' => $line_item_quantity,
                        'unitOfMeasurement' => $line_item_uom
                    ],
                    'commodityCodes' => [
                        [
                            'typeCode' => 'outbound',
                            'value' => $hs_code
                        ]
                    ],
                    'exportReasonType' => $export_reason_type,
                    'manufacturerCountry' => $manufacturer_country,
                    'weight' => [
                        'netValue' => $total_weight_for_customs,
                        'grossValue' => $total_weight_for_customs
                    ]
                ]
            ]
        ];
        
        // Demande explicite de l'image de la facture
        $json_payload['outputImageProperties']['imageOptions'][] = [
            'typeCode' => 'invoice',
            'invoiceType' => 'commercial',
            'isRequested' => true
        ];
    }

    // --- 0. RATE REQUEST (POST - Plus complet et précis) ---
    // Nous utilisons le payload JSON construit ci-dessus pour faire une demande de tarif précise
    $rate_url = ($env === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/rates' : 'https://express.api.dhl.com/mydhlapi/rates';
    
    // Transformation de customerDetails pour Rate Request (Structure différente de Shipment : adresses à plat)
    $rate_customerDetails = [
        "shipperDetails" => [
            "postalCode" => $json_payload['customerDetails']['shipperDetails']['postalAddress']['postalCode'],
            "cityName" => $json_payload['customerDetails']['shipperDetails']['postalAddress']['cityName'],
            "countryCode" => $json_payload['customerDetails']['shipperDetails']['postalAddress']['countryCode']
        ],
        "receiverDetails" => [
            "postalCode" => $json_payload['customerDetails']['receiverDetails']['postalAddress']['postalCode'],
            "cityName" => $json_payload['customerDetails']['receiverDetails']['postalAddress']['cityName'],
            "countryCode" => $json_payload['customerDetails']['receiverDetails']['postalAddress']['countryCode']
        ]
    ];

    $rate_payload = [
        "customerDetails" => $rate_customerDetails,
        "accounts" => $json_payload['accounts'],
        "productCode" => $json_payload['productCode'],
        "plannedShippingDateAndTime" => $json_payload['plannedShippingDateAndTime'],
        "unitOfMeasurement" => $json_payload['content']['unitOfMeasurement'],
        "isCustomsDeclarable" => $json_payload['content']['isCustomsDeclarable'],
        "packages" => $json_payload['content']['packages'],
        "returnStandardProductsOnly" => false,
        "nextBusinessDay" => true
    ];

    // Ajout de monetaryAmount pour les envois avec douane (Rate Request)
    if ($json_payload['content']['isCustomsDeclarable']) {
        $rate_payload['monetaryAmount'] = [
            [
                'typeCode' => 'declaredValue',
                'value' => $json_payload['content']['declaredValue'],
                'currency' => $json_payload['content']['declaredValueCurrency']
            ]
        ];
    }
    
    $rate_req_json = json_encode($rate_payload, JSON_PRETTY_PRINT);
    
    $rate_response = wp_remote_post($rate_url, [
        'body' => $rate_req_json,
        'timeout' => 90, 
        'sslverify' => false,
        'headers' => miad_dhl_get_headers($site_id, $password)
    ]);
    $rate_res_body = is_wp_error($rate_response) ? 'Error: ' . $rate_response->get_error_message() : wp_remote_retrieve_body($rate_response);

    // --- 1. SHIPMENT REQUEST (POST) ---
    $body_json = json_encode($json_payload);
    
    // Envoi de la requête JSON
    $response = wp_remote_post($url, array(
        'body'        => $body_json,
        'timeout'     => 90,
        'httpversion' => '1.1',
        'sslverify'   => false,
        'headers'     => miad_dhl_get_headers($site_id, $password)
    ));

    $body = '';
    $error_message = '';
    if (is_wp_error($response)) {
        $error_message = 'Erreur HTTP : ' . $response->get_error_message();
        $body = 'WP_Error: ' . $error_message;
    } else {
        $body = wp_remote_retrieve_body($response);
    }
    
    // Analyse de la réponse
    $result_data = [
        'Test Case' => isset($p['test_case_id']) ? $p['test_case_id'] : 'N/A',
        'Environment' => $env,
        'API Endpoint' => $url,
        'Shipment Request (JSON)' => $body_json,
        'Shipment Response' => $body,
        'Rating Request (JSON)' => $rate_req_json,
        'Rating Response' => $rate_res_body
    ];

    if (!empty($error_message)) {
        $result_data['Status'] = 'ERROR';
        $result_data['Error Message'] = $error_message;
        return $result_data;
    }

    // Analyse de la réponse JSON
    $json_response = json_decode($body, true);

    if (isset($json_response['shipmentTrackingNumber'])) {
        $result_data['Status'] = 'SUCCESS';
        $result_data['Waybill Number'] = $json_response['shipmentTrackingNumber'];
        
        // Récupération de l'étiquette (Label)
        if (isset($json_response['documents'])) {
            foreach ($json_response['documents'] as $doc) {
                if ($doc['typeCode'] === 'label') {
                    $result_data['Label_Base64'] = $doc['content'];
                    // Création d'une URL temporaire pour le téléchargement (Data URI)
                    $result_data['Label_URL'] = 'data:application/pdf;base64,' . $doc['content'];
                } elseif ($doc['typeCode'] === 'invoice') {
                    $result_data['Invoice_Base64'] = $doc['content'];
                    $result_data['Invoice_URL'] = 'data:application/pdf;base64,' . $doc['content'];
                } elseif ($doc['typeCode'] === 'waybillDoc') {
                    $result_data['WaybillDoc_Base64'] = $doc['content'];
                    $result_data['WaybillDoc_URL'] = 'data:application/pdf;base64,' . $doc['content'];
                }
            }
        }
    } else {
        $result_data['Status'] = 'ERROR';
        // Capture des erreurs JSON
        if (isset($json_response['detail'])) {
            $result_data['Error Message'] = $json_response['detail'];
        } elseif (isset($json_response['title'])) {
            $result_data['Error Message'] = $json_response['title'];
        } else {
            $result_data['Error Message'] = 'Erreur inconnue (Réponse JSON invalide)';
        }
    }

    // ENREGISTREMENT DANS L'HISTORIQUE (DB)
    global $wpdb;
    $table_name = $wpdb->prefix . 'miad_dhl_tests';
    // On vérifie si la table existe avant d'insérer (au cas où)
    if($wpdb->get_var("SHOW TABLES LIKE '$table_name'") == $table_name) {
        $wpdb->insert($table_name, [
            'time' => current_time('mysql'),
            'test_type' => 'Shipment',
            'reference' => $result_data['Waybill Number'] ?? 'N/A',
            'status' => $result_data['Status'],
            'environment' => $env,
            'result_summary' => isset($result_data['Error Message']) ? $result_data['Error Message'] : 'Succès'
        ]);
    }

    // CACHE: Save result for 24 hours
    set_transient($cache_key, $result_data, 24 * HOUR_IN_SECONDS);

    return $result_data;
}

add_action('wp_ajax_miad_dhl_run_test_shipment', 'miad_ajax_run_test_shipment');
function miad_ajax_run_test_shipment() {
    check_ajax_referer('miad_test_nonce');
    $result_data = miad_dhl_execute_test_shipment($_POST);
    
    // --- ENVOI EMAIL AVEC PIÈCES JOINTES (TEST) ---
    if (isset($result_data['Status']) && $result_data['Status'] === 'SUCCESS') {
        $current_user = wp_get_current_user();
        $to = $current_user->user_email;
        $waybill = isset($result_data['Waybill Number']) ? $result_data['Waybill Number'] : 'N/A';
        
        $subject = "[TEST DHL] Expédition créée : $waybill";
        $message = "Bonjour " . $current_user->display_name . ",\n\n";
        $message .= "Votre test d'expédition DHL a réussi.\n";
        $message .= "------------------------------------------------\n";
        $message .= "Waybill : $waybill\n";
        $message .= "Environnement : " . (isset($result_data['Environment']) ? $result_data['Environment'] : 'N/A') . "\n";
        $message .= "------------------------------------------------\n\n";
        $message .= "Vous trouverez l'étiquette (Label) et la facture (Invoice) en pièces jointes.\n";
        
        $attachments = [];
        $upload_dir = wp_upload_dir();
        $temp_dir = $upload_dir['basedir'] . '/dhl-temp';
        if (!file_exists($temp_dir)) wp_mkdir_p($temp_dir);
        
        // Sauvegarde Label
        if (!empty($result_data['Label_Base64'])) {
            $label_file = $temp_dir . "/Label_$waybill.pdf";
            file_put_contents($label_file, base64_decode($result_data['Label_Base64']));
            $attachments[] = $label_file;
        }
        
        // Sauvegarde Invoice
        if (!empty($result_data['Invoice_Base64'])) {
            $invoice_file = $temp_dir . "/Invoice_$waybill.pdf";
            file_put_contents($invoice_file, base64_decode($result_data['Invoice_Base64']));
            $attachments[] = $invoice_file;
        }
        
        // Sauvegarde Waybill Doc
        if (!empty($result_data['WaybillDoc_Base64'])) {
            $waybilldoc_file = $temp_dir . "/WaybillDoc_$waybill.pdf";
            file_put_contents($waybilldoc_file, base64_decode($result_data['WaybillDoc_Base64']));
            $attachments[] = $waybilldoc_file;
        }
        
        $sent = wp_mail($to, $subject, $message, '', $attachments);
        $result_data['Email_Info'] = $sent ? "✅ Email envoyé à $to avec les documents." : "❌ Échec de l'envoi de l'email.";
    }

    wp_send_json_success($result_data);
}

add_action('wp_ajax_miad_dhl_run_test_tracking_scenario', 'miad_ajax_run_test_tracking_scenario');
function miad_ajax_run_test_tracking_scenario() {
    check_ajax_referer('miad_test_nonce');
    $result = miad_dhl_execute_test_tracking_scenario($_POST);
    wp_send_json_success($result);
}

function miad_dhl_execute_test_tracking_scenario($p) {
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    
    if (!$site_id || !$password) {
        return ['Status' => 'ERROR', 'Error Message' => 'Credentials API manquants.'];
    }

    $nums = sanitize_text_field($p['nums']);
    $view = sanitize_text_field($p['view']);
    $detail = sanitize_text_field($p['detail']);
    
    $nums_array = array_map('trim', explode(',', $nums));
    $nums_clean = implode(',', $nums_array);

    $base_url = 'https://express.api.dhl.com/mydhlapi/test';

    $params = [
        'trackingView' => $view,
        'levelOfDetail' => $detail
    ];

    if (count($nums_array) > 1) {
        $endpoint = '/tracking';
        $params['shipmentTrackingNumber'] = $nums_clean;
    } else {
        $endpoint = '/shipments/' . $nums_clean . '/tracking';
    }

    $url = $base_url . $endpoint;
    $query_url = add_query_arg($params, $url);

    $response = wp_remote_get($query_url, [
        'timeout' => 90,
        'sslverify' => false,
        'headers' => miad_dhl_get_headers($site_id, $password)
    ]);

    $req_json = json_encode(['url' => $query_url, 'params' => $params], JSON_PRETTY_PRINT);
    $body = is_wp_error($response) ? 'Error: ' . $response->get_error_message() : wp_remote_retrieve_body($response);
    $data = json_decode($body, true);

    $status = 'SUCCESS';
    $summary = 'Tracking OK';
    if (isset($data['detail']) || isset($data['title'])) {
        $status = 'ERROR';
        $summary = $data['detail'] ?? $data['title'];
    }

    // ENREGISTREMENT DB
    global $wpdb;
    $table_name = $wpdb->prefix . 'miad_dhl_tests';
    if($wpdb->get_var("SHOW TABLES LIKE '$table_name'") == $table_name) {
        $wpdb->insert($table_name, [
            'time' => current_time('mysql'),
            'test_type' => 'Tracking',
            'reference' => substr($nums_clean, 0, 99),
            'status' => $status,
            'environment' => 'test',
            'result_summary' => $summary
        ]);
    }

    return [
        'Status' => $status,
        'Tracking Request (JSON)' => $req_json,
        'Tracking Response' => $body,
        'Parsed' => $data
    ];
}

add_action('wp_ajax_miad_dhl_run_bulk_test_shipment', 'miad_ajax_run_bulk_test_shipment');
function miad_ajax_run_bulk_test_shipment() {
    check_ajax_referer('miad_test_nonce');

    if (!isset($_FILES['csv_file']) || empty($_FILES['csv_file']['tmp_name'])) {
        wp_send_json_error(['message' => 'Aucun fichier CSV reçu.']);
    }

    $file = $_FILES['csv_file']['tmp_name'];
    $handle = fopen($file, "r");
    if ($handle === FALSE) {
        wp_send_json_error(['message' => 'Impossible de lire le fichier.']);
    }

    $results = [];
    $header = fgetcsv($handle, 1000, ","); // Skip header
    // Expected header: test_case_id, shipper_country, shipper_zip, shipper_city, receiver_country, receiver_zip, receiver_city, product_code, is_declarable, declared_value, currency, weight

    $row_count = 0;
    while (($data = fgetcsv($handle, 1000, ",")) !== FALSE) {
        $row_count++;
        // Map CSV columns to function parameters
        // Assuming order matches the template
        $params = [
            'test_case_id' => $data[0] ?? 'Row ' . $row_count,
            'shipper_country' => $data[1] ?? '',
            'shipper_zip' => $data[2] ?? '',
            'shipper_city' => $data[3] ?? '',
            'receiver_country' => $data[4] ?? '',
            'receiver_zip' => $data[5] ?? '',
            'receiver_city' => $data[6] ?? '',
            'product_code' => $data[7] ?? 'P',
            'is_declarable' => $data[8] ?? 1,
            'declared_value' => $data[9] ?? 50,
            'currency' => $data[10] ?? 'USD',
            'weight' => $data[11] ?? 0.5,
            'env' => isset($_POST['env']) ? $_POST['env'] : 'test' // Environment from form
        ];

        $res = miad_dhl_execute_test_shipment($params);
        
        // Simplify result for bulk view
        $simple_res = [
            'ID' => $params['test_case_id'],
            'Status' => $res['Status'] ?? 'UNKNOWN',
            'Waybill' => $res['Waybill Number'] ?? '-',
            'Error' => $res['Error Message'] ?? '',
            'Files' => [
                'Rating_Req' => $res['Rating Request'] ?? '',
                'Rating_Res' => $res['Rating Response'] ?? '',
                'Shipment_Req' => $res['Shipment Request'] ?? '',
                'Shipment_Res' => $res['Shipment Response'] ?? '',
                'Label' => $res['Label_Base64'] ?? '',
                'Invoice' => $res['Invoice_Base64'] ?? ''
            ]
        ];
        $results[] = $simple_res;

        // Optional: Sleep to avoid rate limiting if many rows
        if ($row_count % 5 == 0) sleep(1);
    }
    fclose($handle);

    wp_send_json_success($results);
}

// --- NOUVEAU : AJAX GET PRODUCT INFO ---
add_action('wp_ajax_miad_dhl_get_product_info', 'miad_ajax_get_product_info');
function miad_ajax_get_product_info() {
    if (!current_user_can('manage_options')) wp_send_json_error();
    $pid = intval($_POST['product_id']);
    $product = wc_get_product($pid);
    if ($product) {
        wp_send_json_success([
            'weight' => $product->get_weight(),
            'length' => $product->get_length(),
            'width' => $product->get_width(),
            'height' => $product->get_height(),
            'price' => $product->get_price(),
            'name' => $product->get_name()
        ]);
    }
    wp_send_json_error(['message' => 'Produit introuvable']);
}

// --- NOUVEAU : AJAX RUN TEST RATING (SIMPLE) ---
add_action('wp_ajax_miad_dhl_run_test_rating', 'miad_ajax_run_test_rating');
function miad_ajax_run_test_rating() {
    check_ajax_referer('miad_test_nonce');
    $weight = floatval($_POST['weight']);
    $length = floatval($_POST['length']);
    $width = floatval($_POST['width']);
    $height = floatval($_POST['height']);
    $to_country = sanitize_text_field($_POST['to_country']);
    $to_city = sanitize_text_field($_POST['to_city']);
    $to_zip = sanitize_text_field($_POST['to_zip']);
    $env = !empty($_POST['env']) ? sanitize_text_field($_POST['env']) : 'test';
    
    // Appel API Rate (GET)
    $result = miad_dhl_get_rate_api($weight, $length, $width, $height, 100, '', $to_country, $to_city, $to_zip, null, null, null, true, $env);
    
    if ($result) {
        wp_send_json_success(['Status' => 'SUCCESS', 'Result' => $result]);
    } else {
        wp_send_json_success(['Status' => 'ERROR', 'Error Message' => 'Aucun tarif trouvé ou erreur API. Vérifiez les logs.']);
    }
}
// --- NOUVEAU : GESTIONNAIRE DE TÉLÉCHARGEMENT ZIP ---
add_action('wp_ajax_miad_dhl_download_zip', 'miad_dhl_download_zip_handler');
function miad_dhl_download_zip_handler() {
    if (!current_user_can('manage_options')) wp_die('Non autorisé');
    if (!class_exists('ZipArchive')) wp_die('Extension PHP ZipArchive manquante.');

    $waybill = isset($_POST['waybill']) ? sanitize_file_name($_POST['waybill']) : 'Test';
    $zip_filename = 'DHL_Test_' . $waybill . '_' . date('Ymd_His') . '.zip';
    
    $zip_path = tempnam(sys_get_temp_dir(), 'dhl_zip');
    $zip = new ZipArchive();
    
    if ($zip->open($zip_path, ZipArchive::CREATE) !== TRUE) {
        wp_die('Impossible de créer le fichier ZIP.');
    }

    // Ajout des fichiers JSON (stripslashes car WP ajoute des slashes aux $_POST)
    if (!empty($_POST['rating_req'])) $zip->addFromString('1_Rating_Request.json', stripslashes($_POST['rating_req']));
    if (!empty($_POST['rating_res'])) $zip->addFromString('1_Rating_Response.json', stripslashes($_POST['rating_res']));
    if (!empty($_POST['shipment_req'])) $zip->addFromString('2_Shipment_Request.json', stripslashes($_POST['shipment_req']));
    if (!empty($_POST['shipment_res'])) $zip->addFromString('2_Shipment_Response.json', stripslashes($_POST['shipment_res']));
    if (!empty($_POST['tracking_req'])) $zip->addFromString('3_Tracking_Request.json', stripslashes($_POST['tracking_req']));
    if (!empty($_POST['tracking_res'])) $zip->addFromString('3_Tracking_Response.json', stripslashes($_POST['tracking_res']));
    
    // Pour les tests Pickup et autres
    if (!empty($_POST['generic_req'])) $zip->addFromString('Request.json', stripslashes($_POST['generic_req']));
    if (!empty($_POST['generic_res'])) $zip->addFromString('Response.json', stripslashes($_POST['generic_res']));
    
    // Ajout des PDF (Base64)
    if (!empty($_POST['label_b64'])) $zip->addFromString('Label.pdf', base64_decode($_POST['label_b64']));
    if (!empty($_POST['invoice_b64'])) $zip->addFromString('Commercial_Invoice.pdf', base64_decode($_POST['invoice_b64']));
    if (!empty($_POST['waybilldoc_b64'])) $zip->addFromString('Waybill_Doc.pdf', base64_decode($_POST['waybilldoc_b64']));

    $zip->close();

    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . $zip_filename . '"');
    header('Content-Length: ' . filesize($zip_path));
    readfile($zip_path);
    unlink($zip_path);
    exit;
}

// --- AJAX : RÉCUPÉRATION STATUT DASHBOARD ---
add_action('wp_ajax_miad_dhl_get_dashboard_status', 'miad_ajax_get_dashboard_status');
function miad_ajax_get_dashboard_status() {
    if (!current_user_can('manage_options')) wp_die();

    $tn = isset($_POST['tracking_number']) ? sanitize_text_field($_POST['tracking_number']) : '';
    if (!$tn) wp_send_json_error();

    // Utilisation du cache existant ou appel API
    $transient_key = 'dhl_track_' . md5($tn);
    $result = get_transient($transient_key);

    if (false === $result) {
        $result = miad_dhl_get_tracking_info($tn);
        // Cache court en cas d'erreur, long si succès
        $cache_duration = isset($result['error']) ? 5 * MINUTE_IN_SECONDS : 1 * HOUR_IN_SECONDS;
        set_transient($transient_key, $result, $cache_duration);
    }

    if (isset($result['status'])) {
        $status_code = $result['status']['statusCode'];
        $desc = $result['status']['description']; // ex: Delivered, Shipment picked up
        $color = ($status_code === 'delivered' || stripos($desc, 'delivered') !== false) ? '#008a00' : '#d40511';
        
        $html = '<strong style="color:' . $color . ';">' . esc_html($desc) . '</strong>';
        wp_send_json_success(['html' => $html]);
    }
    
    wp_send_json_error();
}

add_action('wp_ajax_miad_dhl_get_logs', 'miad_dhl_get_logs_ajax');
function miad_dhl_get_logs_ajax() {
    if (!current_user_can('manage_options')) {
        wp_send_json_error('Unauthorized.');
    }
    check_ajax_referer('miad_dhl_log_nonce');

    $log_file = MIAD_DHL_LOG_FILE;
    $logs = miad_dhl_read_log_tail($log_file);

    wp_send_json_success($logs);
}

add_action('wp_ajax_miad_dhl_run_test_tracking', 'miad_ajax_run_test_tracking');
function miad_ajax_run_test_tracking() {
    check_ajax_referer('miad_test_nonce');
    $tn = sanitize_text_field($_POST['tracking_number']);
    $view = !empty($_POST['tracking_view']) ? sanitize_text_field($_POST['tracking_view']) : 'last-checkpoint';
    $detail = !empty($_POST['level_of_detail']) ? sanitize_text_field($_POST['level_of_detail']) : 'all';
    $env = !empty($_POST['env']) ? sanitize_text_field($_POST['env']) : 'test';

    if (empty($tn)) wp_send_json_error(['message' => 'Numéro de suivi manquant']);
    
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');

    if (!$site_id || !$password) {
        wp_send_json_error(['message' => 'Credentials manquants']);
    }

    $base_url = ($env === 'test') ? 'https://express.api.dhl.com/mydhlapi/test' : 'https://express.api.dhl.com/mydhlapi';
    $url = $base_url . '/shipments/' . urlencode($tn) . '/tracking';
    
    // Gestion Multi-Tracking
    $nums_array = array_map('trim', explode(',', $tn));
    
    $params = [
        'trackingView' => $view,
        'levelOfDetail' => $detail
    ];
    
    // Détection automatique : AWB (10-11 chars) vs Piece ID / LP (> 11 chars)
    $is_piece_id = false;
    foreach ($nums_array as $n) {
        if (strlen($n) > 11) { $is_piece_id = true; break; }
    }
    
    // Correction : trackingView 'shipment-details-only' incompatible avec pieceTrackingNumber
    if ($is_piece_id && $params['trackingView'] === 'shipment-details-only') {
        $params['trackingView'] = 'all-checkpoints';
    }
    
    if (count($nums_array) > 1 || $is_piece_id) {
        $url = $base_url . '/tracking';
        $param_name = $is_piece_id ? 'pieceTrackingNumber' : 'shipmentTrackingNumber';
        $params[$param_name] = implode(',', $nums_array);
    } else {
        $url = $base_url . '/shipments/' . urlencode($nums_array[0]) . '/tracking';
    }
    
    $url = add_query_arg($params, $url);

    $args = [
        'headers' => miad_dhl_get_headers($site_id, $password),
        'timeout' => 15
    ];

    $response = wp_remote_get($url, $args);
    $raw_body = is_wp_error($response) ? $response->get_error_message() : wp_remote_retrieve_body($response);
    $data = json_decode($raw_body, true);

    $status = 'UNKNOWN';
    $desc = '';
    
    if (isset($data['shipments'][0]['status']['statusCode'])) {
        $status = $data['shipments'][0]['status']['statusCode'];
        $desc = $data['shipments'][0]['status']['description'];
    } elseif (isset($data['detail'])) {
        $status = 'ERROR';
        $desc = $data['detail'];
    }

    wp_send_json_success([
        'Tracking Number' => $tn,
        'Status' => $status,
        'Description' => $desc,
        'Tracking Request (JSON)' => json_encode(['url' => $url], JSON_PRETTY_PRINT),
        'Tracking Request (JSON)' => json_encode(['url' => $url, 'params' => $params], JSON_PRETTY_PRINT),
        'Tracking Response' => $raw_body,
        'Full Response' => $data
    ]);
}

add_action('wp_ajax_miad_dhl_run_test_pickup', 'miad_ajax_run_test_pickup');
function miad_ajax_run_test_pickup() {
    check_ajax_referer('miad_test_nonce');
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $account = get_option('miad_dhl_account_number');
    $env = !empty($_POST['env']) ? sanitize_text_field($_POST['env']) : 'test';

    if (!$site_id || !$password || !$account) {
        wp_send_json_success(['Status' => 'ERROR', 'Error Message' => 'Credentials manquants.']);
        return;
    }

    $date = !empty($_POST['pickup_date']) ? sanitize_text_field($_POST['pickup_date']) : miad_dhl_get_next_shipping_date();
    $ready_time = !empty($_POST['ready_time']) ? sanitize_text_field($_POST['ready_time']) : '10:00';
    $close_time = !empty($_POST['close_time']) ? sanitize_text_field($_POST['close_time']) : '18:00';
    $location = !empty($_POST['location']) ? sanitize_text_field($_POST['location']) : 'Reception Test';
    $s_company = !empty($_POST['pickup_shipper_company']) ? sanitize_text_field($_POST['pickup_shipper_company']) : 'MIAD MARKET';
    $s_name = !empty($_POST['pickup_shipper_name']) ? sanitize_text_field($_POST['pickup_shipper_name']) : 'Brunel Atekossi';
    $s_email = !empty($_POST['pickup_shipper_email']) ? sanitize_email($_POST['pickup_shipper_email']) : 'abmcompanysn@gmail.com';
    $s_phone = !empty($_POST['pickup_shipper_phone']) ? sanitize_text_field($_POST['pickup_shipper_phone']) : '1234567890';
    $s_address = !empty($_POST['pickup_shipper_address']) ? sanitize_text_field($_POST['pickup_shipper_address']) : 'Test Address';
    $s_city = !empty($_POST['pickup_shipper_city']) ? sanitize_text_field($_POST['pickup_shipper_city']) : 'Dakar';
    $s_zip = !empty($_POST['pickup_shipper_zip']) ? sanitize_text_field($_POST['pickup_shipper_zip']) : '10000';
    $s_country = !empty($_POST['pickup_shipper_country']) ? sanitize_text_field($_POST['pickup_shipper_country']) : 'SN';
    
    $rc_company = !empty($_POST['pickup_receiver_company']) ? sanitize_text_field($_POST['pickup_receiver_company']) : 'Client Final';
    $rc_name = !empty($_POST['pickup_receiver_name']) ? sanitize_text_field($_POST['pickup_receiver_name']) : 'Jean Dupont';
    $rc_email = !empty($_POST['pickup_receiver_email']) ? sanitize_email($_POST['pickup_receiver_email']) : 'client@test.com';
    $rc_phone = !empty($_POST['pickup_receiver_phone']) ? sanitize_text_field($_POST['pickup_receiver_phone']) : '0987654321';
    $rc_address = !empty($_POST['pickup_receiver_address']) ? sanitize_text_field($_POST['pickup_receiver_address']) : '123 Receiver St';
    $rc_city = !empty($_POST['pickup_receiver_city']) ? sanitize_text_field($_POST['pickup_receiver_city']) : 'New York';
    $rc_zip = !empty($_POST['pickup_receiver_zip']) ? sanitize_text_field($_POST['pickup_receiver_zip']) : '10001';
    $rc_country = !empty($_POST['pickup_receiver_country']) ? sanitize_text_field($_POST['pickup_receiver_country']) : 'US';
    
    $r_company = !empty($_POST['pickup_requestor_company']) ? sanitize_text_field($_POST['pickup_requestor_company']) : get_bloginfo('name');
    $r_name = !empty($_POST['pickup_requestor_name']) ? sanitize_text_field($_POST['pickup_requestor_name']) : 'Responsable Logistique';
    $r_email = !empty($_POST['pickup_requestor_email']) ? sanitize_email($_POST['pickup_requestor_email']) : get_option('admin_email');
    $r_phone = !empty($_POST['pickup_requestor_phone']) ? sanitize_text_field($_POST['pickup_requestor_phone']) : '1234567890';
    $r_address = !empty($_POST['pickup_requestor_address']) ? sanitize_text_field($_POST['pickup_requestor_address']) : 'Siege Social';
    $r_city = !empty($_POST['pickup_requestor_city']) ? sanitize_text_field($_POST['pickup_requestor_city']) : get_option('miad_dhl_shipper_city', 'Dakar');
    $r_zip = !empty($_POST['pickup_requestor_zip']) ? sanitize_text_field($_POST['pickup_requestor_zip']) : get_option('miad_dhl_shipper_zip', '10001');
    $r_country = !empty($_POST['pickup_requestor_country']) ? sanitize_text_field($_POST['pickup_requestor_country']) : get_option('miad_dhl_shipper_country', 'SN');

    $instructions = !empty($_POST['pickup_instructions']) ? sanitize_text_field($_POST['pickup_instructions']) : '';
    $remark = !empty($_POST['pickup_remark']) ? sanitize_text_field($_POST['pickup_remark']) : '';
    
    $weight = !empty($_POST['weight']) ? floatval($_POST['weight']) : 1.0;
    $length = !empty($_POST['length']) ? intval($_POST['length']) : 20;
    $width = !empty($_POST['width']) ? intval($_POST['width']) : 20;
    $height = !empty($_POST['height']) ? intval($_POST['height']) : 20;

    $url = ($env === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/pickups' : 'https://express.api.dhl.com/mydhlapi/pickups';
    
  // Payload de test minimal
    $json_payload = [
        "plannedPickupDateAndTime" => $date . "T" . $ready_time . ":00",
        "closeTime" => $close_time,
        "location" => $location,
        "locationType" => "business",
        "accounts" => [ ["typeCode" => "shipper", "number" => $account] ],
        "shipmentDetails" => [
            [
                "productCode" => "P",
                "isCustomsDeclarable" => false,
                "unitOfMeasurement" => "metric",
                "packages" => [ ["weight" => $weight, "dimensions" => ["length" => $length, "width" => $width, "height" => $height]] ]
            ]
        ],
        "customerDetails" => [
            "shipperDetails" => [
                "postalAddress" => [
                    "postalCode" => $s_zip,
                    "cityName" => $s_city,
                    "countryCode" => $s_country,
                    "addressLine1" => $s_address
                ],
                "contactInformation" => [
                    "companyName" => $s_company,
                    "fullName" => $s_name,
                    "phone" => $s_phone,
                    "email" => $s_email
                ]
            ],
            "receiverDetails" => [
                "postalAddress" => [
                    "postalCode" => $rc_zip,
                    "cityName" => $rc_city,
                    "countryCode" => $rc_country,
                    "addressLine1" => $rc_address
                ],
                "contactInformation" => [
                    "companyName" => $rc_company,
                    "fullName" => $rc_name,
                    "phone" => $rc_phone,
                    "email" => $rc_email
                ]
            ],
            "bookingRequestorDetails" => [
                "postalAddress" => [
                    "postalCode" => $r_zip,
                    "cityName" => $r_city,
                    "countryCode" => $r_country,
                    "addressLine1" => $r_address
                ],
                "contactInformation" => [
                    "companyName" => $r_company,
                    "fullName" => $r_name,
                    "phone" => $r_phone,
                    "email" => $r_email
                ]
            ]
        ]
    ];

    if ($instructions) {
        $json_payload['specialInstructions'] = [
            ['value' => $instructions, 'typeCode' => 'INS']
        ];
    }
    if ($remark) {
        $json_payload['remark'] = $remark;
    }

    $response = wp_remote_post($url, [
        'body' => json_encode($json_payload),
        'timeout' => 90,
        'sslverify' => false,
        'headers' => miad_dhl_get_headers($site_id, $password)
    ]);

    $body = is_wp_error($response) ? $response->get_error_message() : wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    $status = isset($data['dispatchConfirmationNumbers']) ? 'SUCCESS' : 'ERROR';
    $msg = isset($data['dispatchConfirmationNumbers']) ? 'Pickup OK: ' . $data['dispatchConfirmationNumbers'][0] : ($data['detail'] ?? 'Erreur');
    
    wp_send_json_success([
        'Test Case' => 'Real Pickup Test',
        'Status' => $status,
        'Request' => json_encode($json_payload),
        'Response' => $body,
        'Result' => $msg
    ]);
}

// --- NOUVEAU : SAUVEGARDE SÉLECTION DHL (SESSION) ---
add_action('wp_ajax_miad_save_dhl_selection', 'miad_save_dhl_selection');
add_action('wp_ajax_nopriv_miad_save_dhl_selection', 'miad_save_dhl_selection');

function miad_save_dhl_selection() {
    $code = sanitize_text_field($_POST['product_code']);
    $price = floatval($_POST['price']);
    $name = sanitize_text_field($_POST['name']);
    
    if (WC()->session) {
        WC()->session->set('miad_dhl_selected_service', [
            'code' => $code,
            'price' => $price,
            'name' => $name
        ]);
    }
    wp_send_json_success();
}

// --- NOUVEAU : FORCER LA MÉTHODE CHOISIE DANS LE PANIER ---
add_filter('woocommerce_shipping_chosen_method', 'miad_dhl_force_chosen_method', 10, 2);
function miad_dhl_force_chosen_method($default, $rates) {
    if (WC()->session && WC()->session->get('miad_dhl_selected_service')) {
        $selected = WC()->session->get('miad_dhl_selected_service');
        $selected_name = sanitize_title($selected['name']);
        
        foreach ($rates as $rate_id => $rate) {
            // On cherche l'ID qui contient le nom du service sélectionné (ex: miad_dhl_shipping_express_worldwide)
            if (strpos($rate_id, 'miad_dhl_shipping_' . $selected_name) !== false) {
                return $rate_id;
            }
        }
    }
    return $default;
}

add_action('wp_ajax_miad_dhl_run_test_list_pickups', 'miad_ajax_run_test_list_pickups');
function miad_ajax_run_test_list_pickups() {
    check_ajax_referer('miad_test_nonce');
    $site_id = get_option('miad_dhl_site_id');
    $password = get_option('miad_dhl_password');
    $account = get_option('miad_dhl_account_number');
    $env = !empty($_POST['env']) ? sanitize_text_field($_POST['env']) : 'test';

    if (!$site_id || !$password || !$account) {
        wp_send_json_success(['Status' => 'ERROR', 'Error Message' => 'Credentials manquants.']);
        return;
    }

    $start_date = sanitize_text_field($_POST['start_date']);
    $end_date = sanitize_text_field($_POST['end_date']);

    $url = ($env === 'test') ? 'https://express.api.dhl.com/mydhlapi/test/pickups' : 'https://express.api.dhl.com/mydhlapi/pickups';
    
    $params = [
        'accountNumber' => $account,
        'plannedPickupDateFrom' => $start_date,
        'plannedPickupDateTo' => $end_date
    ];
    $query_url = add_query_arg($params, $url);

    $response = wp_remote_get($query_url, [
        'timeout' => 90,
        'headers' => miad_dhl_get_headers($site_id, $password)
    ]);

    $body = is_wp_error($response) ? $response->get_error_message() : wp_remote_retrieve_body($response);
    $data = json_decode($body, true);
    $status = isset($data['pickups']) ? 'SUCCESS' : 'ERROR';
    $msg = isset($data['pickups']) ? 'Liste des enlèvements récupérée.' : ($data['detail'] ?? 'Erreur inconnue');

    wp_send_json_success([
        'Test Case' => 'List Pickups',
        'Status' => $status,
        'Request' => $query_url,
        'Response' => $body,
        'Result' => $msg
    ]);
}

// --- NOUVEAU : SAUVEGARDE SÉLECTION DHL (SESSION) ---
add_action('wp_ajax_miad_save_dhl_selection', 'miad_save_dhl_selection');
add_action('wp_ajax_nopriv_miad_save_dhl_selection', 'miad_save_dhl_selection');

if (!function_exists('miad_save_dhl_selection')) {
    function miad_save_dhl_selection() {
        $code = sanitize_text_field($_POST['product_code']);
        $price = floatval($_POST['price']);
        $name = sanitize_text_field($_POST['name']);
        
        if (WC()->session) {
            WC()->session->set('miad_dhl_selected_service', [
                'code' => $code,
                'price' => $price,
                'name' => $name
            ]);
        }
        wp_send_json_success();
    }
}

// --- NOUVEAU : FORCER LA MÉTHODE CHOISIE DANS LE PANIER ---
add_filter('woocommerce_shipping_chosen_method', 'miad_dhl_force_chosen_method', 10, 2);
if (!function_exists('miad_dhl_force_chosen_method')) {
    function miad_dhl_force_chosen_method($default, $rates) {
        if (WC()->session && WC()->session->get('miad_dhl_selected_service')) {
            $selected = WC()->session->get('miad_dhl_selected_service');
            $selected_name = sanitize_title($selected['name']);
            
            foreach ($rates as $rate_id => $rate) {
                // On cherche l'ID qui contient le nom du service sélectionné (ex: miad_dhl_shipping_express_worldwide)
                if (strpos($rate_id, 'miad_dhl_shipping_' . $selected_name) !== false) {
                    return $rate_id;
                }
            }
        }
        return $default;
    }
}

/* ═══════════════════════════════════════════════════════════════════
   NOUVEAU (2026-07-20) : ENDPOINTS REST — LOGISTIQUE DHL DEPUIS LE
   DASHBOARD ADMIN HEADLESS
   ═══════════════════════════════════════════════════════════════════
   Jusqu'ici, gérer une expédition DHL (créer, vérifier le tracking,
   voir le prix estimé) demandait de passer par WP Admin → DHL →
   Tableau de Bord / la meta box "Actions DHL" sur la fiche commande —
   tout en admin-ajax, donc inaccessible depuis le site headless
   (Next.js sur miadmarket.com, domaine différent de api.miadmarket.com,
   sans session WP). Ces routes exposent en lecture/écriture le strict
   nécessaire pour reproduire ce flux depuis le dashboard admin du
   headless (voir components AdminBatekossiClient.tsx côté Next.js) :
   sélectionner une commande, voir ses infos + un prix estimé, créer
   l'expédition, suivre le colis — protégées par le même secret
   partagé que miad-products-api.php (header x-miad-products-secret).
═══════════════════════════════════════════════════════════════════ */
add_action('rest_api_init', function () {

    $dhl_permission = function (WP_REST_Request $request) {
        if (!function_exists('miad_products_api_secret')) return false;
        return hash_equals(miad_products_api_secret(), (string) $request->get_header('x-miad-products-secret'));
    };

    // --- Liste des commandes récentes (pour choisir laquelle expédier/suivre) ---
    register_rest_route('miad-products/v1', '/dhl/orders', [
        'methods'             => 'GET',
        'permission_callback' => $dhl_permission,
        'callback'            => function (WP_REST_Request $request) {
            $limit = min(100, max(1, (int) ($request->get_param('limit') ?: 40)));
            $statuses = $request->get_param('status');
            $statuses = $statuses ? array_map('sanitize_key', explode(',', (string) $statuses)) : ['processing', 'on-hold', 'completed', 'shipped'];

            $orders = wc_get_orders([
                'limit'   => $limit,
                'status'  => $statuses,
                'orderby' => 'date',
                'order'   => 'DESC',
                'type'    => 'shop_order',
            ]);

            $out = [];
            foreach ($orders as $order) {
                $order_id = $order->get_id();
                $stage    = function_exists('miad_get_delivery_stage') ? miad_get_delivery_stage($order_id) : null;
                $stages   = function_exists('miad_delivery_stages') ? miad_delivery_stages() : [];
                $tracking = $order->get_meta('_miad_dhl_tracking_number');

                $out[] = [
                    'id'              => $order_id,
                    'order_number'    => $order->get_order_number(),
                    'date'            => $order->get_date_created() ? $order->get_date_created()->date('Y-m-d H:i') : '',
                    'client_name'     => $order->get_formatted_billing_full_name(),
                    'country'         => $order->get_billing_country(),
                    'city'            => $order->get_billing_city(),
                    'total'           => function_exists('miad_order_total_plain') ? miad_order_total_plain($order) : $order->get_total(),
                    'status'          => $order->get_status(),
                    'shipping_method' => $order->get_shipping_method() ?: 'MIAD Standard',
                    'delivery_stage'  => $stage,
                    'stage_label'     => ($stage && isset($stages[$stage])) ? $stages[$stage]['label'] : null,
                    'tracking_number' => $tracking ?: '',
                    'has_shipment'    => !empty($tracking),
                ];
            }

            return new WP_REST_Response(['ok' => true, 'orders' => $out], 200);
        },
    ]);

    // --- Détail d'une commande : adresse, articles, expédition DHL existante, tracking live, prix estimé ---
    register_rest_route('miad-products/v1', '/dhl/order/(?P<id>\d+)', [
        'methods'             => 'GET',
        'permission_callback' => $dhl_permission,
        'callback'            => function (WP_REST_Request $request) {
            $order_id = (int) $request->get_param('id');
            $order    = wc_get_order($order_id);
            if (!$order) return new WP_REST_Response(['error' => 'Commande introuvable.'], 404);

            $items = [];
            $total_weight = 0;
            $total_value  = 0;
            $hs_code      = '';
            foreach ($order->get_items() as $item) {
                $product = $item->get_product();
                $qty     = $item->get_quantity();
                $weight  = $product ? (($product->get_weight() ?: 0.5) * $qty) : (0.5 * $qty);
                $price   = $product ? $product->get_price() : 0;
                $total_weight += $weight;
                $total_value  += $price * $qty;
                if (!$hs_code && $product) {
                    $hs_code = get_post_meta($product->get_id(), '_miad_hs_code', true);
                }
                $items[] = [
                    'name'     => $item->get_name(),
                    'quantity' => $qty,
                    'weight'   => $weight,
                    'price'    => $price,
                ];
            }
            if (!$hs_code) $hs_code = '85444290';
            if ($total_weight <= 0) $total_weight = 1;

            $stage  = function_exists('miad_get_delivery_stage') ? miad_get_delivery_stage($order_id) : null;
            $stages = function_exists('miad_delivery_stages') ? miad_delivery_stages() : [];

            $tracking_number = $order->get_meta('_miad_dhl_tracking_number');
            $dhl_status = '';
            $dhl_events = [];
            if ($tracking_number && function_exists('miad_dhl_get_tracking_info')) {
                $dhl_result = miad_dhl_get_tracking_info($tracking_number);
                if (is_array($dhl_result) && empty($dhl_result['error']) && !empty($dhl_result['events'])) {
                    $dhl_status = $dhl_result['status']['description'] ?? '';
                    foreach ($dhl_result['events'] as $event) {
                        $dhl_events[] = [
                            'timestamp'   => $event['timestamp'] ?? '',
                            'description' => $event['description'] ?? '',
                            'location'    => $event['location']['address']['addressLocality'] ?? '',
                        ];
                    }
                }
            }

            // Prix estimé (best-effort) : uniquement si pas encore expédié — sinon le
            // prix réel est déjà fixé lors de la création. Un échec ici (credentials
            // manquants, ville de destination absente, DHL indisponible) ne doit pas
            // faire échouer tout l'endpoint : on renvoie juste rate=null.
            $rate = null;
            if (!$tracking_number && function_exists('miad_dhl_get_rate_api')) {
                $rate_result = miad_dhl_get_rate_api(
                    $total_weight, 20, 20, 20, $total_value, $hs_code,
                    $order->get_billing_country(), $order->get_billing_city(), $order->get_billing_postcode()
                );
                if (is_array($rate_result) && isset($rate_result['cost'])) {
                    $rate = ['cost' => round((float) $rate_result['cost'], 2), 'date' => $rate_result['date'] ?? ''];
                }
            }

            return new WP_REST_Response([
                'ok'              => true,
                'id'              => $order_id,
                'order_number'    => $order->get_order_number(),
                'status'          => $order->get_status(),
                'date'            => $order->get_date_created() ? $order->get_date_created()->date('Y-m-d H:i') : '',
                'client_name'     => $order->get_formatted_billing_full_name(),
                'client_email'    => $order->get_billing_email(),
                'client_phone'    => $order->get_billing_phone(),
                'address'         => [
                    'address_1' => $order->get_billing_address_1(),
                    'city'      => $order->get_billing_city(),
                    'postcode'  => $order->get_billing_postcode(),
                    'country'   => $order->get_billing_country(),
                ],
                'total'           => function_exists('miad_order_total_plain') ? miad_order_total_plain($order) : $order->get_total(),
                'shipping_method' => $order->get_shipping_method() ?: 'MIAD Standard',
                'delivery_stage'  => $stage,
                'stage_label'     => ($stage && isset($stages[$stage])) ? $stages[$stage]['label'] : null,
                'items'           => $items,
                'total_weight'    => $total_weight,
                'hs_code'         => $hs_code,
                'tracking_number' => $tracking_number ?: '',
                'label_url'       => $order->get_meta('_miad_dhl_label_url') ?: '',
                'waybill_doc_url' => $order->get_meta('_miad_dhl_waybill_doc_url') ?: '',
                'invoice_url'     => $order->get_meta('_miad_dhl_invoice_url') ?: '',
                'dhl_status'      => $dhl_status,
                'dhl_events'      => $dhl_events,
                'estimated_rate'  => $rate,
            ], 200);
        },
    ]);

    // --- Créer l'expédition DHL pour une commande (réutilise la même logique que le bouton WP Admin) ---
    register_rest_route('miad-products/v1', '/dhl/create-shipment', [
        'methods'             => 'POST',
        'permission_callback' => $dhl_permission,
        'callback'            => function (WP_REST_Request $request) {
            if (!function_exists('miad_dhl_process_shipment_creation')) {
                return new WP_REST_Response(['error' => 'Fonction indisponible.'], 500);
            }
            $order_id = (int) $request->get_param('order_id');
            $plt      = $request->get_param('plt');
            $plt      = ($plt === null) ? true : (bool) $plt;

            // Correction manuelle du poids/dimensions/code HS depuis le panneau
            // admin (demandé le 2026-07-20) — absent = comportement automatique
            // inchangé (poids des fiches produit, colis 20x20x20, code HS produit).
            $override = [];
            $weight   = $request->get_param('weight');
            if ($weight !== null && (float) $weight > 0) {
                $override['weight'] = (float) $weight;
                $override['length'] = (float) ($request->get_param('length') ?: 20);
                $override['width']  = (float) ($request->get_param('width') ?: 20);
                $override['height'] = (float) ($request->get_param('height') ?: 20);
            }
            $hs_code = sanitize_text_field((string) $request->get_param('hsCode'));
            if ($hs_code) $override['hs_code'] = $hs_code;
            if (empty($override)) $override = null;

            $result = miad_dhl_process_shipment_creation($order_id, $plt, $override);
            return new WP_REST_Response($result, $result['success'] ? 200 : 400);
        },
    ]);

    // --- Recalculer le tarif DHL d'une commande avec un poids/dimensions corrigés
    //     à la main (demandé le 2026-07-20 : pouvoir changer les dimensions et
    //     revoir le tarif avant de confirmer l'expédition) ---
    register_rest_route('miad-products/v1', '/dhl/rate', [
        'methods'             => 'GET',
        'permission_callback' => $dhl_permission,
        'callback'            => function (WP_REST_Request $request) {
            if (!function_exists('miad_dhl_get_rate_api')) {
                return new WP_REST_Response(['error' => 'Fonction indisponible.'], 500);
            }
            $order_id = (int) $request->get_param('order_id');
            $order    = wc_get_order($order_id);
            if (!$order) return new WP_REST_Response(['error' => 'Commande introuvable.'], 404);

            $weight = (float) $request->get_param('weight');
            $length = (float) ($request->get_param('length') ?: 20);
            $width  = (float) ($request->get_param('width') ?: 20);
            $height = (float) ($request->get_param('height') ?: 20);
            if ($weight <= 0) {
                return new WP_REST_Response(['error' => 'weight requis et > 0.'], 400);
            }

            $total_value = 0;
            foreach ($order->get_items() as $item) {
                $product = $item->get_product();
                if ($product) $total_value += $product->get_price() * $item->get_quantity();
            }

            // Code HS : celui saisi par l'admin dans le panneau prime sur celui
            // de la fiche produit (n'affecte pas le tarif DHL lui-même — l'API
            // Rate ne le prend pas en compte — mais reste utile à corriger ici
            // avant la création réelle de l'expédition, qui l'utilise pour la
            // déclaration douanière).
            $hs_code = sanitize_text_field((string) $request->get_param('hsCode'));
            if (!$hs_code) {
                foreach ($order->get_items() as $item) {
                    $product = $item->get_product();
                    if ($product) {
                        $hs_code = get_post_meta($product->get_id(), '_miad_hs_code', true);
                        if ($hs_code) break;
                    }
                }
            }
            if (!$hs_code) $hs_code = '85444290';

            $rate_result = miad_dhl_get_rate_api(
                $weight, $length, $width, $height, $total_value, $hs_code,
                $order->get_billing_country(), $order->get_billing_city(), $order->get_billing_postcode()
            );

            if (!is_array($rate_result) || !isset($rate_result['cost'])) {
                return new WP_REST_Response(['error' => $rate_result['message'] ?? 'Tarif indisponible pour ces dimensions.'], 502);
            }

            return new WP_REST_Response([
                'ok'   => true,
                'rate' => ['cost' => round((float) $rate_result['cost'], 2), 'date' => $rate_result['date'] ?? ''],
            ], 200);
        },
    ]);

    // --- Statut de tracking en direct pour un numéro donné (ex: revérifier sans recharger toute la fiche commande) ---
    register_rest_route('miad-products/v1', '/dhl/tracking', [
        'methods'             => 'GET',
        'permission_callback' => $dhl_permission,
        'callback'            => function (WP_REST_Request $request) {
            $tracking_number = (string) $request->get_param('tracking_number');
            if (!$tracking_number || !function_exists('miad_dhl_get_tracking_info')) {
                return new WP_REST_Response(['error' => 'Numéro de suivi manquant.'], 400);
            }
            $dhl_result = miad_dhl_get_tracking_info($tracking_number);
            if (!is_array($dhl_result) || !empty($dhl_result['error'])) {
                return new WP_REST_Response(['error' => $dhl_result['error'] ?? 'Suivi indisponible.'], 502);
            }
            $status = $dhl_result['status']['description'] ?? '';
            $events = [];
            foreach (($dhl_result['events'] ?? []) as $event) {
                $events[] = [
                    'timestamp'   => $event['timestamp'] ?? '',
                    'description' => $event['description'] ?? '',
                    'location'    => $event['location']['address']['addressLocality'] ?? '',
                ];
            }
            return new WP_REST_Response(['ok' => true, 'status' => $status, 'events' => $events], 200);
        },
    ]);
});