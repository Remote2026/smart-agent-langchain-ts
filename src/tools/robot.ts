import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { loadAppConfig } from "../config.js";

const ROBOT_API_URL = loadAppConfig().env.ROBOT_API_URL;

async function robotRequest(action: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${ROBOT_API_URL}/${action}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Robot API HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.ok && data.error) {
    throw new Error(`Robot API error: ${data.error}`);
  }
  return data;
}

export function createRobotTools() {
  return [
    new DynamicStructuredTool({
      name: "robot_status",
      description: "Check if the robot controller is connected and ready.",
      schema: z.object({}),
      func: async () => {
        const data = await robotRequest("status");
        return `Robot connected: ${data.connected}, ready: ${data.ready}`;
      },
    }),

    new DynamicStructuredTool({
      name: "robot_move",
      description: `Send a raw velocity command to the robot.
- linear X/Y/Z: meters per second (m/s). Forward/backward typical: 1.0 - 2.0.
- angular X/Y/Z: radians per second (rad/s). Typical range: -2.0 to 2.0.
- duration: how long to apply the command before auto-stop. Max 10s for safety.`,
      schema: z.object({
        linearX: z.number().min(-2).max(2).describe("Linear X in m/s (forward positive, backward negative). Typical: 1.0 - 2.0").default(0),
        linearY: z.number().min(-2).max(2).describe("Linear Y in m/s (left positive)").default(0),
        linearZ: z.number().min(-1).max(1).describe("Linear Z in m/s (up positive)").default(0),
        angularX: z.number().min(-3).max(3).describe("Angular X in rad/s (roll)").default(0),
        angularY: z.number().min(-3).max(3).describe("Angular Y in rad/s (pitch)").default(0),
        angularZ: z.number().min(-3).max(3).describe("Angular Z in rad/s (yaw / turn left positive)").default(0),
        duration: z.number().min(0).max(10).describe("Seconds before auto-stop (0 = continuous until stop command)").default(1),
      }),
      func: async (input) => {
        const { linearX, linearY, linearZ, angularX, angularY, angularZ, duration } = z.object({
          linearX: z.number().min(-2).max(2).default(1.5),
          linearY: z.number().min(-2).max(2).default(0),
          linearZ: z.number().min(-1).max(1).default(0),
          angularX: z.number().min(-3).max(3).default(0),
          angularY: z.number().min(-3).max(3).default(0),
          angularZ: z.number().min(-3).max(3).default(0),
          duration: z.number().min(0).max(10).default(1),
        }).parse(input);
        await robotRequest("move", {
          lx: linearX, ly: linearY, lz: linearZ,
          ax: angularX, ay: angularY, az: angularZ,
          time: duration,
        });
        const desc = duration > 0 ? `for ${duration}s` : "continuously (must call stop later)";
        return `Executing: linear=(${linearX},${linearY},${linearZ}) m/s, angular=(${angularX},${angularY},${angularZ}) rad/s ${desc}`;
      },
    }),

    new DynamicStructuredTool({
      name: "robot_forward",
      description: "Move the robot forward at a given speed for a specified duration.",
      schema: z.object({
        speed: z.number().min(0.5).max(2).describe("Speed in meters per second (m/s). Typical: 1.0 - 2.0").default(1.5),
        duration: z.number().min(0.1).max(10).describe("Seconds to move before auto-stop. Max 10s.").default(1),
      }),
      func: async (input) => {
        const { speed, duration } = z.object({
          speed: z.number().min(0.5).max(2).default(1.5),
          duration: z.number().min(0.1).max(10).default(1),
        }).parse(input);
        await robotRequest("forward", { speed, time: duration });
        return `Moving forward at ${speed} m/s for ${duration} seconds.`;
      },
    }),

    new DynamicStructuredTool({
      name: "robot_backward",
      description: "Move the robot backward at a given speed for a specified duration.",
      schema: z.object({
        speed: z.number().min(0.5).max(2).describe("Speed in meters per second (m/s). Typical: 1.0 - 2.0").default(1.5),
        duration: z.number().min(0.1).max(10).describe("Seconds to move before auto-stop. Max 10s.").default(1),
      }),
      func: async (input) => {
        const { speed, duration } = z.object({
          speed: z.number().min(0.5).max(2).default(1.5),
          duration: z.number().min(0.1).max(10).default(1),
        }).parse(input);
        await robotRequest("backward", { speed, time: duration });
        return `Moving backward at ${speed} m/s for ${duration} seconds.`;
      },
    }),

    new DynamicStructuredTool({
      name: "robot_turn",
      description: "Turn the robot in place at a given angular speed for a specified duration.",
      schema: z.object({
        direction: z.enum(["left", "right"]).describe("Turn direction"),
        speed: z.number().min(0).max(3).describe("Angular speed in radians per second (rad/s). Typical: 0.3 - 1.0").default(0.5),
        duration: z.number().min(0.1).max(10).describe("Seconds to turn before auto-stop. Max 10s.").default(1),
      }),
      func: async (input) => {
        const { direction, speed, duration } = z.object({
          direction: z.enum(["left", "right"]),
          speed: z.number().min(0).max(3).default(0.5),
          duration: z.number().min(0.1).max(10).default(1),
        }).parse(input);
        const action = direction === "left" ? "left" : "right";
        await robotRequest(action, { speed, time: duration });
        return `Turning ${direction} at ${speed} rad/s for ${duration} seconds.`;
      },
    }),

    new DynamicStructuredTool({
      name: "robot_stop",
      description: "Stop the robot immediately. Call this if the user says stop, emergency, or halt.",
      schema: z.object({}),
      func: async () => {
        await robotRequest("stop");
        return "Robot stopped immediately.";
      },
    }),
  ];
}
