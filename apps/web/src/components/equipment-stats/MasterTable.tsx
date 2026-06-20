"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatRub } from "../../lib/format";
import type { EquipmentStatRow } from "./types";

type SortKey =
  | "name"
  | "category"
  | "totalQuantity"
  | "bookingsCount"
  | "qtyShifts"
  | "revenueRub"
  | "revenuePerStorageUnit"
  | "repairCount"
  | "problemCount";

type FilterChip = "all" | "no-rental" | "with-incidents";

const COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "Позиция", align: "left" },
  { key: "category", label: "Категория", align: "left" },
  { key: "totalQuantity", label: "Σ кол-во", align: "right" },
  { key: "bookingsCount", label: "Броней", align: "right" },
  { key: "qtyShifts", label: "Ед.-смен", align: "right" },
  { key: "revenueRub", label: "Выручка ₽", align: "right" },
  { key: "revenuePerStorageUnit", label: "₽/ед. склада", align: "right" },
  { key: "repairCount", label: "Ремонтов", align: "right" },
  { key: "problemCount", label: "Потерь", align: "right" },
];

function cmp(a: EquipmentStatRow, b: EquipmentStatRow, key: SortKey, dir: 1 | -1): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "string" && typeof bv === "string") {
    // numeric strings (Decimal serialized) → compare as numbers when possible
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn) && (an !== 0 || bn !== 0 || av === bv)) {
      return dir * (an - bn);
    }
    return dir * av.localeCompare(bv);
  }
  return dir * ((av as number) - (bv as number));
}

interface MasterTableProps {
  rows: EquipmentStatRow[];
}

export function MasterTable({ rows }: MasterTableProps) {
  const router = useRouter();
  const [chip, setChip] = useState<FilterChip>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const visible = useMemo(() => {
    let r = rows;
    if (chip === "no-rental") r = r.filter((x) => x.bookingsCount === 0);
    else if (chip === "with-incidents") r = r.filter((x) => x.repairCount + x.problemCount > 0);
    return [...r].sort((a, b) => cmp(a, b, sortKey, sortDir));
  }, [rows, chip, sortKey, sortDir]);

  function onHeader(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 1 ? -1 : 1);
    } else {
      setSortKey(key);
      // default desc for numeric, asc for string
      setSortDir(key === "name" || key === "category" ? 1 : -1);
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap">
        <ChipButton active={chip === "all"} onClick={() => setChip("all")}>Все</ChipButton>
        <ChipButton active={chip === "no-rental"} onClick={() => setChip("no-rental")}>Без аренды</ChipButton>
        <ChipButton active={chip === "with-incidents"} onClick={() => setChip("with-incidents")}>С поломками</ChipButton>
      </div>
      <div className="overflow-x-auto bg-surface border border-border rounded-xl">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-surface-2">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={
                    "px-3 py-2.5 text-xs uppercase tracking-wide font-semibold text-ink-3 cursor-pointer select-none " +
                    (c.align === "right" ? "text-right" : "text-left")
                  }
                  onClick={() => onHeader(c.key)}
                  aria-sort={sortKey === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none"}
                >
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className="border-t border-border hover:bg-surface-2 cursor-pointer"
                onClick={() => router.push(`/equipment/${r.id}/units`)}
              >
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-ink-3">{r.category}</td>
                <td className="px-3 py-2 text-right mono-num">{r.totalQuantity}</td>
                <td className="px-3 py-2 text-right mono-num">{r.bookingsCount}</td>
                <td className="px-3 py-2 text-right mono-num">{r.qtyShifts}</td>
                <td className="px-3 py-2 text-right mono-num">{formatRub(r.revenueRub)}</td>
                <td className="px-3 py-2 text-right mono-num">{formatRub(r.revenuePerStorageUnit)}</td>
                <td className="px-3 py-2 text-right mono-num">{r.repairCount}</td>
                <td className="px-3 py-2 text-right mono-num">{r.problemCount}</td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-ink-3">
                  Нет позиций под выбранный фильтр
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-xs px-3 py-1.5 rounded-full border transition-colors " +
        (active
          ? "bg-accent text-white border-accent"
          : "bg-surface text-ink-3 border-border hover:text-ink")
      }
    >
      {children}
    </button>
  );
}
