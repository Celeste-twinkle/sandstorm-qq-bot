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
      tailKey: anchorKey(selectRecentGroupMessages(messages).at(-1)),
      botKey: this.lastBotKey(messages) };
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

  lastBotKey(messages) {
    const bot = selectRecentGroupMessages(messages).findLast(message => message.role === "assistant");
    return bot ? anchorKey(bot) : null;
  }

  canContinue(ticket, messages) {
    if (!ticket || this.pending.get(ticket.groupId) !== ticket || !getAvailableAnchor(messages)) return false;
    const botKey = this.lastBotKey(messages);
    // An old bot message falling out of the 50-message window is harmless.
    return botKey === null || botKey === ticket.botKey;
  }

  refresh(ticket, messages) {
    if (!this.canContinue(ticket, messages)) return false;
    ticket.anchorKey = anchorKey(getAvailableAnchor(messages));
    ticket.tailKey = anchorKey(selectRecentGroupMessages(messages).at(-1));
    return true;
  }

  cancel(groupId) {
    this.pending.delete(String(groupId));
  }

  finish(ticket) {
    if (ticket && this.pending.get(ticket.groupId) === ticket) {
      this.pending.delete(ticket.groupId);
    }
  }
}

// Coalesce a burst into its latest task. An update arriving during judgement or
// generation is retained and runs afterwards, instead of being lost to the guard.
class AmbientReplyScheduler {
  constructor(options = {}) {
    this.groups = new Map();
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.onError = options.onError || ((error) => console.error("[ai] ambient task failed:", error.message));
  }

  schedule(groupId, operation, delayMs = 0) {
    const key = String(groupId);
    let state = this.groups.get(key);
    if (!state) {
      state = { running: false, timer: null, operation: null, dueAt: 0 };
      this.groups.set(key, state);
    }
    const dueAt = this.now() + Math.max(0, delayMs);
    // Keep the first pending deadline while replacing its operation. Trailing
    // debounce otherwise postpones participation forever in a busy chat.
    state.dueAt = state.operation ? Math.min(state.dueAt, dueAt) : dueAt;
    state.operation = operation;
    if (state.timer !== null) this.clearTimer(state.timer);
    state.timer = null;
    if (!state.running) this.arm(key, state);
  }

  arm(key, state) {
    state.timer = this.setTimer(() => { void this.run(key, state); }, Math.max(0, state.dueAt - this.now()));
  }

  async run(key, state) {
    if (this.groups.get(key) !== state || state.running || !state.operation) return;
    const operation = state.operation;
    state.operation = null;
    state.timer = null;
    state.running = true;
    try {
      await operation();
    } catch (error) {
      this.onError(error, key);
    } finally {
      state.running = false;
      if (state.operation) this.arm(key, state);
      else this.groups.delete(key);
    }
  }

  cancel(groupId) {
    const key = String(groupId);
    const state = this.groups.get(key);
    if (!state) return;
    if (state.timer !== null) this.clearTimer(state.timer);
    state.timer = null;
    state.operation = null;
    if (!state.running) this.groups.delete(key);
  }

  clear() {
    for (const key of this.groups.keys()) this.cancel(key);
  }
}

function getAmbientReplyDelay(mode, lastReplyAt, config, now = Date.now()) {
  const cooldownRemaining = lastReplyAt === undefined ? 0
    : Math.max(0, lastReplyAt + config.ambientChatCooldownSeconds * 1000 - now);
  return Math.max(cooldownRemaining, mode === "instant" ? config.ambientChatDebounceMs ?? 600 : 0);
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

function parseAmbientDraftReview(text, draft) {
  let value;
  try { value = JSON.parse(String(text || "").trim()); }
  catch { throw new Error("Ambient draft review is not valid JSON"); }
  if (!value || Array.isArray(value) || !["send", "edit", "skip"].includes(value.action)) {
    throw new Error("Ambient draft review must contain send, edit or skip");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== (value.action === "edit" ? "action,text" : "action")) {
    throw new Error("Ambient draft review contains unexpected fields");
  }
  if (value.action === "skip") return null;
  if (value.action === "send") return draft;
  if (typeof value.text !== "string" || !value.text.trim()) {
    throw new Error("Ambient draft review edit must contain nonempty text");
  }
  const edited = value.text.trim();
  // An edit is a deletion, not another generation pass. Fail closed if the
  // reviewer adds words, reorders them, or removes protected source details.
  const characters = text => Array.from(text.replace(/[\p{P}\s]/gu, ""));
  const original = characters(draft);
  let position = 0;
  for (const character of characters(edited)) {
    while (position < original.length && original[position] !== character) position += 1;
    if (position === original.length) return null;
    position += 1;
  }
  const numbers = text => text.match(/[-+]?\d+(?:[.:]\d+)*/g) || [];
  if (JSON.stringify(numbers(edited)) !== JSON.stringify(numbers(draft))) return null;
  const urls = draft.match(/https?:\/\/[^\s<>"\])）。，；！？]+/gu) || [];
  if (urls.some(url => !edited.includes(url))) return null;
  const qualifiers = draft.match(/不能确定|不确定|不一定|可能|也许|未必|大概|似乎|估计|听说/g) || [];
  if (qualifiers.some(word => !edited.includes(word))) return null;
  for (const negation of ["不", "没", "未", "无"]) {
    if (edited.split(negation).length !== draft.split(negation).length) return null;
  }
  return edited;
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

module.exports = { AmbientReplyGuard, AmbientReplyScheduler, getAmbientReplyDelay, getAmbientRecipientHint, parseAmbientDecision, parseAmbientDraftReview };
