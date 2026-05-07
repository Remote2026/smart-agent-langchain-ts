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
  intentRationale: Annotation<string | undefined>({ reducer: (_, n) => n }),
  toolResults: Annotation<unknown>({ reducer: (_, n) => n }),
  finalText: Annotation<string | undefined>({ reducer: (_, n) => n }),
  graphEvents: Annotation<GraphEvent[]>({ reducer: (_, n) => n, default: () => [] }),
});

type GraphStateType = typeof GraphState.State;

// ── 事件工具 ────────────────────────────────────────────────────────────

function eventLog(ev: GraphEvent) {
  console.log("[graph:event]", ev);
}

// ── 节点：ingest ────────────────────────────────────────────────────────

async function ingestNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  events.push(nodeEvent({ node: "ingest", phase: "start", summary: "validating text input" }));
  eventLog(events[events.length - 1]);

  const trimmed = state.input.text.trim();
  if (!trimmed) {
    events.push(nodeEvent({ node: "ingest", phase: "error", summary: "empty text" }));
    eventLog(events[events.length - 1]);
    events.push(nodeEvent({ node: "ingest", phase: "end", summary: "fallback to default" }));
    eventLog(events[events.length - 1]);
    return {
      userText: "",
      intent: "default",
      intentConfidence: "low",
      intentRationale: "empty text",
      toolResults: undefined,
      finalText: undefined,
      graphEvents: [...state.graphEvents, ...events]
    };
  }

  events.push(nodeEvent({ node: "ingest", phase: "end", summary: `ok len=${trimmed.length}` }));
  eventLog(events[events.length - 1]);
  return {
    userText: trimmed,
    intent: undefined,
    intentConfidence: undefined,
    intentRationale: undefined,
    toolResults: undefined,
    finalText: undefined,
    graphEvents: [...state.graphEvents, ...events]
  };
}

// ── 节点：router_intent ─────────────────────────────────────────────────

