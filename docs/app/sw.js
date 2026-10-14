/* TeleFamily — service worker: push-уведомления, когда приложение закрыто.
 * Сервер шлёт JSON: { title, body, chatId, tag } — показываем уведомление;
 * клик — фокусим открытое окно приложения (или открываем новое) и говорим
 * странице, какой чат распахнуть. */
'use strict';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (err) { try { data = { body: e.data ? e.data.text() : '' }; } catch (e2) {} }
  const title = data.title || 'TeleFamily';
  const opts = {
    body: data.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || 'telefamily',
    renotify: true,
    requireInteraction: data.kind === 'call',   /* звонок — висит, пока не откроешь */
    data: { chatId: data.chatId || null, kind: data.kind || null },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) {
        await c.focus();
        try { c.postMessage({ type: 'notification-click', chatId: data.chatId }); } catch (err) {}
        return;
      }
    }
    /* окон нет — открываем приложение (адрес берём от scope: работает и на сервере, и на Pages) */
    const u = new URL('./?app=1&serveo-skip-browser-warning=true', self.registration.scope);
    if (data.chatId) u.searchParams.set('chat', data.chatId);
    await self.clients.openWindow(u.href);
  })());
});
