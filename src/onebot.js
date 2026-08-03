const http = require("http");
const { WebSocketServer } = require("ws");

class OneBotActionError extends Error {
  constructor(action, payload, durationMs) {
    const retcode = payload?.retcode;
    const detail = payload?.message || payload?.wording || "unknown OneBot failure";
    super(`OneBot action ${action} failed (retcode=${retcode ?? "unknown"}): ${detail}`);
    this.name = "OneBotActionError";
    this.action = action;
    this.retcode = retcode;
    this.response = payload;
    this.durationMs = durationMs;
  }
}

function normalizePath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

function createOneBotServer(config, onGroupMessage) {
  const server = http.createServer();
  const wsPath = normalizePath(config.wsPath);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (requestUrl.pathname !== wsPath) {
      socket.destroy();
      return;
    }

    if (config.accessToken) {
      const expected = `Bearer ${config.accessToken}`;
      if (request.headers.authorization !== expected) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    const remote = request.socket.remoteAddress || "unknown";
    const pendingActions = new Map();
    const client = createOneBotClient(ws, pendingActions, {
      textChunkMaxChars: config.oneBotTextChunkMaxChars,
    });
    console.log(`[onebot] connected from ${remote}`);

    ws.on("message", async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (payload.echo && pendingActions.has(payload.echo)) {
        const pending = pendingActions.get(payload.echo);
        pendingActions.delete(payload.echo);
        clearTimeout(pending.timeout);
        if (payload.status === "failed" || (payload.retcode !== undefined && Number(payload.retcode) !== 0)) {
          pending.reject(new OneBotActionError(pending.action, payload, Date.now() - pending.startedAt));
        } else {
          pending.resolve(payload);
        }
        return;
      }

      if (payload.post_type !== "message" || payload.message_type !== "group") {
        return;
      }

      try {
        await onGroupMessage(payload, client);
      } catch (error) {
        console.error(`[onebot] group message handler failed: ${error.message}`);
      }
    });

    ws.on("close", () => {
      for (const pending of pendingActions.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("OneBot connection closed before action response."));
      }
      pendingActions.clear();
      console.log("[onebot] disconnected");
    });
  });

  return {
    listen() {
      server.listen(config.port, () => {
        console.log(`[onebot] reverse websocket listening on ws://0.0.0.0:${config.port}${wsPath}`);
      });
    },
    close(callback) {
      wss.close(() => server.close(callback));
    },
  };
}

function createOneBotClient(ws, pendingActions, options = {}) {
  const groupSendQueues = new Map();
  const textChunkMaxChars = normalizeTextChunkMaxChars(options.textChunkMaxChars);
  const logger = options.logger || console;

  function enqueueGroupSend(groupId, operation) {
    const queueKey = String(groupId);
    const previous = groupSendQueues.get(queueKey) || Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    groupSendQueues.set(queueKey, queued);

    return queued.finally(() => {
      if (groupSendQueues.get(queueKey) === queued) {
        groupSendQueues.delete(queueKey);
      }
    });
  }

  return {
    sendGroupMessage(groupId, message) {
      return enqueueGroupSend(groupId, async () => {
        const chunks =
          typeof message === "string"
            ? splitTextMessage(message, textChunkMaxChars)
            : [message];

        for (let index = 0; index < chunks.length; index += 1) {
          try {
            await sendAction(
              ws,
              "send_group_msg",
              {
                group_id: groupId,
                message: chunks[index],
              },
              pendingActions,
            );
          } catch (error) {
            error.chunkIndex = index;
            error.chunkCount = chunks.length;
            error.deliveredChunks = index;
            throw error;
          }
        }

        if (chunks.length > 1) {
          logger.log(
            `[onebot] send_group_msg delivered chunks=${chunks.length} chars=${message.length} group=${groupId}`,
          );
        }
      });
    },
    sendGroupMessageAndWait(groupId, message) {
      return enqueueGroupSend(groupId, () =>
        sendAction(
          ws,
          "send_group_msg",
          {
            group_id: groupId,
            message,
          },
          pendingActions,
        ),
      );
    },
    async getMessage(messageId) {
      const response = await sendAction(
        ws,
        "get_msg",
        {
          message_id: messageId,
        },
        pendingActions,
        { timeoutMs: 10000 },
      );
      return response?.data || null;
    },
    async getForwardMessage(forwardId) {
      const response = await sendAction(
        ws,
        "get_forward_msg",
        {
          // OneBot v11 calls this field `id`, while current NapCat also
          // accepts/recommends `message_id`. Sending both keeps the client
          // compatible with either implementation.
          id: forwardId,
          message_id: forwardId,
        },
        pendingActions,
        { timeoutMs: 10000 },
      );
      return response?.data || null;
    },
  };
}

function normalizeTextChunkMaxChars(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

function splitTextMessage(message, maxChars = 1000) {
  const text = String(message || "").trim();
  const limit = normalizeTextChunkMaxChars(maxChars);
  if (!text || text.length <= limit) {
    return text ? [text] : [];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const splitIndex = findTextSplitIndex(remaining, limit);
    const chunk = remaining.slice(0, splitIndex).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function findTextSplitIndex(text, maxChars) {
  let hardLimit = Math.min(maxChars, text.length);
  const lastCodeUnit = text.charCodeAt(hardLimit - 1);
  const nextCodeUnit = text.charCodeAt(hardLimit);
  if (
    lastCodeUnit >= 0xd800 &&
    lastCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    hardLimit -= 1;
  }

  const minimumPreferred = Math.max(1, Math.floor(hardLimit * 0.55));
  const preferredBreaks = [
    (value) => value === "\n",
    (value) => "。！？；!?;".includes(value),
    (value) => /\s/u.test(value),
  ];

  for (const isPreferredBreak of preferredBreaks) {
    for (let index = hardLimit; index > minimumPreferred; index -= 1) {
      if (isPreferredBreak(text[index - 1])) {
        return index;
      }
    }
  }
  return hardLimit;
}

function sendAction(ws, action, params, pendingActions, options = {}) {
  if (ws.readyState !== ws.OPEN) {
    return Promise.reject(new Error("OneBot connection is not open."));
  }

  const echo = `${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  ws.send(
    JSON.stringify({
      action,
      params,
      echo,
    })
  );

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      pendingActions.delete(echo);
      const error = new Error(`OneBot action ${action} timed out waiting for response.`);
      error.name = "OneBotActionTimeoutError";
      error.action = action;
      error.durationMs = Date.now() - startedAt;
      reject(error);
    }, options.timeoutMs || 120000);
    pendingActions.set(echo, { action, resolve, reject, timeout, startedAt });
  });
}

module.exports = {
  createOneBotClient,
  createOneBotServer,
  OneBotActionError,
  splitTextMessage,
};