async function routeIntentNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  events.push(nodeEvent({ node: "router_intent", phase: "start", summary: "classifying intent" }));
  eventLog(events[events.length - 1]);

  const userText = state.userText ?? "";
  if (!userText) {
    events.push(nodeEvent({ node: "router_intent", phase: "end", summary: "intent=default (missing userText)" }));
    eventLog(events[events.length - 1]);
    return {
      intent: "default",
      intentRationale: "missing userText",
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
  let intentRationale: string;
  let intentConfidence: "low" | "medium" | "high" = "low";

  try {
    const recentHistory = state.messages.slice(-3);
    const historyBlock = recentHistory.length > 0
      ? recentHistory.map((m) => `[${m._getType()}]: ${typeof m.content === "string" ? m.content.slice(0, 200) : ""}`).join("\n")
      : "(none)";
    const prompt = `You are a router. Classify the user's request.\n\nRecent history:\n${historyBlock}\n\nReturn ONLY valid JSON.\nSchema:\n${JSON.stringify(
      { intent: "smartthings|ros2|default", confidence: "low|medium|high", rationale_short: "short reason" },
      null, 2
    )}\n\nUser text:\n${userText}\n`;

    const res = await deps.llm.invoke([new HumanMessage(prompt)]);
    const parsed = safeJsonParse(typeof res.content === "string" ? res.content : JSON.stringify(res.content));
    const intentOut = IntentSchema.safeParse(parsed);
    if (!intentOut.success) {
      intentRationale = "router parse failed";
    } else {
      const out = intentOut.data;
      intentConfidence = out.confidence;
      intent = out.confidence === "low" ? "default" : out.intent;
      intentRationale = `${out.rationale_short} (confidence=${out.confidence})`;
    }
  } catch (error) {
    intentRationale = error instanceof Error ? error.message : String(error);
  }

  events.push(nodeEvent({ node: "router_intent", phase: "end", summary: `intent=${intent}` }));
  eventLog(events[events.length - 1]);
  return { intent, intentRationale, intentConfidence, graphEvents: [...state.graphEvents, ...events] };
}

// ── 节点：smartthings_node ──────────────────────────────────────────────

async function smartthingsNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  events.push(nodeEvent({ node: "smartthings_node", phase: "start", summary: "calling SmartThings tools" }));
  eventLog(events[events.length - 1]);

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
      events.push(nodeEvent({ node: "smartthings_node", phase: "error", summary: "action parse failed", data: actionRaw }));
      eventLog(events[events.length - 1]);
      return { toolResults: { ok: false, error: "smartthings action parse failed" }, graphEvents: [...state.graphEvents, ...events] };
    }

    if (action.data.action === "none") {
      events.push(nodeEvent({ node: "smartthings_node", phase: "end", summary: "no-op" }));
      eventLog(events[events.length - 1]);
      return { toolResults: { ok: true, note: action.data.reason }, graphEvents: [...state.graphEvents, ...events] };
    }

    if (action.data.action === "list_devices") {
      const listTool = deps.tools.find((t) => t.name === "smartthings_list_devices");
      if (!listTool) throw new Error("smartthings_list_devices tool is not registered.");

      const tev = toolEvent({ name: "smartthings_list_devices", phase: "start", summary: "GET /v1/devices", data: {} });
      events.push(tev); eventLog(tev);

      const raw = await listTool.invoke({});
      const output = typeof raw === "string" ? safeJsonParse(raw) : raw;

      const tev2 = toolEvent({ name: "smartthings_list_devices", phase: "end", summary: "ok", data: output });
      events.push(tev2); eventLog(tev2);

      events.push(nodeEvent({ node: "smartthings_node", phase: "end", summary: "ok" }));
      eventLog(events[events.length - 1]);
      return { toolResults: output, graphEvents: [...state.graphEvents, ...events] };
    }

    // action=set_switch
    const resolveTool = deps.tools.find((t) => t.name === "smartthings_resolve_alias");
    const setSwitchTool = deps.tools.find((t) => t.name === "smartthings_set_switch");
    if (!resolveTool || !setSwitchTool) throw new Error("smartthings_resolve_alias/smartthings_set_switch not registered.");

    const tev3 = toolEvent({ name: "smartthings_resolve_alias", phase: "start", summary: "resolve alias", data: { alias: action.data.alias } });
    events.push(tev3); eventLog(tev3);

    const resolvedRaw = await resolveTool.invoke({ alias: action.data.alias });
    const resolved = typeof resolvedRaw === "string" ? safeJsonParse(resolvedRaw) : resolvedRaw;

    const tev4 = toolEvent({ name: "smartthings_resolve_alias", phase: "end", summary: "ok", data: resolved });
    events.push(tev4); eventLog(tev4);

    const found = typeof resolved === "object" && resolved && (resolved as any).found === true;
    const deviceId = found ? String((resolved as any).deviceId ?? "") : "";
    if (!deviceId) {
      events.push(nodeEvent({ node: "smartthings_node", phase: "end", summary: "alias not found", data: resolved }));
      eventLog(events[events.length - 1]);
      return { toolResults: { ok: false, error: "alias not found", resolved }, graphEvents: [...state.graphEvents, ...events] };
    }

    const tev5 = toolEvent({ name: "smartthings_set_switch", phase: "start", summary: action.data.on ? "turn on" : "turn off", data: { deviceId, on: action.data.on } });
    events.push(tev5); eventLog(tev5);

    const setRaw = await setSwitchTool.invoke({ deviceId, on: action.data.on });
    const setOut = typeof setRaw === "string" ? safeJsonParse(setRaw) : setRaw;

    const tev6 = toolEvent({ name: "smartthings_set_switch", phase: "end", summary: "ok", data: setOut });
    events.push(tev6); eventLog(tev6);

    events.push(nodeEvent({ node: "smartthings_node", phase: "end", summary: "ok" }));
    eventLog(events[events.length - 1]);
    return {
      toolResults: { ok: true, action: "set_switch", alias: action.data.alias, on: action.data.on, deviceId },
      graphEvents: [...state.graphEvents, ...events]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    events.push(toolEvent({ name: "smartthings_list_devices", phase: "error", summary: message }));
    eventLog(events[events.length - 1]);
    events.push(nodeEvent({ node: "smartthings_node", phase: "error", summary: message }));
    eventLog(events[events.length - 1]);
    return { toolResults: { ok: false, error: message }, graphEvents: [...state.graphEvents, ...events] };
  }
}

