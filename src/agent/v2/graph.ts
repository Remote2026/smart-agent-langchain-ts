import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
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

// ── 扁平化 GraphState（方案 A）──────────────────────────────────────────
// 每个字段独立 channel + 独立 reducer，不再嵌套 { state: V2State }。
// - messages: append reducer（跨轮累积）+ 超过 50 条截断
// - graphEvents: replace reducer（每轮清空），节点通过 [...prev, ...events] 在本轮内传递
// - 其余字段: replace reducer（总是用最新值）
const MAX_HISTORY = 50;

const GraphState = Annotation.Root({
  sessionId: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
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
  intentConfidence: Annotation<"low" | "medium" | "high" | undefined>({ reducer: (_, n) => n }),
  intentReason: Annotation<string | undefined>({ reducer: (_, n) => n }),
  toolResults: Annotation<unknown>({ reducer: (_, n) => n }),
  finalText: Annotation<string | undefined>({ reducer: (_, n) => n }),
  graphEvents: Annotation<GraphEvent[]>({ reducer: (_, n) => n, default: () => [] }),
});

type GraphStateType = typeof GraphState.State;

// ── 事件工具 ────────────────────────────────────────────────────────────
function addEvent(events: GraphEvent[], ev: GraphEvent) {
  events.push(ev);
  //  console.log("[graph:event]", ev);
}

// ── 节点：ingest ────────────────────────────────────────────────────────

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
      intentConfidence: "low",
      intentReason: "empty text",
      toolResults: undefined,
      finalText: undefined,
      graphEvents: [...state.graphEvents, ...events]
    };
  }

  addEvent(events, nodeEvent({ node: "ingest", phase: "end", summary: `ok len=${trimmed.length}` }));
  return {
    userText: trimmed,
    intent: undefined,
    intentConfidence: undefined,
    intentReason: undefined,
    toolResults: undefined,
    finalText: undefined,
    graphEvents: [...state.graphEvents, ...events]
  };
}

// ── 节点：router_intent ─────────────────────────────────────────────────

async function routeIntentNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "router_intent", phase: "start", summary: "classifying intent" }));

  const userText = state.userText ?? "";
  if (!userText) {
    addEvent(events, nodeEvent({ node: "router_intent", phase: "end", summary: "intent=default (missing userText)" }));
    return {
      intent: "default",
      intentReason: "missing userText",
      intentConfidence: "low",
      graphEvents: [...state.graphEvents, ...events]
    };
  }

  const IntentSchema = z.object({
    intent: z.enum(["smartthings", "ros2", "default"]),
    confidence: z.enum(["low", "medium", "high"]),
    rationale_short: z.string().min(1)
  });

  let intent: "smartthings" | "ros2" | "default" = "default";
  let intentReason: string;
  let intentConfidence: "low" | "medium" | "high" = "low";

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
    if (!intentOut.success) {
      intentReason = "router parse failed";
    } else {
      const out = intentOut.data;
      intentConfidence = out.confidence;
      intent = out.confidence === "low" ? "default" : out.intent;
      intentReason = `${out.rationale_short} (confidence=${out.confidence})`;
    }
  } catch (error) {
    intentReason = error instanceof Error ? error.message : String(error);
  }

  addEvent(events, nodeEvent({ node: "router_intent", phase: "end", summary: `intent=${intent}` }));
  return { intent, intentReason, intentConfidence, graphEvents: [...state.graphEvents, ...events] };
}

// ── 节点：smartthings_node ──────────────────────────────────────────────

