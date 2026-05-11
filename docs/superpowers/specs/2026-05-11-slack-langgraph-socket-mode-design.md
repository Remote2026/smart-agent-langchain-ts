# Slack 与 LangGraph 双向交互设计

## 背景

当前项目是本地智能家居/ROS2 Agent：

- `src/index.ts` 提供 Express HTTP 服务、Web 静态页面和 SSE 推送。
- `src/agent/agent.ts` 中的 `SmartAgent` 负责调用 LangGraph。
- `src/agent/v2/graph.ts` 定义 StateGraph：`ingest -> router_intent -> configure_agent -> llm_call <-> tool_node -> respond`。
- `src/session.ts` 定义现有共享会话：`DEFAULT_SESSION_ID = "web-default-session"`。
- Web `/api/chat` 和设备事件 `/api/device-event` 当前都会进入 `SmartAgent`。

目标是在 Slack 中实现双向交互：

1. 用户在 Slack 给 Agent 发消息。
2. Slack adapter 将消息交给现有 LangGraph Agent。
3. Agent 处理完成后把最终结果回传到 Slack。
4. Slack、Web client、设备事件共用同一个 session id，使多个 client 共享同一段 Agent 记忆和上下文。
5. Web client 发起的请求可以可选同步到 Slack 默认频道，使 Slack 也能看到 Web 侧触发的关键交互结果。

## 设计原则

- Slack 是一个新的 transport/channel，不是新的 Agent。
- LangGraph 不直接依赖 Slack SDK。
- Slack、Web、设备事件统一使用 `DEFAULT_SESSION_ID`。
- 第一版优先支持本地开发和稳定交互，选择 Slack Socket Mode。
- Slack 只展示最终回复和错误，不展示 node/tool 过程，避免刷屏。
- Web SSE 继续展示详细执行过程，并能看到 Slack 触发的 Agent 事件。
- Web -> Slack 同步只发送用户原始消息、最终回复和错误，不同步 node/tool 过程。
- 使用事件来源 `channel` 和 Slack bot 消息过滤共同避免消息回环。

## 推荐方案

使用 `@slack/bolt` 的 Socket Mode 接入 Slack。

整体数据流：

```text
Slack User
  -> Slack Bolt App (Socket Mode)
  -> SlackTransport
  -> SmartAgent.handleUserMessage({
       sessionId: DEFAULT_SESSION_ID,
       message: { kind: "text", text },
       emit
     })
  -> LangGraph StateGraph
  -> emit(status/node/tool/final/error)
  -> SlackTransport
     -> final/error 回 Slack
     -> status/node/tool/final/error 广播给 Web SSE
```

Web 和设备事件保持现有入口：

```text
Web /api/chat
  -> SmartAgent.handleUserMessage({ sessionId: DEFAULT_SESSION_ID, ... })
  -> optional SlackMirror
     -> user message + final/error 发到 Slack 默认频道

POST /api/device-event
  -> SmartAgent.handleDeviceEvent({ sessionId: DEFAULT_SESSION_ID, ... })
```

## Scope

第一版实现：

1. 新增 Slack Socket Mode 启动逻辑。
2. 支持 Slack `app_mention`。
3. 支持 Slack DM `message.im`。
4. Slack/Web/设备事件全部使用 `DEFAULT_SESSION_ID`。
5. Slack 消息复用现有 `SmartAgent.handleUserMessage()`。
6. Slack 触发的所有 `ChatEventOut` 同步广播给 Web SSE。
7. Slack 中只发送 `final` 和 `error`。
8. 保留现有 Web SSE 协议。
9. 不把 `SlackToolkit` 暴露给 LangGraph tool list。
10. 可选支持 Web -> Slack mirror：Web 发起的用户消息、`final`、`error` 发送到 Slack 默认频道。

第一版不做：

1. 不按 Slack channel、thread、user 创建独立 session。
2. 不监听频道内所有普通消息。
3. 不把 Web 触发的 `status/node/tool` 过程事件同步到 Slack。
4. 不让 Agent 主动查询 Slack 频道、发日报、管理消息。
5. 不实现 Slack slash command。

## 新增模块

建议新增：

```text
src/slack/
  app.ts
  transport.ts
  notifier.ts
```

