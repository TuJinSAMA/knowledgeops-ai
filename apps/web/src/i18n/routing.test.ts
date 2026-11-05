import { describe, expect, it } from "vitest";

import enMessages from "../../messages/en.json";
import zhMessages from "../../messages/zh.json";
import { routing } from "./routing";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe("i18n routing", () => {
  it("supports English and Chinese with an explicit locale prefix", () => {
    expect(routing.locales).toEqual(["en", "zh"]);
    expect(routing.defaultLocale).toBe("en");
    expect(routing.localePrefix).toBe("always");
  });

  it("keeps en.json and zh.json translation keys in exact parity", () => {
    expect(flattenKeys(zhMessages)).toEqual(flattenKeys(enMessages));
  });
});
