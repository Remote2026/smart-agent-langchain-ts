import Database from "better-sqlite3";
import { HumanMessage, AIMessage, AIMessageChunk, isAIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { Channel, ChatEventOut, GraphEvent } from "../types.js";
import type { InputMessage } from "./v2/state.js";
import { graphEventToSse } from "./v2/events.js";
import { buildV2Graph } from "./v2/graph.js";
import { loadAppConfig } from "../config.js";
import { compressImage } from "../utils/image.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent.ts");

type EmitEvent = (event: ChatEventOut) => void;

/**
 * V2：自定义 StateGraph（text-only, Plan A）
 * - ingest -> router_intent -> (smartthings|ros2|default) -> respond
 * - 每个 node/tool 都产出 graphEvents，SSE 层只做"增量转发"
 */
function createSystemPrompt(): string {
  return `You are a local smart-home assistant with vision capability.
You can have normal daily conversation, analyze images (e.g., plant health, device photos), and control SmartThings through tools.
You must follow these rules:
- When the user sends an image, analyze it and answer in the same language as the user.
- If device name or ID is ambiguous, call smartthings_list_devices first to find available devices.
- Never invent device IDs, parameter values, or tool results.
- Keep final answers concise and in the same language as the user.
- Explain tool failures in readable language without exposing secrets.`;
}

/**
 * 按 InputMessage.kind 分支构造 HumanMessage：
 *  - kind="text" → 纯文本 HumanMessage
 *  - kind="image" → 多模态 content 数组（text? + image_url）
 */
/** 日志用：截断 base64，避免刷屏 */
function summarizeInput(msg: InputMessage): unknown {
  if (msg.kind === "text") return msg;
  return {
    kind: msg.kind,
    mimeType: msg.mimeType,
    base64Len: msg.imageBase64.length,
    text: msg.text,
  };
}

export async function buildHumanMessage(msg: InputMessage): Promise<HumanMessage> {
  if (msg.kind === "text") {
    return new HumanMessage(msg.text);
  }
  // kind: "image" — 先压缩再构造多模态 content
  const compressed = await compressImage(msg.imageBase64, msg.mimeType);
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  if (msg.text) {
    parts.push({ type: "text", text: msg.text });
  }
  parts.push({
    type: "image_url",
    image_url: { url: `data:${compressed.mimeType};base64,${compressed.base64}` }
  });
  return new HumanMessage({ content: parts });
}

export class SmartAgent {
  private v2Graph: ReturnType<typeof buildV2Graph>;
  private readonly systemPrompt: string;
  // 保存构造参数，clearSession() 重建图时需要
  private readonly graphDeps: {
    llm: ChatOpenAI;
    tools: StructuredToolInterface[];
    dbPath: string;
  };

  constructor(options: {
    baseURL: string;
    apiKey: string;
    model: string;
    tools: StructuredToolInterface[];
    dbPath?: string;
  }) {
    const appConfig = loadAppConfig();

    const model = new ChatOpenAI({
      configuration: {
        baseURL: options.baseURL,
        apiKey: options.apiKey
      },
      model: options.model,
      temperature: 0.2,
      streaming: true,
      ...(appConfig.env.DEEPSEEK_THINKING_MODE === "disabled"
        ? { modelKwargs: { thinking: { type: "disabled" } } }
        : {})
    });

    this.systemPrompt = createSystemPrompt();
    log.info("constructor", "SmartAgent initialized");

    const dbPath = options.dbPath ?? "checkpoints.db";
    this.graphDeps = { llm: model, tools: options.tools, dbPath };

    this.v2Graph = buildV2Graph({
      llm: model,
      tools: options.tools,
      systemPrompt: this.systemPrompt,
      checkpointer: SqliteSaver.fromConnString(dbPath)
    });
    log.info("constructor", "Checkpointer:", dbPath);
  }

  /** 清除 checkpoint 中所有会话历史（直接操作 SQLite，避免 Windows 文件锁） */
  clearSession(): void {
    const db = new Database(this.graphDeps.dbPath);
    db.exec("DELETE FROM checkpoints");
    db.exec("DELETE FROM writes");
    db.close();
    log.info("clearSession", "checkpoint cleared:", this.graphDeps.dbPath);
  }

