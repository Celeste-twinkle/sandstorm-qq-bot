const DAY = 86400000;
const clamp = value => Math.max(0, Math.min(1, value));

function scoreImportance({ text = "", isSelf = false, isImportantUser = false } = {}) {
  const value = String(text).trim();
  if (!value) return 0.1;
  if (/^(?:哈|呵|啊|哦|嗯|好|[!！?？。\s]){1,30}$/u.test(value)) return isSelf ? 0.12 : 0.2;
  let score = 0.3 + Math.min(0.1, value.length / 600);
  if (/记住|别忘|答应|约定|说好|第一次|最后一次|纪念|生日/u.test(value)) score += 0.32;
  const emotional = (value.match(/喜欢|讨厌|爱你|想你|别走|难受|害怕|生气|委屈|开心|谢谢|对不起|心疼/gu) || []).length;
  score += Math.min(0.22, emotional * 0.07);
  if (isImportantUser) score += 0.15;
  if (isSelf) score -= 0.12;
  if (/[?？]$/u.test(value)) score += 0.04;
  return clamp(score);
}

function halfLifeDays(importance) { return 6 + 180 * Math.pow(clamp(Number(importance) || 0), 2.5); }
function memoryStrength({ importance, ts, recalls = 0, last_recall_at = 0 }, now = Date.now()) {
  const age = Math.max(0, now - Math.max(ts || 0, last_recall_at || 0)) / DAY;
  const strength = clamp(importance * Math.pow(0.5, age / halfLifeDays(importance)) * (1 + 0.15 * Math.log1p(Math.min(20, recalls))));
  return { strength, faded: strength < 0.12 && age > 14 ? 1 : 0 };
}

function importanceOfTrait(text) {
  const value = String(text || "").trim();
  if (!value) return 0;
  let score = 0.3 + Math.min(0.1, value.length / 600);
  score += Math.min(0.36, (value.match(/喜欢|爱你|难过|心疼|答应|约定|别走|吵架|和好|信任|习惯|不喜欢/gu) || []).length * 0.12);
  if (/他答应|她答应|专门|愿意|护着|一直|总是/u.test(value)) score += 0.15;
  if (/\d/u.test(value)) score += 0.08;
  if (/刚才|安装|更新工具|吃了/u.test(value)) score -= 0.08;
  return clamp(score);
}

function selectTraits(traits, cap = 12) {
  const unique = [...new Set(traits.filter(text => typeof text === "string" && text.trim()).map(text => text.trim()))];
  const ranked = unique.map((text, index) => ({ text, index, score: importanceOfTrait(text) }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const keep = new Set(ranked.slice(0, cap).map(item => item.index));
  return { kept: unique.filter((_, index) => keep.has(index)), demoted: unique.filter((_, index) => !keep.has(index)) };
}

function timeOfDayMood(date = new Date(), timeZone = "Asia/Shanghai") {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date));
  if (hour < 5) return { slot: "凌晨", eager: 0.2, tone: "语气安静、放松些，直接提问仍认真回答" };
  if (hour < 8) return { slot: "清早", eager: 0.35, tone: "反应舒缓一些，不强行热场" };
  if (hour < 11) return { slot: "上午", eager: 0.6, tone: "清醒自然，正常接话" };
  if (hour < 13) return { slot: "中午", eager: 0.65, tone: "自然轻松，按话题展开" };
  if (hour < 17) return { slot: "下午", eager: 0.7, tone: "有精神，愿意参与有兴趣的话题" };
  if (hour < 19) return { slot: "傍晚", eager: 0.8, tone: "放松，合适时可以多接点梗" };
  if (hour < 23) return { slot: "晚上", eager: 0.75, tone: "随意、柔和一些" };
  return { slot: "深夜", eager: 0.4, tone: "安静一些，不强行起新话题" };
}

function formatMoodHint(now, timeZone, ambient = false) {
  const mood = timeOfDayMood(new Date(now), timeZone);
  return `【此刻状态】${mood.slot}，${mood.tone}。这只是语气参考，不限制回答长度或拒绝正常求助。${ambient && mood.eager < 0.4
    ? "当前主动接话的机会可以不用；没有特别想说的话时，可以继续安静。" : ""}`;
}

module.exports = { scoreImportance, halfLifeDays, memoryStrength, importanceOfTrait, selectTraits, timeOfDayMood, formatMoodHint };
