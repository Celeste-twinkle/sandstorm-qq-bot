const { getLatestGroupMemberMessage, selectRecentGroupMessages } = require("./group-context");

function getAvailableAnchor(messages) {
  return getLatestGroupMemberMessage(messages);
}

function anchorKey(message) {
  return message.messageId !== undefined && message.messageId !== null && message.messageId !== ""
    ? String(message.messageId)
    : JSON.stringify([message.timestamp, message.userId, message.text, message.images]);
}

class AmbientReplyGuard {
  constructor() {
    this.pending = new Map();
  }

  begin(groupId, messages) {
    const key = String(groupId);
    const anchor = getAvailableAnchor(messages);
    if (!anchor || this.pending.has(key)) {
      return null;
    }
    const ticket = { groupId: key, anchorKey: anchorKey(anchor),
      tailKey: anchorKey(selectRecentGroupMessages(messages).at(-1)) };
    this.pending.set(key, ticket);
    return ticket;
  }

  canSend(ticket, messages) {
    if (!ticket || this.pending.get(ticket.groupId) !== ticket) {
      return false;
    }
    const anchor = getAvailableAnchor(messages);
    const latest = selectRecentGroupMessages(messages).at(-1);
    return Boolean(anchor) && anchorKey(anchor) === ticket.anchorKey &&
      anchorKey(latest) === ticket.tailKey;
  }

  finish(ticket) {
    if (ticket && this.pending.get(ticket.groupId) === ticket) {
      this.pending.delete(ticket.groupId);
    }
  }
}

function parseAmbientDecision(text) {
  let value;
  try {
    value = JSON.parse(String(text || "").trim());
  } catch {
    throw new Error("Ambient decision is not valid JSON");
  }
  if (!value || Array.isArray(value) || typeof value.should_reply !== "boolean") {
    throw new Error("Ambient decision must contain a boolean should_reply");
  }
  return value.should_reply;
}

function getAmbientRecipientHint(message) {
  const mentions = Array.isArray(message?.message)
    ? message.message.filter((segment) => segment?.type === "at")
        .map((segment) => String(segment.data?.qq || ""))
    : Array.from(String(message?.message || message?.raw_message || "").matchAll(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/gi),
        (match) => match[1]);
  const selfId = String(message?.self_id || "");
  if (mentions.includes("all")) {
    return "艾特全体群成员";
  }
  if (selfId && mentions.includes(selfId)) {
    return "艾特了 bot";
  }
  return selfId && mentions.some(Boolean) ? "艾特其他群成员" : "";
}

module.exports = { AmbientReplyGuard, getAmbientRecipientHint, parseAmbientDecision };
