/**
 * Приёмка по количеству: потеряшки и ремонты заводятся правильно и один раз.
 *
 *  - «Сломан безвозвратно» раньше падал в «Ищем» (SEARCHING): уничтоженное
 *    искали, а «Найдено» вернуло бы его в доступность. Теперь карточка сразу
 *    закрыта списанием (WROTE_OFF) и продолжает вычитаться из склада.
 *  - Ремонт по количеству держал позицию только через строку брони: правка
 *    состава задним числом пересоздаёт строки, и сломанное снова «продавалось».
 *    Теперь у ремонта и потеряшки прямая ссылка на позицию каталога.
 *  - Ремонты и потеряшки по количеству заводятся в транзакции приёмки: сбой
 *    откатывает всё, повтор «Готово» второй карточки не заводит.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { kioskTestKit } from "./kioskTestKit";

const kit = kioskTestKit("return-problem-classification");

beforeAll(() => kit.boot(), 120_000);
afterAll(() => kit.shutdown());

async function available(equipmentId: string, bookingId: string) {
  const bk = await kit.prisma.booking.findUnique({ where: { id: bookingId } });
  const res = await kit.get(
    kit.saToken,
    `/api/availability?start=${encodeURIComponent(bk.startDate.toISOString())}&end=${encodeURIComponent(
      bk.endDate.toISOString(),
    )}&excludeBookingId=${bookingId}`,
  );
  expect(res.status).toBe(200);
  return res.body.rows.find((r: any) => r.equipmentId === equipmentId).availableQuantity as number;
}

async function returnWith(body: Record<string, unknown>, bookingId: string) {
  const s = await kit.openSession(kit.pinToken, bookingId, "RETURN");
  const res = await kit.complete(kit.pinToken, s.id, body);
  return { s, res };
}

describe("потеряшки по количеству", () => {
  it("«Сломан безвозвратно» сразу списан (WROTE_OFF) и по-прежнему вычтен из склада", async () => {
    const eq = await kit.mkEquipment({ total: 5 });
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 2 }] });
    const bi = await kit.itemOf(b, eq);

    const { res } = await returnWith(
      { problemUnits: [{ bookingItemId: bi.id, quantity: 1, reason: "DESTROYED", comment: "раздавило машиной" }] },
      b,
    );
    expect(res.status).toBe(200);
    const pi = await kit.prisma.problemItem.findFirst({ where: { bookingItemId: bi.id } });
    expect(pi).toMatchObject({
      status: "WROTE_OFF",
      equipmentId: eq,
      quantity: 1,
      resolvedBy: kit.pinName,
      resolutionNote: "Списано при приёмке (уничтожено)",
    });
    expect(pi.resolvedAt).not.toBeNull();
    expect(res.body.createdProblemItemIds).toEqual([pi.id]);
    // Бронь принята, на полке 5 − 1 уничтоженный.
    expect(await available(eq, b)).toBe(4);
  });

  it("«Остался на площадке» ждём (EXPECTED), «Потерян» и «Украден» ищем (SEARCHING)", async () => {
    const eq = await kit.mkEquipment({ total: 10 });
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 3 }] });
    const bi = await kit.itemOf(b, eq);
    const { res } = await returnWith(
      {
        problemUnits: [
          { bookingItemId: bi.id, quantity: 1, reason: "LEFT_ON_SITE", comment: "заберут завтра" },
          { bookingItemId: bi.id, quantity: 1, reason: "LOST", comment: "не нашли" },
          { bookingItemId: bi.id, quantity: 1, reason: "STOLEN", comment: "украли с площадки" },
        ],
      },
      b,
    );
    expect(res.status).toBe(200);
    const rows = await kit.prisma.problemItem.findMany({ where: { bookingItemId: bi.id } });
    const byReason = Object.fromEntries(rows.map((r: any) => [r.reason, r]));
    expect(byReason.LEFT_ON_SITE).toMatchObject({ status: "EXPECTED", resolvedAt: null, equipmentId: eq });
    expect(byReason.LOST).toMatchObject({ status: "SEARCHING", resolvedAt: null });
    expect(byReason.STOLEN).toMatchObject({ status: "SEARCHING", resolvedAt: null });
    expect(rows.every((r: any) => r.createdBy === kit.pinName && r.sourceBookingId === b)).toBe(true);
  });
});

describe("ремонты по количеству", () => {
  it("ремонт держит позицию напрямую: правка состава задним числом не возвращает сломанное в доступность", async () => {
    const eq = await kit.mkEquipment({ total: 5 });
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 2 }] });
    const bi = await kit.itemOf(b, eq);

    const { res } = await returnWith({ repairUnits: [{ bookingItemId: bi.id, quantity: 1, comment: "сорвана резьба" }] }, b);
    expect(res.status).toBe(200);
    const repair = await kit.prisma.repair.findFirst({ where: { sourceBookingId: b } });
    expect(repair).toMatchObject({
      equipmentId: eq,
      bookingItemId: bi.id,
      quantity: 1,
      status: "WAITING_REPAIR",
      createdBy: kit.pinName,
    });
    const afterReturn = await available(eq, b);
    expect(afterReturn).toBe(4);

    // Как «Править задним числом»: позиции брони удаляются и создаются заново.
    await kit.prisma.bookingItem.delete({ where: { id: bi.id } });
    await kit.prisma.bookingItem.create({ data: { bookingId: b, equipmentId: eq, quantity: 2 } });
    const orphan = await kit.prisma.repair.findUnique({ where: { id: repair.id } });
    expect(orphan.bookingItemId).toBeNull();
    expect(await available(eq, b)).toBe(afterReturn);
  });
});

describe("целостность приёмки", () => {
  it("отметка по строке, которой уже нет в брони: 409 CHECKLIST_OUTDATED, ничего не записано", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 2 }] });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");

    const res = await kit.complete(kit.pinToken, s.id, {
      repairUnits: [{ bookingItemId: "gone-item", quantity: 1, comment: "сломано" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHECKLIST_OUTDATED");
    expect(res.body.details.unknownBookingItemIds).toEqual(["gone-item"]);
    expect(await kit.bookingStatus(b)).toBe("ISSUED");
    expect((await kit.sessionRow(s.id)).status).toBe("ACTIVE");
    expect(await kit.prisma.repair.count({ where: { sourceBookingId: b } })).toBe(0);
  });

  it("ремонт и потеряшка больше строки — 400 INVALID_SPLIT до любых записей", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 2 }] });
    const bi = await kit.itemOf(b, eq);
    const s = await kit.openSession(kit.pinToken, b, "RETURN");

    const res = await kit.complete(kit.pinToken, s.id, {
      repairUnits: [{ bookingItemId: bi.id, quantity: 2, comment: "сломано" }],
      problemUnits: [{ bookingItemId: bi.id, quantity: 1, reason: "LOST", comment: "нет" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SPLIT");
    expect(await kit.bookingStatus(b)).toBe("ISSUED");
  });
});
