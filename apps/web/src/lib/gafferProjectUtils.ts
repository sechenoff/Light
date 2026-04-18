import { formatRub } from "./format";

/** Pill descriptor for debt display */
export interface DebtPill {
  label: string;
  colorClass: string;
}

/**
 * Returns a debt pill for the client side of a project.
 * - remaining > 0 → rose «Клиент должен: N ₽»
 * - plan > 0 and remaining = 0 → emerald «Оплачено»
 * - plan = 0 → null (neutral, no pill)
 */
export function clientDebtVariant(
  clientPlanAmount: string | number,
  clientRemaining: string | number,
): DebtPill | null {
  const plan = Number(clientPlanAmount);
  const remaining = Number(clientRemaining);

  if (remaining > 0) {
    return {
      label: `Клиент должен: ${formatRub(remaining)}`,
      colorClass: "bg-rose-soft text-rose border-rose-border",
    };
  }
  if (plan > 0 && remaining === 0) {
    return {
      label: "Оплачено",
      colorClass: "bg-emerald-soft text-emerald border-emerald-border",
    };
  }
  return null;
}

/**
 * Returns a debt pill for the team side of a project.
 * - remaining > 0 → amber «Команде: N ₽»
 * - plan > 0 and remaining = 0 → emerald «Выплачено»
 * - plan = 0 → null (neutral)
 */
export function teamDebtVariant(
  teamPlanTotal: string | number,
  teamRemaining: string | number,
): DebtPill | null {
  const plan = Number(teamPlanTotal);
  const remaining = Number(teamRemaining);

  if (remaining > 0) {
    return {
      label: `Команде: ${formatRub(remaining)}`,
      colorClass: "bg-amber-soft text-amber border-amber-border",
    };
  }
  if (plan > 0 && remaining === 0) {
    return {
      label: "Выплачено",
      colorClass: "bg-emerald-soft text-emerald border-emerald-border",
    };
  }
  return null;
}

/**
 * Formats a shoot date (ISO string or YYYY-MM-DD) as a Russian short date:
 * «15 июл 2026»
 */
export function formatShootDate(
  date: string | null | undefined,
): string {
  if (!date) return "";
  // Append time so Date parsing is not timezone-shifted on date-only strings
  const d = new Date(date.includes("T") ? date : `${date}T00:00:00`);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}
