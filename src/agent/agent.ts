import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatEventOut } from "../types.js";

type EmitEvent = (event: ChatEventOut) => void;

type SessionState = {
  messages: BaseMessage[];
};

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
  private readonly sessions = new Map<string, SessionState>();
  private readonly modelWithTools: ReturnType<ChatOpenAI["bindTools"]>;
  private readonly toolsByName: Map<string, StructuredToolInterface>;
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

    this.modelWithTools = model.bindTools(options.tools);
    this.toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.systemPrompt = createSystemPrompt(options.skillInstructions ?? "No local skills are installed.");
  }

  async handleUserMessage(input: {
    sessionId: string;
    text: string;
    emit: EmitEvent;
  }): Promise<void> {
    const state = this.getSession(input.sessionId);
    state.messages.push(new HumanMessage(input.text));

    input.emit({
      sessionId: input.sessionId,
      channel: "web",
      type: "status",
      payload: { status: "thinking" }
    });

    for (let step = 0; step < 8; step++) {
      const response = await this.modelWithTools.invoke(state.messages);
      state.messages.push(response);

      if (!response.tool_calls?.length) {
        const finalText = this.messageText(response.content);
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
        return;
      }

      for (const toolCall of response.tool_calls) {
        const tool = this.toolsByName.get(toolCall.name);
        if (!tool) {
          const message = `Unknown tool requested: ${toolCall.name}`;
          state.messages.push(
            new ToolMessage({
              tool_call_id: toolCall.id ?? toolCall.name,
              name: toolCall.name,
              content: message
            })
          );
          continue;
        }

        input.emit({
          sessionId: input.sessionId,
          channel: "web",
          type: "tool",
          payload: {
            name: toolCall.name,
            status: "executing",
            input: toolCall.args
          }
        });

        try {
          const output = await tool.invoke(toolCall.args);
          state.messages.push(
            new ToolMessage({
              tool_call_id: toolCall.id ?? toolCall.name,
              name: toolCall.name,
              content: String(output)
            })
          );
          input.emit({
            sessionId: input.sessionId,
            channel: "web",
            type: "tool",
            payload: {
              name: toolCall.name,
              status: "ok",
              output: parseToolOutput(output)
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.messages.push(
            new ToolMessage({
              tool_call_id: toolCall.id ?? toolCall.name,
              name: toolCall.name,
              content: `Tool failed: ${message}`
            })
          );
          input.emit({
            sessionId: input.sessionId,
            channel: "web",
            type: "tool",
            payload: {
              name: toolCall.name,
              status: "error",
              error: message
            }
          });
        }
      }
    }

    throw new Error("Agent reached the maximum tool-call loop limit.");
  }

  private getSession(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: SessionState = {
      messages: [new SystemMessage(this.systemPrompt)]
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private messageText(content: AIMessage["content"]): string {
    if (typeof content === "string") {
      return content;
    }

    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if ("text" in part && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("")
      .trim();
  }
}

function parseToolOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    return output;
  }

  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}
