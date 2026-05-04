import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { V2State } from "./state.js";
import { nodeEvent, toolEvent } from "./events.js";
import { z } from "zod";

type Deps = {
  llm: ChatOpenAI;
  tools: StructuredToolInterface[];
  systemPrompt: string;
};

const GraphState = Annotation.Root({
  state: Annotation<V2State>({
    reducer: (_prev, next) => next,
    // NOTE: LangGraph constructs channel instances up front and may call `default()`
    // during graph initialization. We return a minimal placeholder and rely on `ingest`
    // to validate the real input state.
    default: () =>
      ({
        sessionId: "",
        input: { kind: "text", text: "" },
        messages: [],
        graphEvents: []
      }) as V2State
  })
});

type GraphStateType = typeof GraphState.State;

function cloneState(state: V2State): V2State {
  return {
    ...state,
    messages: [...state.messages],
    graphEvents: [...state.graphEvents]
  };
}

/**
 * 事件追加约定（对应设计文档 “每个 node 必须产出 start/end/error”）：
 * - node 事件用于前端展示“Graph Steps”
 * - tool 事件用于前端展示“Tool Events”
 */
function appendEvent(state: V2State, event: Parameters<typeof nodeEvent>[0] | Parameters<typeof toolEvent>[0]) {
  // 关键数据流日志：node/tool 事件在这里统一落一份到控制台，方便排障。
  console.log("[graph:event]", event);
  if ("node" in event) {
    state.graphEvents.push(nodeEvent(event));
  } else {
    state.graphEvents.push(toolEvent(event));
  }
}

async function ingestNode(input: GraphStateType): Promise<Partial<GraphStateType>> {
  const next = cloneState(input.state);
  appendEvent(next, { node: "ingest", phase: "start", summary: "validating text input" });

  // Text-only: normalize user text early so downstream nodes can assume `userText` exists.
  const trimmed = next.input.text.trim();
  if (!trimmed) {
    // 兜底策略：仍然让图继续跑到 respond，给用户一个友好的提示（而不是直接中断）。
    appendEvent(next, { node: "ingest", phase: "error", summary: "empty text" });
    next.userText = "";
    next.intent = "default";
    next.intentConfidence = "low";
    next.intentRationale = "empty text";
    appendEvent(next, { node: "ingest", phase: "end", summary: "fallback to default" });
    return { state: next };
  }

  next.userText = trimmed;
  appendEvent(next, { node: "ingest", phase: "end", summary: `ok len=${trimmed.length}` });
  return { state: next };
}

async function routeIntentNode(input: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const next = cloneState(input.state);
  appendEvent(next, { node: "router_intent", phase: "start", summary: "classifying intent" });

  const userText = next.userText ?? "";
  if (!userText) {
    next.intent = "default";
    next.intentRationale = "missing userText";
    next.intentConfidence = "low";
    appendEvent(next, { node: "router_intent", phase: "end", summary: "intent=default (missing userText)" });
    return { state: next };
  }

  /**
   * 意图路由（LLM 分类 + 结构化输出）。
   *
   * 设计点：
   * - 输出 intent + rationale + confidence
   * - confidence=low 时强制 intent=default（兜底策略）
   */
  const IntentSchema = z.object({
    intent: z.enum(["smartthings", "ros2", "default"]),
    confidence: z.enum(["low", "medium", "high"]),
    rationale_short: z.string().min(1)
  });

  try {
    const prompt = `You are a router. Classify the user's request.\n\nReturn ONLY valid JSON.\nSchema:\n${JSON.stringify(
      {
        intent: "smartthings|ros2|default",
        confidence: "low|medium|high",
        rationale_short: "short reason"
      },
      null,
      2
    )}\n\nUser text:\n${userText}\n`;
    const res = await deps.llm.invoke([new HumanMessage(prompt)]);
    const parsed = safeJsonParse(typeof res.content === "string" ? res.content : JSON.stringify(res.content));
    const intentOut = IntentSchema.safeParse(parsed);
    if (!intentOut.success) {
      next.intent = "default";
      next.intentRationale = "router parse failed";
      next.intentConfidence = "low";
    } else {
      const out = intentOut.data;
      next.intentConfidence = out.confidence;
      next.intent = out.confidence === "low" ? "default" : out.intent;
      next.intentRationale = `${out.rationale_short} (confidence=${out.confidence})`;
    }
  } catch (error) {
    next.intent = "default";
    next.intentRationale = error instanceof Error ? error.message : String(error);
    next.intentConfidence = "low";
  }

  appendEvent(next, { node: "router_intent", phase: "end", summary: `intent=${next.intent}` });
  return { state: next };
}

