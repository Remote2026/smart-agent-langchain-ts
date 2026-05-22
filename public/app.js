const messagesEl = document.querySelector("#messages");
const toolEventsEl = document.querySelector("#toolEvents");
const graphStepsEl = document.querySelector("#graphSteps");
const formEl = document.querySelector("#composer");
const inputEl = document.querySelector("#messageInput");
const sendButtonEl = document.querySelector("#sendButton");
const statusEl = document.querySelector("#status");

/* ---- 图片选择器 ---- */
const imageInput = document.getElementById("imageInput");
const imagePreview = document.getElementById("imagePreview");
const previewThumb = document.getElementById("previewThumb");
const removeImageBtn = document.getElementById("removeImage");

const sessionId = "web-default-session";
localStorage.setItem("smart-agent-session", sessionId);

const events = new EventSource("/api/events");

for (const type of ["status", "node", "tool", "final", "error"]) {
  events.addEventListener(type, (message) => {
    if (!message.data) {
      return;
    }

    handleServerEvent(JSON.parse(message.data));
  });
}

events.onerror = () => {
  statusEl.textContent = "event stream disconnected";
  statusEl.classList.remove("busy");
};

const GRAPH_NODES = [
  "prepare",
  "llm_call",
  "tool_node",
  "respond"
];
const graphStepState = new Map();

/** 当前正在流式渲染的 assistant 消息元素 */
let currentAssistantMessage = null;

/** File → 纯 base64 字符串（不含 data:image/... 前缀） */
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = /** @type {string} */ (reader.result);
      resolve(result.split(",")[1]); // 去掉 "data:image/png;base64," 前缀
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 隐藏图片预览条 */
function hideImagePreview() {
  imagePreview.hidden = true;
  previewThumb.src = "";
}

// 文件选择 → 显示缩略图预览
imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (!file) {
    hideImagePreview();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    previewThumb.src = /** @type {string} */ (reader.result);
    imagePreview.hidden = false;
  };
  reader.readAsDataURL(file);
});

// 取消已选图片
removeImageBtn.addEventListener("click", () => {
  imageInput.value = "";
  hideImagePreview();
});

// 粘贴图片支持（Ctrl+V）→ 触发图片选择流程
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

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  const file = imageInput.files[0];

  if (!text && !file) return;

  // 构造消息体：有图片 → kind:"image"，无图片 → kind:"text"
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

  // UI 显示文本（图片用占位符）
  const displayText = file
    ? (text ? `[图片] ${text}` : "[图片]")
    : text;
  appendMessage("user", "User", displayText);

  inputEl.value = "";
  resizeInput();
  imageInput.value = "";
  hideImagePreview();
  currentAssistantMessage = null;
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

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

inputEl.addEventListener("input", resizeInput);

async function readEventStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE -> UI 数据流：
  // 服务器会不断写入 "event: xxx\\ndata: {...}\\n\\n"
  // 我们按双换行拆包，取 data 行 JSON.parse 后分发到 handleServerEvent。
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) {
        continue;
      }

      handleServerEvent(JSON.parse(dataLine.slice(6)));
    }
  }
}

