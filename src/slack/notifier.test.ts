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

  it("streamToken posts a Thinking... message on first call", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    await notifier.streamToken("tok", "thread.3");

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: channelId,
      text: "⏳ Thinking...",
      thread_ts: "thread.3"
    });
  });

  it("streamToken does not post duplicate Thinking... messages", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    await notifier.streamToken("a", "thread.4");
    await notifier.streamToken("b", "thread.4");

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("streamToolStatus posts tool statuses as separate messages", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    notifier.streamToolStatus({ name: "smartthings_list_devices", status: "executing" }, "thread.5");
    notifier.streamToolStatus({ name: "smartthings_list_devices", status: "ok" }, "thread.5");

    await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledTimes(3));
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ channel: channelId, text: "⏳ Thinking...", thread_ts: "thread.5" })
    );
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ channel: channelId, text: "🔧 Calling tool: smartthings_list_devices...", thread_ts: "thread.5" })
    );
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(3,
      expect.objectContaining({ channel: channelId, text: "✅ Tool smartthings_list_devices completed", thread_ts: "thread.5" })
    );
  });

  it("streamFinal posts final as a new message", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    await notifier.streamFinal("done!", "thread.6");

    await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledTimes(2));
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ channel: channelId, text: "⏳ Thinking...", thread_ts: "thread.6" })
    );
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ channel: channelId, text: "Agent: done!", thread_ts: "thread.6" })
    );
  });

  it("streamError posts error as a new message", async () => {
    const client = makeClient();
    const notifier = createSlackNotifier(client, channelId);

    await notifier.streamError("boom", "thread.7");

    await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledTimes(2));
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ channel: channelId, text: "⏳ Thinking...", thread_ts: "thread.7" })
    );
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ channel: channelId, text: "Failed: boom", thread_ts: "thread.7" })
    );
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
