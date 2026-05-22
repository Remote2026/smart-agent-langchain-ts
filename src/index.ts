import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SmartAgent } from "./agent/agent.js";
import { loadAppConfig } from "./config.js";
import { createTools } from "./tools/index.js";
import { SmartThingsClient } from "./tools/smartthings.js";
import { FoxgloveClient } from "./foxglove/client.js";
import type { ChatEventOut } from "./types.js";
import { ChatRequestSchema, DeviceEventRequestSchema } from "./agent/v2/state.js";
import { DEFAULT_SESSION_ID } from "./session.js";
import { startSlackIntegration, maybeMirrorToSlack, webMessageSlackText } from "./slack/index.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("index.ts");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appConfig = loadAppConfig();
/**
 * 数据流（简化）：
 * HTTP /api/chat -> SmartAgent -> (LangGraph StateGraph) -> tools(smartthings_* / ros2_*) -> SSE -> Web UI
 */
const foxgloveClient = new FoxgloveClient(appConfig.env.FOXGLOVE_URL);
foxgloveClient.connect().catch((err) => {
  log.error("start", "Foxglove connection failed:", err);
});

const tools = createTools({
  smartThings: new SmartThingsClient(),
  foxglove: foxgloveClient
});

const agent = new SmartAgent({
  baseURL: appConfig.env.OPENAI_BASE_URL,
  apiKey: appConfig.env.OPENAI_API_KEY,
  model: appConfig.env.OPENAI_MODEL,
  tools
});

const app = express();
// 图片 base64 体积比纯文本大，10MB 足够智能家居场景
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve(__dirname, "..", "public")));

// SSE 客户端集合：用于设备事件广播到所有已连接的 Web UI
const sseClients = new Set<import("http").ServerResponse>();

/** 强制刷新 TCP 缓冲区，避免 Node.js  cork 合并小数据块 */
function sseFlush(response: import("http").ServerResponse) {
  const sock = (response as any).socket;
  if (sock && typeof sock.uncork === "function") {
    sock.uncork();
  }
}

/** 广播 SSE 事件到所有已连接客户端 */
function broadcastSse(event: ChatEventOut): void {
  for (const client of sseClients) {
    try {
      client.write(`event: ${event.type}\n`);
      client.write(`data: ${JSON.stringify(event)}\n\n`);
      sseFlush(client);
    } catch {
      sseClients.delete(client);
    }
  }
}

// -------------------------------------------------
// Slack 集成（可选，在 listen 前初始化）
// -------------------------------------------------

const { notifier: slackNotifier, stop: stopSlack } = await startSlackIntegration({
  agent,
  broadcastSse,
  env: appConfig.env
});

// -------------------------------------------------
// Routes
// -------------------------------------------------

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

// 一键清除会话历史（删除 checkpoints.db → 重建空库）
app.post("/api/session/clear", (_request, response) => {
  agent.clearSession();
  response.json({ ok: true });
});

app.get("/api/events", (request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  sseClients.add(response);

  const event = {
    sessionId: DEFAULT_SESSION_ID,
    channel: "web",
    type: "status",
    payload: { status: "done" }
  } satisfies ChatEventOut;

  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
  sseFlush(response);

  request.on("close", () => {
    sseClients.delete(response);
  });
});

app.post("/api/chat", async (request, response) => {
  const parsedRequest = ChatRequestSchema.safeParse(request.body);
  if (!parsedRequest.success) {
    const sessionId = DEFAULT_SESSION_ID;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const emit = (event: ChatEventOut) => {
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      sseFlush(response);
    };

    emit({
      sessionId,
      channel: "web",
      type: "error",
      payload: { message: "Invalid request body." }
    });
    response.end();
    return;
  }

  const body = parsedRequest.data;
  const sessionId = DEFAULT_SESSION_ID;
  const message = body.message;

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  sseClients.add(response);
  request.on("close", () => {
    sseClients.delete(response);
  });

  // mirrorThreadTs：Web→Slack mirror 时，用户消息的 Slack ts 作为 thread 根
  let mirrorThreadTs: string | undefined;

  const emit = (event: ChatEventOut) => {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    sseFlush(response);
    maybeMirrorToSlack(slackNotifier, event, mirrorThreadTs); // Web→Slack mirror 旁路
  };

  // Web → Slack mirror：先发用户消息到 Slack 默认频道，记录 ts 作为后续 thread 根
  if (slackNotifier) {
    const ts = await slackNotifier.mirrorWebUserMessage(webMessageSlackText(message));
    if (ts) mirrorThreadTs = ts;
  }

  try {
    await agent.handleUserMessage({ sessionId, message, emit });
  } catch (error) {
    emit({
      sessionId,
      channel: "web",
      type: "error",
      payload: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
  } finally {
    response.end();
  }
});

app.post("/api/device-event", async (request, response) => {
  const parsed = DeviceEventRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, message: "Invalid device event body." });
    return;
  }

  const ev = parsed.data;
  const sessionId = DEFAULT_SESSION_ID;
  const deviceLabel = ev.label || ev.name;
  const statusText = ev.status
    ? ev.previousStatus
      ? `状态从 ${ev.previousStatus} 变为 ${ev.status}`
      : `当前状态为 ${ev.status}`
    : "状态已更新";
  const eventText = `设备事件：${deviceLabel}(${ev.deviceId}) ${statusText}`;

  let mirrorThreadTs: string | undefined;

  const emit = (event: ChatEventOut) => {
    broadcastSse(event);
    maybeMirrorToSlack(slackNotifier, event, mirrorThreadTs);
  };

  // 设备事件同步到 Slack（如开启 mirror）
  if (slackNotifier) {
    const ts = await slackNotifier.mirrorWebUserMessage(eventText);
    if (ts) mirrorThreadTs = ts;
  }

  emit({
    sessionId,
    channel: "web",
    type: "status",
    payload: { status: "device_event_received" }
  });

  try {
    await agent.handleDeviceEvent({
      sessionId,
      message: { kind: "text", text: eventText },
      emit
    });
  } catch (error) {
    emit({
      sessionId,
      channel: "web",
      type: "error",
      payload: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }

  response.json({ ok: true });
});

// -------------------------------------------------
// Start — Express + 可选的 Slack Socket Mode
// -------------------------------------------------

app.listen(appConfig.env.PORT, () => {
  log.info("start", `Smart Agent web chat is running at http://localhost:${appConfig.env.PORT}`);
});

// 优雅关闭：断开 Slack WebSocket 和 Foxglove，避免孤立连接导致反复重连
function gracefulShutdown(signal: string) {
  log.info("shutdown", `received ${signal}, stopping...`);
  foxgloveClient.disconnect();
  stopSlack()
    .then(() => log.info("shutdown", "Slack app stopped"))
    .catch((err) => log.error("shutdown", "Slack stop failed:", err))
    .finally(() => process.exit(0));
  // 强制退出兜底：5 秒后仍未退出则强制终止
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
