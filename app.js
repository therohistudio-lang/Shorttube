/* =====================================================================
   Main app script — wires the 8 modules above into the UI.
===================================================================== */
const state = { searchQuery:"", likes:0, watched:0, commentsGiven:0, currentPlayerVideo:null, commentsByVideo:{} };
function escapeHtml(str){ const d=document.createElement('div'); d.textContent=str||""; return d.innerHTML; }
function debounce(fn, delay=400){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),delay); }; }
function getVideoKey(v){ return `${v.source}:${v.id}`; }

const lazyImgObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      img.src = img.dataset.src;
      img.onload = () => img.classList.add('loaded');
      observer.unobserve(img);
    }
  });
}, { rootMargin: "200px 0px" });
function observeLazyImages(container){ container.querySelectorAll('img[data-src]').forEach(img => lazyImgObserver.observe(img)); }

/* ---------------- Splash + init ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  // IMPORTANT: refreshAuthUI and loadHomeFeed are independent of each other,
  // AND independent of the splash timer. Previously these were awaited
  // sequentially before the splash timer even started, so the splash could
  // sit on screen for 2s+load time. Now both kick off immediately in
  // parallel (each wrapped in its own try/catch so one failing never blocks
  // the other), and the splash is purely time-based: logo shows for exactly
  // 1s, then hides, regardless of load state. The feed's own skeleton
  // loaders take over from there if data isn't ready yet.
  // initSession() is the "seamless auto-login" step: it guarantees a session
  // exists (a returning real one, or a brand-new anonymous one) BEFORE
  // refreshAuthUI reads it, so nobody ever sees a sign-in screen just to
  // open the app — see auth.js for how the anonymous session later upgrades
  // in place when someone taps Create Channel.
  ShortTubeAuth.initSession()
    .then(() => refreshAuthUI())
    .catch(err => console.error('[ShortTube] auto-login/refreshAuthUI failed:', err));
  imagesInitialized = true;
  loadImagesFeed().catch(err => console.error('[ShortTube] initial loadImagesFeed failed:', err));

  setTimeout(() => {
    document.getElementById('splash').classList.add('hide');
  }, 1000);
});

/* ---------------- Onboarding (first launch only) ---------------- */
// Three possible states now, not two:
//   1. Real identity (has an email)   -> full channel: edit profile, log out, etc.
//   2. Anonymous identity (auto-created by initSession(), no email) -> a
//      fully-working guest that can browse/like/comment/follow, but hasn't
//      created a channel yet. currentUser is still set to this, on purpose —
//      that's what lets requireAuth() skip the login screen for those
//      actions (see below). Nothing is written to the profiles collection
//      for a purely anonymous visitor; a profile/channel doc is only ever
//      created once they upgrade via Create Channel.
//   3. No session at all -> initSession() itself failed (offline, or
//      Anonymous auth disabled in the Appwrite Console). Falls back to the
//      old "Log In" entry point so the app still works, just without the
//      zero-tap guest layer.
async function refreshAuthUI(){
  const me = await ShortTubeAuth.getCurrentUser();
  currentUser = me; // cached for requireAuth() so Like/Comment taps don't need a network round trip to check
  const loginBtn = document.getElementById('loginOpenBtn');
  const editBtn = document.getElementById('editProfileBtn');
  const uploadBtn = document.getElementById('uploadOpenBtn');
  const logoutRow = document.getElementById('logoutRow');
  const anon = ShortTubeAuth.isAnonymous(me);

  if (me && !anon){
    loginBtn.style.display = 'none';
    editBtn.style.display = 'inline-flex';
    uploadBtn.style.display = 'inline-flex'; // channel exists — Upload lives here, in Profile, only
    logoutRow.style.display = 'flex';
    // Coming back from the Google OAuth redirect lands here with a session
    // already established — make sure the (now-stale) login/Create Channel
    // sheet isn't still sitting open over the page.
    document.getElementById('loginModal').classList.remove('active');
    await finalizePendingAgeConfirmation(me);
    // The channel/profile doc is created (or confirmed to already exist)
    // right here, automatically, using the Google account info Appwrite
    // already captured during the OAuth handshake — nothing further to fill
    // in. This runs for every real login, not just fresh Create-Channel
    // ones, since ensureProfileDocument() is a no-op for accounts that
    // already have one (including anonymous sessions that just upgraded).
    try {
      await ensureProfileDocument(me.$id, me.name);
    } catch (err) {
      console.error('[ShortTube] ensureProfileDocument failed for user', me.$id, err);
    }
    try {
      await ShortTubeProfile.loadProfile(me.$id, true);
    } catch (err) {
      // A broken/missing profile document should never take down the whole
      // page — log it so it's diagnosable, and fall back to a safe default.
      console.error('[ShortTube] loadProfile failed for user', me.$id, err);
      document.getElementById('profileDisplayName').textContent = me.name || 'ShortTube User';
    }
    resumePendingUploadIfAny();
  } else if (me && anon){
    // Fully-functional guest: liking/commenting/following all just work
    // (requireAuth() treats any currentUser, anonymous or not, as good
    // enough for those). Only uploading routes back through here to upgrade.
    loginBtn.style.display = 'inline-flex';
    loginBtn.textContent = 'Create Channel';
    editBtn.style.display = 'none';
    uploadBtn.style.display = 'none'; // no channel yet — Create Channel first
    logoutRow.style.display = 'none'; // logging out an anonymous session destroys it permanently — no reason to surface that
    document.getElementById('profileDisplayName').textContent = 'Guest';
    document.getElementById('loginModal').classList.remove('active');
  } else {
    loginBtn.style.display = 'inline-flex';
    loginBtn.textContent = 'Log In / Sign Up';
    editBtn.style.display = 'none';
    uploadBtn.style.display = 'none';
    logoutRow.style.display = 'none';
    document.getElementById('profileDisplayName').textContent = 'Guest';
  }
}

/* ---------------- Auth Guard ---------------- */
// Guest Access: browsing/watching videos never requires login (nothing in the
// feed/player code calls this). Everyone else — anonymous or real — always
// has *some* currentUser now thanks to initSession() in the boot sequence,
// so Like/Comment/Follow/Message/Report all just work with zero prompts,
// exactly like the "basic viewing, liking, and interacting are available
// immediately" requirement. The ONLY action that still needs to stop and
// ask is uploading, because a real (non-anonymous) identity is what makes a
// channel a channel — see the isUpload branch below.
let currentUser = null;
// `context` distinguishes the one case that gets its own framing: uploading.
// Upload gets its own "Create Channel" copy instead of a generic "Log In"
// sheet, and remembers the intent to auto-resume once the Google redirect
// completes (see PENDING_UPLOAD_KEY below).
function requireAuth(message, context){
  const isUpload = context === 'upload';
  // Anonymous currentUser is good enough for every action EXCEPT upload.
  if (currentUser && !(isUpload && ShortTubeAuth.isAnonymous(currentUser))) return true;
  if (message) console.log('[ShortTube] Auth guard blocked action:', message);
  document.getElementById('authModalTitle').textContent = isUpload ? 'Create Channel' : 'Log In';
  document.getElementById('authModalSubtext').textContent = isUpload
    ? "You'll need a channel to upload. We'll set one up automatically from your Google account — no forms to fill in, and any likes/comments you've already made carry over."
    : 'Sign in instantly with your Google account. No forms, no passwords.';
  document.getElementById('googleLoginBtnLabel').textContent = isUpload ? 'Continue' : 'Continue with Google';
  document.getElementById('loginModal').dataset.authContext = isUpload ? 'upload' : '';
  showAuthPanel('authPanelGoogle');
  document.getElementById('loginModal').classList.add('active');
  return false;
}

/* ---------------- Guest-first guard for Like/Comment/Follow ----------------
   requireAuth() (above) is for Upload only now — it's the one action that
   genuinely can't work without a real channel, so it's allowed to show the
   modal. Like/Comment/Follow must NEVER show any login UI, per explicit
   product requirement, so they use this instead. If initSession() already
   succeeded at boot (the normal case), currentUser is set and this returns
   instantly. If it somehow didn't (Anonymous Sessions disabled in the
   Appwrite Console, or this exact domain isn't registered under Appwrite >
   Overview > Platforms — the two most common causes of a failed anonymous
   session on a new Netlify domain), this makes one silent retry right at
   the moment of the tap. If that also fails, the action is skipped quietly
   — a console warning explains why for debugging, but the person never
   sees a popup, modal, or "Continue with Google" screen. */
async function ensureGuestSession(actionLabel) {
  if (currentUser) return true;
  try { currentUser = await ShortTubeAuth.initSession(); }
  catch (err) { console.error('[ShortTube] silent guest-session retry failed for "' + actionLabel + '":', err); }
  if (currentUser) return true;
  console.warn('[ShortTube] No guest session available for "' + actionLabel + '" — this means the app could not create an Appwrite anonymous session at all. Check (1) Appwrite Console > Auth > Settings > Anonymous Sessions is ON, and (2) this exact domain is added under Appwrite Console > Overview > Platforms. This is a project-config issue, not a popup — none is shown.');
  return false;
}

