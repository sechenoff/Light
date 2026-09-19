"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { AuditEntryCard } from "@/components/audit/AuditEntryCard";
import {
  auditActionLabel,
  auditTimestamp,
  auditValue,
  parseAuditSnapshot,
  type AuditRecord,
} from "@/lib/auditFormat";

export type FinanceEventSummary = {
  id: string;
  eventType: string;
  createdAt: string;
  statusFrom?: string | null;
  statusTo?: string | null;
  amountDelta?: string | null;
  payloadJson?: string | null;
};
export function BookingJournalSection({
  bookingId,
  canViewAudit = false,
  financeEvents,
}: {
  bookingId?: string;
  canViewAudit?: boolean;
  financeEvents: FinanceEventSummary[] | null | undefined;
}) {
  const [entries, setEntries] = useState<AuditRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  async function load(next?: string) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        bookingId: bookingId!,
        limit: "30",
      });
      if (next) params.set("cursor", next);
      const data = await apiFetch<{
        items: AuditRecord[];
        nextCursor: string | null;
      }>(`/api/audit?${params}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setEntries((prev) => (next ? [...prev, ...data.items] : data.items));
      setCursor(data.nextCursor);
    } catch (e) {
      if (!abort.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить историю",
        );
    } finally {
      if (controller.current === abort) setLoading(false);
    }
  }
  useEffect(() => {
    setEntries([]);
    setCursor(null);
    if (bookingId && canViewAudit) void load();
    return () => controller.current?.abort();
    // Ссылка financeEvents меняется при перезагрузке карточки после операции.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, canViewAudit, financeEvents]);
  const legacy = (
    <div className="space-y-2">
      {(financeEvents ?? []).map((ev) => {
        const payload = parseAuditSnapshot(ev.payloadJson ?? null);
        const actor = payload.auditActor as { username?: string } | null;
        const from = ev.statusFrom ?? payload.from,
          to = ev.statusTo ?? payload.to;
        return (
          <article
            key={ev.id}
            className="rounded border border-border p-3 text-sm space-y-1 min-w-0"
          >
            <p className="font-medium text-ink">
              {auditActionLabel(ev.eventType)}
            </p>
            <p className="text-xs text-ink-2 break-words">
              {actor?.username && payload.automaticCalculation
                ? `Система · при действии аккаунта ${actor.username}`
                : (actor?.username ??
                  (payload.auditSource === "system"
                    ? "Система"
                    : payload.auditSource === "unknown"
                      ? "Аккаунт автора не определён"
                      : "Автор не сохранён в старой записи"))}
            </p>
            <time className="block text-xs text-ink-3" dateTime={ev.createdAt}>
              {auditTimestamp(ev.createdAt)}
            </time>
            {Boolean(from || to) && (
              <p className="text-xs text-ink-2">
                {auditValue(
                  "status",
                  from,
                  ev.eventType === "PAYMENT_STATUS_CHANGED"
                    ? "Payment"
                    : "Booking",
                )}{" "}
                →{" "}
                {auditValue(
                  "status",
                  to,
                  ev.eventType === "PAYMENT_STATUS_CHANGED"
                    ? "Payment"
                    : "Booking",
                )}
              </p>
            )}
            {ev.amountDelta != null && (
              <p className="text-xs text-ink-2">
                {ev.eventType === "PAYMENT_STATUS_CHANGED"
                  ? "Оплачено"
                  : "Сумма операции"}
                : {auditValue("amount", ev.amountDelta)}
              </p>
            )}
          </article>
        );
      })}
      {!financeEvents?.length && (
        <p className="text-sm text-ink-3">Финансовых событий пока нет.</p>
      )}
      {(financeEvents?.length ?? 0) >= 100 && (
        <p className="text-xs text-ink-3">Последние 100 финансовых событий.</p>
      )}
    </div>
  );
  return (
    <section className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden min-w-0">
      <div className="p-3 border-b border-border flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow">Журнал изменений</h2>
        {canViewAudit && bookingId && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="text-xs text-accent-bright min-h-9 px-2 disabled:opacity-50"
          >
            Обновить журнал
          </button>
        )}
      </div>
      <div className="p-3 space-y-3">
        {canViewAudit && bookingId ? (
          <>
            <p className="text-xs text-ink-3">
              Изменения брони и связанных финансовых документов. Время — МСК.
            </p>
            {error && (
              <p role="alert" className="text-sm text-rose">
                {error}
              </p>
            )}
            {entries.map((entry) => (
              <AuditEntryCard
                key={entry.id}
                entry={entry}
                showEntity={entry.entityType !== "Booking"}
              />
            ))}
            {loading && (
              <p role="status" className="text-sm text-ink-3">
                Загрузка истории…
              </p>
            )}
            {!loading && !error && !entries.length && (
              <p className="text-sm text-ink-3">
                Подробных записей пока нет. Ранее сохранённые финансовые события
                доступны ниже.
              </p>
            )}
            {cursor && (
              <button
                type="button"
                onClick={() => void load(cursor)}
                disabled={loading}
                className="w-full min-h-10 text-sm text-accent-bright disabled:opacity-50"
              >
                Загрузить ещё изменения
              </button>
            )}
            <details className="border-t border-border pt-3">
              <summary className="text-sm text-ink-2 cursor-pointer min-h-9">
                Финансовые события · {financeEvents?.length ?? 0}
              </summary>
              {legacy}
            </details>
            <Link
              href={`/admin/audit?entityType=Booking&entityId=${encodeURIComponent(bookingId)}`}
              className="inline-block text-xs text-accent-bright min-h-8"
            >
              Открыть в общем журнале
            </Link>
          </>
        ) : (
          legacy
        )}
      </div>
    </section>
  );
}
