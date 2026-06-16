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
 * Returns null when Redis is unavailable or the counter has not been set yet.
 */
export async function getUsage(
  workspaceId: string,
  period: "daily" | "monthly" = "daily",
): Promise<number | null> {
  try {
    const redis = getRedis();
    const key = quotaKey(workspaceId, period);
    const value = await redis.get(key);
    return value !== null ? parseInt(value, 10) : null;
  } catch (err) {
    console.warn("[quota] Redis unavailable, cannot read usage counter:", err);
    return null;
  }
}
