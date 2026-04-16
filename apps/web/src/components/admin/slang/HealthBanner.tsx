"use client";

import { pluralize } from "@/lib/format";

type Props = { pendingCount: number };

export function HealthBanner({ pendingCount }: Props) {
  if (pendingCount > 0) {
    const noun = pluralize(pendingCount, "связь", "связи", "связей");
    const verb = pluralize(pendingCount, "ждёт", "ждут", "ждут");
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg mb-5 bg-amber-soft border border-amber-border text-amber text-sm">
        <span className="text-lg">⚠️</span>
        <span>
          <strong className="font-semibold">{pendingCount} {noun} {verb} проверки.</strong>{" "}
          AI предложил, но не уверен.
        </span>
        <a
          href="#review-queue"
          className="ml-auto px-3 py-1 rounded-md border border-amber-border bg-surface text-amber text-xs font-medium hover:opacity-80 transition-opacity"
        >
          Посмотреть ↓
        </a>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg mb-5 bg-emerald-soft border border-emerald-border text-emerald text-sm">
      <span className="text-lg">✅</span>
      <span>
        <strong className="font-semibold">Словарь в порядке.</strong>{" "}
        Все связи подтверждены, новых предложений нет.
      </span>
    </div>
  );
}
