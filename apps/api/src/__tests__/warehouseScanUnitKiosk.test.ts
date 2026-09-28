/**
 * Штучный учёт (UNIT) в киоске: выдача и приёмка не портят экземпляры.
 *
 * На проде штучных позиций пока нет, но переход на них сломался бы на первой
 * же выдаче:
 *  - чек-лист выдачи отмечает строки, а не экземпляры, и «Готово» снимал ВСЕ
 *    резервы как «не отсканированные» — приборы у клиента числились свободными,
 *    а приёмке было нечего принимать;
 *  - забытая выдача после ручной «Выдать» удаляла резерв, и экземпляр навсегда
 *    оставался «Выдан» без брони;
 *  - прибор с открытым ремонтом «✓ Принято» на приёмке возвращал в AVAILABLE;
 *  - штучный добор степпером не резервировал экземпляров.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { kioskTestKit } from "./kioskTestKit";

const kit = kioskTestKit("warehouse-scan-unit-kiosk");

beforeAll(() => kit.boot(), 120_000);
afterAll(() => kit.shutdown());

async function unitStatuses(ids: string[]) {
  const rows = await kit.prisma.equipmentUnit.findMany({ where: { id: { in: ids } } });
  return rows.map((u: any) => u.status).sort();
}

async function reservationsOf(bookingId: string) {
  return kit.prisma.bookingItemUnit.findMany({ where: { bookingItem: { bookingId } }, orderBy: { id: "asc" } });
}

function check(token: string, sessionId: string, equipmentUnitId: string) {
  return request(kit.app)
    .post(`/api/warehouse/sessions/${sessionId}/check`)
    .set(kit.headers(token))
    .send({ equipmentUnitId });
}

describe("выдача штучных позиций", () => {
  it("«Готово» без отметок по экземплярам выдаёт зарезервированные экземпляры, как кнопка «Выдать»", async () => {
    const eq = await kit.mkEquipment({ mode: "UNIT", total: 3 });
    await kit.mkUnits(eq, 3);
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const reserved = await reservationsOf(b);
    expect(reserved).toHaveLength(2);
    const s = await kit.openSession(kit.whToken, b, "ISSUE");

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(200);
    expect(res.body.missingItems).toEqual([]);
    expect(await reservationsOf(b)).toHaveLength(2);
    expect(await unitStatuses(reserved.map((r: any) => r.equipmentUnitId))).toEqual(["ISSUED", "ISSUED"]);

    // Приёмке есть что принимать: оба экземпляра в чек-листе и возвращаются на полку.
    const r = await kit.openSession(kit.whToken, b, "RETURN");
    for (const x of reserved) {
      expect((await check(kit.whToken, r.id, x.equipmentUnitId)).status).toBe(200);
    }
    expect((await kit.complete(kit.whToken, r.id, {})).status).toBe(200);
    expect(await unitStatuses(reserved.map((x: any) => x.equipmentUnitId))).toEqual(["AVAILABLE", "AVAILABLE"]);
  });

  it("степпер штучной позиции сверх заказа резервирует свободный экземпляр и выдаёт его", async () => {
    const eq = await kit.mkEquipment({ mode: "UNIT", total: 3 });
    await kit.mkUnits(eq, 3);
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const bi = await kit.itemOf(b, eq);

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 2 }],
    });
    expect(res.status).toBe(200);
    const reserved = await reservationsOf(b);
    expect(reserved).toHaveLength(2);
    expect(await unitStatuses(reserved.map((r: any) => r.equipmentUnitId))).toEqual(["ISSUED", "ISSUED"]);
  });

  it("степпер штучной позиции сверх свободных экземпляров — 409 с названием строки", async () => {
    const eq = await kit.mkEquipment({ mode: "UNIT", total: 1, name: "Штучный одиночка" });
    await kit.mkUnits(eq, 1);
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    const bi = await kit.itemOf(b, eq);

    const res = await kit.complete(kit.whToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 2 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ADDON_OVER_STOCK");
    expect(res.body.details).toMatchObject({ bookingItemId: bi.id, addCap: 0 });
    expect(res.body.message).toMatch(/Штучный одиночка/);
    expect(await kit.bookingStatus(b)).toBe("CONFIRMED");
  });

  it("добор штучной позиции «+» резервирует реальные экземпляры: их видно в чек-листе и можно отметить", async () => {
    const eqCount = await kit.mkEquipment();
    const eqUnit = await kit.mkEquipment({ mode: "UNIT", total: 3 });
    await kit.mkUnits(eqUnit, 3);
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eqCount, quantity: 1 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");

    const add = await kit.addItem(kit.whToken, s.id, { equipmentId: eqUnit, quantity: 1 });
    expect(add.status).toBe(201);
    const reserved = await kit.prisma.bookingItemUnit.findMany({ where: { bookingItemId: add.body.bookingItemId } });
    expect(reserved).toHaveLength(1);
    const st = await kit.state(kit.whToken, s.id);
    const row = st.body.items.find((i: any) => i.equipmentId === eqUnit);
    expect(row.units.map((u: any) => u.unitId)).toEqual([reserved[0].equipmentUnitId]);
    expect((await check(kit.whToken, s.id, reserved[0].equipmentUnitId)).status).toBe(200);

    expect((await kit.complete(kit.whToken, s.id, {})).status).toBe(200);
    expect(await unitStatuses([reserved[0].equipmentUnitId])).toEqual(["ISSUED"]);
  });

  it("экземпляр, отмеченный в чек-листе, выдаётся по отметке; неотмеченный резерв снимается", async () => {
    const eq = await kit.mkEquipment({ mode: "UNIT", total: 2 });
    await kit.mkUnits(eq, 2);
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const [first, second] = await reservationsOf(b);
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    await kit.prisma.scanRecord.create({
      data: { sessionId: s.id, equipmentUnitId: first.equipmentUnitId, hmacVerified: false },
    });

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(200);
    const left = await reservationsOf(b);
    expect(left.map((r: any) => r.equipmentUnitId)).toEqual([first.equipmentUnitId]);
    expect(await unitStatuses([first.equipmentUnitId])).toEqual(["ISSUED"]);
    expect(await unitStatuses([second.equipmentUnitId])).toEqual(["AVAILABLE"]);
  });

  it("забытая выдача после «Выдать» кнопкой: резерв цел, после «Вернуть» экземпляр на полке", async () => {
    const eq = await kit.mkEquipment({ mode: "UNIT", total: 2 });
    await kit.mkUnits(eq, 2);
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    expect((await kit.manual(b, "issue")).status).toBe(200);
    const [reservation] = await reservationsOf(b);
    expect(await unitStatuses([reservation.equipmentUnitId])).toEqual(["ISSUED"]);

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(409);
    expect(["SESSION_STALE", "SESSION_CANCELLED"]).toContain(res.body.code);
    expect(await reservationsOf(b)).toHaveLength(1);

    expect((await kit.manual(b, "return")).status).toBe(200);
    expect(await unitStatuses([reservation.equipmentUnitId])).toEqual(["AVAILABLE"]);
  });
});

describe("приёмка штучных позиций", () => {
  it("прибор с открытым ремонтом «✓ Принято» не возвращает в оборот", async () => {
    const eq = await kit.mkEquipment({ mode: "UNIT", total: 2 });
    await kit.mkUnits(eq, 2);
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    const [reservation] = await reservationsOf(b);
    // Клиент позвонил «не включается» — поломку завели, пока прибор у него.
    const rep = await request(kit.app)
      .post("/api/warehouse/repairs")
      .set(kit.headers(kit.pinToken))
      .send({ equipmentUnitId: reservation.equipmentUnitId, reason: "не включается" });
    expect(rep.status).toBe(201);

    const s = await kit.openSession(kit.pinToken, b, "RETURN");
    expect((await check(kit.pinToken, s.id, reservation.equipmentUnitId)).status).toBe(200);
    expect((await kit.complete(kit.pinToken, s.id, {})).status).toBe(200);

    expect(await unitStatuses([reservation.equipmentUnitId])).toEqual(["MAINTENANCE"]);
    const repair = await kit.prisma.repair.findUnique({ where: { id: rep.body.repair.id } });
    expect(repair.status).toBe("WAITING_REPAIR");
    // Резерв закрыт — приёмка по брони состоялась.
    expect((await kit.prisma.bookingItemUnit.findUnique({ where: { id: reservation.id } })).returnedAt).not.toBeNull();
  });

  it("неотмеченный экземпляр уходит в «не принято» (MISSING), отмеченный — на полку", async () => {
    const eq = await kit.mkEquipment({ mode: "UNIT", total: 2 });
    await kit.mkUnits(eq, 2);
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 2 }] });
    const [taken, lost] = await reservationsOf(b);
    const s = await kit.openSession(kit.whToken, b, "RETURN");
    await kit.prisma.scanRecord.create({
      data: { sessionId: s.id, equipmentUnitId: taken.equipmentUnitId, hmacVerified: false },
    });

    const res = await kit.complete(kit.whToken, s.id, {});
    expect(res.status).toBe(200);
    expect(res.body.missingItems.map((m: any) => m.id)).toEqual([lost.equipmentUnitId]);
    expect(await unitStatuses([taken.equipmentUnitId])).toEqual(["AVAILABLE"]);
    expect(await unitStatuses([lost.equipmentUnitId])).toEqual(["MISSING"]);
  });
});
