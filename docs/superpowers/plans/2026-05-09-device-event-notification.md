# Device Event Notification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设备事件通知通道：SmartThings CLI 轮询检测变化 → POST /api/device-event → Agent 图处理 → SSE 广播到 Web UI

**Architecture:** 新增 `inject_device_event` 图节点作为第二入口，与 `ingest` 并列，通过 `eventType` 状态字段在 START 处分流。设备事件直接设 intent=smartthings，跳过 router，之后流程与聊天完全相同。

**Tech Stack:** TypeScript, LangGraph, Express SSE

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/agent/v2/graph.ts` | Modify | 新增 eventType 状态字段 + inject_device_event 节点 + START 条件边 + respond TODOs |
| `src/agent/agent.ts` | Modify | 新增 handleDeviceEvent 方法 |
| `src/agent/v2/state.ts` | Modify | 新增 DeviceEventRequest schema |
| `src/index.ts` | Modify | SSE 全局广播 + POST /api/device-event 路由 |
| `scripts/smartthigns-cli-reference.ts` | Modify | 调用 POST /api/device-event |

---

### Task 1: State model — add eventType to GraphState

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Add eventType annotation**

In `GraphState` (after the `sessionId` line), add:

```typescript
  eventType: Annotation<"chat" | "device_event">({ reducer: (_, n) => n, default: () => "chat" }),
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add eventType field to GraphState"
```

---

### Task 2: inject_device_event node + edge to prepare_agent

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Add inject_device_event node function**

Add after `ingestNode` (around line 92):

```typescript
// ── 节点：inject_device_event ────────────────────────────────────────────
// 设备事件入口：构造事件消息，设置 intent=smartthings（跳过 router），直接进 prepare_agent

async function injectDeviceEventNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "inject_device_event", phase: "start", summary: "device event received" }));

  const userText = state.input.text;
  addEvent(events, nodeEvent({ node: "inject_device_event", phase: "end", summary: "intent=smartthings" }));

  return {
    userText,
    intent: "smartthings",
    finalText: undefined,
    graphEvents: [...state.graphEvents, ...events]
  };
}
```

- [ ] **Step 2: Register node in buildV2Graph**

Add after `.addNode("ingest", ingestNode)`:

```typescript
    .addNode("inject_device_event", injectDeviceEventNode)
```

- [ ] **Step 3: Add edge inject_device_event → prepare_agent**

Add before `graph.addEdge(START, "ingest")`:

```typescript
  graph.addEdge("inject_device_event", "prepare_agent");
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 5: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add inject_device_event node"
```

---

### Task 3: START conditional edge

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Replace START → ingest with conditional edge**

Replace:
```typescript
  graph.addEdge(START, "ingest");
```

With:
```typescript
  // START 根据 eventType 分流：chat → ingest，device_event → inject_device_event
  graph.addConditionalEdges(START, (s: GraphStateType) => {
    return s.eventType === "device_event" ? "inject_device_event" : "ingest";
  }, {
    "inject_device_event": "inject_device_event",
    "ingest": "ingest"
  });
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add START conditional edge for device event routing"
```

---

### Task 4: respond node — Slack and Tool TODO placeholders

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Add TODO placeholders in respondNode**

In `respondNode`, add after `const text = ...` line and before `if (text)`:

```typescript
  // TODO: Slack App 集成 — 将 finalText 推送到 Slack
  // TODO: Tool 自动动作 — 根据设备事件触发预定义 tool（如报警、联动）
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add Slack and Tool action TODO placeholders in respond node"
```

---

### Task 5: DeviceEventRequest schema in state.ts

**Files:**
- Modify: `src/agent/v2/state.ts`

- [ ] **Step 1: Add DeviceEventRequest schema**

Add at the end of the file:

```typescript
export const DeviceEventRequestSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  capability: z.string().min(1),
  previousValue: z.string(),
  currentValue: z.string(),
  timestamp: z.string().min(1)
});
export type DeviceEventRequest = z.infer<typeof DeviceEventRequestSchema>;
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/agent/v2/state.ts
git commit -m "feat: add DeviceEventRequest schema"
```

---

### Task 6: SmartAgent.handleDeviceEvent method

**Files:**
- Modify: `src/agent/agent.ts`

- [ ] **Step 1: Add handleDeviceEvent method**

Add after `handleUserMessage` (before the closing `}` of the class):

```typescript
  async handleDeviceEvent(input: { sessionId: string; message: InputMessage; emit: EmitEvent }): Promise<void> {
    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "status",
      payload: { status: "thinking" }
    });

    let lastSeenGraphEventCount = 0;
    let lastFinalText = "";

    try {
      const initialGraphState = {
        sessionId: input.sessionId,
        input: input.message,
        messages: [new HumanMessage(input.message.text)],
        graphEvents: [],
        eventType: "device_event" as const
      };

      const stream = await this.v2Graph.stream(
        initialGraphState,
        {
          streamMode: "values",
          recursionLimit: 12,
          configurable: { thread_id: input.sessionId }
        }
      );

      for await (const chunk of stream) {
        const v2State = chunk as any;
        if (!v2State || !Array.isArray(v2State.graphEvents)) {
          continue;
        }

        lastFinalText = typeof v2State.finalText === "string" ? v2State.finalText : lastFinalText;

        const newEvents = v2State.graphEvents.slice(lastSeenGraphEventCount) as GraphEvent[];
        lastSeenGraphEventCount = v2State.graphEvents.length;
        for (const ev of newEvents) {
          input.emit(graphEventToSse(input.sessionId, ev));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emit({
        sessionId: input.sessionId,
        channel: "web",
        type: "error",
        payload: { message }
      });
      throw error;
    }

    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "final",
      payload: { text: lastFinalText }
    });
    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "status",
      payload: { status: "done" }
    });
  }
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/agent/agent.ts
git commit -m "feat: add handleDeviceEvent method to SmartAgent"
```

---

### Task 7: POST /api/device-event route + SSE broadcast

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import for DeviceEventRequestSchema**

Add to the import from `./agent/v2/state.js`:

```typescript
import { ChatRequestSchema, DeviceEventRequestSchema } from "./agent/v2/state.js";
```

- [ ] **Step 2: Add SSE clients set**

Add after `const app = express();`:

```typescript
// SSE 客户端集合：用于设备事件广播到所有已连接的 Web UI
const sseClients = new Set<import("node:http").ServerResponse>();
```

- [ ] **Step 3: Register SSE client in /api/chat**

In the `/api/chat` handler, after `response.writeHead(200, {...})` lines and before the `emit` definition, add:

```typescript
    sseClients.add(response);
    request.on("close", () => {
      sseClients.delete(response);
    });
