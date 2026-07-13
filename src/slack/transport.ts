/**
 * SlackTransport：Slack inbound 事件 → SmartAgent 调用
 *
 * 职责：
 * 1. 过滤 bot 消息/subtype/空文本（防回环第二层）
 * 2. 从 Slack event 提取用户文本并去除 <@U123> mention token
 * 3. 构造 emit(event)：全部事件广播到 Web SSE，token/final/error 走流式更新
 * 4. 所有 Slack 消息使用 DEFAULT_SESSION_ID，与 Web 共享 Agent 记忆
 */
import type { WebClient } from "@slack/web-api";
import type { ChatEventOut } from "../types.js";
import type { SmartAgent } from "../agent/agent.js";
import { DEFAULT_SESSION_ID } from "../session.js";
import type { InputMessage } from "../agent/v2/state.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack/transport.ts");

const STREAM_FLUSH_MS = 500;

type StreamState = {
  ts: string;
  channel: string;
  buffer: string;
  /** 当前消息已显示的完整文本（含 tool 状态），update 时以此为基准 */
  displayedText: string;
  /** 上次成功同步到 Slack 的文本，用于检测是否需要 update */
  lastSyncedText: string;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
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

  async function flushStream(key: string) {
    const state = activeStreams.get(key);
    if (!state || state.flushing) return;

    // 在异步发送前快照 displayedText，避免发送期间新 tool 状态被误判为已同步
    const displayedTextAtStart = state.displayedText;
    const hasBuffer = !!state.buffer;
    const hasPendingUpdate = displayedTextAtStart !== state.lastSyncedText;
    if (!hasBuffer && !hasPendingUpdate) return;

    state.flushing = true;

    // displayedText 只维护 tool 状态，buffer 是临时 token
    // 发送时组合，但不把 buffer 持久化到 displayedText
    const parts: string[] = [];
    if (displayedTextAtStart) parts.push(displayedTextAtStart);
    if (state.buffer) parts.push(state.buffer);
    const textToSend = parts.join("\n\n");

    try {
      log.debug("flushStream", "chat.update", { channel: state.channel, ts: state.ts, textLen: textToSend.length });
      await slackClient.chat.update({
        channel: state.channel,
        ts: state.ts,
        text: closeMarkdown(textToSend),
      });
      log.debug("flushStream", "chat.update ok");
      state.lastSyncedText = displayedTextAtStart;
    } catch (err: any) {
      if (err.data?.error === "rate_limited" || err.statusCode === 429) {
        const retryAfter = (err.data?.retry_after || 1) * 1000;
        log.warn("flushStream", `rate limited, retry after ${retryAfter}ms`);
        state.timer = setTimeout(() => {
          state.timer = null;
          flushStream(key);
        }, retryAfter);
      } else {
        log.error("flushStream", "update failed:", err);
      }
    } finally {
      state.buffer = "";
      state.flushing = false;
      // 异步期间 displayedText 可能变化，需要补刷
      const needsFlush = state.displayedText !== state.lastSyncedText || state.buffer;
      if (needsFlush && !state.timer) {
        scheduleFlush(key);
      }
    }
  }

  function scheduleFlush(key: string, delay?: number) {
    const state = activeStreams.get(key);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      state.timer = null;
      flushStream(key);
    }, delay ?? STREAM_FLUSH_MS);
  }

  async function handleSlackToken(key: string, text: string) {
    const state = activeStreams.get(key);
    if (!state) return;
    state.buffer += text;
    scheduleFlush(key);
  }

  async function handleSlackFinal(key: string, channel: string, text: string, threadTs?: string) {
    const state = activeStreams.get(key);
    if (state) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.buffer = "";
      activeStreams.delete(key);
    }

    // final summary 作为一条全新消息发出，不覆盖包含工具状态的流式消息
    try {
      log.debug("handleSlackFinal", "chat.postMessage final", { channel, threadTs, textLen: text.length });
      await slackClient.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      log.debug("handleSlackFinal", "chat.postMessage final ok");
    } catch (err) {
      log.error("handleSlackFinal", "final post failed:", err);
    }
  }

  async function handleSlackError(key: string, channel: string, message: string, threadTs?: string) {
    const state = activeStreams.get(key);
    if (state) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.buffer) {
        state.displayedText += state.buffer;
        state.buffer = "";
      }
      state.buffer = "";
      const parts: string[] = [];
      if (state.displayedText) parts.push(state.displayedText);
      parts.push("Failed: " + message);
      const errorText = parts.join("\n\n");
      try {
        await slackClient.chat.update({
          channel: state.channel,
          ts: state.ts,
          text: closeMarkdown(errorText),
        });
      } catch (err) {
        log.error("handleSlackError", "update failed:", err);
      }
      activeStreams.delete(key);
      return;
    }

    await slackClient.chat.postMessage({
      channel,
      text: `Failed: ${message}`,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }).catch(err => log.error("postMessage", "failed:", err));
  }

  async function handleAppMention(event: {
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  }) {
    if (event.bot_id) return;

    if ((event as any).files?.length > 0) {
      const file = (event as any).files[0];
      const mimeType = file.mimetype || "image/jpeg";
      if (!mimeType.startsWith("image/")) return;
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
      const text = event.text.replace(/<@\w+>/g, "").trim() || undefined;
      const threadTs = event.thread_ts ?? event.ts;

      await processMessage(
        text ?? "",
        event.channel,
        threadTs,
        { kind: "image", imageBase64: base64, mimeType, text },
      );
      return;
    }

    if (event.subtype) return;

    const threadTs = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@\w+>/g, "").trim();
    if (!text) return;

    await processMessage(text, event.channel, threadTs);
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
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== "file_share") return;

    if (event.subtype === "file_share" && (event as any).files?.length > 0) {
      const file = (event as any).files[0];
      const mimeType = file.mimetype || "image/jpeg";
      if (!mimeType.startsWith("image/")) return;
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

      await processMessage(
        text ?? "",
        event.channel,
        undefined,
        { kind: "image", imageBase64: base64, mimeType, text },
      );
      return;
    }

    if ((event as any).files?.length > 0 && event.subtype !== "file_share") return;
    if (!event.text?.trim()) return;

    await processMessage(event.text.trim(), event.channel, undefined);
  }

  async function processMessage(
    text: string,
    slackChannel: string,
    threadTs: string | undefined,
    overrideMessage?: InputMessage,
  ) {
    const key = streamKey(slackChannel, threadTs);

    // 预先创建流式消息，确保后续所有更新都走 chat.update
    let initTs: string | undefined;
    try {
      const result = await slackClient.chat.postMessage({
        channel: slackChannel,
        text: "⏳ Thinking...",
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      initTs = result.ts ?? undefined;
    } catch (err) {
      log.error("processMessage", "init postMessage failed:", err);
    }

    if (initTs) {
      activeStreams.set(key, {
        ts: initTs,
        channel: slackChannel,
        buffer: "",
        displayedText: "",
        lastSyncedText: "",
        timer: null,
        flushing: false,
      });
    }

    function toolStatusText(payload: { name: string; status: string }): string {
      const { name, status } = payload;
      if (status === "executing") return `🔧 Calling tool: ${name}...`;
      if (status === "ok") return `✅ Tool ${name} completed`;
      return `❌ Tool ${name} failed`;
    }

    const emit = (event: ChatEventOut) => {
      broadcastSse(event);

      if (event.type === "tool") {
        const msg = toolStatusText(event.payload);
        const state = activeStreams.get(key);
        if (state) {
          state.displayedText += "\n" + msg;
          if (event.payload.status === "executing") {
            // executing 状态立即刷新，让用户在工具执行期间看到 Calling tool...
            flushStream(key);
          } else {
            // ok/error 状态走 debounce，避免多个快速完成的 tool 产生频繁 update
            scheduleFlush(key, 0);
          }
        } else {
          slackClient.chat.postMessage({
            channel: slackChannel,
            text: msg,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          }).catch(err => log.error("postMessage", "tool status failed:", err));
        }
        return;
      }

      if (event.type === "token") {
        handleSlackToken(key, event.payload.text);
      } else if (event.type === "final") {
        handleSlackFinal(key, slackChannel, event.payload.text, threadTs);
      } else if (event.type === "error") {
        handleSlackError(key, slackChannel, event.payload.message, threadTs);
      }
    };

    try {
      const message: InputMessage = overrideMessage ?? { kind: "text", text };
      await agent.handleUserMessage({
        sessionId: DEFAULT_SESSION_ID,
        message,
        emit,
        channel: "slack"
      });
    } catch (err) {
      log.error("processMessage", "Agent execution failed:", err);
    }
  }

  return { handleAppMention, handleDirectMessage };
}
