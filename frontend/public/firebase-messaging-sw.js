// Firebase Cloud Messaging Service Worker
// Ce fichier DOIT être à la racine /public/ pour être servi depuis /firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

// Config Firebase publique (identique à lib/firebase.ts)
const firebaseConfig = {
  apiKey:            'AIzaSyDFyZlqyNuM1OK827DTfKKdp7AxgwkMUzg',
  authDomain:        'authentification-miad.firebaseapp.com',
  projectId:         'authentification-miad',
  storageBucket:     'authentification-miad.firebasestorage.app',
  messagingSenderId: '761840162782',
  appId:             '1:761840162782:web:07ad007945465fa7786f4f',
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const messaging = firebase.messaging();

// ── Notifications en arrière-plan ──────────────────────────────────────────
messaging.onBackgroundMessage(function (payload) {
  const { title, body, icon, click_action, badge, image } = payload.notification || {};
  const data = payload.data || {};

  self.registration.showNotification(title || 'MIAD Market', {
    body:    body    || 'Vous avez un nouveau message.',
    icon:    icon    || '/logo/logo.png',
    badge:   badge   || '/logo/logo.png',
    image:   image,
    data:    { url: click_action || data.url || 'https://www.miadmarket.com' },
    actions: [
      { action: 'open',    title: 'Voir'    },
      { action: 'dismiss', title: 'Ignorer' },
    ],
    vibrate: [200, 100, 200],
    requireInteraction: false,
  });
});

// ── Clic sur la notification ────────────────────────────────────────────────
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = (event.notification.data && event.notification.data.url)
    || 'https://www.miadmarket.com';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
