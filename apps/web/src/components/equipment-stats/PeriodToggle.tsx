"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { PERIOD_OPTIONS, parsePeriod, type PeriodValue } from "./types";

export function PeriodToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active: PeriodValue = parsePeriod(searchParams.get("period"));

  function setPeriod(value: PeriodValue) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("period", value);
    router.replace(`${pathname}?${next.toString()}`);
  }

  return (
    <div
      role="group"
      aria-label="Период"
      className="inline-flex overflow-hidden rounded border border-border bg-surface"
    >
      {PERIOD_OPTIONS.map((opt) => {
        const isActive = opt.value === active;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => setPeriod(opt.value)}
            className={
              // Тот же сегмент, что у периода автопарка (FleetPeriodToggle) и групп «Ремонтов».
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
