"use client";

import { useEffect, useState } from "react";

type AuditItem = {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  user?: { username: string } | null;
};

const APPROVAL_ACTIONS = new Set([
  "BOOKING_SUBMITTED",
  "BOOKING_APPROVED",
  "BOOKING_REJECTED",
]);

function actionLabel(action: string): string {
  switch (action) {
    case "BOOKING_SUBMITTED":
      return "Отправлено на согласование";
    case "BOOKING_APPROVED":
      return "Одобрено";
    case "BOOKING_REJECTED":
      return "Отклонено";
    default:
      return action;
  }
}

function actionDotClass(action: string): string {
  switch (action) {
    case "BOOKING_APPROVED":
      return "bg-emerald";
    case "BOOKING_REJECTED":
      return "bg-rose";
    case "BOOKING_SUBMITTED":
    default:
      return "bg-amber";
  }
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function ApprovalTimeline({ bookingId }: { bookingId: string }) {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setItems(null);
    fetch(
      `/api/audit?entityType=Booking&entityId=${encodeURIComponent(bookingId)}&limit=200`,
      { credentials: "include" },
    )
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          setHidden(true);
          return;
        }
        if (!res.ok) {
          setError("Не удалось загрузить историю согласования");
          return;
        }
        const data = (await res.json()) as { items: AuditItem[] };
        const filtered = (data.items ?? [])
          .filter((it) => APPROVAL_ACTIONS.has(it.action))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setItems(filtered);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Не удалось загрузить историю согласования");
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  if (hidden) return null;
  if (error) {
    return (
      <details className="mt-3 rounded-lg border border-border bg-surface text-sm">
        <summary className="cursor-pointer px-3 py-2 text-ink-2">
          <span className="eyebrow">История согласования</span>
        </summary>
        <div className="px-3 pb-3 text-ink-3">{error}</div>
      </details>
    );
  }
  if (!items || items.length === 0) return null;

  return (
    <details className="mt-3 rounded-lg border border-border bg-surface text-sm">
      <summary className="cursor-pointer select-none px-3 py-2 text-ink-2">
        <span className="eyebrow">История согласования</span>
        <span className="ml-2 text-ink-3">({items.length})</span>
      </summary>
      <ol className="divide-y divide-border px-3 pb-3 pt-1">
        {items.map((it) => {
          const reason =
            it.action === "BOOKING_REJECTED" && it.after && typeof (it.after as any).rejectionReason === "string"
              ? ((it.after as any).rejectionReason as string)
              : null;
          const username = it.user?.username ?? it.userId;
          return (
            <li key={it.id} className="flex items-start gap-3 py-2">
              <span
                aria-hidden="true"
                className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${actionDotClass(it.action)}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-ink">{actionLabel(it.action)}</span>
                  <span className="text-xs text-ink-3">{formatTs(it.createdAt)}</span>
                </div>
                <div className="text-xs text-ink-2">{username}</div>
                {reason && (
                  <div className="mt-1 whitespace-pre-wrap rounded bg-rose-soft px-2 py-1 text-xs text-rose">
                    {reason}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
