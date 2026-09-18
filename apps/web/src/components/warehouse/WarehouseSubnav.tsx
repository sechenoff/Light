"use client";

/**
 * Подменю раздела «Склад»: Потеряшки · Инвентаризация · История инвентаризаций.
 * Общий для /warehouse/problems и /warehouse/inventory/*. Визуальный контракт —
 * подчёркивание активной вкладки (как AdminTabNav), горизонтальный скролл на узких.
 */

import Link from "next/link";

export type WarehouseSubnavKey = "problems" | "inventory" | "history";

const ITEMS: ReadonlyArray<{ key: WarehouseSubnavKey; href: string; label: string }> = [
  { key: "problems", href: "/warehouse/problems", label: "Потеряшки" },
  { key: "inventory", href: "/warehouse/inventory", label: "Инвентаризация" },
  { key: "history", href: "/warehouse/inventory/history", label: "История инвентаризаций" },
];

export function WarehouseSubnav({
  active,
  badges,
}: {
  active: WarehouseSubnavKey;
  /** Необязательные подписи справа от названия: «4», «№ 1 · идёт». */
  badges?: Partial<Record<WarehouseSubnavKey, string>>;
}) {
  return (
    <nav
      aria-label="Разделы склада"
      className="flex gap-0.5 overflow-x-auto border-b border-border"
    >
      {ITEMS.map((item) => {
        const isActive = item.key === active;
        const badge = badges?.[item.key];
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 pb-[7px] pt-1.5 text-[12.5px] font-semibold transition-colors ${
              isActive
                ? "border-accent-bright text-accent-bright"
                : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {item.label}
            {badge && <span className="ml-1 text-[10.5px] font-medium tabular-nums text-ink-3">{badge}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