/* ---------------- Login / Sign up modal (Google OAuth only) ---------------- */
// This button now does double duty depending on who's tapping it: a first-
// time/no-session visitor sees a plain "Log In", while an anonymous guest
// (the common case) sees "Create Channel" — same modal, same upgrade path
// as tapping Upload, just entered from the profile tab instead.
document.getElementById('loginOpenBtn').addEventListener('click', () => {
  const anon = ShortTubeAuth.isAnonymous(currentUser);
  document.getElementById('authModalTitle').textContent = anon ? 'Create Channel' : 'Log In';
  document.getElementById('authModalSubtext').textContent = anon
    ? "Set up your channel — we'll create it from your Google account, no forms to fill in."
    : 'Sign in instantly with your Google account. No forms, no passwords.';
  document.getElementById('googleLoginBtnLabel').textContent = anon ? 'Continue' : 'Continue with Google';
  document.getElementById('loginModal').dataset.authContext = anon ? 'channel' : '';
  showAuthPanel('authPanelGoogle');
  document.getElementById('loginModal').classList.add('active');
});
document.getElementById('logoutRow').addEventListener('click', async () => {
  // Only ever wired up for real identities (see refreshAuthUI) — logging out
  // drops the real session, then immediately starts a fresh anonymous one so
  // the person lands back as a working guest instead of a dead end.
  await ShortTubeAuth.logout();
  await ShortTubeAuth.initSession();
  await refreshAuthUI();
});

// Only one panel exists now (Google), but keep this helper — other code
// (requireAuth, the login button) calls it, and it's a harmless no-op with
// a single panel.
function showAuthPanel(panelId){
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(panelId).classList.add('active');
}

/* ---------------- Google auto-login ----------------
   One tap and Google does the rest — no phone number, no OTP code, no
   YouTube-account details to type in by hand. The age-gate checkbox below
   is the only thing ShortTube itself still asks for, and only once per
   device (self-attested, no date of birth collected). Because
   loginWithGoogle() triggers a full-page redirect to Google and back, the
   "the user confirmed the age gate" intent has to survive that reload, so
   it's stashed in localStorage rather than a JS variable. */
const AGE_VERIFIED_KEY = 'shorttube_age_verified';
const AGE_PENDING_KEY = 'shorttube_age_pending_confirm';
// Set right before the Google redirect if the sheet was opened from Upload,
// so refreshAuthUI() can auto-reopen the upload chooser the moment the
// person lands back with a fresh session — "Continue" really does take them
// straight into uploading, with no extra tap in between.
const PENDING_UPLOAD_KEY = 'shorttube_pending_upload_after_login';
function refreshAgeGateVisibility(){
  const row = document.getElementById('ageGateRow');
  row.style.display = localStorage.getItem(AGE_VERIFIED_KEY) === '1' ? 'none' : 'block';
}
refreshAgeGateVisibility();

document.getElementById('googleLoginBtn').addEventListener('click', () => {
  if (localStorage.getItem(AGE_VERIFIED_KEY) !== '1'){
    const checked = document.getElementById('authAgeCheck').checked;
    const errEl = document.getElementById('authAgeError');
    if (!checked){
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    localStorage.setItem(AGE_PENDING_KEY, '1');
  }
  if (document.getElementById('loginModal').dataset.authContext === 'upload') {
    localStorage.setItem(PENDING_UPLOAD_KEY, '1');
  }
  ShortTubeAuth.loginWithGoogle(); // redirects the browser to Google; nothing after this line runs
});

// Runs once per page load, after refreshAuthUI() has determined whether a
// session exists. If the age gate was pending when the Google redirect
// kicked off and we now have a logged-in user, persist the confirmation on
// their account and mark this device as cleared.
function resumePendingUploadIfAny(){
  if (localStorage.getItem(PENDING_UPLOAD_KEY) !== '1') return;
  localStorage.removeItem(PENDING_UPLOAD_KEY);
  document.getElementById('loginModal').classList.remove('active');
  document.getElementById('uploadChooserModal').classList.add('active');
}

async function finalizePendingAgeConfirmation(me){
  if (!me || localStorage.getItem(AGE_PENDING_KEY) !== '1') return;
  try {
    await databases.updateDocument(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, me.$id, { ageVerified: true });
  } catch (e) { console.warn('[ShortTube] could not persist age verification:', e); }
  localStorage.removeItem(AGE_PENDING_KEY);
  localStorage.setItem(AGE_VERIFIED_KEY, '1');
  refreshAgeGateVisibility();
}

/* ---------------- Static pages: Privacy / About / Legal ---------------- */
document.getElementById('tosRow').addEventListener('click', () => document.getElementById('tosOverlay').classList.add('active'));
document.getElementById('privacyRow').addEventListener('click', () => document.getElementById('privacyOverlay').classList.add('active'));
document.getElementById('aboutRow').addEventListener('click', () => document.getElementById('aboutOverlay').classList.add('active'));
document.getElementById('legalRow').addEventListener('click', () => document.getElementById('legalOverlay').classList.add('active'));
document.querySelectorAll('.static-close').forEach(btn => {
  btn.addEventListener('click', () => document.getElementById(btn.dataset.close).classList.remove('active'));
});

/* ---------------- Theme (Settings > Theme) ---------------- */
const THEME_LABELS = { 'pure-white':'Pure White', 'soft-ivory':'Soft Ivory', 'cool-grey':'Cool Grey' };
function applyTheme(theme){
  if (theme === 'pure-white') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeRowValue').textContent = THEME_LABELS[theme] || 'Pure White';
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.themeValue === theme);
  });
}
function getSavedTheme(){
  try { return localStorage.getItem('shorttube_theme') || 'pure-white'; } catch { return 'pure-white'; }
}
applyTheme(getSavedTheme());
document.getElementById('themeRow').addEventListener('click', () => {
  applyTheme(getSavedTheme()); // re-sync checkmarks in case theme was changed elsewhere
  document.getElementById('themeModal').classList.add('active');
});
document.querySelectorAll('.theme-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.themeValue;
    try { localStorage.setItem('shorttube_theme', theme); } catch {}
    applyTheme(theme);
    setTimeout(() => document.getElementById('themeModal').classList.remove('active'), 220);
  });
});

/* ---------------- Report flow (long-form player) ---------------- */
let reportTargetVideo = null;
function openReportModal(video){
  reportTargetVideo = video;
  document.getElementById('reportModal').classList.add('active');
}
document.querySelectorAll('.report-reason-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!reportTargetVideo) return;
    try {
      await ShortTubeSocial.reportVideo(socialId(reportTargetVideo), btn.dataset.reason);
      alert('Thanks — this video has been reported for review.');
    } catch (err) {
      console.error('[ShortTube] report failed:', err);
      alert("Couldn't submit the report right now.");
    } finally {
      document.getElementById('reportModal').classList.remove('active');
      reportTargetVideo = null;
    }
  });
});
document.getElementById('playerReportBtn').addEventListener('click', () => {
  if (!requireAuth('report a video')) return;
  if (state.currentPlayerVideo) openReportModal(state.currentPlayerVideo);
});

/* ---------------- Profile 3-dot menu -> Studio + Settings ---------------- */
document.getElementById('profileMenuBtn').addEventListener('click', () => {
  document.getElementById('profileMenuOverlay').classList.add('active');
});
document.getElementById('studioMenuRow').addEventListener('click', () => {
  document.getElementById('profileMenuOverlay').classList.remove('active');
  document.getElementById('studioOverlay').classList.add('active');
  loadStudio();
});
document.getElementById('settingsMenuRow').addEventListener('click', () => {
  document.getElementById('profileMenuOverlay').classList.remove('active');
  document.getElementById('settingsOverlay').classList.add('active');
});
// Support Team now lives inside Settings (moved off the main profile body) —
// tapping it opens the same full-screen support chat used from the Inbox.
document.getElementById('supportTeamRow').addEventListener('click', () => {
  document.getElementById('settingsOverlay').classList.remove('active');
  document.getElementById('inboxSupportOverlay').classList.add('active');
});

/* ---------------- HOME FEED ---------------- */
const homeFeedEl = document.getElementById('homeFeed');
const loadMoreSpinner = document.getElementById('loadMoreSpinner');

function renderSkeletons(container, count, type){
  for (let i=0;i<count;i++){
    const sk = document.createElement('div');
    sk.className = type === "card" ? "video-card" : "short-slide";
    sk.dataset.skeleton = "1";
    sk.innerHTML = `<div class="skeleton" style="width:100%; aspect-ratio:16/9;"></div>
      <div class="video-meta"><div class="skeleton" style="height:14px; width:80%; border-radius:4px; margin-bottom:6px;"></div>
      <div class="skeleton" style="height:10px; width:40%; border-radius:4px;"></div></div>`;
    container.appendChild(sk);
  }
}
function clearSkeletons(container){ container.querySelectorAll('[data-skeleton="1"]').forEach(el=>el.remove()); }

