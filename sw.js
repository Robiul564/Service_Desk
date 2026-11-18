const CACHE = "passport-desk-shell-v11";
const APP_FILES = ["./", "./index.html", "./styles.css", "./config.js", "./app.js", "./manifest.webmanifest", "./icon.svg"];
const MRZ_ASSETS = [
  "./vendor/mrz-scanner/worker.js",
  "./vendor/mrz-scanner/mrz-cnn.onnx",
  "./vendor/mrz-scanner/chunks/preload-helper-D9-d1NeU.js",
  "./vendor/mrz-scanner/chunks/ort.wasm.min-BSurf3ne.js",
  "./vendor/mrz-scanner/chunks/ort-wasm-simd-threaded.mjs",
  "./vendor/mrz-scanner/chunks/ort-wasm-simd-threaded.wasm"
];
const EXTERNAL = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"
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
    // Cache-first for the pinned, immutable MRZ model and WASM runtime.
    if (url.pathname.includes("/vendor/mrz-scanner/")) {
      event.respondWith(
        caches.match(request).then(cached => cached || fetch(request).then(response => {
          if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
          return response;
        }))
      );
      return;
    }

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
  if (event.data === "CACHE_MRZ") {
    event.waitUntil(caches.open(CACHE).then(cache => Promise.all([...MRZ_ASSETS, ...EXTERNAL].map(async url => {
      try {
        if (!await cache.match(url)) await cache.add(url);
      } catch { /* Runtime downloads remain available when connected. */ }
    }))));
  }
});
