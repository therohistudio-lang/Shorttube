/* =====================================================================
   appwrite-config.js — Single shared Appwrite client
   ---------------------------------------------------------------------
   Your real Appwrite Endpoint + Project ID are inserted below. These are
   meant to be public (Appwrite enforces security via per-collection
   permissions, not by hiding this ID) — safe to ship in client code.
===================================================================== */

// REQUIRED for seamless auto-login (js/auth.js initSession()): enable
// "Anonymous" under Auth > Settings > Auth Methods in the Appwrite Console
// for this project. Without it, account.createAnonymousSession() will
// fail on every launch and the app falls back to showing a manual
// "Log In / Sign Up" button instead of auto-creating a guest session.
const APPWRITE_CONFIG = {
  ENDPOINT: "https://fra.cloud.appwrite.io/v1",
  PROJECT_ID: "shorttube",

  // ---- Google One Tap (silent sign-in detection) ----
  // Web OAuth Client ID from Google Cloud Console > APIs & Services >
  // Credentials > "OAuth 2.0 Client IDs" (type: Web application). This is
  // DIFFERENT from the Google OAuth provider config inside Appwrite's
  // Console (Auth > Settings > OAuth2 Providers) — that one is used for the
  // full-redirect "Continue with Google" button/Create Channel flow. This
  // one is used only by js/google-onetap.js for the silent detection prompt.
  // See SETUP_GOOGLE_ONETAP.md for full setup steps.
  GOOGLE_CLIENT_ID: "PASTE_YOUR_GOOGLE_WEB_CLIENT_ID_HERE.apps.googleusercontent.com",

  // ID of the Appwrite Function that verifies the Google ID token returned
  // by One Tap and mints an Appwrite session token for it server-side (see
  // /functions/verify-google-token and SETUP_GOOGLE_ONETAP.md).
  FUNCTIONS: {
    VERIFY_GOOGLE_TOKEN: "verify-google-token"
  },

  DATABASE_ID: "6a69384d083784998fb2",
  COLLECTIONS: {
    PROFILES: "profiles",
    VIDEOS: "videos",
    IMAGES: "images",
    LIKES: "likes",
    COMMENTS: "comments",
    FOLLOWS: "follows",
    WATCH_EVENTS: "watch_events",
    REPORTS: "reports",
    CONVERSATIONS: "conversations",
    MESSAGES: "messages"
  },
  BUCKETS: {
    AVATARS: "avatars",
    BANNERS: "banners",
    VIDEO_THUMBS: "thumbnails",
    VIDEO_FILES: "videos",
    IMAGE_FILES: "images"
  }
};

// NOTE: you still need to create the database, collections, and buckets
// above inside your Appwrite Console with these exact IDs — see
// APPWRITE_SETUP.md for the click-by-click steps. The config here just
// tells your app WHERE to look; it doesn't create anything by itself.
//
// NEW FOR THE PROFILE BANNER FEATURE: create the "banners" bucket (same
// permission model as "avatars" — read: any, write: the owning user) and
// add a `bannerFileId` string attribute (optional) to the PROFILES
// collection. Everything degrades gracefully if you skip this — profile.js
// just falls back to the brand-gradient banner when the field is empty.
//
// NEW FOR PRIVATE MESSAGING (js/messaging.js): create two collections —
//   "conversations": userAId (string), userBId (string), lastMessage
//     (string), lastMessageAt (datetime), createdAt (datetime).
//     Permissions: read/update restricted to Role.user(userAId) and
//     Role.user(userBId) at document-create time (see messaging.js).
//   "messages": conversationId (string, indexed), senderId (string),
//     recipientId (string), text (string), createdAt (datetime).
//     Permissions: read restricted to sender+recipient; create by any
//     authenticated user for their own senderId.
// Everything degrades to a friendly empty state if these aren't created
// yet — messaging.js never throws past the UI layer.

const { Client, Account, Databases, Storage, Functions, ID, Query, Permission, Role } = Appwrite;

const client = new Client()
  .setEndpoint(APPWRITE_CONFIG.ENDPOINT)
  .setProject(APPWRITE_CONFIG.PROJECT_ID);

const account = new Account(client);
const databases = new Databases(client);
const storage = new Storage(client);
const functionsClient = new Functions(client); // used by js/google-onetap.js to exchange a Google ID token for an Appwrite session
