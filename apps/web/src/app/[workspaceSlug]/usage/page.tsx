import { notFound } from "next/navigation";

import { QuotaMeter } from "@/components/dashboard/QuotaMeter";
import { getTraceStats } from "@/lib/dashboard";
import { getQuotaStatus } from "@/lib/quota";
import { requireUser } from "@/lib/session";
import { getUserWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export default async function UsagePage({
  params,
}: PageProps<"/[workspaceSlug]/usage">) {
  const { workspaceSlug } = await params;
  const user = await requireUser(`/${workspaceSlug}/usage`);
  const workspace = await getUserWorkspaceBySlug(user.id, workspaceSlug);
  if (!workspace) {
    notFound();
  }

  const [quota, traceStats] = await Promise.all([
    getQuotaStatus(workspace.id),
    getTraceStats(workspace.id),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Usage & quotas</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Token consumption against this workspace&apos;s daily and monthly
        limits, plus cumulative cost across all answers.
      </p>

      <section className="mt-8 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="font-semibold">Quota windows</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Counters live in Redis and reset at the end of each UTC window. A limit
          of 0 means that window is unlimited.
        </p>
        <div className="mt-4">
          <QuotaMeter daily={quota.daily} monthly={quota.monthly} />
        </div>
      </section>

      <section className="mt-6 grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Answers
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCount(traceStats.answerCount)}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Total tokens
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCount(traceStats.totalTokens)}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Est. cost
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCost(traceStats.totalCost)}
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-neutral-200 p-5 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        <h2 className="font-semibold text-neutral-900 dark:text-neutral-100">
          About degraded mode
        </h2>
        <p className="mt-2">
          Quota enforcement and counting depend on Redis. If Redis is temporarily
          unreachable, the system fails open: requests are{" "}
          <span className="font-medium">allowed through</span> and are not counted
          against the quota until the cache recovers. This keeps chat available
          during a transient cache outage at the cost of brief over-allowance
          (see the architecture notes, §3). The meters above show
          &ldquo;degraded mode&rdquo; whenever counters cannot be read.
        </p>
      </section>
    </main>
  );
}
