/* =====================================================================
   pwa-register.js — registers service-worker.js for the web/Netlify
   deployment only.
   ---------------------------------------------------------------------
   Wrapped in feature-detection + try/catch so this is a safe no-op
   anywhere service workers aren't available or don't make sense —
   older browsers, and later when this same www/ folder gets wrapped
   into the VoltBuilder/Capacitor APK. Inside the native app, assets
   are already bundled on-device, so there's nothing useful for a
   service worker to cache; it simply won't register there and the app
   runs exactly as it did before.
===================================================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then((reg) => console.log('[ShortTube] Service worker registered:', reg.scope))
      .catch((err) => console.warn('[ShortTube] Service worker registration failed:', err));
  });
}
