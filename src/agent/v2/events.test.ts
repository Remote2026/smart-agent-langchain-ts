import { describe, it, expect } from "vitest";
import { graphEventToSse, nodeEvent, toolEvent } from "./events.js";
import type { GraphEvent } from "../../types.js";

describe("graphEventToSse", () => {
  const sessionId = "test-session";

  it("defaults channel to 'web'", () => {
    const ev: GraphEvent = nodeEvent({ node: "ingest", phase: "start", summary: "ok" });
    const result = graphEventToSse(sessionId, ev);
    expect(result.channel).toBe("web");
  });

  it("uses channel='slack' when passed", () => {
    const ev: GraphEvent = nodeEvent({ node: "ingest", phase: "start", summary: "ok" });
    const result = graphEventToSse(sessionId, ev, "slack");
    expect(result.channel).toBe("slack");
  });

  describe("node events", () => {
    it("maps GraphEvent type=node to ChatEventOut type=node", () => {
      const ev: GraphEvent = nodeEvent({ node: "configure_agent", phase: "end", summary: "context ready" });
      const result = graphEventToSse(sessionId, ev, "slack");

      expect(result.type).toBe("node");
      expect(result.channel).toBe("slack");
      expect((result as any).payload.node).toBe("configure_agent");
      expect((result as any).payload.phase).toBe("end");
      expect((result as any).payload.summary).toBe("context ready");
    });
  });

  describe("tool events — start phase", () => {
    it("maps to status=executing", () => {
      const ev: GraphEvent = toolEvent({ name: "smartthings_list_devices", phase: "start", summary: "calling", data: { deviceId: "abc" } });
      const result = graphEventToSse(sessionId, ev);

      expect(result.type).toBe("tool");
      expect((result as any).payload.status).toBe("executing");
      expect((result as any).payload.input).toEqual({ deviceId: "abc" });
    });
  });

  describe("tool events — error phase", () => {
    it("maps to status=error with summary as error message", () => {
      const ev: GraphEvent = toolEvent({ name: "ros2_get_param", phase: "error", summary: "connection refused" });
      const result = graphEventToSse(sessionId, ev);

      expect((result as any).payload.status).toBe("error");
      expect((result as any).payload.error).toBe("connection refused");
    });
  });

  describe("tool events — end phase (default)", () => {
    it("maps to status=ok with output data", () => {
      const ev: GraphEvent = toolEvent({ name: "smartthings_list_devices", phase: "end", summary: "2 devices", data: [{ id: "1" }] });
      const result = graphEventToSse(sessionId, ev);

      expect((result as any).payload.status).toBe("ok");
      expect((result as any).payload.output).toEqual([{ id: "1" }]);
    });
  });
});

describe("nodeEvent", () => {
  it("sets type=node and stamps at", () => {
    const ev = nodeEvent({ node: "respond", phase: "end", summary: "done" });
    if (ev.type !== "node") throw new Error("expected node event");
    expect(ev.node).toBe("respond");
    expect(ev.at).toBeTruthy();
    expect(ev.source).toBe("node");
  });

  it("uses custom source when provided", () => {
    const ev = nodeEvent({ node: "ingest", phase: "start", summary: "start", source: "llm" });
    if (ev.type !== "node") throw new Error("expected node event");
    expect(ev.source).toBe("llm");
  });
});

describe("toolEvent", () => {
  it("sets type=tool and defaults source to tool", () => {
    const ev = toolEvent({ name: "test", phase: "start", summary: "ok" });
    if (ev.type !== "tool") throw new Error("expected tool event");
    expect(ev.name).toBe("test");
    expect(ev.source).toBe("tool");
  });
});
