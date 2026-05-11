# 多模态图片输入设计

Date: 2026-05-11

## 1. 背景与目标

当前项目是 text-only：`InputMessage` 只接受 `kind: "text"`，`SmartAgent` 构造纯文本 `HumanMessage`，`/api/chat` 拒绝非文本消息，模型使用 `qwen-turbo`（不支持视觉）。

目标：Web 客户端和 Slack 用户都可以发送图片给 Agent，Agent 理解图片内容并推理（例如：植物照片叶子发黄 → 推理需要浇水）。

核心原则：
- 图片 + 文字走同一条 Agent 路径，不新建独立管线
- `HumanMessage` 原生支持多模态 content 数组，不脏 `messages` channel
- Web 和 Slack 统一使用 `kind: "image"` 的 `InputMessage` schema

## 2. 数据流

```
Web 用户选图片
  → FileReader 转 base64
  → POST /api/chat { message: { kind: "image", imageBase64, mimeType, text? } }
  → SmartAgent.handleUserMessage()
  → HumanMessage({ content: [{type:"text"}, {type:"image_url", image_url:{url:"data:..."}}] })
  → LangGraph StateGraph (checkpoint 持久化)

Slack 用户发图片
  → Bolt file_share event (subtype=file_share, event.files)
  → download via Slack API (url_private + token)
  → SlackTransport 构造 kind:"image" InputMessage
  → SmartAgent.handleUserMessage()
  → 同上路径

先发图再发文字:
  → 第1轮: HumanMessage([image]) → LLM 分析 → 存入 checkpoint
  → 第2轮: HumanMessage([text]) → checkpoint 恢复 messages(含第1轮图片)
  → LLM 结合上下文推理
```

## 3. Schema 与类型变更

### `src/agent/v2/state.ts`

`InputMessage` 从单一 `kind: "text"` 扩展为 discriminated union：

```ts
export const InputMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1)
  }),
  z.object({
    kind: z.literal("image"),
    imageBase64: z.string().min(1),      // 纯 base64，不含 data:前缀
    mimeType: z.string().min(1),         // "image/jpeg" | "image/png" | "image/webp"
    text: z.string().optional()          // 可选伴随文字
  })
]);
```

请求体示例：

```json
// 纯图片
{ "message": { "kind": "image", "imageBase64": "iVBORw0...", "mimeType": "image/jpeg" } }

// 图片 + 文字
{ "message": { "kind": "image", "imageBase64": "iVBORw0...", "mimeType": "image/jpeg", "text": "叶子发黄怎么办？" } }

// 纯文字（保持不变）
{ "message": { "kind": "text", "text": "打开客厅灯" } }
```

### `src/types.ts`

`ChatEventOut` 无需变更。图片信息在 `InputMessage` 和 `HumanMessage` 层面处理，`final` 事件只存文本回复。

## 4. Agent 层变更 (`src/agent/agent.ts`)

`handleUserMessage` 中构造 `HumanMessage` 的逻辑按 `kind` 分支：

```ts
function buildHumanMessage(msg: InputMessage): HumanMessage {
  if (msg.kind === "text") {
    return new HumanMessage(msg.text);
  }
  // kind: "image"
  const parts: Array<TextBlock | ImageURLBlock> = [];
  if (msg.text) {
    parts.push({ type: "text", text: msg.text });
  }
  parts.push({
    type: "image_url",
    image_url: { url: `data:${msg.mimeType};base64,${msg.imageBase64}` }
  });
  return new HumanMessage({ content: parts });
}
```

`handleDeviceEvent` 不变（设备事件始终是 text）。

### graph.ts ingestNode 适配

`ingestNode` 当前直接读 `state.input.text`，但 discriminated union 下 `kind === "image"` 时不存在该字段。改为取文本的通用方式：

```ts
// 替换 state.input.text.trim()
const userText = state.input.kind === "text"
  ? state.input.text.trim()
  : (state.input.text ?? "").trim();
```

- `kind === "image"` + 无文字 → `userText = ""` → `router_intent` 现有逻辑直接设为 `intent=default`，跳过路由
- `kind === "image"` + 有文字 → `userText` 取伴随文字，正常走路由

## 5. 模型配置

`qwen-turbo` 不支持视觉，必须换为：

- 默认模型改为 `qwen-vl-plus`（DashScope 视觉模型，支持文本 + 图片，性价比最高）
- 用户可通过 `OPENAI_MODEL` 环境变量覆盖为 `qwen-vl-max`（更强推理）或其他兼容模型

`src/config.ts` 默认值变更：

```ts
OPENAI_MODEL: z.string().min(1).default("qwen-vl-plus")
```

## 6. Express 路由层变更 (`src/index.ts`)

### 请求体限制

```ts
// 当前: 1mb 纯文本足够，但图片 base64 需要更大
app.use(express.json({ limit: "10mb" }));
```

### 去掉 text-only 守卫