function srcLabelFor(source){ return source === 'youtube' ? 'YouTube' : 'ShortTube'; }
function srcClassFor(source){ return source === 'youtube' ? 'src-yt' : 'src-up'; }

// "10k views" style compact counts
function formatCount(n){
  n = Number(n) || 0;
  if (n >= 1e9) return (n/1e9).toFixed(n%1e9===0?0:1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(n%1e6===0?0:1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(n%1e3===0?0:1) + 'K';
  return String(n);
}
// "2 hours ago" style relative time
function timeAgo(dateStr){
  if (!dateStr) return '';
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const steps = [
    [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']
  ];
  let value = diffSec, unit = 'second';
  for (const [size, name] of steps){
    if (value < size) { unit = name; break; }
    value = Math.floor(value / size);
    unit = name;
  }
  return `${value} ${unit}${value===1?'':'s'} ago`;
}
function formatDuration(sec){
  sec = Math.round(Number(sec) || 0);
  if (!sec) return '';
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  const mm = h ? String(m).padStart(2,'0') : String(m);
  const ss = String(s).padStart(2,'0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function metaLineFor(video){
  const parts = [];
  parts.push(`${formatCount(video.viewCount)} views`);
  const ago = timeAgo(video.uploadedAt);
  if (ago) parts.push(ago);
  return parts.join(' <span class="dot"></span> ');
}

// A creator/channel can be "followed" even for external (YouTube)
// videos, which don't have a real ShortTube account — we key those follow
// relationships off a synthetic id namespaced by source+channel instead of a
// real userId, so the same `follows` collection can track both.
function followIdFor(video){
  return video.source === 'appwrite'
    ? (video.ownerId || video._raw?.ownerId || video.id)
    : `ext:${video.source}:${(video.channel || 'unknown').toLowerCase().replace(/\s+/g, '-')}`;
}

// Facebook-style Like/Comment/Share row, shared by both video and image
// cards. Actions never trigger the card's own tap (open player / open
// viewer) — every button here calls stopPropagation() first. Comment
// opens the lightweight #commentSheet in-place so the person never has
// to leave the feed just to leave a comment.
function cardActionsHtml(){
  return `<div class="card-actions">
      <button class="card-action-btn like-action"><i class="bi bi-heart"></i><span>Like</span></button>
      <button class="card-action-btn comment-action"><i class="bi bi-chat"></i><span>Comment</span></button>
      <button class="card-action-btn share-action"><i class="bi bi-share"></i><span>Share</span></button>
    </div>`;
}
function wireCardActions(actionsEl, contentId, getShareData){
  const likeBtn = actionsEl.querySelector('.like-action');
  const commentBtn = actionsEl.querySelector('.comment-action');
  const shareBtn = actionsEl.querySelector('.share-action');
  likeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await ensureGuestSession('like this'))) return;
    likeBtn.disabled = true;
    try {
      const { liked } = await ShortTubeSocial.toggleLike(contentId);
      likeBtn.classList.toggle('liked', liked);
      likeBtn.querySelector('span').textContent = liked ? 'Liked' : 'Like';
    } catch (err) {
      console.error('[ShortTube] card like failed:', err);
    } finally {
      likeBtn.disabled = false;
    }
  });
  commentBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await ensureGuestSession('comment'))) return;
    openCommentSheet(contentId);
  });
  shareBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const data = getShareData();
    if (navigator.share) { try { await navigator.share(data); } catch (err) {} }
    else navigator.clipboard?.writeText(data.url || data.title || '');
  });
}

function createVideoCard(video){
  const card = document.createElement('div');
  card.className = 'video-card';
  card.innerHTML = `
    <div class="thumb-wrap">
      <span class="src-badge ${srcClassFor(video.source)}">${srcLabelFor(video.source)}</span>
      <img data-src="${video.thumbnail}" alt="${escapeHtml(video.title)}" loading="lazy" decoding="async">
      ${video.duration ? `<span class="duration-badge">${formatDuration(video.duration)}</span>` : ''}
    </div>
    <div class="video-meta">
      <h3>${escapeHtml(video.title)}</h3>
      <div class="sub">${metaLineFor(video)}</div>
    </div>`;
  card._video = video;
  // Click-to-Play: tapping the card opens the player, which autostarts
  // playback immediately. The Long-form/Videos feed keeps its original
  // YouTube-style layout — no Like/Comment/Share row on the card itself;
  // those live only on the full player overlay (playerLikeBtn/
  // playerCommentBtn/playerShareBtn) and on the Image feed's cards.
  card.addEventListener('click', () => openPlayer(video));
  return card;
}

function renderFeedItems(container, items){
  items.forEach(item => {
    container.appendChild(createVideoCard(item));
    window.ShortTubeUnityAds?.notifyCardShown(); // counts videos; no-op display while INTERSTITIAL_AUTO_ENABLED is false
  });
  observeLazyImages(container);
}

let homeLoading = false;
let homePage = 1;
let homeHasMore = true;
let videosInitialized = false;
async function loadHomeFeed(append=false){
  if (homeLoading) return;
  if (append && !homeHasMore) return;
  homeLoading = true;
  if (!append) { homePage = 1; homeHasMore = true; }
  loadMoreSpinner.style.display = 'block';
  if (!append){ homeFeedEl.innerHTML=''; renderSkeletons(homeFeedEl,4,"card"); }
  try{
    const items = await ShortTubeFeed.getHomeFeed(homePage);
    if (!append) clearSkeletons(homeFeedEl);
    // Ad-cards retired: the ad is now the persistent bottom banner (see
    // ads-unity.js showBanner()), not tiles spliced into the feed.
    renderFeedItems(homeFeedEl, items);
    homeHasMore = items.length > 0;
    homePage++;
    loadMoreSpinner.style.display = homeHasMore ? 'block' : 'none';
    if (items.length === 0 && !append){
      // Transient blips (API quota hiccup, slow network) are common enough
      // that a single silent auto-retry clears most of them before the user
      // ever sees an empty state. If it's still empty after that, show a
      // real Retry button instead of leaving the user stuck.
      homeLoading = false;
      if (!homeRetried){ homeRetried = true; setTimeout(() => loadHomeFeed(false), 1200); return; }
      const errs = window.getLastFeedSourceErrors?.();
      const errHint = errs ? `<div style="font-size:.72rem; color:var(--muted); margin-top:8px; padding:0 20px;">${Object.entries(errs).map(([k,v])=>`${k}: ${escapeHtml(v)}`).join('<br>')}</div>` : '';
      homeFeedEl.innerHTML = `<div class="empty-state"><i class="bi bi-camera-video-off"></i>No videos found.${errHint}<br><button class="pill-btn-outline" id="homeRetryBtn" style="margin-top:12px;">Retry</button></div>`;
      document.getElementById('homeRetryBtn')?.addEventListener('click', () => { homeRetried = false; loadHomeFeed(false); });
    } else { homeRetried = false; }
  }catch(err){
    console.error(err);
    if (!append){
      clearSkeletons(homeFeedEl);
      homeFeedEl.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't load the feed.<br><button class="pill-btn-outline" id="homeRetryBtn" style="margin-top:12px;">Retry</button></div>`;
      document.getElementById('homeRetryBtn')?.addEventListener('click', () => { homeRetried = false; loadHomeFeed(false); });
    }
  }finally{ homeLoading = false; }
}
let homeRetried = false;
window.renderHomeFeedFromData = (items) => { homeFeedEl.innerHTML=''; renderFeedItems(homeFeedEl, items); };

// Infinite Scroll: Home feed scrolls at the document/body level (not a
// scrollable inner container), so we listen on window and load the next
// page once the user is near the bottom of the page.
window.addEventListener('scroll', debounce(() => {
  if (document.getElementById('homePage').classList.contains('active')){
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 900;
    if (nearBottom) loadHomeFeed(true);
  }
  if (document.getElementById('imagesPage').classList.contains('active')){
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 900;
    if (nearBottom) loadImagesFeed(true);
  }
}, 150));

/* ---------------- IMAGES FEED (Home tab) ----------------
   Single-column feed, same card style as the long-form Videos feed, but
   sourced from ShortTubeFeed.getImagesFeed() (user-uploaded photos only —
   no external image API). Tapping a card opens a simple full-screen image
   viewer instead of the video player. */
const imagesFeedEl = document.getElementById('imagesFeed');
const imagesLoadMoreSpinner = document.getElementById('imagesLoadMoreSpinner');
let imagesInitialized = false;
let imagesLoading = false;
let imagesPageNum = 1;
let imagesHasMore = true;
let imagesRetried = false;