async function smartthingsNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "smartthings_node", phase: "start", summary: "calling SmartThings tools" }));

  const userText = state.userText ?? "";

  const ActionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("list_devices") }),
    z.object({ action: z.literal("set_switch"), alias: z.string().min(1), on: z.boolean() }),
    z.object({ action: z.literal("none"), reason: z.string().min(1) })
  ]);

  try {
    const actionPrompt = `You extract a SmartThings action.\nReturn ONLY valid JSON.\nRules:\n- If user asks for device list, choose action=list_devices.\n- If user asks to turn on/off a device by name, choose action=set_switch with alias and on.\n- Otherwise choose action=none.\n\nSchema:\n${JSON.stringify(
      { action: "list_devices|set_switch|none", alias: "string (when set_switch)", on: "boolean (when set_switch)", reason: "string (when none)" },
      null, 2
    )}\n\nUser text:\n${userText}\n`;

    const actionRes = await deps.llm.invoke([new HumanMessage(actionPrompt)]);
    const actionRaw = safeJsonParse(typeof actionRes.content === "string" ? actionRes.content : JSON.stringify(actionRes.content));
    const action = ActionSchema.safeParse(actionRaw);

    if (!action.success) {
      const text = "我没能解析这次 SmartThings 操作，请换一种说法再试。";
      addEvent(events, nodeEvent({ node: "smartthings_node", phase: "error", summary: "action parse failed", data: actionRaw }));
      return {
        toolResults: { ok: false, error: "smartthings action parse failed" },
        finalText: text,
        graphEvents: [...state.graphEvents, ...events]
      };
    }

    if (action.data.action === "none") {
      const text = action.data.reason;
      addEvent(events, nodeEvent({ node: "smartthings_node", phase: "end", summary: "no-op" }));
      return {
        toolResults: { ok: true, note: action.data.reason },
        finalText: text,
        graphEvents: [...state.graphEvents, ...events]
      };
    }

    if (action.data.action === "list_devices") {
      const listTool = deps.tools.find((t) => t.name === "smartthings_list_devices");
      if (!listTool) throw new Error("smartthings_list_devices tool is not registered.");

      const tev = toolEvent({ name: "smartthings_list_devices", phase: "start", summary: "GET /v1/devices", data: {} });
      addEvent(events, tev);

      const raw = await listTool.invoke({});
      const output = typeof raw === "string" ? safeJsonParse(raw) : raw;

      const tev2 = toolEvent({ name: "smartthings_list_devices", phase: "end", summary: "ok", data: output });
      addEvent(events, tev2);

      addEvent(events, nodeEvent({ node: "smartthings_node", phase: "end", summary: "ok" }));
      return {
        toolResults: output,
        finalText: formatSmartThingsList(output),
        graphEvents: [...state.graphEvents, ...events]
      };
    }

    // action=set_switch
    const resolveTool = deps.tools.find((t) => t.name === "smartthings_resolve_alias");
    const setSwitchTool = deps.tools.find((t) => t.name === "smartthings_set_switch");
    if (!resolveTool || !setSwitchTool) throw new Error("smartthings_resolve_alias/smartthings_set_switch not registered.");

    const tev3 = toolEvent({ name: "smartthings_resolve_alias", phase: "start", summary: "resolve alias", data: { alias: action.data.alias } });
    addEvent(events, tev3);

    const resolvedRaw = await resolveTool.invoke({ alias: action.data.alias });
    const resolved = typeof resolvedRaw === "string" ? safeJsonParse(resolvedRaw) : resolvedRaw;

    const tev4 = toolEvent({ name: "smartthings_resolve_alias", phase: "end", summary: "ok", data: resolved });
    addEvent(events, tev4);

    const found = typeof resolved === "object" && resolved && (resolved as any).found === true;
    const deviceId = found ? String((resolved as any).deviceId ?? "") : "";
    if (!deviceId) {
      const text = `没有找到名为「${action.data.alias}」的 SmartThings 设备，请换个设备名或先查看设备列表。`;
      addEvent(events, nodeEvent({ node: "smartthings_node", phase: "end", summary: "alias not found", data: resolved }));
      return {
        toolResults: { ok: false, error: "alias not found", resolved },
        finalText: text,
        graphEvents: [...state.graphEvents, ...events]
      };
    }

    const tev5 = toolEvent({ name: "smartthings_set_switch", phase: "start", summary: action.data.on ? "turn on" : "turn off", data: { deviceId, on: action.data.on } });
    addEvent(events, tev5);

    const setRaw = await setSwitchTool.invoke({ deviceId, on: action.data.on });
    const setOut = typeof setRaw === "string" ? safeJsonParse(setRaw) : setRaw;

    const tev6 = toolEvent({ name: "smartthings_set_switch", phase: "end", summary: "ok", data: setOut });
    addEvent(events, tev6);

    addEvent(events, nodeEvent({ node: "smartthings_node", phase: "end", summary: "ok" }));
    return {
      toolResults: { ok: true, action: "set_switch", alias: action.data.alias, on: action.data.on, deviceId },
      finalText: action.data.on ? `已打开 ${action.data.alias}` : `已关闭 ${action.data.alias}`,
      graphEvents: [...state.graphEvents, ...events]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addEvent(events, toolEvent({ name: "smartthings_list_devices", phase: "error", summary: message }));
    addEvent(events, nodeEvent({ node: "smartthings_node", phase: "error", summary: message }));
    return {
      toolResults: { ok: false, error: message },
      finalText: `SmartThings 操作失败：${message}`,
      graphEvents: [...state.graphEvents, ...events]
    };
  }
}

