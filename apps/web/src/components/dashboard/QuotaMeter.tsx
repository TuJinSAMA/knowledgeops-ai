import type { QuotaStatus } from "@/lib/quota";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function Bar({ status }: { status: QuotaStatus }) {
  const disabled = status.limit <= 0;
  const pct = disabled
    ? 0
    : Math.min(100, Math.round((status.used / status.limit) * 100));
  const over = !disabled && status.used >= status.limit;
  const near = !disabled && pct >= 80;

  const barColor = over
    ? "bg-red-500"
    : near
      ? "bg-amber-500"
      : "bg-emerald-500";

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium capitalize">{status.period}</span>
        <span className="text-neutral-500">
          {formatNumber(status.used)}
          {disabled ? (
            <span className="ml-1 text-xs">/ unlimited</span>
          ) : (
            <span className="ml-1 text-xs">
              / {formatNumber(status.limit)} tokens
            </span>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        {!disabled && (
          <div
            className={`h-full rounded-full ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {over && (
        <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">
          Quota exceeded — new answers are blocked until the window resets.
        </p>
      )}
      {!over && near && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          Approaching the limit ({pct}% used).
        </p>
      )}
    </div>
  );
}

/**
 * Presentational quota usage meter. `daily` / `monthly` are null when Redis is
 * unavailable, in which case we surface the degraded-mode behaviour explicitly
 * (counters are not tracked and requests are allowed through; see mvp-plan §3).
 */
export function QuotaMeter({
  daily,
  monthly,
}: {
  daily: QuotaStatus | null;
  monthly: QuotaStatus | null;
}) {
  const degraded = daily === null && monthly === null;

  return (
    <div className="space-y-4">
      {degraded ? (
        <p className="rounded-md border border-dashed border-amber-400 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Usage counters are currently unavailable (Redis unreachable). The
          system is running in <span className="font-medium">degraded mode</span>
          : requests are allowed through and not counted against the quota until
          the cache recovers.
        </p>
      ) : (
        <>
          {daily && <Bar status={daily} />}
          {monthly && <Bar status={monthly} />}
        </>
      )}
    </div>
  );
}
