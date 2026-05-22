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

const STREAM_FLUSH_MS = 300;
const STREAM_BUFFER_MAX = 120;

type StreamState = {
  ts: string | null;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  startPromise: Promise<void> | null;
};

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
};

export function createSlackNotifier(
  client: WebClient,
  defaultChannelId: string
): SlackNotifier {
  const activeStreams = new Map<string, StreamState>();

  async function flushBuffer(threadTs: string) {
    const state = activeStreams.get(threadTs);
    if (!state || !state.ts || !state.buffer || state.flushing) return;

    state.flushing = true;
    const text = state.buffer;
    state.buffer = "";

    try {
      await client.chat.appendStream({
        channel: defaultChannelId,
        ts: state.ts,
        markdown_text: text,
      });
    } catch (err) {
      log.error("appendStream", "failed:", err);
    } finally {
      state.flushing = false;
      if (state.buffer) {
        scheduleFlush(threadTs);
      }
    }
  }

  function scheduleFlush(threadTs: string) {
    const state = activeStreams.get(threadTs);
    if (!state || state.timer) return;

    const delay = state.buffer.length >= STREAM_BUFFER_MAX ? 0 : STREAM_FLUSH_MS;
    state.timer = setTimeout(() => {
      state.timer = null;
      flushBuffer(threadTs);
    }, delay);
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
        text: `处理失败：${message}`,
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
        timer: null,
        flushing: false,
        startPromise: null,
      };
      activeStreams.set(threadTs, state);

      state.startPromise = (async () => {
        try {
          const result = await client.chat.startStream({
            channel: defaultChannelId,
            markdown_text: text,
            thread_ts: threadTs,
          });
          state!.ts = result.ts || null;
          if (state!.ts && state!.buffer.length > text.length) {
            scheduleFlush(threadTs);
          }
        } catch (err) {
          log.error("startStream", "failed:", err);
          activeStreams.delete(threadTs);
        } finally {
          state!.startPromise = null;
        }
      })();

      return;
    }

    state.buffer += text;
    if (state.ts) {
      scheduleFlush(threadTs);
    }
  }

  async function streamFinal(text: string, threadTs?: string) {
    if (!threadTs) return;

    let state = activeStreams.get(threadTs);
    if (!state) {
      await mirrorWebFinal(text, threadTs);
      return;
    }

    if (state.startPromise) {
      await state.startPromise;
      state = activeStreams.get(threadTs);
      if (!state) {
        await mirrorWebFinal(text, threadTs);
        return;
      }
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    await flushBuffer(threadTs);

    if (state.ts) {
      try {
        await client.chat.stopStream({
          channel: defaultChannelId,
          ts: state.ts,
        });
      } catch (err) {
        log.error("stopStream", "failed:", err);
      }
    }

    activeStreams.delete(threadTs);
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
        await flushBuffer(threadTs);

        if (state.ts) {
          try {
            await client.chat.stopStream({
              channel: defaultChannelId,
              ts: state.ts,
            });
          } catch (err) {
            log.error("stopStream", "failed:", err);
          }
        }
        activeStreams.delete(threadTs);
      }
    }

    await mirrorWebError(message, threadTs);
  }

  return {
    mirrorWebUserMessage,
    mirrorWebFinal,
    mirrorWebError,
    streamToken,
    streamFinal,
    streamError,
  };
}
