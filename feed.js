/* =====================================================================
   feed.js — Hybrid feed: YouTube + Appwrite uploads
   ---------------------------------------------------------------------
   STANDALONE APP VERSION: calls ShortTubeVideoAPI (js/video-api.js)
   directly, in-process, instead of fetching a Netlify serverless
   endpoint. There is no backend anymore — YouTube calls run
   straight from the WebView. See video-api.js for the security note
   about API keys now living client-side.

   Normalizes all three into the same shape your existing card renderers
   already expect:
     { id, source, title, thumbnail, embedUrl, channel, duration,
       viewCount, uploadedAt }
   — so createVideoCard() in index.html doesn't need to
   change their data-fetching. Just swap their data source to
   ShortTubeFeed.getHomeFeed() / getShortsFeed() instead of calling
   ShortTubeVideoAPI directly.

   STRICT SHORTS/LONG SEPARATION: a single shared rule decides category
   for EVERY source (Appwrite, YouTube) — not just uploads:
     - duration > 0 && duration <= SHORT_VIDEO_MAX_SECONDS  -> Shorts only
     - everything else (including unknown/0 duration, to be safe with
       older uploads or an API response missing duration) -> Home only
   This prevents the same clip from ever appearing as a landscape Home
   card AND a vertical Shorts slide.

   DEFAULT CONTENT: the onboarding "Interests" picker has been removed —
   there's no per-user category filtering anymore. Home and Shorts both
   default to a fixed "Funny Videos" category (YouTube's Comedy category,
   via the cheap videos.list?videoCategoryId filter — see video-api.js's
   YOUTUBE_CATEGORY_MAP), never the expensive Search API.
===================================================================== */
/* ---------------- Slow-network (2G/3G) performance tuning ----------------
   navigator.connection is a rough signal (not supported on iOS Safari), so
   this only ever narrows the page size down — never widens it beyond the
   caller's base value — and always falls back to the base size when the
   API/data is unavailable. Applied to every paginated feed fetch so a slow
   link pulls a smaller batch per request instead of timing out on a big one. */
function effectivePageSize(baseSize) {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return baseSize;
  if (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') {
    return Math.max(6, Math.round(baseSize / 3));
  }
  if (conn.effectiveType === '3g') {
    return Math.max(10, Math.round(baseSize / 2));
  }
  return baseSize;
}

const SHORT_VIDEO_MAX_SECONDS = 180;
function isShortForm(v) { return typeof v.duration === 'number' && v.duration > 0 && v.duration <= SHORT_VIDEO_MAX_SECONDS; }

// Fixed default content category now that per-user Interests have been
// removed — maps to YOUTUBE_CATEGORY_MAP.comedy ("23") in video-api.js.
const DEFAULT_HOME_CATEGORY = "comedy";

