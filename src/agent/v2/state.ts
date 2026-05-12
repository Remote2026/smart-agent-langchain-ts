import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { GraphEvent } from "../../types.js";

export const InputMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1)
  }),
  z.object({
    kind: z.literal("image"),
    imageBase64: z.string().min(1),
    mimeType: z.string().min(1),
    text: z.string().optional()
  })
]);

export type InputMessage = z.infer<typeof InputMessageSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  // V2 text-only：强制要求 message 存在且为 text
  message: InputMessageSchema
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * AgentState：StateGraph 的共享状态（每个 node 读/写它）。
 *
 * 关键点：
 * - `graphEvents`：图执行过程中的“可观测性事件”，SSE 只转发增量
 * - `messages`：会话历史（多轮上下文）
 * - `toolResults`：结构化执行结果（respond 统一生成最终自然语言）
 */
export type AgentState = {
  sessionId: string;
  input: InputMessage;
  messages: BaseMessage[];
  /**
   * 归一化后的用户文本（用于 router_intent/respond）。
   * 本版仅文本：由 ingest 从 input.text 生成。
   */
  userText?: string;
  intent?: "smartthings" | "ros2" | "default";
  toolResults?: unknown;
  finalText?: string;
  graphEvents: GraphEvent[];
};

export const DeviceEventRequestSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  label: z.string().optional(),
  type: z.string().optional(),
  previousStatus: z.string().optional(),
  status: z.string().min(1).optional(),
});
export type DeviceEventRequest = z.infer<typeof DeviceEventRequestSchema>;
