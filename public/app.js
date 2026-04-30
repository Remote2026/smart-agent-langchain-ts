const messagesEl = document.querySelector("#messages");
const toolEventsEl = document.querySelector("#toolEvents");
const formEl = document.querySelector("#composer");
const inputEl = document.querySelector("#messageInput");
const sendButtonEl = document.querySelector("#sendButton");
const statusEl = document.querySelector("#status");

const sessionId = localStorage.getItem("smart-agent-session") || crypto.randomUUID();
localStorage.setItem("smart-agent-session", sessionId);

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) {
    return;
  }

  appendMessage("user", "User", text);
  inputEl.value = "";
  resizeInput();
  setBusy(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId, text })
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

  if (event.type === "final") {
    appendMessage("assistant", "Assistant", event.payload.text || "(empty response)");
    return;
  }

  if (event.type === "tool") {
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
  }
}

function resizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 130)}px`;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}