async function smartthingsNode(input: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const next = cloneState(input.state);
  appendEvent(next, { node: "smartthings_node", phase: "start", summary: "calling SmartThings tools" });

  try {
    /**
     * 最小可用实现（按你的要求先走通基本流程）：
     * - 当用户意图为 smartthings 且提到“设备列表 / list devices”，就调用 smartthings_list_devices
     *
     * 注意：
     * - 我们这里直接调用已注册的 StructuredTool（来自 createTools），避免重复实现 HTTP 客户端逻辑
     * - 工具本身会走 SmartThings REST：GET https://api.smartthings.com/v1/devices
     */
    const userText = next.userText ?? "";

    /**
     * SmartThings 动作抽取（LLM -> JSON）
     * - action=list_devices：拉取设备列表
     * - action=set_switch：按 alias 开/关
     */
    const ActionSchema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("list_devices") }),
      z.object({ action: z.literal("set_switch"), alias: z.string().min(1), on: z.boolean() }),
      z.object({ action: z.literal("none"), reason: z.string().min(1) })
    ]);

    const actionPrompt = `You extract a SmartThings action.\nReturn ONLY valid JSON.\nRules:\n- If user asks for device list, choose action=list_devices.\n- If user asks to turn on/off a device by name, choose action=set_switch with alias and on.\n- Otherwise choose action=none.\n\nSchema:\n${JSON.stringify(
      { action: "list_devices|set_switch|none", alias: "string (when set_switch)", on: "boolean (when set_switch)", reason: "string (when none)" },
      null,
      2
    )}\n\nUser text:\n${userText}\n`;

    const actionRes = await deps.llm.invoke([new HumanMessage(actionPrompt)]);
    const actionRaw = safeJsonParse(typeof actionRes.content === "string" ? actionRes.content : JSON.stringify(actionRes.content));
    const action = ActionSchema.safeParse(actionRaw);

    if (!action.success) {
      next.toolResults = { ok: false, error: "smartthings action parse failed" };
      appendEvent(next, { node: "smartthings_node", phase: "error", summary: "action parse failed", data: actionRaw });
      return { state: next };
    }

    if (action.data.action === "none") {
      next.toolResults = { ok: true, note: action.data.reason };
      appendEvent(next, { node: "smartthings_node", phase: "end", summary: "no-op" });
      return { state: next };
    }

    if (action.data.action === "list_devices") {
      const listTool = deps.tools.find((toolItem) => toolItem.name === "smartthings_list_devices");
      if (!listTool) {
        throw new Error("smartthings_list_devices tool is not registered.");
      }

      appendEvent(next, { name: "smartthings_list_devices", phase: "start", summary: "GET /v1/devices", data: {} });
      const raw = await listTool.invoke({});
      const output = typeof raw === "string" ? safeJsonParse(raw) : raw;
      next.toolResults = output;
      appendEvent(next, { name: "smartthings_list_devices", phase: "end", summary: "ok", data: output });
      appendEvent(next, { node: "smartthings_node", phase: "end", summary: "ok" });
      return { state: next };
    }

    // action=set_switch: resolve alias -> set_switch
    const resolveTool = deps.tools.find((toolItem) => toolItem.name === "smartthings_resolve_alias");
    const setSwitchTool = deps.tools.find((toolItem) => toolItem.name === "smartthings_set_switch");
    if (!resolveTool || !setSwitchTool) {
      throw new Error("smartthings_resolve_alias/smartthings_set_switch tool is not registered.");
    }

    appendEvent(next, {
      name: "smartthings_resolve_alias",
      phase: "start",
      summary: "resolve alias",
      data: { alias: action.data.alias }
    });
    const resolvedRaw = await resolveTool.invoke({ alias: action.data.alias });
    const resolved = typeof resolvedRaw === "string" ? safeJsonParse(resolvedRaw) : resolvedRaw;
    appendEvent(next, { name: "smartthings_resolve_alias", phase: "end", summary: "ok", data: resolved });

    const found = typeof resolved === "object" && resolved && (resolved as any).found === true;
    const deviceId = found ? String((resolved as any).deviceId ?? "") : "";
    if (!deviceId) {
      next.toolResults = { ok: false, error: "alias not found", resolved };
      appendEvent(next, { node: "smartthings_node", phase: "end", summary: "alias not found", data: resolved });
      return { state: next };
    }

    appendEvent(next, {
      name: "smartthings_set_switch",
      phase: "start",
      summary: action.data.on ? "turn on" : "turn off",
      data: { deviceId, on: action.data.on }
    });
    const setRaw = await setSwitchTool.invoke({ deviceId, on: action.data.on });
    const setOut = typeof setRaw === "string" ? safeJsonParse(setRaw) : setRaw;
    appendEvent(next, { name: "smartthings_set_switch", phase: "end", summary: "ok", data: setOut });

    next.toolResults = {
      ok: true,
      action: "set_switch",
      alias: action.data.alias,
      on: action.data.on,
      deviceId
    };

    appendEvent(next, { node: "smartthings_node", phase: "end", summary: "ok" });
  } catch (error) {
    appendEvent(next, {
      name: "smartthings_list_devices",
      phase: "error",
      summary: error instanceof Error ? error.message : String(error)
    });
    appendEvent(next, {
      node: "smartthings_node",
      phase: "error",
      summary: error instanceof Error ? error.message : String(error)
    });
  }

  return { state: next };
}