// Images are keyed distinctly from videos ("img:<id>") so the shared
// Likes/Comments collections never collide an uploaded photo with a video
// that happens to share the same document ID.
function imageSocialId(image){ return `img:${image.id}`; }

function createImageCard(image){
  const card = document.createElement('div');
  card.className = 'video-card image-card';
  card.innerHTML = `
    <div class="thumb-wrap">
      <img data-src="${image.imageUrl}" alt="${escapeHtml(image.caption||'')}" loading="lazy" decoding="async">
    </div>
    <div class="video-meta">
      ${image.caption ? `<h3>${escapeHtml(image.caption)}</h3>` : ''}
      <div class="sub">${escapeHtml(image.ownerName||'ShortTube Creator')} <span class="dot"></span> ${timeAgo(image.uploadedAt)}</div>
    </div>
    ${cardActionsHtml()}`;
  card.addEventListener('click', () => openImageViewer(image));
  wireCardActions(card.querySelector('.card-actions'), imageSocialId(image), () => ({ title: image.caption || 'Check this out on ShortTube', url: image.imageUrl }));
  return card;
}
function renderImageFeedItems(container, items){
  items.forEach(item => {
    container.appendChild(item.feedItemType === 'video' ? createVideoCard(item) : createImageCard(item));
  });
  observeLazyImages(container);
}

async function loadImagesFeed(append=false){
  if (imagesLoading) return;
  if (append && !imagesHasMore) return;
  imagesLoading = true;
  if (!append) { imagesPageNum = 1; imagesHasMore = true; }
  imagesLoadMoreSpinner.style.display = 'block';
  if (!append){ imagesFeedEl.innerHTML=''; renderSkeletons(imagesFeedEl,4,"card"); }
  try{
    const items = await ShortTubeFeed.getImagesFeed(imagesPageNum);
    if (!append) clearSkeletons(imagesFeedEl);
    // Ad-cards retired: the ad is now the persistent bottom banner (see
    // ads-unity.js showBanner()), not tiles spliced into the feed.
    renderImageFeedItems(imagesFeedEl, items);
    imagesHasMore = items.length > 0;
    imagesPageNum++;
    imagesLoadMoreSpinner.style.display = imagesHasMore ? 'block' : 'none';
    if (items.length === 0 && !append){
      imagesFeedEl.innerHTML = `<div class="empty-state"><i class="bi bi-images"></i>No photos yet. Tap Upload to share the first one.</div>`;
    }
    imagesRetried = false;
  }catch(err){
    console.error('[ShortTube] loadImagesFeed failed:', err);
    if (!append){
      clearSkeletons(imagesFeedEl);
      imagesFeedEl.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't load photos.<br><button class="pill-btn-outline" id="imagesRetryBtn" style="margin-top:12px;">Retry</button></div>`;
      document.getElementById('imagesRetryBtn')?.addEventListener('click', () => loadImagesFeed(false));
    }
  }finally{ imagesLoading = false; }
}
window.refreshImagesFeed = () => loadImagesFeed(false);

/* Minimal full-screen image viewer — reuses the report modal's reasons via
   the same openReportModal() flow is unnecessary here since only videos are
   reportable today; this viewer just shows the photo full-bleed. */
function openImageViewer(image){
  let viewer = document.getElementById('imageViewerOverlay');
  if (!viewer){
    viewer = document.createElement('div');
    viewer.id = 'imageViewerOverlay';
    viewer.className = 'static-overlay';
    viewer.innerHTML = `<div class="static-topbar"><button class="static-close" id="closeImageViewer"><i class="bi bi-arrow-left"></i></button><h3>Photo</h3></div><div class="static-body" id="imageViewerBody" style="padding:0; display:flex; align-items:center; justify-content:center;"></div>`;
    document.body.appendChild(viewer);
    viewer.querySelector('#closeImageViewer').addEventListener('click', () => viewer.classList.remove('active'));
  }
  document.getElementById('imageViewerBody').innerHTML = `<img src="${image.imageUrl}" alt="${escapeHtml(image.caption||'')}" style="width:100%; max-height:80vh; object-fit:contain;">
    ${image.caption ? `<p style="padding:14px; color:var(--text); font-size:.85rem;">${escapeHtml(image.caption)}</p>` : ''}`;
  viewer.classList.add('active');
}

/* ---------------- QUICK COMMENT SHEET (feed-card "Comment" button) ----------------
   A lightweight bottom sheet so commenting never requires leaving the feed
   or opening the full player. Reuses the same renderComments()/postComment()
   helpers the long-form player's comment section already uses. */
let commentSheetTargetId = null;
function openCommentSheet(contentId){
  commentSheetTargetId = contentId;
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('commentSheet').classList.add('open');
  renderComments(contentId, document.getElementById('commentSheetList'));
  document.getElementById('commentSheetInput').focus();
}
function closeCommentSheet(){
  document.getElementById('sheetBackdrop').classList.remove('show');
  document.getElementById('commentSheet').classList.remove('open');
  commentSheetTargetId = null;
}
document.getElementById('closeCommentSheet').addEventListener('click', closeCommentSheet);
document.getElementById('sheetBackdrop').addEventListener('click', closeCommentSheet);
document.getElementById('commentSheetPost').addEventListener('click', async () => {
  if (!(await ensureGuestSession('comment'))) return;
  if (!commentSheetTargetId) return;
  const input = document.getElementById('commentSheetInput');
  postComment(commentSheetTargetId, input.value, document.getElementById('commentSheetList'));
  input.value = '';
});
window.closeCommentSheet = closeCommentSheet; // used by the physical Back-button handler

/* ---------------- Profile feed (Posts grid) -> open in player/viewer ---------------- */
window.openProfileFeedItem = function(item){
  if (!item) return;
  if (item.type === 'video'){
    const d = item._raw;
    openPlayer({
      id: d.$id, source: 'appwrite', title: d.title,
      channel: document.getElementById('profileDisplayName').textContent,
      thumbnail: item.thumbnailUrl,
      embedUrl: storage.getFileView(APPWRITE_CONFIG.BUCKETS.VIDEO_FILES, d.videoFileId).href,
      duration: d.durationSeconds, viewCount: d.engagementScore || 0,
      uploadedAt: d.createdAt || d.$createdAt, ownerId: d.ownerId, _raw: d
    });
  } else {
    const d = item._raw;
    openImageViewer({
      imageUrl: item.thumbnailUrl, caption: d.caption,
      uploadedAt: d.createdAt || d.$createdAt
    });
  }
};

/* ---------------- PULL-TO-REFRESH ---------------- */
// A small reusable touch-drag gesture: only engages when the scrollable
// area is already at its very top, so it never fights normal scrolling.
function initPullToRefresh(scrollElGetter, indicatorEl, onRefresh){
  let startY = null, pulling = false, refreshing = false;
  const THRESHOLD = 70;
  const target = indicatorEl.parentElement;

  target.addEventListener('touchstart', (e) => {
    if (refreshing) return;
    const scrollEl = scrollElGetter();
    const atTop = scrollEl === window ? window.scrollY <= 0 : scrollEl.scrollTop <= 0;
    if (!atTop) { startY = null; return; }
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  target.addEventListener('touchmove', (e) => {
    if (!pulling || startY === null) return;
    const delta = e.touches[0].clientY - startY;
    if (delta > 0){
      const pull = Math.min(delta * 0.5, THRESHOLD + 20);
      indicatorEl.style.transform = `translate(-50%, ${pull - 34}px)`;
    }
  }, { passive: true });

  target.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    const shownPx = parseFloat((indicatorEl.style.transform.match(/-?\d+\.?\d*px/g) || ['0px'])[1] || 0);
    const pulledEnough = shownPx + 34 >= THRESHOLD;
    indicatorEl.style.transform = '';
    if (pulledEnough && !refreshing){
      refreshing = true;
      indicatorEl.classList.add('spin');
      indicatorEl.style.transform = 'translate(-50%, 6px)';
      try { await onRefresh(); } finally {
        indicatorEl.classList.remove('spin');
        indicatorEl.style.transform = '';
        refreshing = false;
      }
    }
    startY = null;
  });
}

initPullToRefresh(
  () => window,
  document.getElementById('homePtrIndicator'),
  () => loadHomeFeed(false)
);
initPullToRefresh(
  () => window,
  document.getElementById('imagesPtrIndicator'),
  () => loadImagesFeed(false)
);



/* ---------------- LONG-FORM PLAYER ---------------- */
const playerOverlay = document.getElementById('playerOverlay');
const playerFrame = document.getElementById('playlistList') && document.getElementById('playerFrame');
const playlistList = document.getElementById('playlistList');

