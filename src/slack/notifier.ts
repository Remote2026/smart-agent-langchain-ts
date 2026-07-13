/**
 * SlackNotifier：Web/设备事件 → Slack 单向同步
 *
 * 职责：封装向 Slack 默认频道主动发消息的能力，供 /api/chat 和 /api/device-event 的 mirror 逻辑调用。
 * 不处理 Slack inbound 事件（那是 transport.ts 的职责），
 * 不把 Slack client 传入 Agent（保持 Agent 对传输层无感）。
 */
import type { WebClient } from "@slack/web-api";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack/notifier.ts");

const STREAM_FLUSH_MS = 500;

type StreamState = {
  ts: string | null;
  buffer: string;
  displayedText: string;
  lastSyncedText: string;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  startPromise: Promise<void> | null;
  finalText?: string;
};

/** 在临时更新时自动补全未闭合的 Markdown，防止排版错乱 */
function closeMarkdown(text: string): string {
  let result = text;

  // 粗体 **
  const boldCount = (result.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) result += "**";

  // inline code `（排除 ``` 代码块内的）
  let singleBacktickCount = 0;
  let inCodeBlock = false;
  for (let i = 0; i < result.length; i++) {
    if (result.slice(i, i + 3) === "```") {
      inCodeBlock = !inCodeBlock;
      i += 2;
      continue;
    }
    if (!inCodeBlock && result[i] === "`") {
      singleBacktickCount++;
    }
  }
  if (singleBacktickCount % 2 !== 0) result += "`";

  // 代码块 ```
  const codeBlockCount = (result.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) result += "\n```";

  return result;
}

export type SlackNotifier = {
  /** 发送 Web 用户消息到 Slack 默认频道，返回消息 ts 用于后续 thread 回复 */
  mirrorWebUserMessage(text: string): Promise<string | undefined>;
  /** 发送 Agent final 到 Slack 默认频道（同一 thread） */
  mirrorWebFinal(text: string, threadTs?: string): Promise<void>;
  /** 发送 Agent error 到 Slack 默认频道（同一 thread） */
  mirrorWebError(message: string, threadTs?: string): Promise<void>;
  /** 流式：追加一个 token chunk */
  streamToken(text: string, threadTs?: string): Promise<void>;
  /** 流式：结束流，如有未 flush 的 buffer 会先发送 */
  streamFinal(text: string, threadTs?: string): Promise<void>;
  /** 流式：出错时结束流并发送错误消息 */
  streamError(message: string, threadTs?: string): Promise<void>;
  /** 流式/非流式：发送工具调用状态 */
  streamToolStatus(payload: { name: string; status: string }, threadTs?: string): void;
};

