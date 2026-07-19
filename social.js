/* =====================================================================
   social.js — Persisted likes & comments + Inbox aggregation
   ---------------------------------------------------------------------
   Depends on appwrite-config.js and auth.js being loaded first.

   videoId convention: for Appwrite-hosted uploads we store the RAW
   document $id (so it lines up with the `ownerId` lookups used by the
   Inbox), for external (YouTube) videos we store the
   composite "source:id" key instead, since those never have an owner
   in our system and only need to be unique per video.
===================================================================== */

const ShortTubeSocial = {

  /* ---------------- Likes ---------------- */
  async findMyLike(videoId, userId) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.LIKES,
      [Query.equal('videoId', videoId), Query.equal('userId', userId), Query.limit(1)]
    );
    return res.documents[0] || null;
  },

  // Returns { requiresAuth: true } if not logged in, otherwise { liked: bool }
  async toggleLike(videoId) {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) return { requiresAuth: true };

    const existing = await this.findMyLike(videoId, me.$id);
    if (existing) {
      await databases.deleteDocument(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.LIKES, existing.$id);
      return { liked: false };
    }
    await databases.createDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.LIKES, ID.unique(),
      { videoId, userId: me.$id },
      [Permission.read(Role.any()), Permission.delete(Role.user(me.$id))]
    );
    return { liked: true };
  },

  async isLikedByMe(videoId) {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) return false;
    return !!(await this.findMyLike(videoId, me.$id));
  },

  /* ---------------- Comments ---------------- */
  async listComments(videoId) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.COMMENTS,
      [Query.equal('videoId', videoId), Query.orderDesc('$createdAt'), Query.limit(50)]
    );
    return res.documents;
  },

  // Returns { requiresAuth: true } if not logged in, otherwise { comment }
  async postComment(videoId, text) {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) return { requiresAuth: true };
    const doc = await databases.createDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.COMMENTS, ID.unique(),
      { videoId, userId: me.$id, text, createdAt: new Date().toISOString() },
      [Permission.read(Role.any()), Permission.delete(Role.user(me.$id))]
    );
    return { comment: doc };
  },

  /* ---------------- Inbox: activity received on MY uploaded videos ---------------- */
  async getMyVideoIds(userId) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
      [Query.equal('ownerId', userId), Query.limit(100)]
    );
    return res.documents.map(v => v.$id);
  },

  async getInboxActivity(userId) {
    const videoIds = await this.getMyVideoIds(userId);
    if (videoIds.length === 0) return [];

    const [likesRes, commentsRes] = await Promise.all([
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.LIKES,
        [Query.equal('videoId', videoIds), Query.limit(50)]),
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.COMMENTS,
        [Query.equal('videoId', videoIds), Query.orderDesc('$createdAt'), Query.limit(50)])
    ]);

    const likeItems = likesRes.documents
      .filter(d => d.userId !== userId) // don't notify yourself about your own like
      .map(d => ({ type: 'like', userId: d.userId, at: d.$createdAt }));
    const commentItems = commentsRes.documents
      .filter(d => d.userId !== userId)
      .map(d => ({ type: 'comment', userId: d.userId, text: d.text, at: d.$createdAt }));

    const combined = [...likeItems, ...commentItems].sort((a, b) => new Date(b.at) - new Date(a.at));

    // Resolve display names in parallel (small list, fine to do per-open)
    await Promise.all(combined.map(async (item) => {
      item.who = await this.getDisplayName(item.userId);
    }));
    return combined;
  },

  /* ---------------- Inbox: Followers ---------------- */
  async getFollowers(userId) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.FOLLOWS,
      [Query.equal('followingId', userId), Query.limit(100)]
    );
    const withNames = await Promise.all(res.documents.map(async (d) => ({
      followerId: d.followerId,
      name: await this.getDisplayName(d.followerId)
    })));
    return withNames;
  },

  async getDisplayName(userId) {
    try {
      const doc = await databases.getDocument(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, userId);
      return doc.displayName || 'ShortTube User';
    } catch {
      return 'ShortTube User';
    }
  },

  /* =====================================================================
     Content moderation: user reports
     ---------------------------------------------------------------------
     Only Appwrite-hosted (own-upload) videos can be reported/removed by
     ShortTube — reports on YouTube content are logged too
     (for our own record) but those platforms handle their own removals.

     REPORTS_AUTO_HIDE_THRESHOLD: once an uploaded video collects this many
     distinct reports, feed.js hides it from Home/Shorts automatically
     (moderationStatus is flipped to 'pending') pending human review —
     this is a basic community-flagging safety net, not a replacement for
     real automated visual moderation (see upload.js for where a real
     vision-moderation API call would plug in — that now has to be an
     Appwrite Function, since this app no longer has any server of its own).
  ===================================================================== */
  REPORTS_AUTO_HIDE_THRESHOLD: 3,

  async reportVideo(videoId, reason) {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) return { requiresAuth: true };

    await databases.createDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.REPORTS, ID.unique(),
      { videoId, reporterId: me.$id, reason: reason || 'unspecified', createdAt: new Date().toISOString() },
      [Permission.read(Role.any())]
    );

    // Only Appwrite-hosted uploads have a document we can flag/hide.
    try {
      const res = await databases.listDocuments(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.REPORTS,
        [Query.equal('videoId', videoId), Query.limit(100)]
      );
      if (res.total >= this.REPORTS_AUTO_HIDE_THRESHOLD) {
        await databases.updateDocument(
          APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS, videoId,
          { moderationStatus: 'pending' }
        ).catch(() => {}); // no-op if videoId isn't one of our own upload docs
      }
    } catch (err) {
      console.warn('[ShortTube] report auto-hide check failed:', err);
    }
    return { reported: true };
  }
};

window.ShortTubeSocial = ShortTubeSocial;
