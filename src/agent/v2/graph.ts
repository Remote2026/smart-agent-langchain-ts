import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { GraphEvent } from "../../types.js";
import type { InputMessage } from "./state.js";
import { nodeEvent, toolEvent } from "./events.js";
import { z } from "zod";

type Deps = {
  llm: ChatOpenAI;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  checkpointer: BaseCheckpointSaver;
};

// ── 扁平化 GraphState ──────────────────────────────────────────────────
// 数据流: ingest → router_intent → prepare_agent → llm_call ⇄ tool_node → respond
// llm_call 与 tool_node 之间构成 agent 循环（最多 5 轮），LLM 自主决定调用哪些 tool
const MAX_HISTORY = 50;

const GraphState = Annotation.Root({
  sessionId: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  eventType: Annotation<"chat" | "device_event">({ reducer: (_, n) => n, default: () => "chat" }),
  input: Annotation<InputMessage>({ reducer: (_, n) => n, default: () => ({ kind: "text", text: "" }) }),
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => {
      const merged = [...prev, ...next];
      return merged.length > MAX_HISTORY ? merged.slice(-MAX_HISTORY) : merged;
    },
    default: () => []
  }),
  userText: Annotation<string | undefined>({ reducer: (_, n) => n }),
  intent: Annotation<"smartthings" | "ros2" | "default" | undefined>({ reducer: (_, n) => n }),
  toolResults: Annotation<unknown>({ reducer: (_, n) => n }),
  finalText: Annotation<string | undefined>({ reducer: (_, n) => n }),
  graphEvents: Annotation<GraphEvent[]>({ reducer: (_, n) => n, default: () => [] }),
  agentLoopCount: Annotation<number>({ reducer: (_, n) => n, default: () => 0 }),
});

type GraphStateType = typeof GraphState.State;

// ── 事件工具 ────────────────────────────────────────────────────────────
function addEvent(events: GraphEvent[], ev: GraphEvent) {
  events.push(ev);
  console.log(`GraphEvent: ${ev.type === "node" ? `[${ev.node}]` : `[tool:${ev.name}]`} ${ev.phase} - ${ev.summary}`);
}

// ── 工具选择 ────────────────────────────────────────────────────────────
// 按意图隔离 tool 子集，避免 smartthings 请求误调到 ros2 tool（安全 + 省 token）

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

// ── 节点：ingest ────────────────────────────────────────────────────────
// 校验输入文本，产出 userText。空文本直接短路到 default，跳过 router

async function ingestNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "ingest", phase: "start", summary: "validating text input" }));

  const trimmed = state.input.text.trim();
  if (!trimmed) {
    addEvent(events, nodeEvent({ node: "ingest", phase: "error", summary: "empty text" }));
    addEvent(events, nodeEvent({ node: "ingest", phase: "end", summary: "fallback to default" }));
    return {
      userText: "",
      intent: "default",
      toolResults: undefined,
      finalText: undefined,
      graphEvents: [...state.graphEvents, ...events]
    };
  }

  addEvent(events, nodeEvent({ node: "ingest", phase: "end", summary: `ok len=${trimmed.length}` }));
  return {
    userText: trimmed,
    intent: undefined,
    toolResults: undefined,
    finalText: undefined,
    graphEvents: [...state.graphEvents, ...events]
  };
}

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

// ── 节点：router_intent ─────────────────────────────────────────────────
// 用最近 3 条历史 + 当前 userText 让 LLM 分类意图。低置信度自动降级到 default

