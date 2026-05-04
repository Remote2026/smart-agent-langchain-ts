# Logging（落盘事件日志）

本项目有两套“可观测性输出”：

1) **实时 UI（SSE）**：浏览器侧看到 `Graph Steps`（node）与 `Tool Events`（tool）
2) **落盘日志（单文件 JSONL）**：把同样的 SSE 事件写入文件，便于回放与排障

## 写入位置

启动服务后，日志写入：

- `logs/YYYY-MM-DD/<sessionId>.jsonl`

`YYYY-MM-DD` 以服务器本地时间生成。

## JSONL 格式

每行一个 JSON：

```json
{"at":"...","sessionId":"...","type":"node|tool|status|final|error","summary":"...","prettyPayload":"...","payload":{...}}
```

其中：
- `payload`：完整结构化事件（与 SSE 一致）
- `summary`：人类可读摘要（方便快速扫一眼发生了什么）
- `prettyPayload`：把 `payload` 做了缩进格式化并截断后的字符串（方便人眼阅读）

## 代码入口

日志写入发生在 SSE emit 的同一位置（单一事实源）：

- `src/index.ts`：`emit(event)` 中调用 `logManager.append(event)`
- `src/logging/index.ts`：按 `sessionId` 复用 writer
- `src/logging/session-log-writer.ts`：写入 JSONL（单文件），并生成 `summary`