// ── 节点：ros2_node ─────────────────────────────────────────────────────

async function ros2Node(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  events.push(nodeEvent({ node: "ros2_node", phase: "start", summary: "get ROS2 status (real if possible, else mock)" }));
  eventLog(events[events.length - 1]);

  const getParamTool = deps.tools.find((t) => t.name === "ros2_get_param");
  const request = { node: "/demo_node", name: "status" };

  if (getParamTool) {
    try {
      const tev = toolEvent({ name: "ros2_get_param", phase: "start", summary: "call rosbridge", data: request });
      events.push(tev); eventLog(tev);

      const raw = await getParamTool.invoke(request);
      const out = typeof raw === "string" ? safeJsonParse(raw) : raw;

      const tev2 = toolEvent({ name: "ros2_get_param", phase: "end", summary: "ok", data: out });
      events.push(tev2); eventLog(tev2);

      events.push(nodeEvent({ node: "ros2_node", phase: "end", summary: "ok (real)" }));
      eventLog(events[events.length - 1]);
      return { toolResults: { mode: "real", request, result: out, at: new Date().toISOString() }, graphEvents: [...state.graphEvents, ...events] };
    } catch (error) {
      const tev3 = toolEvent({ name: "ros2_get_param", phase: "error", summary: error instanceof Error ? error.message : String(error), data: { request } });
      events.push(tev3); eventLog(tev3);
    }
  }

  // mock fallback
  const mockData = { mode: "mock" as const, status: "ok", nodes: ["demo_node"], topics: ["/cmd_vel", "/odom"], at: new Date().toISOString() };
  const tev4 = toolEvent({ name: "ros2_status_mock", phase: "start", summary: "fallback mock", data: {} });
  events.push(tev4); eventLog(tev4);

  const tev5 = toolEvent({ name: "ros2_status_mock", phase: "end", summary: "ok", data: mockData });
  events.push(tev5); eventLog(tev5);

  events.push(nodeEvent({ node: "ros2_node", phase: "end", summary: "ok (mock)" }));
  eventLog(events[events.length - 1]);
  return { toolResults: mockData, graphEvents: [...state.graphEvents, ...events] };
}

// ── 节点：default_node ──────────────────────────────────────────────────

async function defaultNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  events.push(nodeEvent({ node: "default_node", phase: "start", summary: "pass-through to respond" }));
  eventLog(events[events.length - 1]);
  events.push(nodeEvent({ node: "default_node", phase: "end", summary: "ok" }));
  eventLog(events[events.length - 1]);
  return { graphEvents: [...state.graphEvents, ...events] };
}

// ── 节点：respond ───────────────────────────────────────────────────────

