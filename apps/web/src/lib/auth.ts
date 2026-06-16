import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/db";
import { account, session, user, verification } from "@/db/schema";
import { env } from "@/env";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Redis-backed secondaryStorage for better-auth session caching.
//
// better-auth uses this to cache session tokens in Redis (GET/SET/DELETE),
// which reduces Postgres reads on every authenticated request. The interface
// contract requires: get, set (with optional TTL in seconds), and delete.
//
// Errors are caught and surfaced as null/no-ops so that a transient Redis
// outage falls back gracefully to the Postgres session table.
// ---------------------------------------------------------------------------
const redisStorage = {
  async get(key: string): Promise<string | null> {
    try {
      return await getRedis().get(`auth:${key}`);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string, ttl?: number): Promise<void> {
    try {
      const redis = getRedis();
      if (ttl && ttl > 0) {
        await redis.setex(`auth:${key}`, ttl, value);
      } else {
        await redis.set(`auth:${key}`, value);
      }
    } catch {
      // Silently fail — session will be fetched from Postgres on next request.
    }
  },
  async delete(key: string): Promise<void> {
    try {
      await getRedis().del(`auth:${key}`);
    } catch {
      // Best-effort deletion; session will expire naturally or be evicted.
    }
  },
};

export const auth = betterAuth({
  secret: env.betterAuthSecret,
  baseURL: env.betterAuthUrl,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  // Cache session lookups in Redis to reduce Postgres reads on every request.
  secondaryStorage: redisStorage,
  // Email + password is the simplest production-ready starting point.
  // Social / SSO providers can be added here later.
  emailAndPassword: {
    enabled: true,
  },
});

export type Session = typeof auth.$Infer.Session;
