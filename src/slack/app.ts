import { App, type AppOptions } from "@slack/bolt";
import type { ChatEventOut } from "../types.js";
import type { SmartAgent } from "../agent/agent.js";
import { createSlackTransport } from "./transport.js";

export async function startSlackApp(options: {
  agent: SmartAgent;
  broadcastSse: (event: ChatEventOut) => void;
}): Promise<App> {
  const { agent, broadcastSse } = options;

  console.log("[slack] Initializing App with Socket Mode...");
  const app = new App({
    socketMode: true,
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    logger: {
      debug: (msg: string) => console.log("[slack:debug]", msg),
      info: (msg: string) => console.log("[slack:info]", msg),
      warn: (msg: string) => console.warn("[slack:warn]", msg),
      error: (msg: string) => console.error("[slack:error]", msg),
      setLevel: () => {},
      getLevel: () => "debug" as any,
      setName: () => {},
    }
  } as AppOptions);
  console.log("[slack] App created, calling app.start()...");

  const transport = createSlackTransport({
    agent,
    broadcastSse,
    slackClient: app.client
  });

  app.event("app_mention" as any, async ({ event }: any) => {
    console.log("[slack] app_mention received:", { text: event.text?.slice(0, 80), channel: event.channel, ts: event.ts });
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
    console.log("[slack] message event received:", { channel_type: event.channel_type, subtype: (event as any).subtype, text: event.text?.slice(0, 80), channel: event.channel, ts: event.ts });

    if ((event as any).subtype) {
      console.log("[slack] message skipped: subtype=", (event as any).subtype);
      return;
    }

    if (event.channel_type !== "im") {
      console.log("[slack] message skipped: channel_type=", event.channel_type, "(not DM)");
      return;
    }

    await transport.handleDirectMessage({
      text: (event as any).text ?? "",
      channel: event.channel,
      ts: event.ts,
      thread_ts: (event as any).thread_ts,
      bot_id: (event as any).bot_id,
      subtype: (event as any).subtype
    });
  });

  app.error(async (error) => {
    console.error("[slack] Bolt App error:", error);
  });

  await app.start();
  console.log("[slack] Socket Mode app started");
  return app;
}
