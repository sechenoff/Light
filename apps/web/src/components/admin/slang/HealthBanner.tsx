"use client";

type Props = { pendingCount: number };

export function HealthBanner({ pendingCount }: Props) {
  if (pendingCount > 0) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg mb-5 bg-amber-soft border border-amber-border text-amber text-sm">
        <span className="text-lg">⚠️</span>
        <span>
          <strong className="font-semibold">{pendingCount} {pendingCount === 1 ? "связь ждёт" : pendingCount < 5 ? "связи ждут" : "связей ждут"} проверки.</strong>{" "}
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
