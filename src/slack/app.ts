/**
 * Slack App（Socket Mode 启动）
 *
 * 职责：
 * 1. 创建 Bolt App（Socket Mode，无公网 HTTPS endpoint）
 * 2. 注册 app_mention 和 DM (message.im) 事件监听
 * 3. 将有效事件委托给 SlackTransport 处理
 * 4. Socket Mode 自动确认事件（ack 由 Bolt 内部处理，不需要手动调用）
 * 5. 返回 App 实例供 index.ts 生命周期管理（优雅关闭、Notifier 初始化）
 */
import { App, type AppOptions } from "@slack/bolt";
import type { ChatEventOut } from "../types.js";
import type { SmartAgent } from "../agent/agent.js";
import { createSlackTransport } from "./transport.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack/app.ts");

export async function startSlackApp(options: {
  agent: SmartAgent;
  broadcastSse: (event: ChatEventOut) => void;
}): Promise<App> {
  const { agent, broadcastSse } = options;

  log.info("startSlackApp", "Initializing App with Socket Mode...");
  const app = new App({
    socketMode: true,
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    logger: {
      debug: (msg: string) => log.debug("bolt", msg),
      info: (msg: string) => log.info("bolt", msg),
      warn: (msg: string) => log.warn("bolt", msg),
      error: (msg: string) => log.error("bolt", msg),
      setLevel: () => {},
      getLevel: () => "info" as any,
      setName: () => {},
    }
  } as AppOptions);
  log.info("startSlackApp", "App created, calling app.start()...");

  const transport = createSlackTransport({
    agent,
    broadcastSse,
    slackClient: app.client
  });

  app.event("app_mention" as any, async ({ event }: any) => {
    log.info("app_mention", "received:", { text: event.text?.slice(0, 80), channel: event.channel, ts: event.ts });
    await transport.handleAppMention({
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      thread_ts: (event as any).thread_ts,
      bot_id: (event as any).bot_id,
      subtype: (event as any).subtype
    });
  });

  app.event("message" as any, async ({ event }: any) => {
    log.info("message", "received:", { channel_type: event.channel_type, subtype: (event as any).subtype, text: event.text?.slice(0, 80), channel: event.channel, ts: event.ts });

    // file_share（图片消息）放行给 transport 处理，其他 subtype 跳过
    if ((event as any).subtype && (event as any).subtype !== "file_share") {
      log.info("message", "skipped: subtype=", (event as any).subtype);
      return;
    }

    if (event.channel_type !== "im") {
      log.info("message", "skipped: channel_type=", event.channel_type, "(not DM)");
      return;
    }

    await transport.handleDirectMessage({
      text: (event as any).text ?? "",
      channel: event.channel,
      ts: event.ts,
      thread_ts: (event as any).thread_ts,
      bot_id: (event as any).bot_id,
      subtype: (event as any).subtype,
      files: (event as any).files
    });
  });

  app.error(async (error) => {
    log.error("bolt", "App error:", error);
  });

  await app.start();
  log.info("startSlackApp", "Socket Mode app started");
  return app;
}