删除 `/api/chat` 中 `message.kind !== "text"` 的错误分支，`ChatRequestSchema.safeParse` 已校验 schema。

### Slack mirror 适配

`mirrorWebUserMessage` 当前直接使用 `message.text`，需要适配 image 类型：

```ts
function webMessageSlackText(msg: InputMessage): string {
  if (msg.kind === "text") return `Web: ${msg.text}`;
  return msg.text
    ? `Web: [图片] ${msg.text}`
    : `Web: [图片]`;
}
```

## 7. Slack Transport 变更 (`src/slack/transport.ts`)

### file_share 事件处理

当前 `handleDirectMessage` 过滤所有 `subtype`（包括 `file_share`）。需要放开：

```ts
// handleDirectMessage — 检查 files 字段
if (event.files?.length > 0 && event.subtype === "file_share") {
  const file = event.files[0];
  // 1. 通过 url_private 下载文件（需 Authorization: Bearer xoxb-...）
  const buffer = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  }).then(r => r.arrayBuffer());
  // 2. 转为 base64
  const base64 = Buffer.from(buffer).toString("base64");
  // 3. 构造 InputMessage
  const inputMsg: InputMessage = {
    kind: "image",
    imageBase64: base64,
    mimeType: file.mimetype,
    text: event.text?.trim() || undefined
  };
}
```

`handleAppMention` 同理，保留 `bot_id` 过滤但放开 `file_share`。

### 文件大小限制

Slack 免费版文件上限 5MB，工作区版更高。不加额外的 bot 侧限制，由 Slack 平台自身约束即可。

### 新增 Slack Bot Token Scope

| Scope | 用途 |
|-------|------|
| `files:read` | 允许 bot 下载 Slack 消息中分享的文件（图片） |

用户需在 Slack App Dashboard → OAuth & Permissions 中添加并重新安装 App。

## 8. Web UI 变更 (`public/index.html` + `public/app.js`)

### 布局

在文本输入框左侧放 file icon 按钮，不独占一行：

```html
<form id="composer" class="composer">
  <div class="composer-row">
    <label class="image-picker" title="添加图片">
      <input type="file" id="imageInput" accept="image/*" hidden />
      <svg><!-- file-image 图标 --></svg>
    </label>
    <textarea id="messageInput" ...></textarea>
    <button id="sendButton" type="submit">发送</button>
  </div>
  <div id="imagePreview" class="image-preview" hidden>
    <img id="previewThumb" />
    <button id="removeImage" type="button">×</button>
  </div>
</form>
```

### 交互

- 点 file icon → 弹出文件选择器 → 选中后显示缩略预览
- 点击缩略图上的 × → 取消选择
- 可同时输入文字（可选），按 Enter 或点发送 → FileReader 转 base64 → 构造 `kind: "image"` 消息 → POST
- 没有图片时，行为和现在完全一样（`kind: "text"`）
- 粘贴图片（Ctrl+V）也触发图片选择

### 发送逻辑

```js
const file = imageInput.files[0];
const text = inputEl.value.trim();

if (file) {
  const base64 = await toBase64(file);
  const body = {
    sessionId,
    message: {
      kind: "image",
      imageBase64: base64,
      mimeType: file.type || "image/jpeg",
      ...(text ? { text } : {})
    }
  };
  // POST /api/chat
} else if (text) {
  // 现有纯文本逻辑
}
```

## 9. 测试策略

### 自动化测试

- `src/agent/v2/state.test.ts`：校验 `InputMessageSchema` 对 text/image/无效消息的 parse 行为
- `src/agent/agent.test.ts`：验证 `buildHumanMessage` 按 kind 分支生成正确的 `HumanMessage` content 结构

### 回归测试

```bash
npm run typecheck
npm run build
npm test                  # 现有 29 个测试必须全部通过
npm run test:chat         # 纯文本 chat 不受影响
npm run test:device-event # 设备事件不受影响
```

### 手工测试

1. Web UI 选一张植物图片（不输入文字）→ 发送 → 确认 Agent 返回图片分析结果
2. Web UI 选图片 + 输入"叶子发黄了怎么办" → 确认 Agent 结合图片和文字推理
3. Web UI 纯文字"打开客厅灯" → 确认回归正常
4. Slack DM 发图片 → 确认 bot 回复分析结果
5. Slack channel @mention bot + 图片 → 确认回复在 thread 中
6. 先发图片，再发文字 → 确认 Agent 结合上下文
7. `npm test` 全绿

## 10. Done Criteria

- `InputMessageSchema` 接受 `kind: "text"` 和 `kind: "image"`
- `SmartAgent` 将 image 消息转为多模态 `HumanMessage`
- Web `/api/chat` 接受图片消息并返回分析结果
- Slack `file_share` 事件被处理并交给 Agent
- Web UI 有图片选择入口（file icon），不独占一行
- 先图后文时，Agent 能结合上下文推理
- 纯文本功能不受影响（回归）
- 现有 29 个测试全部通过
