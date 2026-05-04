# StateGraph Agent V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current prebuilt `createReactAgent(...)` flow with a custom LangGraph `StateGraph` (multi-node routing + image support) and stream per-node progress to the web UI via SSE `node` events.

**Architecture:** Keep SSE as the transport (`POST /api/chat`), but extend request schema to support `{ message: { kind: "text" | "image", ... } }` (with backward-compatible `{ text }`). Implement a custom `StateGraph` with the nodes/edges from the spec, where nodes append `state.graphEvents[]` and the SSE layer emits deltas (`node/tool/status/final/error`).

**Tech Stack:** Node.js (Express), TypeScript, `@langchain/langgraph@^0.4.9`, `@langchain/openai`, vanilla web UI (`public/*`).

---

## File/Module Map (locked decisions)

**Backend**
- Modify: `src/types.ts` — add V2 request type + add SSE `node` event + (optionally) add `tool` phases.
- Modify: `src/index.ts` — parse new request format, raise JSON limit for image base64, keep SSE framing.
- Modify: `src/agent/agent.ts` — replace prebuilt ReAct agent with a compiled `StateGraph` and implement `graphEvents` delta streaming.
- Create: `src/agent/v2/state.ts` — V2 state types + Zod schemas for parsing/validation.
- Create: `src/agent/v2/events.ts` — helpers to append events consistently (`node:start/end/error`, `tool:start/end/error`) and to compute SSE deltas.
- Create: `src/agent/v2/graph.ts` — builds the `StateGraph`, nodes, and conditional edges (modality + intent).
- Create: `src/agent/v2/nodes/*.ts` — node implementations: `ingest`, `route_modality`, `image_analysis`, `text_prepare`, `route_intent`, `smartthings_node`, `ros2_node`, `default_node`, `respond`, `finalize`.

**Frontend**
- Modify: `public/index.html` — add an image picker + prompt input + a “Graph Steps” panel area.
- Modify: `public/app.js` — send V2 request bodies, handle SSE `node` events, render Graph Steps panel.
- Modify: `public/styles.css` — style Graph Steps (list + current highlight).

---

### Task 1: Define V2 request + event types

**Files:**
- Modify: `src/types.ts`
- Create: `src/agent/v2/state.ts`

- [ ] **Step 1: Add request body types**

Add these types to `src/agent/v2/state.ts` (keep them exported; other modules will import them):

```ts
import { z } from "zod";

export const InputMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("image"),
    mimeType: z.string().min(3),
    base64: z.string().min(1),
    prompt: z.string().min(1).optional(),
    text: z.string().min(1).optional()
  })
]);

export type InputMessage = z.infer<typeof InputMessageSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  message: InputMessageSchema.optional(),
  // backward compatible (V1):
  text: z.string().optional()
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
```

- [ ] **Step 2: Add V2 graph event + node SSE event**

Update `src/types.ts` to include:

```ts
export type GraphEvent =
  | { type: "node"; node: string; phase: "start" | "end" | "error"; summary: string; data?: unknown; at: string }
  | { type: "tool"; name: string; phase: "start" | "end" | "error"; summary: string; data?: unknown; at: string };

// In ChatEventOut union add:
| {
    sessionId: string;
    channel: Channel;
    type: "node";
    payload: { node: string; phase: "start" | "end" | "error"; summary: string; data?: unknown };
  }
```

- [ ] **Step 3: Add V2 state type**

Add to `src/agent/v2/state.ts`:

```ts
import type { BaseMessage } from "@langchain/core/messages";
import type { GraphEvent } from "../../types.js";

export type V2State = {
  sessionId: string;
  input: InputMessage;
  messages: BaseMessage[];
  imageContext?: {
    prompt: string;
    summary?: string;
    extractedText?: string;
    labels?: string[];
    facts?: string[];
    inferences?: string[];
    confidence?: "low" | "medium" | "high";
    raw?: unknown;
  };
  userText?: string;
  intent?: "smartthings" | "ros2" | "default";
  intentRationale?: string;
  toolResults?: unknown;
  finalText?: string;
  graphEvents: GraphEvent[];
};
```

