/**
 * Полная пересборка ADDON Estimate брони.
 *
 * Формула (после issue-stock-cap-and-unit-removal):
 *   addonQty = max(0, BookingItem.quantity − MAIN.line.quantity) per equipmentId.
 *
 * Источник истины — текущее `BookingItem.quantity` минус `MAIN.line.quantity`
 * для каждого equipmentId. Equipment, отсутствующее в MAIN-смете, полностью
 * считается добором.
 *
 * До этого реализация агрегировала `AddonRecord`-дельты — это становилось
 * неконсистентным после per-row adjustment в ISSUE-сессии (дельты копились,
 * но не знали о последующих уменьшениях quantity). `AddonRecord` остаётся
 * как чисто аудитная таблица.
 *
 * Цены считаются ТЕМИ ЖЕ правилами, что и в основной смете
 * (`resolveCatalogLinePrice` + `splitEquipmentDiscount`):
 *   - `EstimateLine.unitPrice` — цена ЗА ВЕСЬ ПЕРИОД (ставка × смены MAIN).
 *     Экспорт делит unitPrice на число смен, чтобы напечатать «цена/смена»;
 *     раньше сюда писалась ставка за смену, и колонка в PDF доб-сметы
 *     многосменной брони уменьшалась во столько раз, сколько смен в периоде.
 *   - договорная ставка позиции (`BookingItem.negotiatedRatePerShift`)
 *     действует и на добор: клиент договорился о цене на прибор, а не на
 *     первые N штук; процентная скидка на договорные строки не начисляется.
 *
 * Идемпотентна: delete-then-create в транзакции. Если ни одного добора нет —
 * существующий ADDON удаляется и новый не создаётся.
 *
 * No-op если у брони нет MAIN-сметы (бронь не CONFIRMED → доборов не может быть).
 *
 * Произвольные позиции (BookingItem.equipmentId == null) в ADDON не попадают —
 * добор учитывает только каталожное оборудование.
 */
import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { resolveCatalogLinePrice, splitEquipmentDiscount } from "./pricing";

export async function recomputeAddonEstimate(bookingId: string): Promise<void> {
  const main = await prisma.estimate.findFirst({
    where: { bookingId, kind: "MAIN" },
    include: { lines: true },
  });
  if (!main) return;

  const items = await prisma.bookingItem.findMany({
    where: { bookingId, quantity: { gt: 0 } },
    include: { equipment: true },
  });

  // mainQty по equipmentId. MAIN custom-lines (equipmentId == null) игнорируются —
  // у произвольных позиций нет equipmentId, чтобы их сопоставить.
  const mainQtyByEquipment = new Map<string, number>();
  for (const line of main.lines) {
    if (line.equipmentId) {
      mainQtyByEquipment.set(line.equipmentId, line.quantity);
    }
  }

  const discountPercent = main.discountPercent
    ? new Decimal(main.discountPercent.toString())
    : new Decimal(0);
  const shifts = main.shifts > 0 ? main.shifts : 1;

  type AddonLineInput = {
    equipmentId: string;
    categorySnapshot: string;
    nameSnapshot: string;
    brandSnapshot: string | null;
    modelSnapshot: string | null;
    quantity: number;
    unitPrice: Decimal;
    lineSum: Decimal;
    listUnitPrice: Decimal | null;
    isNegotiated: boolean;
  };

  const lines: AddonLineInput[] = [];
  for (const bi of items) {
    // ADDON формируется только для каталожных позиций — custom items не учитываются.
    if (!bi.equipmentId || !bi.equipment) continue;
    const inMain = mainQtyByEquipment.get(bi.equipmentId) ?? 0;
    const addonQty = bi.quantity - inMain;
    if (addonQty <= 0) continue;
    const { unitPrice, listUnitPrice, isNegotiated } = resolveCatalogLinePrice({
      ratePerShift: bi.equipment.rentalRatePerShift.toString(),
      shifts,
      negotiatedRatePerShift: bi.negotiatedRatePerShift?.toString() ?? null,
    });
    lines.push({
      equipmentId: bi.equipmentId,
      categorySnapshot: bi.equipment.category,
      nameSnapshot: bi.equipment.name,
      brandSnapshot: bi.equipment.brand ?? null,
      modelSnapshot: bi.equipment.model ?? null,
      quantity: addonQty,
      unitPrice,
      lineSum: unitPrice.mul(addonQty),
      listUnitPrice,
      isNegotiated,
    });
  }

  const { subtotal, discountAmount, totalAfterDiscount } = splitEquipmentDiscount(lines, discountPercent);

  await prisma.$transaction(async (tx) => {
    await tx.estimate.deleteMany({ where: { bookingId, kind: "ADDON" } });
    if (lines.length === 0) return;
    await tx.estimate.create({
      data: {
        bookingId,
        kind: "ADDON",
        shifts,
        subtotal: subtotal.toDecimalPlaces(2).toString(),
        discountPercent: discountPercent.isZero()
          ? null
          : discountPercent.toDecimalPlaces(2).toString(),
        discountAmount: discountAmount.toDecimalPlaces(2).toString(),
        totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
        commentSnapshot: null,
        optionalNote: null,
        includeOptionalInExport: false,
        hoursSummaryText: main.hoursSummaryText,
        lines: {
          create: lines.map((l) => ({
            equipmentId: l.equipmentId,
            categorySnapshot: l.categorySnapshot,
            nameSnapshot: l.nameSnapshot,
            brandSnapshot: l.brandSnapshot,
            modelSnapshot: l.modelSnapshot,
            quantity: l.quantity,
            unitPrice: l.unitPrice.toDecimalPlaces(2).toString(),
            lineSum: l.lineSum.toDecimalPlaces(2).toString(),
            listUnitPrice: l.listUnitPrice ? l.listUnitPrice.toDecimalPlaces(2).toString() : null,
          })),
        },
      },
    });
  });
}
