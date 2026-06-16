import Redis from "ioredis";

import { env } from "@/env";

// Singleton Redis client shared across the process.
// ioredis automatically reconnects on connection loss.
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.redisUrl, {
      // Disable automatic reconnection retries to avoid log noise during
      // transient failures; ioredis still retries internally.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });

    client.on("error", (err) => {
      console.error("[redis] connection error:", err.message);
    });

    client.on("connect", () => {
      console.log("[redis] connected");
    });
  }
  return client;
}

/**
 * Gracefully close the Redis connection.
 * Call this during process shutdown (e.g. Next.js instrumentation teardown).
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
