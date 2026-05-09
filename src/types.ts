export type Channel = "web" | "slack";

/**
 * GraphEvent：V2 StateGraph 内部统一的事件格式。
 *
 * 数据流：
 * nodes/tools 追加 `state.graphEvents[]` -> SmartAgent 增量映射成 SSE -> Web UI 渲染
 */
export type GraphEvent =
  | {
    type: "node";
    node: string;
    phase: "start" | "end" | "error";
    summary: string;
    /**
     * 数据来源标记：
     * - node：普通图节点事件
     * - llm：该节点内部发生了 LLM 调用（可用于细分观察）
     */
    source?: "node" | "llm";
    /**
     * 事件产生位置（便于落盘日志定位代码路径）。
     * 注意：这里是“业务级位置”，不是 JS stack trace。
     */
    origin?: { file: string; fn: string };
    data?: unknown;
    at: string;
  }
  | {
    type: "tool";
    name: string;
    phase: "start" | "end" | "error";
    summary: string;
    /**
     * 数据来源标记：
     * - tool：外部工具调用（SmartThings/ROS2 等）
     * - llm：把 LLM 调用当作一种“可观测步骤”记录（不等同于外部工具）
     */
    source?: "tool" | "llm";
    origin?: { file: string; fn: string };
    data?: unknown;
    at: string;
  };

export type ChatEventOut =
  | {
    sessionId: string;
    channel: Channel;
    type: "status";
    payload: { status: "thinking" | "done" | "device_event_received" };
  }
  /**
   * V2：node 事件用于前端展示“Graph Steps”（每个图节点的进度）。
   */
  | {
    sessionId: string;
    channel: Channel;
    type: "tool";
    payload: {
      name: string;
      status: "executing" | "ok" | "error";
      source?: "tool" | "llm";
      origin?: { file: string; fn: string };
      input?: unknown;
      output?: unknown;
      error?: string;
    };
  }
  | {
    sessionId: string;
    channel: Channel;
    type: "node";
    payload: {
      node: string;
      phase: "start" | "end" | "error";
      summary: string;
      source?: "node" | "llm";
      origin?: { file: string; fn: string };
      data?: unknown;
    };
  }
  | {
    sessionId: string;
    channel: Channel;
    type: "final";
    payload: { text: string };
  }
  | {
    sessionId: string;
    channel: Channel;
    type: "error";
    payload: { message: string };
  };
