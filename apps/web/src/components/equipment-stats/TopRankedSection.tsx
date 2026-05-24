import Link from "next/link";
import { formatRub, pluralize } from "../../lib/format";
import type { EquipmentStatRow } from "./types";

type RowKey = "demand" | "deadStock" | "revenue" | "quality";

interface TopRankedSectionProps {
  icon: string;
  title: string;
  rows: EquipmentStatRow[];
  rowKey: RowKey;
  allLink?: string;
  emptyText?: string;
}

function formatLastBooking(iso: string | null): string {
  if (!iso) return "никогда не брали";
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  return `не брали с ${fmt.format(d)}`;
}

function renderPrimary(row: EquipmentStatRow, key: RowKey): string {
  if (key === "demand") {
    return `${row.bookingsCount} ${pluralize(row.bookingsCount, "бронь", "брони", "броней")} · ${row.qtyShifts} ед.-смен`;
  }
  if (key === "deadStock") {
    return formatLastBooking(row.lastBookingAt);
  }
  if (key === "revenue") {
    return `${formatRub(row.revenuePerStorageUnit)}/ед · ${row.totalQuantity} шт.`;
  }
  // quality
  return `${row.repairCount} ${pluralize(row.repairCount, "ремонт", "ремонта", "ремонтов")} · ${row.problemCount} ${pluralize(row.problemCount, "потеря", "потери", "потерь")}`;
}

function renderTrail(row: EquipmentStatRow, key: RowKey): string | null {
  if (key === "demand" || key === "revenue") return formatRub(row.revenueRub);
  if (key === "quality") return Number(row.repairCostRub) > 0 ? `${formatRub(row.repairCostRub)} на ремонт` : null;
  return null;
}

export function TopRankedSection({ icon, title, rows, rowKey, allLink, emptyText }: TopRankedSectionProps) {
  return (
    <section className="bg-surface border border-border rounded-xl p-5 mb-4">
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="text-lg">{icon}</span>
          <h2 className="text-base font-semibold m-0">{title}</h2>
        </div>
        {allLink ? (
          <Link href={allLink} className="text-xs text-accent font-medium hover:underline">Все позиции →</Link>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-3 py-6 text-center">{emptyText ?? "Нет данных за период"}</div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const trail = renderTrail(r, rowKey);
            return (
              <li key={r.id} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-2.5">
                <Link href={`/equipment/${r.id}`} className="text-sm text-ink hover:text-accent">
                  <div>{r.name}</div>
                  <div className="text-xs text-ink-3">{r.category}</div>
                </Link>
                <div className="text-sm font-mono text-right">{renderPrimary(r, rowKey)}</div>
                <div className="text-xs font-mono text-ink-3 text-right min-w-[6rem]">{trail ?? ""}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
