# V2.1 ToolNode Multi-Round Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 3 hardcoded domain nodes with a unified LLM ⇄ ToolNode multi-round agent loop.

**Architecture:** 5-node StateGraph: ingest → router_intent → prepare_agent → llm_call ⇄ tool_node → respond. LLM uses bindTools + ToolNode for autonomous tool selection and multi-step reasoning. Max 5 loop iterations.

**Tech Stack:** LangGraph StateGraph, ToolNode, ChatOpenAI bindTools, Zod validation

---

### Task 1: Add agentLoopCount to GraphState and import ToolNode

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Add agentLoopCount channel and import ToolNode**

In `src/agent/v2/graph.ts`, add the import for ToolNode and AIMessage:

```ts
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
```

Note: `HumanMessage` is already imported, `AIMessage` and `SystemMessage` might need to be added. Check existing import.

Add `agentLoopCount` to GraphState after `graphEvents`:

```ts
agentLoopCount: Annotation<number>({ reducer: (_, n) => n, default: () => 0 }),
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/agent/v2/graph.ts`
Expected: No new errors from this change.

- [ ] **Step 3: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add agentLoopCount to GraphState for ToolNode loop safety"
```

---

### Task 2: Create tool subset selector helper

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Add selectTools function**

Add after the `GraphState` definition (before `addEvent`):

```ts
function selectTools(intent: string | undefined, allTools: StructuredToolInterface[]): StructuredToolInterface[] {
  switch (intent) {
    case "smartthings":
      return allTools.filter(t => t.name.startsWith("smartthings_"));
    case "ros2":
      return allTools.filter(t => t.name.startsWith("ros2_"));
    default:
      return allTools;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add selectTools helper for intent-based tool filtering"
```

---

### Task 3: Create prepare_agent node

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Write prepareAgentNode function**

Add after the `selectTools` function:

```ts
async function prepareAgentNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "prepare_agent", phase: "start", summary: `intent=${state.intent ?? "default"}` }));

  const hasSystem = state.messages.length > 0 && state.messages[0] instanceof SystemMessage;
  const systemMessages: BaseMessage[] = hasSystem ? [] : [new SystemMessage(deps.systemPrompt)];

  addEvent(events, nodeEvent({ node: "prepare_agent", phase: "end", summary: hasSystem ? "system prompt cached" : "system prompt injected" }));

  return {
    messages: systemMessages,
    agentLoopCount: 0,
    graphEvents: [...state.graphEvents, ...events]
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add prepare_agent node for system prompt and loop reset"
```

---

### Task 4: Create llm_call node

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Write llmCallNode function**

Add after `prepareAgentNode`:

```ts
async function llmCallNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  const loopIdx = state.agentLoopCount;
  addEvent(events, nodeEvent({ node: "llm_call", phase: "start", source: "llm", summary: `round ${loopIdx + 1}` }));

  const activeTools = selectTools(state.intent, deps.tools);
  const llmWithTools = deps.llm.bindTools(activeTools);

  try {
    const response = await llmWithTools.invoke(state.messages as BaseMessage[]);
    const hasToolCalls = response instanceof AIMessage && response.tool_calls && response.tool_calls.length > 0;
    addEvent(events, nodeEvent({
      node: "llm_call", phase: "end", source: "llm",
      summary: hasToolCalls ? `tool_calls: ${response.tool_calls!.map(tc => tc.name).join(", ")}` : "final response"
    }));
    return {
      messages: [response],
      agentLoopCount: state.agentLoopCount + 1,
      graphEvents: [...state.graphEvents, ...events]
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    addEvent(events, nodeEvent({ node: "llm_call", phase: "error", source: "llm", summary: msg }));
    return {
      messages: [new AIMessage(`LLM 调用失败：${msg}`)],
      graphEvents: [...state.graphEvents, ...events]
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add llm_call node with bindTools"
```

---

### Task 5: Create tool_node wrapper with events

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Write toolNodeWithEvents function**

Add after `llmCallNode`:

```ts
function buildToolNodeWithEvents(deps: Deps) {
  const toolNode = new ToolNode(deps.tools);

  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    const events: GraphEvent[] = [];
    addEvent(events, nodeEvent({ node: "tool_node", phase: "start", summary: "executing tool calls" }));

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls) {
      for (const tc of lastMsg.tool_calls) {
        addEvent(events, toolEvent({ name: tc.name, phase: "start", summary: tc.name, data: tc.args }));
      }
    }

    try {
      const result = await toolNode.invoke({ messages: state.messages });

      const toolMessages = result.messages as BaseMessage[];
      for (const tm of toolMessages) {
        addEvent(events, toolEvent({ name: tm.name ?? "unknown", phase: "end", summary: "ok", data: typeof tm.content === "string" ? tm.content.slice(0, 500) : tm.content }));
      }

      return {
        messages: toolMessages,
        toolResults: [...((state.toolResults as any[]) ?? []), ...toolMessages.map(m => ({ name: m.name, content: m.content }))],
        graphEvents: [...state.graphEvents, ...events]
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addEvent(events, toolEvent({ name: "tool_node", phase: "error", summary: msg }));
      addEvent(events, nodeEvent({ node: "tool_node", phase: "error", summary: msg }));
      return { graphEvents: [...state.graphEvents, ...events] };
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: add tool_node wrapper with event tracking"
```

---

### Task 6: Simplify respond node

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Rewrite respondNode**

Replace the existing `respondNode` (lines 294-310) with:

```ts
async function respondNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "respond", phase: "start", summary: "extracting final response" }));

  const lastAi = [...state.messages].reverse().find(m => m instanceof AIMessage && !m.tool_calls?.length) as AIMessage | undefined;
  const text = lastAi && typeof lastAi.content === "string" ? lastAi.content.trim() : (state.finalText ?? "");

  if (text) {
    addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: `ok len=${text.length}` }));
    return { finalText: text, graphEvents: [...state.graphEvents, ...events] };
  }

  addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: "no response content" }));
  return { finalText: "", graphEvents: [...state.graphEvents, ...events] };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: simplify respond node for ToolNode flow"
