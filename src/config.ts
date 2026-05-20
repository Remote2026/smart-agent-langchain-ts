import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

/** Parse boolean from env string. "false", "0", "no", "off", "" → false */
function boolEnv(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val !== "string") return false;
  return !["false", "0", "no", "off", ""].includes(val.toLowerCase());
}

const envSchema = z.object({
  OPENAI_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("qwen-vl-plus"), // 支持视觉的多模态模型
  ROSBRIDGE_URL: z.string().url().default("ws://localhost:9090"),
  FOXGLOVE_URL: z.string().url().default("ws://172.18.0.1:8765"),
  PORT: z.coerce.number().int().positive().default(3000),
  // SmartThings OAuth tokens (ACCESS_TOKEN replaces PAT)
  SMARTTHINGS_CLIENT_ID: z.string().optional(),
  SMARTTHINGS_ACCESS_TOKEN: z.string().optional(),
  SMARTTHINGS_REFRESH_TOKEN: z.string().optional(),
  SMARTTHINGS_CLI_CONFIG_PATH: z.string().default("~/.config/@smartthings/cli/config.yaml"),
  // Slack Socket Mode 集成（默认关闭，不影响现有功能）
  SLACK_ENABLED: z.preprocess(boolEnv, z.boolean()).default(false),
  SLACK_BOT_TOKEN: z.string().optional(),         // Bot User OAuth Token (xoxb-...)
  SLACK_APP_TOKEN: z.string().optional(),         // Socket Mode App Token (xapp-...)
  SLACK_SIGNING_SECRET: z.string().optional(),    // 仅 Socket Mode 验证签名用
  SLACK_MIRROR_WEB_MESSAGES: z.preprocess(boolEnv, z.boolean()).default(false), // Web→Slack 双向同步开关
  SLACK_DEFAULT_CHANNEL_ID: z.string().optional(),  // Mirror 目标频道（启用 mirror 时必填）
  // DeepSeek V4 系列模型思考模式开关（仅在使用 DeepSeek 时设置）：
  // - enabled:  启用 thinking mode（返回 reasoning_content，多轮对话需要传回）
  // - disabled: 关闭 thinking mode（不返回 reasoning_content，从根本上避免 400 错误）
  // 未设置此变量 = 不使用 DeepSeek，不发送 thinking 参数，不影响其他模型。
  DEEPSEEK_THINKING_MODE: z.enum(["enabled", "disabled"]).optional()
});

export function loadAppConfig() {
  const env = envSchema.parse(process.env);
  return { env };
}
