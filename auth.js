/* =====================================================================
   auth.js — Appwrite authentication
   ---------------------------------------------------------------------
   Two layers of identity, both credential-free:
     1. ANONYMOUS (initSession, on every app boot) — no email, no password,
        no OAuth screen, nothing typed. This is what makes browsing, liking,
        commenting, and following available immediately with zero login UI.
     2. REAL / CHANNEL (loginWithGoogle, via "Create Channel") — the app's
        only sign-in method is "Continue with Google", via Appwrite's
        OAuth2 session. There's no phone/email/password form anywhere.
        Google handles the credential check; if the person is already
        signed into Google on their device, this typically completes with
        a single tap. Tapping it while an anonymous session is already
        active upgrades that same account in place (see loginWithGoogle()).

   How it works (Appwrite Web SDK):
     1. loginWithGoogle() calls account.createOAuth2Session('google', ...),
        which does a full browser redirect to Google's consent screen.
     2. Google redirects back to `successUrl` (this same page) once the
        person approves, with the Appwrite session cookie already set.
     3. On reload, refreshAuthUI() (app.js) calls getCurrentUser() and
        finds the new session automatically — no extra "verify" step.

   NOTE: Google blocks OAuth consent screens from loading inside a bare
   embedded WebView (shows "disallowed_useragent"). If ShortTube's Android
   wrapper uses a plain WebView, route it through Chrome Custom Tabs (or an
   equivalent system-browser tab) so this redirect can complete — that's a
   change to the native shell, not to this file.

   Session rules (Appwrite Console > Auth):
     - 30-day session length -> Auth > Session Length (project-level
       Console setting; not something the Web SDK can override per-call)
     - Max 4 concurrent sessions -> Auth > Session Limit
     - Google OAuth2 provider must be enabled + configured with a Client
       ID/Secret under Auth > Settings > OAuth2 Providers > Google
===================================================================== */

const ShortTubeAuth = {

  /* ---------------- Auto-init identity (no login screen on launch) ----------------
     Called once on app boot (see app.js). Guarantees the app ALWAYS has a
     session to work with — a real one if a cookie/token from a previous
     visit still exists, or a brand-new anonymous one otherwise — so nobody
     ever sees a sign-in screen just to open the app.

     Appwrite's Anonymous Sessions are exactly the primitive for this: no
     email, no password, no OAuth redirect, just a session tied to this
     browser/app install (docs: "Use this endpoint to allow a new user to
     register an anonymous account... To allow the new user to convert an
     anonymous account to a normal account, you need to update its email and
     password or create an OAuth2 session."). That second half — converting,
     not replacing — is what makes "Create Channel" a true upgrade instead of
     a second, disconnected identity: see loginWithGoogle() below. */
  async initSession() {
    let me = await this.getCurrentUser();
    if (me) return me; // real or anonymous session already active — nothing to do
    try {
      await account.createAnonymousSession();
      return await this.getCurrentUser();
    } catch (err) {
      // Anonymous sessions can fail if third-party cookies are fully blocked
      // in an embedded WebView with no app-scheme cookie jar configured, or
      // if the "Anonymous" auth method is disabled in Auth > Settings in the
      // Appwrite Console. The app must still boot as a guest either way —
      // browsing/feed code doesn't require a session at all, only
      // like/comment/upload do (gated by requireAuth() in app.js).
      console.warn('[ShortTube] Could not start anonymous session, continuing as guest:', err);
      return null;
    }
  },

  // True for a session created by initSession() that has never been
  // upgraded to a real identity. Appwrite anonymous accounts always have an
  // empty email — that's the reliable signal (there's no separate "isAnon"
  // flag on the user object).
  isAnonymous(user) {
    return !!user && !user.email;
  },

  /* ---------------- Google OAuth2 ----------------
     Two jobs depending on when it's called:
     1. No active session (or the person tapped the plain "Log In" button):
        behaves like a normal sign-in — a fresh Google identity.
     2. An anonymous session IS active (the common case now, since everyone
        gets one automatically on launch) and this is called from the
        "Create Channel" flow: per Appwrite's documented behavior, "If there
        is already an active session, the new session will be attached to
        the logged-in account" — so this UPGRADES the existing anonymous
        account in place rather than creating a disconnected second one.
        Their likes/watch history/comments made while anonymous carry over
        for free, because it's still the same account ID underneath.
     Either way this triggers a full-page redirect to Google and back; both
     successUrl and failureUrl point back at this same page, so on return
     app.js's refreshAuthUI() just picks up whatever session state exists.

     ANDROID/WEBVIEW NOTE: linking an anonymous session through an OAuth2
     redirect depends on Appwrite's session cookie surviving the redirect
     round-trip. That's reliable in a real browser tab, but has had known
     rough edges inside bare embedded WebViews (see Appwrite SDK issue
     trackers). Route this through Chrome Custom Tabs / an in-app browser
     tab (not a raw WebView) in the Android/Amazon build, and test the
     anonymous → Google upgrade specifically in that packaged build before
     shipping — don't assume parity with the desktop browser behavior. */
  loginWithGoogle() {
    const returnUrl = window.location.origin + window.location.pathname;
    return account.createOAuth2Session('google', returnUrl, returnUrl, ['profile', 'email']);
  },

  /* ---------------- Session helpers ---------------- */
  async getCurrentUser() {
    try { return await account.get(); }
    catch (err) { return null; } // not logged in
  },

  async listActiveSessions() {
    return account.listSessions(); // useful for a "Manage devices" settings screen
  },

  async logout() {
    return account.deleteSession('current');
  },

  async logoutEverywhere() {
    return account.deleteSessions();
  }
};

/* Creates the user's profile document the first time they sign up.
   Exported on window so profile.js can also call it defensively (self-healing
   for any account — old or new — that somehow still has no profile doc). */
async function ensureProfileDocument(userId, displayName) {
  try {
    await databases.getDocument(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, userId);
  } catch (err) {
    // No profile yet — create one. Document ID = user ID keeps a 1:1 mapping.
    await databases.createDocument(
      APPWRITE_CONFIG.DATABASE_ID,
      APPWRITE_CONFIG.COLLECTIONS.PROFILES,
      userId,
      { displayName: displayName || "New User", avatarFileId: null, bio: "" },
      [Permission.read(Role.any()), Permission.update(Role.user(userId))]
    );
  }
}
window.ensureProfileDocument = ensureProfileDocument;

window.ShortTubeAuth = ShortTubeAuth;
