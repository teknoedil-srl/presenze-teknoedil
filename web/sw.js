// Service worker: rende disponibile l'interfaccia anche senza rete.
// I dati (Firestore) hanno una propria cache offline gestita dall'SDK.
const CACHE = "presenze-v4";
const FILES = ["./", "index.html", "style.css?v=4", "app.js?v=4", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "vendor/xlsx.full.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const sdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!sameOrigin && !sdk) return; // Firestore e login passano direttamente in rete
  if (url.pathname.includes("/__/auth/")) return; // pagine di accesso: mai dalla cache
  if (sdk) {
    // SDK Firebase con versione fissa: prima la cache
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); return res;
    })));
    return;
  }
  // File dell'app: prima la rete (aggiornamenti immediati), cache se offline
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: false }).then((r) => r || caches.match("index.html"))));
});
