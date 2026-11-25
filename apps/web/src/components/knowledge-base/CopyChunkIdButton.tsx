"use client";

import { useState } from "react";

export function CopyChunkIdButton({
  chunkId,
  copyLabel,
  copiedLabel,
}: {
  chunkId: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(chunkId).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={chunkId}
      className="rounded border border-neutral-200 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 transition hover:border-neutral-400 hover:text-neutral-800 dark:border-neutral-800 dark:hover:border-neutral-600 dark:hover:text-neutral-200"
    >
      {copied ? copiedLabel : `${copyLabel} · ${chunkId.slice(0, 8)}`}
    </button>
  );
}
