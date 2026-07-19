/* =====================================================================
   ads-unity.js — Unity Ads (Game ID 800084807) — the ONLY ad system
   ---------------------------------------------------------------------
   Google Ad Manager / GPT has been fully removed from this app (ads.js
   is deleted). Unity Ads is the sole ad network, via
   @openanime/capacitor-plugin-unityads, a native Capacitor plugin.
   Unity Ads has no web/JS SDK — ad rendering always happens in native
   Android code; this file only talks to that native layer through the
   Capacitor bridge (window.Capacitor.Plugins.UnityAds), auto-registered
   after `npm install @openanime/capacitor-plugin-unityads &&
   npx cap sync android`. No bundler/import needed — this project loads
   plain <script> tags.

   >>> INTERSTITIAL — SHOWS IN BOTH HOME AND SHORTS <<<
   Interstitials are a FULL-SCREEN format by design — no ad network lets
   you embed one inside a scrolling list as a tile, and faking that is a
   Unity Ads policy violation that risks the whole account. So instead of
   adding interstitials into either feed's item array, this file paces
   them by counting real "one video reached" events and popping a
   full-screen interstitial over the whole app every
   INTERSTITIAL_EVERY_N_VIDEOS videos — set to 3 below (i.e. an ad after
   every 3rd video) per your "every video or every few videos" request.
   Set it to 1 for an ad after every single video/scroll if you want it
   more aggressive — see the constant below.
     - HOME (long-form): counted once per real video card rendered —
       see the hook in renderFeedItems() in index.html.
     - SHORTS: counted once per Short that actually becomes the active/
       visible slide — see the hook in observeShortsPlayback() in
       index.html. This fires on every real scroll/swipe, not when a
       batch of Shorts is first rendered into the DOM.
   Both feeds share the same counter/config below, so "every 3 videos"
   means the same thing whichever feed the user is scrolling.

   >>> BANNER — HIDDEN PLACEHOLDER, UNITY-ONLY (NO GPT) <<<
   @openanime/capacitor-plugin-unityads is beta and, as of this writing,
   only implements interstitial — banner support is listed as "planned"
   but not shipped. Per your instruction to drop Google/GPT entirely,
   the reserved <div id="unityBannerSlot"> in index.html is now either:
     - hidden completely (BANNER_PLACEHOLDER_MODE = 'hidden', default), or
     - a simple static "Ad space" placeholder with no ad network behind
       it at all (BANNER_PLACEHOLDER_MODE = 'placeholder').
   Switch the mode below any time. Once banner support lands in this
   plugin (or you move to Unity's newer LevelPlay mediation plugin,
   which supports banner today under a different App Key/Ad Unit
   dashboard), fill in showBanner()'s loadAds() call and swap
   BANNER_PLACEHOLDER_MODE out.
===================================================================== */

const UNITY_ADS_CONFIG = {
  GAME_ID: "800084807",
  BANNER_PLACEMENT: "Banner_Android",
  INTERSTITIAL_PLACEMENT: "Interstitial_Android",
  // ⚠️ MUST be false before you submit to Amazon/any store — true only
  // returns Unity's test creative and never earns real revenue.
  TEST_MODE: true,
  // Disabled per explicit instruction: "Do NOT use Full-Screen or
  // Interstitial ads. They ruin the user experience." notifyCardShown()
  // below still counts videos reached, but skips displaying anything while
  // this is false. Flip to true only if you decide you want interstitials
  // back as a secondary revenue source alongside the banner.
  INTERSTITIAL_AUTO_ENABLED: false,
  // Show one full-screen interstitial every N videos reached, in either
  // feed (Home cards rendered + Shorts actually scrolled to). Set to 1
  // for "after every single video". Only takes effect if the flag above
  // is true.
  INTERSTITIAL_EVERY_N_VIDEOS: 3,
  // 'hidden' = banner slot takes no space at all.
  // 'placeholder' = a plain static "Ad space" box, no ad network.
  BANNER_PLACEHOLDER_MODE: 'hidden'
};

