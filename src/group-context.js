const MAX_GROUP_CONTEXT_MESSAGES = 50;

function selectRecentGroupMessages(messages, maxMessages = MAX_GROUP_CONTEXT_MESSAGES) {
  const limit = Math.min(
    MAX_GROUP_CONTEXT_MESSAGES,
    Math.max(1, Number(maxMessages) || MAX_GROUP_CONTEXT_MESSAGES),
  );
  return (Array.isArray(messages) ? messages : [])
    .slice()
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0))
    .slice(-limit);
}

class GroupConversationContext {
  constructor() {
    this.groups = new Map();
  }

  append(groupId, message) {
    const key = String(groupId);
    const existing = this.groups.get(key) || [];
    const duplicate = message.messageId
      ? existing.findIndex((entry) => entry.messageId === String(message.messageId))
      : -1;
    if (duplicate >= 0) {
      // Enrich replies/forwarded content and reconcile self-message echoes
      // without moving an already recorded message to the end of the chat.
      existing[duplicate] = {
        ...existing[duplicate],
        ...message,
        messageId: String(message.messageId),
        timestamp: existing[duplicate].timestamp,
      };
    } else {
      existing.push({
        ...message,
        messageId: message.messageId ? String(message.messageId) : "",
      });
    }
    this.groups.set(key, selectRecentGroupMessages(existing));
  }

  get(groupId, maxMessages = MAX_GROUP_CONTEXT_MESSAGES) {
    return selectRecentGroupMessages(this.groups.get(String(groupId)), maxMessages);
  }

  clear(groupId) {
    this.groups.delete(String(groupId));
  }
}

function getLatestGroupMemberMessage(messages) {
  return selectRecentGroupMessages(messages)
    .findLast((message) => message?.role === "user") || null;
}

function getGroupReplyMeta(messages) {
  const anchor = getLatestGroupMemberMessage(messages);
  return {
    senderName: anchor?.senderName || "",
  };
}

function getGroupMessageTimestamp(message, receivedAt = Date.now()) {
  const eventTime = Number(message?.time);
  return Number.isFinite(eventTime) && eventTime > 0
    ? eventTime * 1000
    : receivedAt;
}

module.exports = {
  MAX_GROUP_CONTEXT_MESSAGES,
  GroupConversationContext,
  getGroupMessageTimestamp,
  getGroupReplyMeta,
  getLatestGroupMemberMessage,
  selectRecentGroupMessages,
};
