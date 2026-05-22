import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, AIMessageChunk, HumanMessage, isAIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { randomUUID } from "node:crypto";
import type { GraphEvent } from "../../types.js";
import type { InputMessage } from "./state.js";
import { nodeEvent, toolEvent } from "./events.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("graph.ts");

type Deps = {
  llm: ChatOpenAI;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  checkpointer: BaseCheckpointSaver;
};

// ── 扁平化 GraphState ──────────────────────────────────────────────────
// 数据流: START → prepare → llm_call ⇄ tool_node → respond → END
// llm_call 与 tool_node 之间构成 agent 循环，LLM 自主决定调用哪些 tool
// 限制：同一工具最多 3 次，总工具调用最多 10 次，agentLoopCount 兜底 15 轮
const MAX_HISTORY = 50;
const MAX_AGENT_LOOPS = 15;
const MAX_PER_TOOL = 3;
const MAX_TOTAL_TOOLS = 10;

interface ToolResult { name: string; content: unknown }

const GraphState = Annotation.Root({
  sessionId: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  input: Annotation<InputMessage>({ reducer: (_, n) => n, default: () => ({ kind: "text", text: "" }) }),
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => {
      const merged = [...prev, ...next];
      // 去重 SystemMessage：只保留最后一条，避免 checkpoint 积累多条
      const sysIdxs: number[] = [];
      merged.forEach((m, i) => { if (m instanceof SystemMessage) sysIdxs.push(i); });
      let cleaned = merged;
      if (sysIdxs.length > 1) {
        const keep = sysIdxs[sysIdxs.length - 1];
        cleaned = merged.filter((_, i) => sysIdxs.includes(i) ? i === keep : true);
      }
      return cleaned.length > MAX_HISTORY ? cleaned.slice(-MAX_HISTORY) : cleaned;
    },
    default: () => []
  }),
  toolResults: Annotation<unknown>({ reducer: (_, n) => n }),
  finalText: Annotation<string | undefined>({ reducer: (_, n) => n }),
  graphEvents: Annotation<GraphEvent[]>({ reducer: (_, n) => n, default: () => [] }),
  agentLoopCount: Annotation<number>({ reducer: (_, n) => n, default: () => 0 }),
  currentStreakTool: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  toolStreak: Annotation<number>({ reducer: (_, n) => n, default: () => 0 }),
  totalToolCalls: Annotation<number>({ reducer: (_, n) => n, default: () => 0 }),
});

type GraphStateType = typeof GraphState.State;

// ── 事件工具 ────────────────────────────────────────────────────────────
function addEvent(events: GraphEvent[], ev: GraphEvent) {
  events.push(ev);
  log.info("addEvent", `${ev.type === "node" ? `[${ev.node}]` : `[tool:${ev.name}]`} ${ev.phase} - ${ev.summary}`);
}

// ── 节点：prepare ─────────────────────────────────────────────────
// 统一入口节点：注入 SystemMessage + 重置循环计数器。
// SystemMessage 只写一次（checkpoint 持久化后跨轮复用）

async function prepareNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "prepare", phase: "start", summary: "injecting system prompt" }));

  // 跨轮去重：checkpoint 恢复的 messages 可能已含 SystemMessage
  const hasSystem = state.messages.some(m => m instanceof SystemMessage);
  const systemMessages: BaseMessage[] = hasSystem ? [] : [new SystemMessage(deps.systemPrompt)];

  addEvent(events, nodeEvent({ node: "prepare", phase: "end", summary: "context ready" }));

  return {
    messages: systemMessages,
    agentLoopCount: 0,
    toolResults: undefined,
    finalText: undefined,
    currentStreakTool: "",
    toolStreak: 0,
    totalToolCalls: 0,
    graphEvents: [...state.graphEvents, ...events]
  };
}

/**
 * 某些国产模型（如 qwen-turbo）的流式 API 返回的 tool_call id 为空字符串，
 * 导致 LangChain 的 AIMessageChunk 构造函数将其标记为 invalid_tool_calls，
 * tool_calls 变为空数组。此函数从 tool_call_chunks 手动提取 tool_calls，
 * 并为空 id 补上随机 UUID，使下游 ToolNode 能正常工作。
 */
