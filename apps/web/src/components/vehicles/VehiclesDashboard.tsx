"use client";

import Link from "next/link";

import { SectionHeader } from "../SectionHeader";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { pluralize } from "../../lib/format";
import { FleetKpiRow } from "./FleetKpiRow";
import { FleetPeriodToggle } from "./FleetPeriodToggle";
import { VehicleCard } from "./VehicleCard";
import { useFleetDashboard } from "./useFleetDashboard";
import { needsAttention, SERVICE_HEALTH_META, type FleetVehicle } from "./types";

/** Скелет карточки на время загрузки — держит высоту, чтобы сетка не прыгала. */
function CardSkeleton() {
  return (
    <div className="h-[420px] animate-pulse rounded-lg border border-border bg-surface shadow-xs" />
  );
}

/**
 * Лента внимания над сеткой: одна строка на машину, требующую действия.
 * Рендерится только при наличии повода — «всё в норме» не занимает экран.
 */
function AttentionBand({ vehicles }: { vehicles: FleetVehicle[] }) {
  const attention = vehicles.filter((v) => v.active && needsAttention(v.stats.serviceHealth));
  // «Интервал не задан» — не операционная тревога, а разовая настройка. Если таких
  // машин несколько, три одинаковых строки превращают ленту в шум: сворачиваем в одну.
  const noInterval = attention.filter((v) => v.stats.serviceHealth === "NO_INTERVAL");
  const rows = attention
    .filter((v) => v.stats.serviceHealth !== "NO_INTERVAL")
    .sort((a, b) => {
      // Просроченные — выше «скоро» и «нет записей».
      const rank = (h: string) => (h === "OVERDUE" ? 0 : h === "DUE_SOON" ? 1 : 2);
      return rank(a.stats.serviceHealth) - rank(b.stats.serviceHealth);
    });

  if (rows.length === 0 && noInterval.length === 0) return null;

  return (
    <ul className="space-y-2">
      {noInterval.length > 0 && (
        <li className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-subtle px-3 py-2 text-xs">
          <p className="text-ink-2">
            <span className="font-semibold text-ink">
              {noInterval.length === 1
                ? `${noInterval[0].name} — интервал ТО не задан`
                : `У ${noInterval.length} ${pluralize(noInterval.length, "машины", "машин", "машин")} не задан интервал ТО`}
            </span>{" "}
            · напоминания о следующем обслуживании пока не работают
          </p>
          <Link
            href={`/vehicles/${noInterval[0].id}`}
            className="shrink-0 font-medium text-accent-bright hover:text-accent"
          >
            Задать →
          </Link>
        </li>
      )}
      {rows.map((v) => {
        const meta = SERVICE_HEALTH_META[v.stats.serviceHealth];
        const isAlert = meta.tone === "alert";
        return (
          <li
            key={v.id}
            className={
              "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs " +
              (isAlert
                ? "border-rose-border bg-rose-soft"
                : "border-amber-border bg-amber-soft")
            }
          >
            <p className={isAlert ? "text-rose" : "text-amber"}>
              {/* Аббревиатуру «ТО» нельзя переводить в нижний регистр, поэтому
                  подписи хранятся готовыми к подстановке, без toLowerCase(). */}
              <span className="font-semibold">
                {v.name} — {meta.bandLabel}
              </span>
              {v.stats.serviceHealth === "OVERDUE" && v.stats.kmToNextService != null && v.stats.kmToNextService <= 0 && (
                <span className="text-ink-2">
                  {" · перепробег "}
                  <span className="mono-num">
                    {Math.abs(v.stats.kmToNextService).toLocaleString("ru-RU")} км
                  </span>
                </span>
              )}
              {v.stats.serviceHealth === "DUE_SOON" && v.stats.kmToNextService != null && (
                <span className="text-ink-2">
                  {" · осталось "}
                  <span className="mono-num">
                    {v.stats.kmToNextService.toLocaleString("ru-RU")} км
                  </span>
                </span>
              )}
              {v.stats.serviceHealth === "NO_INTERVAL" && (
                <span className="text-ink-2"> · задайте межсервисный интервал, чтобы включить напоминания</span>
              )}
              {v.stats.serviceHealth === "NO_SERVICE" && (
                <span className="text-ink-2"> · добавьте первую запись обслуживания</span>
              )}
            </p>
            <Link
              href={`/vehicles/${v.id}`}
              className={
                "shrink-0 font-medium " + (isAlert ? "text-rose hover:underline" : "text-amber hover:underline")
              }
            >
              Открыть →
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function VehiclesDashboard() {
  const { user } = useCurrentUser();
  const { data, error, loading, period, reload } = useFleetDashboard();
  const canSeeMoney = user?.role === "SUPER_ADMIN";
  const canEdit = user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE";

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <SectionHeader
        eyebrow="Автопарк"
        title="Машины"
        actions={
          <div className="flex items-center gap-2">
            <FleetPeriodToggle />
            {user?.role === "SUPER_ADMIN" && (
              <Link
                href="/admin/vehicles"
                className="text-xs font-medium text-accent-bright hover:text-accent"
              >
                Тарифы →
              </Link>
            )}
          </div>
        }
      />

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-sm text-rose">
          <span>{error}</span>
          <button
            type="button"
            onClick={reload}
            className="shrink-0 font-medium hover:underline"
          >
            Повторить
          </button>
        </div>
      )}

      {loading && !data && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: canSeeMoney ? 5 : 3 }).map((_, i) => (
              <div key={i} className="h-[74px] animate-pulse rounded-lg border border-border bg-surface" />
            ))}
          </div>
          <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </>
      )}

      {data && (
        <>
          <FleetKpiRow totals={data.totals} period={period} canSeeMoney={canSeeMoney} />

          <AttentionBand vehicles={data.vehicles} />

          {data.vehicles.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-strong bg-surface px-4 py-10 text-center">
              <p className="text-sm font-medium text-ink">В парке пока нет машин</p>
              <p className="mt-1 text-xs text-ink-3">
                Машины заводятся в разделе тарифов — там же задаются смена и генератор.
              </p>
              {user?.role === "SUPER_ADMIN" && (
                <Link
                  href="/admin/vehicles"
                  className="mt-3 inline-block text-xs font-medium text-accent-bright hover:text-accent"
                >
                  Перейти к тарифам →
                </Link>
              )}
            </div>
          ) : (
            <>
              <p className="eyebrow">
                {data.vehicles.length}{" "}
                {pluralize(data.vehicles.length, "машина", "машины", "машин")} в парке
              </p>
              <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
                {data.vehicles.map((v) => (
                  <VehicleCard
                    key={v.id}
                    vehicle={v}
                    period={period}
                    canSeeMoney={canSeeMoney}
                    canEdit={canEdit}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
