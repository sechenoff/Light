/**
 * Основная смета (MAIN) после выдачи в киоске — точечно, по снимку цен.
 *
 * Раньше выдача со степпером пересобирала MAIN целиком по ТЕКУЩЕМУ прайсу
 * (`recreateMainEstimate`): недовыдали одну строку — переоценились все
 * остальные, а добор из доп-сметы молча вливался в MAIN (27 из 28 доборов на
 * проде лежат именно так). Теперь смета клиента меняется ровно на то, что
 * изменилось на полке:
 *
 *  - строка MAIN: `quantity = min(было в смете, выдано по позиции)`, цена —
 *    из снимка строки (та же договорная/прайсовая цена за период, что видел
 *    клиент); строка, по которой не выдано ничего, удаляется;
 *  - прибавка сверх сметы остаётся доп-сметой (ADDON) — её пересобирает
 *    `recomputeAddonEstimate` после транзакции, как при доборе «+». Исключение —
 *    произвольная позиция: доп-смета её не видит (нет equipmentId), поэтому
 *    прибавку по ней держит сама MAIN по цене из снимка — иначе довезённое
 *    ушло бы клиенту бесплатно, хотя киоск показал его в «Итого»;
 *  - итоги — `splitEquipmentDiscount`, как `applyAdditionsToMainEstimate`:
 *    процент скидки не начисляется на договорные строки.
 *
 * Каталожные строки сопоставляются с позициями брони по `equipmentId`,
 * произвольные — по названию (`nameSnapshot` = `customName`). Estimate.id
 * сохраняется: ссылки на экспорт `/api/estimates/:id` не протухают.
 */
import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";

import { splitEquipmentDiscount } from "./pricing";

type TxClient = Prisma.TransactionClient;

export interface IssuanceMainResult {
  /** true — смета изменилась (строки уменьшены, удалены или выросла произвольная). */
  changed: boolean;
  /** MAIN.totalAfterDiscount после правки; null — у брони нет MAIN. */
  totalAfterDiscount: Decimal | null;
}

function lineKey(equipmentId: string | null, name: string | null): string | null {
  if (equipmentId) return `eq:${equipmentId}`;
  return name != null ? `custom:${name}` : null;
}

/**
 * Приводит строки MAIN к фактически выданному количеству. Вызывается внутри
 * транзакции завершения выдачи, после применения корректировок степпера.
 * Каталожные строки только уменьшаются (прибавку считает доп-смета);
 * произвольные — и растут, потому что в доп-смету не попадают.
 */
export async function applyIssuanceToMainEstimate(
  tx: TxClient,
  bookingId: string,
): Promise<IssuanceMainResult> {
  const main = await tx.estimate.findFirst({
    where: { bookingId, kind: "MAIN" },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  if (!main) return { changed: false, totalAfterDiscount: null };

  const items = await tx.bookingItem.findMany({
    where: { bookingId },
    select: { equipmentId: true, customName: true, quantity: true },
  });
  // Сколько по ключу выдано — «бюджет», который строки сметы разбирают по порядку.
  const issued = new Map<string, number>();
  for (const bi of items) {
    const key = lineKey(bi.equipmentId, bi.customName);
    if (!key) continue;
    issued.set(key, (issued.get(key) ?? 0) + Math.max(0, bi.quantity));
  }

  type Planned = { line: (typeof main.lines)[number]; quantity: number };
  const planned: Planned[] = [];
  const lastCustomLine = new Map<string, Planned>();
  for (const line of main.lines) {
    const key = lineKey(line.equipmentId, line.nameSnapshot);
    const budget = key ? issued.get(key) ?? 0 : 0;
    const quantity = Math.min(line.quantity, budget);
    if (key) issued.set(key, budget - quantity);
    const p = { line, quantity };
    planned.push(p);
    if (key && line.equipmentId == null) lastCustomLine.set(key, p);
  }
  // Остаток «бюджета» произвольной позиции — прибавка степпером: её держит
  // последняя строка с тем же названием (все строки ключа уже заполнены целиком).
  for (const [key, p] of lastCustomLine) {
    const left = issued.get(key) ?? 0;
    if (left > 0) p.quantity += left;
  }

  const state: Array<{ lineSum: Decimal; isNegotiated: boolean }> = [];
  let changed = false;
  for (const { line, quantity } of planned) {
    const isNegotiated = line.listUnitPrice != null;
    if (quantity === line.quantity) {
      state.push({ lineSum: new Decimal(line.lineSum.toString()), isNegotiated });
      continue;
    }
    changed = true;
    if (quantity <= 0) {
      await tx.estimateLine.delete({ where: { id: line.id } });
      continue;
    }
    const lineSum = new Decimal(line.unitPrice.toString()).mul(quantity);
    await tx.estimateLine.update({
      where: { id: line.id },
      data: { quantity, lineSum: lineSum.toDecimalPlaces(2).toString() },
    });
    state.push({ lineSum, isNegotiated });
  }

  if (!changed) {
    return { changed: false, totalAfterDiscount: new Decimal(main.totalAfterDiscount.toString()) };
  }

  const discountPercent = main.discountPercent
    ? new Decimal(main.discountPercent.toString())
    : new Decimal(0);
  const { subtotal, discountAmount, totalAfterDiscount } = splitEquipmentDiscount(state, discountPercent);
  await tx.estimate.update({
    where: { id: main.id },
    data: {
      subtotal: subtotal.toDecimalPlaces(2).toString(),
      discountAmount: discountAmount.toDecimalPlaces(2).toString(),
      totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
    },
  });
  return { changed: true, totalAfterDiscount };
}
