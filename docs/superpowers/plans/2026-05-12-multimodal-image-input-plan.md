# 多模态图片输入 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** Web 客户端和 Slack 用户都能发送图片给 Agent，Agent 结合图片进行视觉推理。

**架构:** `InputMessage` 扩展为 `kind: "text" | "image"` discriminated union。各 Transport 层（Web/Slack/未来入口）负责将原始输入转为 `InputMessage`，Agent 层不感知来源。`kind: "image"` 时 Agent 构造多模态 `HumanMessage`（content 数组合并 text + image_url），存入 StateGraph checkpoint。

**技术栈:** LangChain HumanMessage (multimodal content), zod discriminatedUnion, qwen-vl-plus, Slack files:read scope

**前置条件:**
- Task 6 前：Slack App Dashboard → OAuth & Permissions → 添加 `files:read` scope → 重新安装 App

**改动文件 (8 modify + 2 create):**

| 文件 | 改动 |
|------|------|
| `src/agent/v2/state.ts` | InputMessage discriminator union (text + image) |
| `src/config.ts` | OPENAI_MODEL 默认值 → qwen-vl-plus |
| `src/agent/agent.ts` | buildHumanMessage 多模态分支 |
| `src/agent/v2/graph.ts` | ingestNode userText 提取适配 |
| `src/index.ts` | 10MB 限制、去掉 text-only 守卫、mirror 适配 |
| `src/slack/transport.ts` | file_share 事件处理 |
| `public/index.html` | 图片选择器 UI |
| `public/app.js` | 图片 base64 编码 + 发送逻辑 |
| `src/agent/v2/state.test.ts` (NEW) | InputMessageSchema parse 测试 |
| `src/agent/agent.test.ts` (NEW) | buildHumanMessage 单元测试 |

---

### Task 1: InputMessage Schema 扩展 + 单元测试

**文件:**
- 修改: `src/agent/v2/state.ts:9-13`
- 创建: `src/agent/v2/state.test.ts`

- [ ] **Step 1: 扩展 InputMessageSchema**

将 `src/agent/v2/state.ts` 中的 InputMessageSchema 从单一 `z.literal("text")` 改为 discriminated union：

```ts
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
```

同时更新 `InputMessage` 类型导出（zod infer 自动推导，无需手动改 type）。

- [ ] **Step 2: 编写 state.test.ts**

创建 `src/agent/v2/state.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { InputMessageSchema } from "./state.js";

describe("InputMessageSchema", () => {
  it("解析纯文本消息", () => {
    const result = InputMessageSchema.safeParse({ kind: "text", text: "打开客厅灯" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("text");
      expect(result.data.text).toBe("打开客厅灯");
    }
  });

  it("拒绝空文本消息", () => {
    const result = InputMessageSchema.safeParse({ kind: "text", text: "" });
    expect(result.success).toBe(false);
  });

  it("解析纯图片消息（无文字）", () => {
    const result = InputMessageSchema.safeParse({
      kind: "image",
      imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      mimeType: "image/png"
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "image") {
      expect(result.data.imageBase64).toBeTruthy();
      expect(result.data.mimeType).toBe("image/png");
      expect(result.data.text).toBeUndefined();
    }
  });

  it("解析图片 + 文字消息", () => {
    const result = InputMessageSchema.safeParse({
      kind: "image",
      imageBase64: "iVBORw0KGgo=",
      mimeType: "image/jpeg",
      text: "叶子发黄了怎么办？"
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "image") {
      expect(result.data.text).toBe("叶子发黄了怎么办？");
    }
  });

  it("拒绝 base64 为空的图片消息", () => {
    const result = InputMessageSchema.safeParse({
      kind: "image",
      imageBase64: "",
      mimeType: "image/jpeg"
    });
    expect(result.success).toBe(false);
  });

  it("拒绝 mimeType 为空的图片消息", () => {
    const result = InputMessageSchema.safeParse({
      kind: "image",
      imageBase64: "aGVsbG8=",
      mimeType: ""
    });
    expect(result.success).toBe(false);
  });

  it("拒绝没有 kind 字段的消息", () => {
    const result = InputMessageSchema.safeParse({ text: "hello" });
    expect(result.success).toBe(false);
  });

  it("拒绝未知 kind 的消息", () => {
    const result = InputMessageSchema.safeParse({ kind: "video", url: "http://..." });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试验证**

```bash
npm run pretest && npx vitest run src/agent/v2/state.test.ts
```

预期: 8 个测试全部通过。

- [ ] **Step 4: 运行全量回归测试**

```bash
npm test
```

预期: 现有 29 个测试 + 新增 8 个 = 37 个全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/agent/v2/state.ts src/agent/v2/state.test.ts
git commit -m "$(cat <<'EOF'
feat: expand InputMessageSchema to support image kind

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 模型配置变更

**文件:**
- 修改: `src/config.ts:9`

- [ ] **Step 1: 修改默认模型**

```ts
// 第 9 行，将默认值从 "qwen-turbo" 改为 "qwen-vl-plus"
OPENAI_MODEL: z.string().min(1).default("qwen-vl-plus"),
```

- [ ] **Step 2: 验证 typecheck**

```bash
npm run typecheck
```

预期: 零错误。

- [ ] **Step 3: 确认构建**

```bash
npm run build
```

- [ ] **Step 4: 提交**

```bash
git add src/config.ts
git commit -m "$(cat <<'EOF'
feat: switch default model to qwen-vl-plus for vision support

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: graph.ts ingestNode 适配

