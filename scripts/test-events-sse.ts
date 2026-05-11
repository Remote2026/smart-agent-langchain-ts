const baseUrl = process.env.SMART_AGENT_BASE_URL ?? "http://localhost:3000";

type SseMessage = {
  event: string;
  data: any;
};

function parseSseChunk(chunk: string): SseMessage | null {
  const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
  const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    return null;
  }

  return {
    event: eventLine ? eventLine.slice("event: ".length) : "message",
    data: JSON.parse(dataLine.slice("data: ".length))
  };
}

async function waitForDeviceEvent(stream: ReadableStream<Uint8Array>): Promise<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 30_000;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const message = parseSseChunk(chunk);
        if (message?.data?.type === "status" && message.data.payload?.status === "device_event_received") {
          return message;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error("Timed out waiting for device_event_received SSE event.");
}

async function main() {
  const controller = new AbortController();

  try {
    const eventsResponse = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    if (!eventsResponse.ok || !eventsResponse.body) {
      throw new Error(`GET /api/events failed: HTTP ${eventsResponse.status}`);
    }

    const received = waitForDeviceEvent(eventsResponse.body);

    const postResponse = await fetch(`${baseUrl}/api/device-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "test-device-001", name: "测试门磁传感器" })
    });

    if (!postResponse.ok) {
      throw new Error(`POST /api/device-event failed: HTTP ${postResponse.status}`);
    }

    const event = await received;
    if (event.data.sessionId !== "web-default-session") {
      throw new Error(`Expected web-default-session, got ${event.data.sessionId}`);
    }
  } finally {
    controller.abort();
  }

  console.log("[test-events-sse] ok");
}

main().catch((error) => {
  console.error("[test-events-sse] failed:", error);
  process.exitCode = 1;
});