```

- [ ] **Step 4: Add POST /api/device-event route**

Add before `app.listen(...)`:

```typescript
app.post("/api/device-event", async (request, response) => {
  const parsed = DeviceEventRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ ok: false, message: "Invalid device event body." });
    return;
  }

  const ev = parsed.data;
  const sessionId = `device-${crypto.randomUUID()}`;
  const eventText = `设备事件：${ev.deviceName}(${ev.deviceId}) ${ev.capability} 从 ${ev.previousValue} 变为 ${ev.currentValue}`;

  // SSE 广播 emit：写入所有已连接客户端
  const emit = (event: ChatEventOut) => {
    for (const client of sseClients) {
      client.write(`event: ${event.type}\n`);
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    logManager.append(event);
  };

  emit({
    sessionId,
    channel: "web",
    type: "status",
    payload: { status: "device_event_received" }
  });

  try {
    await agent.handleDeviceEvent({
      sessionId,
      message: { kind: "text", text: eventText },
      emit
    });
  } catch (error) {
    emit({
      sessionId,
      channel: "web",
      type: "error",
      payload: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }

  response.json({ ok: true });
});
```

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add POST /api/device-event with SSE broadcast"
```

---

### Task 8: Polling script — call API on device change

**Files:**
- Modify: `scripts/smartthigns-cli-reference.ts`

- [ ] **Step 1: Add fetch type import**

Add at top with other imports:

```typescript
import type { DeviceEventRequest } from "../src/agent/v2/state.js";
```

Note: if the script runs standalone (not with ts-node from project root), use a local type definition instead:

```typescript
interface DeviceEventPayload {
  deviceId: string;
  deviceName: string;
  capability: string;
  previousValue: string;
  currentValue: string;
  timestamp: string;
}
```

- [ ] **Step 2: Replace placeholder with fetch call**

Replace:
```typescript
                    ///发送信息到Openclaw
                    ///占位 - 这里可以添加发送到Openclaw的代码，例如调用API或执行其他操作
```

With:
```typescript
                    // 通知 Agent 设备状态变化
                    const payload: DeviceEventPayload = {
                      deviceId,
                      deviceName: deviceLabel,
                      capability: "contact",
                      previousValue: prevContact ?? "",
                      currentValue: currentContact ?? "",
                      timestamp: new Date().toISOString()
                    };
                    fetch("http://localhost:3000/api/device-event", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(payload)
                    }).catch(() => {
                      console.log("   警告: 无法连接到 Agent API");
                    });
```

- [ ] **Step 3: Commit**

```bash
git add scripts/smartthigns-cli-reference.ts
git commit -m "feat: integrate polling script with POST /api/device-event"
```

---

## Verification

After all tasks, run:

```bash
npx tsc --noEmit
```

Expected: PASS with no errors.
