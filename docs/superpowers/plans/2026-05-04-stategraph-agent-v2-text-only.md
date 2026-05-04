# StateGraph Agent V2 (Text-Only, Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify V2 to a text-only LangGraph `StateGraph` using a single `router_intent` and a unified `respond`, while keeping SSE streaming of per-node progress (`node` events) and tool events.

**Architecture:** Keep `POST /api/chat` + SSE (`text/event-stream`). Accept only text input (`{ message: { kind:"text", text } }`, plus backward-compatible `{ text }`). Run a minimal StateGraph: `ingest -> router_intent -> (smartthings|ros2|default) -> respond -> finalize`.

**Tech Stack:** Node.js (Express), TypeScript, `@langchain/langgraph@^0.4.9`, `@langchain/openai`, vanilla web UI (`public/*`).

---

## File/Module Map (locked decisions)

**Backend**
- Modify: `src/agent/v2/state.ts` — make request schema text-only; remove image fields.
- Modify: `src/index.ts` — enforce text-only request parsing and lower JSON body limit (optional but recommended).
- Modify: `src/agent/v2/graph.ts` — remove modality/image nodes and edges; implement Plan A graph.
- Modify: `src/agent/agent.ts` — remove image-specific session message handling; keep graphEvents delta streaming.

**Frontend**
- Modify: `public/index.html` — remove image attachments UI (file + prompt).
- Modify: `public/app.js` — send only text requests; remove base64 logic; update `GRAPH_NODES`.
- (Optional) Modify: `public/styles.css` — remove now-unused attachment styles if present.

---

### Task 1: Make request + state text-only

**Files:**
- Modify: `src/agent/v2/state.ts`

- [ ] **Step 1: Replace `InputMessageSchema` with text-only**

In `src/agent/v2/state.ts`, replace the current discriminated union with:

```ts
import { z } from "zod";

export const InputMessageSchema = z.object({
  kind: z.literal("text"),
  text: z.string().min(1)
});

export type InputMessage = z.infer<typeof InputMessageSchema>;
```

- [ ] **Step 2: Keep `ChatRequestSchema` V1 compatibility, but text-only V2**

In `src/agent/v2/state.ts`, keep:

```ts
export const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  message: InputMessageSchema.optional(),
  // backward compatible (V1):
  text: z.string().optional()
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
```

- [ ] **Step 3: Remove `imageContext` from `V2State`**

In `src/agent/v2/state.ts`, update `V2State` to:

```ts
import type { BaseMessage } from "@langchain/core/messages";
import type { GraphEvent } from "../../types.js";

export type V2State = {
  sessionId: string;
  input: InputMessage;
  messages: BaseMessage[];

  // Normalized user text for routing + respond.
  userText?: string;

  intent?: "smartthings" | "ros2" | "default";
  intentRationale?: string;
  intentConfidence?: "low" | "medium" | "high";

  toolResults?: unknown;
  finalText?: string;

  graphEvents: GraphEvent[];
};
```

- [ ] **Step 4: Typecheck to ensure no image references remain**

Run: `npm run typecheck`
Expected: exit code 0 (fix any compile errors by updating imports/usages in later tasks).

---

### Task 2: Enforce text-only at the HTTP boundary

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Lower JSON body limit back to 1mb**

In `src/index.ts`, change:

```ts
app.use(express.json({ limit: "5mb" }));
```

to:

```ts
app.use(express.json({ limit: "1mb" }));
```

- [ ] **Step 2: Reject V2 `message.kind !== "text"` explicitly**

In `src/index.ts`, after `message` is derived, add:

```ts
if (message.kind !== "text") {
  emit({
    sessionId,
    channel: "web",
    type: "error",
    payload: { message: "Only text messages are supported for now." }
  });
  response.end();
  return;
}
```

- [ ] **Step 3: Manual curl sanity check (V1 + V2)**

Run:

```powershell
curl -Method Post http://localhost:3000/api/chat -Headers @{"Content-Type"="application/json"} -Body '{"text":"hello"}'
```

Expected:
- SSE stream includes `event: status` then `event: final` then `event: status` done.

Run:

```powershell
curl -Method Post http://localhost:3000/api/chat -Headers @{"Content-Type"="application/json"} -Body '{"message":{"kind":"text","text":"hello"}}'
```

Expected: same as above.

---

### Task 3: Simplify the StateGraph to Plan A (single router_intent)

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Update GraphState default to text-only**

In `src/agent/v2/graph.ts`, ensure default state matches the new schema:

```ts
default: () =>
  ({
    sessionId: "",
    input: { kind: "text", text: "" },
    messages: [],
    graphEvents: []
  }) as V2State
```

- [ ] **Step 2: Remove nodes: `route_modality`, `image_analysis`, `text_prepare`**

