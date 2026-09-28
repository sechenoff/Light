/**
 * Черновик чек-листа выдачи — чистые функции без React и сети (P6, P4).
 *
 * Зачем: количества на степпере, отметки «Выдано» и «под ответственность»
 * раньше жили только в `useState` `IssueChecklist` и пропадали при смене
 * раздела, «←», перезагрузке и на втором планшете — а «Готово» оформляло план
 * вместо погруженного. Теперь экран складывает их в `ChecklistDraftV1.issue`
 * и хранит на сервере (`PUT /sessions/:id/draft`), а при открытии
 * восстанавливает отсюда.
 *
 * В черновик попадают только строки, которые отличаются от плана: количество
 * не равно позиции брони, строка отмечена или взята «под ответственность».
 * Нетронутая строка следует за планом — если руководитель поменял количество
 * в брони, экран покажет новое, а не старое.
 *
 * Восстановление сверяется с ТЕКУЩИМ составом брони:
 *  - строку ищем по `bookingItemId`, не нашли — по `equipmentId` (позицию
 *    брони могли пересоздать правкой состава);
 *  - количество не выше текущего потолка строки (свободное или «под
 *    ответственность», если оно было взято и ещё возможно);
 *  - строки, которых больше нет, отбрасываются.
 */

import type { ChecklistDraftV1, ChecklistItem, IssueDraftRow } from "./types";

/** Состояние одной строки выдачи на экране. */
export interface IssueRowState {
  /** Сколько выдаём (значение степпера). */
  qty: number;
  /** Отмечено «Выдано» (грузчик унёс). */
  checked: boolean;
  /** Взято «под ответственность»: потолок `ackCap` вместо `addCap`. */
  ack: boolean;
}

/** bookingItemId → состояние строки. */
export type IssueRowMap = ReadonlyMap<string, IssueRowState>;