---

### Task 2: Update `/api/chat` request parsing + payload limits

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Raise JSON body size limit for image base64**

Change `express.json({ limit: "1mb" })` to something aligned with the spec risk note (e.g. `5mb`) and keep it configurable later if needed:

```ts
app.use(express.json({ limit: "5mb" }));
```

- [ ] **Step 2: Parse V2 request format, keep V1 compatibility**

Replace the current `text` extraction with:

```ts
import { ChatRequestSchema } from "./agent/v2/state.js";

const parsed = ChatRequestSchema.safeParse(request.body);
if (!parsed.success) { /* emit error + end */ }

const body = parsed.data;
const sessionId = typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();

const message =
  body.message ??
  (typeof body.text === "string" ? { kind: "text" as const, text: body.text } : null);
```

And validate `message` exists; if not, emit `type:"error"` with a clear message.

- [ ] **Step 3: Pass `message` into the agent**

Change `agent.handleUserMessage({ sessionId, text, emit })` to pass the structured message (see Task 4’s `SmartAgent` signature change).

---

### Task 3: Implement graph event helpers + SSE delta streaming

**Files:**
- Create: `src/agent/v2/events.ts`
- Modify: `src/agent/agent.ts`

- [ ] **Step 1: Add event helper functions**

Create `src/agent/v2/events.ts`:

```ts
import type { ChatEventOut, GraphEvent } from "../../types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function nodeEvent(node: string, phase: "start" | "end" | "error", summary: string, data?: unknown): GraphEvent {
  return { type: "node", node, phase, summary, data, at: nowIso() };
}

export function toolEvent(name: string, phase: "start" | "end" | "error", summary: string, data?: unknown): GraphEvent {
  return { type: "tool", name, phase, summary, data, at: nowIso() };
}

export function graphEventToSse(sessionId: string, event: GraphEvent): ChatEventOut | null {
  if (event.type === "node") {
    return {
      sessionId,
      channel: "web",
      type: "node",
      payload: { node: event.node, phase: event.phase, summary: event.summary, data: event.data }
    };
  }
  // For tool events: keep mapping to existing ChatEventOut.tool for UI compatibility
  return null;
}
```

- [ ] **Step 2: Switch SmartAgent streaming logic from “messages diff” to “graphEvents diff”**

In `src/agent/agent.ts`, remove the ReAct `messages`-diff-to-SSE mapping and replace it with:
- Graph stream over `V2State`
- Track `lastSeenGraphEventCount`
- For each new `state.graphEvents.slice(lastSeenGraphEventCount)`, emit:
  - `type:"node"` for node events
  - `type:"tool"` for tool events (mapped to existing UI shape)
  - Keep `status thinking/done` + `final`

Key invariant from spec: every node must produce `node:start` and `node:end` (or `node:error`).

---

### Task 4: Build the V2 StateGraph (nodes + edges)

**Files:**
- Create: `src/agent/v2/graph.ts`
- Create: `src/agent/v2/nodes/ingest.ts`
- Create: `src/agent/v2/nodes/route_modality.ts`
- Create: `src/agent/v2/nodes/image_analysis.ts`
- Create: `src/agent/v2/nodes/text_prepare.ts`
- Create: `src/agent/v2/nodes/route_intent.ts`
- Create: `src/agent/v2/nodes/smartthings_node.ts`
- Create: `src/agent/v2/nodes/ros2_node.ts`
- Create: `src/agent/v2/nodes/default_node.ts`
- Create: `src/agent/v2/nodes/respond.ts`
- Create: `src/agent/v2/nodes/finalize.ts`
- Modify: `src/agent/agent.ts`

- [ ] **Step 1: Create the graph builder skeleton**

In `src/agent/v2/graph.ts`:

```ts
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { V2State } from "./state.js";

// Keep state in a single channel to simplify updates in TS.
const State = Annotation.Root({
  state: Annotation<V2State>({
    reducer: (_prev, next) => next,
    default: () => {
      throw new Error("V2 state must be provided");
    }
  })
});

export function buildV2Graph(/* deps injected here */) {
  const graph = new StateGraph(State);
  // graph.addNode(...), addEdge/conditionalEdges, then compile()
  return graph;
}
```

