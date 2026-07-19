/* =====================================================================
   profile.js — Edit Profile + Follow system + social stats
   ---------------------------------------------------------------------
   Depends on appwrite-config.js and auth.js being loaded first.

   HTML hooks this expects to exist in index.html (see html-injections.html
   for the exact markup to paste in):
     #editProfileBtn        - opens the edit modal
     #editProfileModal       - the modal itself
     #editNameInput          - text input for display name
     #editAvatarInput        - <input type="file" accept="image/*">
     #editAvatarPreview      - <img> preview
     #saveProfileBtn         - submit button
     #profileAvatarImg       - the avatar shown on the profile page itself
     #profileDisplayName     - the name shown on the profile page
     #statFollowersVal / #statFollowingVal / #statPostsVal
     #followBtn              - Follow / Following toggle button
===================================================================== */

const ShortTubeProfile = {

  /* ---------------- Load + render a profile ---------------- */
  async loadProfile(userId, viewingOwnProfile = true) {
    let doc;
    try {
      doc = await databases.getDocument(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, userId
      );
    } catch (err) {
      // BUG FIX: any account that reached this point without a profile doc
      // (e.g. created directly in the Appwrite console, or via an older
      // build that only created docs on email/password signup) would
      // otherwise show a broken/blank profile forever. Self-heal by
      // creating a default doc now, then re-fetch it.
      console.warn('[ShortTube] No profile doc for', userId, '— creating a default one.', err);
      const me = viewingOwnProfile ? await ShortTubeAuth.getCurrentUser() : null;
      await window.ensureProfileDocument(userId, me?.name || "ShortTube User");
      doc = await databases.getDocument(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, userId
      );
    }

    document.getElementById('profileDisplayName').textContent = doc.displayName;
    const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 74 74'%3E%3Crect width='74' height='74' rx='18' fill='%23EEF1F5'/%3E%3Ccircle cx='37' cy='29' r='13' fill='%23AEB6C4'/%3E%3Cpath d='M14 63c2-14 13-21 23-21s21 7 23 21' fill='%23AEB6C4'/%3E%3C/svg%3E";
    document.getElementById('profileAvatarImg').src = doc.avatarFileId
      ? storage.getFileView(APPWRITE_CONFIG.BUCKETS.AVATARS, doc.avatarFileId).href
      : DEFAULT_AVATAR; // falls back to a neutral generic avatar, not the brand logo

    // Banner: falls back to the CSS brand-gradient (see .profile-banner-wrap)
    // when the account has never set one, rather than showing a broken image.
    const bannerImg = document.getElementById('profileBannerImg');
    if (doc.bannerFileId) {
      bannerImg.src = storage.getFileView(APPWRITE_CONFIG.BUCKETS.BANNERS, doc.bannerFileId).href;
      bannerImg.classList.add('set');
    } else {
      bannerImg.removeAttribute('src');
      bannerImg.classList.remove('set');
    }

    const [followers, following, posts] = await Promise.all([
      this.countFollowers(userId),
      this.countFollowing(userId),
      this.countPosts(userId)
    ]);
    document.getElementById('statFollowersVal').textContent = followers;
    document.getElementById('statFollowingVal').textContent = following;
    document.getElementById('statPostsVal').textContent = posts;

    // Bio is kept as hidden data only (read/written by the Edit Profile
    // modal) — it's not part of the on-page Facebook-style design, so it
    // never becomes visible here.
    const bioEl = document.getElementById('profileBioText');
    bioEl.textContent = (doc.bio && doc.bio.trim()) ? doc.bio : '';

    const followBtn = document.getElementById('followBtn');
    const messageBtn = document.getElementById('messageProfileBtn');
    if (viewingOwnProfile) {
      followBtn.style.display = 'none';
      messageBtn.style.display = 'none';
    } else {
      followBtn.style.display = 'inline-flex';
      messageBtn.style.display = 'inline-flex';
      messageBtn.onclick = () => window.openDmThreadWithUser?.(userId);
      const me = await ShortTubeAuth.getCurrentUser();
      const isFollowing = me ? await this.isFollowing(me.$id, userId) : false;
      this.renderFollowButton(followBtn, isFollowing, userId);
    }

    this.renderProfileFeed(userId).catch(err => console.error('[ShortTube] renderProfileFeed failed:', err));
  },

  /* ---------------- Profile feed: this user's own uploads (videos + photos),
     newest first — a simple 3-column grid, TikTok/Instagram-profile style. ---- */
  async getMyContent(userId) {
    const [videosRes, imagesRes] = await Promise.all([
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
        [Query.equal('ownerId', userId), Query.orderDesc('$createdAt'), Query.limit(50)]),
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.IMAGES,
        [Query.equal('ownerId', userId), Query.orderDesc('$createdAt'), Query.limit(50)])
    ]);
    const videos = videosRes.documents
      .filter(d => d.moderationStatus !== 'removed')
      .map(d => ({
        type: 'video', id: d.$id, createdAt: d.$createdAt,
        thumbnailUrl: d.thumbnailFileId ? storage.getFileView(APPWRITE_CONFIG.BUCKETS.VIDEO_THUMBS, d.thumbnailFileId).href : 'logo.png',
        _raw: d
      }));
    const images = imagesRes.documents
      .filter(d => d.moderationStatus !== 'removed')
      .map(d => ({
        type: 'image', id: d.$id, createdAt: d.$createdAt,
        thumbnailUrl: storage.getFileView(APPWRITE_CONFIG.BUCKETS.IMAGE_FILES, d.imageFileId).href,
        _raw: d
      }));
    // Chronological order (newest first) across BOTH content types combined.
    return [...videos, ...images].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async renderProfileFeed(userId) {
    const grid = document.getElementById('profileFeedGrid');
    if (!grid) return;
    grid.innerHTML = `<div class="empty-state" style="padding:30px 10px;"><div class="st-loader" style="margin:0 auto;"></div></div>`;
    const items = await this.getMyContent(userId);
    if (!items.length) {
      grid.innerHTML = `<div class="empty-state"><i class="bi bi-grid"></i>No posts yet.</div>`;
      return;
    }
    // Facebook-profile style: one full-width card per post, in upload order
    // (newest first), photos and videos mixed exactly as posted — not a grid.
    grid.innerHTML = items.map(item => `
      <div class="fb-post-card type-${item.type}" data-type="${item.type}" data-id="${item.id}">
        <img data-src="${item.thumbnailUrl}" alt="" loading="lazy" decoding="async">
        ${item.type === 'video' ? '<i class="bi bi-play-circle-fill fb-post-play"></i>' : ''}
      </div>`).join('');
    if (typeof observeLazyImages === 'function') observeLazyImages(grid);
    grid.querySelectorAll('.fb-post-card').forEach(el => {
      const item = items.find(i => i.id === el.dataset.id && i.type === el.dataset.type);
      el.addEventListener('click', () => window.openProfileFeedItem?.(item));
    });
  },

  /* ---------------- Unique display-name check ----------------
     Exact-match on the `displayName` attribute (Appwrite's equal query is
     case-sensitive); excludes the account's own current document so
     re-saving your own unchanged name never falsely reports "taken". */
  async isDisplayNameTaken(name, excludingUserId) {
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES,
      [Query.equal('displayName', trimmed), Query.limit(5)]
    );
    return res.documents.some(d => d.$id !== excludingUserId);
  },

  /* ---------------- Edit Profile (name + bio + avatar + banner) ---------------- */
  async saveProfileEdits(userId, newName, avatarFile, bannerFile, bio) {
    const updates = { displayName: newName };
    if (typeof bio === 'string') updates.bio = bio.slice(0, 150);

    if (avatarFile) {
      // Upload the new avatar to Appwrite Storage, then link its file ID on the profile doc
      const uploaded = await storage.createFile(
        APPWRITE_CONFIG.BUCKETS.AVATARS, ID.unique(), avatarFile,
        [Permission.read(Role.any()), Permission.update(Role.user(userId))]
      );
      updates.avatarFileId = uploaded.$id;
    }
    if (bannerFile) {
      const uploadedBanner = await storage.createFile(
        APPWRITE_CONFIG.BUCKETS.BANNERS, ID.unique(), bannerFile,
        [Permission.read(Role.any()), Permission.update(Role.user(userId))]
      );
      updates.bannerFileId = uploadedBanner.$id;
    }

    const updatedDoc = await databases.updateDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, userId, updates
    );

    // Reflect the change immediately in the UI — no page reload needed
    document.getElementById('profileDisplayName').textContent = updatedDoc.displayName;
    const bioEl = document.getElementById('profileBioText');
    if (typeof updates.bio === 'string') {
      bioEl.textContent = updates.bio;
    }
    if (updates.avatarFileId) {
      document.getElementById('profileAvatarImg').src =
        storage.getFileView(APPWRITE_CONFIG.BUCKETS.AVATARS, updates.avatarFileId).href;
    }
    if (updates.bannerFileId) {
      const bannerImg = document.getElementById('profileBannerImg');
      bannerImg.src = storage.getFileView(APPWRITE_CONFIG.BUCKETS.BANNERS, updates.bannerFileId).href;
      bannerImg.classList.add('set');
    }
    return updatedDoc;
  },

  /* ---------------- Follow / Unfollow ---------------- */
  async isFollowing(followerId, followingId) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.FOLLOWS,
      [Query.equal('followerId', followerId), Query.equal('followingId', followingId)]
    );
    return res.documents.length > 0 ? res.documents[0] : false;
  },

  async follow(followerId, followingId) {
    return databases.createDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.FOLLOWS, ID.unique(),
      { followerId, followingId },
      [Permission.read(Role.any()), Permission.delete(Role.user(followerId))]
    );
  },

  async unfollow(followDocId) {
    return databases.deleteDocument(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.FOLLOWS, followDocId);
  },

  renderFollowButton(btn, isFollowingDocOrFalse, targetUserId) {
    const setState = (following) => {
      btn.textContent = following ? "Following" : "Follow";
      btn.classList.toggle('following', !!following);
    };
    setState(isFollowingDocOrFalse);

    btn.onclick = async () => {
      const me = await ShortTubeAuth.getCurrentUser();
      if (!me) { alert("Please log in to follow creators."); return; }

      const current = await this.isFollowing(me.$id, targetUserId);
      btn.disabled = true;
      try {
        if (current) {
          await this.unfollow(current.$id);
          setState(false);
        } else {
          await this.follow(me.$id, targetUserId);
          setState(true);
        }
        const followerCount = await this.countFollowers(targetUserId);
        document.getElementById('statFollowersVal').textContent = followerCount;
      } finally {
        btn.disabled = false;
      }
    };
  },

  /* ---------------- Stat counters ---------------- */
  async countFollowers(userId) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.FOLLOWS,
      [Query.equal('followingId', userId), Query.limit(1)]
    );
    return res.total;
  },

  async countFollowing(userId) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.FOLLOWS,
      [Query.equal('followerId', userId), Query.limit(1)]
    );
    return res.total;
  },

  // Total posts (videos + photos combined) for the Facebook-style
  // "X followers · Y following · Z posts" line on the profile page.
  async countPosts(userId) {
    const [videosRes, imagesRes] = await Promise.all([
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
        [Query.equal('ownerId', userId), Query.limit(1)]),
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.IMAGES,
        [Query.equal('ownerId', userId), Query.limit(1)])
    ]);
    return videosRes.total + imagesRes.total;
  },

  async countLikesReceived(userId) {
    // Likes on videos owned by this user. Requires videos to store ownerId,
    // and likes to store videoId — this does a two-step lookup.
    const videos = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
      [Query.equal('ownerId', userId), Query.limit(100)]
    );
    const videoIds = videos.documents.map(v => v.$id);
    if (videoIds.length === 0) return 0;
    const likes = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.LIKES,
      [Query.equal('videoId', videoIds), Query.limit(1)]
    );
    return likes.total;
  },

  async countCommentsReceived(userId) {
    const videos = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
      [Query.equal('ownerId', userId), Query.limit(100)]
    );
    const videoIds = videos.documents.map(v => v.$id);
    if (videoIds.length === 0) return 0;
    const comments = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.COMMENTS,
      [Query.equal('videoId', videoIds), Query.limit(1)]
    );
    return comments.total;
  },

  /* ---------------- Studio: views (used by the Studio analytics tab) ----------------
     A "view" is counted as one logged watch_events record (algorithm.js writes one
     each time a viewer finishes/pauses one of this user's uploaded videos). This is
     an approximation — good enough for a creator dashboard — not a strictly
     deduplicated unique-viewer count. */
  async countViewsReceived(userId) {
    const videos = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
      [Query.equal('ownerId', userId), Query.limit(100)]
    );
    const videoIds = videos.documents.map(v => v.$id);
    if (videoIds.length === 0) return 0;
    const views = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.WATCH_EVENTS,
      [Query.equal('videoId', videoIds), Query.limit(1)]
    );
    return views.total;
  },

  // Per-video breakdown for the Studio tab: views, likes, comments, and
  // moderation status for every video this user has uploaded.
  async getMyVideoStats(userId) {
    const videos = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
      [Query.equal('ownerId', userId), Query.orderDesc('$createdAt'), Query.limit(50)]
    );
    return Promise.all(videos.documents.map(async (doc) => {
      const [viewsRes, likesRes, commentsRes] = await Promise.all([
        databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.WATCH_EVENTS, [Query.equal('videoId', doc.$id), Query.limit(1)]),
        databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.LIKES, [Query.equal('videoId', doc.$id), Query.limit(1)]),
        databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.COMMENTS, [Query.equal('videoId', doc.$id), Query.limit(1)])
      ]);
      return {
        id: doc.$id,
        title: doc.title,
        thumbnailUrl: doc.thumbnailFileId ? storage.getFileView(APPWRITE_CONFIG.BUCKETS.VIDEO_THUMBS, doc.thumbnailFileId).href : 'logo.png',
        views: viewsRes.total,
        likes: likesRes.total,
        comments: commentsRes.total,
        moderationStatus: doc.moderationStatus || 'live'
      };
    }));
  }
};

