"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { StatusPill } from "../StatusPill";
import { formatRub, pluralize } from "../../lib/format";
import { OccupancyStrip } from "./OccupancyStrip";
import {
  SERVICE_HEALTH_META,
  SERVICE_KIND_LABEL,
  type FleetPeriodValue,
  type FleetVehicle,
  FLEET_PERIOD_LABEL,
} from "./types";

function formatKm(n: number): string {
  return `${n.toLocaleString("ru-RU")} км`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Moscow",
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

/** Цветной рельс слева — светофор состояния. Цветом кричат только проблемы. */
const STRIPE_CLASS: Record<string, string> = {
  ok: "bg-border",
  warn: "bg-amber",
  alert: "bg-rose",
  none: "bg-border-strong",
};

/** Зона карточки с надстрочником. */
function Zone({
  label,
  aside,
  children,
  className = "",
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-4 py-3 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <p className="eyebrow">{label}</p>
        {aside && <span className="text-[11px] text-ink-3">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

function WrenchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden="true">
      <path
        d="M10.5 1.5a3.5 3.5 0 0 0-3.2 4.9L1.9 11.8a1.3 1.3 0 0 0 1.9 1.9l5.4-5.4a3.5 3.5 0 0 0 4.4-4.5l-2 2-1.9-.5-.5-1.9 2-2a3.5 3.5 0 0 0-.7-.1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden="true">
      <path d="M8 5.5v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.2" r=".8" fill="currentColor" />
      <path
        d="M7 2.2 1.4 12a1.1 1.1 0 0 0 1 1.7h11.2a1.1 1.1 0 0 0 1-1.7L9 2.2a1.1 1.1 0 0 0-2 0Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Полоса выработки межсервисного ресурса. Пустая, если интервал не задан —
 * не рисуем шкалу, для которой нет масштаба.
 */
function ServiceGauge({ used, total }: { used: number; total: number }) {
  const ratio = Math.max(0, Math.min(1, used / total));
  const tone = ratio >= 1 ? "bg-rose" : ratio >= 0.8 ? "bg-amber" : "bg-emerald";
  return (
    <div className="mt-1.5">
      <div className="h-1.5 rounded-full bg-surface-subtle overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-ink-3 mono-num">
        {formatKm(used)} из {formatKm(total)}
      </p>
    </div>
  );
}

export function VehicleCard({
  vehicle,
  period,
  canSeeMoney,
  canEdit,
}: {
  vehicle: FleetVehicle;
  period: FleetPeriodValue;
  canSeeMoney: boolean;
  /** Может записывать пробег и ТО (SUPER_ADMIN / WAREHOUSE). Техник — только чтение. */
  canEdit: boolean;
}) {
  const { stats } = vehicle;
  const health = SERVICE_HEALTH_META[stats.serviceHealth];
  const current = vehicle.upcomingBookings.find((b) => b.isCurrent) ?? null;
  const next = vehicle.upcomingBookings.find((b) => !b.isCurrent) ?? null;

  const occupancyPill = !vehicle.active
    ? { variant: "none" as const, label: "Не активна" }
    : current
      ? { variant: "info" as const, label: "Выдана" }
      : stats.occupancy[0]
        ? { variant: "info" as const, label: "Занята сегодня" }
        : { variant: "ok" as const, label: "Свободна" };

  // Тревожная плашка — только когда есть что сказать. «Норма» молчит.
  const flag =
    stats.serviceHealth === "OVERDUE"
      ? {
          tone: "rose" as const,
          title: "Пора на ТО",
          text:
            stats.kmToNextService != null && stats.kmToNextService <= 0
              ? `Межсервисный интервал выбран, перепробег ${formatKm(Math.abs(stats.kmToNextService))}.`
              : `С последнего обслуживания прошло ${stats.daysSinceService} ${pluralize(stats.daysSinceService ?? 0, "день", "дня", "дней")}.`,
        }
      : stats.serviceHealth === "DUE_SOON"
        ? {
            tone: "amber" as const,
            title: "Скоро ТО",
            text: `Осталось ${formatKm(stats.kmToNextService ?? 0)} до планового обслуживания.`,
          }
        : stats.serviceHealth === "NO_SERVICE"
          ? {
              tone: "amber" as const,
              title: "Нет записей о ТО",
              text: "Интервал задан, но обслуживание ни разу не записывали — считать ресурс не от чего.",
            }
          : stats.serviceHealth === "NO_INTERVAL"
            ? {
                // Не тревога, а настройка: машина исправна, система просто не знает,
                // через сколько км напоминать. Поэтому нейтральный тон, не amber.
                tone: "slate" as const,
                title: "Интервал ТО не задан",
                text: "Укажите межсервисный интервал — появится прогноз следующего обслуживания.",
              }
            : null;

  return (
    <article className="relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
      <span
        className={`absolute inset-y-0 left-0 w-1 ${STRIPE_CLASS[health.tone]}`}
        aria-hidden="true"
      />

      {/* Шапка: имя, номер, статус занятости, тариф */}
      <div className="pl-5 pr-4 pt-3 pb-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-[15px] font-semibold text-ink leading-tight">{vehicle.name}</h3>
              {vehicle.licensePlate?.trim() && (
                <span className="mono-num rounded border border-border bg-surface-subtle px-1.5 py-0.5 text-[11px] text-ink-2">
                  {vehicle.licensePlate}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-2">
              <span className="mono-num font-medium text-ink">{formatRub(vehicle.shiftPriceRub)}</span>
              <span className="text-ink-3"> / смена · {vehicle.shiftHours} ч · переработка +{Number(vehicle.overtimePercent)} %</span>
              {vehicle.hasGeneratorOption && vehicle.generatorPriceRub && (
                <span className="text-ink-3">
                  {" · генератор "}
                  <span className="mono-num">{formatRub(vehicle.generatorPriceRub)}</span>
                </span>
              )}
            </p>
          </div>
          <StatusPill variant={occupancyPill.variant} label={occupancyPill.label} />
        </div>
        {vehicle.notes?.trim() && (
          <p className="mt-1.5 line-clamp-2 text-xs text-ink-3">{vehicle.notes}</p>
        )}
      </div>

      {flag && (
        <div
          className={
            "flex items-start gap-2 border-y px-4 py-2 text-xs " +
            (flag.tone === "rose"
              ? "border-rose-border bg-rose-soft text-rose"
              : flag.tone === "amber"
                ? "border-amber-border bg-amber-soft text-amber"
                : "border-border bg-surface-subtle text-ink-2")
          }
        >
          <span className="mt-0.5">
            <AlertIcon />
          </span>
          <p>
            <span className="font-semibold">{flag.title}.</span> <span className="text-ink-2">{flag.text}</span>
          </p>
        </div>
      )}

      {/* Занятость */}
      <Zone label="Занятость" aside="ближайшие 14 дней" className="border-t border-border">
        <p className="text-sm text-ink">
          {current ? (
            <>
              На выдаче до{" "}
              <span className="mono-num">{formatShortDate(current.endDate)}</span>
            </>
          ) : stats.occupancy[0] ? (
            "Занята сегодня"
          ) : (
            "Свободна сегодня"
          )}
        </p>
        <OccupancyStrip occupancy={stats.occupancy} className="mt-2" />
        {(current ?? next) ? (
          <Link
            href={`/bookings/${(current ?? next)!.bookingId}`}
            className="mt-2 block text-xs text-accent-bright hover:text-accent"
          >
            {current ? "Сейчас: " : "Ближайшая: "}
            <span className="font-medium">
              {(current ?? next)!.clientName ?? (current ?? next)!.projectName}
            </span>
            <span className="mono-num text-ink-3">
              {" "}
              {formatShortDate((current ?? next)!.startDate)}–{formatShortDate((current ?? next)!.endDate)}
            </span>
          </Link>
        ) : (
          <p className="mt-2 text-xs text-ink-3">Броней на ближайшие 14 дней нет</p>
        )}
      </Zone>

      {/* Пробег + обслуживание */}
      <div className="grid grid-cols-1 sm:grid-cols-2 border-t border-border divide-y sm:divide-y-0 sm:divide-x divide-border">
        <Zone label="Пробег">
          <p className="mono-num text-lg font-semibold text-ink leading-none">
            {formatKm(vehicle.currentMileage)}
          </p>
          {stats.mileageDelta != null ? (
            <p className="mt-1.5 text-xs text-ink-2">
              <span className="mono-num">+{stats.mileageDelta.toLocaleString("ru-RU")} км</span>{" "}
              <span className="text-ink-3">{FLEET_PERIOD_LABEL[period]}</span>
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-ink-3">
              {stats.mileageSamples > 0
                ? "Мало замеров, чтобы посчитать пробег за период"
                : "Замеров пробега нет"}
            </p>
          )}
        </Zone>

        <Zone
          label="Обслуживание"
          aside={
            stats.serviceHealth === "OK" || stats.serviceHealth === "DUE_SOON"
              ? health.label
              : undefined
          }
        >
          {stats.kmToNextService != null && vehicle.serviceIntervalKm != null ? (
            <>
              <p
                className={
                  "mono-num text-lg font-semibold leading-none " +
                  (stats.kmToNextService <= 0
                    ? "text-rose"
                    : stats.serviceHealth === "DUE_SOON"
                      ? "text-amber"
                      : "text-ink")
                }
              >
                {stats.kmToNextService > 0
                  ? `Ещё ${formatKm(stats.kmToNextService)}`
                  : `Перепробег ${formatKm(Math.abs(stats.kmToNextService))}`}
              </p>
              <ServiceGauge
                used={stats.kmSinceService ?? 0}
                total={vehicle.serviceIntervalKm}
              />
            </>
          ) : (
            <p className="text-sm text-ink-3">
              {vehicle.serviceIntervalKm == null ? "Интервал не задан" : "Обслуживание не записывали"}
            </p>
          )}

          {vehicle.lastServiceAt ? (
            <p className="mt-2 text-xs text-ink-2">
              <span className="mono-num">{formatDate(vehicle.lastServiceAt)}</span>
              {vehicle.lastServiceKind && (
                <span className="text-ink-3">
                  {" · "}
                  {SERVICE_KIND_LABEL[vehicle.lastServiceKind] ?? vehicle.lastServiceKind}
                </span>
              )}
              {stats.daysSinceService != null && (
                <span className="text-ink-3">
                  {" · "}
                  {stats.daysSinceService} {pluralize(stats.daysSinceService, "день", "дня", "дней")} назад
                </span>
              )}
            </p>
          ) : (
            <p className="mt-2 text-xs text-ink-3">Записей об обслуживании ещё нет</p>
          )}
        </Zone>
      </div>

      {/* Экономика — только для роли с доступом к финансам */}
      {canSeeMoney && (
        <Zone
          label={`Экономика ${FLEET_PERIOD_LABEL[period]}`}
          className="border-t border-border bg-surface-muted"
        >
          <div className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-[11px] text-ink-3">Заработала</p>
              {/* Прочерк, когда броней не было вовсе: «0 ₽» читалось бы как
                  «поработала и не заработала», а это разные вещи. */}
              <p className="mono-num text-sm font-semibold text-ink">
                {stats.bookingsCount > 0 ? formatRub(stats.revenue) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-ink-3">Обслуживание</p>
              <p className="mono-num text-sm font-semibold text-ink-2">
                {stats.serviceCount > 0 ? formatRub(stats.serviceCost) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-ink-3">Итог</p>
              <p
                className={
                  "mono-num text-sm font-semibold " +
                  (Number(stats.net ?? 0) < 0
                    ? "text-rose"
                    : Number(stats.net ?? 0) > 0
                      ? "text-emerald"
                      : "text-ink-2")
                }
              >
                {stats.bookingsCount > 0 || stats.serviceCount > 0 ? (
                  <>
                    {Number(stats.net ?? 0) > 0 ? "+" : ""}
                    {formatRub(stats.net)}
                  </>
                ) : (
                  "—"
                )}
              </p>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            {stats.bookingsCount > 0 ? (
              <>
                {stats.rentedDays} {pluralize(stats.rentedDays, "день", "дня", "дней")} аренды ·
                загрузка <span className="mono-num">{stats.utilizationPct} %</span>
              </>
            ) : (
              <>За период машина ни разу не выезжала на бронь</>
            )}
          </p>
        </Zone>
      )}

      {/* Футер действий. Кнопки высотой 36 px — на складе страницу открывают
          с телефона, текстовые ссылки в 15 px там не попадаемы пальцем.
          Ссылки ведут на карточку машины и сразу раскрывают нужную форму. */}
      <div className="mt-auto border-t border-border px-4 py-2.5">
        {canEdit && (
          <div className="flex gap-2">
            <Link
              href={`/vehicles/${vehicle.id}?action=service`}
              className={
                "inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded border px-3 text-xs font-medium transition-colors " +
                (stats.serviceHealth === "OVERDUE"
                  ? "border-transparent bg-accent-bright text-white hover:bg-accent"
                  : "border-border bg-surface text-ink-2 hover:border-accent hover:text-accent")
              }
            >
              <WrenchIcon />
              Записать ТО
            </Link>
            <Link
              href={`/vehicles/${vehicle.id}?action=mileage`}
              className="inline-flex h-9 flex-1 items-center justify-center rounded border border-border bg-surface px-3 text-xs font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
            >
              Записать пробег
            </Link>
          </div>
        )}
        <div className={"flex items-center justify-between gap-2 " + (canEdit ? "mt-2" : "")}>
          <span className="text-[11px] text-ink-3">
            {stats.serviceCount > 0
              ? `${stats.serviceCount} ${pluralize(stats.serviceCount, "запись", "записи", "записей")} ${FLEET_PERIOD_LABEL[period]}`
              : `Без обслуживания ${FLEET_PERIOD_LABEL[period]}`}
          </span>
          <Link
            href={`/vehicles/${vehicle.id}`}
            className="inline-flex h-9 items-center text-xs font-medium text-accent-bright hover:text-accent"
          >
            Открыть карточку →
          </Link>
        </div>
      </div>
    </article>
  );
}
