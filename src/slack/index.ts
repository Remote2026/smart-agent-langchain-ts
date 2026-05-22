import type { App as SlackApp } from "@slack/bolt";
import type { ChatEventOut } from "../types.js";
import type { InputMessage } from "../agent/v2/state.js";
import type { SmartAgent } from "../agent/agent.js";
import { startSlackApp } from "./app.js";
import { createSlackNotifier, type SlackNotifier } from "./notifier.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slack/index.ts");

export { type SlackApp, type SlackNotifier };
export { startSlackApp } from "./app.js";
export { createSlackNotifier } from "./notifier.js";
export { createSlackTransport } from "./transport.js";

/** Mirror Web token/final/error events to Slack default channel (streaming-aware) */
export function maybeMirrorToSlack(
  notifier: SlackNotifier | undefined,
  event: ChatEventOut,
  threadTs?: string
): void {
  if (!notifier) return;
  if (event.channel !== "web") return;
  if (event.type === "token") {
    notifier.streamToken(event.payload.text, threadTs);
  } else if (event.type === "tool") {
    notifier.streamToolStatus(event.payload, threadTs);
  } else if (event.type === "final") {
    notifier.streamFinal(event.payload.text, threadTs);
  } else if (event.type === "error") {
    notifier.streamError(event.payload.message, threadTs);
  }
}

/** Format Web user message text for Slack mirror */
export function webMessageSlackText(msg: InputMessage): string {
  if (msg.kind === "text") return `Web: ${msg.text}`;
  return msg.text ? `Web: [图片] ${msg.text}` : `Web: [图片]`;
}

/** Initialize Slack Socket Mode and optional Web→Slack mirror.
 *  Returns app/notifier handles and a stop function for graceful shutdown. */
export async function startSlackIntegration(options: {
  agent: SmartAgent;
  broadcastSse: (event: ChatEventOut) => void;
  env: {
    SLACK_ENABLED: boolean;
    SLACK_MIRROR_WEB_MESSAGES: boolean;
    SLACK_DEFAULT_CHANNEL_ID?: string;
  };
}): Promise<{ app?: SlackApp; notifier?: SlackNotifier; stop: () => Promise<void> }> {
  let app: SlackApp | undefined;
  let notifier: SlackNotifier | undefined;

  if (options.env.SLACK_ENABLED) {
    app = await startSlackApp({ agent: options.agent, broadcastSse: options.broadcastSse });
    if (options.env.SLACK_MIRROR_WEB_MESSAGES && options.env.SLACK_DEFAULT_CHANNEL_ID) {
      notifier = createSlackNotifier(app.client, options.env.SLACK_DEFAULT_CHANNEL_ID);
      log.info("startSlackIntegration", "Web->Slack mirror enabled");
    }
  }

  const stop = async () => {
    if (app) {
      await app.stop();
      log.info("stop", "Slack app stopped");
    }
  };

  return { app, notifier, stop };
}
