import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  OPENAI_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("qwen-vl-plus"), // 支持视觉的多模态模型
  ROSBRIDGE_URL: z.string().url().default("ws://localhost:9090"),
  PORT: z.coerce.number().int().positive().default(3000),
  // Slack Socket Mode 集成（默认关闭，不影响现有功能）
  SLACK_ENABLED: z.coerce.boolean().default(false),
  SLACK_BOT_TOKEN: z.string().optional(),         // Bot User OAuth Token (xoxb-...)
  SLACK_APP_TOKEN: z.string().optional(),         // Socket Mode App Token (xapp-...)
  SLACK_SIGNING_SECRET: z.string().optional(),    // 仅 Socket Mode 验证签名用
  SLACK_MIRROR_WEB_MESSAGES: z.coerce.boolean().default(false), // Web→Slack 双向同步开关
  SLACK_DEFAULT_CHANNEL_ID: z.string().optional()  // Mirror 目标频道（启用 mirror 时必填）
});

export function loadAppConfig() {
  const env = envSchema.parse(process.env);
  return { env };
}