const ShortTubeUnityAds = {
  _unity: null,
  _sdkReady: false,
  _interstitialLoaded: false,
  _videosSinceLastAd: 0,

  _plugin() {
    this._unity = window.Capacitor?.Plugins?.UnityAds || null;
    if (!this._unity) {
      console.warn('[ShortTube] UnityAds native plugin not found. Did you run ' +
        '"npm install @openanime/capacitor-plugin-unityads && npx cap sync android"?');
    }
    return this._unity;
  },

  init() {
    const UnityAds = this._plugin();
    if (!UnityAds) return;

    UnityAds.addListener('initialized', () => {
      this._sdkReady = true;
      console.log('[ShortTube] Unity Ads initialized (Game ID ' + UNITY_ADS_CONFIG.GAME_ID + ')');
      this._loadInterstitial();
    });
    UnityAds.addListener('initializationError', ({ error }) => {
      console.error('[ShortTube] Unity Ads init failed:', error);
    });
    UnityAds.addListener('adLoaded', () => {
      this._interstitialLoaded = true;
    });
    UnityAds.addListener('adLoadError', ({ error }) => {
      this._interstitialLoaded = false;
      console.error('[ShortTube] Unity interstitial failed to load:', error);
    });
    UnityAds.addListener('adShown', ({ state }) => {
      // state: "SKIPPED" | "COMPLETED"
      console.log('[ShortTube] Unity interstitial finished:', state);
      this._interstitialLoaded = false;
      this._loadInterstitial(); // pre-fetch the next one right away
    });
    UnityAds.addListener('adShowError', ({ error }) => {
      console.error('[ShortTube] Unity interstitial failed to show:', error);
    });

    UnityAds.initAds({
      unityGameId: UNITY_ADS_CONFIG.GAME_ID,
      testMode: UNITY_ADS_CONFIG.TEST_MODE
    });
  },

  _loadInterstitial() {
    if (!this._unity) return;
    this._unity.loadAds({ adUnitId: UNITY_ADS_CONFIG.INTERSTITIAL_PLACEMENT });
  },

  // Called once per real video "reached" — a Home card rendered, or a
  // Short that actually became the active/visible slide (see the two
  // call sites in index.html). Shared counter, so pacing is identical
  // across both feeds.
  notifyCardShown() {
    if (!this._unity) return;
    this._videosSinceLastAd++;
    if (this._videosSinceLastAd < UNITY_ADS_CONFIG.INTERSTITIAL_EVERY_N_VIDEOS) return;
    this._videosSinceLastAd = 0;
    if (!UNITY_ADS_CONFIG.INTERSTITIAL_AUTO_ENABLED) return; // full-screen ads are off — see config note above
    if (this._sdkReady && this._interstitialLoaded) {
      this._unity.displayAd();
    } else {
      // Not ready yet (slow network / still loading) — skip this cycle
      // rather than blocking or queuing; the next _loadInterstitial()
      // pre-fetch keeps future cycles on track.
      console.log('[ShortTube] Unity interstitial not ready, skipping this cycle');
    }
  },

  /* ---------------- Ad-card trigger (ads-cards.js) ----------------
     Called when someone taps the "Watch Ad" CTA on an in-feed ad card.
     Uses the SAME Interstitial_Android placement/pipeline as the
     scroll-paced interstitials above — it's a real ad, just launched by a
     tap instead of a scroll count. Separate from _videosSinceLastAd so
     tapping a card never messes with that counter. */
  preloadForCard() {
    if (!this._unity || this._interstitialLoaded) return;
    this._loadInterstitial(); // harmless if one's already loading
  },
  showAdForCard(adId) {
    if (!this._unity) {
      console.warn('[ShortTube] Ad card tapped (' + adId + ') but the Unity Ads native plugin isn\'t present. ' +
        'This is expected in a browser/Netlify preview — Unity Ads has no web SDK and only runs inside the ' +
        'built Android app. Test this tap in the actual APK.');
      return;
    }
    if (this._sdkReady && this._interstitialLoaded) {
      this._unity.displayAd();
    } else {
      console.log('[ShortTube] Ad card tapped (' + adId + ') but the interstitial wasn\'t preloaded yet — loading now; try tapping again in a second.');
      this._loadInterstitial();
    }
  },

  /* ---------------- Banner (real, via native UnityBannerPlugin) ----------------
     Requires the UnityBannerPlugin.java native plugin (provided separately —
     see UnityBannerPlugin.java and its setup notes) to be added to your
     Capacitor Android project and registered in MainActivity.java. Until
     that's done, window.Capacitor.Plugins.UnityBanner won't exist and this
     falls back to the static "Ad space" placeholder below automatically —
     nothing crashes either way. */
  showBanner() {
    const UnityBanner = window.Capacitor?.Plugins?.UnityBanner;
    if (!UnityBanner) {
      console.warn('[ShortTube] UnityBannerPlugin not found — showing placeholder strip instead. ' +
        'Add UnityBannerPlugin.java to your Android project and register it in MainActivity.java (see the file\'s own header notes) to make this a real ad.');
      this.renderBannerPlaceholder();
      return;
    }
    UnityBanner.show({ placementId: UNITY_ADS_CONFIG.BANNER_PLACEMENT })
      .then(() => this._setSlotVisible(true))
      .catch(err => console.error('[ShortTube] Unity banner failed to show:', err));
  },
  hideBanner() {
    const UnityBanner = window.Capacitor?.Plugins?.UnityBanner;
    if (UnityBanner) UnityBanner.hide().catch(() => {});
    this._setSlotVisible(false);
  },

  // Renders the reserved #unityBannerSlot as either fully hidden or a
  // plain static placeholder, per BANNER_PLACEHOLDER_MODE. No ad network
  // involved — this is just a layout placeholder until a real Unity
  // banner call replaces it in showBanner() above.
  renderBannerPlaceholder() {
    const slot = document.getElementById('unityBannerSlot');
    if (!slot) return;
    if (UNITY_ADS_CONFIG.BANNER_PLACEHOLDER_MODE === 'placeholder') {
      slot.textContent = 'Ad space';
      this._setSlotVisible(true);
    } else {
      slot.textContent = '';
      this._setSlotVisible(false);
    }
  },

  // Shows/hides #unityBannerSlot and pushes the bottom-nav-adjacent content
  // (body bottom padding) up when visible, so the banner reserves its own
  // space above the nav bar instead of covering the last row of feed cards.
  _setSlotVisible(visible) {
    const slot = document.getElementById('unityBannerSlot');
    if (!slot) return;
    const slotHeight = 50; // keep in sync with #unityBannerSlot CSS height
    const navHeight = 64; // keep in sync with .bottom-nav CSS height
    slot.classList.toggle('visible', visible);
    document.body.style.paddingBottom = (navHeight + (visible ? slotHeight : 0)) + 'px';
  }
};

window.ShortTubeUnityAds = ShortTubeUnityAds;
document.addEventListener('DOMContentLoaded', () => {
  ShortTubeUnityAds.init();
  ShortTubeUnityAds.showBanner(); // tries the real native banner; auto-falls back to the placeholder strip if UnityBannerPlugin isn't installed yet
});
