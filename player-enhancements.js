/* =====================================================================
   player-enhancements.js — Play/Pause + Double-tap-to-seek
   ---------------------------------------------------------------------
   IMPORTANT SCOPE NOTE: double-tap seek and direct play/pause control
   only work on a real <video> element — they do NOT work on YouTube or
   YouTube <iframe> embeds, since cross-origin iframes don't expose
   their internal player to your JavaScript. That's exactly why this only
   attaches to Appwrite-hosted (self-hosted <video>) playback — which
   also lines up with the ad policy: only your own uploads get the full
   native-feeling player treatment.

   Usage: call attachEnhancedPlayer(videoEl, videoDoc) once you've set
   videoEl.src to the Appwrite-hosted file and inserted it into the DOM,
   for either the long-form player overlay or a Shorts slide.
===================================================================== */

const SEEK_SECONDS = 4; // within your requested 3–5s range

function attachEnhancedPlayer(videoEl, videoDoc) {
  let lastTapTime = 0;
  let lastTapX = 0;

  // ---- Tap to play/pause (single tap) ----
  videoEl.addEventListener('click', (e) => {
    const now = Date.now();
    const isDoubleTap = (now - lastTapTime) < 300;
    lastTapTime = now;
    lastTapX = e.offsetX;

    if (isDoubleTap) {
      handleDoubleTapSeek(videoEl, e.offsetX, videoEl.clientWidth);
    } else {
      // Delay the single-tap play/pause slightly so it doesn't fire
      // right before a double-tap is recognized
      setTimeout(() => {
        if (Date.now() - lastTapTime >= 280) {
          videoEl.paused ? videoEl.play() : videoEl.pause();
        }
      }, 300);
    }
  });

  // ---- Engagement tracking hooks (algorithm.js) ----
  videoEl.addEventListener('play', () => ShortTubeAlgorithm.startTracking(videoDoc, videoEl));
  videoEl.addEventListener('pause', () => ShortTubeAlgorithm.stopTracking(videoDoc, videoEl));
  videoEl.addEventListener('ended', () => ShortTubeAlgorithm.stopTracking(videoDoc, videoEl));

  // Also flush watch-time if the user navigates away / closes the tab
  window.addEventListener('beforeunload', () => {
    if (!videoEl.paused) ShortTubeAlgorithm.stopTracking(videoDoc, videoEl);
  });
}

function handleDoubleTapSeek(videoEl, tapX, elementWidth) {
  const isRightHalf = tapX > elementWidth / 2;
  if (isRightHalf) {
    videoEl.currentTime = Math.min(videoEl.duration, videoEl.currentTime + SEEK_SECONDS);
    showSeekFeedback(videoEl, `+${SEEK_SECONDS}s`, 'right');
  } else {
    videoEl.currentTime = Math.max(0, videoEl.currentTime - SEEK_SECONDS);
    showSeekFeedback(videoEl, `-${SEEK_SECONDS}s`, 'left');
  }
}

/* Small flash animation so the seek feels responsive, YouTube-style */
function showSeekFeedback(videoEl, label, side) {
  const parent = videoEl.parentElement;
  if (!parent) return;
  const flash = document.createElement('div');
  flash.textContent = label;
  flash.style.cssText = `
    position:absolute; top:50%; ${side}:20%; transform:translateY(-50%);
    background:rgba(0,0,0,.6); color:#fff; padding:8px 14px; border-radius:20px;
    font-size:.85rem; font-weight:600; pointer-events:none; z-index:10;
    animation:seekFlash .6s ease forwards;`;
  if (!document.getElementById('seekFlashKeyframes')) {
    const style = document.createElement('style');
    style.id = 'seekFlashKeyframes';
    style.textContent = `@keyframes seekFlash{0%{opacity:0;} 20%{opacity:1;} 100%{opacity:0;}}`;
    document.head.appendChild(style);
  }
  parent.style.position = parent.style.position || 'relative';
  parent.appendChild(flash);
  setTimeout(() => flash.remove(), 600);
}

window.attachEnhancedPlayer = attachEnhancedPlayer;
