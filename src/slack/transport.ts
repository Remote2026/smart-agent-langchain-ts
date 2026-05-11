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
    console.log("[slack:transport] handleAppMention:", { bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 80) });
    // 防回环第2层：过滤 bot 自己发出的消息和非普通消息 subtype
    if (event.bot_id) { console.log("[slack:transport] skipped: bot_id"); return; }
    if (event.subtype) { console.log("[slack:transport] skipped: subtype"); return; }

    const threadTs = event.thread_ts ?? event.ts;
    const text = event.text.replace(/<@\w+>/g, "").trim();
    if (!text) { console.log("[slack:transport] skipped: empty text after stripping mention"); return; }

    console.log("[slack:transport] processing app_mention -> agent");
    await processMessage(text, event.channel, threadTs);
  }

  async function handleDirectMessage(event: {
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  }) {
    console.log("[slack:transport] handleDirectMessage:", { bot_id: event.bot_id, subtype: event.subtype, text: event.text?.slice(0, 80) });
    if (event.bot_id) { console.log("[slack:transport] skipped: bot_id"); return; }
    if (event.subtype) { console.log("[slack:transport] skipped: subtype"); return; }
    if (!event.text?.trim()) { console.log("[slack:transport] skipped: empty text"); return; }

    const threadTs = event.thread_ts ?? event.ts;
    console.log("[slack:transport] processing DM -> agent");
    await processMessage(event.text.trim(), event.channel, threadTs);
  }

  async function processMessage(
    text: string,
    slackChannel: string,
    threadTs: string
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
          thread_ts: threadTs
        }).catch(err => console.error("[slack:transport] final reply failed:", err));
      }

      if (event.type === "error") {
        slackClient.chat.postMessage({
          channel: slackChannel,
          text: `处理失败：${event.payload.message}`,
          thread_ts: threadTs
        }).catch(err => console.error("[slack:transport] error reply failed:", err));
      }
    };

    try {
      console.log("[slack:transport] calling agent.handleUserMessage...");
      await agent.handleUserMessage({
        sessionId: DEFAULT_SESSION_ID,
        message: { kind: "text", text },
        emit,
        channel: "slack"
      });
      console.log("[slack:transport] agent.handleUserMessage done");
    } catch (err) {
      console.error("[slack:transport] Agent execution failed:", err);
    }
  }

  return { handleAppMention, handleDirectMessage };
}
