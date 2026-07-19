# Setup: automatic sign-in, Create Channel, and auto-moderation

This covers the three things added on top of the existing app:

1. **Automatic Google account detection for viewers** (Google One Tap)
2. **Create Channel flow** — only triggered by Upload, auto-creates the
   channel/profile from the person's Google info
3. **Automatic explicit-content detection + instant removal** (server-side
   Appwrite Function using Google Cloud Vision SafeSearch)

Nothing here changes how the app behaves for a guest who's just browsing —
that already worked with zero login (see `requireAuth()` in `js/app.js`).
These changes are about *how fast* a returning visitor gets recognized, and
about giving Upload its own framing instead of a generic "Log In" wall.

---

## 1. Google One Tap (automatic detection)

**What it does:** on page load, if the visitor is already signed into a
Google account in that browser and has used ShortTube before, they're
signed in with no tap at all. First-time visitors see Google's own small
"Sign in as ___" chip in the corner — one tap, nothing typed.

**Why it can't be fully invisible:** no browser lets a website log someone
in with *zero* prompt ever, on any visit — that would let any site quietly
fingerprint a visitor, so Chrome/Safari/Firefox all block it. One Tap is
the same mechanism YouTube and most large Google-integrated sites use for
exactly this "auto-detect the device account" behavior; it's the closest
thing the web platform allows.

**Setup steps:**
1. Google Cloud Console → APIs & Services → Credentials → **Create
   Credentials → OAuth client ID** → Application type: **Web application**.
   - Add your production domain(s) under "Authorized JavaScript origins"
     (e.g. `https://yourapp.com`).
2. Copy the Client ID into `js/appwrite-config.js` →
   `APPWRITE_CONFIG.GOOGLE_CLIENT_ID`.
3. Deploy the `verify-google-token` function (step 3 below) — One Tap
   won't do anything until that's live, but nothing breaks in the
   meantime; the app just behaves exactly like before.

This is separate from the Google OAuth2 provider you already configured
inside **Appwrite Console → Auth → Settings → OAuth2 Providers → Google**
for the manual "Continue with Google" button — keep both configured.

---

## 2. Create Channel flow (Upload only)

No code changes needed from you here — this is already wired in
`js/app.js`:

- Every action that needs an identity (Like, Comment, Follow, Message)
  still opens the same sheet, titled **"Log In."**
- Tapping **Upload** opens the *same sheet* but retitled **"Create
  Channel,"** with copy explaining a channel will be set up automatically,
  and a button that just says **"Continue."**
- After Google auth completes, `ensureProfileDocument()` creates the
  profile/channel doc automatically from the Google account's name — no
  form. If the sheet was opened from Upload, the app then reopens the
  upload chooser automatically, so "Continue" really does lead straight
  into uploading.

---

## 3. Automatic explicit-content detection + removal

**What it does:** the moment a photo, or a video's auto-captured thumbnail
frame, lands in Storage, an Appwrite Function sends it to Google Cloud
Vision's SafeSearch model. Anything adult/violent/racy gets deleted —
storage file and database doc both — within moments, with no human review
step.

**Scope limit, stated plainly:** SafeSearch only ever sees one still frame
per video (the thumbnail). It cannot scan an entire video's frames or
audio. Full-video coverage needs Google's **Video Intelligence API**
(frame-sampling across the whole clip) added as a second check — the
function is structured so that's a later drop-in, not a rewrite.

**Setup steps:**
1. Google Cloud Console → enable the **Cloud Vision API** on your project,
   then create an API key (restrict it to the Vision API).
2. Appwrite Console → **Functions → Create Function**:
   - Runtime: Node.js 18+ (or newer)
   - Upload the `functions/moderate-content` folder as the deployment
     (or connect it via Git — either way, `npm install` runs automatically
     from its `package.json`).
   - **Settings → Events**, add:
     - `buckets.<IMAGE_FILES_BUCKET_ID>.files.*.create`
     - `buckets.<VIDEO_THUMBS_BUCKET_ID>.files.*.create`
     (bucket IDs come from `APPWRITE_CONFIG.BUCKETS` in
     `js/appwrite-config.js` — `"images"` and `"thumbnails"` by default)
   - **Settings → Variables**, add:
     - `APPWRITE_API_KEY` — a server API key (Console → Overview → API
       Keys) with `databases.read`, `databases.write`, `storage.read`,
       `storage.write` scopes
     - `GOOGLE_VISION_API_KEY` — the key from step 1
3. Deploy the `verify-google-token` function the same way (needed for
   Google One Tap, section 1):
   - **Settings → Variables**: `GOOGLE_CLIENT_ID` (same value as
     `APPWRITE_CONFIG.GOOGLE_CLIENT_ID`), plus the same `APPWRITE_API_KEY`
     as above but with `users.read` + `users.write` scopes instead
     (a single key with all five scopes works fine for both functions).
   - This one is called directly by the client (`functionsClient.
     createExecution(...)` in `js/google-onetap.js`), not by an event —
     no Events setting needed for it, just make sure **Execute Access**
     permits `any` (or at least guests) so a signed-out visitor can call it.

Once both functions are deployed and their env vars are set, uploads are
covered automatically — nothing else in the app needs to change.
