import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SmartAgent } from "./agent/agent.js";
import { loadAppConfig } from "./config.js";
import { createTools } from "./tools/index.js";
import { RosbridgeClient } from "./tools/ros2.js";
import { SmartThingsClient } from "./tools/smartthings.js";
import type { ChatEventOut } from "./types.js";
import { ChatRequestSchema, DeviceEventRequestSchema } from "./agent/v2/state.js";
import { LogManager } from "./logging/index.js";

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
// 纯文本模式：1MB 足够，并且能避免异常大请求占用内存。
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(__dirname, "..", "public")));

// SSE 客户端集合：用于设备事件广播到所有已连接的 Web UI
const sseClients = new Set<import("http").ServerResponse>();

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/chat", async (request, response) => {
  /**
   * V2（text-only）请求格式：
   * - { sessionId?, message: { kind: "text", text: string } }
   */
  const parsedRequest = ChatRequestSchema.safeParse(request.body);
  if (!parsedRequest.success) {
    const sessionId = crypto.randomUUID();
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
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();
  const message = body.message;

  /**
   * 说明：这里使用 SSE（Server-Sent Events）向浏览器持续推送事件流。
   *
   * - 这是“传输层”，负责把后端执行过程不断写给前端
   * - Agent 内部使用 LangGraph 负责“控制流”（LLM <-> Tools 的循环）
   * - 我们在 agent.ts 里把 LangGraph 的 stream 输出映射成 ChatEventOut
   *
   * 为什么选 SSE：
   * - 浏览器原生支持 EventSource / fetch + readable stream
   * - 单向推送足够满足“展示思考/工具/最终回答”这种 UI
   * - 若未来需要双向实时（例如人类确认/中断恢复），再升级 WebSocket 也很自然
   */
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

  const emit = (event: ChatEventOut) => {
    // 约定：每条 SSE 消息都包含 event type（事件名）+ data（JSON 字符串）
    // 前端可以按 event.type 分发：status/tool/final/error...
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);

    // 旁路：同一份事件写入日志（落盘），便于回放/排障
    logManager.append(event);
  };

  // Schema 已保证：message 一定存在且为 text
  if (message.kind !== "text") {
    emit({
      sessionId,
      channel: "web",
      type: "error",
      payload: { message: "Only text messages are supported for now." }
    });
    response.end();
    return;
  }

  try {
    // 关键交互点：SmartAgent 内部使用 LangGraph 跑“可控的 agent 图”，并在执行过程中持续 emit SSE 事件。
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
  const sessionId = `device-${crypto.randomUUID()}`;
  const deviceLabel = ev.label || ev.name;
  const eventText = `设备事件：${deviceLabel}(${ev.deviceId}) 状态已更新`;

  // SSE 广播 emit：写入所有已连接客户端
  const emit = (event: ChatEventOut) => {
    for (const client of sseClients) {
      try {
        client.write(`event: ${event.type}\n`);
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
    logManager.append(event);
  };

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

app.listen(appConfig.env.PORT, () => {
  console.log(`Smart Agent web chat is running at http://localhost:${appConfig.env.PORT}`);
});
