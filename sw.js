/**
 * sw.js — Service Worker (FCM対応版)
 * テク班 活動お知らせ PWA
 *
 * 【FCMとSWの関係】
 * Firebase Messaging はデフォルトで "firebase-messaging-sw.js" という名前のSWを
 * 自動登録しようとするが、index.html 側で messaging.useServiceWorker(reg) を呼ぶことで
 * このファイル（sw.js）をFCM用SWとして使用できる。
 *
 * 担当範囲:
 *   1. Firebase Messaging SDK の読み込みとバックグラウンド受信設定
 *   2. 静的アセットのキャッシュ（Cache First）
 *   3. 通知クリック時にPWAを前面に開く
 */

'use strict';

// ── Firebase SDK をSWスコープに読み込む ──────────────────────────────
// importScripts はSW内でCDNスクリプトを同期的に読み込む唯一の方法
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// ── Firebase 初期化（index.htmlと同じ設定値が必要） ─────────────────
// SWはメインスレッドと独立したコンテキストで動くため、ここでも initializeApp が必要
firebase.initializeApp({
    apiKey: "AIzaSyAW0Dml8tSNNybpsegTKhZn0k8g1yA3-a0",
    authDomain: "auto-notification-for-tekuhan.firebaseapp.com",
    projectId: "auto-notification-for-tekuhan",
    storageBucket: "auto-notification-for-tekuhan.firebasestorage.app",
    messagingSenderId: "269103417349",
    appId: "1:269103417349:web:0afb0762c6247fffe2346c",
    measurementId: "G-NPYR5BTWHZ"
});

const messaging = firebase.messaging();

// ── バックグラウンド受信ハンドラ ──────────────────────────────────────
// アプリが閉じている / バックグラウンドにいるときにFCMメッセージが届いた場合、
// Firebase SDK がこのハンドラを呼び出す。
// ここで showNotification() を呼ばないと通知が表示されない。
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] バックグラウンド受信:', payload);

  const title = payload.notification?.title || 'テク班 活動お知らせ';
  const body  = payload.notification?.body  || '今週の活動情報が更新されました。タップして確認してください。';
  const icon  = payload.notification?.icon  || './icons/icon-192.png';

  self.registration.showNotification(title, {
    body,
    icon,
    badge:   './icons/icon-192.png',
    tag:     'tekuban-activity',  // 同タグの通知は上書き（重複防止）
    renotify: false,
    vibrate: [200, 100, 200],
    data: {
      // 通知クリック時の遷移先URL
      url: self.location.origin + self.registration.scope,
    },
  });
});

// ── キャッシュ設定 ─────────────────────────────────────────────────
const CACHE_NAME = 'tekuban-v2'; // FCM対応に更新したためバージョンを上げる
const CACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── インストール ───────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] install (v2)');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

// ── アクティベート ────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] activate (v2)');
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log('[SW] 古いキャッシュを削除:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ── フェッチ ──────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Firebase / GAS / Drive へのリクエストはキャッシュしない
  if (
    url.hostname.includes('firebaseapp.com')   ||
    url.hostname.includes('googleapis.com')    ||
    url.hostname.includes('gstatic.com')       ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('drive.google.com')
  ) {
    return;
  }

  // 静的ファイルはキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const toCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
        }
        return response;
      });
    })
  );
});

// ── 通知クリック ──────────────────────────────────────────────────
// FCM の onBackgroundMessage で表示した通知をタップしたときの処理
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] notificationclick');
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : self.location.origin + self.registration.scope;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
