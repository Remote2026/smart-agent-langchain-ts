/**
 * 测试程序：向本地服务 POST /api/chat 发送图片消息（kind:"image"），验证视觉模型链路。
 *
 * 用法：
 *   1) 先启动服务：npm run dev
 *   2) 发送本地图片：npm run test:image -- <图片路径> [可选文字]
 *      例：npm run test:image -- ./test-plant.jpg "叶子发黄怎么办？"
 *   3) 不传路径时使用内置 1x1 红色像素 PNG 做连通性测试：
 *      npm run test:image
 *
 * 验证要点：
 *   - /api/chat 接受 kind:"image" 消息
 *   - SmartAgent.buildHumanMessage 构造多模态 HumanMessage
 *   - qwen-vl-plus 正确识别图片内容并返回推理结果
 *   - SSE 事件流正常（status → node → tool → final）
 */
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

const baseUrl = process.env.SMART_AGENT_BASE_URL ?? "http://localhost:3000";

// ---- 内置测试图片：1×1 红色像素 PNG（base64） ----
const RED_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

/** 从文件路径读取图片并返回 base64 + mimeType */
function loadImageFromFile(filePath: string): { base64: string; mimeType: string } {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const buffer = readFileSync(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
  };
  return {
    base64: buffer.toString("base64"),
    mimeType: mimeMap[ext] ?? "image/png",
  };
}

async function main() {
  const args = process.argv.slice(2);

  // 判断第一个参数是否为图片路径（有已知图片扩展名）
  const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
  const hasImagePath = args.length > 0 && IMAGE_EXTS.some((ext) => args[0].toLowerCase().endsWith(ext));

  const imagePath = hasImagePath ? args[0] : undefined;
  const text = args.slice(hasImagePath ? 1 : 0).join(" ").trim() || undefined;

  let imageBase64: string;
  let mimeType: string;

  if (imagePath) {
    console.log(`[test-image] 加载图片: ${imagePath}`);
    const loaded = loadImageFromFile(imagePath);
    imageBase64 = loaded.base64;
    mimeType = loaded.mimeType;
    console.log(`[test-image] 图片大小: ${bufferBytes(imagePath)} bytes, MIME: ${mimeType}`);
  } else {
    // 内置测试图片
    console.log("[test-image] 使用内置 1×1 红色像素 PNG 做连通性测试");
    imageBase64 = RED_PIXEL_PNG_BASE64;
    mimeType = "image/png";
  }

  const body: Record<string, unknown> = {
    sessionId: "test-image-session",
    message: {
      kind: "image",
      imageBase64,
      mimeType,
      ...(text ? { text } : {}),
    },
  };

  console.log(`[test-image] POST ${baseUrl}/api/chat`);
  console.log(`[test-image] text: ${text ?? "(无文字，纯图片推理)"}`);

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

      // 精简输出：final 事件打印完整文本
      if (type === "final") {
        console.log(`\n[Agent 回复]\n${payload.payload?.text ?? payload}`);
      } else if (type === "error") {
        console.error(`\n[错误] ${payload.payload?.message ?? payload}`);
      } else if (type === "tool") {
        console.log(`  [tool:${payload.payload?.name}] ${payload.payload?.status}`);
      } else {
        console.log(`  [${type}]`, JSON.stringify(payload).slice(0, 120));
      }
    }
  }
}

function bufferBytes(filePath: string): number {
  try {
    return readFileSync(filePath).length;
  } catch {
    return -1;
  }
}

main().catch((err) => {
  console.error("[test-image] 失败:", err);
  process.exitCode = 1;
});
