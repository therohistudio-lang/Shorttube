/* =====================================================================
   messaging.js — Private messaging (DMs) between two ShortTube users
   ---------------------------------------------------------------------
   Depends on appwrite-config.js, auth.js, and social.js (for display
   name lookups) being loaded first.

   Data model (see appwrite-config.js for the exact attributes to create
   in the Appwrite Console):
     conversations: { userAId, userBId, lastMessage, lastMessageAt, createdAt }
       — userAId/userBId are stored in a canonical (sorted) order so a
       lookup between two people always hits the same document, however
       the conversation was opened from either side.
     messages: { conversationId, senderId, recipientId, text, createdAt }

   Real-time: subscribes to the messages collection's Appwrite Realtime
   channel while a thread is open, so new messages appear instantly
   without polling.
===================================================================== */

const ShortTubeMessaging = {

  _pair(userA, userB) { return [userA, userB].sort(); },

  /* ---------------- Find or create the conversation between two users ---------------- */
  async getOrCreateConversation(myId, otherId) {
    const [userAId, userBId] = this._pair(myId, otherId);
    const existing = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.CONVERSATIONS,
      [Query.equal('userAId', userAId), Query.equal('userBId', userBId), Query.limit(1)]
    );
    if (existing.documents[0]) return existing.documents[0];

    return databases.createDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.CONVERSATIONS, ID.unique(),
      { userAId, userBId, lastMessage: '', lastMessageAt: new Date().toISOString(), createdAt: new Date().toISOString() },
      [Permission.read(Role.user(userAId)), Permission.read(Role.user(userBId)),
       Permission.update(Role.user(userAId)), Permission.update(Role.user(userBId))]
    );
  },

  /* ---------------- List all of my conversations, newest first ---------------- */
  async listConversations(myId) {
    const [asA, asB] = await Promise.all([
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.CONVERSATIONS,
        [Query.equal('userAId', myId), Query.orderDesc('lastMessageAt'), Query.limit(50)]),
      databases.listDocuments(APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.CONVERSATIONS,
        [Query.equal('userBId', myId), Query.orderDesc('lastMessageAt'), Query.limit(50)])
    ]);
    const merged = [...asA.documents, ...asB.documents].sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

    return Promise.all(merged.map(async (c) => {
      const otherId = c.userAId === myId ? c.userBId : c.userAId;
      return { ...c, otherId, otherName: await ShortTubeSocial.getDisplayName(otherId) };
    }));
  },

  /* ---------------- Messages within a conversation ---------------- */
  async listMessages(conversationId, limit = 50) {
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.MESSAGES,
      [Query.equal('conversationId', conversationId), Query.orderAsc('$createdAt'), Query.limit(limit)]
    );
    return res.documents;
  },

  async sendMessage(conversationId, senderId, recipientId, text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    const doc = await databases.createDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.MESSAGES, ID.unique(),
      { conversationId, senderId, recipientId, text: trimmed, createdAt: new Date().toISOString() },
      [Permission.read(Role.user(senderId)), Permission.read(Role.user(recipientId))]
    );
    // Best-effort — keeps the conversation list preview + sort order fresh.
    // Never let a permissions/index hiccup here break message sending itself.
    databases.updateDocument(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.CONVERSATIONS, conversationId,
      { lastMessage: trimmed.slice(0, 120), lastMessageAt: new Date().toISOString() }
    ).catch(err => console.warn('[ShortTube] conversation preview update failed:', err));
    return doc;
  },

  /* ---------------- Realtime: live-append new messages while a thread is open ---------------- */
  _unsub: null,
  subscribeToConversation(conversationId, onMessage) {
    this.unsubscribe();
    if (!client.subscribe) return; // realtime not available in this SDK build — thread still works, just not live
    const channel = `databases.${APPWRITE_CONFIG.DATABASE_ID}.collections.${APPWRITE_CONFIG.COLLECTIONS.MESSAGES}.documents`;
    this._unsub = client.subscribe(channel, (event) => {
      const doc = event.payload;
      if (doc && doc.conversationId === conversationId && event.events?.some(e => e.endsWith('.create'))) {
        onMessage(doc);
      }
    });
  },
  unsubscribe() {
    if (this._unsub) { try { this._unsub(); } catch {} this._unsub = null; }
  },

  /* ---------------- Search users by display name (for "New Message") ---------------- */
  async searchUsers(query, excludeUserId) {
    const q = (query || '').trim();
    if (!q) return [];
    const res = await databases.listDocuments(
      APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES,
      [Query.search('displayName', q), Query.limit(15)]
    ).catch(async () => {
      // Fallback if "displayName" has no fulltext index configured yet:
      // pull a page and filter client-side (fine at this app's scale).
      const all = await databases.listDocuments(
        APPWRITE_CONFIG.DATABASE_ID, APPWRITE_CONFIG.COLLECTIONS.PROFILES, [Query.limit(100)]
      );
      return { documents: all.documents.filter(d => (d.displayName || '').toLowerCase().includes(q.toLowerCase())) };
    });
    return res.documents.filter(d => d.$id !== excludeUserId).slice(0, 15);
  }
};

window.ShortTubeMessaging = ShortTubeMessaging;
