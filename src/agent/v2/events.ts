import type { Channel, ChatEventOut, GraphEvent } from "../../types.js";

/**
 * V2 事件系统（GraphEvents -> SSE）
 *
 * 设计目标（对应设计文档）：
 * - Runtime（graph nodes / tools）只负责往 `state.graphEvents[]` 追加结构化事件
 * - SSE 层只负责“按增量把新事件推送给前端”
 * - 前端用 `node` 事件渲染 Graph Steps，用 `tool` 事件渲染 Tool Events
 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function nodeEvent(args: {
  node: string;
  phase: "start" | "end" | "error";
  summary: string;
  source?: "node" | "llm";
  origin?: { file: string; fn: string };
  data?: unknown;
}): GraphEvent {
  return {
    type: "node",
    node: args.node,
    phase: args.phase,
    summary: args.summary,
    source: args.source ?? "node",
    origin: args.origin,
    data: args.data,
    at: nowIso()
  };
}

export function toolEvent(args: {
  name: string;
  phase: "start" | "end" | "error";
  summary: string;
  source?: "tool" | "llm";
  origin?: { file: string; fn: string };
  data?: unknown;
}): GraphEvent {
  return {
    type: "tool",
    name: args.name,
    phase: args.phase,
    summary: args.summary,
    source: args.source ?? "tool",
    origin: args.origin,
    data: args.data,
    at: nowIso()
  };
}

/**
 * 把内部 GraphEvent 映射为对外 SSE 事件（ChatEventOut）。
 *
 * 注意：
 * - `node` -> 新增的 SSE channel，用于前端展示“图节点进度”
 * - `tool` -> 仍复用现有 SSE `tool` 事件形状，避免前端大改
 */
// channel 参数支持多 transport 的事件来源标记：Web → "web"，Slack → "slack"（默认 "web"）
export function graphEventToSse(sessionId: string, event: GraphEvent, channel: Channel = "web"): ChatEventOut {
  if (event.type === "node") {
    return {
      sessionId,
      channel,
      type: "node",
      payload: {
        node: event.node,
        phase: event.phase,
        summary: event.summary,
        source: event.source,
        origin: event.origin,
        data: event.data
      }
    };
  }

  if (event.phase === "start") {
    return {
      sessionId,
      channel,
      type: "tool",
      payload: { name: event.name, status: "executing", source: event.source, origin: event.origin, input: event.data }
    };
  }

  if (event.phase === "error") {
    return {
      sessionId,
      channel,
      type: "tool",
      payload: {
        name: event.name,
        status: "error",
        source: event.source,
        origin: event.origin,
        error: event.summary,
        output: event.data
      }
    };
  }

  return {
    sessionId,
    channel,
    type: "tool",
    payload: { name: event.name, status: "ok", source: event.source, origin: event.origin, output: event.data }
  };
}
