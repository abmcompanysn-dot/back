/**
 * MIAD MARKET - Custom Service Worker
 * Author: Brunel A. Mahuzonsou
 * Purpose: style caching for African Artisans
 */
const CACHE_NAME = 'miad-market-v10';
const STATIC_ASSETS = ['/', '/offline.html', '/logo/logo.png', '/manifest.json'];

// IndexedDB constants
const DB_NAME = 'miad-cart-db';
const DB_VERSION = 1;
const STORE_NAME = 'pending-cart-actions';

// Helper function to open IndexedDB
function openCartDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      console.error('[SW] IndexedDB error:', event.target.error);
      reject(event.target.error);
    };
  });
}

// Helper function to add a cart action to IndexedDB
async function addPendingCartAction(action) {
  const db = await openCartDB();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const request = store.add(action);
    request.onsuccess = () => resolve();
    request.onerror = (event) => reject(event.target.error);
  });
}

// Helper function to get all pending cart actions from IndexedDB
async function getPendingCartActions() {
  const db = await openCartDB();
  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

// Helper function to delete a specific action from IndexedDB
async function deletePendingCartAction(id) {
  const db = await openCartDB();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = (event) => reject(event.target.error);
  });
}

// Helper function to clear all pending cart actions from IndexedDB
async function clearPendingCartActions() {
  const db = await openCartDB();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = (event) => reject(event.target.error);
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // On utilise Promise.all avec des catch individuels pour éviter que l'échec d'un seul fichier 
      // (ex: logo.png manquant) ne bloque toute l'installation du Service Worker.
      return Promise.all(
        STATIC_ASSETS.map(url => cache.add(url).catch(err => console.error(`[SW] Erreur de cache pour ${url}:`, err)))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ne pas intercepter les requêtes sensibles ou non-GET. /api/cart et
  // /api/wishlist ajoutés le 2026-08-26 : le stale-while-revalidate
  // ci-dessous rend le cache AVANT de revalider, donc un client gardait un
  // panier périmé après un déploiement (nouvelle version de l'API) ou
  // après une suppression d'article (le prochain GET /api/cart renvoyait
  // encore l'ancien contenu en cache le temps que la revalidation arrive).
  // Ces deux endpoints doivent toujours refléter l'état serveur réel.
  if (url.pathname.includes('/api/orders') || url.pathname.includes('/api/cart') || url.pathname.includes('/api/wishlist') || url.pathname.includes('/checkout') || request.method !== 'GET') return;

  // Ne pas intercepter les domaines externes (Stripe, Firebase, flagcdn, etc.)
  const isSameOrigin = url.origin === self.location.origin;
  const isMiadCDN = url.hostname.endsWith('miadmarket.com') || url.hostname.includes('r2.dev');
  if (!isSameOrigin && !isMiadCDN) return;

  if (request.destination === 'image' || url.pathname.includes('/api/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          const fetchPromise = fetch(request)
            .then((networkResponse) => {
              if (networkResponse.ok) {
                cache.put(request, networkResponse.clone()).catch(() => {});
              }
              return networkResponse;
            })
            .catch(() => {
              return cachedResponse || caches.match('/offline.html');
            });
          
          // Stratégie Stale-While-Revalidate : on rend le cache immédiatement s'il existe
          return cachedResponse || fetchPromise;
        });
      })
    );
  } else {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  }
});

self.addEventListener('message', (event) => {
  // Activation forcée : le client demande au nouveau SW de prendre le contrôle immédiatement
  // Cela évite que l'ancien SW reste actif et bloque Google Auth / Firebase
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'ADD_TO_CART_OFFLINE') {
    event.waitUntil(addPendingCartAction(event.data.payload));
  }
});
// 4. Background Sync (LA LOGIQUE RÉELLE AJOUTÉE ICI)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-cart') {
    event.waitUntil(sendPendingCartData());
  }
});

async function sendPendingCartData() {
  console.log('[MIAD SW] Début de la synchronisation en arrière-plan...');

  try {
    // 1. On récupère les actions stockées depuis IndexedDB
    const pendingActions = await getPendingCartActions();

    if (pendingActions.length === 0) {
      console.log('[MIAD SW] Aucune action en attente de synchronisation.');
      return;
    }

    for (const action of pendingActions) {
      try {
        // 2. Tentative de synchronisation individuelle
        const response = await fetch('/api/cart/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action)
        });

        if (response.ok) {
          console.log('[MIAD SW] Action synchronisée et supprimée :', action.id);
          // 3. Suppression uniquement si le serveur a répondu positivement
          await deletePendingCartAction(action.id);
        } else {
          console.warn('[MIAD SW] Le serveur a refusé l action (status:', response.status, '). Elle reste en attente.');
        }
      } catch (individualErr) {
        console.error('[MIAD SW] Erreur réseau pour l action', action.id, individualErr);
        // On ne jette pas d'erreur ici pour permettre aux autres actions de tenter leur chance
      }
    }

    // Notification globale si au moins une action a été traitée (optionnel)
    const remaining = await getPendingCartActions();
    if (remaining.length === 0 && pendingActions.length > 0) {
    self.registration.showNotification('MIAD Market', {
        body: 'Toutes vos modifications de panier ont été enregistrées !',
      icon: '/logo/logo.png',
    });
    }

  } catch (err) {
    console.error('[MIAD SW] Échec de la synchronisation complète :', err);
    // Optionnellement, notifier l'utilisateur de l'échec
    self.registration.showNotification('MIAD Market', {
      body: 'Échec de la synchronisation du panier. Réessayez plus tard.',
      icon: '/logo/logo.png',
    });
  }
}