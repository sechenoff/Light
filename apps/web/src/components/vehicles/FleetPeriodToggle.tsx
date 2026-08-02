"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

import { FLEET_PERIOD_OPTIONS, parseFleetPeriod, type FleetPeriodValue } from "./types";

/** Переключатель периода витрины. Состояние живёт в URL — ссылку можно переслать. */
export function FleetPeriodToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active: FleetPeriodValue = parseFleetPeriod(searchParams.get("period"));

  function setPeriod(value: FleetPeriodValue) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("period", value);
    router.replace(`${pathname}?${next.toString()}`);
  }

  return (
    <div
      role="group"
      aria-label="Период статистики"
      className="inline-flex items-center rounded-full border border-border bg-surface p-1"
    >
      {FLEET_PERIOD_OPTIONS.map((opt) => {
        const isActive = opt.value === active;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => setPeriod(opt.value)}
            className={
              "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
              (isActive ? "bg-accent text-surface" : "text-ink-3 hover:text-ink")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
