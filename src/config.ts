import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  OPENAI_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("qwen-turbo"),
  SMARTTHINGS_PAT: z.string().min(1).optional(),
  ROSBRIDGE_URL: z.string().url().default("ws://localhost:9090"),
  SKILLS_DIR: z.string().min(1).default("skills"),
  ENABLE_SKILL_SHELL: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  PORT: z.coerce.number().int().positive().default(3000)
});

const aliasSchema = z.object({
  aliases: z.record(
    z.string(),
    z.object({
      deviceId: z.string().min(1),
      room: z.string().optional(),
      type: z.string().optional()
    })
  )
});

export type DeviceAliases = z.infer<typeof aliasSchema>;

export function loadAppConfig() {
  const env = envSchema.parse(process.env);
  const aliasPath = path.resolve(process.cwd(), "config", "device-aliases.json");
  const aliases = fs.existsSync(aliasPath)
    ? aliasSchema.parse(JSON.parse(fs.readFileSync(aliasPath, "utf8")))
    : { aliases: {} };

  return {
    env,
    aliases
  };
}
