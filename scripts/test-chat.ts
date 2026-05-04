/**
 * 简易测试程序：对本地服务 `POST /api/chat` 发起请求并打印 SSE 输出。
 *
 * 用法：
 *   1) 先启动服务：npm run dev
 *   2) 另开终端运行：npm run test:chat -- "你好"
 */
import process from "node:process";

const baseUrl = process.env.SMART_AGENT_BASE_URL ?? "http://localhost:3000";
const text = process.argv.slice(2).join(" ").trim() || "你好";

async function main() {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "test-session", message: { kind: "text", text } })
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  console.log(`[test-chat] POST ${baseUrl}/api/chat text="${text}"`);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;

      const type = eventLine ? eventLine.slice("event: ".length) : "unknown";
      const payload = JSON.parse(dataLine.slice("data: ".length));
      console.log(`[sse:${type}]`, payload);
    }
  }
}

main().catch((err) => {
  console.error("[test-chat] failed:", err);
  process.exitCode = 1;
});

