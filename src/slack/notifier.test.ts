import { describe, it, expect, vi } from "vitest";
import { createSlackNotifier } from "./notifier.js";

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "123.456" })
    }
  } as any;
}

describe("createSlackNotifier", () => {
  const channelId = "C_TEST";

  it("mirrorWebUserMessage sends formatted text and returns ts", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    const ts = await notifier.mirrorWebUserMessage("打开灯");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: channelId,
      text: "Web: 打开灯"
    });
    expect(ts).toBe("123.456");
  });

  it("mirrorWebFinal sends with thread_ts", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    await notifier.mirrorWebFinal("已开灯", "thread.1");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: channelId,
      text: "Agent: 已开灯",
      thread_ts: "thread.1"
    });
  });

  it("mirrorWebFinal sends without thread_ts (new message)", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    await notifier.mirrorWebFinal("已开灯");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: channelId,
      text: "Agent: 已开灯",
      thread_ts: undefined
    });
  });

  it("mirrorWebError sends formatted error", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    await notifier.mirrorWebError("API timeout", "thread.2");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: channelId,
      text: "Failed: API timeout",
      thread_ts: "thread.2"
    });
  });

  it("mirrorWebUserMessage returns undefined on API failure", async () => {
    const client = makeClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("network error"));
    const notifier = createSlackNotifier(client, channelId);

    const ts = await notifier.mirrorWebUserMessage("test");

    expect(ts).toBeUndefined();
  });

  it("mirrorWebFinal does not throw on API failure", async () => {
    const client = makeClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("network error"));
    const notifier = createSlackNotifier(client, channelId);

    await expect(notifier.mirrorWebFinal("test")).resolves.toBeUndefined();
  });

  it("mirrorWebError does not throw on API failure", async () => {
    const client = makeClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("network error"));
    const notifier = createSlackNotifier(client, channelId);

    await expect(notifier.mirrorWebError("test")).resolves.toBeUndefined();
  });
});
