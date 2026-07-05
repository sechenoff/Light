/**
 * unitStatus.ts — единый глоссарий статусов единиц техники для UI.
 * Канон подписей (женский род, по образцу financeTerms.ts):
 *   AVAILABLE   → «Доступна»
 *   ISSUED      → «Выдана»
 *   MAINTENANCE → «В ремонте»
 *   RETIRED     → «Списана»
 *   MISSING     → «Утеряна»
 *
 * Раньше подписи расходились по файлам («на складе» / «Доступен», «ремонт» /
 * «Обслуживание», род прыгал). Держим один источник правды.
 */
import type { StatusPillVariant } from "../components/StatusPill";

export type UnitStatus = "AVAILABLE" | "ISSUED" | "MAINTENANCE" | "RETIRED" | "MISSING";

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  AVAILABLE: "Доступна",
  ISSUED: "Выдана",
  MAINTENANCE: "В ремонте",
  RETIRED: "Списана",
  MISSING: "Утеряна",
};

export const UNIT_STATUS_VARIANTS: Record<UnitStatus, StatusPillVariant> = {
  AVAILABLE: "full",
  ISSUED: "limited",
  MAINTENANCE: "warn",
  RETIRED: "none",
  MISSING: "alert",
};

/** Подпись статуса; неизвестный код возвращается как есть (не роняем UI). */
export function unitStatusLabel(status: string): string {
  return UNIT_STATUS_LABELS[status as UnitStatus] ?? status;
}

/** Вариант StatusPill для статуса; неизвестный → «none». */
export function unitStatusVariant(status: string): StatusPillVariant {
  return UNIT_STATUS_VARIANTS[status as UnitStatus] ?? "none";
}
