"use client";

import { SectionHeader } from "../SectionHeader";
import { PeriodToggle } from "./PeriodToggle";
import { KpiHero } from "./KpiHero";
import { TopRankedSection } from "./TopRankedSection";
import { MasterTable } from "./MasterTable";
import { useEquipmentStats } from "./useEquipmentStats";

const PERIOD_LABEL: Record<"30d" | "90d" | "365d", string> = {
  "30d": "за 30 дней",
  "90d": "за 90 дней",
  "365d": "за год",
};

export function EquipmentStatsPage() {
  const { data, error, loading, retry } = useEquipmentStats();

  return (
    <div className="space-y-2">
      <SectionHeader
        eyebrow="Аналитика"
        title="Статистика техники"
        actions={<PeriodToggle />}
      />

      {loading && !data ? (
        <div className="py-12 text-center text-ink-3">Загружаем…</div>
      ) : error ? (
        <div className="py-6 px-4 bg-rose-soft border border-rose-border rounded-xl text-rose flex items-center justify-between gap-4 flex-wrap">
          <span>{error}</span>
          <button
            type="button"
            onClick={retry}
            className="shrink-0 px-3 py-2 -my-1 text-sm font-medium text-rose bg-surface border border-rose-border rounded-lg hover:bg-rose-soft transition-colors"
          >
            Повторить
          </button>
        </div>
      ) : data ? (
        <div
          aria-busy={loading}
          className={loading ? "opacity-50 pointer-events-none" : undefined}
        >
          <KpiHero kpi={data.kpi} periodLabel={PERIOD_LABEL[data.period]} />

          <TopRankedSection
            title="Чаще всего берут"
            rows={data.demand}
            rowKey="demand"
            emptyText="Нет броней за выбранный период"
          />
          <TopRankedSection
            title="Мёртвый груз"
            rows={data.deadStock}
            rowKey="deadStock"
            emptyText="Все позиции в работе — мёртвого груза нет 🎉"
          />
          <TopRankedSection
            title="Лучшая доходность на единицу склада"
            rows={data.revenue}
            rowKey="revenue"
            emptyText="Нет выручки за выбранный период"
          />
          <TopRankedSection
            title="Проблемные позиции"
            rows={data.quality}
            rowKey="quality"
            emptyText="За выбранный период ничего не ломали 🎉"
          />

          <div className="mt-8 mb-2 eyebrow">Все позиции</div>
          <MasterTable rows={data.table} />
        </div>
      ) : null}
    </div>
  );
}
