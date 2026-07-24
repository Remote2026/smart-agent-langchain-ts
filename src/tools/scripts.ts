import { DynamicStructuredTool } from "@langchain/core/tools";
import { execFile, type ExecFileOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tools/scripts.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "..", "..", "scripts");

function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
  });
}

async function runScript(name: string, timeoutMs = 30000): Promise<string> {
  const scriptPath = path.join(SCRIPTS_DIR, name);
  log.info("runScript", `Executing ${scriptPath}`);

  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: timeoutMs,
    });
    if (stderr) {
      log.warn("runScript", `${name} stderr:`, stderr);
    }
    return stdout.trim();
  } catch (error: any) {
    const stderr = error.stderr?.toString() || "";
    const stdout = error.stdout?.toString() || "";
    const message = stderr || stdout || error.message;
    log.error("runScript", `${name} failed:`, message);
    throw new Error(`Script ${name} failed: ${message}`);
  }
}

async function runPythonScript(name: string, timeoutMs = 90000): Promise<string> {
  const scriptPath = path.join(SCRIPTS_DIR, name);
  log.info("runPythonScript", `Executing ${scriptPath}`);

  try {
    const { stdout, stderr } = await execFileAsync("python3", [scriptPath], {
      encoding: "utf-8",
      timeout: timeoutMs,
    });
    if (stderr) {
      log.warn("runPythonScript", `${name} stderr:`, stderr);
    }
    return stdout.trim();
  } catch (error: any) {
    const stderr = error.stderr?.toString() || "";
    const stdout = error.stdout?.toString() || "";
    const message = stderr || stdout || error.message;
    log.error("runPythonScript", `${name} failed:`, message);
    throw new Error(`Python script ${name} failed: ${message}`);
  }
}

export function createScriptTools() {
  return [
    new DynamicStructuredTool({
      name: "robot_water_on",
      description: `Turn on the robot water device by running navi_check_water.py.
This script navigates to the plant pose, captures a plant photo from ROS2, analyzes it with a vision model, and turns on the water device.
Call this tool FIRST when the user asks to "start patrol", "begin patrol", "patrol", or similar commands.
This is step 1 of the patrol sequence.`,
      schema: z.object({}),
      func: async () => {
        return runPythonScript("navi_check_water.py");
      }
    }),

    new DynamicStructuredTool({
      name: "robot_clean_start",
      description: `Start the robot cleaning pipeline by running navi_check_clean.py.
This script navigates to the cleaning pose, captures a floor photo from ROS2, analyzes it with a vision model, and starts the vacuum.
Call this tool SECOND, only AFTER robot_water_on has completed successfully, when the user asks to "start patrol" or similar commands.
This is step 2 of the patrol sequence.`,
      schema: z.object({}),
      func: async () => {
        return runPythonScript("navi_check_clean.py");
      }
    })
  ];
}
