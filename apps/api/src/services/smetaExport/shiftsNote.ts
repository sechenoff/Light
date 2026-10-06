/**
 * Подписи срока строки сметы — общие для PDF и XLSX. Отдельный листовой модуль
 * без зависимостей: рендеры не тянут через buildDocument базу (lineOrder).
 */

/** «смена / смены / смен» для числа. */
export function pluralShifts(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "смена";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "смены";
  return "смен";
}

/**
 * Подпись строки о её сроке — общая для PDF и XLSX:
 *  - своя позиция в брони больше чем на смену: «цена за весь срок аренды»
 *    (колонка «цена / смена» показывает её фиксированную цену);
 *  - каталожная строка со своим числом смен (только для XLSX: в PDF для этого
 *    есть колонка «Смен») — «на 2 смены».
 */
export function lineShiftsNote(
  line: { shifts: number | null },
  doc: { shiftsCount: number; showShiftsColumn: boolean },
  opts: { withCount: boolean },
): string | null {
  if (line.shifts == null) return doc.shiftsCount > 1 ? "цена за весь срок аренды" : null;
  if (opts.withCount && doc.showShiftsColumn && line.shifts !== Math.max(1, doc.shiftsCount)) {
    return `на ${line.shifts} ${pluralShifts(line.shifts)}`;
  }
  return null;
}

/**
 * Вторая строка под названием позиции: персональная скидка и/или срок строки.
 * Обе подписи бывают у одной строки (договорная цена на свои смены) — тогда
 * через « · », иначе читатель XLSX не сведёт «кол-во × цена» с суммой.
 */
export function lineNote(
  line: { shifts: number | null; listPricePerShift?: string | null },
  doc: { shiftsCount: number; showShiftsColumn: boolean },
  opts: { withCount: boolean; rub: (v: string) => string },
): string | null {
  const parts = [
    line.listPricePerShift ? `персональная скидка · цена до скидки ${opts.rub(line.listPricePerShift)}` : null,
    lineShiftsNote(line, doc, { withCount: opts.withCount }),
  ].filter((p): p is string => p != null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
