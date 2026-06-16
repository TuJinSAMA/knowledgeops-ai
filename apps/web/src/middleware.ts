import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Rate limiting middleware using Redis fixed-window counters.
//
// Strategy: fixed window per (key, minute). Simple to reason about and
// sufficient for protecting API routes at MVP scale.
//
// Limits (configurable via environment):
//   API routes (/api/**)  – 60 requests / minute per IP
//   Auth routes (/api/auth/**) – 20 requests / minute per IP (brute-force guard)
//
// Fallback: when Redis is unavailable, the request is allowed through so that
// a transient Redis outage does not take down the application. This matches
// the degraded-mode contract in AGENTS.md.
// ---------------------------------------------------------------------------

const API_LIMIT = parseInt(process.env.RATE_LIMIT_API ?? "60", 10);
const AUTH_LIMIT = parseInt(process.env.RATE_LIMIT_AUTH ?? "20", 10);
const WINDOW_SECONDS = 60;

/**
 * Build a Redis rate-limit key scoped to the current fixed window.
 * The key expires naturally when the window ends.
 */
function rateLimitKey(identifier: string, route: string): string {
  const window = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  return `ratelimit:${route}:${identifier}:${window}`;
}

/**
 * Extract a stable client identifier from the request.
 * Prefers the X-Forwarded-For header (set by reverse proxies / Vercel edge)
 * and falls back to the direct connection IP.
 */
function clientIdentifier(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Only rate-limit API routes.
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const isAuthRoute = pathname.startsWith("/api/auth/");
  const limit = isAuthRoute ? AUTH_LIMIT : API_LIMIT;
  const routeTag = isAuthRoute ? "auth" : "api";
  const identifier = clientIdentifier(req);
  const key = rateLimitKey(identifier, routeTag);

  try {
    // Dynamic import so the Redis singleton is only loaded in the Node.js
    // runtime, not at the edge (middleware runs in Node.js by default in
    // Next.js App Router self-hosted deployments).
    const { getRedis } = await import("@/lib/redis");
    const redis = getRedis();

    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, WINDOW_SECONDS, "NX");
    const results = await pipeline.exec();

    const count = results?.[0]?.[1] as number | undefined;

    if (count !== undefined && count > limit) {
      return NextResponse.json(
        { error: "Too many requests", retryAfter: WINDOW_SECONDS },
        {
          status: 429,
          headers: {
            "Retry-After": String(WINDOW_SECONDS),
            "X-RateLimit-Limit": String(limit),
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }

    const response = NextResponse.next();
    if (count !== undefined) {
      response.headers.set("X-RateLimit-Limit", String(limit));
      response.headers.set(
        "X-RateLimit-Remaining",
        String(Math.max(0, limit - count)),
      );
    }
    return response;
  } catch {
    // Redis unavailable: allow request through (degraded mode).
    console.warn("[ratelimit] Redis unavailable, skipping rate limit check");
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/api/:path*"],
};
