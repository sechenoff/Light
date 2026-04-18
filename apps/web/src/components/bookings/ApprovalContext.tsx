"use client";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatMoneyRub, pluralize } from "../../lib/format";

type ClientStats = {
  bookingCount: number;
  averageCheck: number;
  outstandingDebt: number;
  hasDebt: boolean;
};

type ConflictItem = {
  equipmentName: string;
  requested: number;
  available: number;
};

type Props = {
  bookingId: string;
  clientId: string;
  startDate: string;
  endDate: string;
  itemCount: number;
  comment: string | null;
  items: Array<{ equipmentId: string | null; quantity: number; equipment: { name: string } | null }>;
};

export function ApprovalContext({ bookingId: _bookingId, clientId, startDate, endDate, itemCount, comment, items }: Props) {
  const [clientStats, setClientStats] = useState<ClientStats | null>(null);
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);
  const [conflictChecked, setConflictChecked] = useState(false);

  // Stable key for items to avoid re-fetching on every parent render
  const itemsKey = useMemo(
    () => items.filter((i) => i.equipmentId != null).map((i) => `${i.equipmentId}:${i.quantity}`).join(","),
    [items]
  );

  // Fetch client stats
  useEffect(() => {
    let cancelled = false;
    apiFetch<ClientStats>(`/api/clients/${clientId}/stats`)
      .then((data) => {
        if (!cancelled) setClientStats(data);
      })
      .catch(() => {}); // Silent fail — panel just won't show
    return () => { cancelled = true; };
  }, [clientId]);

  // Check equipment availability/conflicts
  useEffect(() => {
    let cancelled = false;
    const startISO = new Date(startDate).toISOString();
    const endISO = new Date(endDate).toISOString();
    apiFetch<{ rows: Array<{ equipmentId: string; name: string; availableQuantity: number }> }>(
      `/api/availability?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`
    )
      .then((data) => {
        if (cancelled) return;
        const found: ConflictItem[] = [];
        for (const item of items) {
          if (item.equipmentId == null) continue; // skip custom items
          const avail = data.rows.find((r) => r.equipmentId === item.equipmentId);
          if (avail && item.quantity > avail.availableQuantity) {
            found.push({
              equipmentName: item.equipment?.name ?? "—",
              requested: item.quantity,
              available: avail.availableQuantity,
            });
          }
        }
        setConflicts(found);
        setConflictChecked(true);
      })
      .catch(() => { if (!cancelled) setConflictChecked(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, itemsKey]);

  return (
    <div className="space-y-3">
      {/* Conflict check */}
      {conflictChecked && (
        conflicts.length === 0 ? (
          <div className="rounded border border-emerald-border bg-emerald-soft px-3 py-2.5 text-sm text-ink">
            <span className="font-medium">📅 Конфликтов нет</span>{" "}
            <span className="text-ink-2">
              · {pluralize(itemCount, "позиция свободна", "позиции свободны", "позиций свободно")} на указанные даты
            </span>
          </div>
        ) : (
          <div className="rounded border border-amber-border bg-amber-soft px-3 py-2.5 text-sm">
            <div className="font-medium text-amber">⚠️ Конфликты доступности</div>
            <ul className="mt-1 space-y-0.5 text-ink-2 text-xs">
              {conflicts.map((c, i) => (
                <li key={i}>
                  {c.equipmentName}: запрошено {c.requested}, доступно {c.available}
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      {/* Client history */}
      {clientStats && (
        <div className="rounded border border-border bg-surface px-3 py-2.5 text-sm text-ink">
          <span className="font-medium">💰 История клиента:</span>{" "}
          {clientStats.bookingCount} {pluralize(clientStats.bookingCount, "бронь", "брони", "броней")}
          {clientStats.averageCheck > 0 && (
            <> · средний чек {formatMoneyRub(String(clientStats.averageCheck))}</>
          )}
          {" · "}
          <span className={clientStats.hasDebt ? "text-rose font-medium" : "text-emerald"}>
            {clientStats.hasDebt
              ? `долг ${formatMoneyRub(String(clientStats.outstandingDebt))}`
              : "долгов нет"}
          </span>
        </div>
      )}

      {/* Warehouse comment (highlighted) */}
      {comment && (
        <div className="rounded border-l-[3px] border-amber bg-amber-soft px-3 py-2.5 text-sm">
          <div className="font-medium text-ink">💬 Комментарий кладовщика:</div>
          <div className="mt-1 text-ink-2 whitespace-pre-wrap">{comment}</div>
        </div>
      )}
    </div>
  );
}
