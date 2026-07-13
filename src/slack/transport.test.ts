import { describe, it, expect, vi } from "vitest";
import { createSlackTransport } from "./transport.js";
import type { ChatEventOut } from "../types.js";

function makeAgent() {
  return {
    handleUserMessage: vi.fn().mockResolvedValue(undefined)
  } as any;
}

function makeSlackClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "123.456" }),
      update: vi.fn().mockResolvedValue({ ok: true })
    }
  } as any;
}

function makeBroadcastSse() {
  return vi.fn();
}

function makeTransport() {
  const agent = makeAgent();
  const slackClient = makeSlackClient();
  const broadcastSse = makeBroadcastSse();
  const transport = createSlackTransport({ agent, broadcastSse, slackClient });
  return { transport, agent, slackClient, broadcastSse };
}

describe("createSlackTransport", () => {
  describe("handleAppMention", () => {
    it("skips events from bot itself", async () => {
      const { transport } = makeTransport();
      await transport.handleAppMention({ text: "hello", channel: "C1", ts: "1", bot_id: "B1" });
      // No error, just returns — verified by no agent call below
    });

    it("skips events with subtype", async () => {
      const { transport } = makeTransport();
      await transport.handleAppMention({ text: "hello", channel: "C1", ts: "1", subtype: "message_changed" });
    });

    it("skips empty text after removing mention tags", async () => {
      const { transport, agent } = makeTransport();
      await transport.handleAppMention({ text: "<@U123>  ", channel: "C1", ts: "1" });
      expect(agent.handleUserMessage).not.toHaveBeenCalled();
    });

    it("strips <@U123> mention tokens from text", async () => {
      const { transport, agent } = makeTransport();
      await transport.handleAppMention({ text: "<@U123> 打开灯", channel: "C1", ts: "1" });
      expect(agent.handleUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "web-default-session",
          message: { kind: "text", text: "打开灯" },
          channel: "slack"
        })
      );
    });
  });

  describe("handleDirectMessage", () => {
    it("skips bot messages", async () => {
      const { transport } = makeTransport();
      await transport.handleDirectMessage({ text: "hi", channel: "D1", ts: "1", bot_id: "B1" });
    });

    it("skips subtype events", async () => {
      const { transport } = makeTransport();
      await transport.handleDirectMessage({ text: "hi", channel: "D1", ts: "1", subtype: "message_deleted" });
    });

    it("skips empty text", async () => {
      const { transport, agent } = makeTransport();
      await transport.handleDirectMessage({ text: "   ", channel: "D1", ts: "1" });
      expect(agent.handleUserMessage).not.toHaveBeenCalled();
    });

    it("calls agent with correct text and session", async () => {
      const { transport, agent } = makeTransport();
      await transport.handleDirectMessage({ text: "hello agent", channel: "D1", ts: "1" });
      expect(agent.handleUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "web-default-session",
          message: { kind: "text", text: "hello agent" },
          channel: "slack"
        })
      );
    });
  });

  describe("emit dispatch", () => {
    it("broadcasts all event types to SSE", async () => {
      const { transport, agent, broadcastSse } = makeTransport();

      // Capture the emit function passed to handleUserMessage
      (agent.handleUserMessage as any).mockImplementation(async (input: any) => {
        input.emit({ sessionId: "s1", channel: "slack", type: "status", payload: { status: "thinking" } } as ChatEventOut);
        input.emit({ sessionId: "s1", channel: "slack", type: "node", payload: { node: "ingest", phase: "start", summary: "ok" } } as ChatEventOut);
        input.emit({ sessionId: "s1", channel: "slack", type: "tool", payload: { name: "test", status: "ok" } } as ChatEventOut);
      });

      await transport.handleDirectMessage({ text: "test", channel: "D1", ts: "1" });

      expect(broadcastSse).toHaveBeenCalledTimes(3);
      expect(broadcastSse).toHaveBeenCalledWith(expect.objectContaining({ channel: "slack", type: "status" }));
      expect(broadcastSse).toHaveBeenCalledWith(expect.objectContaining({ channel: "slack", type: "node" }));
      expect(broadcastSse).toHaveBeenCalledWith(expect.objectContaining({ channel: "slack", type: "tool" }));
    });

    it("sends final events to Slack via chat.update for DM", async () => {
      const { transport, agent, slackClient } = makeTransport();

      (agent.handleUserMessage as any).mockImplementation(async (input: any) => {
        input.emit({ sessionId: "s1", channel: "slack", type: "final", payload: { text: "done!" } } as ChatEventOut);
      });

      await transport.handleDirectMessage({ text: "test", channel: "D2", ts: "2" });

      expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D2",
          text: "⏳ Thinking...",
        })
      );
      expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ thread_ts: expect.anything() })
      );
      expect(slackClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D2",
          ts: "123.456",
          text: "done!",
        })
      );
    });

    it("sends error events to Slack via chat.update for DM", async () => {
      const { transport, agent, slackClient } = makeTransport();

      (agent.handleUserMessage as any).mockImplementation(async (input: any) => {
        input.emit({ sessionId: "s1", channel: "slack", type: "error", payload: { message: "boom" } } as ChatEventOut);
      });

      await transport.handleDirectMessage({ text: "test", channel: "D3", ts: "3" });

      expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D3",
          text: "⏳ Thinking...",
        })
      );
      expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ thread_ts: expect.anything() })
      );
      expect(slackClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D3",
          ts: "123.456",
          text: "Failed: boom",
        })
      );
    });

    it("does NOT send status/node events to Slack via chat.update", async () => {
      const { transport, agent, slackClient } = makeTransport();

      (agent.handleUserMessage as any).mockImplementation(async (input: any) => {
        input.emit({ sessionId: "s1", channel: "slack", type: "status", payload: { status: "thinking" } } as ChatEventOut);
        input.emit({ sessionId: "s1", channel: "slack", type: "node", payload: { node: "ingest", phase: "start", summary: "ok" } } as ChatEventOut);
      });

      await transport.handleDirectMessage({ text: "test", channel: "D4", ts: "4" });

      expect(slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(slackClient.chat.update).not.toHaveBeenCalled();
    });

    it("uses thread_ts for app_mention events", async () => {
      const { transport, agent, slackClient } = makeTransport();

      (agent.handleUserMessage as any).mockImplementation(async (input: any) => {
        input.emit({ sessionId: "s1", channel: "slack", type: "final", payload: { text: "ok" } } as ChatEventOut);
      });

      await transport.handleAppMention({ text: "test", channel: "C5", ts: "ts.999" });

      expect(slackClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: "ts.999" })
      );
    });
  });
});