async function respondNode(state: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  events.push(nodeEvent({ node: "respond", phase: "start", summary: "generating finalText" }));
  eventLog(events[events.length - 1]);

  try {
    // 模板路径：smartthings 结构化结果
    if (state.intent === "smartthings" && state.toolResults && typeof state.toolResults === "object") {
      const tr = state.toolResults as any;
      if (Array.isArray(tr.devices)) {
        const text = "SmartThings 设备列表：\n" +
          tr.devices.map((d: any, idx: number) => `${idx + 1}. ${d.label ?? d.name ?? "(unnamed)"} (${d.id ?? "unknown-id"})`).join("\n");
        events.push(nodeEvent({ node: "respond", phase: "end", summary: "ok (template)" }));
        eventLog(events[events.length - 1]);
        return { finalText: text, messages: [new AIMessage(text)], graphEvents: [...state.graphEvents, ...events] };
      }
      if (tr.action === "set_switch") {
        const on = Boolean(tr.on);
        const alias = String(tr.alias ?? "");
        const text = on ? `已打开 ${alias}` : `已关闭 ${alias}`;
        events.push(nodeEvent({ node: "respond", phase: "end", summary: "ok (template)" }));
        eventLog(events[events.length - 1]);
        return { finalText: text, messages: [new AIMessage(text)], graphEvents: [...state.graphEvents, ...events] };
      }
    }

    // 模板路径：ros2 结构化结果
    if (state.intent === "ros2" && state.toolResults && typeof state.toolResults === "object") {
      const tr = state.toolResults as any;
      const mode = String(tr.mode ?? "mock");
      let text: string;
      if (mode === "real") {
        text = `ROS2 状态（通过 rosbridge）：\nrequest=${JSON.stringify(tr.request)}\nresult=${JSON.stringify(tr.result)}`;
      } else {
        text = `ROS2 状态（模拟）：${tr.status ?? "ok"}\nNodes: ${tr.nodes?.join(", ") ?? "-"}\nTopics: ${tr.topics?.join(", ") ?? "-"}`;
      }
      events.push(nodeEvent({ node: "respond", phase: "end", summary: "ok (template)" }));
      eventLog(events[events.length - 1]);
      return { finalText: text, messages: [new AIMessage(text)], graphEvents: [...state.graphEvents, ...events] };
    }

    // 澄清路径：default + low confidence
    if (state.intent === "default" && (state.intentConfidence ?? "low") === "low") {
      const t = (state.userText ?? "").toLowerCase();
      const wantsSwitch = t.includes("打开") || t.includes("关闭") || t.includes("turn on") || t.includes("turn off") || t.includes("开灯") || t.includes("关灯");
      const wantsRos = t.includes("ros2") || t.includes("topic") || t.includes("service") || t.includes("launch") || t.includes("param");
      let text: string;
      if (wantsSwitch) {
        text = "我不确定你要控制哪个 SmartThings 设备。\n请告诉我设备别名（例如：客厅灯/卧室灯）以及要执行的动作（打开/关闭）。";
      } else if (wantsRos) {
        text = "我不确定你要查询/控制哪个 ROS2 节点或参数。\n请给我 node 名称和参数名（例如：node=/demo_node, param=status）。";
      } else {
        text = "我不太确定你的意图。\n你是想控制 SmartThings 设备、查询 ROS2 状态，还是普通聊天？";
      }
      events.push(nodeEvent({ node: "respond", phase: "end", summary: "ok (clarify)" }));
      eventLog(events[events.length - 1]);
      return { finalText: text, messages: [new AIMessage(text)], graphEvents: [...state.graphEvents, ...events] };
    }

    // 通用 LLM 路径：SystemMessage + 完整 messages 历史 → 多轮对话记忆
    const res = await deps.llm.invoke([
      new SystemMessage(deps.systemPrompt),
      ...state.messages
    ]);
    const text = (typeof res.content === "string" ? res.content : JSON.stringify(res.content)).trim();
    events.push(nodeEvent({ node: "respond", phase: "end", summary: "ok" }));
    eventLog(events[events.length - 1]);
    return { finalText: text, messages: [new AIMessage(text)], graphEvents: [...state.graphEvents, ...events] };
  } catch (error) {
    events.push(nodeEvent({ node: "respond", phase: "error", summary: error instanceof Error ? error.message : String(error) }));
    eventLog(events[events.length - 1]);
    return { finalText: "", graphEvents: [...state.graphEvents, ...events] };
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

// ── 节点：finalize ──────────────────────────────────────────────────────

async function finalizeNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  events.push(nodeEvent({ node: "finalize", phase: "start", summary: "checkpoint will persist messages" }));
  eventLog(events[events.length - 1]);
  events.push(nodeEvent({ node: "finalize", phase: "end", summary: "done" }));
  eventLog(events[events.length - 1]);
  return { graphEvents: [...state.graphEvents, ...events] };
}

// ── 构建图 ──────────────────────────────────────────────────────────────

export function buildV2Graph(deps: Deps) {
  const graph = new StateGraph(GraphState)
    .addNode("ingest", ingestNode)
    .addNode("router_intent", (s: GraphStateType) => routeIntentNode(s, deps))
    .addNode("smartthings_node", (s: GraphStateType) => smartthingsNode(s, deps))
    .addNode("ros2_node", (s: GraphStateType) => ros2Node(s, deps))
    .addNode("default_node", defaultNode)
    .addNode("respond", (s: GraphStateType) => respondNode(s, deps))
    .addNode("finalize", finalizeNode);

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

  graph.addEdge("respond", "finalize");
  graph.addEdge("finalize", END);

  return graph.compile({ checkpointer: deps.checkpointer });
}
