/* =====================================================================
   video-api.js — Direct client-side YouTube calls
   ---------------------------------------------------------------------
   STANDALONE APP VERSION: this replaces the old Netlify serverless
   functions (netlify/functions/feed.js + related.js). ShortTube is now
   a WebView-based Android app with no server of its own, so these calls
   run directly from the device instead of from a Netlify backend.

   Dailymotion has been fully removed (API calls, key, mapping, and UI
   labels) — ShortTube now mixes only YouTube videos with Appwrite
   user uploads. See feed.js for how the two are merged.

   >>> SECURITY NOTE — READ BEFORE SHIPPING <<<
   The YouTube key below is bundled inside the APK. Any APK can be
   unzipped/decompiled with free tools, so this key IS visible to
   anyone who pulls the app apart — that is unavoidable once there is
   no server to hide it behind. To limit the damage, BEFORE you publish:

     1. Rotate the key. The value below (and any earlier version of
        this file) may already have been shared/committed somewhere,
        so treat it as burned and generate a fresh one in Google Cloud
        Console → APIs & Services → Credentials.
     2. Restrict the new key to ONLY the "YouTube Data API v3" under
        "API restrictions" — this stops it from being reusable against
        any other Google API even if someone extracts it.
     3. Add an Application restriction of type "Android apps" once you
        have a signing key: this ties the key to your app's package
        name (com.shorttube.app) + SHA-1 signing certificate
        fingerprint, so the key stops working if copied into a
        different APK. (Note: Google enforces this for the Android
        restriction type on API calls made through Google's Android
        SDKs; for plain HTTPS calls like the ones below, treat the
        Android restriction as a deterrent + audit trail, not a hard
        technical wall — real protection comes from tracking usage in
        Cloud Console and rotating fast if you see abuse.)
     4. Set a daily quota cap on the key (Cloud Console → Quotas) so a
        leaked/abused key can't run up an unexpected bill or get the
        whole project suspended.
     5. Watch Cloud Console → APIs & Services → Credentials/Metrics
        periodically after launch for traffic spikes that don't match
        your real users — that's the main sign of a scraped key being
        reused elsewhere.

   Quota-saving split (unchanged):
     mode=home   -> videos.list (chart=mostPopular), 1 quota unit/call
     mode=search -> search.list, 100 quota units/call, ONLY on explicit
                    user search submit.
===================================================================== */

const YOUTUBE_API_KEY = "AIzaSyDzMS8WHuydcevIr_nFJ3G3RFDWhC3tNKQ"; // TODO: rotate before publishing — see notes above

const YOUTUBE_CATEGORY_MAP = {
  music: "10", gaming: "20", comedy: "23", tech: "28",
  sports: "17", vlogs: "22", cooking: "26", news: "25"
};

function vaShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseISODuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const hours = parseInt(m[1] || 0, 10);
  const mins = parseInt(m[2] || 0, 10);
  const secs = parseInt(m[3] || 0, 10);
  return hours * 3600 + mins * 60 + secs;
}

function mapYouTubeItem(item, id) {
  return {
    id,
    source: "youtube",
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`,
    channel: item.snippet.channelTitle,
    duration: parseISODuration(item.contentDetails?.duration),
    viewCount: parseInt(item.statistics?.viewCount || 0, 10),
    uploadedAt: item.snippet.publishedAt || null
  };
}

async function ytGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try { const errBody = await res.json(); detail = errBody?.error?.message || ''; } catch {}
    throw new Error(`YouTube API error: ${res.status}${detail ? ' — ' + detail : ''}`);
  }
  return res.json();
}

async function fetchYouTubeHome(page = 1, category = null) {
  let url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics` +
    `&chart=mostPopular&regionCode=PK&maxResults=25&key=${YOUTUBE_API_KEY}`;
  if (category && YOUTUBE_CATEGORY_MAP[category]) url += `&videoCategoryId=${YOUTUBE_CATEGORY_MAP[category]}`;
  const data = await ytGet(url);
  const items = data.items || [];
  return { nextPageToken: data.nextPageToken || null, items: items.map(item => mapYouTubeItem(item, item.id)) };
}

async function fetchYouTubeSearch(query, pageToken = "") {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12` +
    `&q=${encodeURIComponent(query)}&pageToken=${pageToken}&key=${YOUTUBE_API_KEY}`;
  const searchData = await ytGet(searchUrl);
  const items = searchData.items || [];
  const videoIds = items.map(item => item.id.videoId).filter(Boolean);

  let detailsById = {};
  if (videoIds.length) {
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics` +
      `&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`;
    try {
      const detailsData = await ytGet(detailsUrl);
      (detailsData.items || []).forEach(d => { detailsById[d.id] = d; });
    } catch { /* still return videos below with duration:0 / viewCount:0 */ }
  }

  return {
    nextPageToken: searchData.nextPageToken || null,
    items: items.map(item => {
      const id = item.id.videoId;
      const details = detailsById[id];
      return mapYouTubeItem({ snippet: item.snippet, contentDetails: details?.contentDetails, statistics: details?.statistics }, id);
    })
  };
}