function nonNegativeInt(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

/** Сколько можно добавить сверх позиции без конфликта. */
export function freeAddCap(item: ChecklistItem): number {
  return nonNegativeInt(item.addCap, 0);
}

/**
 * Сколько можно добавить сверх позиции «под ответственность» (не меньше
 * свободного). Старый сервер без `ackCap` — как свободное.
 */
export function ackAddCap(item: ChecklistItem): number {
  return Math.max(freeAddCap(item), nonNegativeInt(item.ackCap, freeAddCap(item)));
}

/** Есть ли у строки путь «под ответственность» (держатель мешает добрать). */
export function hasAckPath(item: ChecklistItem): boolean {
  return ackAddCap(item) > freeAddCap(item);
}

/** Потолок степпера строки. */
export function rowMax(item: ChecklistItem, ack: boolean): number {
  return item.quantity + (ack && hasAckPath(item) ? ackAddCap(item) : freeAddCap(item));
}

/** Строка по плану: количество из брони, ничего не отмечено. */
export function defaultRow(item: ChecklistItem): IssueRowState {
  return { qty: item.quantity, checked: false, ack: false };
}

/** Состояние строки — сохранённое или план. */
export function rowOf(rows: IssueRowMap, item: ChecklistItem): IssueRowState {
  return rows.get(item.bookingItemId) ?? defaultRow(item);
}

/** Строки на экране по плану (новый чек-лист без черновика). */
export function defaultRows(items: readonly ChecklistItem[]): Map<string, IssueRowState> {
  return new Map(items.map((item) => [item.bookingItemId, defaultRow(item)]));
}

/**
 * Добавить строки, которых на экране ещё нет (добор этой сессии пришёл после
 * `refresh`). Уже выбранное оператором не трогаем.
 *
 * `prevItems` — строки прошлого `/state`. Строка, которую оператор не трогал
 * (количество равно прежнему плану, без отметок), следует за новым планом:
 * иначе экран держал бы старое количество позиции и «Готово» вернуло бы его
 * корректировкой, откатив правку брони.
 */
export function mergeNewItems(
  prev: IssueRowMap,
  items: readonly ChecklistItem[],
  prevItems?: readonly ChecklistItem[] | null,
): IssueRowMap {
  const prevPlan = new Map((prevItems ?? []).map((i) => [i.bookingItemId, i.quantity]));
  let changed = false;
  const next = new Map(prev);
  for (const item of items) {
    const cur = next.get(item.bookingItemId);
    if (!cur) {
      next.set(item.bookingItemId, defaultRow(item));
      changed = true;
      continue;
    }
    const planBefore = prevPlan.get(item.bookingItemId);
    const untouched =
      planBefore !== undefined && cur.qty === planBefore && !cur.checked && !cur.ack;
    if (untouched && planBefore !== item.quantity) {
      next.set(item.bookingItemId, defaultRow(item));
      changed = true;
    }
  }
  return changed ? next : prev;
}

/** Черновик для сервера: только строки, отличные от плана. */
export function buildIssueDraft(
  items: readonly ChecklistItem[],
  rows: IssueRowMap,
): ChecklistDraftV1 {
  const out: Record<string, IssueDraftRow> = {};
  for (const item of items) {
    const r = rows.get(item.bookingItemId);
    if (!r) continue;
    if (r.qty === item.quantity && !r.checked && !r.ack) continue;
    out[item.bookingItemId] = {
      qty: r.qty,
      checked: r.checked,
      equipmentId: item.equipmentId,
      ...(r.ack ? { ack: true } : {}),
    };
  }
  return { v: 1, issue: { rows: out } };
}

/** Есть ли в черновике хоть одна строка выдачи. */
export function issueDraftHasRows(draft: ChecklistDraftV1 | null | undefined): boolean {
  return !!draft?.issue && Object.keys(draft.issue.rows).length > 0;
}

export interface SeedResult {
  rows: Map<string, IssueRowState>;
  /** Сколько строк восстановлено из черновика. */
  restored: number;
  /** Названия строк, где сохранённое количество больше текущего потолка. */
  clamped: string[];
}

/**
 * Засеять экран из черновика поверх плана. Строка черновика находит позицию
 * по `bookingItemId`, иначе — по `equipmentId` среди строк, чьих позиций в
 * брони больше нет (одна строка черновика — одна позиция).
 */
export function seedIssueRows(
  items: readonly ChecklistItem[],
  draft: ChecklistDraftV1 | null | undefined,
): SeedResult {
  const rows = defaultRows(items);
  const saved = draft?.issue?.rows;
  if (!saved || typeof saved !== "object") return { rows, restored: 0, clamped: [] };

  const currentIds = new Set(items.map((i) => i.bookingItemId));
  // Строки черновика, чьих позиций в брони уже нет, — кандидаты на сопоставление по прибору.
  const orphans = Object.entries(saved).filter(([id]) => !currentIds.has(id));
  const usedOrphans = new Set<string>();

  let restored = 0;
  const clamped: string[] = [];
  for (const item of items) {
    let entry: IssueDraftRow | undefined = saved[item.bookingItemId];
    if (!entry && item.equipmentId) {
      const match = orphans.find(
        ([id, r]) => !usedOrphans.has(id) && r && r.equipmentId === item.equipmentId,
      );
      if (match) {
        usedOrphans.add(match[0]);
        entry = match[1];
      }
    }
    if (!entry || typeof entry !== "object") continue;

    const ack = entry.ack === true && hasAckPath(item);
    const max = rowMax(item, ack);
    const wanted = nonNegativeInt(entry.qty, item.quantity);
    const qty = Math.min(wanted, max);
    if (qty < wanted) clamped.push(item.equipmentName);
    rows.set(item.bookingItemId, {
      qty,
      checked: entry.checked === true && qty > 0,
      ack,
    });
    restored += 1;
  }
  return { rows, restored, clamped };
}
