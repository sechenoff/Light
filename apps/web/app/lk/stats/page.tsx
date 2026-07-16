"use client";
import { useEffect, useState } from "react";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkStatsResponse } from "../../../src/lib/lkTypes";
import { StatsTopTable } from "../../../src/components/lk/StatsTopTable";
import { TypicalKitGrid } from "../../../src/components/lk/TypicalKitGrid";

type Period = "180d" | "365d" | "all";

const PERIODS: { label: string; value: Period }[] = [
  { label: "Полгода", value: "180d" },
  { label: "Год", value: "365d" },
  { label: "Всё время", value: "all" },
];

export default function LkStatsPage() {
  const [period, setPeriod] = useState<Period>("365d");
  const [data, setData] = useState<LkStatsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    (async () => {
      try {
        const r = await lkApi.stats(period);
        if (!cancelled) setData(r);
      } catch {
        // redirect to login handled by lkApi on 401
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-medium">Статистика</h1>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={[
                "px-3 py-1 text-sm rounded-md border transition-colors",
                period === p.value
                  ? "bg-accent-bright text-surface border-accent-bright"
                  : "border-border hover:bg-surface-muted",
              ].join(" ")}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {!data ? (
        <p className="text-ink-2">Загрузка…</p>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Топ оборудования</h2>
            <StatsTopTable items={data.topEquipment} />
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-medium">Твой типовой набор</h2>
            <TypicalKitGrid
              items={data.typicalKit}
              sampleSize={data.typicalKitSampleSize}
            />
          </section>
        </>
      )}
    </div>
  );
}