### `src/slack/app.ts`

职责：

- 创建并启动 Bolt `App`。
- 根据环境变量决定是否启用 Slack。
- 注册事件 handler：
  - `app_mention`
  - `message`，仅处理 DM。
- 将有效 Slack 事件转交给 `SlackTransport`。

对外暴露：

```ts
export function startSlackApp(options: {
  agent: SmartAgent;
  broadcastToWeb: (event: ChatEventOut) => void;
  notifier?: SlackNotifier;
}): Promise<void>;
```

### `src/slack/transport.ts`

职责：

- 从 Slack event 中提取用户文本。
- 过滤 bot 自己发出的消息，避免循环回复。
- 调用 `SmartAgent.handleUserMessage()`。
- 构造 `emit(event)`：
  - 所有事件先调用 `broadcastToWeb(event)`。
  - `final` 事件回 Slack thread。
  - `error` 事件回 Slack thread。
  - `status/node/tool` 不回 Slack。

Slack 回帖策略：

- 优先回复到原消息 thread：`thread_ts = event.thread_ts ?? event.ts`。
- DM 中也使用 thread reply，保持 Slack 侧上下文集中。
- 可以在开始时发一条简短的 `处理中...`，第一版可选；如果实现，最终回复可以作为 thread 新消息，不需要更新原消息。

### `src/slack/notifier.ts`

职责：

- 封装向 Slack 默认频道主动发消息的能力。
- 服务 Web -> Slack mirror，不处理 Slack inbound event。
- 只暴露明确的方法，不把 Slack client 传入 Agent。

建议接口：

```ts
export type SlackNotifier = {
  mirrorWebUserMessage(text: string): Promise<string | undefined>;
  mirrorWebFinal(text: string, threadTs?: string): Promise<void>;
  mirrorWebError(message: string, threadTs?: string): Promise<void>;
};
```

`mirrorWebUserMessage()` 返回 Slack 消息 `ts`，后续 `final/error` 优先回复到同一个 thread；如果发送用户消息失败，`final/error` 可以退化为直接发到默认频道，或只记录错误。

## 配置

扩展 `src/config.ts`：

```env
SLACK_ENABLED=false
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_MIRROR_WEB_MESSAGES=false
SLACK_DEFAULT_CHANNEL_ID=C...
```

配置 schema：

- `SLACK_ENABLED`：布尔值，默认 `false`。
- `SLACK_BOT_TOKEN`：启用 Slack 时必填。
- `SLACK_APP_TOKEN`：启用 Slack Socket Mode 时必填。
- `SLACK_SIGNING_SECRET`：启用 Slack 时必填。
- `SLACK_MIRROR_WEB_MESSAGES`：是否把 Web 发起的消息同步到 Slack，默认 `false`。
- `SLACK_DEFAULT_CHANNEL_ID`：Web -> Slack mirror 的目标频道；启用 mirror 时必填。

第一版固定使用 Socket Mode，不需要公网 HTTPS endpoint。

## Session 策略

统一使用：

```ts
DEFAULT_SESSION_ID
```

所有 Slack 消息进入 Agent 时都使用：

```ts
sessionId: DEFAULT_SESSION_ID
```

这意味着：

- Web、Slack、设备事件共享 LangGraph checkpoint。
- 所有 client 共享同一段 `messages` 历史。
- Slack thread 只影响 Slack 消息展示位置，不影响 Agent session。

风险：

- 多个用户同时在 Slack/Web 发送消息时，会写入同一个会话历史。
- 这是本设计的有意行为，因为目标是不区分独立对话 session。

第一版接受这个风险；后续如果出现并发混乱，再考虑对 `SmartAgent` 增加同一 session 的请求队列。

## Web SSE 同步

现有 `src/index.ts` 中有 `sseClients` 集合和局部 `emit` 函数。为复用 Slack 触发的事件广播，建议抽出一个小的广播函数：

```ts
function broadcastSse(event: ChatEventOut): void
```

职责：

- 遍历 `sseClients`。
- 写入 `event: ${event.type}` 和 `data: ...`。
- 失败时移除断开的 client。
- 调用 `logManager.append(event)`。

然后：

- `/api/device-event` 使用 `broadcastSse`。
- Slack transport 使用 `broadcastSse`。
- `/api/chat` 保持请求级 SSE response，同时可继续写日志。

