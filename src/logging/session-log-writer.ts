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
  private dirReady = false;
  private jsonlPath: string;

  constructor(
    private readonly sessionId: string,
    private readonly baseDir: string,
    private readonly date: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    const dir = path.join(this.baseDir, this.date);
    this.jsonlPath = path.join(dir, `${this.sessionId}.jsonl`);
  }

  getPaths(): LogPaths {
    return { jsonlPath: this.jsonlPath };
  }

  append(event: ChatEventOut): void {
    const summary = formatTextLine(this.now(), event);
    const meta = inferMeta(event);
    const record = {
      at: this.now(),
      sessionId: event.sessionId,
      type: event.type,
      source: meta.source,
      origin: meta.origin,
      summary,
      prettyPayload: formatPrettyPayload(event.payload),
      payload: event.payload
    };

    const jsonLine = `${JSON.stringify(record)}\n`;

    // 保证 mkdir 只执行一次，后续 append 直接写文件
    if (!this.dirReady) {
      this.writeQueue = this.writeQueue.then(async () => {
        await fs.promises.mkdir(path.dirname(this.jsonlPath), { recursive: true });
        this.dirReady = true;
        await fs.promises.appendFile(this.jsonlPath, jsonLine, "utf8");
      });
    } else {
      this.writeQueue = this.writeQueue.then(() =>
        fs.promises.appendFile(this.jsonlPath, jsonLine, "utf8")
      );
    }
  }
}

type InferredMeta = {
  source: "node" | "tool" | "llm" | "sse" | "unknown";
  origin?: { file: string; fn: string };
};

/**
 * inferMeta：把"事件 -> 代码位置/数据来源"补齐到落盘日志里。
 *
 * 为什么在 logger 做：
 * - v1 先以最小侵入满足"日志必须体现 file/fn/source"的需求
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
  const file = "src/agent/v2/graph.ts";
  const table: Record<string, string> = {
    prepare: "prepareNode",
    llm_call: "llmCallNode",
    tool_node: "toolNode",
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

  // 目标：让你"肉眼扫一眼"就知道发生了什么，同时不泄露敏感信息（v1 不做深度脱敏）
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
  // 目标：让你在 editor 里展开字段时能看到"可读的缩进结构"
  const maxChars = 6000;
  try {
    const text = JSON.stringify(payload, null, 2);
    return truncate(text, maxChars);
  } catch {
    return truncate(String(payload), maxChars);
  }
}
