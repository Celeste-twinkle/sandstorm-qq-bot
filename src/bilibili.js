const BILIBILI_HOST_PATTERN = /(^|\.)bilibili\.com$/i;
const BILIBILI_SHORT_HOSTS = new Set(["b23.tv", "bili2233.cn", "bili22.cn", "bili33.cn"]);

function extractBilibiliUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'，。；、]+/gi) || [];
  return matches
    .map((url) => normalizeUrl(url))
    .filter(Boolean)
    .filter(isBilibiliUrl);
}

async function resolveBilibiliVideo(config, inputUrl) {
  const originalUrl = normalizeUrl(inputUrl);
  if (!originalUrl || !isBilibiliUrl(originalUrl)) {
    throw new Error("未识别到有效的 Bilibili 视频链接。");
  }

  const canonicalUrl = await resolveBilibiliShortUrl(config, originalUrl);
  const parsed = parseBilibiliId(canonicalUrl);
  if (!parsed.bvid && !parsed.aid) {
    throw new Error("暂时只支持普通 BV/av 视频链接。");
  }

  const errors = [];
  for (const provider of config.bilibiliProviders) {
    const name = String(provider || "").trim().toLowerCase();
    try {
      let result;
      if (name === "injahow") {
        result = await resolveWithInjahow(config, parsed);
      } else if (name === "mir6") {
        result = await resolveWithMir6(config, canonicalUrl);
      } else {
        errors.push(`${name}: unknown provider`);
        continue;
      }

      if (result?.videoUrl) {
        const metadata = config.bilibiliMetadataEnabled ? await fetchBilibiliMetadata(config, parsed) : {};
        return {
          ...mergeBilibiliInfo(result, metadata),
          pageUrl: canonicalUrl,
          bvid: parsed.bvid,
          aid: parsed.aid,
          page: parsed.page,
          provider: name,
        };
      }

      errors.push(`${name}: empty video url`);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }

  throw new Error(`Bilibili 解析失败：${errors.join("; ")}`);
}

async function resolveWithInjahow(config, parsed) {
  const url = new URL("https://api.injahow.cn/bparse/");
  if (parsed.bvid) {
    url.searchParams.set("bv", parsed.bvid);
  } else {
    url.searchParams.set("av", parsed.aid);
  }
  url.searchParams.set("p", String(parsed.page || 1));
  url.searchParams.set("format", "mp4");
  url.searchParams.set("otype", "json");

  const payload = await fetchJson(url.toString(), config.bilibiliTimeoutMs, "injahow");
  if (Number(payload.code) !== 0 || !payload.url) {
    throw new Error(`bad response ${JSON.stringify(payload).slice(0, 200)}`);
  }

  return {
    videoUrl: payload.url,
    quality: payload.quality,
    acceptQuality: payload.accept_quality,
  };
}

async function resolveWithMir6(config, pageUrl) {
  const url = new URL("https://api.mir6.com/api/bzjiexi");
  url.searchParams.set("url", pageUrl);
  url.searchParams.set("type", "json");

  const payload = await fetchJson(url.toString(), config.bilibiliTimeoutMs, "mir6");
  if (Number(payload.code) !== 200) {
    throw new Error(`code=${payload.code} msg=${payload.msg || ""}`);
  }

  const first = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  const videoUrl = first?.video_url;
  if (!videoUrl) {
    throw new Error("missing data.video_url");
  }

  return {
    videoUrl,
    title: payload.title || first?.title || "",
    coverUrl: payload.imgurl || "",
    description: payload.desc || "",
    duration: first?.duration,
    durationText: first?.durationFormat,
    authorName: payload.user?.name || "",
  };
}

async function fetchBilibiliMetadata(config, parsed) {
  const url = new URL("https://api.bilibili.com/x/web-interface/view");
  if (parsed.bvid) {
    url.searchParams.set("bvid", parsed.bvid);
  } else {
    url.searchParams.set("aid", parsed.aid);
  }

  try {
    const payload = await fetchJson(url.toString(), config.bilibiliTimeoutMs, "bilibili-view");
    if (Number(payload.code) !== 0 || !payload.data) {
      return {};
    }

    const data = payload.data;
    return {
      title: data.title || "",
      coverUrl: data.pic || "",
      description: data.desc || "",
      duration: data.duration,
      durationText: formatDuration(data.duration),
      authorName: data.owner?.name || "",
      authorId: data.owner?.mid,
      pubdate: data.pubdate,
      pubdateText: formatUnixTime(data.pubdate),
      stats: {
        view: data.stat?.view,
        danmaku: data.stat?.danmaku,
        reply: data.stat?.reply,
        favorite: data.stat?.favorite,
        coin: data.stat?.coin,
        share: data.stat?.share,
        like: data.stat?.like,
      },
      dynamic: data.dynamic || "",
    };
  } catch (error) {
    console.warn(`[bilibili] metadata fetch failed: ${error.message}`);
    return {};
  }
}

function mergeBilibiliInfo(resolveResult, metadata) {
  return {
    ...resolveResult,
    title: metadata.title || resolveResult.title || "",
    coverUrl: metadata.coverUrl || resolveResult.coverUrl || "",
    description: metadata.description || resolveResult.description || "",
    duration: metadata.duration || resolveResult.duration,
    durationText: metadata.durationText || resolveResult.durationText || "",
    authorName: metadata.authorName || resolveResult.authorName || "",
    authorId: metadata.authorId,
    pubdate: metadata.pubdate,
    pubdateText: metadata.pubdateText || "",
    stats: metadata.stats || {},
    dynamic: metadata.dynamic || "",
  };
}

async function resolveBilibiliShortUrl(config, inputUrl) {
  const parsed = new URL(inputUrl);
  if (!BILIBILI_SHORT_HOSTS.has(parsed.hostname.toLowerCase())) {
    return inputUrl;
  }

  const response = await fetchWithTimeout(inputUrl, {
    timeoutMs: config.bilibiliTimeoutMs,
    method: "HEAD",
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (!location) {
    return inputUrl;
  }

  return normalizeUrl(new URL(location, inputUrl).toString()) || inputUrl;
}

async function fetchJson(url, timeoutMs, label) {
  const response = await fetchWithTimeout(url, {
    timeoutMs,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) sandstorm-qq-bot/1.0",
      Referer: "https://www.bilibili.com/",
      Accept: "application/json,text/plain,*/*",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`request timed out after ${options.timeoutMs || 15000}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseBilibiliId(url) {
  const parsed = new URL(url);
  const text = `${parsed.pathname}${parsed.search}`;
  const bvid = text.match(/BV[0-9A-Za-z]{10,}/)?.[0] || "";
  const aid = text.match(/av(\d+)/i)?.[1] || "";
  const page = Number.parseInt(parsed.searchParams.get("p") || "1", 10);
  return {
    bvid,
    aid,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function formatDuration(seconds) {
  const value = Number.parseInt(seconds, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatUnixTime(seconds) {
  const value = Number.parseInt(seconds, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  const date = new Date(value * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    return parsed.toString();
  } catch {
    return "";
  }
}

function isBilibiliUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return BILIBILI_HOST_PATTERN.test(host) || BILIBILI_SHORT_HOSTS.has(host);
  } catch {
    return false;
  }
}

module.exports = {
  extractBilibiliUrls,
  resolveBilibiliVideo,
};
