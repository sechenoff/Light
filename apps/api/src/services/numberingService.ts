import { prisma } from "../prisma";

const MAX_RETRIES = 5;

/**
 * Генерирует уникальный номер счёта в формате `${prefix}-${year}-${NNNN}`.
 * Год сбрасывает счётчик — LR-2026-0001, LR-2027-0001.
 * Защита от race conditions: транзакция + retry на P2002 (unique violation).
 */
export async function generateInvoiceNumber(prefix: string, year: number): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const number = await prisma.$transaction(async (tx) => {
        // Ищем последний номер за данный год по данному префиксу
        const yearPrefix = `${prefix}-${year}-`;
        const last = await tx.invoice.findFirst({
          where: { number: { startsWith: yearPrefix } },
          orderBy: { number: "desc" },
        });

        let nextSeq = 1;
        if (last) {
          // Парсим числовую часть из конца строки: "LR-2026-0042" → 42
          const suffix = last.number.slice(yearPrefix.length);
          const parsed = parseInt(suffix, 10);
          if (!isNaN(parsed)) {
            nextSeq = parsed + 1;
          }
        }

        return `${yearPrefix}${String(nextSeq).padStart(4, "0")}`;
      });

      return number;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "P2002" && attempt < MAX_RETRIES - 1) {
        // Уникальное нарушение — другой запрос уже занял этот номер, повторяем
        continue;
      }
      throw err;
    }
  }

  throw new Error(`generateInvoiceNumber: не удалось получить уникальный номер после ${MAX_RETRIES} попыток`);
}