Decide deps injection now (locked):
- LLM(s): `ChatOpenAI` for text + multimodal calls (same client, different prompt/messages)
- Tools: reuse existing tools from `src/tools/*`
- `systemPrompt`: reuse `createSystemPrompt(...)` but update for V2 (router + image policy)

- [ ] **Step 2: Implement the node list from the spec**

Each node file exports a function `(state: V2State, deps) => Promise<V2State>` (or returns a partial update if you decide to use multi-channel state later). Every node must:
- append `node:start`
- append `node:end` or `node:error`

Node behaviors (minimum for Done Criteria):
- `ingest`: validate `input`, append node events
- `route_modality`: no-op except event + edge routing
- `image_analysis`: call multimodal model, set `imageContext`
- `text_prepare`: set `userText` from text or from `imageContext` (facts vs inferences labeling)
- `route_intent`: set `intent`, `intentRationale`, apply low-confidence -> `default`
- `smartthings_node` / `ros2_node`: call existing tools and save structured `toolResults`
- `default_node`: normal chat answer plan data (can keep `toolResults` empty)
- `respond`: produce `finalText` in one style for all intents
- `finalize`: append to `messages` history (Human/AI/Tool as needed)

- [ ] **Step 3: Implement edges (exactly as spec §8)**

Add conditional edges:
- `route_modality` -> `image_analysis` or `text_prepare`
- `route_intent` -> `smartthings_node` / `ros2_node` / `default_node`
- Always converge: `respond` -> `finalize` -> `END`

- [ ] **Step 4: Replace SmartAgent to use compiled V2 graph**

In `src/agent/agent.ts`:
- Replace `createReactAgent(...)` with `buildV2Graph(...).compile()`
- Update `handleUserMessage` signature to accept `message: InputMessage`

---

### Task 5: Implement image request UI + Graph Steps panel

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Add image input + prompt input UI**

In `public/index.html`, add:
- `<input type="file" accept="image/*" id="imageInput" />`
- `<input type="text" id="imagePrompt" placeholder="(optional) image prompt..." />`
- Keep existing text composer (for `kind:"text"`)

- [ ] **Step 2: Encode image to base64 and send `{ message: { kind:"image", ... } }`**

In `public/app.js`, add helper:

```js
async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
```

Send body:
- text: `{ sessionId, message: { kind:"text", text } }`
- image: `{ sessionId, message: { kind:"image", mimeType:file.type, base64, prompt, text } }`

- [ ] **Step 3: Add Graph Steps panel render and `node` event handler**

In `public/app.js`:
- Maintain an ordered list of nodes (spec order).
- On `event.type === "node"`, update:
  - list item for `payload.node` (phase + summary)
  - highlight current node when `phase === "start"`

Also keep existing tool events list unchanged.

---

### Task 6: Verification checklist (no new test framework)

**Files:**
- (none)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0

- [ ] **Step 2: Manual text flow**

Run: `npm run dev`, then in browser:
- send a normal text message
- verify UI shows: `status=thinking`, `node` steps, tool events (when applicable), final answer, `status=done`

- [ ] **Step 3: Manual image flow**

In browser:
- select an image + optional prompt
- verify it routes through `image_analysis` and emits node events

- [ ] **Step 4: Backward compatibility**

Run (PowerShell):

```powershell
curl -Method Post http://localhost:3000/api/chat -Headers @{\"Content-Type\"=\"application/json\"} -Body '{\"text\":\"hello\"}'
```

Expected: server accepts `{text}` without `{message}`.

---

## Spec coverage self-check

- Nodes/edges match spec §4/§5/§8.
- `node` SSE event added (spec §11.2).
- Request accepts `message.kind` and `{text}` fallback (spec §11.1, §14.1).
- Low-confidence intent -> default + clarify in respond (spec §4 `route_intent`, §14.2).
- Frontend Graph Steps panel implemented (spec §14.3).

