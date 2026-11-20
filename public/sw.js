// Service worker for push notifications only. It caches nothing: Homebase is not an offline app.
const sw = /** @type {any} */ (self);
sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', e => e.waitUntil(sw.clients.claim()));

// server/push.mjs sends { title, body, tag, chat }; one tag per session, so a newer push replaces the older one.
sw.addEventListener('push', e => {
    let d = {};
    try {
        d = e.data?.json() ?? {};
    } catch {}
    e.waitUntil(sw.registration.showNotification(d.title || 'Homebase', { body: d.body, tag: d.tag, data: { chat: d.chat }, icon: '/icon.svg' }));
});

// Opens Homebase on that chat (app.js reads ?chat=), in an open Homebase window if there is one.
sw.addEventListener('notificationclick', e => {
    e.notification.close();
    const chat = e.notification.data?.chat;
    const url = new URL(chat ? `/?chat=${encodeURIComponent(chat)}` : '/', sw.location.origin).href;
    e.waitUntil(sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
        const c = list[0];
        if (!c) {
            return sw.clients.openWindow(url);
        }
        try {
            await c.focus();
            return await c.navigate(url);
        } catch {
            return sw.clients.openWindow(url);
        }
    }));
});
