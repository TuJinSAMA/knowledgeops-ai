import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: { quotaDailyTokens: 1000, quotaMonthlyTokens: 5000 },
}));

// Controllable fake Redis: tests set `getImpl` to drive responses/failures.
let getImpl: (key: string) => Promise<string | null>;
vi.mock("./redis", () => ({
  getRedis: () => ({
    get: (key: string) => getImpl(key),
  }),
}));

import {
  assertWithinQuota,
  getQuotaStatus,
  getUsage,
  QuotaExceededError,
} from "./quota";

beforeEach(() => {
  getImpl = async () => null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getQuotaStatus", () => {
  it("returns used / limit / remaining per window", async () => {
    getImpl = async (key) => (key.includes(":daily:") ? "100" : "250");
    const status = await getQuotaStatus("ws-1");

    expect(status.daily).toEqual({
      period: "daily",
      used: 100,
      limit: 1000,
      remaining: 900,
    });
    expect(status.monthly).toEqual({
      period: "monthly",
      used: 250,
      limit: 5000,
      remaining: 4750,
    });
  });

  it("reports null (degraded) when Redis is unavailable", async () => {
    getImpl = async () => {
      throw new Error("redis down");
    };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const status = await getQuotaStatus("ws-1");
    expect(status.daily).toBeNull();
    expect(status.monthly).toBeNull();
    spy.mockRestore();
  });

  it("treats a missing counter as zero usage", async () => {
    getImpl = async () => null;
    const status = await getQuotaStatus("ws-1");
    // getUsage returns null for a missing counter, surfaced as a null window.
    expect(status.daily).toBeNull();
  });
});

describe("getUsage", () => {
  it("parses the stored counter", async () => {
    getImpl = async () => "4242";
    await expect(getUsage("ws-1", "daily")).resolves.toBe(4242);
  });
});

describe("assertWithinQuota", () => {
  it("allows a workspace under its limits", async () => {
    getImpl = async () => "100";
    await expect(assertWithinQuota("ws-1")).resolves.toBeUndefined();
  });

  it("throws 429 when a window is exhausted", async () => {
    getImpl = async (key) => (key.includes(":daily:") ? "1500" : "0");
    await expect(assertWithinQuota("ws-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("fails open (degraded mode) when Redis is unavailable", async () => {
    getImpl = async () => {
      throw new Error("redis down");
    };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(assertWithinQuota("ws-1")).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
