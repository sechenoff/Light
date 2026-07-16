"use client";
import { useState } from "react";
import { formatRub } from "../../lib/format";
import type { LkStatsResponse } from "../../lib/lkTypes";

type SortKey = "bookingsCount" | "totalQuantityRented" | "totalSpentRub" | "name";

export function StatsTopTable({ items }: { items: LkStatsResponse["topEquipment"] }) {
  const [sortKey, setSortKey] = useState<SortKey>("bookingsCount");

  const sorted = [...items].sort((a, b) => {
    if (sortKey === "name") return a.name.localeCompare(b.name, "ru");
    if (sortKey === "totalSpentRub") return Number(b.totalSpentRub) - Number(a.totalSpentRub);
    return (b[sortKey] as number) - (a[sortKey] as number);
  });

  function ColHeader({
    sortId,
    label,
    right = false,
  }: {
    sortId: SortKey;
    label: string;
    right?: boolean;
  }) {
    const active = sortKey === sortId;
    return (
      <th
        onClick={() => setSortKey(sortId)}
        className={[
          "px-4 py-2 cursor-pointer select-none whitespace-nowrap",
          right ? "text-right" : "text-left",
          active ? "text-ink font-medium" : "text-ink-2 hover:text-ink",
        ].join(" ")}
        aria-sort={active ? "descending" : "none"}
      >
        {label}
        {active && <span className="ml-1 text-accent">↓</span>}
      </th>
    );
  }

  return (
    <div className="bg-surface-muted border border-border rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <ColHeader sortId="name" label="Название" />
            <ColHeader sortId="name" label="Категория" />
            <ColHeader sortId="bookingsCount" label="Заказов" right />
            <ColHeader sortId="totalQuantityRented" label="Раз арендовано" right />
            <ColHeader sortId="totalSpentRub" label="Сумма" right />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.equipmentId} className="hover:bg-surface/50">
              <td className="px-4 py-2">{r.name}</td>
              <td className="px-4 py-2 text-ink-2">{r.category}</td>
              <td className="px-4 py-2 text-right mono-num">{r.bookingsCount}</td>
              <td className="px-4 py-2 text-right mono-num">{r.totalQuantityRented}</td>
              <td className="px-4 py-2 text-right mono-num">{formatRub(Number(r.totalSpentRub))}</td>
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
