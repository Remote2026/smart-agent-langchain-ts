const messagesEl = document.querySelector("#messages");
const toolEventsEl = document.querySelector("#toolEvents");
const graphStepsEl = document.querySelector("#graphSteps");
const formEl = document.querySelector("#composer");
const inputEl = document.querySelector("#messageInput");
const sendButtonEl = document.querySelector("#sendButton");
const statusEl = document.querySelector("#status");

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
  "ingest",
  "router_intent",
  "smartthings_node",
  "ros2_node",
  "default_node",
  "respond",
  "finalize"
];
const graphStepState = new Map();

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) {
    return;
  }

  // UI -> HTTP 数据流（text-only）
  appendMessage("user", "User", text);
  inputEl.value = "";
  resizeInput();
  setBusy(true);
  resetGraphSteps();

  try {
    const body = { sessionId, message: { kind: "text", text } };

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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
    return;
  }

  if (event.type === "node") {
    // V2：node 事件用于渲染 Graph Steps（节点进度）
    applyNodeEvent(event.payload);
    return;
  }

  if (event.type === "final") {
    appendMessage("assistant", "Assistant", event.payload.text || "(empty response)");
    return;
  }

  if (event.type === "tool") {
    // tool 事件用于渲染 Tool Events（详细日志）
    appendToolEvent(event.payload);
    if (event.payload.status === "executing") {
      appendMessage("tool", "Tool Call", `${event.payload.name}\n${formatJson(event.payload.input)}`);
    }
    return;
  }

  if (event.type === "error") {
    appendMessage("error", "Error", event.payload.message);
  }
}

function appendMessage(kind, role, content) {
  const article = document.createElement("article");
  article.className = `message ${kind}`;

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role;

  const contentEl = document.createElement("div");
  contentEl.className = "content";
  contentEl.textContent = content;

  article.append(roleEl, contentEl);
  messagesEl.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
