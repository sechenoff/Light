import Decimal from "decimal.js";
import type { MatchedItem } from "./equipmentMatcher";

// ── Типы ──────────────────────────────────────────────────────────────────────

export type EstimateLine = {
  equipmentId: string;
  /** Имя из каталога */
  name: string;
  category: string;
  quantity: number;
  /** Ставка аренды за 1 смену на единицу, руб. */
  ratePerShift: string;
  /** Итог строки = ratePerShift × quantity */
  lineTotal: string;
  /** true если позиция подобрана как аналог (не точное совпадение) */
  isAnalog: boolean;
};

export type EstimateResult = {
  lines: EstimateLine[];
  /** Итоговая сумма за 1 смену, руб. */
  grandTotal: string;
  currency: "RUB";
  /**
   * Пометка «ориентировочный расчёт».
   * Всегда присутствует — смета на основе AI-анализа не является точным предложением.
   */
  disclaimer: string;
};

// ── Расчёт ────────────────────────────────────────────────────────────────────

const DISCLAIMER =
  "⚠️ Ориентировочный расчёт на основе вероятной реконструкции освещения. " +
  "Точная стоимость определяется менеджером после уточнения состава и дат.";

/**
 * Строит детализированную смету из списка сопоставленного оборудования.
 *
 * Правила:
 * - Расчёт за 1 смену (MVP; логистика и налоги не включаются)
 * - Если позиция — аналог (matchType === "analog"), отмечается isAnalog=true
 * - Все суммы в рублях, строки через Decimal для точности
 */
export function buildEstimate(items: MatchedItem[]): EstimateResult {
  let grandTotal = new Decimal(0);

  const lines: EstimateLine[] = items.map((item) => {
    const rate = new Decimal(item.rentalRatePerShift);
    const lineTotal = rate.mul(item.quantity);
    grandTotal = grandTotal.add(lineTotal);

    return {
      equipmentId: item.equipmentId,
      name: item.catalogName,
      category: item.category,
      quantity: item.quantity,
      ratePerShift: rate.toFixed(0),
      lineTotal: lineTotal.toFixed(0),
      isAnalog: item.matchType === "analog",
    };
  });

  return {
    lines,
    grandTotal: grandTotal.toFixed(0),
    currency: "RUB",
    disclaimer: DISCLAIMER,
  };
}

/**
 * Форматирует смету в читаемый текст для Telegram-сообщения.
 */
export function formatEstimateText(estimate: EstimateResult): string {
  const lineItems = estimate.lines
    .map((l) => {
      const analog = l.isAnalog ? " _(аналог)_" : "";
      const rate = Number(l.ratePerShift).toLocaleString("ru-RU");
      const total = Number(l.lineTotal).toLocaleString("ru-RU");
      return `• ${l.name}${analog} × ${l.quantity} шт — ${rate} ₽ → *${total} ₽*`;
    })
    .join("\n");

  const grand = Number(estimate.grandTotal).toLocaleString("ru-RU");

  return [lineItems, `\n*Итого за 1 смену: ${grand} ₽*`].join("\n");
}
