/* Gram Flow service worker — app shell only; remote media stays a direct URL. */
const CACHE_NAME = "gram-flow-shell-v2";
const APP_SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./legacy-crypto.js", "./manifest.json", "./assets/icon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Never cache Firebase JSON, SSE or direct media: this prevents stale feeds and
  // avoids consuming device storage with user-provided URLs.
  if (url.hostname.includes("firebasedatabase.app") || request.destination === "video" || request.destination === "audio") return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (!response || !response.ok || response.type === "opaque") return response;
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match("./index.html")))
  );
});
