import { DayKpiCard } from "../day/DayKpiCard";
import { formatRub, pluralize } from "../../lib/format";
import type { EquipmentStatsResponse } from "./types";

interface KpiHeroProps {
  kpi: EquipmentStatsResponse["kpi"];
  periodLabel: string;
}

export function KpiHero({ kpi, periodLabel }: KpiHeroProps) {
  const dormantShare = kpi.totalCount > 0 ? kpi.dormantCount / kpi.totalCount : 0;
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 mb-8">
      <DayKpiCard
        eyebrow="Активных позиций"
        value={
          <span className="mono-num text-lg sm:text-xl">
            {kpi.activeCount} <span className="text-ink-3 text-base">/ {kpi.totalCount}</span>
          </span>
        }
        sub={periodLabel}
      />
      <DayKpiCard
        eyebrow="Мёртвый груз"
        value={<span className="mono-num text-lg sm:text-xl">{kpi.dormantCount}</span>}
        sub={`${pluralize(kpi.dormantCount, "позиция", "позиции", "позиций")} без аренды`}
        subTone={dormantShare > 0.3 ? "rose" : "muted"}
      />
      <DayKpiCard
        eyebrow="Выручка"
        value={<span className="mono-num text-lg sm:text-xl">{formatRub(kpi.revenueRub)}</span>}
        sub={periodLabel}
      />
      <DayKpiCard
        eyebrow="Расход на ремонт"
        value={<span className="mono-num text-lg sm:text-xl">{formatRub(kpi.repairCostRub)}</span>}
        sub="расходы на ремонт"
      />
    </div>
  );
}
