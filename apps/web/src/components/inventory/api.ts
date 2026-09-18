/**
 * Обёртки над /api/stock-counts (десктоп, cookie-сессия SA / WAREHOUSE).
 *
 * Контракт — спека §6; типы ответов — ./types (зеркало сервера). Ошибки
 * пробрасываются как есть (ApiFetchError: status / code / details), а
 * человеческий текст для тоста даёт `explainInventoryError`.
 */

import { apiFetch } from "../../lib/api";
import { signed } from "./format";
import type {
  CompleteResult,
  Decision,
  EquipmentTrail,
  StockCountDetail,
  StockCountLineFilter,
  StockCountLineView,
  StockCountScope,
  StockCountSummary,
  TrailSuggestion,
} from "./types";

const BASE = "/api/stock-counts";

function path(id: string, rest = ""): string {
  return `${BASE}/${encodeURIComponent(id)}${rest}`;
}

function linePath(id: string, lineId: string, action: string): string {
  return path(id, `/lines/${encodeURIComponent(lineId)}/${action}`);
}

function post(body?: unknown): RequestInit {
  return { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) };
}

export interface DecisionBody {
  decision: Decision | null;
  note?: string | null;
  sourceBookingId?: string | null;
  /** Счёт строки, который видел руководитель (обязателен для решения, не для снятия). */
  seenCountedQty?: number;
  /** «На полке должно быть», которое он видел (снапшот строки). */
  seenExpectedQty?: number;
  /** «Оставить как посчитано»: учёт изменился после счёта, решение — по счёту. */
  acknowledgeBooksChanged?: boolean;
}

export const inventoryApi = {
  list: () => apiFetch<{ items: StockCountSummary[] }>(BASE),
  active: () => apiFetch<{ stockCount: StockCountDetail | null }>(`${BASE}/active`),
  start: (categories: string[] | null) =>
    apiFetch<{ stockCount: StockCountDetail }>(BASE, post({ categories })),
  detail: (id: string) => apiFetch<{ stockCount: StockCountDetail }>(path(id)),
  lines: (id: string, opts: { category?: string; filter?: StockCountLineFilter } = {}) => {
    const params = new URLSearchParams();
    if (opts.category) params.set("category", opts.category);
    if (opts.filter && opts.filter !== "all") params.set("filter", opts.filter);
    const qs = params.toString();
    return apiFetch<{ lines: StockCountLineView[] }>(path(id, `/lines${qs ? `?${qs}` : ""}`));
  },
  count: (id: string, lineId: string, qty: number) =>
    apiFetch<{ line: StockCountLineView }>(linePath(id, lineId, "count"), post({ qty })),
  reset: (id: string, lineId: string) =>
    apiFetch<{ line: StockCountLineView }>(linePath(id, lineId, "reset"), post()),
  /** «Обновить ожидание»: снапшот заново по живому учёту, счёт остаётся. */
  refreshExpected: (id: string, lineId: string) =>
    apiFetch<{ line: StockCountLineView }>(linePath(id, lineId, "refresh-expected"), post()),
  decide: (id: string, lineId: string, body: DecisionBody) =>
    apiFetch<{ line: StockCountLineView }>(linePath(id, lineId, "decision"), post(body)),
  trail: (id: string, lineId: string) =>
    apiFetch<{ trail: EquipmentTrail }>(linePath(id, lineId, "trail")),
  /** Подсказки «Как пропало» для всех недостач разом: lineId → бронь или null. */
  trailSuggestions: (id: string) =>
    apiFetch<{ suggestions: Record<string, TrailSuggestion | null> }>(path(id, "/trail-suggestions")),
  complete: (id: string) =>
    apiFetch<{ stockCount: StockCountDetail; result: CompleteResult }>(path(id, "/complete"), post()),
  cancel: (id: string) => apiFetch<{ stockCount: StockCountDetail }>(path(id, "/cancel"), post()),
  /** Охват для старта: категории и сколько в них позиций с учётом количеством. */
  scope: () => apiFetch<StockCountScope>(`${BASE}/scope`),
};

/** Акт — PDF (черновик, пока инвентаризация идёт) и XLSX. Строит другой поток. */
export function actPdfUrl(id: string): string {
  return path(id, "/act.pdf");
}

