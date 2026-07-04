const http = require("http");
const { WebSocketServer } = require("ws");

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
          pending.reject(new Error(`OneBot action failed: ${JSON.stringify(payload).slice(0, 300)}`));
        } else {
          pending.resolve(payload);
        }
        return;
      }

      if (payload.post_type !== "message" || payload.message_type !== "group") {
        return;
      }

      await onGroupMessage(payload, {
        sendGroupMessage(groupId, message) {
          sendAction(ws, "send_group_msg", {
            group_id: groupId,
            message,
          }, pendingActions).catch((error) => {
            console.error(`[onebot] send_group_msg failed: ${error.message}`);
          });
        },
        sendGroupMessageAndWait(groupId, message) {
          return sendAction(ws, "send_group_msg", {
            group_id: groupId,
            message,
          }, pendingActions);
        },
      });
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

function sendAction(ws, action, params, pendingActions) {
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
    const timeout = setTimeout(() => {
      pendingActions.delete(echo);
      reject(new Error(`OneBot action ${action} timed out waiting for response.`));
    }, 120000);
    pendingActions.set(echo, { resolve, reject, timeout });
  });
}

module.exports = { createOneBotServer };
