/**
 * SlackNotifier：Web/设备事件 → Slack 单向同步
 *
 * 职责：封装向 Slack 默认频道主动发消息的能力，供 /api/chat 和 /api/device-event 的 mirror 逻辑调用。
 * 不处理 Slack inbound 事件（那是 transport.ts 的职责），
 * 不把 Slack client 传入 Agent（保持 Agent 对传输层无感）。
 *
 * 当前策略：每条状态都是独立完整消息，不再使用 chat.update 维护单条流式消息。
 */
import type { WebClient } from "@slack/web-api";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack/notifier.ts");

function toolStatusText(payload: { name: string; status: string }): string {
  const { name, status } = payload;
  if (status === "executing") return `🔧 Calling tool: ${name}...`;
  if (status === "ok") return `✅ Tool ${name} completed`;
  return `❌ Tool ${name} failed`;
}

export type SlackNotifier = {
  /** 发送 Web 用户消息到 Slack 默认频道，返回消息 ts 用于后续 thread 回复 */
  mirrorWebUserMessage(text: string): Promise<string | undefined>;
  /** 发送 Agent final 到 Slack 默认频道（同一 thread） */
  mirrorWebFinal(text: string, threadTs?: string): Promise<void>;
  /** 发送 Agent error 到 Slack 默认频道（同一 thread） */
  mirrorWebError(message: string, threadTs?: string): Promise<void>;
  /** 流式：追加一个 token chunk（Slack 侧忽略，final 会单独发完整消息） */
  streamToken(text: string, threadTs?: string): Promise<void>;
  /** 流式：结束流，发送完整 final 消息 */
  streamFinal(text: string, threadTs?: string): Promise<void>;
  /** 流式：出错时发送错误消息 */
  streamError(message: string, threadTs?: string): Promise<void>;
  /** 流式/非流式：发送工具调用状态 */
  streamToolStatus(payload: { name: string; status: string }, threadTs?: string): void;
};

export function createSlackNotifier(
  client: WebClient,
  defaultChannelId: string
): SlackNotifier {
  // 记录每个 thread 是否已经补发了一条 Thinking...，保持和 transport 一致的 UX
  const thinkingPosted = new Set<string>();
  // 按 thread 串行发送，保证消息顺序
  const outboundQueues = new Map<string, Promise<void>>();
  const seqByThread = new Map<string, number>();

  async function postMessage(channel: string, text: string, threadTs?: string) {
    try {
      await client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (err) {
      log.error("postMessage", "failed:", err);
    }
  }

  function enqueue(threadTs: string | undefined, text: string) {
    if (!threadTs) return;
    const seq = (seqByThread.get(threadTs) ?? 0) + 1;
    seqByThread.set(threadTs, seq);
    log.info("enqueue", `#[${threadTs}:${seq}] queueing Slack message`, { channel: defaultChannelId, threadTs, textLen: text.length, preview: text.slice(0, 80) });
    const queue = outboundQueues.get(threadTs) ?? Promise.resolve();
    outboundQueues.set(threadTs, queue.then(async () => {
      log.info("dequeue", `#[${threadTs}:${seq}] sending Slack message`, { channel: defaultChannelId, threadTs, textLen: text.length, preview: text.slice(0, 80) });
      await postMessage(defaultChannelId, text, threadTs);
      log.info("dequeue", `#[${threadTs}:${seq}] Slack message sent`, { channel: defaultChannelId, threadTs });
    }));
  }

  function ensureThinking(threadTs: string | undefined) {
    if (!threadTs || thinkingPosted.has(threadTs)) return;
    thinkingPosted.add(threadTs);
    enqueue(threadTs, "⏳ Thinking...");
  }

  async function mirrorWebUserMessage(text: string) {
    try {
      const result = await client.chat.postMessage({
        channel: defaultChannelId,
        text: `Web: ${text}`
      });
      return result.ts;
    } catch (err) {
      log.error("mirrorWebUserMessage", "failed:", err);
      return undefined;
    }
  }

  async function mirrorWebFinal(text: string, threadTs?: string) {
    try {
      await client.chat.postMessage({
        channel: defaultChannelId,
        text: `Agent: ${text}`,
        thread_ts: threadTs
      });
    } catch (err) {
      log.error("mirrorWebFinal", "failed:", err);
    }
  }

  async function mirrorWebError(message: string, threadTs?: string) {
    try {
      await client.chat.postMessage({
        channel: defaultChannelId,
        text: `Failed: ${message}`,
        thread_ts: threadTs
      });
    } catch (err) {
      log.error("mirrorWebError", "failed:", err);
    }
  }

  async function streamToken(_text: string, threadTs?: string) {
    // Slack 不逐 token 渲染，只在第一次收到 token 时补一条 Thinking... 消息
    ensureThinking(threadTs);
  }

  async function streamFinal(text: string, threadTs?: string) {
    ensureThinking(threadTs);
    enqueue(threadTs, `Agent: ${text}`);
  }

  async function streamError(message: string, threadTs?: string) {
    ensureThinking(threadTs);
    enqueue(threadTs, `Failed: ${message}`);
  }

  function streamToolStatus(payload: { name: string; status: string }, threadTs?: string) {
    ensureThinking(threadTs);
    enqueue(threadTs, toolStatusText(payload));
  }

  return {
    mirrorWebUserMessage,
    mirrorWebFinal,
    mirrorWebError,
    streamToken,
    streamFinal,
    streamError,
    streamToolStatus,
  };
}