async function openPlayer(video){
  state.currentPlayerVideo = video;
  document.getElementById('playerTitle').textContent = video.title;
  document.getElementById('playerChannel').textContent = video.channel;
  playerOverlay.classList.add('active');
  document.getElementById('playerCommentsSection').classList.remove('open'); // hidden by default until "Comment" is tapped
  document.querySelector('.player-scroll-body').scrollTop = 0;
  state.watched++;

  if (video.source === 'appwrite'){
    playerFrame.innerHTML = `<video id="playerVideoEl" src="${video.embedUrl}" controls autoplay playsinline></video>`;
    attachEnhancedPlayer(document.getElementById('playerVideoEl'), video._raw);
  } else {
    playerFrame.innerHTML = `<iframe src="${video.embedUrl}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
  }

  const likeBtn = document.getElementById('playerLikeBtn');
  const likeCountEl = document.getElementById('playerLikeCount');
  likeBtn.classList.remove('liked');
  likeCountEl.textContent = "Like";
  const followBtn = document.getElementById('playerFollowBtn');
  const followLabelEl = document.getElementById('playerFollowLabel');
  followBtn.classList.remove('liked');
  followLabelEl.textContent = "Follow";
  // Reflect whether *this* logged-in user has already liked/followed it
  // (Guest Access: browsing/watching never requires login — these checks
  // just no-op for guests)
  if (currentUser){
    try {
      const already = await ShortTubeSocial.isLikedByMe(socialId(video));
      likeBtn.classList.toggle('liked', already);
      likeCountEl.textContent = already ? "Liked" : "Like";
    } catch (err) { console.warn('[ShortTube] could not check like state:', err); }
    try {
      const existingFollow = await ShortTubeProfile.isFollowing(currentUser.$id, followIdFor(video));
      followBtn.classList.toggle('liked', !!existingFollow);
      followLabelEl.textContent = existingFollow ? "Following" : "Follow";
    } catch (err) { console.warn('[ShortTube] could not check follow state:', err); }
  }
  renderComments(socialId(video), document.getElementById('playerCommentList'));

  playlistList.innerHTML = '';
  renderSkeletons(playlistList, 3, "card");
  try{
    const res = await ShortTubeVideoAPI.getRelated(video.title);
    clearSkeletons(playlistList);
    (res.videos || []).filter(v => getVideoKey(v) !== getVideoKey(video)).slice(0,8).forEach(v => {
      const item = document.createElement('div');
      item.className = 'playlist-item';
      item.innerHTML = `<div class="thumb"><img data-src="${v.thumbnail}" alt="${escapeHtml(v.title)}" loading="lazy" decoding="async"></div>
        <div class="meta"><h5>${escapeHtml(v.title)}</h5><div class="sub">${escapeHtml(v.channel)} · ${srcLabelFor(v.source)}</div></div>`;
      item.addEventListener('click', () => openPlayer(v));
      playlistList.appendChild(item);
    });
    observeLazyImages(playlistList);
  }catch(err){ clearSkeletons(playlistList); }
}
document.getElementById('closePlayer').addEventListener('click', () => {
  const v = document.getElementById('playerVideoEl');
  if (v) ShortTubeAlgorithm.stopTracking(state.currentPlayerVideo._raw, v);
  playerFrame.innerHTML = '';
  playerOverlay.classList.remove('active');
});
document.getElementById('playerLikeBtn').addEventListener('click', async function(){
  // Guest-first: liking never requires a real account, just a session.
  if (!(await ensureGuestSession('like a video'))) return;
  const btn = this;
  const video = state.currentPlayerVideo; if (!video) return;
  btn.disabled = true;
  try {
    const { liked } = await ShortTubeSocial.toggleLike(socialId(video));
    btn.classList.toggle('liked', liked);
    document.getElementById('playerLikeCount').textContent = liked ? "Liked" : "Like";
  } catch (err) {
    console.error('[ShortTube] toggleLike failed:', err);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('playerFollowBtn').addEventListener('click', async function(){
  if (!(await ensureGuestSession('follow a creator'))) return;
  const btn = this;
  const video = state.currentPlayerVideo; if (!video) return;
  btn.disabled = true;
  try {
    const targetId = followIdFor(video);
    const existing = await ShortTubeProfile.isFollowing(currentUser.$id, targetId);
    if (existing) {
      await ShortTubeProfile.unfollow(existing.$id);
      btn.classList.remove('liked');
      document.getElementById('playerFollowLabel').textContent = 'Follow';
    } else {
      await ShortTubeProfile.follow(currentUser.$id, targetId);
      btn.classList.add('liked');
      document.getElementById('playerFollowLabel').textContent = 'Following';
    }
  } catch (err) {
    console.error('[ShortTube] player follow failed:', err);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('playerShareBtn').addEventListener('click', async () => {
  const v = state.currentPlayerVideo; if (!v) return;
  if (navigator.share){ try{ await navigator.share({title:v.title, url:v.embedUrl}); }catch(e){} }
  else navigator.clipboard?.writeText(v.embedUrl);
});
document.getElementById('playerCommentBtn').addEventListener('click', async () => {
  if (!(await ensureGuestSession('comment on a video'))) return;
  const section = document.getElementById('playerCommentsSection');
  const opening = !section.classList.contains('open');
  section.classList.toggle('open', opening);
  if (opening) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('playerCommentInput').focus();
  }
});
document.getElementById('playerCommentPost').addEventListener('click', async () => {
  if (!(await ensureGuestSession('comment on a video'))) return;
  const input = document.getElementById('playerCommentInput');
  postComment(socialId(state.currentPlayerVideo), input.value, document.getElementById('playerCommentList'));
  input.value = '';
});

// Videos hosted on Appwrite are keyed by their raw document $id (so likes/
// comments line up with the ownerId lookups the Inbox uses); external
// (YouTube) videos use the composite source:id key instead.
function socialId(video){ return video.source === 'appwrite' ? video.id : getVideoKey(video); }

async function postComment(videoId, text, listEl){
  text = text.trim(); if (!text) return;
  try {
    const result = await ShortTubeSocial.postComment(videoId, text);
    // Session dropped between the tap and this write (rare — e.g. it expired
    // mid-action). Never pop the login modal here either: retry the guest
    // session silently once, resend the comment, and only give up quietly
    // (no modal) if that retry also fails.
    if (result.requiresAuth) {
      if (await ensureGuestSession('comment on a video')) {
        const retry = await ShortTubeSocial.postComment(videoId, text);
        if (!retry.requiresAuth) { state.commentsGiven++; renderComments(videoId, listEl); return; }
      }
      console.warn('[ShortTube] Comment could not be saved — no guest session available (see ensureGuestSession warning above). No login popup shown.');
      return;
    }
    state.commentsGiven++;
    renderComments(videoId, listEl);
  } catch (err) {
    console.error('[ShortTube] postComment failed:', err);
    alert("Couldn't post your comment. Please try again.");
  }
}
async function renderComments(videoId, listEl){
  listEl.innerHTML = `<div style="color:var(--muted); font-size:.8rem;">Loading comments...</div>`;
  try {
    const docs = await ShortTubeSocial.listComments(videoId);
    if (docs.length === 0) {
      listEl.innerHTML = `<div style="color:var(--muted); font-size:.8rem;">No comments yet.</div>`;
      return;
    }
    const withNames = await Promise.all(docs.map(async d => ({ name: await ShortTubeSocial.getDisplayName(d.userId), text: d.text })));
    listEl.innerHTML = withNames.map(c => `
      <div class="comment-item"><div class="comment-avatar">${escapeHtml((c.name[0]||'?').toUpperCase())}</div>
      <div class="comment-body"><div class="name">${escapeHtml(c.name)}</div><div class="text">${escapeHtml(c.text)}</div></div></div>`).join('');
  } catch (err) {
    console.error('[ShortTube] listComments failed:', err);
    listEl.innerHTML = `<div style="color:var(--muted); font-size:.8rem;">Couldn't load comments.</div>`;
  }
}

/* ---------------- SEARCH (dedicated full-page search) ---------------- */
const searchOverlay = document.getElementById('searchOverlay');
const searchOverlayInput = document.getElementById('searchOverlayInput');
const searchOverlayResults = document.getElementById('searchOverlayResults');

document.getElementById('openSearchBtn').addEventListener('click', () => {
  searchOverlay.classList.add('active');
  searchOverlayInput.value = state.searchQuery || '';
  // Autofocusing on the very next frame reliably triggers the mobile keyboard
  // right as the page becomes visible, instead of racing the overlay's paint.
  requestAnimationFrame(() => searchOverlayInput.focus());
  if (state.searchQuery) runSearch(state.searchQuery);
});
document.getElementById('closeSearchOverlay').addEventListener('click', () => {
  searchOverlay.classList.remove('active');
});

