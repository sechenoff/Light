"use client";

import { DayKpiCard } from "../day/DayKpiCard";
import { formatRub, pluralize } from "../../lib/format";
import { FLEET_PERIOD_LABEL, type FleetPeriodValue, type FleetTotals } from "./types";

/**
 * Верхняя сводка по парку. Для ролей без доступа к финансам денежные карточки
 * не рендерятся вовсе (а не показываются пустыми) — меньше визуального шума.
 */
export function FleetKpiRow({
  totals,
  period,
  canSeeMoney,
}: {
  totals: FleetTotals;
  period: FleetPeriodValue;
  canSeeMoney: boolean;
}) {
  const periodLabel = FLEET_PERIOD_LABEL[period];
  const inactive = totals.vehiclesTotal - totals.vehiclesActive;

  return (
    <div
      // На телефоне 2 в ряд: пять карточек в столбик отодвигали бы первую машину
      // почти на экран вниз, а на складе страницу открывают именно с телефона.
      className={
        "grid gap-3 grid-cols-2 " + (canSeeMoney ? "lg:grid-cols-5" : "lg:grid-cols-3")
      }
    >
      <DayKpiCard
        eyebrow="Парк"
        value={
          <span className="mono-num">
            {totals.freeNow}
            <span className="text-base text-ink-3"> / {totals.vehiclesActive}</span>
          </span>
        }
        sub={
          totals.issuedNow > 0
            ? `свободны · ${totals.issuedNow} на выдаче`
            : inactive > 0
              ? `свободны · ${inactive} не активн${inactive === 1 ? "а" : "ы"}`
              : "свободны сейчас"
        }
      />

      <DayKpiCard
        eyebrow="Требуют внимания"
        value={<span className="mono-num">{totals.needAttention}</span>}
        sub={
          totals.needAttention > 0
            ? `${pluralize(totals.needAttention, "машина", "машины", "машин")} по обслуживанию`
            : "все машины в норме"
        }
        subTone={totals.needAttention > 0 ? "amber" : "muted"}
      />

      <DayKpiCard
        eyebrow="Пробег парка"
        value={
          <span className="mono-num">
            {totals.mileageDelta != null
              ? `${totals.mileageDelta.toLocaleString("ru-RU")} км`
              : "—"}
          </span>
        }
        sub={totals.mileageDelta != null ? periodLabel : "мало замеров за период"}
      />

      {canSeeMoney && (
        <>
          <DayKpiCard
            eyebrow="Заработал парк"
            value={<span className="mono-num">{formatRub(totals.revenue)}</span>}
            sub={`${periodLabel} · загрузка ${totals.utilizationPct} %`}
          />
          <DayKpiCard
            eyebrow="Итог"
            value={
              <span className="mono-num">
                {Number(totals.net ?? 0) > 0 ? "+" : ""}
                {formatRub(totals.net)}
              </span>
            }
            sub={`минус обслуживание ${formatRub(totals.serviceCost)}`}
            subTone={Number(totals.net ?? 0) < 0 ? "rose" : "muted"}
          />
        </>
      )}
    </div>
  );
}
