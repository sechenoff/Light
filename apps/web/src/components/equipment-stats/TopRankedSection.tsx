import type { ReactNode } from "react";
import Link from "next/link";
import { formatRub, pluralize } from "../../lib/format";
import type { EquipmentStatRow } from "./types";

type RowKey = "demand" | "deadStock" | "revenue" | "quality";

interface TopRankedSectionProps {
  title: string;
  rows: EquipmentStatRow[];
  rowKey: RowKey;
  emptyText?: string;
}

function formatLastBooking(iso: string | null): ReactNode {
  if (!iso) return "никогда не брали";
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  return (
    <>
      не брали с <span className="mono-num">{fmt.format(d)}</span>
    </>
  );
}

function renderPrimary(row: EquipmentStatRow, key: RowKey): ReactNode {
  if (key === "demand") {
    return (
      <>
        <span className="mono-num">{row.bookingsCount}</span>{" "}
        {pluralize(row.bookingsCount, "бронь", "брони", "броней")} ·{" "}
        <span className="mono-num">{row.qtyShifts}</span> ед.-смен
      </>
    );
  }
  if (key === "deadStock") {
    return formatLastBooking(row.lastBookingAt);
  }
  if (key === "revenue") {
    return (
      <>
        <span className="mono-num">{formatRub(row.revenuePerStorageUnit)}</span>/ед ·{" "}
        <span className="mono-num">{row.totalQuantity}</span> шт.
      </>
    );
  }
  // quality
  return (
    <>
      <span className="mono-num">{row.repairCount}</span>{" "}
      {pluralize(row.repairCount, "ремонт", "ремонта", "ремонтов")} ·{" "}
      <span className="mono-num">{row.problemCount}</span>{" "}
      {pluralize(row.problemCount, "потеря", "потери", "потерь")}
    </>
  );
}

function renderTrail(row: EquipmentStatRow, key: RowKey): ReactNode {
  if (key === "demand" || key === "revenue") {
    return <span className="mono-num">{formatRub(row.revenueRub)}</span>;
  }
  if (key === "quality") {
    return Number(row.repairCostRub) > 0 ? (
      <>
        <span className="mono-num">{formatRub(row.repairCostRub)}</span> на ремонт
      </>
    ) : null;
  }
  return null;
}

export function TopRankedSection({ title, rows, rowKey, emptyText }: TopRankedSectionProps) {
  return (
    <section className="bg-surface border border-border rounded-xl p-5 mb-4">
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold m-0">{title}</h2>
      </header>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-3 py-6 text-center">{emptyText ?? "Нет данных за период"}</div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const trail = renderTrail(r, rowKey);
            return (
              <li
                key={r.id}
                className="grid grid-cols-1 gap-1 sm:grid-cols-[1fr_auto_auto] sm:gap-3 sm:items-center py-2.5"
              >
                <Link href={`/equipment/${r.id}/units`} className="text-sm text-ink hover:text-accent">
                  <div>{r.name}</div>
                  <div className="text-xs text-ink-3">{r.category}</div>
                </Link>
                <div className="text-sm sm:text-right">{renderPrimary(r, rowKey)}</div>
                <div className="text-xs text-ink-3 sm:text-right sm:min-w-[6rem]">{trail ?? ""}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