**文件:**
- 修改: `src/agent/v2/graph.ts:76-101`（ingestNode 函数体）

- [ ] **Step 1: 修改 ingestNode 的 userText 提取逻辑**

`ingestNode` 当前第 82 行直接读 `state.input.text`。改为：

```ts
async function ingestNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const events: GraphEvent[] = [];
  addEvent(events, nodeEvent({ node: "ingest", phase: "start", summary: "validating text input" }));

  // discriminated union: kind="text" vs kind="image"
  const userText = state.input.kind === "text"
    ? state.input.text.trim()
    : (state.input.text ?? "").trim();

  if (!userText) {
    return {
      userText: "",
      intent: "default",
      toolResults: undefined,
      finalText: undefined,
      graphEvents: [...state.graphEvents, ...events]
    };
  }

  addEvent(events, nodeEvent({ node: "ingest", phase: "end", summary: `ok len=${userText.length}` }));
  return {
    userText,
    intent: undefined,
    toolResults: undefined,
    finalText: undefined,
    graphEvents: [...state.graphEvents, ...events]
  };
}
```

- [ ] **Step 2: 运行全量测试确认回归**

```bash
npm test
```

预期: 全部 37 个测试通过（ingestNode 适配对现有纯文本行为无影响）。

- [ ] **Step 3: 运行 typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/agent/v2/graph.ts
git commit -m "$(cat <<'EOF'
fix: adapt ingestNode for discriminated union InputMessage

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Agent 层多模态 HumanMessage + 单元测试

**文件:**
- 修改: `src/agent/agent.ts`
- 创建: `src/agent/agent.test.ts`

- [ ] **Step 1: 在 agent.ts 中抽取 buildHumanMessage 函数**

在 `SmartAgent` 类外部定义纯函数（便于单独测试）：

```ts
import { HumanMessage } from "@langchain/core/messages";
import type { InputMessage } from "./v2/state.js";

function buildHumanMessage(msg: InputMessage): HumanMessage {
  if (msg.kind === "text") {
    return new HumanMessage(msg.text);
  }
  // kind: "image" — 构造多模态 content 数组
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
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

- [ ] **Step 2: 修改 handleUserMessage 中的 HumanMessage 构造**

将 `handleUserMessage` 第 92 行：

```ts
// 原文
messages: [new HumanMessage(input.message.text)],

// 改为
messages: [buildHumanMessage(input.message)],
```

- [ ] **Step 3: 编写 agent.test.ts**

创建 `src/agent/agent.test.ts`（测试 `buildHumanMessage` 纯函数，不需要 mock Agent）：

```ts
import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";

// 直接复制 buildHumanMessage 在此测试，或从 agent.ts import
// 注意：如果 SmartAgent 构造函数需要 ChatOpenAI/SqliteSaver 等依赖，
// 我们将 buildHumanMessage 导出为独立函数以便测试

