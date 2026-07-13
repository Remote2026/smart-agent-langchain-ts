/**
 * SlackTransport：Slack inbound 事件 → SmartAgent 调用
 *
 * 职责：
 * 1. 过滤 bot 消息/subtype/空文本（防回环第二层）
 * 2. 从 Slack event 提取用户文本并去除 <@U123> mention token
 * 3. 构造 emit(event)：全部事件广播到 Web SSE，tool/final/error 各自作为独立完整消息发到 Slack
 * 4. 所有 Slack 消息使用 DEFAULT_SESSION_ID，与 Web 共享 Agent 记忆
 */
import type { WebClient } from "@slack/web-api";
import type { ChatEventOut } from "../types.js";
import type { SmartAgent } from "../agent/agent.js";
import { DEFAULT_SESSION_ID } from "../session.js";
import type { InputMessage } from "../agent/v2/state.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack/transport.ts");

function toolStatusText(payload: { name: string; status: string }): string {
  const { name, status } = payload;
  if (status === "executing") return `🔧 Calling tool: ${name}...`;
  if (status === "ok") return `✅ Tool ${name} completed`;
  return `❌ Tool ${name} failed`;
}

export function createSlackTransport(options: {
  agent: SmartAgent;
  broadcastSse: (event: ChatEventOut) => void;
  slackClient: WebClient;
}) {
  const { agent, broadcastSse, slackClient } = options;

  async function postMessage(channel: string, text: string, threadTs?: string) {
    try {
      await slackClient.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (err) {
      log.error("postMessage", "failed:", err);
    }
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
    // 每条状态都是独立完整消息：先发 Thinking
    await postMessage(slackChannel, "⏳ Thinking...", threadTs);

    // 用 Promise 队列保证多条消息按 emit 顺序发出
    let outboundQueue: Promise<void> = Promise.resolve();
    function enqueue(text: string) {
      outboundQueue = outboundQueue.then(() => postMessage(slackChannel, text, threadTs));
    }

    const emit = (event: ChatEventOut) => {
      broadcastSse(event);

      if (event.type === "tool") {
        enqueue(toolStatusText(event.payload));
        return;
      }

      if (event.type === "final") {
        enqueue(event.payload.text);
      } else if (event.type === "error") {
        enqueue(`Failed: ${event.payload.message}`);
      }
      // status/node/token 事件只广播到 SSE，不往 Slack 发
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
