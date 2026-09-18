/**
 * Обёртки над /api/stock-counts (десктоп, cookie-сессия SA / WAREHOUSE).
 *
 * Контракт — спека §6; типы ответов — ./types (зеркало сервера). Ошибки
 * пробрасываются как есть (ApiFetchError: status / code / details), а
 * человеческий текст для тоста даёт `explainInventoryError`.
 */

import { apiFetch } from "../../lib/api";
import type {
  CompleteResult,
  Decision,
  EquipmentTrail,
  StockCountDetail,
  StockCountLineFilter,
  StockCountLineView,
  StockCountSummary,
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
}

export interface CategoriesResponse {
  categories: string[];
  counts?: Record<string, number>;
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
  decide: (id: string, lineId: string, body: DecisionBody) =>
    apiFetch<{ line: StockCountLineView }>(linePath(id, lineId, "decision"), post(body)),
  trail: (id: string, lineId: string) =>
    apiFetch<{ trail: EquipmentTrail }>(linePath(id, lineId, "trail")),
  complete: (id: string) =>
    apiFetch<{ stockCount: StockCountDetail; result: CompleteResult }>(path(id, "/complete"), post()),
  cancel: (id: string) => apiFetch<{ stockCount: StockCountDetail }>(path(id, "/cancel"), post()),
  categories: () => apiFetch<CategoriesResponse>("/api/equipment/categories"),
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

/** Сколько строк без решения сервер насчитал в 409 UNDECIDED_LINES. */
export function undecidedCountOf(e: unknown): number | null {
  const details = asErrorShape(e).details;
  if (typeof details === "object" && details !== null && "count" in details) {
    const n = (details as { count?: unknown }).count;
    return typeof n === "number" ? n : null;
  }
  return null;
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
  if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code]!;
  if (err.code === "STOCK_COUNT_ALREADY_OPEN" || err.code === "DECISION_NOT_APPLICABLE") {
    return err.message || fallback;
  }
  if (err.status === 403) return "Недостаточно прав";
  return err.message && !err.message.startsWith("Request failed") ? err.message : fallback;
}