```

---

### Task 7: Remove old domain nodes and rebuild graph

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Remove old domain nodes**

Delete these functions and their helpers that are no longer needed:
- `routeIntentNode` — KEEP (router_intent is still used)
- `smartthingsNode` (lines 150-264) — REMOVE
- `ros2Node` (lines 268-270) — REMOVE
- `defaultNode` (lines 274-290) — REMOVE
- `formatSmartThingsList` (lines 318-332) — REMOVE (LLM will format its own response)
- `safeJsonParse` (lines 314-316) — REMOVE (no more manual JSON parsing for tool actions)

- [ ] **Step 2: Rewrite buildV2Graph**

Replace the `buildV2Graph` function (lines 336-363) with:

```ts
export function buildV2Graph(deps: Deps) {
  const graph = new StateGraph(GraphState)
    .addNode("ingest", ingestNode)
    .addNode("router_intent", (s: GraphStateType) => routeIntentNode(s, deps))
    .addNode("prepare_agent", (s: GraphStateType) => prepareAgentNode(s, deps))
    .addNode("llm_call", (s: GraphStateType) => llmCallNode(s, deps))
    .addNode("tool_node", buildToolNodeWithEvents(deps))
    .addNode("respond", respondNode);

  graph.addEdge(START, "ingest");
  graph.addEdge("ingest", "router_intent");
  graph.addEdge("router_intent", "prepare_agent");
  graph.addEdge("prepare_agent", "llm_call");

  graph.addConditionalEdges("llm_call", (s: GraphStateType) => {
    const lastMsg = s.messages[s.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      return "tool_node";
    }
    return "respond";
  });

  graph.addConditionalEdges("tool_node", (s: GraphStateType) => {
    if (s.agentLoopCount < 5) {
      return "llm_call";
    }
    return "respond";
  });

  graph.addEdge("respond", END);

  return graph.compile({ checkpointer: deps.checkpointer });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/agent/v2/graph.ts
git commit -m "feat: replace domain nodes with ToolNode multi-round agent loop"
```

---

### Task 8: Update ingest node to handle intent=default edge case

**Files:**
- Modify: `src/agent/v2/graph.ts`

- [ ] **Step 1: Simplify ingestNode error/empty path**

The old ingestNode sets `intent="default"` for empty text. With the new flow, router_intent won't even be reached if we short-circuit to respond. But for simplicity, keep the existing behavior — router_intent will also detect empty userText and route to default. No change needed.

Skip this task — existing ingest logic is compatible.

---

### Task 9: Verify compilation and graph structure

**Files:**
- (no file changes, verification only)

- [ ] **Step 1: Verify TypeScript compilation**

```bash
npx tsc --noEmit 2>&1
```
Expected: No type errors.

- [ ] **Step 2: Start dev server and test manually**

```bash
npm run dev
```

Then test with curl (or use web UI):
1. `"你好"` → default route, LLM responds naturally without tool calls
2. `"list my devices"` → smartthings route, calls `smartthings_list_devices`
3. `"turn on living room light"` → smartthings route, multi-round: `smartthings_resolve_alias` → `smartthings_set_switch`
4. `"get ros param node_name param_name"` → ros2 route, calls `ros2_get_param`

Check SSE events include: `node:start/end` for each node, `tool:start/end` for each tool call, and final text response.

- [ ] **Step 3: Verify loop limit works**

Send a request that would trigger many tool calls. Verify agent stops after 5 rounds and returns a response rather than looping infinitely.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: verify ToolNode agent loop end-to-end"
```
