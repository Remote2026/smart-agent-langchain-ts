/**
 * 测试程序：向本地服务 POST /api/chat 发送图片消息（kind:"image"），验证视觉模型链路。
 *
 * 用法：
 *   1) 先启动服务：npm run dev
 *   2) 发送本地图片：npm run test:image -- <图片路径> [可选文字]
 *      例：npm run test:image -- ./test-plant.jpg "叶子发黄怎么办？"
 *   3) 无路径时自动生成 50×50 红色 PNG 做视觉测试：
 *      npm run test:image
 */
import { readFileSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import process from "node:process";

const baseUrl = process.env.SMART_AGENT_BASE_URL ?? "http://localhost:3000";

/** 动态生成一张 W×H 纯色 PNG，返回 { base64, mimeType } */
function generateColorPNG(width: number, height: number, r: number, g: number, b: number) {
  // 每行：filter byte(0) + RGB×width
  const rowBytes = 1 + width * 3;
  const rawData = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const offset = y * rowBytes;
    rawData[offset] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = offset + 1 + x * 3;
      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
    }
  }

  const compressed = deflateSync(rawData);

  // 构造最小 PNG 文件
  const chunks: Buffer[] = [];
  // PNG signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(pngChunk("IHDR", ihdr));

  // IDAT
  chunks.push(pngChunk("IDAT", compressed));

  // IEND
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));

  const buffer = Buffer.concat(chunks);
  return {
    base64: buffer.toString("base64"),
    mimeType: "image/png" as const,
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeB, data]);
  const crc = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeB, data, crcBuf]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 从文件路径读取图片并返回 base64 + mimeType */
function loadImageFromFile(filePath: string): { base64: string; mimeType: string } {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const buffer = readFileSync(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
  };
  return { base64: buffer.toString("base64"), mimeType: mimeMap[ext] ?? "image/png" };
}

function bufferBytes(filePath: string): number {
  try { return readFileSync(filePath).length; } catch { return -1; }
}

async function main() {
  const args = process.argv.slice(2);

  // 第一个参数若含已知图片扩展名，则视为图片路径；否则所有参数作为文字
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
    console.log(`[test-image] 大小: ${bufferBytes(imagePath)} bytes, MIME: ${mimeType}`);
  } else {
    // 动态生成 50×50 纯红色 PNG（明亮、可辨识）
    console.log("[test-image] 生成 50×50 纯红色 PNG");
    const generated = generateColorPNG(50, 50, 255, 0, 0);
    imageBase64 = generated.base64;
    mimeType = generated.mimeType;
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
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;

      const type = eventLine ? eventLine.slice("event: ".length) : "unknown";
      const payload = JSON.parse(dataLine.slice("data: ".length));

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

main().catch((err) => {
  console.error("[test-image] 失败:", err);
  process.exitCode = 1;
});