function normalizeLlmResponse(response: BaseMessage): BaseMessage {
  if (!(response instanceof AIMessageChunk)) {
    return response;
  }
  const anyResp = response as any;
  if (anyResp.tool_calls?.length) {
    return response;
  }
  const chunks: Array<{ name?: string; args?: string; id?: string; index?: number; type?: string }> =
    anyResp.tool_call_chunks ?? [];
  if (!chunks.length) {
    return response;
  }

  const toolCalls = [];
  for (const chunk of chunks) {
    const name = chunk.name ?? "";
    const argsStr = chunk.args || "{}";
    const id = chunk.id || `call-${randomUUID()}`;
    try {
      const args = JSON.parse(argsStr);
      toolCalls.push({ name, args, id, type: "tool_call" as const });
    } catch {
      log.warn("normalizeLlmResponse", "failed to parse tool call args:", argsStr);
    }
  }

  if (!toolCalls.length) {
    return response;
  }

  return new AIMessage({
    content: anyResp.content,
    tool_calls: toolCalls,
    additional_kwargs: anyResp.additional_kwargs,
    response_metadata: anyResp.response_metadata,
    id: anyResp.id,
  });
}

// ── 节点：llm_call ──────────────────────────────────────────────────────
// 核心节点：LLM bindTools 后根据 messages 决定是调 tool（返回 tool_calls）还是给最终回复
// agentLoopCount 递增，用于 tool_node 侧判断是否达到循环上限

async function llmCallNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  const loopIdx = state.agentLoopCount;
  addEvent(events, nodeEvent({ node: "llm_call", phase: "start", source: "llm", summary: `round ${loopIdx + 1}` }));

  const llmWithTools = deps.llm.bindTools(deps.tools);

  try {
    const rawResponse = await llmWithTools.invoke(state.messages);
    const response = normalizeLlmResponse(rawResponse);
    const hasToolCalls = isAIMessage(response) && response.tool_calls && response.tool_calls.length > 0;

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

  try {
    const result = await toolRunner.invoke({ messages: state.messages });
    const toolMessages = result.messages as BaseMessage[];

    for (const tm of toolMessages) {
      const name = (tm as any).name ?? "unknown";
      addEvent(events, toolEvent({
        name, phase: "end", summary: "ok",
        data: typeof tm.content === "string" ? tm.content.slice(0, 500) : tm.content,
        toolCallId: (tm as any).tool_call_id
      }));
    }

    const prevResults = Array.isArray(state.toolResults) ? state.toolResults as ToolResult[] : [];
    const newResults: ToolResult[] = toolMessages.map(m => ({ name: (m as any).name ?? "unknown", content: m.content }));

    // returnDirect：如果最后调用的工具有 returnDirect，直接把输出内容写入 finalText
    let directText: string | undefined;
    const lastAi = [...state.messages].reverse().find(
      m => isAIMessage(m) && m.tool_calls && m.tool_calls.length > 0
    ) as AIMessage | undefined;
    if (lastAi?.tool_calls) {
      for (const tc of lastAi.tool_calls) {
        const tool = deps.tools.find(t => t.name === tc.name);
        if (tool && (tool as any).returnDirect) {
          const tm = toolMessages.find(m => (m as any).name === tc.name);
          if (tm && typeof tm.content === "string") {
            directText = tm.content.trim();
          }
        }
      }
    }

    // 更新工具调用 streak 和总次数
    const lastToolName = toolMessages.length > 0
      ? (toolMessages[toolMessages.length - 1] as any).name ?? ""
      : "";
    let currentStreakTool = state.currentStreakTool || "";
    let toolStreak = state.toolStreak || 0;
    if (lastToolName === currentStreakTool && lastToolName) {
      toolStreak += 1;
    } else if (lastToolName) {
      currentStreakTool = lastToolName;
      toolStreak = 1;
    }
    const totalToolCalls = (state.totalToolCalls || 0) + toolMessages.length;

    return {
      messages: toolMessages,
      toolResults: [...prevResults, ...newResults],
      finalText: directText,
      currentStreakTool,
      toolStreak,
      totalToolCalls,
      graphEvents: [...state.graphEvents, ...events]
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    addEvent(events, toolEvent({ name: "tool_node", phase: "error", summary: msg, toolCallId: "batch" }));
    return { graphEvents: [...state.graphEvents, ...events] };
  }
}

// ── 节点：respond ───────────────────────────────────────────────────────
// 从 messages 中逆序找最后一条不含 tool_calls 的 AIMessage 作为 finalText。
// 逆序是因为 agent 循环结束时，最终 AIMessage 在所有 ToolMessage 之前

async function respondNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "respond", phase: "start", summary: "extracting final response" }));

  // returnDirect 优先：tool_node 已把工具输出写入 finalText
  let text = state.finalText ?? "";

  // 正常路径：取最后一条不含 tool_calls 的 AIMessage
  if (!text) {
    const lastAi = [...state.messages].reverse().find(
      m => isAIMessage(m) && !(m.tool_calls && m.tool_calls.length > 0)
    ) as AIMessage | undefined;
    text = lastAi && typeof lastAi.content === "string" ? lastAi.content.trim() : "";
  }

  if (text) {
    addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: `ok len=${text.length}` }));
    return { finalText: text, graphEvents: [...state.graphEvents, ...events] };
  }

  addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: "no response content" }));
  return { finalText: "", graphEvents: [...state.graphEvents, ...events] };
}

