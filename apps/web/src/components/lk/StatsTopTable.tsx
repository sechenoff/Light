"use client";
import { useState } from "react";
import { formatRub } from "../../lib/format";
import type { LkStatsResponse } from "../../lib/lkTypes";

type SortKey = "bookingsCount" | "totalQuantityRented" | "totalSpentRub" | "name" | "category";

// Текстовые колонки сортируются по алфавиту (по возрастанию), числовые — по убыванию.
const ASCENDING_KEYS: ReadonlySet<SortKey> = new Set(["name", "category"]);

export function StatsTopTable({ items }: { items: LkStatsResponse["topEquipment"] }) {
  const [sortKey, setSortKey] = useState<SortKey>("bookingsCount");

  const sorted = [...items].sort((a, b) => {
    if (sortKey === "category") return a.category.localeCompare(b.category, "ru") || a.name.localeCompare(b.name, "ru");
    if (sortKey === "name") return a.name.localeCompare(b.name, "ru");
    if (sortKey === "totalSpentRub") return Number(b.totalSpentRub) - Number(a.totalSpentRub);
    return (b[sortKey] as number) - (a[sortKey] as number);
  });

  function ColHeader({
    sortId,
    label,
    right = false,
    className = "",
  }: {
    sortId: SortKey;
    label: string;
    right?: boolean;
    className?: string;
  }) {
    const active = sortKey === sortId;
    const ascending = ASCENDING_KEYS.has(sortId);
    return (
      <th
        onClick={() => setSortKey(sortId)}
        className={[
          "px-4 py-2 font-medium cursor-pointer select-none whitespace-nowrap",
          right ? "text-right" : "text-left",
          // Активность — только цветом: начертание у всех заголовков одно.
          active ? "text-ink" : "text-ink-2 hover:text-ink",
          className,
        ].join(" ")}
        aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}
      >
        {label}
        {active && <span className="ml-1 text-accent">{ascending ? "↑" : "↓"}</span>}
      </th>
    );
  }

  return (
    <div className="bg-surface-muted border border-border rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface-subtle border-b border-border">
          <tr>
            <ColHeader sortId="name" label="Название" />
            {/* На узких экранах категория уходит подписью под название,
                «Раз арендовано» — только с sm: иначе суммы за краем */}
            <ColHeader sortId="category" label="Категория" className="hidden md:table-cell" />
            <ColHeader sortId="bookingsCount" label="Заказов" right />
            <ColHeader sortId="totalQuantityRented" label="Раз арендовано" right className="hidden sm:table-cell" />
            <ColHeader sortId="totalSpentRub" label="Сумма" right />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.equipmentId} className="hover:bg-surface/50">
              <td className="px-4 py-2">
                {r.name}
                <span className="block md:hidden text-xs text-ink-3">{r.category}</span>
              </td>
              <td className="px-4 py-2 text-ink-2 hidden md:table-cell">{r.category}</td>
              <td className="px-4 py-2 text-right mono-num">{r.bookingsCount}</td>
              <td className="px-4 py-2 text-right mono-num hidden sm:table-cell">{r.totalQuantityRented}</td>
              <td className="px-4 py-2 text-right mono-num whitespace-nowrap">{formatRub(Number(r.totalSpentRub))}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-ink-2">
                Данных за выбранный период нет.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
