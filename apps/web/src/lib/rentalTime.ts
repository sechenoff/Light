/** Должно совпадать с apps/api/src/utils/dates.ts (24 ч = 1 смена). */
const MS_PER_RENTAL_SHIFT = 24 * 60 * 60 * 1000;

export function billableShifts24h(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / MS_PER_RENTAL_SHIFT));
}

export function formatRentalDurationDetails(start: Date, end: Date): {
  shifts: number;
  totalHours: number;
  labelShort: string;
} {
  const ms = end.getTime() - start.getTime();
  const shifts = billableShifts24h(start, end);
  const totalHours = ms / (60 * 60 * 1000);
  const fullDays = Math.floor(ms / MS_PER_RENTAL_SHIFT);
  const remAfterDays = ms % MS_PER_RENTAL_SHIFT;
  const wholeHoursRemainder = Math.floor(remAfterDays / (60 * 60 * 1000));
  const minutesRemainder = Math.round((remAfterDays % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (fullDays > 0) parts.push(`${fullDays} сут.`);
  if (wholeHoursRemainder > 0) parts.push(`${wholeHoursRemainder} ч.`);
  if (fullDays === 0 && wholeHoursRemainder === 0 && minutesRemainder > 0) {
    parts.push(`${minutesRemainder} мин.`);
  }
  const durationPart = parts.length > 0 ? parts.join(" ") : "менее 1 ч.";

  const shiftWord =
    shifts % 10 === 1 && shifts % 100 !== 11
      ? "смена"
      : shifts % 10 >= 2 && shifts % 10 <= 4 && (shifts % 100 < 10 || shifts % 100 >= 20)
        ? "смены"
        : "смен";
  const labelShort = `${durationPart} · ${shifts} ${shiftWord} (по 24 ч)`;
  return { shifts, totalHours, labelShort };
}

function pluralShiftWord(shifts: number): string {
  if (shifts % 10 === 1 && shifts % 100 !== 11) return "смена";
  if (shifts % 10 >= 2 && shifts % 10 <= 4 && (shifts % 100 < 10 || shifts % 100 >= 20)) return "смены";
  return "смен";
}

/** Должно совпадать с apps/api/src/utils/dates.ts — строка для PDF/XLSX. */
export function formatExportHourCalculationLine(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const shifts = billableShifts24h(start, end);
  const fullDays = Math.floor(ms / MS_PER_RENTAL_SHIFT);
  const remAfterDays = ms % MS_PER_RENTAL_SHIFT;
  const wholeHoursRemainder = Math.floor(remAfterDays / (60 * 60 * 1000));
  const minutesRemainder = Math.round((remAfterDays % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (fullDays > 0) parts.push(`${fullDays} сут.`);
  if (wholeHoursRemainder > 0) parts.push(`${wholeHoursRemainder} ч.`);
  if (fullDays === 0 && wholeHoursRemainder === 0 && minutesRemainder > 0) {
    parts.push(`${minutesRemainder} мин.`);
  }
  const durationPart = parts.length > 0 ? parts.join(" ") : "менее 1 ч.";
  const w = pluralShiftWord(shifts);
  return `${shifts} ${w} = 24 ч. · ${durationPart} · ${shifts} ${w} (по 24 ч)`;
}

export function defaultPickupDatetimeLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:00`;
}

export function addHoursToDatetimeLocal(local: string, hours: number): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  d.setTime(d.getTime() + hours * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

export function datetimeLocalToISO(local: string): string | null {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function dateToDatetimeLocalValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

/** ?start= / ?end= — ISO или YYYY-MM-DD (тогда 10:00 локально). */
export function pickupFromSearchParam(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  const d = new Date(raw.includes("T") ? raw : `${raw}T10:00`);
  if (Number.isNaN(d.getTime())) return fallback;
  return dateToDatetimeLocalValue(d);
}

export function returnFromSearchParam(raw: string | null, pickup: string): string {
  if (!raw) return addHoursToDatetimeLocal(pickup, 24);
  const d = new Date(raw.includes("T") ? raw : `${raw}T10:00`);
  if (Number.isNaN(d.getTime())) return addHoursToDatetimeLocal(pickup, 24);
  return dateToDatetimeLocalValue(d);
}
