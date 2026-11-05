import { env } from "@/env";
import { getRedis } from "./redis";

// Redis key prefix for workspace quota counters.
const QUOTA_KEY_PREFIX = "quota:workspace:";

// TTL for quota windows (seconds).
const DAILY_TTL_SECONDS = 86_400;
const MONTHLY_TTL_SECONDS = 86_400 * 31;

function quotaKey(workspaceId: string, period: "daily" | "monthly"): string {
  const now = new Date();
  const segment =
    period === "daily"
      ? `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`
      : `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
  return `${QUOTA_KEY_PREFIX}${workspaceId}:${period}:${segment}`;
}

/**
 * Atomically increment token usage for a workspace using a Redis pipeline.
 * Returns the new counter value after the increment.
 *
 * When Redis is unavailable, logs a warning and returns 0 so the caller can
 * decide whether to block the request or allow it through in degraded mode.
 */
export async function incrementUsage(
  workspaceId: string,
  tokens: number,
  period: "daily" | "monthly" = "daily",
): Promise<number> {
  try {
    const redis = getRedis();
    const key = quotaKey(workspaceId, period);
    const ttl = period === "daily" ? DAILY_TTL_SECONDS : MONTHLY_TTL_SECONDS;

    const pipeline = redis.pipeline();
    pipeline.incrby(key, tokens);
    pipeline.expire(key, ttl, "NX"); // set TTL only on first write
    const results = await pipeline.exec();

    if (results?.[0] && !results[0][0]) {
      return results[0][1] as number;
    }
  } catch (err) {
    // Degraded mode: allow the request through but log the miss.
    console.warn("[quota] Redis unavailable, usage not tracked:", err);
  }

  return 0;
}

/**
 * Return the current usage counter for a workspace in the active period window.
 * Missing keys mean zero usage. Returns null only when Redis is unavailable.
 */
export async function getUsage(
  workspaceId: string,
  period: "daily" | "monthly" = "daily",
): Promise<number | null> {
  try {
    const redis = getRedis();
    const key = quotaKey(workspaceId, period);
    const value = await redis.get(key);
    return value !== null ? parseInt(value, 10) : 0;
  } catch (err) {
    console.warn("[quota] Redis unavailable, cannot read usage counter:", err);
    return null;
  }
}

// A limit of 0 (or less) means the quota is disabled for that period.
function isLimitDisabled(limit: number): boolean {
  return limit <= 0;
}

export type QuotaStatus = {
  period: "daily" | "monthly";
  used: number;
  limit: number;
  remaining: number;
};

/**
 * Raised when a workspace has exhausted its token quota. Carries HTTP 429 so
 * callers can translate it into a Too Many Requests response.
 */
export class QuotaExceededError extends Error {
  readonly status = 429 as const;
  readonly period: "daily" | "monthly";
  readonly limit: number;
  readonly used: number;

  constructor(period: "daily" | "monthly", used: number, limit: number) {
    super(`Workspace ${period} token quota exceeded (${used}/${limit})`);
    this.name = "QuotaExceededError";
    this.period = period;
    this.used = used;
    this.limit = limit;
  }
}

/**
 * Assert that a workspace is within its daily and monthly token quotas before
 * an LLM-backed operation runs (wired into the chat/answer entry point in
 * Phase 4). Throws {@link QuotaExceededError} (HTTP 429) when a limit is hit.
 *
 * Degraded mode: when Redis is unavailable getUsage returns null; per the
 * plan §3 contract we allow the request through and log a warning rather than
 * failing closed, so a transient Redis outage does not take down chat.
 */
export async function assertWithinQuota(workspaceId: string): Promise<void> {
  const checks: Array<{ period: "daily" | "monthly"; limit: number }> = [
    { period: "daily", limit: env.quotaDailyTokens },
    { period: "monthly", limit: env.quotaMonthlyTokens },
  ];

  for (const { period, limit } of checks) {
    if (isLimitDisabled(limit)) {
      continue;
    }
    const used = await getUsage(workspaceId, period);
    if (used === null) {
      console.warn(
        `[quota] Redis unavailable while checking ${period} quota for workspace ${workspaceId}; allowing in degraded mode`,
      );
      continue;
    }
    if (used >= limit) {
      throw new QuotaExceededError(period, used, limit);
    }
  }
}

/**
 * Read the current quota status for a workspace (for UI display). Returns null
 * for a period when Redis is unavailable. Limits come from configuration.
 */
export async function getQuotaStatus(
  workspaceId: string,
): Promise<{ daily: QuotaStatus | null; monthly: QuotaStatus | null }> {
  async function status(
    period: "daily" | "monthly",
    limit: number,
  ): Promise<QuotaStatus | null> {
    const used = await getUsage(workspaceId, period);
    if (used === null) {
      return null;
    }
    return {
      period,
      used,
      limit,
      remaining: isLimitDisabled(limit) ? Infinity : Math.max(0, limit - used),
    };
  }

  const [daily, monthly] = await Promise.all([
    status("daily", env.quotaDailyTokens),
    status("monthly", env.quotaMonthlyTokens),
  ]);
  return { daily, monthly };
}
