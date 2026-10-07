/**
 * FEROX has moved — this service worker exists only to retire the old one.
 *
 * The app that used to live here registered /FEROX/sw.js (scope /FEROX/) and
 * served its shell cache-first, so anyone who had it would keep seeing the
 * old app instead of the page telling them it moved. Browsers re-fetch a
 * registered worker's script on their routine update check, find this one,
 * and install it in the old one's place. It then:
 *
 *   1. takes over at once (skipWaiting),
 *   2. deletes the old app's caches,
 *   3. unregisters itself, so nothing intercepts this scope any more,
 *   4. reloads every page it controls from the network — which is now the
 *      "FEROX has moved" bridge.
 *
 * Only pages that were already controlled are reloaded. A page that registers
 * this worker fresh is never claimed, so even a stale copy of the old app
 * served from the HTTP cache cannot loop: it registers, nothing reloads it.
 *
 * Caches are matched on the old app's own prefix ('ferox-v…'): the origin is
 * shared with the rest of victordeglon.github.io, and nothing else here is
 * this worker's to delete. There is deliberately no fetch handler — every
 * request goes straight to the network.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => /^ferox/i.test(k)).map(k => caches.delete(k)));
    } catch { /* nothing to clear */ }
    try { await self.registration.unregister(); } catch { /* already gone */ }
    const windows = await self.clients.matchAll({ type: 'window' });
    // Not awaited: a navigation can outlive this event, and waiting on it
    // from inside activation is how a worker ends up waiting on itself.
    for (const client of windows) client.navigate(client.url).catch(() => {});
  })());
});