export function actXlsxUrl(id: string): string {
  return path(id, "/act.xlsx");
}

// ── Ошибки ───────────────────────────────────────────────────────────────────

interface ErrorShape {
  status?: number;
  code?: string;
  details?: unknown;
  message?: string;
}

function asErrorShape(e: unknown): ErrorShape {
  return typeof e === "object" && e !== null ? (e as ErrorShape) : {};
}

export function errorCode(e: unknown): string | undefined {
  return asErrorShape(e).code;
}

/** Числовое поле `details` ошибки (count, diff…), если сервер его прислал. */
function detailNumber(e: unknown, key: string): number | null {
  const details = asErrorShape(e).details;
  if (typeof details === "object" && details !== null && key in details) {
    const n = (details as Record<string, unknown>)[key];
    return typeof n === "number" ? n : null;
  }
  return null;
}

/** Сколько строк без решения сервер насчитал в 409 UNDECIDED_LINES. */
export function undecidedCountOf(e: unknown): number | null {
  return detailNumber(e, "count");
}

const CODE_MESSAGES: Record<string, string> = {
  STOCK_COUNT_NOT_OPEN: "Инвентаризация уже завершена или отменена — изменения не сохранены",
  STOCK_COUNT_NOT_FOUND: "Инвентаризация не найдена",
  LINE_NOT_FOUND: "Строка инвентаризации не найдена — обновите страницу",
  LINE_NOT_COUNT_MODE:
    "Позицию перевели на штучный учёт — её сверяют по единицам в карточке оборудования",
  EQUIPMENT_DELETED: "Позицию удалили из каталога — считать нечего",
  EQUIPMENT_NOT_FOUND: "Позицию удалили из каталога — след не построить",
  LINE_NOT_DISCREPANT: "Строка больше не расходится — решение не нужно",
  REASON_REQUIRED: "Укажите причину поправки — не короче 3 символов",
  BOOKING_NOT_FOUND: "Бронь не найдена — выберите другую или «не определено»",
  EMPTY_SCOPE: "В выбранном охвате нет позиций для пересчёта",
  INVALID_QTY: "Количество — целое число от 0 до 100 000",
  EXPECTATION_CHANGED: "С момента счёта учёт позиции изменился — нажмите «Пересчитать» и посчитайте полку заново",
  LINE_NOT_COUNTED: "Строка ещё не посчитана — обновлять нечего",
  SEEN_VALUES_REQUIRED: "Данные строки устарели — обновите страницу и решите заново",
};

/**
 * Человеческое объяснение ошибки для тоста. Коды, где сервер сам формулирует
 * точнее (номер открытой инвентаризации, почему решение не подходит), берут
 * его текст.
 */
export function explainInventoryError(e: unknown, fallback: string): string {
  if (e instanceof TypeError) return "Нет связи с сервером — изменения не сохранены";
  const err = asErrorShape(e);
  if (err.code === "UNDECIDED_LINES") {
    const n = undecidedCountOf(e);
    return n != null ? `Осталось решить: ${n} — завершить пока нельзя` : "Остались расхождения без решения";
  }
  if (err.code === "LINE_CHANGED") {
    const diff = detailNumber(e, "diff");
    return diff == null
      ? "Строку пересчитали — проверьте новое расхождение и решите заново"
      : diff === 0
        ? "Строку пересчитали — теперь сошлось, решение не нужно"
        : `Строку пересчитали: теперь ${signed(diff)} — проверьте и решите заново`;
  }
  if (err.code === "LINE_BOOKS_CHANGED") {
    const n = detailNumber(e, "count");
    return n != null
      ? `Учёт изменился после счёта у ${n} ${n === 1 ? "строки" : "строк"} — проверьте их в списке и подтвердите решение`
      : "Учёт позиции изменился после счёта — обновите ожидание или оставьте как посчитано";
  }
  if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code]!;
  if (err.code === "STOCK_COUNT_ALREADY_OPEN" || err.code === "DECISION_NOT_APPLICABLE") {
    return err.message || fallback;
  }
  if (err.status === 403) return "Недостаточно прав";
  return err.message && !err.message.startsWith("Request failed") ? err.message : fallback;
}
