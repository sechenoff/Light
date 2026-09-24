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
      className="inline-flex overflow-hidden rounded border border-border bg-surface"
    >
      {FLEET_PERIOD_OPTIONS.map((opt) => {
        const isActive = opt.value === active;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => setPeriod(opt.value)}
            // Сегмент как группы на «Ремонтах» (GROUP_BTN): на телефоне выше — под палец.
            className={
              "border-r border-border px-2.5 py-2 text-[11px] font-semibold leading-[1.6] transition-colors last:border-r-0 md:py-1 " +
              (isActive ? "bg-accent text-surface hover:bg-accent" : "text-ink-2 hover:bg-surface-muted")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