async function routeIntentNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "router_intent", phase: "start", summary: "classifying intent" }));

  const userText = state.userText ?? "";
  if (!userText) {
    addEvent(events, nodeEvent({ node: "router_intent", phase: "end", summary: "intent=default (missing userText)" }));
    return {
      intent: "default",
      graphEvents: [...state.graphEvents, ...events]
    };
  }

  const IntentSchema = z.object({
    intent: z.enum(["smartthings", "ros2", "default"]),
    confidence: z.enum(["low", "medium", "high"]),
    rationale_short: z.string().min(1)
  });

  let intent: "smartthings" | "ros2" | "default" = "default";

  try {
    const recentHistory = state.messages.slice(-3);
    const historyBlock = recentHistory.length > 0
      ? recentHistory.map((m) => `[${m._getType()}]: ${typeof m.content === "string" ?
        m.content.slice(0, 200) : ""}`).join("\n")
      : "(none)";
    const prompt = `You are a router. Classify the user's request.\n\n
    Recent history:\n${historyBlock}\n\n
    Return ONLY valid JSON.\nSchema:\n${JSON.stringify(
      {
        intent: "smartthings|ros2|default",
        confidence: "low|medium|high",
        rationale_short: "short reason"
      },
      null, 2
    )}\n\nUser text:\n${userText}\n`;

    const res = await deps.llm.invoke([new HumanMessage(prompt)]);
    const parsed = safeJsonParse(typeof res.content === "string" ? res.content : JSON.stringify(res.content));
    const intentOut = IntentSchema.safeParse(parsed);
    if (intentOut.success) {
      const out = intentOut.data;
      intent = out.confidence === "low" ? "default" : out.intent;
    }
  } catch {
    // intent stays "default" on error
  }

  addEvent(events, nodeEvent({ node: "router_intent", phase: "end", summary: `intent=${intent}` }));
  return { intent, graphEvents: [...state.graphEvents, ...events] };
}

// ── 节点：prepare_agent ─────────────────────────────────────────────────
// 注入 system prompt + 重置循环计数器。SystemMessage 只写一次（checkpoint 持久化后跨轮复用）

async function prepareAgentNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "prepare_agent", phase: "start", summary: `intent=${state.intent ?? "default"}` }));

  // 跨轮去重：checkpoint 恢复的 messages 可能已含 SystemMessage
  const hasSystem = state.messages.some(m => m instanceof SystemMessage);
  const systemMessages: BaseMessage[] = hasSystem ? [] : [new SystemMessage(deps.systemPrompt)];

  const tools = selectTools(state.intent, deps.tools);
  const names = tools.map(t => t.name).join(", ");
  addEvent(events, nodeEvent({ node: "prepare_agent", phase: "end", summary: `tools: ${names}` }));

  return {
    messages: systemMessages,
    agentLoopCount: 0,
    graphEvents: [...state.graphEvents, ...events]
  };
}

// ── 节点：llm_call ──────────────────────────────────────────────────────
// 核心节点：LLM bindTools 后根据 messages 决定是调 tool（返回 tool_calls）还是给最终回复
// agentLoopCount 递增，用于 tool_node 侧判断是否达到循环上限

