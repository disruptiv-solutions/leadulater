/* eslint-disable no-restricted-globals */
// Minimal PWA service worker (dev + prod safe).
// Strategy:
// - Precache app shell routes we control.
// - Navigations: network-first with offline fallback.
// - Static assets: cache-first.

const VERSION = "v1";
const CACHE = `crm-companion-${VERSION}`;
const PRECACHE_URLS = ["/", "/login", "/dashboard", "/offline", "/manifest.webmanifest", "/icon.svg", "/maskable-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isNavigationRequest = (request) =>
  request.mode === "navigate" ||
  (request.method === "GET" &&
    request.headers.get("accept") &&
    request.headers.get("accept").includes("text/html"));

const isStaticAsset = (url) => {
  // next static, public assets, common static extensions
  return (
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/public/") ||
    /\.(?:css|js|mjs|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(url.pathname)
  );
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isNavigationRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache a copy of successful navigations (best effort)
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offline = await caches.match("/offline");
          return offline || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        }),
    );
    return;
  }

  if (request.method === "GET" && isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        });
      }),
    );
  }
});

