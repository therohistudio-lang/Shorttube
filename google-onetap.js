/* =====================================================================
   google-onetap.js — automatic "device Google account detected" sign-in
   ---------------------------------------------------------------------
   WHAT THIS DOES:
   For a returning viewer who's already signed into a Google account in
   their browser/device AND has previously used ShortTube, this signs them
   in with zero taps — no login sheet, nothing to press. For a first-time
   visitor (or one who hasn't granted before), it shows Google's own small
   "Sign in as ___" chip in the corner of the screen; tapping it is one tap,
   nothing typed. Either way, nobody ever sees a form.

   HONEST LIMITATION — please read before assuming this is invisible:
   No browser allows a website to log a person in *completely* invisibly,
   with no prompt at all, on first use — that would let any site silently
   identify a visitor, so Chrome, Safari, and Firefox all block it. Google's
   "One Tap" (implemented here) is the closest mechanism that exists: it's
   the same one youtube.com, google.com, and most large sites use for this
   exact "auto-detect the signed-in Google account" behavior. `auto_select:
   true` below makes it skip even the chip and sign in immediately for
   anyone who granted before — that's as close to "just start working" as
   the web platform permits. Browsing itself never required any of this;
   guests can already use every feed/player without it (see app.js
   requireAuth()). This only affects how fast a *return* visit gets them
   from anonymous to recognized, and it always degrades to the manual
   "Continue with Google" button in the Log In / Create Channel sheet if
   One Tap can't run (ad blockers, GSI script blocked, embedded WebView,
   third-party cookies fully disabled with no FedCM support, etc).

   SETUP REQUIRED before this does anything:
     1. A Google Cloud "OAuth 2.0 Client ID" (Web application type) pasted
        into APPWRITE_CONFIG.GOOGLE_CLIENT_ID in appwrite-config.js.
     2. The `verify-google-token` Appwrite Function deployed (see
        /functions/verify-google-token and SETUP_GOOGLE_ONETAP.md) — it's
        what verifies the token really came from Google and mints a real
        Appwrite session for it. Until both are configured, this file exits
        immediately and the app behaves exactly as before (manual button
        only) — nothing here is required for the rest of the app to work.
===================================================================== */

// >>> AUTO-PROMPT DISABLED — explicit product requirement: zero login pop-ups,
// ever, for guests. <<<
// Two real bugs made this worth killing outright instead of just tuning:
//   1. This listener's own session check (`getCurrentUser()` below) races
//      against app.js's `initSession()`, which is what actually creates the
//      anonymous session on first load. If this file's DOMContentLoaded
//      handler resolves first, `me` comes back null even though a guest
//      session is about to exist a moment later — and the code below would
//      then call `google.accounts.id.prompt()`, which is a REAL, visible
//      Google UI (a "Sign in as ___" chip, or an immediate silent sign-in
//      for a previously-granted account) popping up over the app.
//   2. Even race-free, `auto_select: true` means a returning user gets
//      signed in via Google with no tap at all the moment this runs — which
//      is exactly the kind of surprise identity-switch the "do not
//      interrupt the guest" requirement rules out.
// GOOGLE_CLIENT_ID is still a placeholder in appwrite-config.js right now,
// which already keeps this from running — this flag is a second, explicit
// guarantee that survives even after that gets filled in later, so nobody
// has to remember to touch this file again to keep it off.
const ONE_TAP_AUTO_PROMPT_ENABLED = false;

window.addEventListener('DOMContentLoaded', async () => {
  if (!ONE_TAP_AUTO_PROMPT_ENABLED) return; // see note above — flip to true only if/when you explicitly want auto sign-in back
  const clientId = APPWRITE_CONFIG.GOOGLE_CLIENT_ID;
  if (!clientId || clientId.startsWith('PASTE_YOUR_')) return; // not configured yet — see setup notes above
  if (!window.google?.accounts?.id) return; // GSI script didn't load (blocked/offline) — manual button still works fine

  let me;
  try { me = await ShortTubeAuth.getCurrentUser(); }
  catch (err) { return; } // network hiccup on load — don't block anything, just skip the prompt this time
  if (me) return; // already signed in, nothing to detect

  try {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: handleOneTapCredential,
      auto_select: true,          // previously-granted visitors sign in with no chip shown at all
      cancel_on_tap_outside: false,
      itp_support: true,          // Safari Intelligent Tracking Prevention compatibility
      use_fedcm_for_prompt: true  // required for Chrome's third-party-cookie-independent identity flow
    });
    google.accounts.id.prompt();  // shows the small "Sign in as ___" chip, or resolves silently if auto-selected
  } catch (err) {
    console.warn('[ShortTube] Google One Tap could not initialize:', err);
  }
});

/* Fires once Google returns a signed credential (a JWT proving which
   Google account this is). We never trust this client-side — it's handed
   straight to the verify-google-token Appwrite Function, which checks the
   signature with Google's own servers before minting a real session. */
async function handleOneTapCredential(response) {
  try {
    const execution = await functionsClient.createExecution(
      APPWRITE_CONFIG.FUNCTIONS.VERIFY_GOOGLE_TOKEN,
      JSON.stringify({ credential: response.credential }),
      false // synchronous execution — the app needs the session token back immediately
    );
    const result = JSON.parse(execution.responseBody || '{}');
    if (!result.userId || !result.secret) {
      throw new Error(result.error || 'verify-google-token did not return a session token');
    }
    await account.createSession(result.userId, result.secret);
    if (typeof refreshAuthUI === 'function') await refreshAuthUI();
  } catch (err) {
    // Fails open, silently — the person is still a fully-functional guest,
    // and "Continue with Google" in the Log In / Create Channel sheet is
    // right there whenever they do want to sign in.
    console.warn('[ShortTube] Google One Tap sign-in did not complete, manual sign-in still available:', err);
  }
}