describe("buildHumanMessage", () => {
  it("纯文本消息 → HumanMessage 字符串 content", () => {
    const msg = buildHumanMessage({ kind: "text", text: "打开客厅灯" });
    expect(msg).toBeInstanceOf(HumanMessage);
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toBe("打开客厅灯");
  });

  it("纯图片消息 → HumanMessage 多模态 content 数组（只有 image_url）", () => {
    const msg = buildHumanMessage({
      kind: "image",
      imageBase64: "aGVsbG8=",
      mimeType: "image/png"
    });
    expect(msg).toBeInstanceOf(HumanMessage);
    expect(Array.isArray(msg.content)).toBe(true);
    if (Array.isArray(msg.content)) {
      expect(msg.content.length).toBe(1);
      expect(msg.content[0]).toMatchObject({
        type: "image_url",
        image_url: { url: "data:image/png;base64,aGVsbG8=" }
      });
    }
  });

  it("图片 + 文字 → 多模态 content 数组（text 在前，image_url 在后）", () => {
    const msg = buildHumanMessage({
      kind: "image",
      imageBase64: "aGVsbG8=",
      mimeType: "image/jpeg",
      text: "这是什么植物？"
    });
    expect(Array.isArray(msg.content)).toBe(true);
    if (Array.isArray(msg.content)) {
      expect(msg.content.length).toBe(2);
      expect(msg.content[0]).toEqual({ type: "text", text: "这是什么植物？" });
      expect(msg.content[1]).toMatchObject({
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,aGVsbG8=" }
      });
    }
  });

  it("image_url 的 data URI 格式正确", () => {
    const msg = buildHumanMessage({
      kind: "image",
      imageBase64: "Zm9vYmFy",
      mimeType: "image/webp"
    });
    if (Array.isArray(msg.content)) {
      const imageBlock = msg.content[0] as { type: string; image_url: { url: string } };
      expect(imageBlock.image_url.url).toBe("data:image/webp;base64,Zm9vYmFy");
    }
  });
});
```

注意：需要在 `src/agent/agent.ts` 中将 `buildHumanMessage` 加上 `export` 关键字，以便测试文件导入。

- [ ] **Step 4: 运行 agent 测试**

```bash
npm run pretest && npx vitest run src/agent/agent.test.ts
```

预期: 4 个测试全部通过。

- [ ] **Step 5: 运行全量回归**

```bash
npm test
```

预期: 全部 41 个测试通过。

- [ ] **Step 6: typecheck**

```bash
npm run typecheck
```

- [ ] **Step 7: 提交**

```bash
git add src/agent/agent.ts src/agent/agent.test.ts
git commit -m "$(cat <<'EOF'
feat: add multimodal HumanMessage support via buildHumanMessage

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Express 路由层变更

**文件:**
- 修改: `src/index.ts`

- [ ] **Step 1: 扩大请求体限制 (第 49 行)**

```ts
// 原文
app.use(express.json({ limit: "1mb" }));
// 改为
app.use(express.json({ limit: "10mb" }));
```

- [ ] **Step 2: 去掉 text-only 守卫 (删除第 172-181 行)**

删除以下代码块：

```ts
if (message.kind !== "text") {
  emit({
    sessionId,
    channel: "web",
    type: "error",
    payload: { message: "Only text messages are supported for now." }
  });
  response.end();
  return;
}
```

- [ ] **Step 3: Slack mirror 适配 image 消息文案**

当 `/api/chat` 发送用户消息到 Slack mirror 时，`message.kind === "image"` 时 `message.text` 不存在（可选字段）。需要补一个辅助函数（放在 `maybeMirrorToSlack` 附近）：

```ts
function webMessageSlackText(msg: typeof message): string {
  if (msg.kind === "text") return `Web: ${msg.text}`;
  return msg.text
    ? `Web: [图片] ${msg.text}`
    : `Web: [图片]`;
}
```

然后将第 185 行的 `mirrorWebUserMessage(message.text)` 改为 `mirrorWebUserMessage(webMessageSlackText(message))`。

同理，`/api/device-event` 的 mirror 逻辑保持不变（设备事件始终 text）。

- [ ] **Step 4: typecheck**

```bash
npm run typecheck
```

预期: 零错误（`InputMessage.kind === "image"` 时 TS 知道 `text` 是 `string | undefined`，需要确保所有访问 `message.text` 的地方都有正确处理）。

- [ ] **Step 5: 运行测试脚本**

```bash
npm run test:chat
npm run test:device-event
```

预期: 两个脚本正常返回（chat 验证纯文本路径，device-event 验证设备事件路径）。

- [ ] **Step 6: 运行全量测试**

```bash
npm test
```

- [ ] **Step 7: 提交**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: accept image messages in /api/chat, increase body limit to 10mb

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Slack Transport file_share 处理

**文件:**
- 修改: `src/slack/transport.ts`

- [ ] **Step 1: 修改 handleDirectMessage 支持 file_share subtype**

当前 `handleDirectMessage` 在第 54 行过滤所有 `subtype`：

```ts
if (event.subtype) { console.log("[slack:transport] skipped: subtype"); return; }
```

