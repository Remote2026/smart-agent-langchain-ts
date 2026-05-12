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
