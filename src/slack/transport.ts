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

export function createSlackTransport(options: {
  agent: SmartAgent;
  broadcastSse: (event: ChatEventOut) => void;
  slackClient: WebClient;
}) {
  const { agent, broadcastSse, slackClient } = options;

  // @mention 事件处理：去除 <@U123> token，只有纯文本传给 Agent
  async function handleAppMention(event: {
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  }) {
    log.info("handleAppMention", { bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 80) });
    // 防回环第2层：过滤 bot 自己发出的消息和非普通消息 subtype
    if (event.bot_id) { log.info("handleAppMention", "skipped: bot_id"); return; }

    // Slack @mention 带图片：下载文件 → base64 → 构造 kind:"image" InputMessage
    if ((event as any).files?.length > 0) {
      const file = (event as any).files[0];
      const mimeType = file.mimetype || "image/jpeg";
      if (!mimeType.startsWith("image/")) {
        log.info("handleAppMention", "file_share skipped: non-image");
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

      log.info("handleAppMention", "processing file_share -> agent");
      await processMessage(
        text ?? "",
        event.channel,
        threadTs,
        { kind: "image", imageBase64: base64, mimeType, text }
      );
      return;
    }

    if (event.subtype) { log.info("handleAppMention", "skipped: subtype"); return; }

    const threadTs = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@\w+>/g, "").trim();
    if (!text) { log.info("handleAppMention", "skipped: empty text after stripping mention"); return; }

    log.info("handleAppMention", "processing -> agent");
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
    log.info("handleDirectMessage", { bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 80) });
    if (event.bot_id) { log.info("handleDirectMessage", "skipped: bot_id"); return; }
    // file_share 是唯一放行的 subtype（图片消息），其他 subtype 全部过滤
    if (event.subtype && event.subtype !== "file_share") {
      log.info("handleDirectMessage", "skipped: subtype=", event.subtype);
      return;
    }

    // Slack 图片消息：下载文件 → base64 → 构造 kind:"image" InputMessage
    if (event.subtype === "file_share" && (event as any).files?.length > 0) {
      const file = (event as any).files[0];
      const mimeType = file.mimetype || "image/jpeg";
      // 只处理图片，忽略其他文件类型
      if (!mimeType.startsWith("image/")) {
        log.info("handleDirectMessage", "file_share skipped: non-image", mimeType);
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

      log.info("handleDirectMessage", "processing file_share -> agent");
      await processMessage(
        text ?? "",
        event.channel,
        undefined,
        { kind: "image", imageBase64: base64, mimeType, text }
      );
      return;
    }

    // 有文件但不是 file_share subtype（正常情况下不该发生），跳过
    if ((event as any).files?.length > 0 && event.subtype !== "file_share") {
      log.info("handleDirectMessage", "files present but not file_share, skipping");
      return;
    }

    if (!event.text?.trim()) { log.info("handleDirectMessage", "skipped: empty text"); return; }

    log.info("handleDirectMessage", "processing DM -> agent");
    await processMessage(event.text.trim(), event.channel, undefined);
  }

  async function processMessage(
    text: string,
    slackChannel: string,
    threadTs: string | undefined,
    overrideMessage?: InputMessage // 非 text 消息时传入（如 kind:"image"）
  ) {
    // emit 双重分发：
    // - 全部事件 → broadcastSse（Web UI 可见所有 node/tool/final/error）
    // - 仅 final/error → Slack thread（避免刷屏，只发结果）
    const emit = (event: ChatEventOut) => {
      broadcastSse(event);

      if (event.type === "final") {
        slackClient.chat.postMessage({
          channel: slackChannel,
          text: event.payload.text,
          ...(threadTs ? { thread_ts: threadTs } : {})
        }).catch(err => log.error("processMessage", "final reply failed:", err));
      }

      if (event.type === "error") {
        slackClient.chat.postMessage({
          channel: slackChannel,
          text: `处理失败：${event.payload.message}`,
          ...(threadTs ? { thread_ts: threadTs } : {})
        }).catch(err => log.error("processMessage", "error reply failed:", err));
      }
    };

    try {
      log.info("processMessage", "calling agent.handleUserMessage...");
      const message: InputMessage = overrideMessage ?? { kind: "text", text };
      await agent.handleUserMessage({
        sessionId: DEFAULT_SESSION_ID,
        message, // 使用构造好的 message 而非硬编码 kind:"text"
        emit,
        channel: "slack"
      });
      log.info("processMessage", "agent.handleUserMessage done");
    } catch (err) {
      log.error("processMessage", "Agent execution failed:", err);
    }
  }

  return { handleAppMention, handleDirectMessage };
}