改为只过滤 `bot_message` 和 `message_changed`（非 file_share）：

```ts
// file_share 是唯一放行的 subtype（携带图片）
if (event.subtype && event.subtype !== "file_share") {
  console.log("[slack:transport] skipped: subtype=", event.subtype);
  return;
}
```

- [ ] **Step 2: 添加 file_share → InputMessage 转换逻辑**

在 `handleDirectMessage` 中，如果 `event.subtype === "file_share"` 且有 files：

```ts
if (event.subtype === "file_share" && (event as any).files?.length > 0) {
  const file = (event as any).files[0];
  const mimeType = file.mimetype || "image/jpeg";
  // 只处理图片类型
  if (!mimeType.startsWith("image/")) {
    console.log("[slack:transport] file_share skipped: non-image", mimeType);
    return;
  }
  // 通过 url_private 下载文件
  const token = process.env.SLACK_BOT_TOKEN;
  const response = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    console.error("[slack:transport] file download failed:", response.status);
    return;
  }
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const text = (event.text || "").trim() || undefined;
  const threadTs = (event as any).thread_ts ?? event.ts;

  console.log("[slack:transport] processing file_share -> agent");
  await processMessage(
    text ?? "",
    event.channel,
    threadTs,
    { kind: "image", imageBase64: base64, mimeType, text }
  );
  return;
}
```

- [ ] **Step 3: 修改 processMessage 签名为支持直接传入 InputMessage**

当前 `processMessage(text, channel, threadTs)` 构造 `{ kind: "text", text }`。改为增加可选参数：

```ts
async function processMessage(
  text: string,
  slackChannel: string,
  threadTs: string,
  overrideMessage?: InputMessage
) {
  // ...
  const message: InputMessage = overrideMessage ?? { kind: "text", text };
  // ...
  await agent.handleUserMessage({
    sessionId: DEFAULT_SESSION_ID,
    message,
    emit,
    channel: "slack"
  });
}
```

- [ ] **Step 4: handleAppMention 同样处理 file_share**

在 `handleAppMention` 中添加相同的 file_share 检测逻辑（app_mention 中 @mention 带图片的情况）：

```ts
// handleAppMention 开头，bot_id 检查之后
if ((event as any).files?.length > 0 && (event as any).subtype === "file_share") {
  const file = (event as any).files[0];
  if (!file.mimetype?.startsWith("image/")) return;
  const token = process.env.SLACK_BOT_TOKEN;
  const response = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return;
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const text = event.text.replace(/<@\w+>/g, "").trim() || undefined;
  await processMessage(
    text ?? "",
    event.channel,
    event.thread_ts ?? event.ts,
    { kind: "image", imageBase64: base64, mimeType: file.mimetype, text }
  );
  return;
}
```

- [ ] **Step 5: typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: 运行 Slack transport 测试**

```bash
npm run pretest && npx vitest run src/slack/transport.test.ts
```

预期: 现有 13 个测试全部通过（file_share 新增逻辑不影响纯文本路径）。

- [ ] **Step 7: 运行全量测试**

```bash
npm test
```

- [ ] **Step 8: 提交**

```bash
git add src/slack/transport.ts
git commit -m "$(cat <<'EOF'
feat: handle Slack file_share events for image input

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Web UI 图片选择器

**文件:**
- 修改: `public/index.html`
- 修改: `public/app.js`
- 修改: `public/styles.css`（如需要新增样式）

- [ ] **Step 1: 更新 index.html 的 composer 区域**

将现有：

```html
<form id="composer" class="composer">
  <textarea
    id="messageInput"
    rows="1"
    placeholder="输入消息，Enter 发送，Shift+Enter 换行"
    autocomplete="off"
  ></textarea>
  <button id="sendButton" type="submit">发送</button>
</form>
```

改为：

```html
<form id="composer" class="composer">
  <div class="composer-row">
    <label class="image-picker" title="添加图片">
      <input type="file" id="imageInput" accept="image/*" hidden />
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    </label>
    <textarea
      id="messageInput"
      rows="1"
      placeholder="输入消息，Enter 发送，Shift+Enter 换行"
      autocomplete="off"
    ></textarea>
    <button id="sendButton" type="submit">发送</button>
  </div>
  <div id="imagePreview" class="image-preview" hidden>
    <img id="previewThumb" alt="预览" />
    <button id="removeImage" type="button" title="取消">×</button>
  </div>
