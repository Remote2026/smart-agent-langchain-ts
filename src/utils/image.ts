import sharp from "sharp";
import { createLogger } from "./logger.js";

const log = createLogger("image.ts");

/** 图片压缩参数 */
const MAX_DIMENSION = 768; // 最长边限制（像素）
const WEBP_QUALITY = 75;   // WebP 输出质量

/**
 * 压缩图片为适合 LLM 消费的尺寸和格式。
 *
 * 规则：
 * - 最长边超过 MAX_DIMENSION 时等比缩放
 * - 输出为 WebP（体积比 JPEG 再小 20~30%）
 * - 保留原始宽高比，不做裁剪
 * - 小于 50KB 的图片直接透传，避免无意义压缩
 *
 * @param base64 纯 base64 字符串（无 data URI 前缀）
 * @param mimeType 原始 MIME type，用于决定输入格式
 * @returns 压缩后的 { base64, mimeType }
 */
export async function compressImage(
  base64: string,
  mimeType: string
): Promise<{ base64: string; mimeType: string }> {
  const inputBuffer = Buffer.from(base64, "base64");
  const inputBytes = inputBuffer.length;

  // 极小图直接透传
  if (inputBytes < 50 * 1024) {
    return { base64, mimeType };
  }

  const pipeline = sharp(inputBuffer, {
    failOnError: false,
    unlimited: true,
  })
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY });

  const outputBuffer = await pipeline.toBuffer();
  const outputBase64 = outputBuffer.toString("base64");
  const outputBytes = outputBuffer.length;

  log.info("compressImage", {
    originalBytes: inputBytes,
    compressedBytes: outputBytes,
    ratio: `${((1 - outputBytes / inputBytes) * 100).toFixed(1)}%`,
  });

  return { base64: outputBase64, mimeType: "image/webp" };
}
