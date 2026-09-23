import {
  BOOKING_ISSUE_FILTERS,
  REGISTER_SCOPES,
  REGISTER_STATUSES,
  REGISTER_SORTS,
  REGISTER_DATE_FIELDS,
} from "@light-rental/shared";
export const scopeLabels = {
  active: "В работе",
  unpaid: "К оплате",
  overdue: "Просрочено",
  paid: "Оплаченные",
  issued: "На руках",
  pending: "На согласовании",
  completed: "Завершённые",
  all: "Все",
};
export const sortLabels = {
  startDate: "Начало аренды",
  endDate: "Конец аренды",
  createdAt: "Дата создания",
  dueDate: "Срок оплаты",
  outstanding: "Остаток",
  total: "Начислено",
  client: "Клиент",
};
export const dateLabels = {
  rental: "Период аренды",
  start: "Начало аренды",
  end: "Конец аренды",
  due: "Срок оплаты",
  created: "Дата создания",
};
export const actionLabels = {
  prepare: "Подготовить",
  approve: "Согласовать",
  issue: "Выдать",
  return: "Принять возврат",
  payment: "Записать платёж",
  period: "Закрыть период",
  review: "Проверить",
};
export const paymentLabels: Record<string, string> = {
  unpaid: "Есть остаток",
  partial: "Частичная оплата",
  overdue: "Есть просрочка",
  paid: "Оплачено",
  unpriced: "Без расчёта / начислений",
  zero: "К оплате 0 ₽",
  settled: "Со списанием",
  credit: "Аванс / переплата",
};
export const FILTER_KEYS = [
  "q",
  "clientId",
  "projectId",
  "status",
  "mode",
  "payment",
  "dateField",
  "from",
  "to",
  "amountField",
  "min",
  "max",
  "action",
  "age",
  "issue",
] as const;
export function registerParams(input: { toString(): string }) {
  const raw = new URLSearchParams(input.toString()),
    p = new URLSearchParams();
  for (const key of [
    ...FILTER_KEYS,
    "sort",
    "direction",
    "scope",
    "view",
    "day",
    "columns",
  ]) {
    const value = raw.get(key);
    if (value) p.set(key, value.slice(0, 400));
  }
  const oneOf = (
    key: string,
    allowed: readonly string[],
    fallback?: string,
  ) => {
    if (!allowed.includes(p.get(key) ?? "")) {
      p.delete(key);
      if (fallback) p.set(key, fallback);
    }
  };
  oneOf("scope", REGISTER_SCOPES, "all");
  oneOf("sort", REGISTER_SORTS, "startDate");
  oneOf("direction", ["asc", "desc"], "desc");
  oneOf("view", ["registry", "day", "board"], "registry");
  oneOf("dateField", REGISTER_DATE_FIELDS, "rental");
  oneOf("mode", ["STANDARD", "PROJECT"]);
  if (p.has("status")) {
    const values = p
      .get("status")!
      .split(",")
      .filter((v) => (REGISTER_STATUSES as readonly string[]).includes(v));
    if (values.length) p.set("status", values.join(","));
    else p.delete("status");
  }
  const legacy: Record<string, string> = {
    PAID: "paid",
    UNPAID: "unpaid",
    NOT_PAID: "unpaid",
    PARTIALLY_PAID: "partial",
    OVERDUE: "overdue",
  };
  if (!p.has("payment") && legacy[raw.get("paid") ?? ""])
    p.set("payment", legacy[raw.get("paid")!]);
  oneOf("payment", [
    "unpaid",
    "partial",
    "overdue",
    "paid",
    "unpriced",
    "credit",
    "settled",
    "zero",
  ]);
  oneOf(
    "amountField",
    ["outstanding", "total", "paid", "overdue"],
    "outstanding",
  );
  oneOf("action", Object.keys(actionLabels));
  oneOf("issue", Object.keys(BOOKING_ISSUE_FILTERS));
  oneOf("age", ["1-7", "8-30", "31+"]);
  oneOf("columns", ["expanded"]);
  return p;
}
export function requestParams(p: URLSearchParams) {
  const q = new URLSearchParams(p);
  q.delete("view");
  q.delete("columns");
  q.set("limit", p.get("view") === "board" ? "200" : "50");
  return q;
}
export function registerDate(value: string | null, time = false) {
  if (!value) return "Не задан";
  const d = new Date(value.length === 10 ? `${value}T12:00:00+03:00` : value);
  if (!Number.isFinite(d.getTime())) return "Не задан";
  return d.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}
export type SavedRegisterView = { id: string; name: string; query: string };
export function parseSavedViews(raw: string | null): SavedRegisterView[] {
  try {
    const views: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(views)
      ? views
          .filter(
            (v): v is SavedRegisterView =>
              !!v &&
              typeof v.id === "string" &&
              typeof v.name === "string" &&
              v.name.length <= 60 &&
              typeof v.query === "string" &&
              v.query.length < 4000,
          )
          .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}
