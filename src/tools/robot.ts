import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { FoxgloveClient } from "../foxglove/client.js";

const CMD_VEL_TOPIC = "/turtle1/cmd_vel";
const PUB_HZ = 10;

export function createRobotTools(foxglove?: FoxgloveClient) {
  if (!foxglove) {
    return [];
  }
  const client = foxglove;

  let cmdVelChannelPromise: Promise<number> | undefined;
  let stopTimer: NodeJS.Timeout | null = null;

  async function getChannel(): Promise<number> {
    if (!cmdVelChannelPromise) {
      cmdVelChannelPromise = client.advertiseTopic(CMD_VEL_TOPIC);
    }
    return cmdVelChannelPromise;
  }

  function scheduleStop(delayMs: number) {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      client.stopPublishing();
      client.setTwist(0, 0, 0, 0, 0, 0);
      getChannel().then((cid) =>
        client.publishJson(cid, { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } })
      );
    }, delayMs);
  }

  function cancelStop() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  async function startMotion(lx: number, ly: number, lz: number, ax: number, ay: number, az: number) {
    cancelStop();
    const cid = await getChannel();
    client.setTwist(lx, ly, lz, ax, ay, az);
    client.startPublishing(cid, { linear: { x: lx, y: ly, z: lz }, angular: { x: ax, y: ay, z: az } }, PUB_HZ);
  }

  async function doStop() {
    cancelStop();
    client.stopPublishing();
    client.setTwist(0, 0, 0, 0, 0, 0);
    const cid = await getChannel();
    client.publishJson(cid, { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } });
  }

  return [
    new DynamicStructuredTool({
      name: "robot_status",
      description: "Check if the robot controller is connected and ready.",
      schema: z.object({}),
      func: async () => {
        return `Robot connected: ${client.connected}`;
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
        await startMotion(linearX, linearY, linearZ, angularX, angularY, angularZ);
        if (duration > 0) scheduleStop(duration * 1000);
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
        await startMotion(speed, 0, 0, 0, 0, 0);
        scheduleStop(duration * 1000);
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
        await startMotion(-speed, 0, 0, 0, 0, 0);
        scheduleStop(duration * 1000);
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
        const az = direction === "left" ? speed : -speed;
        await startMotion(0, 0, 0, 0, 0, az);
        scheduleStop(duration * 1000);
        return `Turning ${direction} at ${speed} rad/s for ${duration} seconds.`;
      },
    }),

    new DynamicStructuredTool({
      name: "robot_stop",
      description: "Stop the robot immediately. Call this if the user says stop, emergency, or halt.",
      schema: z.object({}),
      func: async () => {
        await doStop();
        return "Robot stopped immediately.";
      },
    }),
  ];
}