async function fetchYouTubeRelated(query) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8` +
    `&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
  const data = await ytGet(url);
  return (data.items || []).map(item => ({
    id: item.id.videoId,
    source: "youtube",
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    embedUrl: `https://www.youtube.com/embed/${item.id.videoId}?autoplay=1&rel=0`,
    channel: item.snippet.channelTitle
  }));
}

/* ---------------- In-memory cache (per app session, 15 min TTL) ----------------
   Same purpose as the old Netlify warm-container cache: cuts down repeat
   calls to YouTube within a short window. This resets when the app
   process is killed, which is fine — it's a quota-saver only. */
const CACHE_TTL_MS = 15 * 60 * 1000;
const vaCache = new Map();
function getCached(key) {
  const hit = vaCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) { vaCache.delete(key); return null; }
  return hit.body;
}
function setCached(key, body) {
  vaCache.set(key, { body, time: Date.now() });
  if (vaCache.size > 200) vaCache.delete(vaCache.keys().next().value);
}

/* ---------------- Public API (mirrors the old /api/feed & /api/related shapes) ----------------
   Home and Search are now two fully separate public methods (instead of a
   single getFeed({mode}) dispatcher). They call different YouTube
   endpoints, take different params, and previously shared one function's
   cache-key/error-handling logic — a mistake in one mode's params (e.g. a
   stray `category` or `pageToken` meant for the other) could silently
   affect both. Splitting them removes that shared surface area entirely. */
const ShortTubeVideoAPI = {
  // HOME feed only. Hits videos.list?chart=mostPopular (1 quota unit).
  async getHomeVideos({ page = 1, category = null } = {}) {
    const cacheKey = `home:${page}:${category || ''}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const [ytResult] = await Promise.allSettled([fetchYouTubeHome(page, category)]);
    const yt = ytResult.status === 'fulfilled' ? ytResult.value : { items: [], nextPageToken: null };
    const sourceErrors = {};
    if (ytResult.status === 'rejected') sourceErrors.youtube = ytResult.reason?.message || String(ytResult.reason);

    const result = {
      videos: vaShuffle([...yt.items]).filter(v => v.title && v.thumbnail),
      nextPageToken: yt.nextPageToken,
      page,
      mode: 'home',
      ...(Object.keys(sourceErrors).length ? { sourceErrors } : {})
    };
    if (result.videos.length > 0) setCached(cacheKey, result);
    return result;
  },

  // SEARCH only. Hits search.list (100 quota units) — only ever called on
  // an explicit user search submit, never on every keystroke.
  async getSearchVideos({ query = '', page = 1, pageToken = '' } = {}) {
    if (!query || !query.trim()) return { videos: [], nextPageToken: null, page, mode: 'search' };
    const cacheKey = `search:${query}:${page}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const [ytResult] = await Promise.allSettled([fetchYouTubeSearch(query, pageToken)]);
    const yt = ytResult.status === 'fulfilled' ? ytResult.value : { items: [], nextPageToken: null };
    const sourceErrors = {};
    if (ytResult.status === 'rejected') sourceErrors.youtube = ytResult.reason?.message || String(ytResult.reason);

    const result = {
      videos: vaShuffle([...yt.items]).filter(v => v.title && v.thumbnail),
      nextPageToken: yt.nextPageToken,
      page,
      mode: 'search',
      ...(Object.keys(sourceErrors).length ? { sourceErrors } : {})
    };
    if (result.videos.length > 0) setCached(cacheKey, result);
    return result;
  },

  async getRelated(title) {
    try {
      const yt = await fetchYouTubeRelated(title);
      return { videos: vaShuffle([...yt]).slice(0, 10) };
    } catch (err) {
      console.error('[ShortTube] getRelated failed:', err);
      return { videos: [] };
    }
  }
};

window.ShortTubeVideoAPI = ShortTubeVideoAPI;
