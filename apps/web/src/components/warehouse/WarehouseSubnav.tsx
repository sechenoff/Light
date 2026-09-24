"use client";

/**
 * Подменю раздела «Склад»: Потеряшки · Инвентаризация · История инвентаризаций.
 * Общий для /warehouse/problems и /warehouse/inventory/*. Визуальный контракт —
 * подчёркивание активной вкладки (как AdminTabNav), горизонтальный скролл на узких.
 */

import Link from "next/link";

export type WarehouseSubnavKey = "problems" | "inventory" | "history";

/** `short` — подпись на телефоне, чтобы три вкладки влезали в 343 px без обрезки. */
const ITEMS: ReadonlyArray<{ key: WarehouseSubnavKey; href: string; label: string; short?: string }> = [
  { key: "problems", href: "/warehouse/problems", label: "Потеряшки" },
  { key: "inventory", href: "/warehouse/inventory", label: "Инвентаризация" },
  { key: "history", href: "/warehouse/inventory/history", label: "История инвентаризаций", short: "История" },
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
    // Линия под вкладками — внутренняя тень, а не border-b: overflow-x-auto
    // обрезал бы -mb-px ссылок, и от 2 px подчёркивания активной оставался 1 px.
    <nav
      aria-label="Разделы склада"
      className="flex gap-0.5 overflow-x-auto shadow-[inset_0_-1px_0_rgb(var(--c-border))]"
    >
      {ITEMS.map((item) => {
        const isActive = item.key === active;
        const badge = badges?.[item.key];
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-3 pb-[7px] pt-1.5 text-[12.5px] font-semibold transition-colors ${
              isActive
                ? "border-accent-bright text-accent-bright"
                : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {item.short ? (
              <>
                <span aria-hidden="true" className="sm:hidden">
                  {item.short}
                </span>
                <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">{item.label}</span>
              </>
            ) : (
              item.label
            )}
            {/* Бейдж на телефоне не помещается в ряд вкладок — только с sm */}
            {badge && <span className="ml-1 hidden text-[10.5px] font-medium tabular-nums text-ink-3 sm:inline">{badge}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
