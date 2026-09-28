/**
 * Смета после выдачи в киоске меняется точечно.
 *
 * Раньше любая правка степпера пересобирала основную смету целиком по ТЕКУЩЕМУ
 * прайсу: недовыдали один штатив — переоценились колёса, прайс которых подняли
 * после подтверждения; а добор из доп-сметы молча вливался в основную (27 из 28
 * доборов на проде). Теперь уменьшение считается по цене из снимка сметы,
 * прибавка остаётся доп-сметой.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { DAY, kioskTestKit } from "./kioskTestKit";

const kit = kioskTestKit("issue-main-estimate-point");

beforeAll(() => kit.boot(), 120_000);
afterAll(() => kit.shutdown());

async function estimates(bookingId: string) {
  return kit.prisma.estimate.findMany({ where: { bookingId }, include: { lines: true }, orderBy: { kind: "asc" } });
}

describe("точечная правка сметы при выдаче", () => {
  it("недовыдача одной строки не переоценивает остальные по новому прайсу", async () => {
    const tripod = await kit.mkEquipment({ name: "Штатив", rate: "1000" });
    const wheels = await kit.mkEquipment({ name: "Колёса", rate: "300" });
    const b = await kit.mkBooking({
      status: "CONFIRMED",
      shifts: 2,
      durationMs: 2 * DAY,
      items: [{ equipmentId: tripod, quantity: 4 }, { equipmentId: wheels, quantity: 2 }],
    });
    // 4 × 1000 × 2 + 2 × 300 × 2 = 9 200. Прайс колёс подняли после подтверждения.
    await kit.prisma.equipment.update({ where: { id: wheels }, data: { rentalRatePerShift: "500" } });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const bi = await kit.itemOf(b, tripod);

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 3 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.mainOriginalAfterDiscount).toBe("9200");
    expect(Number(res.body.mainAfterDiscount)).toBe(7200);
    expect(Number(res.body.finalAmount)).toBe(7200);
    const [main] = await estimates(b);
    expect(main.lines.find((l: any) => l.equipmentId === wheels)).toMatchObject({ quantity: 2 });
    expect(Number(main.lines.find((l: any) => l.equipmentId === wheels).unitPrice)).toBe(600);
  });

  it("добор «+» остаётся доп-сметой, когда степпером уменьшают другую строку", async () => {
    const light = await kit.mkEquipment({ name: "Прибор A", rate: "1000" });
    const flag = await kit.mkEquipment({ name: "Флаг C", rate: "200" });
    const stand = await kit.mkEquipment({ name: "Стойка B", rate: "400" });
    const b = await kit.mkBooking({
      status: "CONFIRMED",
      items: [{ equipmentId: light, quantity: 2 }, { equipmentId: flag, quantity: 2 }],
    });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    expect((await kit.addItem(kit.whToken, s.id, { equipmentId: stand, quantity: 1 })).status).toBe(201);
    const before = Number((await kit.prisma.booking.findUnique({ where: { id: b } })).finalAmount);
    expect(before).toBe(2400 + 400);
    const flagItem = await kit.itemOf(b, flag);

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: flagItem.id, actualQuantity: 1 }],
    });

    expect(res.status).toBe(200);
    const [addon, main] = await estimates(b);
    expect(addon.kind).toBe("ADDON");
    expect(addon.lines.map((l: any) => l.equipmentId)).toEqual([stand]);
    expect(main.lines.some((l: any) => l.equipmentId === stand)).toBe(false);
    expect(Number(res.body.addonAfterDiscount)).toBe(400);
    expect(Number(res.body.finalAmount)).toBe(before - 200);
    expect(res.body.addonsAddedInSession).toBe(1);
  });

  it("степпер сверх сметы: основная смета не меняется, прибавка уходит в доп-смету", async () => {
    const light = await kit.mkEquipment({ name: "Прибор D", rate: "1000", total: 10 });
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: light, quantity: 2 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const bi = await kit.itemOf(b, light);

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 3 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.mainOriginalAfterDiscount).toBe("2000");
    expect(res.body.mainAfterDiscount).toBe("2000");
    expect(Number(res.body.addonAfterDiscount)).toBe(1000);
    expect(Number(res.body.finalAmount)).toBe(3000);
    expect(res.body.addonsAddedInSession).toBe(1);
    const increased = await kit.prisma.auditEntry.findFirst({
      where: { entityId: b, action: "BOOKING_ITEM_QUANTITY_INCREASED" },
    });
    expect(JSON.parse(increased.after)).toMatchObject({ quantity: 3, delta: 1 });
  });

  it("строка с добором уменьшена ниже сметы: смета — до выданного, доп-смета исчезает", async () => {
    const light = await kit.mkEquipment({ name: "Прибор E", rate: "1000", total: 10 });
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: light, quantity: 2 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    expect((await kit.addItem(kit.whToken, s.id, { equipmentId: light, quantity: 1 })).status).toBe(201);
    const bi = await kit.itemOf(b, light);
    expect(bi.quantity).toBe(3);

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 1 }],
    });

    expect(res.status).toBe(200);
    const all = await estimates(b);
    expect(all.map((e: any) => e.kind)).toEqual(["MAIN"]);
    expect(all[0].lines[0].quantity).toBe(1);
    expect(Number(res.body.finalAmount)).toBe(1000);
  });

  it("произвольная позиция сверх сметы попадает в сумму к оплате по цене из снимка", async () => {
    const light = await kit.mkEquipment({ name: "Прибор G", rate: "1000" });
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: light, quantity: 1 }] });
    const [main] = await estimates(b);
    const custom = await kit.prisma.bookingItem.create({
      data: { bookingId: b, customName: "Работа механика", customUnitPrice: "1500", quantity: 1 },
    });
    await kit.prisma.estimateLine.create({
      data: {
        estimateId: main.id,
        categorySnapshot: "Прочее",
        nameSnapshot: "Работа механика",
        quantity: 1,
        unitPrice: "1500",
        lineSum: "1500",
      },
    });
    await kit.prisma.estimate.update({
      where: { id: main.id },
      data: { subtotal: "2500", totalAfterDiscount: "2500" },
    });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: custom.id, actualQuantity: 2 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.mainOriginalAfterDiscount).toBe("2500");
    // Доп-смета произвольных позиций не видит — прибавку держит основная.
    expect(Number(res.body.mainAfterDiscount)).toBe(4000);
    expect(Number(res.body.finalAmount)).toBe(4000);
  });

  it("договорной итог: добор его не меняет, ответ называет договорную сумму", async () => {
    const light = await kit.mkEquipment({ name: "Прибор F", rate: "1000" });
    const wheels = await kit.mkEquipment({ name: "Колёса F", rate: "300" });
    const b = await kit.mkBooking({
      status: "CONFIRMED",
      items: [{ equipmentId: light, quantity: 3 }],
      manualFinalAmount: "2500",
    });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    expect((await kit.addItem(kit.whToken, s.id, { equipmentId: wheels, quantity: 2 })).status).toBe(201);

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(200);
    expect(res.body.manualFinalAmount).toBe("2500");
    expect(Number(res.body.finalAmount)).toBe(2500);
    expect(Number(res.body.addonAfterDiscount)).toBe(600);
    expect(res.body.addonsAddedInSession).toBe(1);
    expect(res.body.bookingStatus).toBe("ISSUED");
  });
});
