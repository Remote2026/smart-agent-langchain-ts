import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SmartAgent } from "./agent/agent.js";
import { loadAppConfig } from "./config.js";
import { SkillManager } from "./skill-runtime/skill-manager.js";
import { createTools } from "./tools/index.js";
import { RosbridgeClient } from "./tools/ros2.js";
import { SmartThingsClient } from "./tools/smartthings.js";
import type { ChatEventOut } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appConfig = loadAppConfig();
const skillManager = new SkillManager({
  skillsDir: appConfig.env.SKILLS_DIR,
  workspaceDir: process.cwd(),
  shellEnabled: appConfig.env.ENABLE_SKILL_SHELL
});
const tools = createTools({
  smartThings: new SmartThingsClient(appConfig.env.SMARTTHINGS_PAT),
  rosbridge: new RosbridgeClient(appConfig.env.ROSBRIDGE_URL),
  aliases: appConfig.aliases,
  skills: skillManager
});

const agent = new SmartAgent({
  baseURL: appConfig.env.OPENAI_BASE_URL,
  apiKey: appConfig.env.OPENAI_API_KEY,
  model: appConfig.env.OPENAI_MODEL,
  tools,
  skillInstructions: skillManager.describeForPrompt()
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(__dirname, "..", "public")));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/chat", async (request, response) => {
  const sessionId = typeof request.body?.sessionId === "string" ? request.body.sessionId : crypto.randomUUID();
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const emit = (event: ChatEventOut) => {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (!text) {
    emit({
      sessionId,
      channel: "web",
      type: "error",
      payload: { message: "Message text is required." }
    });
    response.end();
    return;
  }

  try {
    await agent.handleUserMessage({ sessionId, text, emit });
  } catch (error) {
    emit({
      sessionId,
      channel: "web",
      type: "error",
      payload: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
  } finally {
    response.end();
  }
});

app.listen(appConfig.env.PORT, () => {
  console.log(`Smart Agent web chat is running at http://localhost:${appConfig.env.PORT}`);
  console.log(`Loaded ${skillManager.listSkills().length} local skill(s) from ${appConfig.env.SKILLS_DIR}`);
});