</form>
```

- [ ] **Step 2: 更新 app.js 发送逻辑**

新增变量和函数（放在现有 `const` 声明区之后）：

```js
const imageInput = document.getElementById("imageInput");
const imagePreview = document.getElementById("imagePreview");
const previewThumb = document.getElementById("previewThumb");
const removeImageBtn = document.getElementById("removeImage");

// 文件选择 → 显示缩略图预览
imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (!file) {
    hideImagePreview();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    previewThumb.src = reader.result;
    imagePreview.hidden = false;
  };
  reader.readAsDataURL(file);
});

// 取消图片
removeImageBtn.addEventListener("click", () => {
  imageInput.value = "";
  hideImagePreview();
});

function hideImagePreview() {
  imagePreview.hidden = true;
  previewThumb.src = "";
}

// 粘贴图片支持
document.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        imageInput.files = dt.files;
        imageInput.dispatchEvent(new Event("change"));
      }
      break;
    }
  }
});

// base64 编码辅助
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      // 去掉 "data:image/png;base64," 前缀，只保留纯 base64
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
```

修改 `formEl.addEventListener("submit", ...)` 中的发送部分，替换现有纯文本逻辑：

```js
formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  const file = imageInput.files[0];

  if (!text && !file) return;

  // 构造消息体
  const body = {
    sessionId,
    message: file
      ? {
          kind: "image",
          imageBase64: await toBase64(file),
          mimeType: file.type || "image/jpeg",
          ...(text ? { text } : {})
        }
      : { kind: "text", text }
  };

  // UI 显示
  const displayText = file
    ? (text ? `[图片] ${text}` : "[图片]")
    : text;
  appendMessage("user", "User", displayText);

  inputEl.value = "";
  resizeInput();
  imageInput.value = "";
  hideImagePreview();
  setBusy(true);
  resetGraphSteps();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await readEventStream(response.body);
  } catch (error) {
    appendMessage("error", "Error", error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});
```

- [ ] **Step 3: 更新 styles.css — 图片选择器和预览样式**

在 `public/styles.css` 末尾追加：

```css
/* composer row: 图片图标 + textarea + 发送按钮 并排 */
.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.image-picker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  cursor: pointer;
  color: #666;
  background: #f0f0f0;
  transition: background 0.2s, color 0.2s;
  flex-shrink: 0;
}
.image-picker:hover {
  background: #e0e0e0;
  color: #333;
}

/* 图片预览条 */
.image-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  background: #f8f8f8;
  border-radius: 8px;
  max-width: 200px;
}
.image-preview img {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #ddd;
}
.image-preview button {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: #999;
  padding: 0 4px;
  line-height: 1;
}
.image-preview button:hover {
  color: #333;
}
```

- [ ] **Step 4: 启动 dev server 手工验证 UI**

```bash
npm run dev
```

打开 `http://localhost:3000`，验证：
1. file icon 出现在 textarea 左侧，不独占一行
2. 点击 icon → 文件选择器弹出
3. 选中图片后 → 缩略图预览出现
4. 点击 × → 预览消失
5. 无图片时 textarea + 发送按钮和以前一样

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "$(cat <<'EOF'
feat: add image picker to Web UI with inline preview

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 终局回归验证

- [ ] **Step 1: typecheck**

```bash
npm run typecheck
```

预期: 零错误。

- [ ] **Step 2: 全量测试**

```bash
npm test
```

预期: 全部测试通过（37 现有 + 8 schema 测试 + 4 agent 测试 ≈ 49 个）。

- [ ] **Step 3: 构建**

```bash
npm run build
```

预期: 编译成功，dist/ 产出正常。

- [ ] **Step 4: 启动 dev server 端到端手工测试**

```bash
npm run dev
```

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| 1 | Web UI 纯文字"打开客厅灯" | 正常回复，回归 |
| 2 | Web UI 选图片（不输文字）发送 | Agent 返回图片分析结果 |
| 3 | Web UI 选图片 + 输入"叶子发黄怎么办？" 发送 | Agent 结合图文推理 |
| 4 | Web UI 发完图片后，再发文字"怎么处理？" | Agent 结合上轮图片上下文回答 |
| 5 | Web UI 粘贴图片（Ctrl+V） | 触发图片选择预览 |
| 6 | `npm run test:chat` | 纯文本 chat 正常 |
| 7 | `npm run test:device-event` | 设备事件正常 |

- [ ] **Step 5: 最终提交（如有遗漏）**

```bash
git status
# 如有未提交文件
git add -A
git commit -m "chore: final regression verification pass"
```
