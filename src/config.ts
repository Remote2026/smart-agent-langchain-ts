import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  OPENAI_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("qwen-turbo"),
ROSBRIDGE_URL: z.string().url().default("ws://localhost:9090"),
  PORT: z.coerce.number().int().positive().default(3000),
  SLACK_ENABLED: z.coerce.boolean().default(false),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_MIRROR_WEB_MESSAGES: z.coerce.boolean().default(false),
  SLACK_DEFAULT_CHANNEL_ID: z.string().optional()
});

export function loadAppConfig() {
  const env = envSchema.parse(process.env);
  return { env };
}