async function runSearch(query){
  searchOverlayResults.innerHTML = '';
  renderSkeletons(searchOverlayResults, 4, 'card');
  try {
    // getSearchResults is the ONLY code path that hits YouTube's Search API
    // (100 quota units/call) — see js/feed.js. It must only ever be reached
    // from an explicit user action (Enter / voice result), never per-keystroke.
    const items = await ShortTubeFeed.getSearchResults(query);
    clearSkeletons(searchOverlayResults);
    if (items.length === 0){
      searchOverlayResults.innerHTML = `<div class="empty-state"><i class="bi bi-search"></i>No results for "${escapeHtml(query)}".</div>`;
      return;
    }
    items.forEach(item => {
      if (item.isAd) return; // no ad cards inside search results
      const card = createVideoCard(item);
      card.addEventListener('click', () => searchOverlay.classList.remove('active'), { once:true });
      searchOverlayResults.appendChild(card);
    });
    observeLazyImages(searchOverlayResults);
  } catch (err) {
    console.error('[ShortTube] search failed:', err);
    clearSkeletons(searchOverlayResults);
    searchOverlayResults.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't search right now.</div>`;
  }
}

// Explicit search submission — the only trigger point for the Search API
// call. Called from Enter/keyboard-search-key and from voice search
// results, never from the live 'input' event.
function submitSearch(query){
  state.searchQuery = query.trim();
  document.getElementById('searchPillLabel').textContent = state.searchQuery || 'Search ShortTube';
  if (!state.searchQuery) { searchOverlayResults.innerHTML = ''; return; }
  runSearch(state.searchQuery);
}

// Live typing only updates the input's own state (label preview) — it
// intentionally does NOT call the API. This is what used to burn the whole
// daily YouTube quota in minutes (one Search API call per keystroke).
searchOverlayInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value.trim();
});
searchOverlayInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitSearch(searchOverlayInput.value); }
});

/* Voice search: uses the Web Speech API where the browser supports it
   (most Android/Chrome contexts do); gracefully explains when it doesn't
   rather than pretending to listen. */
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
document.getElementById('voiceSearchBtn').addEventListener('click', function(){
  if (!SpeechRecognitionCtor) { alert("Voice search isn't supported in this browser."); return; }
  const recognizer = new SpeechRecognitionCtor();
  recognizer.lang = 'en-US';
  recognizer.interimResults = false;
  this.classList.add('listening');
  recognizer.start();
  recognizer.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    searchOverlayInput.value = transcript;
    submitSearch(transcript); // explicit action (spoken result) — safe to call the Search API here
  };
  recognizer.onend = () => this.classList.remove('listening');
  recognizer.onerror = () => this.classList.remove('listening');
});

/* ---------------- NAV ----------------
   goToPage() is the one place that actually switches the active page/tab —
   shared by the bottom nav AND the Profile "Messages" link, which jumps
   straight to Inbox and scrolls to the conversation list there. */
function goToPage(pageId, tab, afterSwitch){
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelector(`.nav-btn[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(pageId).classList.add('active');
  // Top header (logo/branding/search) is only shown on the two feed tabs
  // (Home/Images and Videos) — hidden on Inbox/Profile.
  document.body.classList.toggle('header-hidden', tab !== 'home' && tab !== 'videos');
  if (tab === 'home' && !imagesInitialized){ imagesInitialized = true; loadImagesFeed(false); }
  if (tab === 'videos' && !videosInitialized){ videosInitialized = true; loadHomeFeed(false); }
  if (tab === 'inbox') loadInbox();
  if (tab === 'profile') refreshAuthUI();
  if (typeof afterSwitch === 'function') afterSwitch();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => goToPage(btn.dataset.page, btn.dataset.tab));
});

// Upload lives exclusively in Profile now (see index.html fb-action-row) —
// this is the ONLY place in the whole app that opens the upload chooser or
// the Create-Channel modal for it. requireAuth() is still called
// defensively (in case this button is ever visible to a stale/anonymous
// state), but in practice it's only shown once a real channel exists.
document.getElementById('uploadOpenBtn').addEventListener('click', () => {
  if (!requireAuth('upload a video', 'upload')) return;
  document.getElementById('uploadChooserModal').classList.add('active');
});

/* ---------------- PROFILE HUB ----------------
   The Facebook-style profile only keeps a "followers" stat as a tappable
   link (Following/Posts are plain text, matching the reference design) —
   tapping it jumps to Inbox and opens the Followers list there. */

/* Inbox page: the three TikTok-style category rows (Activity, New
   followers, ShortTube Team) each open their own full-screen overlay. */
document.getElementById('inboxActivityRow').addEventListener('click', () => {
  document.getElementById('inboxActivityOverlay').classList.add('active');
});
document.getElementById('inboxFollowersRow').addEventListener('click', () => {
  document.getElementById('inboxFollowersOverlay').classList.add('active');
});
document.getElementById('inboxSupportRow').addEventListener('click', () => {
  document.getElementById('inboxSupportOverlay').classList.add('active');
});

// Profile page's "followers" link jumps to Inbox (to trigger a fresh load)
// then opens the Followers overlay directly.
function wireProfileHubOverlayRow(rowId, overlayId){
  document.getElementById(rowId)?.addEventListener('click', () => {
    goToPage('inboxPage', 'inbox', () => {
      document.getElementById(overlayId)?.classList.add('active');
    });
  });
}
wireProfileHubOverlayRow('profileFollowersCol', 'inboxFollowersOverlay');

/* ---------------- Upload chooser: Long Video vs Photo ----------------
   Tapping '+' opens this camera-style picker first. Whichever option the
   person taps sets the hidden file input's `accept` filter to match, then
   opens the device's native camera/gallery chooser. upload.js already
   detects the resulting file's MIME type and shows the Title/Description
   form (uploadFormModal) before anything actually uploads. */
document.getElementById('chooseLongVideoBtn').addEventListener('click', () => {
  document.getElementById('uploadChooserModal').classList.remove('active');
  const fileInput = document.getElementById('uploadFileInput');
  fileInput.accept = 'video/*';
  fileInput.click();
});
document.getElementById('choosePhotoBtn').addEventListener('click', () => {
  document.getElementById('uploadChooserModal').classList.remove('active');
  const fileInput = document.getElementById('uploadFileInput');
  fileInput.accept = 'image/*';
  fileInput.click();
});

/* ---------------- STUDIO (creator analytics) ---------------- */
async function loadStudio(){
  const loggedOut = document.getElementById('studioLoggedOut');
  const content = document.getElementById('studioContent');
  const me = await ShortTubeAuth.getCurrentUser();
  if (!me){
    loggedOut.style.display = 'block';
    content.style.display = 'none';
    return;
  }
  loggedOut.style.display = 'none';
  content.style.display = 'block';

  const listEl = document.getElementById('studioVideoList');
  listEl.innerHTML = `<div class="empty-state"><div class="st-loader" style="margin:0 auto 10px;"></div>Loading...</div>`;

  try {
    const [views, likes, comments, followers] = await Promise.all([
      ShortTubeProfile.countViewsReceived(me.$id),
      ShortTubeProfile.countLikesReceived(me.$id),
      ShortTubeProfile.countCommentsReceived(me.$id),
      ShortTubeProfile.countFollowers(me.$id)
    ]);
    document.getElementById('studioViewsVal').textContent = views;
    document.getElementById('studioLikesVal').textContent = likes;
    document.getElementById('studioCommentsVal').textContent = comments;
    document.getElementById('studioFollowersVal').textContent = followers;

    const videoStats = await ShortTubeProfile.getMyVideoStats(me.$id);
    studioVideoStatsCache = videoStats; // used by the detail overlay when a row is tapped
    listEl.innerHTML = videoStats.length ? videoStats.map(v => {
      const badgeClass = v.moderationStatus === 'removed' ? 'removed' : (v.moderationStatus === 'pending' ? 'pending' : 'live');
      const badgeLabel = v.moderationStatus === 'removed' ? 'Removed' : (v.moderationStatus === 'pending' ? 'Pending review' : 'Live');
      return `<div class="studio-video-row" data-video-id="${v.id}" style="cursor:pointer;">
        <img src="${v.thumbnailUrl}" alt="${escapeHtml(v.title)}">
        <div>
          <h5>${escapeHtml(v.title)}</h5>
          <div class="metrics">
            <span><i class="bi bi-eye"></i> ${v.views}</span>
            <span><i class="bi bi-heart"></i> ${v.likes}</span>
            <span><i class="bi bi-chat"></i> ${v.comments}</span>
          </div>
          <span class="mod-badge ${badgeClass}">${badgeLabel}</span>
        </div>
      </div>`;
    }).join('') : `<div class="empty-state"><i class="bi bi-camera-video"></i>You haven't uploaded any videos yet.</div>`;
    listEl.querySelectorAll('.studio-video-row').forEach(row => {
      row.addEventListener('click', () => openStudioVideoDetail(row.dataset.videoId));
    });
  } catch (err) {
    console.error('[ShortTube] loadStudio failed:', err);
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't load your analytics.</div>`;
  }
}

