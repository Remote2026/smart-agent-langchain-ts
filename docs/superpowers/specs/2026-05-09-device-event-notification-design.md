# Smart Agent — 设备事件通知通道设计

Date: 2026-05-09

## 1. 背景与目标

SmartThings CLI 轮询脚本检测到设备状态变化后，通过 API 通知 Agent，Agent 处理后推送到 Web UI，并为 Slack 和 tool 动作预留扩展点。

## 2. 数据流

```
SmartThings CLI 轮询 (独立进程)
  → POST /api/device-event
    → inject_device_event 节点
      → prepare_agent(configure_agent) → llm_call ⇄ tool_node → respond
        → SSE 推 Web UI
        → Slack 占位 (TODO)
        → Tool 动作 占位 (TODO)
```

## 3. 图结构变更

新增 `inject_device_event` 节点，与 `ingest` 并列作为入口：

```
                ┌─ chat / slack ─→ ingest → router_intent ─┐
START ─(eventType)─┤                                         ├→ prepare_agent → llm_call ⇄ tool_node → respond → END
                └─ device_event ─→ inject_device_event ─────┘
```

START 改用条件边，根据 `eventType` 分流：
- `"chat"` → `ingest → router_intent → prepare_agent`
- `"device_event"` → `inject_device_event → prepare_agent`

Slack 消息复用 `ingest`（本质是用户文本，需路由意图）。

## 4. 状态模型变更

新增字段：
- `eventType: "chat" | "device_event"` — 入口分流标识，默认 `"chat"`

保留字段：
- `deviceEvent` 不单独存储，事件信息直接注入 `messages` 为 HumanMessage。

## 5. 新增 API

### POST /api/device-event

Request:
```json
{
  "deviceId": "abc-123",
  "deviceName": "门磁传感器",
  "capability": "contact",
  "previousValue": "open",
  "currentValue": "closed",
  "timestamp": "2026-05-09T12:00:00+08:00"
}
```

Response 200:
```json
{ "ok": true }
```

处理流程：
1. 校验必填字段
2. 构造 `HumanMessage("设备事件：门磁传感器(abc-123) contact 从 open 变为 closed")`
3. 调用 `v2Graph.stream()` 流式执行图
4. 通过全局 SSE 客户端集合广播增量事件到所有已连接 Web UI

### SSE 广播机制

`src/index.ts` 维护全局 SSE 客户端集合：
```typescript
const sseClients = new Set<Response>();
// /api/chat 连接时 sseClients.add(res)
// 连接断开时 sseClients.delete(res)
// POST /api/device-event 时遍历 sseClients 广播
```

设备事件的 emit 广播到所有客户端，确保所有打开的 Web UI 都能看到通知。

## 6. 节点职责

### 6.1 inject_device_event（新增）

- 从 input 提取设备事件字段
- 构造 HumanMessage 描述事件
- 设置 `intent = "smartthings"`（跳过 router）
- 设置 `userText` 为事件描述文本
- 发送 node:start/end 事件

### 6.2 ingest（不变）

- 现有逻辑不变
- `eventType` 为 `"device_event"` 时不经过此节点

## 7. respond 节点扩展

respond 节点末尾预留两个占位：

```typescript
// TODO: Slack App 集成 — 将 finalText 推送到 Slack
// TODO: Tool 自动动作 — 根据设备事件触发预定义 tool（如报警、联动）
```

## 8. 轮询脚本集成

修改 `scripts/smartthigns-cli-reference.ts`，检测到 contact 变化时：

```typescript
// 替换现有的 ///占位 注释
await fetch("http://localhost:3000/api/device-event", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    deviceId, deviceName: deviceLabel,
    capability: "contact",
    previousValue: prevContact,
    currentValue: currentContact,
    timestamp: new Date().toISOString()
  })
});
```

## 9. Web UI

前端监听现有 SSE `node`/`tool`/`final` 事件即可，无需新增事件类型。设备事件触发图执行后，前端自然看到 Graph Steps 推进和最终回复文本。

## 10. Done Criteria

- POST /api/device-event 接收设备事件并返回 200
- 事件通过 inject_device_event 进入图，走完完整流程
- Web UI 通过现有 SSE 展示事件通知
- respond 节点含 Slack 和 Tool 动作的 TODO 占位
- 轮询脚本在检测到变化时调用 API