/* ---------------- Wire up the Edit Profile modal ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  const editBtn = document.getElementById('editProfileBtn');
  const modal = document.getElementById('editProfileModal');
  const nameInput = document.getElementById('editNameInput');
  const nameCheckRow = document.getElementById('nameCheckRow');
  const bioInput = document.getElementById('editBioInput');
  const avatarInput = document.getElementById('editAvatarInput');
  const avatarPreview = document.getElementById('editAvatarPreview');
  const bannerInput = document.getElementById('editBannerInput');
  const bannerPreview = document.getElementById('editBannerPreview');
  const saveBtn = document.getElementById('saveProfileBtn');
  if (!editBtn) return; // markup not present on this page

  let pendingAvatarFile = null;
  let pendingBannerFile = null;
  let nameIsAvailable = true; // becomes false only when a live check confirms a collision
  let originalName = '';

  editBtn.addEventListener('click', async () => {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) { alert("Please log in first."); return; }
    originalName = document.getElementById('profileDisplayName').textContent;
    nameInput.value = originalName;
    bioInput.value = document.getElementById('profileBioText').textContent || '';
    nameCheckRow.textContent = '';
    nameCheckRow.className = 'name-check-row';
    nameIsAvailable = true;
    avatarPreview.src = document.getElementById('profileAvatarImg').src;
    const currentBanner = document.getElementById('profileBannerImg');
    if (currentBanner.classList.contains('set')) {
      bannerPreview.src = currentBanner.src;
      bannerPreview.classList.add('set');
    } else {
      bannerPreview.removeAttribute('src');
      bannerPreview.classList.remove('set');
    }
    modal.classList.add('active');
  });

  // Live, debounced uniqueness check as the person types a new name —
  // never fires if the value is unchanged from their current name.
  let nameCheckTimer = null;
  nameInput.addEventListener('input', () => {
    clearTimeout(nameCheckTimer);
    const val = nameInput.value.trim();
    if (!val || val === originalName) {
      nameCheckRow.textContent = '';
      nameCheckRow.className = 'name-check-row';
      nameIsAvailable = true;
      return;
    }
    nameCheckRow.textContent = 'Checking availability...';
    nameCheckRow.className = 'name-check-row checking';
    nameCheckTimer = setTimeout(async () => {
      const me = await ShortTubeAuth.getCurrentUser();
      try {
        const taken = await ShortTubeProfile.isDisplayNameTaken(val, me?.$id);
        nameIsAvailable = !taken;
        nameCheckRow.textContent = taken ? 'That name is already taken.' : 'Name is available.';
        nameCheckRow.className = 'name-check-row ' + (taken ? 'taken' : 'available');
      } catch (err) {
        console.warn('[ShortTube] name availability check failed:', err);
      }
    }, 450);
  });

  avatarInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAvatarFile = file;
    avatarPreview.src = URL.createObjectURL(file);
  });

  bannerInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingBannerFile = file;
    bannerPreview.src = URL.createObjectURL(file);
    bannerPreview.classList.add('set');
  });

  saveBtn.addEventListener('click', async () => {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) return;
    const newName = nameInput.value.trim();
    if (!newName) { alert("Please enter a display name."); return; }
    // Final authoritative check right before saving (covers the case where
    // someone else claimed the name in the few hundred ms since the last
    // debounced check, or the person saved before that check finished).
    if (newName !== originalName) {
      const taken = await ShortTubeProfile.isDisplayNameTaken(newName, me.$id).catch(() => false);
      if (taken) {
        nameIsAvailable = false;
        nameCheckRow.textContent = 'That name is already taken.';
        nameCheckRow.className = 'name-check-row taken';
        return;
      }
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      await ShortTubeProfile.saveProfileEdits(me.$id, newName, pendingAvatarFile, pendingBannerFile, bioInput.value);
      modal.classList.remove('active');
      pendingAvatarFile = null;
      pendingBannerFile = null;
    } catch (err) {
      alert("Couldn't save profile: " + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });
});

window.ShortTubeProfile = ShortTubeProfile;
