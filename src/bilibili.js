const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { pathToFileURL } = require("url");

const BILIBILI_HOST_PATTERN = /(^|\.)bilibili\.com$/i;
const BILIBILI_SHORT_HOSTS = new Set(["b23.tv", "bili2233.cn", "bili22.cn", "bili33.cn"]);
const BILIBILI_DOWNLOAD_DIRECTORY = path.join(os.tmpdir(), "sandstorm-qq-bot", "bilibili");
const MEBIBYTE = 1024 * 1024;

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

async function downloadBilibiliVideo(config, result) {
  const videoUrl = normalizeUrl(result?.videoUrl);
  if (!videoUrl) {
    throw new Error("解析服务没有返回可下载的视频地址。");
  }

  const maxBytes = Math.max(1, Number(config.bilibiliMaxVideoSizeMb) || 95) * MEBIBYTE;
  const timeoutMs = Math.max(1000, Number(config.bilibiliDownloadTimeoutMs) || 180000);
  const videoId = sanitizeFileName(result.bvid || (result.aid ? `av${result.aid}` : "video"));
  const filePath = path.join(BILIBILI_DOWNLOAD_DIRECTORY, `${videoId}-${randomUUID()}.mp4`);
  const partialPath = `${filePath}.part`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  await fsPromises.mkdir(BILIBILI_DOWNLOAD_DIRECTORY, { recursive: true });

  try {
    const response = await fetch(videoUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) sandstorm-qq-bot/1.0",
        Referer: result.pageUrl || "https://www.bilibili.com/",
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`视频下载 HTTP ${response.status}`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("application/json")) {
      throw new Error(`视频下载返回了非视频内容（${contentType || "unknown"}）`);
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw createVideoTooLargeError(contentLength, maxBytes);
    }

    if (!response.body) {
      throw new Error("视频下载响应为空。");
    }

    let downloadedBytes = 0;
    const sizeLimiter = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxBytes) {
          callback(createVideoTooLargeError(downloadedBytes, maxBytes));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimiter,
      fs.createWriteStream(partialPath, { flags: "wx" }),
    );

    if (downloadedBytes === 0) {
      throw new Error("下载到的视频文件为空。");
    }

    await assertMp4File(partialPath);
    await fsPromises.rename(partialPath, filePath);
    return {
      filePath,
      fileUrl: pathToFileURL(filePath).href,
      sizeBytes: downloadedBytes,
    };
  } catch (error) {
    await removeFilesQuietly(partialPath, filePath);
    if (error.name === "AbortError") {
      throw new Error(`视频下载超时（${Math.round(timeoutMs / 1000)} 秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function removeDownloadedBilibiliVideo(downloaded) {
  if (!downloaded?.filePath) {
    return;
  }
  await removeFilesQuietly(downloaded.filePath);
}

async function assertMp4File(filePath) {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 8 || header.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new Error("解析服务返回的文件不是有效的 MP4 视频。");
    }
  } finally {
    await handle.close();
  }
}

function createVideoTooLargeError(actualBytes, maxBytes) {
  const error = new Error(
    `视频大小 ${formatFileSize(actualBytes)} 超过发送上限 ${formatFileSize(maxBytes)}。`,
  );
  error.code = "BILIBILI_VIDEO_TOO_LARGE";
  return error;
}

function formatFileSize(bytes) {
  return `${(Number(bytes) / MEBIBYTE).toFixed(1)} MB`;
}

function sanitizeFileName(value) {
  return String(value || "video").replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 64) || "video";
}

async function removeFilesQuietly(...filePaths) {
  await Promise.all(
    filePaths.filter(Boolean).map((filePath) => fsPromises.rm(filePath, { force: true }).catch(() => {})),
  );
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
  downloadBilibiliVideo,
  extractBilibiliUrls,
  removeDownloadedBilibiliVideo,
  resolveBilibiliVideo,
};
