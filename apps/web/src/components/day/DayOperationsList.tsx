"use client";

import Link from "next/link";
import { formatRub, pluralize } from "../../lib/format";

// HH:MM from ISO date, ru-RU locale
function formatHM(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type DayOperation = {
  id: string;
  kind: "pickup" | "return";
  startDate: string;          // ISO
  endDate: string;             // ISO
  projectName: string;
  clientName: string;
  itemCount: number;
  finalAmount?: string;        // опционально; если задан — рендерим «(сумма)»
};

export function DayOperationsList({
  operations,
  showAmount = false,
  emptyLabel = "Нет операций",
}: {
  operations: DayOperation[];
  showAmount?: boolean;
  emptyLabel?: string;
}) {
  if (operations.length === 0) {
    return <p className="text-xs text-ink-3 italic">{emptyLabel}</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {operations.map((op) => {
        const time = op.kind === "pickup" ? formatHM(op.startDate) : formatHM(op.endDate);
        const kindLabel = op.kind === "pickup" ? "выдача" : "возврат";
        return (
          <li key={op.id} className="py-2">
            <Link
              href={`/bookings/${op.id}`}
              className="text-sm text-ink hover:text-accent flex flex-wrap items-baseline gap-x-2"
            >
              {/* Разделители склеены с соседями в неразрывные группы: иначе
                  перенос строки ложится между «—» и количеством позиций. */}
              <span className="whitespace-nowrap">
                <span className="mono-num text-ink-2">{time}</span>
                <span className="text-ink-3">
                  <span className="mx-2">·</span>
                  {kindLabel}
                  <span className="ml-2">·</span>
                </span>
              </span>
              <span className="min-w-0 font-medium truncate">{op.clientName || op.projectName}</span>
              {showAmount && op.finalAmount && (
                <span className="whitespace-nowrap mono-num text-ink-2">({formatRub(op.finalAmount)})</span>
              )}
              <span className="whitespace-nowrap text-ink-3">
                <span className="mr-2">—</span>
                <span className="text-xs">
                  {op.itemCount} {pluralize(op.itemCount, "позиция", "позиции", "позиций")}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
