/**
 * Журнал брони видит выдачу и приёмку в киоске.
 *
 * До исправления аудит киоска писался ПОСЛЕ транзакции с userId = имя
 * кладовщика: внешний ключ на AdminUser падал, `.catch` глотал ошибку, и в
 * журнале брони не было ни выдачи, ни приёмки — ни по PIN, ни главной сессией
 * (все 32 сессии прода). Теперь записи BOOKING_ISSUED / BOOKING_RETURNED и
 * изменения количества пишутся в той же транзакции: автор — сотрудник CRM,
 * если киоск открыт его сессией, иначе `_system_` с именем кладовщика в
 * `after.workerName`. Системный пользователь создаётся сам, если его нет.
 *
 * Журнал рабочего стола и «Как пропало» называют того, кто нажал «Готово»,
 * а не того, кто открыл сессию.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { kioskTestKit } from "./kioskTestKit";

const kit = kioskTestKit("warehouse-kiosk-audit");

// База БЕЗ `_system_` — как свежий стенд, где сид системного пользователя не запускали.
beforeAll(() => kit.boot({ withSystemUser: false }), 120_000);
afterAll(() => kit.shutdown());

async function auditOf(bookingId: string) {
  return kit.prisma.auditEntry.findMany({ where: { entityId: bookingId }, orderBy: { createdAt: "asc" } });
}

describe("аудит выдачи и приёмки в киоске", () => {
  it("выдача по PIN на базе без `_system_`: выдача проходит, системный автор создан, кладовщик — в записи", async () => {
    expect(await kit.prisma.adminUser.findUnique({ where: { id: "_system_" } })).toBeNull();
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 2 }] });
    const s = await kit.openSession(kit.pinToken, b, "ISSUE");
    const bi = await kit.itemOf(b, eq);

    const res = await kit.complete(kit.pinToken, s.id, {
      issuanceAdjustments: [{ bookingItemId: bi.id, actualQuantity: 1 }],
    });
    expect(res.status).toBe(200);
    expect(await kit.bookingStatus(b)).toBe("ISSUED");

    const system = await kit.prisma.adminUser.findUnique({ where: { id: "_system_" } });
    expect(system).not.toBeNull();
    expect(system.isActive).toBe(false); // войти под ним нельзя

    const entries = await auditOf(b);
    const issued = entries.filter((e: any) => e.action === "BOOKING_ISSUED");
    expect(issued).toHaveLength(1);
    expect(issued[0].userId).toBe("_system_");
    expect(JSON.parse(issued[0].before)).toEqual({ status: "CONFIRMED" });
    expect(JSON.parse(issued[0].after)).toMatchObject({
      status: "ISSUED",
      via: "kiosk",
      sessionId: s.id,
      workerName: kit.pinName,
      startedBy: kit.pinName,
      adjustments: 1,
    });
    const reduced = entries.find((e: any) => e.action === "BOOKING_ITEM_QUANTITY_REDUCED");
    expect(reduced.userId).toBe("_system_");
    expect(JSON.parse(reduced.after)).toMatchObject({ quantity: 1, delta: -1, workerName: kit.pinName });
    expect(entries.some((e: any) => e.action === "BOOKING_STATUS_CHANGED")).toBe(false);
  });

  it("выдача главной сессией кладовщика: автор — сам сотрудник", async () => {
    const eq = await kit.mkEquipment();
    const eqAddon = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.whToken, b, "ISSUE");
    expect((await kit.addItem(kit.whToken, s.id, { equipmentId: eqAddon, quantity: 1 })).status).toBe(201);

    expect((await kit.complete(kit.whToken, s.id, {})).status).toBe(200);
    const entries = await auditOf(b);
    const issued = entries.filter((e: any) => e.action === "BOOKING_ISSUED");
    expect(issued).toHaveLength(1);
    expect(issued[0].userId).toBe(kit.whId);
    expect(JSON.parse(issued[0].after)).toMatchObject({ via: "kiosk", workerName: kit.whName });
  });

  it("вход по PIN на планшете, где открыта CRM: автор — кладовщик по PIN, а не учётка планшета", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "CONFIRMED", items: [{ equipmentId: eq, quantity: 1 }] });
    // Браузер шлёт и cookie CRM (учётка планшета), и PIN-токен кладовщика —
    // склад действует от имени PIN (warehouseAuth проверяет его первым).
    const both = { ...kit.headers(kit.pinToken), Cookie: `lr_session=${kit.whToken}` };
    const open = await request(kit.app).post("/api/warehouse/sessions").set(both).send({ bookingId: b, operation: "ISSUE" });
    expect(open.status).toBe(201);
    expect(open.body.session.workerName).toBe(kit.pinName);

    const res = await request(kit.app).post(`/api/warehouse/sessions/${open.body.session.id}/complete`).set(both).send({});
    expect(res.status).toBe(200);
    const [issued] = (await auditOf(b)).filter((e: any) => e.action === "BOOKING_ISSUED");
    expect(issued.userId).toBe("_system_");
    expect(JSON.parse(issued.after)).toMatchObject({ workerName: kit.pinName });
  });

  it("приёмка по PIN: BOOKING_RETURNED в журнале брони", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");

    expect((await kit.complete(kit.pinToken, s.id, {})).status).toBe(200);
    const returned = (await auditOf(b)).filter((e: any) => e.action === "BOOKING_RETURNED");
    expect(returned).toHaveLength(1);
    expect(returned[0].userId).toBe("_system_");
    expect(JSON.parse(returned[0].after)).toMatchObject({
      status: "RETURNED",
      via: "kiosk",
      workerName: kit.pinName,
    });
  });

  it("приёмку открыл один, завершил другой: журнал склада и «Как пропало» называют завершившего", async () => {
    const eq = await kit.mkEquipment({ name: "Прибор для следа" });
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");
    expect((await kit.complete(kit.whToken, s.id, {})).status).toBe(200);

    // Автор записи — завершивший главной сессией, открывший — в `startedBy`.
    const [returned] = (await auditOf(b)).filter((e: any) => e.action === "BOOKING_RETURNED");
    expect(returned.userId).toBe(kit.whId);
    expect(JSON.parse(returned.after)).toMatchObject({ workerName: kit.whName, startedBy: kit.pinName });

    const all = await kit.get(kit.whToken, "/api/warehouse/journal?days=7&scope=all");
    expect(all.status).toBe(200);
    const entry = all.body.entries.find((e: any) => e.kind === "SESSION" && e.id === s.id);
    expect(entry.workerName).toBe(kit.whName);

    // «Мои» у завершившего содержат сессию, у открывшего — нет.
    const mine = await kit.get(kit.whToken, "/api/warehouse/journal?days=7&scope=me");
    expect(mine.body.entries.some((e: any) => e.id === s.id)).toBe(true);
    const opener = await kit.get(kit.pinToken, "/api/warehouse/journal?days=7&scope=me");
    expect(opener.body.entries.some((e: any) => e.id === s.id)).toBe(false);

    const shift = await kit.get(kit.whToken, "/api/warehouse/shift");
    expect(shift.status).toBe(200);
    expect(shift.body.myShift.sessions).toBeGreaterThanOrEqual(1);

    const { getEquipmentTrail } = await import("../services/stockCount/equipmentTrail");
    const trail = await getEquipmentTrail(eq);
    expect(trail.bookings.find((x: any) => x.bookingId === b)).toMatchObject({
      returnMode: "KIOSK",
      returnedBy: kit.whName,
    });
  });

  it("«Моя выработка»: чужая вчерашняя сессия, завершённая сегодня, не растягивает смену и среднее время", async () => {
    const { moscowTodayStart } = await import("../utils/moscowDate");
    const todayStart = moscowTodayStart();
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    // Приёмку открыл кладовщик по PIN вчера вечером и бросил.
    const s = await kit.openSession(kit.pinToken, b, "RETURN");
    await kit.prisma.scanSession.update({
      where: { id: s.id },
      data: { startedAt: new Date(todayStart.getTime() - 3 * 60 * 60 * 1000) },
    });
    // Сегодня её завершил кладовщик главной сессией.
    expect((await kit.complete(kit.whToken, s.id, {})).status).toBe(200);

    const shift = await kit.get(kit.whToken, "/api/warehouse/shift");
    expect(shift.status).toBe(200);
    const { firstAt, avgMinutes } = shift.body.myShift;
    // Смена началась не раньше сегодняшнего завершения чужой сессии, а не вчера.
    expect(new Date(firstAt).getTime()).toBeGreaterThanOrEqual(todayStart.getTime());
    expect(new Date(firstAt).getTime()).toBeLessThanOrEqual(Date.now());
    // Три часа чужого ожидания — не «среднее время на операцию» завершившего.
    expect(avgMinutes == null || avgMinutes < 60).toBe(true);
  });

  it("пробег машин записан от имени того, кто завершил приёмку", async () => {
    const eq = await kit.mkEquipment();
    const b = await kit.mkBooking({ status: "ISSUED", items: [{ equipmentId: eq, quantity: 1 }] });
    const vehicle = await kit.prisma.vehicle.create({
      data: { name: "Газель аудита", slug: `gazel-audit-${Date.now()}`, shiftPriceRub: "8000", currentMileage: 1000 },
    });
    await kit.prisma.bookingVehicle.create({ data: { bookingId: b, vehicleId: vehicle.id } });
    const s = await kit.openSession(kit.pinToken, b, "RETURN");

    const res = await kit.complete(kit.whToken, s.id, { vehicleMileages: [{ vehicleId: vehicle.id, mileage: 1250 }] });
    expect(res.status).toBe(200);
    const log = await kit.prisma.vehicleMileageLog.findFirst({ where: { vehicleId: vehicle.id }, orderBy: { recordedAt: "desc" } });
    expect(log.mileage).toBe(1250);
    expect(log.recordedBy).toBe(kit.whName);
  });
});