// ── 节点：ros2_node ─────────────────────────────────────────────────────

async function ros2Node(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  return {};
}

// ── 节点：default_node ──────────────────────────────────────────────────

async function defaultNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "default_node", phase: "start", summary: "generating fallback response" }));

  try {
    const res = await deps.llm.invoke([
      new SystemMessage(deps.systemPrompt),
      ...state.messages
    ]);
    const text = (typeof res.content === "string" ? res.content : JSON.stringify(res.content)).trim();
    addEvent(events, nodeEvent({ node: "default_node", phase: "end", summary: "ok" }));
    return { finalText: text, graphEvents: [...state.graphEvents, ...events] };
  } catch (error) {
    addEvent(events, nodeEvent({ node: "default_node", phase: "error", summary: error instanceof Error ? error.message : String(error) }));
    return { finalText: "", graphEvents: [...state.graphEvents, ...events] };
  }
}

// ── 节点：respond ───────────────────────────────────────────────────────

async function respondNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "respond", phase: "start", summary: "generating finalText" }));

  try {
    // 上游节点已经完成领域操作并给出可展示文本时，respond 只负责落消息。
    if (state.finalText) {
      addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: "ok (upstream finalText)" }));
      return { messages: [new AIMessage(state.finalText)], graphEvents: [...state.graphEvents, ...events] };
    }

    addEvent(events, nodeEvent({ node: "respond", phase: "end", summary: "no finalText" }));
    return { graphEvents: [...state.graphEvents, ...events] };
  } catch (error) {
    return { finalText: "", graphEvents: [...state.graphEvents, ...events] };
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function formatSmartThingsList(output: unknown): string {
  const devices = typeof output === "object" && output ? (output as any).devices : undefined;
  if (!Array.isArray(devices)) {
    return `SmartThings 返回结果：${JSON.stringify(output)}`;
  }

  if (devices.length === 0) {
    return "SmartThings 设备列表为空。";
  }

  return "SmartThings 设备列表：\n" +
    devices
      .map((d: any, idx: number) => `${idx + 1}. ${d.label ?? d.name ?? "(unnamed)"} (${d.id ?? "unknown-id"})`)
      .join("\n");
}

// ── 构建图 ──────────────────────────────────────────────────────────────

export function buildV2Graph(deps: Deps) {
  const graph = new StateGraph(GraphState)
    .addNode("ingest", ingestNode)
    .addNode("router_intent", (s: GraphStateType) => routeIntentNode(s, deps))
    .addNode("smartthings_node", (s: GraphStateType) => smartthingsNode(s, deps))
    .addNode("ros2_node", (s: GraphStateType) => ros2Node(s, deps))
    .addNode("default_node", (s: GraphStateType) => defaultNode(s, deps))
    .addNode("respond", respondNode);

  graph.addEdge(START, "ingest");
  graph.addEdge("ingest", "router_intent");

  graph.addConditionalEdges("router_intent", (s: GraphStateType) => {
    switch (s.intent) {
      case "smartthings": return "smartthings_node";
      case "ros2": return "ros2_node";
      default: return "default_node";
    }
  });

  graph.addEdge("smartthings_node", "respond");
  graph.addEdge("ros2_node", "respond");
  graph.addEdge("default_node", "respond");

  graph.addEdge("respond", END);

  return graph.compile({ checkpointer: deps.checkpointer });
}
