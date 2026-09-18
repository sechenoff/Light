import Decimal from "decimal.js";
import { HttpError } from "../utils/errors";

export const DAY_MS = 86_400_000;
export function projectDate(value: string): string {
  const parsed = new Date(value + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new HttpError(400, "Некорректная дата проекта");
  }
  return value;
}
export function nextDate(value: string, days = 1): string {
  return new Date(
    new Date(projectDate(value) + "T00:00:00Z").getTime() + days * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
}
export function projectMidnight(value: string): Date {
  return new Date(projectDate(value) + "T00:00:00+03:00");
}
export function projectDates(from: string, through: string): string[] {
  projectDate(from);
  projectDate(through);
  const n = (new Date(through).getTime() - new Date(from).getTime()) / DAY_MS;
  if (n < 0 || n > 730)
    throw new HttpError(400, "Период должен быть от 1 до 731 дня");
  return Array.from({ length: n + 1 }, (_, i) => nextDate(from, i));
}
export function defaultDayKind(date: string): "SHOOT" | "REST" {
  return [0, 6].includes(new Date(date + "T00:00:00Z").getUTCDay())
    ? "REST"
    : "SHOOT";
}
export type PriceLot = {
  id: string;
  nameSnapshot: string;
  quantity: number;
  ratePerShift: { toString(): string } | string;
  fromDate: string;
  throughDate: string;
  status: string;
  returns: Array<{ quantity: number; lastBillableDate: string }>;
};
export type ProjectPriceLine = {
  lotId?: string;
  name: string;
  quantity: number;
  fromDate: string;
  throughDate: string;
  shootDays: number;
  restDays: number;
  restFactor: string;
  rate: string;
  amount: string;
};
export function priceProject(args: {
  fromDate: string;
  throughDate: string;
  restFactor: { toString(): string } | string;
  days: Array<{ date: string; kind: string }>;
  lots: PriceLot[];
  actual?: boolean;
}): { lines: ProjectPriceLine[]; total: string } {
  const days = new Map(args.days.map((d) => [d.date, d.kind]));
  const factor = new Decimal(args.restFactor.toString());
  const lines: ProjectPriceLine[] = [];
  for (const lot of args.lots) {
    if (
      lot.status === "CANCELLED" ||
      (args.actual && !["ISSUED", "RETURNED"].includes(lot.status))
    )
      continue;
    const remaining =
      lot.quantity - lot.returns.reduce((s, r) => s + r.quantity, 0);
    const pieces = [
      ...lot.returns.map((r) => ({
        quantity: r.quantity,
        through: r.lastBillableDate,
      })),
      { quantity: remaining, through: lot.throughDate },
    ];
    for (const piece of pieces) {
      const from = [lot.fromDate, args.fromDate].sort().at(-1)!;
      const through = [piece.through, args.throughDate].sort()[0]!;
      if (piece.quantity <= 0 || from > through) continue;
      const dates = projectDates(from, through);
      const restDays = dates.filter(
        (d) => (days.get(d) ?? defaultDayKind(d)) === "REST",
      ).length;
      const shootDays = dates.length - restDays;
      const amount = new Decimal(lot.ratePerShift.toString())
        .mul(piece.quantity)
        .mul(new Decimal(shootDays).add(factor.mul(restDays)))
        .toFixed(2);
      lines.push({
        lotId: lot.id,
        name: lot.nameSnapshot,
        quantity: piece.quantity,
        fromDate: from,
        throughDate: through,
        shootDays,
        restDays,
        restFactor: factor.toString(),
        rate: lot.ratePerShift.toString(),
        amount,
      });
    }
  }
  return {
    lines,
    total: lines
      .reduce((sum, l) => sum.add(l.amount), new Decimal(0))
      .toFixed(2),
  };
}
export function suggestedPeriodEnd(
  from: string,
  cycle: string,
  projectEnd: string,
): string {
  let end = nextDate(from, 6);
  if (cycle === "MONTHLY") {
    const date = new Date(from + "T00:00:00Z");
    end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
  }
  return end < projectEnd ? end : projectEnd;
}
