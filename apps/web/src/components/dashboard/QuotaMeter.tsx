"use client";

import { useLocale, useTranslations } from "next-intl";

import type { QuotaStatus } from "@/lib/quota";

function Bar({ status }: { status: QuotaStatus }) {
  const t = useTranslations("usage");
  const locale = useLocale();
  const formatNumber = new Intl.NumberFormat(locale).format;
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
        <span className="font-medium">{t(`periods.${status.period}`)}</span>
        <span className="text-neutral-500">
          {formatNumber(status.used)}
          {disabled ? (
            <span className="ml-1 text-xs">/ {t("unlimited")}</span>
          ) : (
            <span className="ml-1 text-xs">
              / {formatNumber(status.limit)} {t("tokens")}
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
          {t("exceeded")}
        </p>
      )}
      {!over && near && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {t("nearLimit", { percent: pct })}
        </p>
      )}
    </div>
  );
}

/**
 * Presentational quota usage meter. `daily` / `monthly` are null only when
 * Redis is unavailable (degraded mode: counters are not tracked and requests
 * are allowed through; see mvp-plan §3). Zero usage is a normal status.
 */
export function QuotaMeter({
  daily,
  monthly,
}: {
  daily: QuotaStatus | null;
  monthly: QuotaStatus | null;
}) {
  const t = useTranslations("usage");
  const degraded = daily === null && monthly === null;

  return (
    <div className="space-y-4">
      {degraded ? (
        <p className="rounded-md border border-dashed border-amber-400 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {t("countersUnavailable")}
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