In `src/agent/v2/graph.ts`:
- Delete the node functions `routeModalityNode`, `imageAnalysisNode`, `textPrepareNode`.
- Remove `.addNode("route_modality" ...)`, `.addNode("image_analysis" ...)`, `.addNode("text_prepare" ...)`.

- [ ] **Step 3: Make `ingest` set `userText` (and validate non-empty)**

In `ingestNode`, after validating `text.trim()`, set:

```ts
next.userText = next.input.text.trim();
```

And update the `summary` to only mention text (e.g. `len=${next.userText.length}`).

- [ ] **Step 4: Update edges to the simplified flow**

Replace the old modality edges with:

```ts
graph.addEdge(START, "ingest");
graph.addEdge("ingest", "router_intent");

graph.addConditionalEdges("router_intent", (s: GraphStateType) => {
  switch (s.state.intent) {
    case "smartthings":
      return "smartthings_node";
    case "ros2":
      return "ros2_node";
    default:
      return "default_node";
  }
});

graph.addEdge("smartthings_node", "respond");
graph.addEdge("ros2_node", "respond");
graph.addEdge("default_node", "respond");
graph.addEdge("respond", "finalize");
graph.addEdge("finalize", END);
```

Notes:
- Keep the node name `router_intent` (matches the spec and current implementation).
- Keep `respond` unified.

- [ ] **Step 5: Ensure `router_intent` runs even when ingest errors**

Decide one (and implement explicitly):

Option A (recommended): If ingest detects empty text, set `finalText=""` and skip the rest by forcing `intent="default"` + respond clarifies.

Implement in `ingestNode` (instead of returning early with only an error event):

```ts
if (!next.input.text.trim()) {
  appendEvent(next, { node: "ingest", phase: "error", summary: "empty text" });
  next.userText = "";
  next.intent = "default";
  next.intentConfidence = "low";
  next.intentRationale = "empty text";
  appendEvent(next, { node: "ingest", phase: "end", summary: "fallback to default" });
  return { state: next };
}
```

This keeps the graph converging to `respond` and returning a friendly message.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0

---

### Task 4: Remove image handling from SmartAgent session persistence

**Files:**
- Modify: `src/agent/agent.ts`

- [ ] **Step 1: Delete the `if (input.message.kind === "text") ... else ...` branch**

Replace:

```ts
if (input.message.kind === "text") {
  sessionState.messages.push(new HumanMessage(input.message.text));
} else {
  sessionState.messages.push(new HumanMessage("[image]"));
}
```

with:

```ts
sessionState.messages.push(new HumanMessage(input.message.text));
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0

---

### Task 5: Simplify the Web UI to text-only

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`

- [ ] **Step 1: Remove the Attachments section from the HTML**

In `public/index.html`, delete:
- `<section class="attachments" ...>`
- The `#imageInput` file input
- The `#imagePrompt` input

- [ ] **Step 2: Remove image DOM references + base64 helper**

In `public/app.js`, delete:

```js
const imageInputEl = document.querySelector("#imageInput");
const imagePromptEl = document.querySelector("#imagePrompt");
```

And delete `fileToBase64(...)`.

- [ ] **Step 3: Make the submit handler send text-only body**

In `public/app.js`, replace the conditional body build with:

```js
const body = {
  sessionId,
  message: { kind: "text", text }
};
```

Also simplify the “empty input” check to:

```js
if (!text) return;
```

- [ ] **Step 4: Update Graph Steps node ordering**

In `public/app.js`, replace `GRAPH_NODES` with:

```js
const GRAPH_NODES = [
  "ingest",
  "router_intent",
  "smartthings_node",
  "ros2_node",
  "default_node",
  "respond",
  "finalize"
];
```

- [ ] **Step 5: Manual UI check**

Run: `npm run dev`

In the browser:
- Send “你好”
- Confirm you see `node` events for `ingest` → `router_intent` → `default_node` → `respond` → `finalize`
- Confirm final response is rendered and status ends at `done`

---

## Plan self-review (run now, before execution)

1) **Spec coverage:** This plan implements the updated spec `docs/superpowers/specs/2026-05-03-stategraph-agent-v2-design.md` (Plan A text-only): single router_intent, unified respond, keep ingest/finalize and SSE node events.
2) **Placeholder scan:** No “TBD/TODO/implement later”; every step includes exact edits and commands.
3) **Type consistency:** Node names are consistent (`router_intent`, `smartthings_node`, `ros2_node`, `default_node`, `respond`, `finalize`).

---

Plan complete and saved to `docs/superpowers/plans/2026-05-04-stategraph-agent-v2-text-only.md`. Two execution options:

1. Subagent-Driven (recommended) — I dispatch a fresh subagent per task, review between tasks
2. Inline Execution — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