/* ---------------- Studio: per-video analytics detail ---------------- */
// Clicking an uploaded video in Studio opens a YouTube-Studio-style detail
// view: views/likes/comments, an engagement-rate bar, and a comment breakdown.
let studioVideoStatsCache = [];
async function openStudioVideoDetail(videoId){
  const v = studioVideoStatsCache.find(x => x.id === videoId);
  if (!v) return;
  const overlay = document.getElementById('studioDetailOverlay');
  const body = document.getElementById('studioDetailBody');
  const engagementRate = v.views > 0 ? Math.min(100, Math.round(((v.likes + v.comments) / v.views) * 100)) : 0;
  body.innerHTML = `
    <img class="studio-detail-thumb" src="${v.thumbnailUrl}" alt="${escapeHtml(v.title)}">
    <h4 class="studio-detail-title">${escapeHtml(v.title)}</h4>
    <div class="studio-metric-grid">
      <div class="stat-box"><div class="num">${v.views}</div><div class="lbl">Views</div></div>
      <div class="stat-box"><div class="num">${v.likes}</div><div class="lbl">Likes</div></div>
      <div class="stat-box"><div class="num">${v.comments}</div><div class="lbl">Comments</div></div>
      <div class="stat-box"><div class="num">${engagementRate}%</div><div class="lbl">Engagement</div></div>
    </div>
    <h4 style="color:var(--text); font-size:.9rem; margin-bottom:8px;">Engagement rate</h4>
    <div class="studio-engagement-bar"><div class="studio-engagement-fill" style="width:${engagementRate}%;"></div></div>
    <p style="font-size:.72rem; margin:0 0 18px;">(Likes + comments) as a share of total views.</p>
    <h4 style="color:var(--text); font-size:.9rem;">Comment breakdown</h4>
    <div class="studio-comment-breakdown" id="studioDetailComments"><div class="st-loader" style="margin:6px 0;"></div></div>
  `;
  overlay.classList.add('active');
  try {
    const docs = await ShortTubeSocial.listComments(videoId);
    const commentsEl = document.getElementById('studioDetailComments');
    if (!docs.length){
      commentsEl.innerHTML = `<p style="font-size:.8rem;">No comments yet.</p>`;
      return;
    }
    const withNames = await Promise.all(docs.map(async d => ({ name: await ShortTubeSocial.getDisplayName(d.userId), text: d.text })));
    commentsEl.innerHTML = withNames.map(c => `
      <div class="comment-item"><div class="comment-avatar">${escapeHtml((c.name[0]||'?').toUpperCase())}</div>
      <div class="comment-body"><div class="name">${escapeHtml(c.name)}</div><div class="text">${escapeHtml(c.text)}</div></div></div>`).join('');
  } catch (err) {
    console.error('[ShortTube] studio comment breakdown failed:', err);
    document.getElementById('studioDetailComments').innerHTML = `<p style="font-size:.8rem;">Couldn't load comments.</p>`;
  }
}

async function loadInbox(){
  const activityList = document.getElementById('inboxActivityList');
  const followersList = document.getElementById('inboxFollowersList');
  const activityPreview = document.getElementById('inboxActivityPreview');
  const activityBadge = document.getElementById('inboxActivityBadge');
  const followersPreview = document.getElementById('inboxFollowersPreview');
  const followersBadge = document.getElementById('inboxFollowersBadge');

  // Messages is now just another stacked section on this same page (no
  // tab click to trigger it separately), so load it alongside everything
  // else every time Inbox opens.
  loadMessagesTab().catch(err => console.error('[ShortTube] loadMessagesTab failed:', err));

  if (!currentUser){
    activityList.innerHTML = `<div class="empty-state"><i class="bi bi-bell"></i>Log in to see likes and comments on your videos.</div>`;
    followersList.innerHTML = `<div class="empty-state"><i class="bi bi-people"></i>Log in to see your followers.</div>`;
    activityPreview.textContent = 'Likes and comments on your videos';
    activityBadge.style.display = 'none';
    followersPreview.textContent = "See who's following you";
    followersBadge.style.display = 'none';
    return;
  }

  activityList.innerHTML = `<div class="empty-state"><div class="st-loader" style="margin:0 auto 10px;"></div>Loading...</div>`;
  followersList.innerHTML = `<div class="empty-state"><div class="st-loader" style="margin:0 auto 10px;"></div>Loading...</div>`;

  try {
    const activity = await ShortTubeSocial.getInboxActivity(currentUser.$id);
    activityList.innerHTML = activity.length ? activity.map(item => `
      <div class="notif-item">
        <i class="bi ${item.type === 'like' ? 'bi-heart-fill' : 'bi-chat-fill'}"></i>
        <div>
          <div class="txt"><span class="who">${escapeHtml(item.who)}</span> ${item.type === 'like' ? 'liked your video' : `commented: "${escapeHtml(item.text)}"`}</div>
          <div class="when">${new Date(item.at).toLocaleDateString()}</div>
        </div>
      </div>`).join('') : `<div class="empty-state"><i class="bi bi-bell"></i>No activity yet on your videos.</div>`;
    // Summary row preview: latest item's text + an unread-style count badge.
    if (activity.length){
      const latest = activity[0];
      activityPreview.textContent = `${latest.who} ${latest.type === 'like' ? 'liked your video' : `commented: "${latest.text}"`}`;
      activityBadge.textContent = activity.length > 99 ? '99+' : String(activity.length);
      activityBadge.style.display = 'inline-flex';
    } else {
      activityPreview.textContent = 'Likes and comments on your videos';
      activityBadge.style.display = 'none';
    }
  } catch (err) {
    console.error('[ShortTube] loadInbox activity failed:', err);
    activityList.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't load activity.</div>`;
    activityPreview.textContent = "Couldn't load activity";
    activityBadge.style.display = 'none';
  }

  try {
    const followers = await ShortTubeSocial.getFollowers(currentUser.$id);
    followersList.innerHTML = followers.length ? followers.map(f => `
      <div class="follower-item">
        <div class="avatar-dot">${escapeHtml((f.name[0]||'?').toUpperCase())}</div>
        <span class="follower-name">${escapeHtml(f.name)}</span>
        <button class="follow-back-btn" data-follower-id="${f.followerId}">Follow Back</button>
        <button class="msg-icon-btn" data-message-user-id="${f.followerId}" aria-label="Message"><i class="bi bi-chat-dots"></i></button>
      </div>`).join('')
      : `<div class="empty-state"><i class="bi bi-people"></i>No followers yet.</div>`;
    wireFollowBackButtons(followersList);
    followersList.querySelectorAll('.msg-icon-btn').forEach(btn => {
      btn.addEventListener('click', () => openDmThreadWithUser(btn.dataset.messageUserId));
    });
    // Summary row preview: latest follower's name + an unread-style count badge.
    if (followers.length){
      followersPreview.textContent = `${followers[0].name} started following you`;
      followersBadge.textContent = followers.length > 99 ? '99+' : String(followers.length);
      followersBadge.style.display = 'inline-flex';
    } else {
      followersPreview.textContent = "See who's following you";
      followersBadge.style.display = 'none';
    }
  } catch (err) {
    console.error('[ShortTube] loadInbox followers failed:', err);
    followersList.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't load followers.</div>`;
    followersPreview.textContent = "Couldn't load followers";
    followersBadge.style.display = 'none';
  }
}

