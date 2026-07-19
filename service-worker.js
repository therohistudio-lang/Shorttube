/* =====================================================================
   service-worker.js — App Shell caching for ShortTube
   ---------------------------------------------------------------------
   Strategy: cache the app "shell" (HTML/CSS/JS/icons) so the app loads
   instantly and works offline, but NEVER cache live data — YouTube API
   responses, Appwrite calls, or the Appwrite SDK from its CDN. Those
   always go straight to the network so feeds, search, auth, and uploads
   stay live and correct.

   >>> BUMP THIS ON EVERY DEPLOY <<<
   Changing CACHE_NAME is what tells returning visitors' browsers there's
   a new version to fetch — without it, the old shell can keep being
   served from cache after you've pushed changes to Netlify.
===================================================================== */
const CACHE_NAME = 'shorttube-shell-v2';

const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/appwrite-config.js',
  './js/auth.js',
  './js/profile.js',
  './js/upload.js',
  './js/algorithm.js',
  './js/ads-unity.js',
  './js/social.js',
  './js/messaging.js',
  './js/video-api.js',
  './js/feed.js',
  './js/player-enhancements.js',
  './js/app.js',
  './js/pwa-register.js',
  './assets/logo.png',
  './assets/splash.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png'
];

// Hosts that must ALWAYS hit the network — live data, never cached.
const NEVER_CACHE_HOSTS = [
  'googleapis.com',       // YouTube Data API
  'youtube.com',          // video embeds
  'appwrite',             // your Appwrite endpoint (matches cloud.appwrite.io etc.)
  'cdn.jsdelivr.net',     // Appwrite SDK — check for SDK updates, don't pin it
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com'
];

function isNeverCache(url) {
  return NEVER_CACHE_HOSTS.some(host => url.includes(host));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting()) // activate the new SW as soon as it's installed
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)) // drop old-version caches
      ))
      .then(() => self.clients.claim()) // take control of open tabs immediately
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests — POST/PUT (uploads, auth) must always hit
  // the network untouched.
  if (request.method !== 'GET') return;

  // Never intercept API/CDN/live-data requests — always network.
  if (isNeverCache(request.url)) return;

  // App shell: cache-first, falling back to network, and quietly
  // refreshing the cache in the background (stale-while-revalidate) so
  // the next load picks up any change without blocking this one.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached: nothing we can do

      return cached || networkFetch;
    })
  );
});
