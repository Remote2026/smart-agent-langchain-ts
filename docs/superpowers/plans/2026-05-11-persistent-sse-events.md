# Persistent SSE Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a long-lived Web SSE connection so `npm run test:device-event` can push Agent events to the already-open Web UI.

**Architecture:** Keep the existing `/api/chat` request-scoped SSE behavior for chat. Add `GET /api/events` as a page-level SSE stream that registers the browser response in the existing global `sseClients` set. Keep the fixed `DEFAULT_SESSION_ID` and current broadcast logic in `/api/device-event`.

**Tech Stack:** Express 5, browser `EventSource`, existing `ChatEventOut` SSE event shape, `tsx` verification scripts.

---

### File Structure

- Modify: `src/index.ts`
  - Add `GET /api/events`.
  - Reuse the existing `sseClients` set.
  - Send an initial `status: done` event so clients can confirm the stream is connected.
- Modify: `public/app.js`
  - Open `new EventSource("/api/events")` during page initialization.
  - Route server events into existing `handleServerEvent`.
  - Show a readable error if the long-lived stream fails.
- Create: `scripts/test-events-sse.ts`
  - Connect to `/api/events`.
  - POST `/api/device-event`.
  - Assert the SSE stream receives `device_event_received` for `web-default-session`.

### Task 1: Add Server-Side Persistent SSE

- [ ] **Step 1: Add a failing integration script**

Create `scripts/test-events-sse.ts`:

```ts
const baseUrl = process.env.SMART_AGENT_BASE_URL ?? "http://localhost:3000";

type SseMessage = {
  event: string;
  data: any;
};

function parseSseChunk(chunk: string): SseMessage | null {
  const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
  const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return null;

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

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
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

  throw new Error("Timed out waiting for device_event_received SSE event.");
}

async function main() {
  const eventsResponse = await fetch(`${baseUrl}/api/events`);
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

  console.log("[test-events-sse] ok");
}

main().catch((error) => {
  console.error("[test-events-sse] failed:", error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run the script against the current server and verify it fails**

Run:

```bash
npx tsx scripts/test-events-sse.ts
```

Expected before implementation:

```txt
GET /api/events failed: HTTP 404
```

- [ ] **Step 3: Add `GET /api/events`**

In `src/index.ts`, add this route after `/api/health`:

```ts
app.get("/api/events", (request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  sseClients.add(response);

  response.write(`event: status\n`);
  response.write(`data: ${JSON.stringify({
    sessionId: DEFAULT_SESSION_ID,
    channel: "web",
    type: "status",
    payload: { status: "done" }
  } satisfies ChatEventOut)}\n\n`);

  request.on("close", () => {
    sseClients.delete(response);
  });
});
```

- [ ] **Step 4: Re-run the script**

Run:

```bash
npx tsx scripts/test-events-sse.ts
```

Expected after implementation:

```txt
[test-events-sse] ok
```

### Task 2: Connect the Browser on Page Load

- [ ] **Step 1: Add browser EventSource wiring**

In `public/app.js`, add this after `localStorage.setItem("smart-agent-session", sessionId);`:

```js
const events = new EventSource("/api/events");

for (const type of ["status", "node", "tool", "final", "error"]) {
  events.addEventListener(type, (message) => {
    if (!message.data) {
      return;
    }

    handleServerEvent(JSON.parse(message.data));
  });
}

events.onerror = () => {
  statusEl.textContent = "event stream disconnected";
  statusEl.classList.remove("busy");
};
```

- [ ] **Step 2: Verify manually in browser**

Run:

```bash
npm run dev
npm run test:device-event
```

Expected:

- Web page stays open without sending a chat message.
- `npm run test:device-event` returns `{ ok: true }`.
- Web page receives `device_event_received`, graph events, and final message.

### Task 3: Final Verification

- [ ] **Step 1: Typecheck**

Run:

```bash
npm run typecheck
```

Expected:

```txt
tsc -p tsconfig.json --noEmit
```

Exit code `0`.

- [ ] **Step 2: Regression scripts**

Run:

```bash
npx tsx scripts/test-fixed-session-id.ts
npx tsx scripts/test-events-sse.ts
```

Expected:

```txt
[test-fixed-session-id] ok
[test-events-sse] ok
```