// "Follow Back" on each Inbox follower row — mirrors the person you follow
// back to your own Following list. Pre-checks state per-row so an already-
// mutual follow shows "Following" instead of a misleading "Follow Back".
function wireFollowBackButtons(container){
  container.querySelectorAll('.follow-back-btn').forEach(async (btn) => {
    const targetId = btn.dataset.followerId;
    try {
      const already = await ShortTubeProfile.isFollowing(currentUser.$id, targetId);
      btn.classList.toggle('following', !!already);
      btn.textContent = already ? 'Following' : 'Follow Back';
    } catch (err) { console.warn('[ShortTube] follow-back state check failed:', err); }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const existing = await ShortTubeProfile.isFollowing(currentUser.$id, targetId);
        if (existing) {
          await ShortTubeProfile.unfollow(existing.$id);
          btn.classList.remove('following');
          btn.textContent = 'Follow Back';
        } else {
          await ShortTubeProfile.follow(currentUser.$id, targetId);
          btn.classList.add('following');
          btn.textContent = 'Following';
        }
      } catch (err) {
        console.error('[ShortTube] follow-back toggle failed:', err);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/* =====================================================================
   PRIVATE MESSAGING — Inbox "Messages" tab (conversation list), the
   full-screen DM thread overlay, and the "New Message" user search.
   Backed by js/messaging.js (ShortTubeMessaging). Realtime keeps an
   open thread live-updating without polling.
===================================================================== */
function initialsFor(name){ return escapeHtml((name && name[0] ? name[0] : '?').toUpperCase()); }

async function loadMessagesTab(){
  const listEl = document.getElementById('inboxMessagesList');
  if (!currentUser){
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-chat-dots"></i>Log in to see your messages.</div>`;
    return;
  }
  listEl.innerHTML = `<div class="empty-state"><div class="st-loader" style="margin:0 auto 10px;"></div>Loading...</div>`;
  try {
    const conversations = await ShortTubeMessaging.listConversations(currentUser.$id);
    listEl.innerHTML = conversations.length ? conversations.map(c => `
      <div class="conversation-item" data-conversation-id="${c.$id}" data-other-id="${c.otherId}" data-other-name="${escapeHtml(c.otherName)}">
        <div class="avatar-dot">${initialsFor(c.otherName)}</div>
        <div class="cv-body">
          <div class="cv-name">${escapeHtml(c.otherName)}</div>
          <div class="cv-last">${c.lastMessage ? escapeHtml(c.lastMessage) : 'Say hello 👋'}</div>
        </div>
        <div class="cv-time">${c.lastMessageAt ? timeAgo(c.lastMessageAt) : ''}</div>
      </div>`).join('')
      : `<div class="empty-state"><i class="bi bi-chat-dots"></i>No messages yet. Visit someone's profile and tap "Message" to start a conversation.</div>`;
    listEl.querySelectorAll('.conversation-item').forEach(row => {
      row.addEventListener('click', () => openDmThread(row.dataset.conversationId, row.dataset.otherId, row.dataset.otherName));
    });
  } catch (err) {
    console.error('[ShortTube] loadMessagesTab failed:', err);
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't load messages. Make sure the "conversations"/"messages" collections exist in Appwrite (see appwrite-config.js).</div>`;
  }
}

// Entry point used from a follower row or a profile's Message button —
// resolves/creates the conversation first, then opens the thread.
async function openDmThreadWithUser(otherId){
  if (!requireAuth('message this user')) return;
  if (!otherId || otherId === currentUser.$id) return;
  try {
    const [conv, otherName] = await Promise.all([
      ShortTubeMessaging.getOrCreateConversation(currentUser.$id, otherId),
      ShortTubeSocial.getDisplayName(otherId)
    ]);
    openDmThread(conv.$id, otherId, otherName);
  } catch (err) {
    console.error('[ShortTube] openDmThreadWithUser failed:', err);
    alert("Couldn't open that conversation right now.");
  }
}
window.openDmThreadWithUser = openDmThreadWithUser;

let activeDmConversationId = null;
let activeDmOtherId = null;
async function openDmThread(conversationId, otherId, otherName){
  activeDmConversationId = conversationId;
  activeDmOtherId = otherId;
  document.getElementById('dmThreadName').textContent = otherName || 'Conversation';
  document.getElementById('dmThreadAvatar').textContent = initialsFor(otherName);
  const body = document.getElementById('dmThreadBody');
  body.innerHTML = `<div class="empty-state"><div class="st-loader" style="margin:0 auto;"></div></div>`;
  document.getElementById('dmThreadOverlay').classList.add('active');

  try {
    const messages = await ShortTubeMessaging.listMessages(conversationId);
    renderDmMessages(messages);
  } catch (err) {
    console.error('[ShortTube] listMessages failed:', err);
    body.innerHTML = `<div class="empty-state"><i class="bi bi-wifi-off"></i>Couldn't load this conversation.</div>`;
  }

  ShortTubeMessaging.subscribeToConversation(conversationId, (doc) => {
    appendDmMessage(doc);
  });
}

function dmBubbleHtml(m){
  const mine = m.senderId === currentUser?.$id;
  const time = m.createdAt || m.$createdAt;
  return `<div class="dm-msg ${mine ? 'me' : 'them'}">${escapeHtml(m.text)}<span class="dm-time">${time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>`;
}
function renderDmMessages(messages){
  const body = document.getElementById('dmThreadBody');
  body.innerHTML = messages.length
    ? messages.map(dmBubbleHtml).join('')
    : `<div class="empty-state"><i class="bi bi-chat-heart"></i>No messages yet. Say hello 👋</div>`;
  body.scrollTop = body.scrollHeight;
}
function appendDmMessage(m){
  // Realtime can echo back a message we just sent optimistically — skip
  // exact duplicates by $id so it doesn't render twice.
  const body = document.getElementById('dmThreadBody');
  if (body.querySelector(`[data-msg-id="${m.$id}"]`)) return;
  const wasEmpty = body.querySelector('.empty-state');
  if (wasEmpty) body.innerHTML = '';
  body.insertAdjacentHTML('beforeend', dmBubbleHtml(m).replace('<div class="dm-msg', `<div data-msg-id="${m.$id}" class="dm-msg`));
  body.scrollTop = body.scrollHeight;
}

document.getElementById('closeDmThread').addEventListener('click', () => {
  document.getElementById('dmThreadOverlay').classList.remove('active');
  ShortTubeMessaging.unsubscribe();
  activeDmConversationId = null;
  activeDmOtherId = null;
});

async function sendDmMessage(){
  const input = document.getElementById('dmThreadInput');
  const text = input.value.trim();
  if (!text || !activeDmConversationId) return;
  input.value = '';
  try {
    const doc = await ShortTubeMessaging.sendMessage(activeDmConversationId, currentUser.$id, activeDmOtherId, text);
    if (doc) appendDmMessage(doc);
  } catch (err) {
    console.error('[ShortTube] sendMessage failed:', err);
    alert("Couldn't send that message. Please try again.");
  }
}
document.getElementById('dmThreadSend').addEventListener('click', sendDmMessage);
document.getElementById('dmThreadInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDmMessage(); });

/* Starting a NEW conversation only ever happens from the other person's
   profile now (their "Message" button → openDmThreadWithUser), so there's
   no standalone "New Message" search/picker here anymore. */

/* ---------------- Chat with Support Team (local placeholder) ---------------- */
// NOTE: this is a lightweight local mock — messages aren't sent anywhere yet.
// Wire supportChatSend to a real support backend/ticketing endpoint when one exists.
document.getElementById('supportChatSend').addEventListener('click', () => {
  if (!requireAuth('message support')) return;
  const input = document.getElementById('supportChatInput');
  const text = input.value.trim();
  if (!text) return;
  const log = document.getElementById('supportChatLog');
  log.insertAdjacentHTML('beforeend', `<div class="support-msg me">${escapeHtml(text)}</div>`);
  input.value = '';
  log.scrollTop = log.scrollHeight;
  setTimeout(() => {
    log.insertAdjacentHTML('beforeend', `<div class="support-msg them">Thanks for reaching out! Our team will follow up here soon.</div>`);
    log.scrollTop = log.scrollHeight;
  }, 700);
});

/* =====================================================================
   PHYSICAL BACK BUTTON (Android) — closes the topmost open overlay/modal
   first; if nothing is open and we're not on Home, jumps to Home; only
   exits the app as a last resort. Works two ways:
     1. Native APK (Capacitor): listens on the @capacitor/app "backButton"
        event. Requires `npm install @capacitor/app && npx cap sync android`
        in the build pipeline — this file degrades to a no-op wiring if
        that plugin isn't installed, so it's always safe to ship.
     2. Browser / installed PWA: falls back to intercepting the browser's
        own back navigation via history.pushState()/popstate, so the same
        "close overlay, then go Home, then exit" order applies there too.
===================================================================== */
function topActiveOverlayForBack(){
  // Ordered innermost-first: whichever of these is open, closing it should
  // never also close something layered underneath it.
  const selectors = [
    '#commentSheet.open',
    '.modal-overlay.active',
    '#dmThreadOverlay.active',
    '#playerOverlay.active',
    '#imageViewerOverlay.active',
    '.static-overlay.active'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}
function handlePhysicalBack(){
  const overlay = topActiveOverlayForBack();
  if (overlay) {
    if (overlay.id === 'commentSheet') { closeCommentSheet(); return; }
    if (overlay.id === 'playerOverlay') { document.getElementById('closePlayer').click(); return; }
    if (overlay.id === 'dmThreadOverlay') { document.getElementById('closeDmThread').click(); return; }
    overlay.classList.remove('active');
    return;
  }
  const activeTab = document.querySelector('.nav-btn.active');
  if (activeTab && activeTab.dataset.tab !== 'home') {
    document.querySelector('.nav-btn[data-tab="home"]')?.click();
    return;
  }
  // Nothing left to close and already on Home — let the OS handle it
  // (exits the app on native; browsers back out of the page normally).
  if (window.Capacitor?.Plugins?.App) window.Capacitor.Plugins.App.exitApp();
}
if (window.Capacitor?.Plugins?.App) {
  window.Capacitor.Plugins.App.addListener('backButton', handlePhysicalBack);
} else {
  // Browser fallback: keep one extra history entry "primed" so every real
  // back gesture fires popstate instead of leaving the page immediately.
  history.pushState({ shortTubeGuard: true }, '');
  window.addEventListener('popstate', () => {
    history.pushState({ shortTubeGuard: true }, '');
    handlePhysicalBack();
  });
}
