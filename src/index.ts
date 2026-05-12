import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SmartAgent } from "./agent/agent.js";
import { loadAppConfig } from "./config.js";
import { createTools } from "./tools/index.js";
import { RosbridgeClient } from "./tools/ros2.js";
import { SmartThingsClient } from "./tools/smartthings.js";
import type { ChatEventOut } from "./types.js";
import { ChatRequestSchema, DeviceEventRequestSchema, type InputMessage } from "./agent/v2/state.js";
import { LogManager } from "./logging/index.js";
import { DEFAULT_SESSION_ID } from "./session.js";
import { startSlackApp } from "./slack/app.js";
import { createSlackNotifier } from "./slack/notifier.js";
import type { SlackNotifier } from "./slack/notifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appConfig = loadAppConfig();
/**
 * 数据流（简化）：
 * HTTP /api/chat -> SmartAgent -> (LangGraph StateGraph) -> tools(smartthings_* / ros2_*) -> SSE -> Web UI
 */
const tools = createTools({
  smartThings: new SmartThingsClient(),
  rosbridge: new RosbridgeClient(appConfig.env.ROSBRIDGE_URL)
});

const agent = new SmartAgent({
  baseURL: appConfig.env.OPENAI_BASE_URL,
  apiKey: appConfig.env.OPENAI_API_KEY,
  model: appConfig.env.OPENAI_MODEL,
  tools
});

/**
 * LogManager：把 SSE 事件落盘（JSONL），每条记录同时包含：
 * - payload：完整结构化事件
 * - summary：人类可读摘要（方便快速扫一眼发生了什么）
 *
 * 写入路径：logs/YYYY-MM-DD/<sessionId>.jsonl
 * - 单一事实源：直接使用 emit(event) 的 ChatEventOut
 */
const logManager = new LogManager({ baseDir: path.resolve(process.cwd(), "logs") });

const app = express();
// 图片 base64 体积比纯文本大，10MB 足够智能家居场景
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve(__dirname, "..", "public")));

// SSE 客户端集合：用于设备事件广播到所有已连接的 Web UI
const sseClients = new Set<import("http").ServerResponse>();

/** 广播 SSE 事件到所有已连接客户端，同时落盘日志 */
function broadcastSse(event: ChatEventOut): void {
  for (const client of sseClients) {
    try {
      client.write(`event: ${event.type}\n`);
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
  logManager.append(event);
}

// ---- Slack 相关（可选，SLACK_ENABLED=true 时启用） ----

import type { App as SlackApp } from "@slack/bolt";
let slackApp: SlackApp | undefined;       // Bolt App 实例，供 SIGINT 优雅关闭
let slackNotifier: SlackNotifier | undefined;

// 防回环第1层：只有 channel === "web" 的 final/error 才 mirror 到 Slack
// Slack 触发的事件 (channel="slack") 绝不走进 mirror，避免重复发回 Slack
function maybeMirrorToSlack(event: ChatEventOut, threadTs?: string): void {
  if (!slackNotifier) return;
  if (event.channel !== "web") return;
  if (event.type === "final") {
    slackNotifier.mirrorWebFinal(event.payload.text, threadTs);
  }
  if (event.type === "error") {
    slackNotifier.mirrorWebError(event.payload.message, threadTs);
  }
}

/** 构造 Web→Slack mirror 文案：
 *  - kind="text" → "Web: {text}"
 *  - kind="image" → "Web: [图片] {text}" 或 "Web: [图片]"（无文字时） */
function webMessageSlackText(msg: InputMessage): string {
  if (msg.kind === "text") return `Web: ${msg.text}`;
  return msg.text
    ? `Web: [图片] ${msg.text}`
    : `Web: [图片]`;
}

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
    logManager.append(event);
    maybeMirrorToSlack(event, mirrorThreadTs); // Web→Slack mirror 旁路
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
    maybeMirrorToSlack(event, mirrorThreadTs);
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
  console.log(`Smart Agent web chat is running at http://localhost:${appConfig.env.PORT}`);

  // Slack 为可选功能：SLACK_ENABLED=true 时才启动 Socket Mode
  if (appConfig.env.SLACK_ENABLED) {
    startSlackApp({ agent, broadcastSse }).then((app) => {
      slackApp = app;
      // Notifier 在 Slack App 启动后初始化（需要 app.client）
      if (appConfig.env.SLACK_MIRROR_WEB_MESSAGES && appConfig.env.SLACK_DEFAULT_CHANNEL_ID) {
        slackNotifier = createSlackNotifier(
          app.client,
          appConfig.env.SLACK_DEFAULT_CHANNEL_ID
        );
        console.log("[slack] Web->Slack mirror enabled");
      }
    }).catch((err) => {
      console.error("[slack] Failed to start Slack App:", err);
    });
  }
});

// 优雅关闭：SIGINT 时断开 Slack WebSocket，避免孤立连接
process.on("SIGINT", () => {
  if (slackApp) {
    slackApp.stop().catch(() => {});
  }
  process.exit(0);
});
