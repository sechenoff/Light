"use client";

import Link from "next/link";
import { StatusPill } from "../StatusPill";

// Карточка «Сканирование» на странице брони (фаза 4.10, вынос из
// bookings/[id]/page.tsx, поведение 1:1): сессии киоска выдачи/приёмки +
// deep-link «Начать сканирование» (?booking=). Показывается только для
// CONFIRMED / ISSUED / RETURNED.

export type ScanSessionSummary = {
  id: string;
  operation: string;
  status: string;
  workerName: string;
  createdAt: string;
  _count: { scanRecords: number };
};

export function BookingScanSection({
  bookingId,
  bookingStatus,
  scanSessions,
}: {
  bookingId: string;
  bookingStatus: string;
  scanSessions: ScanSessionSummary[] | null | undefined;
}) {
  if (!["CONFIRMED", "ISSUED", "RETURNED"].includes(bookingStatus)) return null;

  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden no-print">
      <div className="p-3 border-b border-border bg-surface-subtle">
        <p className="eyebrow">Сканирование</p>
      </div>
      <div className="p-3 text-sm text-ink space-y-3">
        {(scanSessions ?? []).length > 0 ? (
          <div className="space-y-2">
            {(scanSessions ?? []).map((ss) => (
              <div key={ss.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-surface-subtle">
                <div className="flex items-center gap-2">
                  <StatusPill
                    variant={ss.operation === "ISSUE" ? "info" : "ok"}
                    label={ss.operation === "ISSUE" ? "Выдача" : "Возврат"}
                  />
                  <span className="text-ink-2">{ss.workerName}</span>
                </div>
                <div className="text-right text-xs text-ink-3">
                  <div>{new Date(ss.createdAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</div>
                  <div className="flex items-center gap-1 justify-end">
                    <span>{ss._count.scanRecords} скан. ·</span>
                    <StatusPill
                      variant={ss.status === "COMPLETED" ? "ok" : ss.status === "ACTIVE" ? "edit" : "none"}
                      label={ss.status === "COMPLETED" ? "Завершена" : ss.status === "ACTIVE" ? "Активна" : "Отменена"}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-sm">Нет сессий сканирования</div>
        )}
        {(bookingStatus === "CONFIRMED" || bookingStatus === "ISSUED") && (
          <Link
            href={`/warehouse/scan?booking=${bookingId}`}
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-sm hover:bg-surface-muted transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2" />
              <path d="M17 3h2a2 2 0 0 1 2 2v2" />
              <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
              <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
              <line x1="7" y1="12" x2="17" y2="12" />
            </svg>
            Начать сканирование
          </Link>
        )}
      </div>
    </div>
  );
}