export function createSlackNotifier(
  client: WebClient,
  defaultChannelId: string
): SlackNotifier {
  const activeStreams = new Map<string, StreamState>();

  async function flushBuffer(threadTs: string) {
    const state = activeStreams.get(threadTs);
    if (!state || !state.ts || state.flushing) return;

    if (state.finalText) {
      state.flushing = true;
      try {
        log.debug("flushBuffer", "chat.update final", { channel: defaultChannelId, ts: state.ts, textLen: state.finalText.length });
        await client.chat.update({
          channel: defaultChannelId,
          ts: state.ts,
          text: state.finalText,
        });
        log.debug("flushBuffer", "chat.update final ok");
      } catch (err) {
        log.error("flushBuffer", "final update failed:", err);
      } finally {
        activeStreams.delete(threadTs);
      }
      return;
    }

    const displayedTextAtStart = state.displayedText;
    const hasBuffer = !!state.buffer;
    const hasPendingUpdate = displayedTextAtStart !== state.lastSyncedText;
    if (!hasBuffer && !hasPendingUpdate) return;

    state.flushing = true;

    const parts: string[] = [];
    if (displayedTextAtStart) parts.push(displayedTextAtStart);
    if (state.buffer) parts.push(state.buffer);
    const textToSend = parts.join("\n\n");

    try {
      log.debug("flushBuffer", "chat.update", { channel: defaultChannelId, ts: state.ts, textLen: textToSend.length });
      await client.chat.update({
        channel: defaultChannelId,
        ts: state.ts,
        text: closeMarkdown(textToSend),
      });
      log.debug("flushBuffer", "chat.update ok");
      state.lastSyncedText = displayedTextAtStart;
    } catch (err: any) {
      if (err.data?.error === "rate_limited" || err.statusCode === 429) {
        const retryAfter = (err.data?.retry_after || 1) * 1000;
        log.warn("flushBuffer", `rate limited, retry after ${retryAfter}ms`);
        state.timer = setTimeout(() => {
          state.timer = null;
          flushBuffer(threadTs);
        }, retryAfter);
      } else {
        log.error("flushBuffer", "update failed:", err);
      }
    } finally {
      state.buffer = "";
      state.flushing = false;
      // 异步期间 displayedText 可能变化，需要补刷
      const needsFlush = state.displayedText !== state.lastSyncedText || state.buffer || state.finalText;
      if (needsFlush && !state.timer) {
        scheduleFlush(threadTs);
      }
    }
  }

  function scheduleFlush(threadTs: string, delay?: number) {
    const state = activeStreams.get(threadTs);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      state.timer = null;
      flushBuffer(threadTs);
    }, delay ?? STREAM_FLUSH_MS);
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

  async function streamToken(text: string, threadTs?: string) {
    if (!threadTs) return;

    let state = activeStreams.get(threadTs);
    if (!state) {
      state = {
        ts: null,
        buffer: text,
        displayedText: "",
        lastSyncedText: "",
        timer: null,
        flushing: false,
        startPromise: null,
      };
      activeStreams.set(threadTs, state);

      state.startPromise = (async () => {
        try {
          const result = await client.chat.postMessage({
            channel: defaultChannelId,
            text: "⏳ Thinking...",
            thread_ts: threadTs,
          });
          state!.ts = result.ts || null;
          if (state!.ts) {
            state!.displayedText = "";
            state!.lastSyncedText = "";
          }
        } catch (err) {
          log.error("streamToken", "postMessage failed:", err);
          activeStreams.delete(threadTs);
        } finally {
          state!.startPromise = null;
        }
      })();
      return;
    }

    state.buffer += text;
    if (state.ts && !state.finalText) {
      scheduleFlush(threadTs);
    }
  }

  async function streamFinal(text: string, threadTs?: string) {
    if (!threadTs) return;

    const state = activeStreams.get(threadTs);
    if (state?.startPromise) {
      await state.startPromise;
    }

    const currentState = activeStreams.get(threadTs);
    if (currentState) {
      if (currentState.timer) {
        clearTimeout(currentState.timer);
        currentState.timer = null;
      }
      currentState.buffer = "";
      activeStreams.delete(threadTs);
    }

    // final summary 作为 thread 里的全新消息发出，不覆盖包含工具状态的流式消息
    await mirrorWebFinal(text, threadTs);
  }

  async function streamError(message: string, threadTs?: string) {
    if (!threadTs) return;

    let state = activeStreams.get(threadTs);
    if (state) {
      if (state.startPromise) {
        await state.startPromise;
        state = activeStreams.get(threadTs);
      }

      if (state) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        state.buffer = "";
        const parts: string[] = [];
        if (state.displayedText) parts.push(state.displayedText);
        parts.push("Failed: " + message);
        const errorText = parts.join("\n\n");
        if (state.ts) {
          try {
            await client.chat.update({
              channel: defaultChannelId,
              ts: state.ts,
              text: closeMarkdown(errorText),
            });
          } catch (err) {
            log.error("streamError", "update failed:", err);
          }
        }
        activeStreams.delete(threadTs);
      }
      return;
    }

    await mirrorWebError(message, threadTs);
  }

  function streamToolStatus(payload: { name: string; status: string }, threadTs?: string) {
    if (!threadTs) return;
    const icon = payload.status === "executing" ? "🔧" : payload.status === "ok" ? "✅" : "❌";
    const msg = payload.status === "executing"
      ? `${icon} Calling tool: ${payload.name}...`
      : `${icon} Tool ${payload.name} ${payload.status === "ok" ? "completed" : "failed"}`;

    const state = activeStreams.get(threadTs);
    if (state && state.ts) {
      state.displayedText += "\n" + msg;
      if (payload.status === "executing") {
        // executing 状态立即刷新，让用户在工具执行期间看到 Calling tool...
        flushBuffer(threadTs);
      } else {
        // ok/error 状态走 debounce
        scheduleFlush(threadTs, 0);
      }
    } else {
      log.debug("streamToolStatus", `postMessage (no stream): ${msg}`);
      client.chat.postMessage({
        channel: defaultChannelId,
        text: msg,
        thread_ts: threadTs,
      }).catch(err => log.error("postMessage", "tool status failed:", err));
    }
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
