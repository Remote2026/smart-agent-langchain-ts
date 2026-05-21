import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { buildHumanMessage } from "./agent.js";

describe("buildHumanMessage", () => {
  it("纯文本消息 → HumanMessage 字符串 content", async () => {
    const msg = await buildHumanMessage({ kind: "text", text: "打开客厅灯" });
    expect(msg).toBeInstanceOf(HumanMessage);
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toBe("打开客厅灯");
  });

  it("纯图片消息（无文字）→ content 数组只有 image_url", async () => {
    const msg = await buildHumanMessage({
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

  it("图片 + 文字 → content 数组 text 在前、image_url 在后", async () => {
    const msg = await buildHumanMessage({
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

  it("data URI 格式正确：data:{mimeType};base64,{base64}", async () => {
    const msg = await buildHumanMessage({
      kind: "image",
      imageBase64: "Zm9vYmFy",
      mimeType: "image/webp"
    });
    if (Array.isArray(msg.content)) {
      const img = msg.content[0] as { type: string; image_url: { url: string } };
      expect(img.image_url.url).toBe("data:image/webp;base64,Zm9vYmFy");
    }
  });
});
