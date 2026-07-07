// Единый источник дефолтного окна проверки доступности: «сегодня 10:00 + offset».
// Раньше эта логика была скопирована в QuickAvailabilityCheck (defaultDatetimeLocal)
// и в каталоге /equipment. Держим её здесь, чтобы смена политики (напр. 8:00–20:00)
// правилась в одном месте.

export const DEFAULT_PICKUP_HOUR = 10;

/**
 * datetime-local строка «сегодня DEFAULT_PICKUP_HOUR:00», сдвинутая на offsetHours.
 * Сдвиг миллисекундами (один раз) — чтобы offset ≥ 24ч не переносил дату дважды.
 */
export function defaultDatetimeLocal(offsetHours = 0): string {
  const d = new Date();
  d.setHours(DEFAULT_PICKUP_HOUR, 0, 0, 0);
  d.setTime(d.getTime() + offsetHours * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

/** Дефолтное начало проверки — сегодня в DEFAULT_PICKUP_HOUR:00. */
export const defaultAvailabilityStart = (): string => defaultDatetimeLocal(0);

/** Дефолтный конец проверки — через сутки (завтра в DEFAULT_PICKUP_HOUR:00). */
export const defaultAvailabilityEnd = (): string => defaultDatetimeLocal(24);
