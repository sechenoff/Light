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
      className="inline-flex items-center bg-surface border border-border rounded-full p-1"
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
              "text-sm font-medium px-3.5 py-1.5 rounded-full transition-colors " +
              (isActive
                ? "bg-accent text-white"
                : "text-ink-3 hover:text-ink")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
