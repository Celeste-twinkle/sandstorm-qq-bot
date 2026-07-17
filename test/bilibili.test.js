const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const test = require("node:test");

const {
  downloadBilibiliVideo,
  extractBilibiliUrls,
  removeDownloadedBilibiliVideo,
} = require("../src/bilibili");

const TEST_MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftyp", "ascii"),
  Buffer.from("isom0000isom", "ascii"),
]);

test("extractBilibiliUrls accepts Bilibili links and strips Chinese punctuation", () => {
  assert.deepEqual(
    extractBilibiliUrls("看看：https://www.bilibili.com/video/BV1xx411c7mD，这个不错"),
    ["https://www.bilibili.com/video/BV1xx411c7mD"],
  );
});

test("downloadBilibiliVideo downloads an MP4 to a local file URL and cleans it up", async () => {
  const { server, url, getHeaders } = await startServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": TEST_MP4.length,
    });
    response.end(TEST_MP4);
  });

  let downloaded;
  try {
    downloaded = await downloadBilibiliVideo(
      {
        bilibiliDownloadTimeoutMs: 5000,
        bilibiliMaxVideoSizeMb: 1,
      },
      {
        bvid: "BV1xx411c7mD",
        pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        videoUrl: url,
      },
    );

    assert.match(downloaded.fileUrl, /^file:\/\//);
    assert.equal(downloaded.sizeBytes, TEST_MP4.length);
    assert.deepEqual(await fs.readFile(downloaded.filePath), TEST_MP4);
    assert.equal(getHeaders().referer, "https://www.bilibili.com/video/BV1xx411c7mD");

    await removeDownloadedBilibiliVideo(downloaded);
    await assert.rejects(fs.access(downloaded.filePath));
    downloaded = undefined;
  } finally {
    await removeDownloadedBilibiliVideo(downloaded);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("downloadBilibiliVideo rejects an oversized response before writing the file", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": 2 * 1024 * 1024,
    });
    response.end(TEST_MP4);
  });

  try {
    await assert.rejects(
      downloadBilibiliVideo(
        {
          bilibiliDownloadTimeoutMs: 5000,
          bilibiliMaxVideoSizeMb: 1,
        },
        {
          pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
          videoUrl: url,
        },
      ),
      (error) => error.code === "BILIBILI_VIDEO_TOO_LARGE",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("downloadBilibiliVideo rejects a non-MP4 payload", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>expired</html>");
  });

  try {
    await assert.rejects(
      downloadBilibiliVideo(
        {
          bilibiliDownloadTimeoutMs: 5000,
          bilibiliMaxVideoSizeMb: 1,
        },
        {
          pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
          videoUrl: url,
        },
      ),
      /非视频内容/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function startServer(handler) {
  let headers = {};
  const server = http.createServer((request, response) => {
    headers = request.headers;
    handler(request, response);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/video.mp4`,
        getHeaders: () => headers,
      });
    });
  });
}
