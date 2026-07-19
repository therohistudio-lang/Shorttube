/* =====================================================================
   ads-cards.js — In-feed "Ad Card" system
   ---------------------------------------------------------------------
   WHAT THIS ADDS: a real in-feed tile (not a full-screen interstitial)
   that sits in the scrolling grid, styled to match the surrounding
   video/image thumbnails, with a clearly visible "Ad" badge.

   HONEST LIMITATION — please read this before assuming the card frame
   itself plays a video, because it doesn't and can't with what's
   installed:
   Unity Ads has NO inline/native ad format at all — not in this app's
   plugin, not in any Unity SDK. Every Unity ad is either a full-screen
   Interstitial or a full-screen Rewarded video; there is no "embed this
   ad inside a small tile" mode, full stop (that's true of Google AdMob
   and Meta too — full-screen formats are full-screen by definition on
   every network). On top of that, the specific plugin already installed
   here (@openanime/capacitor-plugin-unityads) has ONLY ever shipped
   Interstitial — its own header in ads-unity.js says Banner support is
   still "planned," not shipped. So Banner_Android has nowhere to render
   to yet, inline or otherwise.
   What IS real and does work: the card shows a labeled "Ad" tile. The real
   Unity Interstitial (Interstitial_Android) auto-fires full-screen the
   moment the card scrolls into view (see _autoPlayObserver below) — no tap
   needed. The CTA button on the tile is a manual replay/retry, for the case
   where the interstitial hadn't finished pre-loading yet when the card came
   into view.
   Rewarded_Android isn't used by this file — it's reserved for a
   "watch an ad for coins" button, which fits the coin-reward system
   already in the app, but that's a different feature from a passive feed
   ad; say the word if you want that wired up separately.
   IMPORTANT — Unity Ads only exists natively: Unity has no web/JS SDK, so
   testing this on Netlify (a browser) will ALWAYS show the placeholder art
   with no real ad behind it, by design — window.Capacitor.Plugins.UnityAds
   simply doesn't exist outside the built Android app. Test this in the
   actual APK, not the Netlify preview.

   PACING: per-feed, set in AD_CARD_CONFIG.EVERY_N below — every Nth item in
   that specific feed is an ad, including across paginated infinite-scroll
   loads, via a per-feed counter that only resets on a fresh (non-append)
   load.
===================================================================== */

const AD_CARD_CONFIG = {
  // Per your latest instructions: an ad after every 2 videos in the
  // long-form feed, and after every single item in the Home/Shorts feed.
  EVERY_N: { images: 1, videos: 2 },
  PLACEHOLDER_HEADLINE: "Sponsored",
  PLACEHOLDER_BODY: "Ad playing…",
  PLACEHOLDER_CTA: "Replay Ad",
  // Inline SVG, not an external URL — a remote placeholder image (e.g.
  // placehold.co) silently fails with no network access (offline testing,
  // a locked-down packaged-app WebView), which is exactly what made these
  // cards look "empty." This always renders, network or not, as the tile's
  // static art — the real ad plays full-screen on tap (see header above).
  PLACEHOLDER_IMAGE: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225'%3E%3Crect width='400' height='225' fill='%231a1a1a'/%3E%3Ctext x='50%25' y='50%25' fill='%23FFC107' font-family='sans-serif' font-size='22' font-weight='bold' text-anchor='middle' dominant-baseline='middle'%3EAd Space%3C/text%3E%3C/svg%3E",

  // Real IDs from your Unity dashboard. INTERSTITIAL is the only one this
  // file uses (see header note on why Banner/Rewarded aren't wired here).
  UNITY_PLACEMENT_IDS: {
    interstitial: "Interstitial_Android",
    banner: "Banner_Android",     // not usable yet — plugin has no banner support (see header)
    rewarded: "Rewarded_Android"  // reserved for a future "watch ad for coins" feature, not used here
  }
};

const ShortTubeAdCards = {
  _counters: {},

  // Fires the real Unity ad automatically the moment an ad card is actually
  // on-screen (not just rendered into the DOM off-screen), so the ad
  // launches as the person scrolls to it — no tap required. Each card only
  // auto-fires once (unobserve after firing) so re-scrolling past the same
  // card doesn't relaunch it. threshold 0.6 = fires once ~60% of the card
  // is visible, so it doesn't trigger on a card that's barely peeking in
  // at the very bottom edge of the screen.
  _autoPlayObserver: new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      window.ShortTubeUnityAds?.showAdForCard(el.dataset.adId);
      el.dataset.autoFired = '1';
      obs.unobserve(el);
    });
  }, { threshold: 0.6 }),

  // Call at the start of every FRESH (non-append) feed load so the "every
  // 3rd card" pattern starts clean each time the feed is reloaded from
  // scratch, but keeps counting across infinite-scroll pages.
  reset(feedKey) { this._counters[feedKey] = 0; },

  // Takes a page of real feed items and returns a new array with ad-card
  // placeholder objects spliced in at the right spots.
  interleave(feedKey, items) {
    if (this._counters[feedKey] === undefined) this._counters[feedKey] = 0;
    const out = [];
    items.forEach(item => {
      out.push(item);
      this._counters[feedKey]++;
      const everyN = AD_CARD_CONFIG.EVERY_N[feedKey] || 3; // fallback if an unrecognized feedKey ever shows up
      if (this._counters[feedKey] % everyN === 0) {
        out.push({ __isAd: true, __feedKey: feedKey, __adId: `${feedKey}-ad-${this._counters[feedKey]}` });
      }
    });
    return out;
  },

  // Builds the ad tile. Deliberately reuses the exact .video-card/
  // .thumb-wrap/.video-meta markup real thumbnails use (per "must match
  // the design of my video thumbnails"), plus the .ad-card/.ad-badge
  // styling in style.css so it's unmistakably an ad, not a fake video.
  createAdCardElement(feedKey, adId) {
    const card = document.createElement('div');
    card.className = 'video-card ad-card';
    card.dataset.adId = adId;
    card.innerHTML = `
      <div class="thumb-wrap">
        <span class="ad-badge">Ad</span>
        <img src="${AD_CARD_CONFIG.PLACEHOLDER_IMAGE}" alt="Advertisement" loading="lazy" decoding="async">
      </div>
      <div class="video-meta">
        <h3>${AD_CARD_CONFIG.PLACEHOLDER_HEADLINE}</h3>
        <div class="sub">${AD_CARD_CONFIG.PLACEHOLDER_BODY}</div>
        <button class="pill-btn-outline ad-cta-btn" type="button">${AD_CARD_CONFIG.PLACEHOLDER_CTA}</button>
      </div>`;
    card.querySelector('.ad-cta-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      window.ShortTubeUnityAds?.showAdForCard(adId);
    });
    // Pre-fetch immediately so the interstitial is ready by the time this
    // card scrolls into view (see _autoPlayObserver below) — otherwise the
    // very first ad card on a fresh load would hit a cold cache.
    window.ShortTubeUnityAds?.preloadForCard();
    this._autoPlayObserver.observe(card);
    return card;
  }
};

window.ShortTubeAdCards = ShortTubeAdCards;
