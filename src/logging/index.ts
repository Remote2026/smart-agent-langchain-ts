import path from "node:path";
import type { ChatEventOut } from "../types.js";
import { SessionLogWriter } from "./session-log-writer.js";

/**
 * LogManager：管理每个 sessionId 对应的落盘 writer。
 *
 * 为什么要做 manager：
 * - 同一会话会产生很多 SSE 事件，避免每次都重复创建 writer
 * - 统一管理 baseDir/date，方便未来扩展（比如最大打开文件数、LRU 淘汰等）
 */
export class LogManager {
  private readonly writers = new Map<string, SessionLogWriter>();

  constructor(
    private readonly options: {
      baseDir: string;
      now?: () => Date;
    }
  ) {}

  append(event: ChatEventOut): void {
    const writer = this.getWriter(event.sessionId);
    writer.append(event);
  }

  private getWriter(sessionId: string): SessionLogWriter {
    const existing = this.writers.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = this.options.now ? this.options.now() : new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const writer = new SessionLogWriter(sessionId, path.resolve(this.options.baseDir), date);
    this.writers.set(sessionId, writer);
    return writer;
  }
}

