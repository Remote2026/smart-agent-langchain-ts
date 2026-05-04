import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { GraphEvent } from "../../types.js";

/**
 * V2 (Text-only): message schema
 * - 暂时只支持文本，后续需要图片再扩展为 discriminatedUnion。
 */
export const InputMessageSchema = z.object({
  kind: z.literal("text"),
  text: z.string().min(1)
});

export type InputMessage = z.infer<typeof InputMessageSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  // V2 text-only：强制要求 message 存在且为 text
  message: InputMessageSchema
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * V2State：StateGraph 的共享状态（每个 node 读/写它）。
 *
 * 关键点：
 * - `graphEvents`：图执行过程中的“可观测性事件”，SSE 只转发增量
 * - `messages`：会话历史（多轮上下文）
 * - `toolResults`：结构化执行结果（respond 统一生成最终自然语言）
 */
export type V2State = {
  sessionId: string;
  input: InputMessage;
  messages: BaseMessage[];
  /**
   * 归一化后的用户文本（用于 router_intent/respond）。
   * 本版仅文本：由 ingest 从 input.text 生成。
   */
  userText?: string;
  intent?: "smartthings" | "ros2" | "default";
  intentRationale?: string;
  /**
   * route_intent 的置信度（低置信度会强制兜底到 default）。
   * respond 会基于此做“自然澄清/追问最关键缺失信息”。
   */
  intentConfidence?: "low" | "medium" | "high";
  toolResults?: unknown;
  finalText?: string;
  graphEvents: GraphEvent[];
};
