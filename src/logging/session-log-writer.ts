import fs from "node:fs";
import path from "node:path";
import type { ChatEventOut } from "../types.js";

type LogPaths = {
  jsonlPath: string;
};

/**
 * SessionLogWriter：把一次会话的事件落盘（JSONL + 文本摘要）。
 *
 * 设计约束（v1）：
 * - 单一事实源：直接使用 SSE 对外事件 ChatEventOut（不引入第二套事件格式）
 * - 双写：jsonl 保存完整结构化事件；text 保存易读摘要
 * - 串行写入：用 promise 队列避免并发写导致文件内容交错
 */
export class SessionLogWriter {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    private readonly baseDir: string,
    private readonly date: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  getPaths(): LogPaths {
    const dir = path.join(this.baseDir, this.date);
    return {
      jsonlPath: path.join(dir, `${this.sessionId}.jsonl`)
    };
  }

  /**
   * 追加一条 SSE 事件到本会话日志。
   * - JSONL：一行一个 JSON（便于 grep/jq/后处理）
   * - Text：一行一个摘要（便于人直接看）
   */
  append(event: ChatEventOut): void {
    // 关键点：只写 1 个文件（JSONL），但每条记录同时包含：
    // - summary：人类可读摘要
    // - origin：业务代码位置（文件名/函数名），用于快速定位上下文
    // - source：数据来源（node/tool/llm/sse 等）
    const summary = formatTextLine(this.now(), event);
    const meta = inferMeta(event);
    const prettyPayload = formatPrettyPayload(event.payload);
    const record = {
      at: this.now(),
      sessionId: event.sessionId,
      type: event.type,
      source: meta.source,
      origin: meta.origin,
      summary,
      /**
       * prettyPayload：为了人类阅读做的“缩进 + 截断”版本。
       * - 仍然保留 payload 原始结构化数据（机器友好）
       * - prettyPayload 主要用于快速浏览（人眼友好）
       */
      prettyPayload,
      payload: event.payload
    };

    const { jsonlPath } = this.getPaths();
    const jsonLine = `${JSON.stringify(record)}\n`;

    this.writeQueue = this.writeQueue.then(async () => {
      await fs.promises.mkdir(path.dirname(jsonlPath), { recursive: true });
      await fs.promises.appendFile(jsonlPath, jsonLine, "utf8");
    });
  }
}

type InferredMeta = {
  source: "node" | "tool" | "llm" | "sse" | "unknown";
  origin?: { file: string; fn: string };
};

/**
 * inferMeta：把“事件 -> 代码位置/数据来源”补齐到落盘日志里。
 *
 * 为什么在 logger 做：
 * - v1 先以最小侵入满足“日志必须体现 file/fn/source”的需求
 * - 未来如果 GraphEvent 本身已携带 origin/source，可直接在这里读取并覆盖
 */
function inferMeta(event: ChatEventOut): InferredMeta {
  if (event.type === "node") {
    return {
      source: event.payload.source ?? "node",
      origin: event.payload.origin ?? mapNodeToOrigin(event.payload.node)
    };
  }

  if (event.type === "tool") {
    return {
      source: event.payload.source ?? "tool",
      origin: event.payload.origin ?? mapToolToOrigin(event.payload.name)
    };
  }

  if (event.type === "status" || event.type === "final" || event.type === "error") {
    // 这些事件由 SSE 层/运行时汇总产生
    return { source: "sse", origin: { file: "src/index.ts", fn: "emit" } };
  }

  return { source: "unknown" };
}

function mapNodeToOrigin(node: string): { file: string; fn: string } | undefined {
  // 当前 V2 图的 node 都在 src/agent/v2/graph.ts；函数名与 node 基本一一对应
  const file = "src/agent/v2/graph.ts";
  const table: Record<string, string> = {
    ingest: "ingestNode",
    route_modality: "routeModalityNode",
    image_analysis: "imageAnalysisNode",
    text_prepare: "textPrepareNode",
    route_intent: "routeIntentNode",
    smartthings_node: "smartthingsNode",
    ros2_node: "ros2Node",
    default_node: "defaultNode",
    respond: "respondNode"
  };
  const fn = table[node];
  return fn ? { file, fn } : undefined;
}

function mapToolToOrigin(name: string): { file: string; fn: string } | undefined {
  // SmartThings/ROS2 工具注册在 src/tools/index.ts；实际 HTTP/WS 客户端在各自文件
  if (name.startsWith("smartthings_")) {
    return { file: "src/tools/index.ts", fn: "createTools" };
  }
  if (name.startsWith("ros2_")) {
    return { file: "src/tools/index.ts", fn: "createTools" };
  }
  if (name.startsWith("llm.")) {
    return { file: "src/agent/v2/graph.ts", fn: "llm.invoke" };
  }
  return undefined;
}

function formatTextLine(at: string, event: ChatEventOut): string {
  const meta = inferMeta(event);
  const where = meta.origin ? `${meta.origin.file}#${meta.origin.fn}` : "-";
  const prefix = `${at} [${meta.source}] [${where}]`;

  // 目标：让你“肉眼扫一眼”就知道发生了什么，同时不泄露敏感信息（v1 不做深度脱敏）
  if (event.type === "status") {
    return `${prefix} status ${event.payload.status}`;
  }

  if (event.type === "node") {
    return `${prefix} node ${event.payload.node} ${event.payload.phase} ${truncate(event.payload.summary)}`;
  }

  if (event.type === "tool") {
    const suffix =
      event.payload.status === "executing"
        ? `start ${safeInlineJson(event.payload.input)}`
        : event.payload.status === "ok"
          ? `ok ${safeInlineJson(event.payload.output)}`
          : `error ${truncate(event.payload.error ?? "")}`;
    return `${prefix} tool ${event.payload.name} ${suffix}`.trim();
  }

  if (event.type === "final") {
    return `${prefix} final ${truncate(event.payload.text)}`;
  }

  if (event.type === "error") {
    return `${prefix} error ${truncate(event.payload.message)}`;
  }

  // ChatEventOut 是联合类型，这里走不到；保底返回避免 TS 收窄到 never 报错
  return `${prefix} unknown`;
}

function truncate(value: string, limit = 180): string {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…`;
}

function safeInlineJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    const text = JSON.stringify(value);
    return truncate(text, 200);
  } catch {
    return truncate(String(value), 200);
  }
}

function formatPrettyPayload(payload: unknown): string {
  // JSONL 仍然是一行一个 JSON；这里返回的字符串会在 JSON 中以 \n 形式保存
  // 目标：让你在 editor 里展开字段时能看到“可读的缩进结构”
  const maxChars = 6000;
  try {
    const text = JSON.stringify(payload, null, 2);
    return truncate(text, maxChars);
  } catch {
    return truncate(String(payload), maxChars);
  }
}
