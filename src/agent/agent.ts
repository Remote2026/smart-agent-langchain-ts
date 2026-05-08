import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ChatEventOut, GraphEvent } from "../types.js";
import type { InputMessage } from "./v2/state.js";
import { graphEventToSse } from "./v2/events.js";
import { buildV2Graph } from "./v2/graph.js";

type EmitEvent = (event: ChatEventOut) => void;

/**
 * V2：自定义 StateGraph（text-only, Plan A）
 * - ingest -> router_intent -> (smartthings|ros2|default) -> respond
 * - 每个 node/tool 都产出 graphEvents，SSE 层只做"增量转发"
 */
function createSystemPrompt(): string {
  return `You are a local smart-home and ROS2 assistant.
You can have normal daily conversation, and you can control SmartThings and ROS2 through tools.

Rules:
- Use device aliases before controlling named devices.
- If a device alias is missing or ambiguous, list devices or ask the user to choose.
- Never invent device IDs, parameter values, or tool results.
- Keep final answers concise and in the same language as the user.
- Explain tool failures in readable language without exposing secrets.`;
}

export class SmartAgent {
  /**
   * LangGraph 编译后的可运行图（Runnable Graph）。
   * - 通过 SqliteSaver checkpoint 自动持久化会话（messages 历史）
   * - stream(): 以"状态快照"的方式流式产出每一步的 state（便于做 SSE）
   */
  private readonly v2Graph: ReturnType<typeof buildV2Graph>;
  private readonly systemPrompt: string;

  constructor(options: {
    baseURL: string;
    apiKey: string;
    model: string;
    tools: StructuredToolInterface[];
    dbPath?: string;
  }) {
    const model = new ChatOpenAI({
      configuration: {
        baseURL: options.baseURL,
        apiKey: options.apiKey
      },
      model: options.model,
      temperature: 0.2
    });

    this.systemPrompt = createSystemPrompt();
    console.log("SmartAgent initialized with system prompt:", this.systemPrompt);

    // SqliteSaver：嵌入式 SQLite，数据存本地 .db 文件，无需服务端
    const checkpointer = SqliteSaver.fromConnString(options.dbPath ?? "checkpoints.db");
    console.log(`Checkpointer: ${options.dbPath ?? "checkpoints.db"}`);

    this.v2Graph = buildV2Graph({
      llm: model,
      tools: options.tools,
      systemPrompt: this.systemPrompt,
      checkpointer
    });
  }

  async handleUserMessage(input: { sessionId: string; message: InputMessage; emit: EmitEvent }): Promise<void> {
    // 1) 通知前端：进入思考/执行流程（SSE 事件）
    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "status",
      payload: { status: "thinking" }
    });

    // graphEvents 增量推送：只发本轮新增的 delta，避免重复渲染前端
    let lastSeenGraphEventCount = 0;
    let lastStateMessages: BaseMessage[] | null = null;
    let lastFinalText = "";

    try {
      // 初始 state（扁平 channel，直接传字段）：
      //   messages: [本轮 HumanMessage] → checkpoint append reducer 追加到历史
      //   graphEvents: [] → replace reducer 每轮清空，各 node 逐步补事件
      const initialGraphState = {
        sessionId: input.sessionId,
        input: input.message,
        messages: [new HumanMessage(input.message.text)],
        graphEvents: []
      };

      console.log(`[agent] handleUserMessage - graph start`, {
        input: initialGraphState.input,
        msgLen: initialGraphState.messages.length
      });

      // thread_id = sessionId → LangGraph 自动从 checkpoint 恢复消息历史
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

        lastStateMessages = Array.isArray(v2State.messages) ? (v2State.messages as BaseMessage[]) : lastStateMessages;
        lastFinalText = typeof v2State.finalText === "string" ? v2State.finalText : lastFinalText;

        console.log(`[agent] handleUserMessage -state`, {
          messages: Array.isArray(lastStateMessages) ? lastStateMessages.length : undefined,
          finalTextLen: typeof lastFinalText === "string" ? lastFinalText.length : undefined,
          graphEvents: v2State.graphEvents.length
        });

        // delta 切片：只取本轮新增的 graphEvents
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

    const finalText = lastFinalText;

    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "final",
      payload: { text: finalText }
    });
    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "status",
      payload: { status: "done" }
    });
  }

}
