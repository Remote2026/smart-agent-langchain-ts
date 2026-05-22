/**
 * SlackTransport：Slack inbound 事件 → SmartAgent 调用
 *
 * 职责：
 * 1. 过滤 bot 消息/subtype/空文本（防回环第二层）
 * 2. 从 Slack event 提取用户文本并去除 <@U123> mention token
 * 3. 构造 emit(event)：全部事件广播到 Web SSE，仅 final/error 回复 Slack thread
 * 4. 所有 Slack 消息使用 DEFAULT_SESSION_ID，与 Web 共享 Agent 记忆
 */
import type { WebClient } from "@slack/web-api";
import type { ChatEventOut } from "../types.js";
import type { SmartAgent } from "../agent/agent.js";
import { DEFAULT_SESSION_ID } from "../session.js";
import type { InputMessage } from "../agent/v2/state.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack/transport.ts");

const STREAM_FLUSH_MS = 300;
const STREAM_BUFFER_MAX = 120;

type StreamState = {
  ts: string | null;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  startPromise: Promise<void> | null;
};

export function createSlackTransport(options: {
  agent: SmartAgent;
  broadcastSse: (event: ChatEventOut) => void;
  slackClient: WebClient;
}) {
  const { agent, broadcastSse, slackClient } = options;
  const activeStreams = new Map<string, StreamState>();

  function streamKey(channel: string, threadTs?: string) {
    return threadTs ? `${channel}:${threadTs}` : channel;
  }

  async function flushStream(key: string, channel: string) {
    const state = activeStreams.get(key);
    if (!state || !state.ts || !state.buffer || state.flushing) return;

    state.flushing = true;
    const text = state.buffer;
    state.buffer = "";
    log.info("flushStream", `appendStream key=${key} len=${text.length}`);

    try {
      await slackClient.chat.appendStream({
        channel,
        ts: state.ts,
        markdown_text: text,
      });
    } catch (err) {
      log.error("appendStream", "failed:", err);
    } finally {
      state.flushing = false;
      if (state.buffer) {
        scheduleFlush(key, channel);
      }
    }
  }

  function scheduleFlush(key: string, channel: string) {
    const state = activeStreams.get(key);
    if (!state || state.timer) return;

    const delay = state.buffer.length >= STREAM_BUFFER_MAX ? 0 : STREAM_FLUSH_MS;
    state.timer = setTimeout(() => {
      state.timer = null;
      flushStream(key, channel);
    }, delay);
  }

  async function startSlackStream(key: string, channel: string, text: string, threadTs?: string) {
    const state: StreamState = {
      ts: null,
      buffer: text,
      timer: null,
      flushing: false,
      startPromise: null,
    };
    activeStreams.set(key, state);

    state.startPromise = (async () => {
      try {
        const startArgs: { channel: string; markdown_text: string; thread_ts?: string } = {
          channel,
          markdown_text: text,
        };
        if (threadTs) startArgs.thread_ts = threadTs;
        log.info("startSlackStream", `startStream key=${key} textLen=${text.length}`);
        const result = await slackClient.chat.startStream(startArgs as any);
        state.ts = result.ts || null;
        log.info("startSlackStream", `startStream ok key=${key} ts=${state.ts}`);
        if (state.ts && state.buffer.length > text.length) {
          scheduleFlush(key, channel);
        }
      } catch (err) {
        log.error("startStream", "failed:", err);
        activeStreams.delete(key);
      } finally {
        state.startPromise = null;
      }
    })();
  }

  async function handleSlackToken(key: string, channel: string, text: string, threadTs?: string) {
    log.info("handleSlackToken", `key=${key} textLen=${text.length}`);
    let state = activeStreams.get(key);
    if (!state) {
      await startSlackStream(key, channel, text, threadTs);
      return;
    }
    state.buffer += text;
    if (state.ts) {
      scheduleFlush(key, channel);
    }
  }

  async function handleSlackFinal(key: string, channel: string, text: string, threadTs?: string) {
    log.info("handleSlackFinal", `key=${key} textLen=${text.length}`);
    let state = activeStreams.get(key);
    if (!state) {
      log.info("handleSlackFinal", "no active stream, fallback to postMessage");
      await slackClient.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {})
      }).catch(err => log.error("postMessage", "failed:", err));
      return;
    }

    if (state.startPromise) {
      await state.startPromise;
      state = activeStreams.get(key);
      if (!state) {
        await slackClient.chat.postMessage({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {})
        }).catch(err => log.error("postMessage", "failed:", err));
        return;
      }
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    await flushStream(key, channel);

    if (state.ts) {
      try {
        log.info("handleSlackFinal", `stopStream key=${key} ts=${state.ts}`);
        await slackClient.chat.stopStream({ channel, ts: state.ts });
      } catch (err) {
        log.error("stopStream", "failed:", err);
      }
    }
    activeStreams.delete(key);
  }

  async function handleSlackError(key: string, channel: string, message: string, threadTs?: string) {
    let state = activeStreams.get(key);
    if (state) {
      if (state.startPromise) {
        await state.startPromise;
        state = activeStreams.get(key);
      }
      if (state) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        await flushStream(key, channel);
        if (state.ts) {
          try {
            await slackClient.chat.stopStream({ channel, ts: state.ts });
          } catch (err) {
            log.error("stopStream", "failed:", err);
          }
        }
        activeStreams.delete(key);
      }
    }

    await slackClient.chat.postMessage({
      channel,
      text: `处理失败：${message}`,
      ...(threadTs ? { thread_ts: threadTs } : {})
    }).catch(err => log.error("postMessage", "failed:", err));
  }

  // @mention 事件处理：去除 <@U123> token，只有纯文本传给 Agent
  async function handleAppMention(event: {
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  }) {
    // log.info("handleAppMention", { bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 80) });
    // 防回环第2层：过滤 bot 自己发出的消息和非普通消息 subtype
    if (event.bot_id) { /* log.info("handleAppMention", "skipped: bot_id"); */ return; }

    // Slack @mention 带图片：下载文件 → base64 → 构造 kind:"image" InputMessage
    if ((event as any).files?.length > 0) {
      const file = (event as any).files[0];
      const mimeType = file.mimetype || "image/jpeg";
      if (!mimeType.startsWith("image/")) {
        // log.info("handleAppMention", "file_share skipped: non-image");
        return;
      }
      const token = process.env.SLACK_BOT_TOKEN;
      const response = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        log.error("handleAppMention", "file download failed:", response.status);
        return;
      }
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      // 去除 <@U123> mention token，保留纯文本
      const text = event.text.replace(/<@\w+>/g, "").trim() || undefined;
      const threadTs = event.thread_ts ?? event.ts;

      // log.info("handleAppMention", "processing file_share -> agent");
      await processMessage(
        text ?? "",
        event.channel,
        threadTs,
        { kind: "image", imageBase64: base64, mimeType, text },
        false
      );
      return;
    }

    if (event.subtype) { /* log.info("handleAppMention", "skipped: subtype"); */ return; }

    const threadTs = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@\w+>/g, "").trim();
    if (!text) { /* log.info("handleAppMention", "skipped: empty text after stripping mention"); */ return; }

    // log.info("handleAppMention", "processing -> agent");
    await processMessage(text, event.channel, threadTs, undefined, false);
  }

  async function handleDirectMessage(event: {
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
    files?: Array<{ url_private: string; mimetype: string }>;
  }) {
    // log.info("handleDirectMessage", { bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 80) });
    if (event.bot_id) { /* log.info("handleDirectMessage", "skipped: bot_id"); */ return; }
    // file_share 是唯一放行的 subtype（图片消息），其他 subtype 全部过滤
    if (event.subtype && event.subtype !== "file_share") {
      // log.info("handleDirectMessage", "skipped: subtype=", event.subtype);
      return;
    }

    // Slack 图片消息：下载文件 → base64 → 构造 kind:"image" InputMessage
    if (event.subtype === "file_share" && (event as any).files?.length > 0) {
      const file = (event as any).files[0];
      const mimeType = file.mimetype || "image/jpeg";
      // 只处理图片，忽略其他文件类型
      if (!mimeType.startsWith("image/")) {
        // log.info("handleDirectMessage", "file_share skipped: non-image", mimeType);
        return;
      }
      const token = process.env.SLACK_BOT_TOKEN;
      const response = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        log.error("handleDirectMessage", "file download failed:", response.status);
        return;
      }
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const text = (event.text || "").trim() || undefined;
      const threadTs = (event as any).thread_ts ?? event.ts;

      // log.info("handleDirectMessage", "processing file_share -> agent");
      await processMessage(
        text ?? "",
        event.channel,
        threadTs,
        { kind: "image", imageBase64: base64, mimeType, text },
        true
      );
      return;
    }

    // 有文件但不是 file_share subtype（正常情况下不该发生），跳过
    if ((event as any).files?.length > 0 && event.subtype !== "file_share") {
      // log.info("handleDirectMessage", "files present but not file_share, skipping");
      return;
    }

    if (!event.text?.trim()) { /* log.info("handleDirectMessage", "skipped: empty text"); */ return; }

    // log.info("handleDirectMessage", "processing DM -> agent");
    await processMessage(event.text.trim(), event.channel, undefined, undefined, true);
  }

  async function processMessage(
    text: string,
    slackChannel: string,
    threadTs: string | undefined,
    overrideMessage?: InputMessage, // 非 text 消息时传入（如 kind:"image"）
    isDm?: boolean
  ) {
    const key = streamKey(slackChannel, threadTs);

    // emit 双重分发：
    // - 全部事件 → broadcastSse（Web UI 可见所有 node/tool/final/error）
    // - channel（@mention）→ Slack thread 流式回复
    // - DM → 直接 postMessage（chat.startStream 强制要求 thread_ts，会创建 thread）
    function toolStatusText(payload: { name: string; status: string }): string {
      const { name, status } = payload;
      if (status === "executing") return `🔧 正在调用工具: ${name}...`;
      if (status === "ok") return `✅ 工具 ${name} 已完成`;
      return `❌ 工具 ${name} 失败`;
    }

    const emit = (event: ChatEventOut) => {
      broadcastSse(event);

      if (event.type === "tool") {
        const msg = toolStatusText(event.payload);
        if (isDm) {
          slackClient.chat.postMessage({ channel: slackChannel, text: msg })
            .catch(err => log.error("postMessage", "failed:", err));
        } else {
          const state = activeStreams.get(key);
          if (state && state.ts) {
            slackClient.chat.appendStream({
              channel: slackChannel,
              ts: state.ts,
              markdown_text: msg,
            }).catch(err => log.error("appendStream", "tool status failed:", err));
          } else {
            slackClient.chat.postMessage({
              channel: slackChannel,
              text: msg,
              ...(threadTs ? { thread_ts: threadTs } : {})
            }).catch(err => log.error("postMessage", "failed:", err));
          }
        }
        return;
      }

      if (isDm) {
        if (event.type === "final") {
          slackClient.chat.postMessage({
            channel: slackChannel,
            text: event.payload.text,
          }).catch(err => log.error("postMessage", "failed:", err));
        } else if (event.type === "error") {
          slackClient.chat.postMessage({
            channel: slackChannel,
            text: `处理失败：${event.payload.message}`,
          }).catch(err => log.error("postMessage", "failed:", err));
        }
        return;
      }

      if (event.type === "token") {
        handleSlackToken(key, slackChannel, event.payload.text, threadTs);
      } else if (event.type === "final") {
        handleSlackFinal(key, slackChannel, event.payload.text, threadTs);
      } else if (event.type === "error") {
        handleSlackError(key, slackChannel, event.payload.message, threadTs);
      }
    };

    try {
      // log.info("processMessage", "calling agent.handleUserMessage...");
      const message: InputMessage = overrideMessage ?? { kind: "text", text };
      await agent.handleUserMessage({
        sessionId: DEFAULT_SESSION_ID,
        message, // 使用构造好的 message 而非硬编码 kind:"text"
        emit,
        channel: "slack"
      });
      // log.info("processMessage", "agent.handleUserMessage done");
    } catch (err) {
      log.error("processMessage", "Agent execution failed:", err);
    }
  }

  return { handleAppMention, handleDirectMessage };
}