let lastFeedSourceErrors = null;
const ShortTubeFeed = {

  async fetchAppwriteVideos(limit = 25, offset = 0) {
    // DEBUG: log exactly which IDs are being sent, so a typo'd/incorrect
    // database or collection ID shows up immediately in the console.
    console.log('[ShortTube] fetchAppwriteVideos → calling listDocuments with',
      { databaseId: APPWRITE_CONFIG.DATABASE_ID, collectionId: APPWRITE_CONFIG.COLLECTIONS.VIDEOS, limit, offset });

    let res;
    try {
      res = await databases.listDocuments(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
        [Query.orderDesc('$createdAt'), Query.limit(limit), Query.offset(offset)]
      );
      console.log('[ShortTube] listDocuments response:', res);
    } catch (err) {
      // Log the full Appwrite error (message/code/type/response) so the real
      // cause — bad ID, missing permission, no index, etc. — is visible,
      // then fail soft with an empty array instead of throwing. Throwing
      // here would previously reject the whole Promise.all in getHomeFeed()
      // and silently wipe out the YouTube results too.
      console.error('[ShortTube] listDocuments FAILED:', err);
      return [];
    }

    // Defensive check: handle a missing/empty response shape gracefully
    // instead of crashing on res.documents being undefined.
    const documents = Array.isArray(res?.documents) ? res.documents : [];
    if (documents.length === 0) {
      console.log('[ShortTube] Appwrite videos collection returned 0 documents (collection is empty or query matched nothing).');
      return [];
    }

    // MODERATION: never surface a video that automated/community moderation
    // has flagged. 'removed' = confirmed violation (taken down for good);
    // 'pending' = enough reports came in (or the upload-time checks flagged
    // it) that it's held out of feeds until a human reviews it. Videos with
    // no moderationStatus field yet (older uploads) are treated as clean.
    const clean = documents.filter(d => d.moderationStatus !== 'removed' && d.moderationStatus !== 'pending');

    // Ranks uploads by engagement score before they enter the merge,
    // so consistently well-watched uploads surface more often.
    const ranked = ShortTubeAlgorithm.rankByEngagement(clean);

    // Resolve owner display names in parallel (small batch, cached per session)
    const withOwners = await Promise.all(ranked.map(async (doc) => {
      const ownerName = await this._getCachedOwnerName(doc.ownerId);
      return {
        id: doc.$id,
        source: 'appwrite',
        title: doc.title,
        channel: ownerName,
        thumbnail: storage.getFileView(APPWRITE_CONFIG.BUCKETS.VIDEO_THUMBS, doc.thumbnailFileId).href,
        embedUrl: storage.getFileView(APPWRITE_CONFIG.BUCKETS.VIDEO_FILES, doc.videoFileId).href,
        duration: doc.durationSeconds,
        // engagementScore is the closest thing we track to a "view count"
        // for uploads (bumped on every watch — see algorithm.js)
        viewCount: doc.engagementScore || 0,
        uploadedAt: doc.createdAt || doc.$createdAt,
        ownerId: doc.ownerId,
        _raw: doc // kept around so player-enhancements.js / algorithm.js can log watch time
      };
    }));
    return withOwners;
  },

  _ownerNameCache: {},
  async _getCachedOwnerName(ownerId) {
    if (this._ownerNameCache[ownerId]) return this._ownerNameCache[ownerId];
    try {
      const profile = await databases.getDocument(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, ownerId);
      this._ownerNameCache[ownerId] = profile.displayName;
      return profile.displayName;
    } catch { return "ShortTube Creator"; }
  },

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  /* ---------------- HOME (long-form) ----------------
     IMPORTANT: this now NEVER touches YouTube's Search API. It calls
     ShortTubeVideoAPI.getHomeVideos(), which hits
     videos.list?chart=mostPopular (1 quota unit) instead of search.list
     (100 quota units) — see video-api.js for the full explanation and for
     why Home/Search are two fully separate methods. There's no per-user
     Interests picker anymore — Home always defaults to the same
     DEFAULT_HOME_CATEGORY ("Funny Videos" / Comedy) for everyone, via the
     cheap videoCategoryId filter on that same call — not a Search API hit. */
  async getHomeFeed(page = 1) {
    const HOME_PAGE_SIZE = effectivePageSize(25);

    const [externalRes, appwriteVideos] = await Promise.all([
      ShortTubeVideoAPI.getHomeVideos({ page, category: DEFAULT_HOME_CATEGORY })
        .then(data => {
          lastFeedSourceErrors = data?.sourceErrors || null;
          if (data?.sourceErrors) console.error('[ShortTube] getHomeVideos source errors (this is almost always why videos are missing):', data.sourceErrors);
          return data;
        })
        .catch((err) => { console.error('[ShortTube] getHomeVideos failed:', err); return { videos: [] }; }),
      // Infinite Scroll fix: page>1 must fetch the NEXT batch of uploads via
      // offset, not silently refetch the same first 25 every time — otherwise
      // "loading more" would show duplicates of what's already on screen.
      this.fetchAppwriteVideos(HOME_PAGE_SIZE, (page - 1) * HOME_PAGE_SIZE)
    ]);

    console.log('[ShortTube] getHomeFeed results:', { external: externalRes, appwriteCount: appwriteVideos.length });

    // Defensive: externalRes.videos could be missing/undefined if the API
    // call returned an unexpected shape.
    const externalVideos = Array.isArray(externalRes?.videos) ? externalRes.videos : [];
    // Categorization: apply the SAME short/long rule to every source, so a
    // sub-3-minute YouTube clip can't leak into the long-form
    // Home feed any more than a short Appwrite upload can.
    const longExternal = externalVideos.filter(v => !isShortForm(v));
    const longUploads = appwriteVideos.filter(v => !isShortForm(v));
    const merged = this.shuffle([...longExternal, ...longUploads]);
    return merged; // Unity interstitial pacing happens in renderFeedItems()/observeShortsPlayback(), not here
  },

  /* ---------------- SEARCH ----------------
     The ONLY path in this app that hits YouTube's Search API (100 quota
     units/call), via the fully separate ShortTubeVideoAPI.getSearchVideos()
     method — never mixed with the Home code path. Must only be called on
     an explicit user action (Enter / Search submit) — never on every
     keystroke. See index.html's search overlay wiring: the old
     per-keystroke debounce call was removed. */
  async getSearchResults(query, page = 1) {
    if (!query || !query.trim()) return [];
    const res = await ShortTubeVideoAPI.getSearchVideos({ query, page })
      .then(data => {
        lastFeedSourceErrors = data?.sourceErrors || null;
        if (data?.sourceErrors) console.error('[ShortTube] getSearchVideos source errors:', data.sourceErrors);
        return data;
      })
      .catch((err) => { console.error('[ShortTube] search failed:', err); return { videos: [] }; });
    const externalVideos = Array.isArray(res?.videos) ? res.videos : [];
    return this.shuffle(externalVideos);
  },

  /* ---------------- IMAGES (Home tab) ----------------
     User-uploaded photos, PLUS user-uploaded short videos woven in at a
     fixed ratio (one video per five images) — see getImagesFeed() below.
     Same moderation/ownership pattern as fetchAppwriteVideos(). */
  async fetchAppwriteImages(limit = 25, offset = 0) {
    let res;
    try {
      res = await databases.listDocuments(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.IMAGES,
        [Query.orderDesc('$createdAt'), Query.limit(limit), Query.offset(offset)]
      );
    } catch (err) {
      console.error('[ShortTube] listDocuments (images) FAILED:', err);
      return [];
    }
    const documents = Array.isArray(res?.documents) ? res.documents : [];
    if (documents.length === 0) return [];

    const clean = documents.filter(d => d.moderationStatus !== 'removed' && d.moderationStatus !== 'pending');

    return Promise.all(clean.map(async (doc) => {
      const ownerName = await this._getCachedOwnerName(doc.ownerId);
      return {
        id: doc.$id,
        source: 'appwrite',
        caption: doc.caption,
        ownerName,
        ownerId: doc.ownerId,
        imageUrl: storage.getFileView(APPWRITE_CONFIG.BUCKETS.IMAGE_FILES, doc.imageFileId).href,
        uploadedAt: doc.createdAt || doc.$createdAt,
        _raw: doc
      };
    }));
  },

  /* ---------------- Short-form uploads for the Images feed ----------------
     Reuses fetchAppwriteVideos() (so moderation filtering + ranking stay
     identical) and keeps only the short-form ones. IMPORTANT: this pulls
     exclusively from the Appwrite `videos` collection — i.e. content the
     user themselves manually uploaded. YouTube is never a source here,
     so no YouTube-sourced "Short" can ever appear mixed in with photos. */
  async fetchAppwriteShortVideos(limit, offset) {
    const videos = await this.fetchAppwriteVideos(limit, offset);
    return videos.filter(v => isShortForm(v) && v.source === 'appwrite');
  },

  // One uploaded short video for every five photos. Ratio is applied within
  // each page of results, so it holds up consistently as the feed scrolls,
  // not just on the very first load.
  IMAGE_TO_SHORT_RATIO: 5,

  async getImagesFeed(page = 1) {
    const IMAGES_PAGE_SIZE = effectivePageSize(25);
    const images = await this.fetchAppwriteImages(IMAGES_PAGE_SIZE, (page - 1) * IMAGES_PAGE_SIZE);
    if (!images.length) return images;

    const shortsWanted = Math.max(1, Math.floor(images.length / this.IMAGE_TO_SHORT_RATIO));
    // Separate offset "space" for shorts so each page pulls in the NEXT
    // batch instead of re-showing the same handful of videos every time.
    const shortsOffset = (page - 1) * shortsWanted;
    const shortVideos = (await this.fetchAppwriteShortVideos(shortsWanted, shortsOffset))
      .map(v => ({ ...v, feedItemType: 'video' }));

    if (!shortVideos.length) return images;

    // Weave in one video after every 5th image.
    const merged = [];
    let vIdx = 0;
    images.forEach((img, i) => {
      merged.push(img);
      if ((i + 1) % this.IMAGE_TO_SHORT_RATIO === 0 && vIdx < shortVideos.length) {
        merged.push(shortVideos[vIdx++]);
      }
    });
    // Any leftover shorts (fewer than 5 images on this page) still show up
    // at the end, rather than being silently dropped.
    while (vIdx < shortVideos.length) merged.push(shortVideos[vIdx++]);
    return merged;
  },

  async refreshHome() {
    if (typeof window.renderHomeFeedFromData === 'function') {
      const data = await this.getHomeFeed();
      window.renderHomeFeedFromData(data);
    }
  }
};

window.ShortTubeFeed = ShortTubeFeed;
window.getLastFeedSourceErrors = () => lastFeedSourceErrors;
