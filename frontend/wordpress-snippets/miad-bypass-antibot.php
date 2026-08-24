<?php
/**
 * MIAD Headless - Bypass SG Security AI Anti-Bot pour les appels API internes
 *
 * A deposer dans wp-content/mu-plugins/ (creer le dossier mu-plugins s'il
 * n'existe pas). Prefixe "00-" pour charger le plus tot possible parmi les
 * mu-plugins (ordre alphabetique), avant SG Security si celui-ci est lui-meme
 * charge comme mu-plugin ou comme plugin normal.
 *
 * Principe : si la requete porte le header X-Headless-Secret avec la bonne
 * valeur, on retire dynamiquement tous les callbacks enregistres par le
 * plugin SG Security (sg-security / sg-cachepress) sur les hooks ou il
 * effectue generalement ses verifications (init, wp_loaded,
 * template_redirect, rest_api_init). On ne devine aucun nom de fonction :
 * on inspecte les callbacks deja enregistres et on retire ceux dont le
 * fichier source appartient au dossier du plugin.
 *
 * IMPORTANT : remplacer 'CHANGE_MOI' ci-dessous par la valeur reelle de
 * INTERNAL_API_SECRET (celle deja configuree comme secret sur le Worker
 * Cloudflare). Ne jamais committer ce fichier avec la vraie valeur dans un
 * depot public.
 */

define('MIAD_HEADLESS_SECRET', 'CHANGE_MOI');

add_action('muplugins_loaded', function () {
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $provided = $headers['X-Headless-Secret']
        ?? $headers['X-headless-secret']
        ?? ($_SERVER['HTTP_X_HEADLESS_SECRET'] ?? null);

    if (!$provided || !hash_equals(MIAD_HEADLESS_SECRET, $provided)) {
        return; // pas notre client headless, on ne touche a rien
    }

    // Ne s'applique qu'aux appels REST API (wp-json), jamais a wp-admin/wp-login
    $uri = $_SERVER['REQUEST_URI'] ?? '';
    if (strpos($uri, '/wp-json/') === false) {
        return;
    }

    foreach (['init', 'wp_loaded', 'template_redirect', 'rest_api_init'] as $hook) {
        miad_strip_plugin_callbacks($hook, ['sg-security', 'sg-cachepress', 'sgsecurity']);
    }
}, 0); // priorite 0 : avant la plupart des plugins qui s'enregistrent en priorite 10

function miad_strip_plugin_callbacks(string $hook, array $pluginFolderHints): void
{
    global $wp_filter;

    if (empty($wp_filter[$hook])) {
        return;
    }

    foreach ($wp_filter[$hook]->callbacks as $priority => $callbacks) {
        foreach ($callbacks as $id => $cb) {
            $callable = $cb['function'];
            $reflectionFile = miad_get_callable_file($callable);

            if (!$reflectionFile) {
                continue;
            }

            foreach ($pluginFolderHints as $hint) {
                if (stripos($reflectionFile, $hint) !== false) {
                    unset($wp_filter[$hook]->callbacks[$priority][$id]);
                }
            }
        }
    }
}

function miad_get_callable_file($callable): ?string
{
    try {
        if (is_array($callable)) {
            $reflection = is_object($callable[0])
                ? new ReflectionMethod($callable[0], $callable[1])
                : new ReflectionMethod($callable[0], $callable[1]);
        } elseif (is_string($callable) && strpos($callable, '::') !== false) {
            $reflection = new ReflectionMethod($callable);
        } elseif ($callable instanceof Closure || is_string($callable)) {
            $reflection = new ReflectionFunction($callable);
        } else {
            return null;
        }
        return $reflection->getFileName() ?: null;
    } catch (\Throwable $e) {
        return null;
    }
}
