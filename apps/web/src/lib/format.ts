export function formatMoneyRub(value: number | string | null | undefined | unknown) {
  if (value == null) return "0.00";
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "0.00";
  }
  const s = String(value).trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Форматирует сумму в рублях: «1 234 567 ₽» (без копеек, локаль ru-RU).
 */
export function formatRub(value: string | number | null | undefined): string {
  if (value == null) return "0 ₽";
  const n = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return "0 ₽";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(n);
}

/**
 * Выбирает форму по числу: 1 → one, 2-4 → few, прочее → many.
 * Пример: pluralize(5, "день", "дня", "дней") → "дней".
 *
 * Обычно используется вместе со значением: `${n} ${pluralize(n, ...)}`.
 */
export function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Возвращает метку «времени ожидания» для брони в статусе PENDING_APPROVAL.
 * Использует submittedAt если доступен, иначе createdAt.
 * Возвращает null если оба аргумента null/undefined.
 */
export function formatWaitingTime(
  submittedAt: string | null | undefined,
  createdAt: string | null | undefined,
): { text: string; className: string } | null {
  const ref = submittedAt ?? createdAt;
  if (!ref) return null;
  const now = new Date();
  const submitted = new Date(ref);
  const diffMs = now.getTime() - submitted.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays >= 2) {
    return {
      text: `${diffDays} ${pluralize(diffDays, "день", "дня", "дней")}`,
      className: "text-rose font-medium",
    };
  } else if (diffDays >= 1) {
    return { text: "1 день", className: "text-amber font-medium" };
  } else {
    return { text: "сегодня", className: "text-ink-3" };
  }
}

/**
 * Русские названия месяцев в предложном падеже («в январе», «в феврале», …).
 * Индекс 0..11 соответствует `Date#getMonth()`.
 */
export const MONTHS_LOCATIVE = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
] as const;

