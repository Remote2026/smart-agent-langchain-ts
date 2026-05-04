import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatEventOut, GraphEvent } from "../types.js";
import type { InputMessage } from "./v2/state.js";
import { graphEventToSse } from "./v2/events.js";
import { buildV2Graph } from "./v2/graph.js";

type EmitEvent = (event: ChatEventOut) => void;

type SessionState = {
  messages: BaseMessage[];
};

/**
 * V2：自定义 StateGraph（text-only, Plan A）
 * - ingest -> router_intent -> (smartthings|ros2|default) -> respond -> finalize
 * - 每个 node/tool 都产出 graphEvents，SSE 层只做“增量转发”
 */
function createSystemPrompt(skillInstructions: string): string {
  return `You are a local smart-home and ROS2 assistant.
You can have normal daily conversation, and you can control SmartThings and ROS2 through tools.
You can also use local skills when SKILL.md files are installed.

Rules:
- Use device aliases before controlling named devices.
- If a device alias is missing or ambiguous, list devices or ask the user to choose.
- Use skill_list and skill_read to inspect local SKILL.md instructions before applying a skill.
- Only run shell commands through skill_run_shell when a matching SKILL.md explicitly allows the command.
- Never invent device IDs, parameter values, or tool results.
- Keep final answers concise and in the same language as the user.
- Explain tool failures in readable language without exposing secrets.

Installed local skills:
${skillInstructions}`;
}

export class SmartAgent {
  //每个会话一份
  private readonly sessionStateMap = new Map<string, SessionState>();

  /**
   * LangGraph 编译后的可运行图（Runnable Graph）。
   * - invoke(): 一次性跑完图并返回最终状态
   * - stream(): 以“状态快照”的方式流式产出每一步的 state（便于做 SSE）
   */
  private readonly v2Graph: ReturnType<typeof buildV2Graph>;
  private readonly systemPrompt: string;

  constructor(options: {
    baseURL: string;
    apiKey: string;
    model: string;
    tools: StructuredToolInterface[];
    skillInstructions?: string;
  }) {
    const model = new ChatOpenAI({
      configuration: {
        baseURL: options.baseURL,
        apiKey: options.apiKey
      },
      model: options.model,
      temperature: 0.2
    });

    this.systemPrompt = createSystemPrompt(options.skillInstructions ?? "No local skills are installed.");
    console.log("SmartAgent initialized with system prompt:", this.systemPrompt);

    /**
     * V2：自定义 StateGraph（按设计文档拆成多个 node/edge）
     *
     * 数据流（高层）：
     * HTTP(SSE) -> SmartAgent.handleUserMessage -> v2Graph.stream(state)
     * - 每个 node 只往 state.graphEvents[] 追加事件（node/tool）
     * - 这里把 graphEvents 的“增量”映射成 SSE，推给前端
     */
    this.v2Graph = buildV2Graph({
      llm: model,
      tools: options.tools,
      systemPrompt: this.systemPrompt
    });
  }

  async handleUserMessage(input: { sessionId: string; message: InputMessage; emit: EmitEvent }): Promise<void> {
    const sessionState = this.getSessionState(input.sessionId);
    // Persist user message into session history for multi-turn context.
    sessionState.messages.push(new HumanMessage(input.message.text));

    // 数据流日志：HTTP -> SmartAgent -> Graph
    console.log(`[agent] session=${input.sessionId} recv`, input.message);
    // 1) 通知前端：进入思考/执行流程（SSE 事件）
    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "status",
      payload: { status: "thinking" }
    });

    /**
     * 2) graphEvents 增量推送
     * - v2Graph.stream 会不断产出“最新 state”
     * - state.graphEvents[] 是累积数组
     * - 我们只发新增的那段（delta），避免重复渲染
     */
    let lastSeenGraphEventCount = 0;

    /**
     * 2) LangGraph 流式执行：我们用 streamMode="values"，每次产出“最新的 state”。
     *
     * 对应知识点：
     * - LangGraph 的 state 里有一个 messages 数组（MessagesAnnotation）
     * - 每经历一次 “agent(LLM)” 或 “tools(工具执行)” 节点，messages 都会追加新消息
     * - 所以我们只要对 messages 做“增量 diff”，就能把过程映射成 SSE：
     *   - 看到 AIMessage.tool_calls => emit tool executing
     *   - 看到 ToolMessage => emit tool ok / error（取决于内容是否以 Tool failed 开头）
     */
    let lastStateMessages: BaseMessage[] | null = null;
    let lastFinalText = "";

    try {
      /**
       * V2 图的初始状态（本轮输入 + 会话历史 messages）
       * 注意：graphEvents 由 nodes 逐步追加。
       */
      const initialGraphState = {
        sessionId: input.sessionId,
        input: input.message,
        messages: sessionState.messages,
        graphEvents: []
      };

      console.log(`[agent] session=${input.sessionId} graph start`, {
        input: initialGraphState.input,
        messages: initialGraphState.messages.length
      });
      // 运行图，获取流式输出
      //invoke: 等待整个图执行完毕，然后一次性返回最终结果
      //stream: 以流式方式运行图，在图执行过程中逐步返回中间状态和结果
      const stream = await this.v2Graph.stream(
        { state: initialGraphState },
        { streamMode: "values", recursionLimit: 12 }
      );

      // 然后逐个处理流中的每个块（chunk），提取其中的 graphEvents，并把新增事件通过 SSE 发给前端。
      for await (const chunk of stream) {
        const v2State = (chunk as any)?.state as any;
        if (!v2State || !Array.isArray(v2State.graphEvents)) {
          continue;
        }

        lastStateMessages = Array.isArray(v2State.messages) ? (v2State.messages as BaseMessage[]) : lastStateMessages;
        lastFinalText = typeof v2State.finalText === "string" ? v2State.finalText : lastFinalText;

        // 关键数据流日志：每次 state 更新，打印 messages 数量与 finalText 是否已产出（避免刷屏打印全文）。
        console.log(`[agent] session=${input.sessionId} state`, {
          messages: Array.isArray(lastStateMessages) ? lastStateMessages.length : undefined,
          finalTextLen: typeof lastFinalText === "string" ? lastFinalText.length : undefined,
          graphEvents: v2State.graphEvents.length
        });


        // 只发新增事件：前端 Graph Steps / Tool Events 都靠这些事件更新
        const newEvents = v2State.graphEvents.slice(lastSeenGraphEventCount) as GraphEvent[];
        lastSeenGraphEventCount = v2State.graphEvents.length;
        for (const ev of newEvents) {
          input.emit(graphEventToSse(input.sessionId, ev));
        }
      }
    } catch (error) {
      // LangGraph 在工具报错、模型调用失败、或超过 recursionLimit 时，可能直接 throw
      const message = error instanceof Error ? error.message : String(error);
      input.emit({
        sessionId: input.sessionId,
        channel: "web",
        type: "error",
        payload: { message }
      });
      throw error;
    } finally {
      // 3) stream 结束后，我们把最终 messages 写回 session，保证多轮对话有记忆
      if (lastStateMessages) {
        sessionState.messages = lastStateMessages;
      }
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

  private getSessionState(sessionId: string): SessionState {
    const existing = this.sessionStateMap.get(sessionId);
    if (existing) {
      return existing;
    }

    const sessionState: SessionState = {
      /**
       * session.messages 只存“对话历史”（Human/AI/Tool）。
       * 系统提示词通过 LangGraph 的 prompt 参数注入，不进入 session。
       */
      messages: []
    };
    this.sessionStateMap.set(sessionId, sessionState);
    return sessionState;
  }
}
