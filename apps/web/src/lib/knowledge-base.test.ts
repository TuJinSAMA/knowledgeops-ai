import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { parseChunkContextHeader } from "./knowledge-base";

describe("parseChunkContextHeader", () => {
  it("extracts both Document and Section from a contextual chunk header", () => {
    const raw =
      "[Document: 03-refund-policy.md | Section: 退订与退款政策 > 全额退款窗口]\n成功付款后 7 天内可申请全额退款。";
    expect(parseChunkContextHeader(raw)).toEqual({
      header: {
        document: "03-refund-policy.md",
        section: "退订与退款政策 > 全额退款窗口",
      },
      body: "成功付款后 7 天内可申请全额退款。",
    });
  });

  it("extracts Document-only headers", () => {
    const raw = "[Document: notes.txt]\nPlain text body.";
    expect(parseChunkContextHeader(raw)).toEqual({
      header: { document: "notes.txt" },
      body: "Plain text body.",
    });
  });

  it("leaves regular bracketed lines untouched when not a context header", () => {
    const raw = "[1] Regular numbered list item\nSecond line.";
    expect(parseChunkContextHeader(raw)).toEqual({
      header: null,
      body: raw,
    });
  });
});
