// OneBot does not reliably identify other bot accounts. Explicit IDs are exact;
// repeated reactions to our delivered replies are only a local loop heuristic.
class GroupBotLoopGuard {
  constructor(config = {}, options = {}) {
    this.botIds = new Set(config.groupChatBotIds || []);
    this.trustedIds = new Set([...(config.groupChatTrustedUserIds || []), ...(config.botAdminIds || [])]);
    this.accountDecision = options.accountDecision || (() => null);
    this.maxTurns = config.groupChatLoopMaxTurns ?? 4;
    this.replyWindowMs = (config.groupChatLoopReplyWindowSeconds ?? 120) * 1000;
    this.quietMs = (config.groupChatLoopQuietSeconds ?? 600) * 1000;
    this.now = options.now || Date.now;
    this.groups = new Map();
  }

  state(groupId) {
    const key = String(groupId);
    if (!this.groups.has(key)) {
      this.groups.set(key, { members: new Map(), seen: new Set() });
    }
    return this.groups.get(key);
  }

  recordReply(groupId, userId) {
    const member = this.groups.get(String(groupId))?.members.get(String(userId || ""));
    if (!member) return;
    member.replyVersion++;
    member.repliedAt = this.now();
  }

  inspect(message) {
    const userId = String(message.user_id || message.sender?.user_id || "");
    const decision = this.accountDecision(message.group_id, userId);
    if (decision === "ignore" || (decision !== "allow" &&
        (this.botIds.has(userId) || message.is_bot === true || message.sender?.is_bot === true))) {
      return { allowed: false, reason: "known_bot" };
    }
    if (!userId) return { allowed: false, reason: "missing_sender" };

    const state = this.state(message.group_id);
    const messageId = message.message_id === undefined || message.message_id === null
      ? "" : `${userId}:${message.message_id}`;
    if (messageId && state.seen.has(messageId)) return { allowed: false, reason: "duplicate" };
    if (messageId) state.seen.add(messageId);
    while (state.seen.size > 200) state.seen.delete(state.seen.values().next().value);
    if (this.trustedIds.has(userId)) return { allowed: true };

    const now = this.now();
    let member = state.members.get(userId);
    if (!member || now - member.lastSeenAt >= this.quietMs) {
      member = { lastSeenAt: now, replyVersion: 0, consumedReplyVersion: 0,
        repliedAt: null, turns: 0, blocked: false };
      state.members.set(userId, member);
      // Drop inactive accounts, but never forget an account still driving a loop.
      for (const [id, previous] of state.members) {
        if (!previous.blocked && now - previous.lastSeenAt >= this.quietMs) state.members.delete(id);
      }
    } else if (!member.blocked) {
      if (member.replyVersion !== member.consumedReplyVersion) {
        member.turns = now - member.repliedAt <= this.replyWindowMs ? member.turns + 1 : 0;
      } else if (member.repliedAt !== null && now - member.repliedAt > this.replyWindowMs) {
        member.turns = 0;
      }
    }
    const justBlocked = !member.blocked && member.turns >= this.maxTurns;
    member.blocked ||= justBlocked;
    member.lastSeenAt = now;
    member.consumedReplyVersion = member.replyVersion;
    return member.blocked
      ? { allowed: false, reason: "reply_loop", justBlocked }
      : { allowed: true };
  }

  canRespond(groupId, userId) {
    const key = String(userId || "");
    const decision = this.accountDecision(groupId, key);
    if (decision === "ignore" || (decision !== "allow" && this.botIds.has(key))) return false;
    if (this.trustedIds.has(key)) return true;
    // Time alone never wakes a blocked conversation. A new incoming message
    // after a full quiet period must pass inspect() first.
    return !this.groups.get(String(groupId))?.members.get(key)?.blocked;
  }

  resetAccount(groupId, userId) {
    this.groups.get(String(groupId))?.members.delete(String(userId));
  }

  responseCheck(groupId, userId) {
    const member = this.groups.get(String(groupId))?.members.get(String(userId));
    return () => this.canRespond(groupId, userId) &&
      this.groups.get(String(groupId))?.members.get(String(userId)) === member;
  }
}

module.exports = { GroupBotLoopGuard };