  // channel 参数支持多 transport：Web 传入 "web"，Slack 传入 "slack"（默认 "web" 保持向后兼容）
  async handleUserMessage(input: { sessionId: string; message: InputMessage; emit: EmitEvent; channel?: Channel }): Promise<void> {
    const channel = input.channel ?? "web";
    // 1) 通知前端：进入思考/执行流程（SSE 事件）
    input.emit({
      sessionId: input.sessionId,
      channel,
      type: "status",
      payload: { status: "thinking" }
    });

    // graphEvents 增量推送：只发本轮新增的 delta，避免重复渲染前端
    let lastSeenGraphEventCount = 0;
    let lastStateMessages: BaseMessage[] | null = null;
    let lastFinalText = "";
    const seenToolCallIds = new Set<string>();

    try {
      // 初始 state（扁平 channel，直接传字段）：
      //   messages: [本轮 HumanMessage] → checkpoint append reducer 追加到历史
      //   graphEvents: [] → replace reducer 每轮清空，各 node 逐步补事件
      const initialGraphState = {
        sessionId: input.sessionId,
        input: input.message,
        messages: [await buildHumanMessage(input.message)], // text/image 统一入口
        graphEvents: []
      };

      log.info("handleUserMessage", "graph start", {
        input: summarizeInput(initialGraphState.input),
        msgLen: initialGraphState.messages.length
      });

      // thread_id = sessionId → LangGraph 自动从 checkpoint 恢复消息历史
      const stream = await this.v2Graph.stream(
        initialGraphState,
        {
          streamMode: ["values", "messages"],
          recursionLimit: 35,
          configurable: { thread_id: input.sessionId }
        }
      );

      for await (const [eventType, data] of stream) {
        if (eventType === "values") {
          const v2State = data as any;
          if (!v2State || !Array.isArray(v2State.graphEvents)) {
            continue;
          }

          lastStateMessages = Array.isArray(v2State.messages) ? (v2State.messages as BaseMessage[]) : lastStateMessages;
          lastFinalText = typeof v2State.finalText === "string" ? v2State.finalText : lastFinalText;

          const lastMsg = lastStateMessages?.[lastStateMessages.length - 1];
          // log.info("handleUserMessage", "graph state", { lastMsg, lastFinalText });

          // 如果 LLM 返回了新的 tool_calls，立即发送 tool:start SSE（不等 tool_node 执行完）
          if (lastMsg && isAIMessage(lastMsg) && lastMsg.tool_calls?.length) {
            for (const tc of lastMsg.tool_calls) {
              if (tc.id && !seenToolCallIds.has(tc.id)) {
                seenToolCallIds.add(tc.id);
                log.debug("handleUserMessage", `emit tool executing: ${tc.name}`);
                input.emit({
                  sessionId: input.sessionId,
                  channel,
                  type: "tool",
                  payload: {
                    name: tc.name ?? "unknown",
                    status: "executing",
                    input: tc.args,
                    toolCallId: tc.id
                  }
                });
              }
            }
          }

          // delta 切片：只取本轮新增的 graphEvents
          const newEvents = v2State.graphEvents.slice(lastSeenGraphEventCount) as GraphEvent[];
          lastSeenGraphEventCount = v2State.graphEvents.length;
          log.debug("handleUserMessage", `graphEvents delta: ${newEvents.length} new, total ${lastSeenGraphEventCount}`);
          for (const ev of newEvents) {
            log.debug("handleUserMessage", `emit graphEvent: ${ev.type} ${(ev as any).name ?? (ev as any).node} ${ev.phase}`);
            input.emit(graphEventToSse(input.sessionId, ev, channel));
          }
        } else if (eventType === "messages") {
          const [messageChunk] = data as [BaseMessage, Record<string, any>];
          // 只转发 AI 消息（流式增量或完整消息），过滤掉 SystemMessage 等其他类型
          if (!isAIMessage(messageChunk)) {
            continue;
          }
          const text = typeof messageChunk.content === "string" ? messageChunk.content : "";
          // log.info("handleUserMessage", "messages chunk:", JSON.stringify(text), "len:", text.length, "type:", (messageChunk as any).constructor?.name);
          if (text) {
            input.emit({
              sessionId: input.sessionId,
              channel,
              type: "token",
              payload: { text }
            });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emit({
        sessionId: input.sessionId,
        channel,
        type: "error",
        payload: { message }
      });
      // 注意：只 return 不 throw，避免调用方 catch 块重复 emit error 事件（Slack mirror 会发两次）
      return;
    }

    const finalText = lastFinalText;

    input.emit({
      sessionId: input.sessionId,
      channel,
      type: "final",
      payload: { text: finalText }
    });
    input.emit({
      sessionId: input.sessionId,
      channel,
      type: "status",
      payload: { status: "done" }
    });
  }

  async handleDeviceEvent(input: { sessionId: string; message: InputMessage; emit: EmitEvent; channel?: Channel }): Promise<void> {
    const channel = input.channel ?? "web";
    input.emit({
      sessionId: input.sessionId,
      channel,
      type: "status",
      payload: { status: "thinking" }
    });

    let lastSeenGraphEventCount = 0;
    let lastFinalText = "";
    let lastStateMessages: BaseMessage[] | null = null;
    const seenToolCallIds = new Set<string>();

    try {
      const initialGraphState = {
        sessionId: input.sessionId,
        input: input.message,
        messages: [await buildHumanMessage(input.message)], // 设备事件始终为 kind:"text"，走纯文本分支
        graphEvents: []
      };

      const stream = await this.v2Graph.stream(
        initialGraphState,
        {
          streamMode: ["values", "messages"],
          recursionLimit: 35,
          configurable: { thread_id: input.sessionId }
        }
      );

      for await (const [eventType, data] of stream) {
        if (eventType === "values") {
          const v2State = data as any;
          if (!v2State || !Array.isArray(v2State.graphEvents)) {
            continue;
          }

          lastFinalText = typeof v2State.finalText === "string" ? v2State.finalText : lastFinalText;
          lastStateMessages = Array.isArray(v2State.messages) ? (v2State.messages as BaseMessage[]) : lastStateMessages;

          const lastMsg = lastStateMessages?.[lastStateMessages.length - 1];
          if (lastMsg && isAIMessage(lastMsg) && lastMsg.tool_calls?.length) {
            for (const tc of lastMsg.tool_calls) {
              if (tc.id && !seenToolCallIds.has(tc.id)) {
                seenToolCallIds.add(tc.id);
                input.emit({
                  sessionId: input.sessionId,
                  channel,
                  type: "tool",
                  payload: {
                    name: tc.name ?? "unknown",
                    status: "executing",
                    input: tc.args,
                    toolCallId: tc.id
                  }
                });
              }
            }
          }

          const newEvents = v2State.graphEvents.slice(lastSeenGraphEventCount) as GraphEvent[];
          lastSeenGraphEventCount = v2State.graphEvents.length;
          for (const ev of newEvents) {
            input.emit(graphEventToSse(input.sessionId, ev, channel));
          }
        } else if (eventType === "messages") {
          const [messageChunk] = data as [BaseMessage, Record<string, any>];
          if (!isAIMessage(messageChunk)) {
            continue;
          }
          const text = typeof messageChunk.content === "string" ? messageChunk.content : "";
          // log.info("handleDeviceEvent", "messages chunk:", JSON.stringify(text), "len:", text.length, "type:", (messageChunk as any).constructor?.name);
          if (text) {
            input.emit({
              sessionId: input.sessionId,
              channel,
              type: "token",
              payload: { text }
            });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.emit({
        sessionId: input.sessionId,
        channel,
        type: "error",
        payload: { message }
      });
      return;
    }

    input.emit({
      sessionId: input.sessionId,
      channel,
      type: "final",
      payload: { text: lastFinalText }
    });
    input.emit({
      sessionId: input.sessionId,
      channel,
      type: "status",
      payload: { status: "done" }
    });
  }

}
