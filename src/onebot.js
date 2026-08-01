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

      await onGroupMessage(payload, createOneBotClient(ws, pendingActions));
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

function createOneBotClient(ws, pendingActions) {
  return {
    sendGroupMessage(groupId, message) {
      sendAction(
        ws,
        "send_group_msg",
        {
          group_id: groupId,
          message,
        },
        pendingActions,
      ).catch((error) => {
        console.error(`[onebot] send_group_msg failed: ${error.message}`);
      });
    },
    sendGroupMessageAndWait(groupId, message) {
      return sendAction(
        ws,
        "send_group_msg",
        {
          group_id: groupId,
          message,
        },
        pendingActions,
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
  };
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
};
