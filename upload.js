/* =====================================================================
   upload.js — Video upload flow
   ---------------------------------------------------------------------
   Flow: tap Upload -> hidden file input opens -> once a video file is
   picked, show a form (Title, Description, auto-generated Thumbnail) ->
   on submit, upload both files to Appwrite Storage and create a
   `videos` document that the hybrid feed (feed.js) will pick up
   alongside YouTube results.

   HTML hooks expected (see html-injections.html):
     #uploadFab            - the floating "+" upload button
     #uploadFileInput       - <input type="file" accept="video/*" hidden>
     #uploadFormModal       - the metadata form modal
     #uploadTitleInput
     #uploadDescInput
     #uploadThumbnailPreview - <img> showing an auto-captured frame
     #uploadSubmitBtn
     #uploadProgressBar
===================================================================== */

const ShortTubeUpload = {
  pendingVideoFile: null,
  pendingThumbnailBlob: null,
  pendingImageFile: null,
  pendingMediaType: 'video', // 'video' | 'image' — set from the picked file's MIME type

  init() {
    // The "+" upload trigger now lives in the bottom nav bar (index.html
    // handles requireAuth() + opening this hidden file input on click), so
    // this module only needs to wire the file input and the submit button.
    // The input now accepts both video/* and image/*, so a single Upload
    // button lets people share either a video or a photo.
    const fileInput = document.getElementById('uploadFileInput');
    const modal = document.getElementById('uploadFormModal');
    const submitBtn = document.getElementById('uploadSubmitBtn');
    if (!fileInput || !modal || !submitBtn) return; // markup not present on this page

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const modalTitle = document.getElementById('uploadModalTitle');
      if (file.type.startsWith('image/')) {
        this.pendingMediaType = 'image';
        this.pendingImageFile = file;
        this.pendingVideoFile = null;
        document.getElementById('uploadThumbnailPreview').src = URL.createObjectURL(file);
        if (modalTitle) modalTitle.textContent = 'Upload Photo';
      } else {
        this.pendingMediaType = 'video';
        this.pendingVideoFile = file;
        this.pendingImageFile = null;
        await this.captureThumbnailFrame(file);
        if (modalTitle) modalTitle.textContent = 'Upload Video';
      }
      modal.classList.add('active');
    });

    submitBtn.addEventListener('click', () => this.submitUpload());
  },

  /* Grabs a frame ~1s into the video as an automatic thumbnail,
     using an offscreen <video> + <canvas> — no server round trip needed. */
  async captureThumbnailFrame(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.muted = true;
      video.addEventListener('loadeddata', () => { video.currentTime = Math.min(1, video.duration / 2); });
      video.addEventListener('seeked', () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
          this.pendingThumbnailBlob = blob;
          document.getElementById('uploadThumbnailPreview').src = URL.createObjectURL(blob);
          resolve();
        }, 'image/jpeg', 0.85);
      });
    });
  },

  /* =====================================================================
     Upload-time moderation
     ---------------------------------------------------------------------
     This client-side layer is deliberately narrow — it CANNOT see what's
     actually in a video/photo's pixels, so it never gets to decide "this
     is fine." The real, automatic detector is the server-side
     `moderate-content` Appwrite Function (see /functions/moderate-content
     and SETUP_GOOGLE_ONETAP.md), which runs the moment a file lands in
     Storage, checks it against Google Cloud Vision's SafeSearch model, and
     removes anything explicit/violent instantly — no human review, no
     waiting. That function is the one enforcing "auto-detect and remove";
     everything below is just an early, best-effort screen on top of it:
       1. Exact re-upload detection — a SHA-256 hash of the file is
          compared against every existing upload; an identical file is
          blocked outright before it even uploads.
       2. A basic text screen on the title/description against a short
          denylist, so obviously-violating uploads are held for review
          (moderationStatus: 'pending') rather than publishing immediately,
          even before the vision check runs.
     Anything that passes both is set to 'live' immediately, but the
     moderate-content function can still flip it to 'removed' moments later
     once it's actually looked at the file — feed.js never shows 'pending'
     or 'removed' content publicly either way.
  ===================================================================== */
  PROHIBITED_TERMS: ['rape', 'gore', 'beheading', 'child porn', 'underage sex', 'bestiality', 'porn', 'nude', 'nudity', 'explicit sex', 'sex tape', 'onlyfans'],

  async hashFile(file) {
    try {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.warn('[ShortTube] could not hash video file for dedupe check:', err);
      return null;
    }
  },

  async findDuplicateByHash(hash) {
    if (!hash) return null;
    try {
      const res = await databases.listDocuments(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS,
        [Query.equal('videoHash', hash), Query.limit(1)]
      );
      return res.documents[0] || null;
    } catch (err) {
      console.warn('[ShortTube] duplicate-hash lookup failed:', err);
      return null; // fail open on lookup errors — the upload itself is still hashed/stored for future checks
    }
  },

  screenText(title, description) {
    const haystack = `${title} ${description}`.toLowerCase();
    return this.PROHIBITED_TERMS.some(term => haystack.includes(term));
  },

  async submitUpload() {
    if (this.pendingMediaType === 'image') return this.submitImageUpload();

    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) { alert("Please log in to upload."); return; }
    if (!this.pendingVideoFile) return;

    const title = document.getElementById('uploadTitleInput').value.trim();
    const description = document.getElementById('uploadDescInput').value.trim();
    if (!title) { alert("Please add a title."); return; }

    const progressBar = document.getElementById('uploadProgressBar');
    const submitBtn = document.getElementById('uploadSubmitBtn');
    submitBtn.disabled = true;
    progressBar.style.width = '0%';

    try {
      // 0a. Exact re-upload check
      const videoHash = await this.hashFile(this.pendingVideoFile);
      const duplicate = await this.findDuplicateByHash(videoHash);
      if (duplicate) {
        alert("This video has already been uploaded to ShortTube. Re-uploading someone else's content without authorization isn't allowed.");
        submitBtn.disabled = false;
        return;
      }

      // 0b. Basic text screen — obvious violations are held for review, not published
      const flaggedByText = this.screenText(title, description);

      // 1. Upload the thumbnail (fast, small file)
      const thumbFile = new File([this.pendingThumbnailBlob], `${Date.now()}_thumb.jpg`, { type: 'image/jpeg' });
      const thumbUpload = await storage.createFile(
        APPWRITE_CONFIG.BUCKETS.VIDEO_THUMBS, ID.unique(), thumbFile,
        [Permission.read(Role.any()), Permission.delete(Role.user(me.$id))]
      );
      progressBar.style.width = '30%';

      // 2. Upload the video file itself (larger — Appwrite SDK chunks this automatically)
      const videoUpload = await storage.createFile(
        APPWRITE_CONFIG.BUCKETS.VIDEO_FILES, ID.unique(), this.pendingVideoFile,
        [Permission.read(Role.any()), Permission.delete(Role.user(me.$id))],
        (progress) => { progressBar.style.width = `${30 + progress.progress * 0.6}%`; }
      );

      // 3. Read duration so the engagement algorithm has something to compare watch-time against
      const durationSeconds = await this.readVideoDuration(this.pendingVideoFile);

      // 4. Create the video document that feed.js will merge into the hybrid feed
      await databases.createDocument(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.VIDEOS, ID.unique(),
        {
          title, description,
          thumbnailFileId: thumbUpload.$id,
          videoFileId: videoUpload.$id,
          ownerId: me.$id,
          durationSeconds,
          createdAt: new Date().toISOString(),
          engagementScore: 0, // algorithm.js updates this as watch events come in
          videoHash,
          moderationStatus: flaggedByText ? 'pending' : 'live'
        },
        [Permission.read(Role.any()), Permission.update(Role.user(me.$id)), Permission.delete(Role.user(me.$id))]
      );

      progressBar.style.width = '100%';
      document.getElementById('uploadFormModal').classList.remove('active');
      this.resetForm();
      if (flaggedByText) {
        alert("Your video was uploaded and is being held for a quick safety review before it appears publicly.");
      }
      if (window.ShortTubeFeed) window.ShortTubeFeed.refreshHome(); // pull the new upload into Home immediately (no-op if held for review)
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      submitBtn.disabled = false;
    }
  },

  /* Photo upload path — mirrors submitUpload() above (dedupe hash + text
     screen), but stores a single image file into the `images` collection
     instead of a video+thumbnail pair. */
  async submitImageUpload() {
    const me = await ShortTubeAuth.getCurrentUser();
    if (!me) { alert("Please log in to upload."); return; }
    if (!this.pendingImageFile) return;

    const caption = document.getElementById('uploadDescInput').value.trim();
    const title = document.getElementById('uploadTitleInput').value.trim();

    const progressBar = document.getElementById('uploadProgressBar');
    const submitBtn = document.getElementById('uploadSubmitBtn');
    submitBtn.disabled = true;
    progressBar.style.width = '0%';

    try {
      const imageHash = await this.hashFile(this.pendingImageFile);
      let duplicate = null;
      try {
        const res = await databases.listDocuments(
          APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.IMAGES,
          [Query.equal('imageHash', imageHash), Query.limit(1)]
        );
        duplicate = res.documents[0] || null;
      } catch (err) { console.warn('[ShortTube] duplicate image hash lookup failed:', err); }
      if (duplicate) {
        alert("This photo has already been uploaded to ShortTube.");
        submitBtn.disabled = false;
        return;
      }

      const flaggedByText = this.screenText(title, caption);

      const imageUpload = await storage.createFile(
        APPWRITE_CONFIG.BUCKETS.IMAGE_FILES, ID.unique(), this.pendingImageFile,
        [Permission.read(Role.any()), Permission.delete(Role.user(me.$id))],
        (progress) => { progressBar.style.width = `${progress.progress}%`; }
      );

      await databases.createDocument(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.IMAGES, ID.unique(),
        {
          caption: caption || title,
          imageFileId: imageUpload.$id,
          ownerId: me.$id,
          createdAt: new Date().toISOString(),
          engagementScore: 0,
          imageHash,
          moderationStatus: flaggedByText ? 'pending' : 'live'
        },
        [Permission.read(Role.any()), Permission.update(Role.user(me.$id)), Permission.delete(Role.user(me.$id))]
      );

      progressBar.style.width = '100%';
      document.getElementById('uploadFormModal').classList.remove('active');
      this.resetForm();
      if (flaggedByText) {
        alert("Your photo was uploaded and is being held for a quick safety review before it appears publicly.");
      }
      if (window.refreshImagesFeed) window.refreshImagesFeed();
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      submitBtn.disabled = false;
    }
  },

  readVideoDuration(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.addEventListener('loadedmetadata', () => resolve(Math.round(video.duration)));
    });
  },

  resetForm() {
    this.pendingVideoFile = null;
    this.pendingThumbnailBlob = null;
    this.pendingImageFile = null;
    this.pendingMediaType = 'video';
    document.getElementById('uploadTitleInput').value = '';
    document.getElementById('uploadDescInput').value = '';
    document.getElementById('uploadFileInput').value = '';
  }
};

document.addEventListener('DOMContentLoaded', () => ShortTubeUpload.init());
window.ShortTubeUpload = ShortTubeUpload;
