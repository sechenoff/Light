/**
 * Тексты про чужую бронь, которая держит оборудование (P26), и про договорной
 * итог (P22). Общие для «+ Добор» (`AddonSearch`) и подсказки у степпера
 * чек-листа выдачи (`IssueChecklist`) — одна формулировка на весь киоск.
 */

import type { AddonConflict } from "./types";
import { toMoscowDateString } from "../../lib/moscowDate";

/** «21.05» — день.месяц по московскому времени (как в BookingList). */
export function shortDate(iso: string): string {
  const ymd = toMoscowDateString(new Date(iso)); // YYYY-MM-DD
  const [, m, d] = ymd.split("-");
  return `${d}.${m}`;
}

/** Название в «ёлочках», не удваивая уже поставленные кавычки. */
export function quoted(name: string): string {
  const t = name.trim();
  if (/^[«„"“]/.test(t) && /[»“"”]$/.test(t)) return t;
  return `«${t}»`;
}

/**
 * Что происходит с вещью у брони-держателя (P26): кладовщик должен видеть
 * разницу между «вещь у клиента» и «вещь на полке, но под другой бронью».
 * Общий для карточки добора и подсказки у степпера чек-листа.
 */
export function holderStateText(c: AddonConflict): string {
  if (c.holderStatus === "ISSUED") {
    if (c.overdue) return `Возврат не отмечен — срок был ${shortDate(c.to)}`;
    const who = c.clientName ? ` ${quoted(c.clientName)}` : "";
    return `Сейчас у клиента${who} с ${shortDate(c.issuedAt ?? c.from)}`;
  }
  if (c.holderStatus === "PENDING_APPROVAL") {
    return "Бронь на согласовании — пока на складе";
  }
  if (c.holderStatus === "CONFIRMED") {
    return "Пока на складе — зарезервирован под эту бронь";
  }
  return "";
}

/** Текст предупреждения о договорном итоге — как в модалке добора на карточке. */
export const NEGOTIATED_TOTAL_ADDON_NOTE =
  "У брони зафиксирован договорной итог — сумма к оплате не изменится автоматически. Доб-смета обновится; итог пересмотрит руководитель.";
