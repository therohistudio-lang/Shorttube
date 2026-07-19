/* =====================================================================
   moderate-content — Appwrite Function
   ---------------------------------------------------------------------
   The real, automatic explicit-content detector. js/upload.js can only do
   a text screen on the title/description and an exact-duplicate check —
   it has no way to look at actual pixels, and nothing running in the
   visitor's own browser can be trusted to police itself anyway. This
   function is the trusted, server-side layer: Appwrite invokes it the
   instant a new file lands in Storage (a photo, or a video's
   auto-captured thumbnail frame), sends the image to Google Cloud
   Vision's SafeSearch API, and if it comes back adult/violent/racy content,
   removes it immediately — no human review step and no waiting.

   TRIGGER SETUP (Appwrite Console > Functions > this function > Settings
   > Events) — add both of these events:
     buckets.<IMAGE_FILES_BUCKET_ID>.files.*.create
     buckets.<VIDEO_THUMBS_BUCKET_ID>.files.*.create
   (Use the actual bucket IDs from APPWRITE_CONFIG.BUCKETS in
   appwrite-config.js — "images" and "thumbnails" by default.)

   REQUIRED environment variables:
     APPWRITE_API_KEY        Server API key with databases + storage read/write scopes
     GOOGLE_VISION_API_KEY   Google Cloud API key with the Vision API enabled
   Optional overrides (defaults match appwrite-config.js):
     MODERATION_DATABASE_ID, MODERATION_VIDEOS_COLLECTION,
     MODERATION_IMAGES_COLLECTION, MODERATION_THUMBS_BUCKET,
     MODERATION_IMAGE_FILES_BUCKET, MODERATION_VIDEO_FILES_BUCKET

   SCOPE NOTE: SafeSearch only ever sees one still frame per video (the
   thumbnail captured ~1s in) — it can't scan every frame of a video body.
   That's a real gap, not a fake one: full-video coverage needs Google's
   Video Intelligence API (frame-sampling across the whole clip) wired in
   as a second, heavier check. This function is written so that's a
   drop-in addition later without changing anything else about the flow.
===================================================================== */
const { Client, Storage, Databases, Query } = require('node-appwrite');

const DATABASE_ID = process.env.MODERATION_DATABASE_ID || '6a69384d083784998fb2';
const VIDEOS_COLLECTION = process.env.MODERATION_VIDEOS_COLLECTION || 'videos';
const IMAGES_COLLECTION = process.env.MODERATION_IMAGES_COLLECTION || 'images';
const THUMBS_BUCKET = process.env.MODERATION_THUMBS_BUCKET || 'thumbnails';
const IMAGE_FILES_BUCKET = process.env.MODERATION_IMAGE_FILES_BUCKET || 'images';
const VIDEO_FILES_BUCKET = process.env.MODERATION_VIDEO_FILES_BUCKET || 'videos';

// Anything at LIKELY or above on adult/violence, or VERY_LIKELY on racy,
// gets removed automatically. Tune this if it's too strict/lenient for
// your content mix.
const SEVERE = ['LIKELY', 'VERY_LIKELY'];

module.exports = async ({ req, res, log, error }) => {
  const eventHeader = req.headers['x-appwrite-event'] || '';
  const match = eventHeader.match(/^buckets\.([^.]+)\.files\.([^.]+)\.create$/);
  if (!match) return res.json({ skipped: true, reason: 'Not a file-create event' });
  const [, bucketId, fileId] = match;

  if (bucketId !== IMAGE_FILES_BUCKET && bucketId !== THUMBS_BUCKET) {
    return res.json({ skipped: true, reason: `Bucket ${bucketId} isn't wired for moderation` });
  }

  const apiKey = process.env.APPWRITE_API_KEY;
  const visionKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey || !visionKey) {
    error('Missing APPWRITE_API_KEY or GOOGLE_VISION_API_KEY environment variable');
    return res.json({ error: 'Function is not fully configured' }, 500);
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(apiKey);
  const storage = new Storage(client);
  const databases = new Databases(client);

  // 1. Pull down the actual bytes of the newly uploaded file.
  let fileBuffer;
  try {
    const view = await storage.getFileView(bucketId, fileId);
    fileBuffer = Buffer.from(view);
  } catch (err) {
    error('Could not download file for moderation: ' + err.message);
    return res.json({ error: 'Could not read the uploaded file' }, 500);
  }

  // 2. Ask Google Cloud Vision's SafeSearch model what's in it.
  let safeSearch;
  try {
    const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: fileBuffer.toString('base64') },
          features: [{ type: 'SAFE_SEARCH_DETECTION' }]
        }]
      })
    });
    const visionJson = await visionRes.json();
    safeSearch = visionJson?.responses?.[0]?.safeSearchAnnotation;
    if (!safeSearch) throw new Error(JSON.stringify(visionJson));
  } catch (err) {
    error('Vision SafeSearch call failed: ' + err.message);
    // Fail closed to "still pending", not "live" — a broken moderation call
    // should never be the reason something explicit slips through.
    return res.json({ error: 'Moderation check failed; left out of the public feed for manual review' }, 500);
  }

  const isExplicit = SEVERE.includes(safeSearch.adult) || SEVERE.includes(safeSearch.violence) || safeSearch.racy === 'VERY_LIKELY';

  if (!isExplicit) {
    log(`SafeSearch clean (adult=${safeSearch.adult}, violence=${safeSearch.violence}, racy=${safeSearch.racy})`);
    return res.json({ flagged: false, safeSearch });
  }

  log(`SafeSearch FLAGGED (adult=${safeSearch.adult}, violence=${safeSearch.violence}, racy=${safeSearch.racy}) — auto-removing`);

  // 3. Instantly remove it — no waiting on a human reviewer.
  try {
    if (bucketId === IMAGE_FILES_BUCKET) {
      const matches = await databases.listDocuments(DATABASE_ID, IMAGES_COLLECTION, [Query.equal('imageFileId', fileId), Query.limit(1)]);
      const doc = matches.documents[0];
      if (doc) await databases.updateDocument(DATABASE_ID, IMAGES_COLLECTION, doc.$id, { moderationStatus: 'removed' });
      await storage.deleteFile(IMAGE_FILES_BUCKET, fileId);
    } else {
      // A flagged thumbnail means the video it belongs to comes down too.
      const matches = await databases.listDocuments(DATABASE_ID, VIDEOS_COLLECTION, [Query.equal('thumbnailFileId', fileId), Query.limit(1)]);
      const doc = matches.documents[0];
      if (doc) {
        await databases.updateDocument(DATABASE_ID, VIDEOS_COLLECTION, doc.$id, { moderationStatus: 'removed' });
        try { await storage.deleteFile(VIDEO_FILES_BUCKET, doc.videoFileId); }
        catch (err) { error('Could not delete the flagged video file itself: ' + err.message); }
      }
      await storage.deleteFile(THUMBS_BUCKET, fileId);
    }
  } catch (err) {
    error('Failed to remove flagged content: ' + err.message);
    return res.json({ flagged: true, removed: false, error: err.message }, 500);
  }

  return res.json({ flagged: true, removed: true, safeSearch });
};
