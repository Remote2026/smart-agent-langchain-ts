import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRobotTools } from "./robot.js";
import type { FoxgloveClient } from "../foxglove/client.js";

function makeMockFoxglove(): FoxgloveClient {
  return {
    connected: true,
    advertiseTopic: vi.fn().mockResolvedValue(100),
    startPublishing: vi.fn(),
    stopPublishing: vi.fn(),
    setTwist: vi.fn(),
    publishJson: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as FoxgloveClient;
}

function makeTools(client: FoxgloveClient) {
  return createRobotTools(client);
}

describe("createRobotTools", () => {
  let mockFoxglove: FoxgloveClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFoxglove = makeMockFoxglove();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("robot_status", () => {
    it("returns connected status", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_status")!;
      const result = await tool.invoke({});
      expect(result).toContain("connected: true");
    });
  });

  describe("robot_move", () => {
    it("starts publishing with correct 6DOF parameters", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_move")!;
      await tool.invoke({
        linearX: 1.0, linearY: 0.5, linearZ: 0,
        angularX: 0, angularY: 0, angularZ: 0.3,
        duration: 2,
      });

      expect(mockFoxglove.setTwist).toHaveBeenCalledWith(1.0, 0.5, 0, 0, 0, 0.3);
      expect(mockFoxglove.startPublishing).toHaveBeenCalledWith(
        100,
        { linear: { x: 1.0, y: 0.5, z: 0 }, angular: { x: 0, y: 0, z: 0.3 } },
        10
      );
    });

    it("schedules auto-stop after duration", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_move")!;
      await tool.invoke({ duration: 3 });

      expect(mockFoxglove.stopPublishing).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(mockFoxglove.stopPublishing).toHaveBeenCalled();
    });

    it("rejects out-of-range linearX", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_move")!;
      await expect(tool.invoke({ linearX: 3.0 })).rejects.toThrow();
    });

    it("rejects duration over 10s", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_move")!;
      await expect(tool.invoke({ duration: 15 })).rejects.toThrow();
    });
  });

  describe("robot_forward", () => {
    it("starts forward motion with defaults", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_forward")!;
      await tool.invoke({});

      expect(mockFoxglove.setTwist).toHaveBeenCalledWith(1.5, 0, 0, 0, 0, 0);
      expect(mockFoxglove.startPublishing).toHaveBeenCalled();
    });

    it("uses provided speed and duration", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_forward")!;
      await tool.invoke({ speed: 2.0, duration: 5 });

      expect(mockFoxglove.setTwist).toHaveBeenCalledWith(2.0, 0, 0, 0, 0, 0);
    });

    it("rejects speed below minimum", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_forward")!;
      await expect(tool.invoke({ speed: 0.1 })).rejects.toThrow();
    });
  });

  describe("robot_backward", () => {
    it("starts backward motion", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_backward")!;
      await tool.invoke({ speed: 1.0, duration: 2 });

      expect(mockFoxglove.setTwist).toHaveBeenCalledWith(-1.0, 0, 0, 0, 0, 0);
    });
  });

  describe("robot_turn", () => {
    it("turns left with positive angular Z", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_turn")!;
      await tool.invoke({ direction: "left", speed: 1.0, duration: 2 });

      expect(mockFoxglove.setTwist).toHaveBeenCalledWith(0, 0, 0, 0, 0, 1.0);
    });

    it("turns right with negative angular Z", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_turn")!;
      await tool.invoke({ direction: "right", speed: 0.8, duration: 1.5 });

      expect(mockFoxglove.setTwist).toHaveBeenCalledWith(0, 0, 0, 0, 0, -0.8);
    });

    it("rejects invalid direction", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_turn")!;
      await expect(tool.invoke({ direction: "up" as any })).rejects.toThrow();
    });
  });

  describe("robot_stop", () => {
    it("stops publishing and sends zero twist", async () => {
      const tool = makeTools(mockFoxglove).find((t) => t.name === "robot_stop")!;
      await tool.invoke({});

      expect(mockFoxglove.stopPublishing).toHaveBeenCalled();
      expect(mockFoxglove.setTwist).toHaveBeenCalledWith(0, 0, 0, 0, 0, 0);
      expect(mockFoxglove.publishJson).toHaveBeenCalledWith(100, {
        linear: { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      });
    });
  });

  describe("cancels previous auto-stop", () => {
    it("new command cancels old stop timer", async () => {
      const tools = makeTools(mockFoxglove);
      const forward = tools.find((t) => t.name === "robot_forward")!;
      const stop = tools.find((t) => t.name === "robot_stop")!;

      await forward.invoke({ duration: 5 });
      await stop.invoke({});

      vi.advanceTimersByTime(5000);
      // stopPublishing should only be called once (by stop, not by the cancelled timer)
      expect(mockFoxglove.stopPublishing).toHaveBeenCalledTimes(1);
    });
  });
});