async function llmCallNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  const loopIdx = state.agentLoopCount;
  addEvent(events, nodeEvent({ node: "llm_call", phase: "start", source: "llm", summary: `round ${loopIdx + 1}` }));

  const activeTools = selectTools(state.intent, deps.tools);
  const llmWithTools = deps.llm.bindTools(activeTools);

  try {
    const response = await llmWithTools.invoke(state.messages);
    const hasToolCalls = response instanceof AIMessage && response.tool_calls && response.tool_calls.length > 0;

    addEvent(events, nodeEvent({
      node: "llm_call", phase: "end", source: "llm",
      summary: hasToolCalls
        ? `tool_calls: ${response.tool_calls!.map(tc => tc.name).join(", ")}`
        : `final response len=${typeof response.content === "string" ? response.content.length : 0}`
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

// ── 节点：tool_node（ToolNode 封装）─────────────────────────────────────
// 包装 LangGraph ToolNode，注入 tool:start / tool:end 事件。
// ToolNode 自动读取最后一条 AIMessage.tool_calls 并执行，返回 ToolMessage[]

async function toolNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  const toolRunner = new ToolNode(deps.tools);
  addEvent(events, nodeEvent({ node: "tool_node", phase: "start", summary: "executing tool calls" }));

  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg instanceof AIMessage && lastMsg.tool_calls) {
    for (const tc of lastMsg.tool_calls) {
      addEvent(events, toolEvent({ name: tc.name, phase: "start", summary: tc.name, data: tc.args }));
    }
  }

  try {
    const result = await toolRunner.invoke({ messages: state.messages });
    const toolMessages = result.messages as BaseMessage[];

    for (const tm of toolMessages) {
      const name = (tm as any).name ?? "unknown";
      addEvent(events, toolEvent({
        name, phase: "end", summary: "ok",
        data: typeof tm.content === "string" ? tm.content.slice(0, 500) : tm.content
      }));
    }

    interface ToolResult { name: string; content: unknown }
    const prevResults = Array.isArray(state.toolResults) ? state.toolResults as ToolResult[] : [];
    const newResults: ToolResult[] = toolMessages.map(m => ({ name: (m as any).name ?? "unknown", content: m.content }));
    return {
      messages: toolMessages,
      toolResults: [...prevResults, ...newResults],
      graphEvents: [...state.graphEvents, ...events]
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    addEvent(events, toolEvent({ name: "tool_node", phase: "error", summary: msg }));
    return { graphEvents: [...state.graphEvents, ...events] };
  }
}

// ── 节点：respond ───────────────────────────────────────────────────────
// 从 messages 中逆序找最后一条不含 tool_calls 的 AIMessage 作为 finalText。
// 逆序是因为 agent 循环结束时，最终 AIMessage 在所有 ToolMessage 之前

async function respondNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "respond", phase: "start", summary: "extracting final response" }));

  const lastAi = [...state.messages].reverse().find(
    m => m instanceof AIMessage && !(m.tool_calls && m.tool_calls.length > 0)
  ) as AIMessage | undefined;

  const text = lastAi && typeof lastAi.content === "string" ? lastAi.content.trim() : (state.finalText ?? "");

  if (text) {
    addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: `ok len=${text.length}` }));
    return { finalText: text, graphEvents: [...state.graphEvents, ...events] };
  }

  addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: "no response content" }));
  return { finalText: "", graphEvents: [...state.graphEvents, ...events] };
}

// ── 工具函数 ────────────────────────────────────────────────────────────

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

// ── 构建图 ──────────────────────────────────────────────────────────────

export function buildV2Graph(deps: Deps) {
  const graph = new StateGraph(GraphState)
    .addNode("ingest", ingestNode)
    .addNode("inject_device_event", injectDeviceEventNode)
    .addNode("router_intent", (s: GraphStateType) => routeIntentNode(s, deps))
    .addNode("prepare_agent", (s: GraphStateType) => prepareAgentNode(s, deps))
    .addNode("llm_call", (s: GraphStateType) => llmCallNode(s, deps))
    .addNode("tool_node", (s: GraphStateType) => toolNode(s, deps))
    .addNode("respond", respondNode);

  graph.addEdge("inject_device_event", "prepare_agent");
  // START 根据 eventType 分流：chat → ingest，device_event → inject_device_event
  graph.addConditionalEdges(START, (s: GraphStateType) => {
    return s.eventType === "device_event" ? "inject_device_event" : "ingest";
  }, {
    "inject_device_event": "inject_device_event",
    "ingest": "ingest"
  });
  graph.addEdge("ingest", "router_intent");
  graph.addEdge("router_intent", "prepare_agent");
  graph.addEdge("prepare_agent", "llm_call");

  // llm_call 之后：有 tool_calls → 执行 tool；无 → 直接回复
  graph.addConditionalEdges("llm_call", (s: GraphStateType) => {
    const lastMsg = s.messages[s.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      return "tool_node";
    }
    return "respond";
  });

  // tool_node 之后：未达上限 → 继续 agent 循环；已达上限 → 强制退出
  graph.addConditionalEdges("tool_node", (s: GraphStateType) => {
    if (s.agentLoopCount < 5) {
      return "llm_call";
    }
    return "respond";
  });

  graph.addEdge("respond", END);

  return graph.compile({ checkpointer: deps.checkpointer });
}
