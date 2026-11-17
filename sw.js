const CACHE = "passport-desk-shell-v5";
const APP_FILES = ["./", "./index.html", "./styles.css", "./config.js", "./app.js", "./mrz.mjs", "./mrz-vision.mjs", "./manifest.webmanifest", "./icon.svg"];
const EXTERNAL = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(APP_FILES);
    try { await cache.add(EXTERNAL[0]); } catch { /* The app shell must remain installable without CDN */ }
    await self.skipWaiting();
  }));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network-First for app files to guarantee instant updates on phones and desktops,
// falling back seamlessly to offline cache when disconnected.
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match("./index.html")))
    );
    return;
  }

  if (url.hostname.endsWith("jsdelivr.net")) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
        return response;
      }))
    );
  }
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data === "CACHE_OCR") {
    event.waitUntil(caches.open(CACHE).then(cache => Promise.all(EXTERNAL.map(async url => {
      try { await cache.add(url); } catch { /* Runtime downloads remain available when connected. */ }
    }))));
  }
});
