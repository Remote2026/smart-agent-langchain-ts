import { DynamicStructuredTool } from "@langchain/core/tools";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tools/scripts.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "scripts");

function runScript(name: string): string {
  const scriptPath = path.join(SCRIPTS_DIR, name);
  log.info("runScript", `Executing ${scriptPath}`);

  try {
    const output = execSync(`bash "${scriptPath}"`, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return output.trim();
  } catch (error: any) {
    const stderr = error.stderr?.toString() || "";
    const stdout = error.stdout?.toString() || "";
    const message = stderr || stdout || error.message;
    log.error("runScript", `${name} failed:`, message);
    throw new Error(`Script ${name} failed: ${message}`);
  }
}

export function createScriptTools() {
  return [
    new DynamicStructuredTool({
      name: "robot_water_on",
      description: `Turn on the robot water device using SmartThings CLI.
Call this tool FIRST when the user asks to "start patrol", "begin patrol", "patrol", or similar commands.
This is step 1 of the patrol sequence.`,
      schema: z.object({}),
      func: async () => {
        return runScript("start-water.sh");
      }
    }),

    new DynamicStructuredTool({
      name: "robot_clean_start",
      description: `Start the robot cleaning using SmartThings CLI.
Call this tool SECOND, only AFTER robot_water_on has completed successfully, when the user asks to "start patrol" or similar commands.
This is step 2 of the patrol sequence.`,
      schema: z.object({}),
      func: async () => {
        return runScript("start-clean.sh");
      }
    })
  ];
}
