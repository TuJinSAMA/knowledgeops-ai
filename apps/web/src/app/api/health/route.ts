import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { env } from "@/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // Database connectivity + pgvector availability.
  try {
    const result = await db.execute(
      sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    const version = (result.rows[0] as { extversion?: string } | undefined)
      ?.extversion;
    checks.database = { ok: true, detail: `connected` };
    checks.pgvector = version
      ? { ok: true, detail: `v${version}` }
      : { ok: false, detail: "extension not installed" };
  } catch (error) {
    checks.database = {
      ok: false,
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }

  // AI service reachability (best-effort).
  try {
    const res = await fetch(`${env.aiServiceUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    checks.aiService = { ok: res.ok, detail: `status ${res.status}` };
  } catch {
    checks.aiService = { ok: false, detail: "unreachable" };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