// ── 构建图 ──────────────────────────────────────────────────────────────

export function buildV2Graph(deps: Deps) {
  const graph = new StateGraph(GraphState)
    .addNode("prepare", (s: GraphStateType) => prepareNode(s, deps))
    .addNode("llm_call", (s: GraphStateType) => llmCallNode(s, deps))
    .addNode("tool_node", (s: GraphStateType) => toolNode(s, deps))
    .addNode("respond", respondNode);

  graph.addEdge(START, "prepare");
  graph.addEdge("prepare", "llm_call");

  // llm_call 之后：
  // - 有 tool_calls 但同一工具已连续 3 次 → 跳过 tool_node，直接 respond
  // - 有 tool_calls 但总调用已达 10 次 → 跳过 tool_node，直接 respond
  // - 有 tool_calls 且无超限 → 执行 tool_node
  // - 无 tool_calls → 直接 respond
  graph.addConditionalEdges("llm_call", (s: GraphStateType) => {
    const lastMsg = s.messages[s.messages.length - 1];
    if (isAIMessage(lastMsg) && lastMsg.tool_calls?.length) {
      for (const tc of lastMsg.tool_calls) {
        if (tc.name === s.currentStreakTool && s.toolStreak >= 3) {
          return "respond";
        }
      }
      if (s.totalToolCalls >= 10) {
        return "respond";
      }
      return "tool_node";
    }
    return "respond";
  });

  // tool_node 之后：
  // - 如果调用的工具有 returnDirect，直接结束，不再让 LLM 加工
  // - agentLoopCount 超过 MAX_AGENT_LOOPS → 结束
  // - 否则继续 agent 循环
  // （同一工具连续3次和总调用10次的限制已在 llm_call 条件边拦截）
  graph.addConditionalEdges("tool_node", (s: GraphStateType) => {
    const lastAi = [...s.messages].reverse().find(
      m => isAIMessage(m) && m.tool_calls && m.tool_calls.length > 0
    ) as AIMessage | undefined;

    if (lastAi?.tool_calls) {
      for (const tc of lastAi.tool_calls) {
        const tool = deps.tools.find(t => t.name === tc.name);
        if (tool && (tool as any).returnDirect) {
          return "respond";
        }
      }
    }

    if (s.agentLoopCount < MAX_AGENT_LOOPS) {
      return "llm_call";
    }
    return "respond";
  });

  graph.addEdge("respond", END);

  return graph.compile({ checkpointer: deps.checkpointer });
}