## Web -> Slack Mirror

Web -> Slack mirror 是可选能力，由 `SLACK_MIRROR_WEB_MESSAGES=true` 开启。

数据流：

```text
Web /api/chat
  -> send "Web: <user text>" to SLACK_DEFAULT_CHANNEL_ID
  -> SmartAgent.handleUserMessage(...)
  -> on final: send "Agent: <final text>" to same Slack thread
  -> on error: send "处理失败：<message>" to same Slack thread
```

同步范围：

- 同步 Web 用户原始消息。
- 同步 Agent `final`。
- 同步 Agent `error`。
- 不同步 `status/node/tool`。

Slack 展示建议：

```text
Web: 打开客厅灯
Agent: 已打开客厅灯。
```

如果 Web 请求启动时发送 Slack 用户消息成功，记录返回的 `threadTs`，本轮 `final/error` 回复到该 thread。这个 `threadTs` 只用于 Slack 展示，不参与 LangGraph session。

## 防回环

防回环依赖两层保护。

第一层是应用层事件来源：

```ts
function maybeMirrorToSlack(event: ChatEventOut) {
  if (!config.env.SLACK_MIRROR_WEB_MESSAGES) return;
  if (event.channel !== "web") return;
  if (event.type !== "final" && event.type !== "error") return;
  slackNotifier.mirror(event);
}
```

规则：

- `channel === "web"` 的 `final/error` 才允许进入 Web -> Slack mirror。
- `channel === "slack"` 的事件只广播给 Web SSE 和回 Slack 原 thread，不进入 Web -> Slack mirror。
- 设备事件如果继续标记为 `channel: "web"`，第一版不自动 mirror 到 Slack；如果后续要同步设备事件，应新增独立配置，避免和 Web 手动请求混在一起。

第二层是 Slack inbound 过滤：

```ts
if (event.bot_id) return;
if (event.subtype) return;
```

Slack bot 自己发出的 mirror 消息即使被 Slack event 系统投递回来，也会因为 `bot_id` 或 `subtype` 被忽略，不会再次进入 Agent。

## 错误处理

Slack 事件处理要保证：

- 先 `ack()`，避免 Slack 重试。
- Agent 执行失败时：
  - 广播 Web SSE `error`。
  - Slack thread 回复一条中文错误消息。
- Slack API 发送失败时：
  - 记录日志。
  - 不影响 Agent checkpoint。
- Web -> Slack mirror 发送失败时：
  - 记录日志。
  - 不影响 Web SSE 响应。
  - 不影响 Agent 执行。

推荐 Slack 错误文案：

```text
处理失败：<error message>
```

## 安全与过滤

第一版需要过滤：

- `event.bot_id` 存在的消息。
- `event.subtype` 非空的非普通用户消息。
- 空文本。
- 非 DM 的普通 `message` 事件。

`app_mention` 文本中应移除 bot mention token，例如 `<@U123>`，再交给 Agent。

## 测试策略

类型和构建：

```bash
npm run typecheck
npm run build
```

手工测试：

1. 设置 Slack env。
2. 启动 `npm run dev`。
3. 在 Slack DM 发送一条普通聊天消息。
4. 在 Slack channel 中 `@agent` 发送智能家居/ROS2 请求。
5. 打开 Web UI，确认 Slack 触发的 node/tool/final 事件能显示。
6. Web UI 再发送一条消息，确认它能基于 Slack 刚才的上下文继续回答。
7. 开启 `SLACK_MIRROR_WEB_MESSAGES=true` 和 `SLACK_DEFAULT_CHANNEL_ID`。
8. Web UI 发送消息，确认 Slack 默认频道出现 Web 用户消息和 Agent final。
9. 确认 Slack 中由 bot 发出的 mirror 消息不会再次触发 Agent。

回归测试：

```bash
npm run test:chat
npm run test:device-event
```

## 后续扩展

可以在后续版本加入：

- 同一 shared session 的请求队列。
- 设备事件可选同步到 Slack。
- Slack slash command。
- SlackToolkit 作为 LangGraph tool，用于主动发通知、查频道、生成日报。
- Slack channel allowlist，限制可用频道。
