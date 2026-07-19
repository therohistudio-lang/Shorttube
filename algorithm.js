/* =====================================================================
   algorithm.js — Engagement-based visibility boost
   ---------------------------------------------------------------------
   Rule as specified: on a ~10-minute video, once a viewer has watched
   8+ minutes (80%+), that view counts as "high engagement" and nudges
   the video's engagementScore up. Videos are then sorted higher in the
   feed as their score grows. Uses a ratio (watched / duration >= 0.8)
   so it scales correctly for videos that aren't exactly 10 minutes.

   This only applies to Appwrite-hosted (user-uploaded) videos — YouTube
   videos aren't yours to re-rank by watch time, and their
   own platforms already handle that.
===================================================================== */

const ENGAGEMENT_THRESHOLD_RATIO = 0.8; // 8 of 10 minutes
const HIGH_ENGAGEMENT_POINTS = 5;
const NORMAL_VIEW_POINTS = 1;

const ShortTubeAlgorithm = {
  // Call this periodically (e.g. every 5s) while a video plays, and once
  // more on pause/close with the final watched time.
  activeWatchTimers: {},

  startTracking(videoDoc, mediaEl) {
    const key = videoDoc.$id;
    if (this.activeWatchTimers[key]) clearInterval(this.activeWatchTimers[key]);

    this.activeWatchTimers[key] = setInterval(() => {
      if (!mediaEl.paused && !mediaEl.ended) {
        this._recordProgress(videoDoc, mediaEl.currentTime);
      }
    }, 5000);
  },

  stopTracking(videoDoc, mediaEl) {
    const key = videoDoc.$id;
    if (this.activeWatchTimers[key]) {
      clearInterval(this.activeWatchTimers[key]);
      delete this.activeWatchTimers[key];
    }
    this._recordProgress(videoDoc, mediaEl.currentTime, true);
  },

  async _recordProgress(videoDoc, watchedSeconds, isFinal = false) {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) return; // only logged-in views count toward the algorithm

    const ratio = videoDoc.durationSeconds > 0 ? watchedSeconds / videoDoc.durationSeconds : 0;
    const isHighEngagement = ratio >= ENGAGEMENT_THRESHOLD_RATIO;

    // Log the raw watch event — useful later for analytics/creator dashboards
    if (isFinal) {
      await databases.createDocument(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.WATCH_EVENTS, ID.unique(),
        {
          videoId: videoDoc.$id,
          userId: me.$id,
          watchedSeconds: Math.round(watchedSeconds),
          durationSeconds: videoDoc.durationSeconds
        },
        [Permission.read(Role.user(me.$id))]
      ).catch(() => {}); // non-critical — don't block playback on logging failures
    }

    // Bump the visibility score once per session when the threshold is first crossed
    if (isHighEngagement && !this._alreadyBoostedThisSession(videoDoc.$id)) {
      this._markBoostedThisSession(videoDoc.$id);
      await this._incrementScore(videoDoc.$id, HIGH_ENGAGEMENT_POINTS);
    } else if (isFinal && !isHighEngagement) {
      await this._incrementScore(videoDoc.$id, NORMAL_VIEW_POINTS);
    }
  },

  async _incrementScore(videoId, points) {
    try {
      const doc = await databases.getDocument(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS, videoId);
      await databases.updateDocument(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS, videoId,
        { engagementScore: (doc.engagementScore || 0) + points }
      );
    } catch (err) {
      console.warn("Could not update engagement score:", err.message);
    }
  },

  // Session-scoped guard so one viewer watching the same video twice in a
  // row doesn't farm the score endlessly within a single sitting.
  _alreadyBoostedThisSession(videoId) {
    return sessionStorage.getItem(`boosted:${videoId}`) === '1';
  },
  _markBoostedThisSession(videoId) {
    sessionStorage.setItem(`boosted:${videoId}`, '1');
  },

  // Used by feed.js to rank Appwrite videos before merging them into the feed
  rankByEngagement(videos) {
    return videos.slice().sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0));
  }
};

window.ShortTubeAlgorithm = ShortTubeAlgorithm;
