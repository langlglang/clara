/* Clara companion service worker (registered by the companion app at scope "/").
 *
 * - Caches the app shell (pages, Next's static chunks, icons) so the app opens on a weak connection. API responses
 *   (/api/...) are never cached: alerts must always be live.
 * - Shows push notifications for emergency alerts and ride offers, with answer buttons.
 * - A button press posts the answer to the same API the app uses; a tap on the notification opens the app.
 */
// v2: v1 kept dev-server chunks forever (see cacheFirst); bumping the version deletes that cache on activate.
const VERSION = "clara-shell-v2";
const SHELL = ["/app", "/join", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/apple-icon"];
const NAV_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // One missing file never blocks the install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const cacheable = (res) => res && res.ok && res.type === "basic";
// Only files the server marks immutable are safe to serve from cache forever: production builds put a content
// hash in /_next/static names and send `immutable`. `next dev` reuses the same chunk URLs with `no-cache`, so a
// cached dev chunk would outlive every edit and restart.
const immutable = (res) => cacheable(res) && /\bimmutable\b/i.test(res.headers.get("cache-control") || "");

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NAV_TIMEOUT_MS)),
    ]);
    if (cacheable(res)) cache.put(new URL(request.url).pathname, res.clone()).catch(() => undefined);
    return res;
  } catch {
    const path = new URL(request.url).pathname;
    return (await cache.match(path)) || (await cache.match("/app")) || new Response("Clara is offline. Reconnect to see alerts.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (immutable(res)) cache.put(request, res.clone()).catch(() => undefined);
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API (alerts, inbox, live stream) or the service worker itself.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname === "/apple-icon" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(cacheFirst(request));
  }
});

// ---- Push ----

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Clara", body: event.data ? event.data.text() : "" };
  }
  const info = data.data || {};
  const isRide = info.kind === "ride";
  const actions = data.actions
    ? isRide
      ? [
          { action: "accept", title: "I CAN DRIVE" },
          { action: "decline", title: "CAN'T" },
        ]
      : [
          { action: "coming", title: "I'M COMING" },
          { action: "declined", title: "CAN'T" },
        ]
    : [];
  event.waitUntil(
    self.registration.showNotification(data.title || "Clara", {
      body: data.body || "",
      tag: data.tag || "clara",
      renotify: true,
      requireInteraction: Boolean(data.actions),
      vibrate: [400, 150, 400, 150, 800],
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      actions,
      data: info,
    }),
  );
});

async function openApp(path) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of all) {
    if (new URL(client.url).origin === self.location.origin && "focus" in client) {
      await client.focus();
      if ("navigate" in client) await client.navigate(path).catch(() => undefined);
      return;
    }
  }
  await self.clients.openWindow(path);
}

async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const info = n.data || {};
  n.close();
  event.waitUntil(
    (async () => {
      if (info.alert_id && (event.action === "coming" || event.action === "declined")) {
        const ok = await post(`/api/alerts/${encodeURIComponent(info.alert_id)}/respond`, { volunteer_id: info.volunteer_id, action: event.action });
        // Coming: open the app for directions. A failed answer also opens it, so they can answer there.
        if (event.action === "coming" || !ok) await openApp(`/app?alert=${encodeURIComponent(info.alert_id)}`);
        return;
      }
      if (info.ride_id && (event.action === "accept" || event.action === "decline")) {
        const ok = await post(`/api/rides/${encodeURIComponent(info.ride_id)}/answer`, { driver_id: info.driver_id, action: event.action });
        if (event.action === "accept" || !ok) await openApp(`/app?ride=${encodeURIComponent(info.ride_id)}`);
        return;
      }
      await openApp(info.url || (info.alert_id ? `/app?alert=${encodeURIComponent(info.alert_id)}` : "/app"));
    })(),
  );
});