function handleServerEvent(event) {
  if (event.type === "status") {
    statusEl.textContent = event.payload.status;
    statusEl.classList.toggle("busy", event.payload.status !== "done");
    if (event.payload.status === "done") {
      currentAssistantMessage = null;
    }
    return;
  }

  if (event.type === "node") {
    // V2：node 事件用于渲染 Graph Steps（节点进度）
    applyNodeEvent(event.payload);
    return;
  }

  if (event.type === "token") {
    if (!currentAssistantMessage) {
      currentAssistantMessage = appendMessage("assistant", "Assistant", "");
    }
    const contentEl = currentAssistantMessage.querySelector(".content");
    contentEl.textContent += event.payload.text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  if (event.type === "final") {
    if (currentAssistantMessage) {
      const contentEl = currentAssistantMessage.querySelector(".content");
      contentEl.innerHTML = marked.parse(event.payload.text || "(empty response)");
      currentAssistantMessage = null;
    } else {
      appendMessage("assistant", "Assistant", event.payload.text || "(empty response)");
    }
    return;
  }

  if (event.type === "tool") {
    appendToolEvent(event.payload);
    const tcId = event.payload.toolCallId || "";
    if (event.payload.status === "executing") {
      const text = `**${event.payload.name}** ⏳\n\n\`\`\`json\n${formatJson(event.payload.input)}\n\`\`\``;
      appendMessage("tool", "Tool Call", text, tcId);
    } else {
      const existing = messagesEl.querySelector(`[data-tool-call-id="${tcId}"]`);
      if (existing) {
        const contentEl = existing.querySelector(".content");
        const status = event.payload.status === "ok" ? "✅" : "❌";
        const output = typeof event.payload.output === "string"
          ? event.payload.output
          : JSON.stringify(event.payload.output);
        contentEl.innerHTML = marked.parse(`**${event.payload.name}** ${status}\n\n${output.slice(0, 500)}`);
      }
    }
    return;
  }

  if (event.type === "error") {
    appendMessage("error", "Error", event.payload.message);
  }
}

function appendMessage(kind, role, content, toolCallId) {
  const article = document.createElement("article");
  article.className = `message ${kind}`;
  if (toolCallId) {
    article.dataset.toolCallId = toolCallId;
  }

  const metaEl = document.createElement("div");
  metaEl.className = "message-meta";

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role;

  const timeEl = document.createElement("time");
  timeEl.className = "message-time";
  timeEl.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  metaEl.append(roleEl, timeEl);

  const contentEl = document.createElement("div");
  contentEl.className = "content";
  contentEl.innerHTML = marked.parse(content);

  article.append(metaEl, contentEl);
  messagesEl.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return article;
}

function appendToolEvent(payload) {
  const empty = toolEventsEl.querySelector(".empty");
  empty?.remove();

  const item = document.createElement("div");
  item.className = `tool-event ${payload.status}`;
  item.innerHTML = `<strong></strong><span></span>`;
  item.querySelector("strong").textContent = payload.name;
  item.querySelector("span").textContent = payload.status;

  const details = payload.error || payload.output || payload.input;
  if (details !== undefined) {
    const pre = document.createElement("pre");
    pre.textContent = typeof details === "string" ? details : formatJson(details);
    item.append(pre);
  }

  toolEventsEl.prepend(item);
}

function setBusy(isBusy) {
  inputEl.disabled = isBusy;
  sendButtonEl.disabled = isBusy;
  if (isBusy) {
    statusEl.textContent = "sending";
    statusEl.classList.add("busy");
  } else {
    // 恢复焦点：disabled 过的元素不会自动获得焦点
    inputEl.focus();
  }
}

function resizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 130)}px`;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function resetGraphSteps() {
  if (!graphStepsEl) {
    return;
  }
  graphStepState.clear();
  graphStepsEl.innerHTML = '<div class="empty">暂无图节点事件</div>';
}

function applyNodeEvent(payload) {
  const empty = graphStepsEl?.querySelector(".empty");
  empty?.remove();

  const node = payload.node || "unknown";
  graphStepState.set(node, payload);

  const order = GRAPH_NODES.includes(node) ? GRAPH_NODES : [...GRAPH_NODES, ...graphStepState.keys()];
  const items = Array.from(new Set(order)).filter((n) => graphStepState.has(n));

  graphStepsEl.innerHTML = "";
  for (const name of items) {
    const evt = graphStepState.get(name);
    const row = document.createElement("div");
    row.className = `graph-step ${evt.phase}`;
    row.innerHTML = `<strong></strong><span></span><div class="summary"></div>`;
    row.querySelector("strong").textContent = name;
    row.querySelector("span").textContent = evt.phase;
    row.querySelector(".summary").textContent = evt.summary || "";
    graphStepsEl.append(row);
  }
}

/* ---- 清除会话历史 ---- */
const clearSessionBtn = document.getElementById("clearSessionBtn");
clearSessionBtn?.addEventListener("click", async () => {
  if (!confirm("确认清除所有会话历史？")) return;
  try {
    const res = await fetch("/api/session/clear", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 清空 UI
    messagesEl.innerHTML = "";
    toolEventsEl.innerHTML = '<div class="empty">暂无工具调用</div>';
    resetGraphSteps();
    statusEl.textContent = "会话已清除";
    console.log("[ui] session cleared");
  } catch (err) {
    console.error("[ui] clear session failed:", err);
    statusEl.textContent = "清除失败";
  }
});