async function ros2Node(input: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const next = cloneState(input.state);
  appendEvent(next, { node: "ros2_node", phase: "start", summary: "get ROS2 status (real if possible, else mock)" });

  /**
   * ROS2 策略（贴近设计文档，同时兼容“本地无 ROS2”现状）：
   * 1) 优先尝试调用已注册工具 `ros2_get_param`（走 rosbridge）
   * 2) 如果连接失败/调用失败：记录 tool:error，然后回退到 mock 数据（tool:end）
   */
  const getParamTool = deps.tools.find((toolItem) => toolItem.name === "ros2_get_param");
  const userText = next.userText ?? "";

  // 最小参数：允许用户不提供细节时也能跑通流程
  const request = { node: "/demo_node", name: "status" };

  if (getParamTool) {
    try {
      appendEvent(next, { name: "ros2_get_param", phase: "start", summary: "call rosbridge", data: request });
      const raw = await getParamTool.invoke(request);
      const out = typeof raw === "string" ? safeJsonParse(raw) : raw;
      appendEvent(next, { name: "ros2_get_param", phase: "end", summary: "ok", data: out });
      next.toolResults = { mode: "real", request, result: out, at: new Date().toISOString() };
      appendEvent(next, { node: "ros2_node", phase: "end", summary: "ok (real)" });
      return { state: next };
    } catch (error) {
      appendEvent(next, {
        name: "ros2_get_param",
        phase: "error",
        summary: error instanceof Error ? error.message : String(error),
        data: { request, userText }
      });
    }
  }

  // mock fallback
  appendEvent(next, { name: "ros2_status_mock", phase: "start", summary: "fallback mock", data: {} });
  next.toolResults = {
    mode: "mock",
    status: "ok",
    nodes: ["demo_node"],
    topics: ["/cmd_vel", "/odom"],
    at: new Date().toISOString()
  };
  appendEvent(next, { name: "ros2_status_mock", phase: "end", summary: "ok", data: next.toolResults });

  appendEvent(next, { node: "ros2_node", phase: "end", summary: "ok (mock)" });
  return { state: next };
}

