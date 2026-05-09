import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  OPENAI_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("qwen-turbo"),
ROSBRIDGE_URL: z.string().url().default("ws://localhost:9090"),
  PORT: z.coerce.number().int().positive().default(3000)
});

export function loadAppConfig() {
  const env = envSchema.parse(process.env);
  return { env };
}
