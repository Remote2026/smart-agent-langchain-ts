import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRobotTools } from "./robot.js";

function mockFetch(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  return vi.fn().mockResolvedValue(response);
}

function makeTools() {
  return createRobotTools();
}

describe("createRobotTools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("robot_status", () => {
    const tool = makeTools().find((t) => t.name === "robot_status")!;

    it("returns connected status on success", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, connected: true, ready: true }),
      });

      const result = await tool.invoke({});
      expect(result).toContain("connected: true");
      expect(result).toContain("ready: true");
    });

    it("throws on HTTP error", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "Robot not connected" }),
      });

      await expect(tool.invoke({})).rejects.toThrow("Robot API HTTP 503");
    });
  });

  describe("robot_move", () => {
    const tool = makeTools().find((t) => t.name === "robot_move")!;

    it("sends correct 6DOF parameters", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await tool.invoke({
        linearX: 1.0,
        linearY: 0.5,
        linearZ: 0,
        angularX: 0,
        angularY: 0,
        angularZ: 0.3,
        duration: 2,
      });

      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toContain("/move?");
      expect(url).toContain("lx=1");
      expect(url).toContain("ly=0.5");
      expect(url).toContain("az=0.3");
      expect(url).toContain("time=2");
    });

    it("rejects out-of-range linearX", async () => {
      await expect(
        tool.invoke({ linearX: 3.0 })
      ).rejects.toThrow();
    });

    it("rejects negative duration", async () => {
      await expect(
        tool.invoke({ duration: -1 })
      ).rejects.toThrow();
    });

    it("rejects duration over 10s", async () => {
      await expect(
        tool.invoke({ duration: 15 })
      ).rejects.toThrow();
    });
  });

  describe("robot_forward", () => {
    const tool = makeTools().find((t) => t.name === "robot_forward")!;

    it("sends forward command with defaults", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await tool.invoke({});

      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toContain("/forward?");
      expect(url).toContain("speed=1.5");
      expect(url).toContain("time=1");
    });

    it("uses provided speed and duration", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await tool.invoke({ speed: 2.0, duration: 5 });

      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toContain("speed=2");
      expect(url).toContain("time=5");
    });

    it("rejects speed below minimum", async () => {
      await expect(tool.invoke({ speed: 0.1 })).rejects.toThrow();
    });

    it("rejects speed above maximum", async () => {
      await expect(tool.invoke({ speed: 3.0 })).rejects.toThrow();
    });
  });

  describe("robot_backward", () => {
    const tool = makeTools().find((t) => t.name === "robot_backward")!;

    it("sends backward command", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      const result = await tool.invoke({ speed: 1.0, duration: 2 });
      expect(result).toContain("backward");

      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toContain("/backward?");
    });
  });

  describe("robot_turn", () => {
    const tool = makeTools().find((t) => t.name === "robot_turn")!;

    it("sends left turn command", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await tool.invoke({ direction: "left", speed: 1.0, duration: 2 });

      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toContain("/left?");
      expect(url).toContain("speed=1");
    });

    it("sends right turn command", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await tool.invoke({ direction: "right", speed: 0.8, duration: 1.5 });

      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toContain("/right?");
    });

    it("rejects invalid direction", async () => {
      await expect(
        tool.invoke({ direction: "up" as any })
      ).rejects.toThrow();
    });
  });

  describe("robot_stop", () => {
    const tool = makeTools().find((t) => t.name === "robot_stop")!;

    it("sends stop command", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      const result = await tool.invoke({});
      expect(result).toContain("stopped");

      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toContain("/stop");
    });
  });

  describe("error handling", () => {
    it("throws on API error response with error field", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: "timeout" }),
      });

      const tool = makeTools().find((t) => t.name === "robot_stop")!;
      await expect(tool.invoke({})).rejects.toThrow("Robot API error: timeout");
    });

    it("throws on non-JSON response", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("invalid json");
        },
      });

      const tool = makeTools().find((t) => t.name === "robot_status")!;
      await expect(tool.invoke({})).rejects.toThrow("Robot API HTTP 500");
    });
  });
});
