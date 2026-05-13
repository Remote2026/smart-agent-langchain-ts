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

export type SlackNotifier = {
  /** 发送 Web 用户消息到 Slack 默认频道，返回消息 ts 用于后续 thread 回复 */
  mirrorWebUserMessage(text: string): Promise<string | undefined>;
  /** 发送 Agent final 到 Slack 默认频道（同一 thread） */
  mirrorWebFinal(text: string, threadTs?: string): Promise<void>;
  /** 发送 Agent error 到 Slack 默认频道（同一 thread） */
  mirrorWebError(message: string, threadTs?: string): Promise<void>;
};

export function createSlackNotifier(
  client: WebClient,
  defaultChannelId: string
): SlackNotifier {
  return {
    async mirrorWebUserMessage(text: string) {
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
    },

    async mirrorWebFinal(text: string, threadTs?: string) {
      try {
        await client.chat.postMessage({
          channel: defaultChannelId,
          text: `Agent: ${text}`,
          thread_ts: threadTs
        });
      } catch (err) {
        log.error("mirrorWebFinal", "failed:", err);
      }
    },

    async mirrorWebError(message: string, threadTs?: string) {
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
  };
}