async function defaultNode(input: GraphStateType): Promise<Partial<GraphStateType>> {
  const next = cloneState(input.state);
  appendEvent(next, { node: "default_node", phase: "start", summary: "placeholder" });
  appendEvent(next, { node: "default_node", phase: "end", summary: "ok" });
  return { state: next };
}

async function respondNode(input: GraphStateType, deps: Deps): Promise<Partial<GraphStateType>> {
  const next = cloneState(input.state);
  appendEvent(next, { node: "respond", phase: "start", summary: "generating finalText" });

  try {
    /**
     * 最小可用：当上游已经产出结构化 toolResults 时，优先用“可预测的模板”输出，
     * 这样就算模型/外部依赖不可用，用户也能看到基本结果与数据流。
     */
    if (next.intent === "smartthings" && next.toolResults && typeof next.toolResults === "object") {
      const devices = (next.toolResults as any)?.devices;
      if (Array.isArray(devices)) {
        next.finalText =
          "SmartThings 设备列表：\n" +
          devices
            .map((d: any, idx: number) => `${idx + 1}. ${d.label ?? d.name ?? "(unnamed)"} (${d.id ?? "unknown-id"})`)
            .join("\n");
        next.messages.push(new AIMessage(next.finalText));
        appendEvent(next, { node: "respond", phase: "end", summary: "ok (template)" });
        return { state: next };
      }

      if ((next.toolResults as any)?.action === "set_switch") {
        const on = Boolean((next.toolResults as any).on);
        const alias = String((next.toolResults as any).alias ?? "");
        next.finalText = on ? `已打开 ${alias}` : `已关闭 ${alias}`;
        next.messages.push(new AIMessage(next.finalText));
        appendEvent(next, { node: "respond", phase: "end", summary: "ok (template)" });
        return { state: next };
      }
    }

    if (next.intent === "ros2" && next.toolResults && typeof next.toolResults === "object") {
      const mode = String((next.toolResults as any)?.mode ?? "mock");
      if (mode === "mock") {
        const status = (next.toolResults as any)?.status;
        next.finalText = `ROS2 状态（模拟）：${status ?? "ok"}\nNodes: ${(next.toolResults as any).nodes?.join(", ") ?? "-"}\nTopics: ${(next.toolResults as any).topics?.join(", ") ?? "-"
          }`;
        next.messages.push(new AIMessage(next.finalText));
        appendEvent(next, { node: "respond", phase: "end", summary: "ok (template)" });
        return { state: next };
      }

      if (mode === "real") {
        next.finalText = `ROS2 状态（通过 rosbridge）：\nrequest=${JSON.stringify((next.toolResults as any).request)}\nresult=${JSON.stringify(
          (next.toolResults as any).result
        )}`;
        next.messages.push(new AIMessage(next.finalText));
        appendEvent(next, { node: "respond", phase: "end", summary: "ok (template)" });
        return { state: next };
      }
    }

    /**
     * default + low confidence：自然澄清/追问一个最关键缺失信息（设计文档要求）。
     * 这里不依赖模型，先用规则保证可预测。
     */
    if (next.intent === "default" && (next.intentConfidence ?? "low") === "low") {
      const t = (next.userText ?? "").toLowerCase();
      const wantsSwitch =
        t.includes("打开") || t.includes("关闭") || t.includes("turn on") || t.includes("turn off") || t.includes("开灯") || t.includes("关灯");
      const wantsRos =
        t.includes("ros2") || t.includes("topic") || t.includes("service") || t.includes("launch") || t.includes("param");

      if (wantsSwitch) {
        next.finalText =
          "我不确定你要控制哪个 SmartThings 设备。\n请告诉我设备别名（例如：客厅灯/卧室灯）以及要执行的动作（打开/关闭）。";
      } else if (wantsRos) {
        next.finalText = "我不确定你要查询/控制哪个 ROS2 节点或参数。\n请给我 node 名称和参数名（例如：node=/demo_node, param=status）。";
      } else {
        next.finalText = "我不太确定你的意图。\n你是想控制 SmartThings 设备、查询 ROS2 状态，还是普通聊天？";
      }

      next.messages.push(new AIMessage(next.finalText));
      appendEvent(next, { node: "respond", phase: "end", summary: "ok (clarify)" });
      return { state: next };
    }

    const userText = next.userText ?? "";
    /**
     * 统一由 respond 生成自然语言输出（执行节点与回复节点分离）。
     * - 当前版本：根据 `userText` + `intent` + `toolResults` 生成 finalText
     */
    const prompt = `${deps.systemPrompt}\n\nUser:\n${userText}\n`;
    const res = await deps.llm.invoke([new HumanMessage(prompt)]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    next.finalText = text.trim();
    next.messages.push(new AIMessage(next.finalText));
    appendEvent(next, { node: "respond", phase: "end", summary: "ok" });
  } catch (error) {
    appendEvent(next, {
      node: "respond",
      phase: "error",
      summary: error instanceof Error ? error.message : String(error)
    });
    next.finalText = "";
  }

  return { state: next };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function finalizeNode(input: GraphStateType): Promise<Partial<GraphStateType>> {
  const next = cloneState(input.state);
  appendEvent(next, { node: "finalize", phase: "start", summary: "persisting session messages" });

  // For now, messages are already updated in respond (AI) + ingest (Human).
  appendEvent(next, { node: "finalize", phase: "end", summary: "done" });
  return { state: next };
}

/**
 * 构建 V2（text-only）智能体图结构（Plan A）。
 *
 * 图结构流程：
 * START -> ingest -> router_intent -> (smartthings|ros2|default) -> respond -> finalize -> END
 *
 * 说明：
 * - 本版暂时不考虑图片输入（纯文本）。
 * - 关键节点都会通过 `appendEvent` 产出 node/tool 事件，便于 SSE/控制台观测数据流。
 */
export function buildV2Graph(deps: Deps) {
  const graph = new StateGraph(GraphState)
    // 添加各个处理节点
    .addNode("ingest", ingestNode) // 输入处理节点：校验并归一化 userText
    .addNode("router_intent", (i: GraphStateType) => routeIntentNode(i, deps)) // 意图路由节点：确定用户意图
    .addNode("smartthings_node", (i: GraphStateType) => smartthingsNode(i, deps)) // SmartThings相关处理节点
    .addNode("ros2_node", (i: GraphStateType) => ros2Node(i, deps))              // ROS2相关处理节点
    .addNode("default_node", defaultNode)            // 默认处理节点：处理未分类的意图
    .addNode("respond", (i: GraphStateType) => respondNode(i, deps))             // 响应生成节点：生成最终响应
    .addNode("finalize", finalizeNode);              // 结束节点：完成处理并清理资源

  // 定义固定边：设置节点间的直接连接
  graph.addEdge(START, "ingest");                    // 开始节点连接到输入处理节点
  graph.addEdge("ingest", "router_intent");          // 输入处理节点连接到意图路由

  // 根据识别的意图类型路由到相应的处理节点
  graph.addConditionalEdges("router_intent", (s: GraphStateType) => {
    switch (s.state.intent) {
      case "smartthings":
        return "smartthings_node";                   // 智能家居相关意图
      case "ros2":
        return "ros2_node";                          // ROS2机器人相关意图
      default:
        return "default_node";                       // 其他意图使用默认处理
    }
  });

  // 将所有意图处理节点连接到响应生成节点
  graph.addEdge("smartthings_node", "respond");
  graph.addEdge("ros2_node", "respond");
  graph.addEdge("default_node", "respond");

  // 连接到结束流程
  graph.addEdge("respond", "finalize");              // 响应生成后进行收尾工作
  graph.addEdge("finalize", END);                    // 收尾工作完成后结束

  // 返回编译后的图实例
  return graph.compile();
}
