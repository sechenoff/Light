/**
 * «Как пропало» — getEquipmentTrail (спека §5).
 *
 * Проверяем окно (по умолчанию 60 дней / от прошлой сверки / явное), режимы
 * приёмки (киоск / кнопкой / системой / ещё у клиента), подсказку единственного
 * кандидата, исключение архивных броней, открытые потеряшки и разбивку «на полке».
 * «Ещё у клиента» совпадает с формулой §3: CONFIRMED с прошедшим сроком — кандидат.
 *
 * Даты — только от Date.now().
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-equipment-trail.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-equipment-trail";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

let prisma: any;
let getEquipmentTrail: typeof import("../services/stockCount/equipmentTrail").getEquipmentTrail;

let equipmentId: string;
let manyId: string;
let endedId: string;
let mixedId: string;
const booking: Record<string, string> = {};

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  getEquipmentTrail = (await import("../services/stockCount/equipmentTrail")).getEquipmentTrail;

  const manager = await prisma.adminUser.create({
    data: { username: "sechenoff", passwordHash: "!", role: "WAREHOUSE" },
  });
  const system = await prisma.adminUser.create({
    data: { id: "_system_", username: "_system_", passwordHash: "!disabled", role: "SUPER_ADMIN" },
  });

  const eq = await prisma.equipment.create({
    data: {
      importKey: "trail-softbox",
      name: "Софтбокс 90",
      category: "Свет",
      totalQuantity: 10,
      rentalRatePerShift: "700",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;
  const other = await prisma.equipment.create({
    data: {
      importKey: "trail-other",
      name: "Решётка",
      category: "Свет",
      totalQuantity: 10,
      rentalRatePerShift: "100",
      stockTrackingMode: "COUNT",
    },
  });
  const many = await prisma.equipment.create({
    data: {
      importKey: "trail-many",
      name: "Кабель ходовой",
      category: "Коммутация",
      totalQuantity: 100,
      rentalRatePerShift: "50",
      stockTrackingMode: "COUNT",
    },
  });
  manyId = many.id;

  const client = await prisma.client.create({ data: { name: "Клиент Следа" } });
  async function make(
    key: string,
    status: string,
    startDays: number,
    endDays: number,
    qty: number,
    extra: Record<string, unknown> = {},
    extraItems: Array<{ equipmentId: string; quantity: number }> = [],
  ) {
    const b = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: `Проект ${key}`,
        status,
        startDate: daysFromNow(startDays),
        endDate: daysFromNow(endDays),
        items: { create: [{ equipmentId, quantity: qty }, ...extraItems] },
        ...extra,
      },
      include: { items: true },
    });
    booking[key] = b.id;
    return b;
  }

  const kiosk = await make("kiosk", "RETURNED", -10, -8, 3, {}, [{ equipmentId: other.id, quantity: 4 }]);
  await make("manual", "RETURNED", -20, -18, 1);
  await make("auto", "RETURNED", -30, -28, 2);
  await make("noaudit", "RETURNED", -40, -39, 1);
  await make("out", "ISSUED", -2, 2, 2);
  await make("conf", "CONFIRMED", -1, 1, 1);
  await make("future", "CONFIRMED", 5, 7, 4);
  await make("old", "RETURNED", -90, -85, 1);
  await make("archived", "RETURNED", -5, -4, 1, { deletedAt: new Date() });
  await make("draft", "DRAFT", -3, -2, 1);

  // Киоск: завершённая приёмка. Выдача в киоске и отменённая приёмка — не приёмка.
  await prisma.scanSession.create({
    data: {
      bookingId: booking.kiosk, workerName: "Иван", operation: "RETURN", status: "COMPLETED",
      completedAt: daysFromNow(-8),
    },
  });
  await prisma.scanSession.create({
    data: {
      bookingId: booking.manual, workerName: "Пётр", operation: "ISSUE", status: "COMPLETED",
      completedAt: daysFromNow(-20),
    },
  });
  await prisma.scanSession.create({
    data: { bookingId: booking.auto, workerName: "Пётр", operation: "RETURN", status: "CANCELLED" },
  });

  // Возврат кнопкой и системой — в день окончания брони.
  await prisma.auditEntry.create({
    data: {
      userId: manager.id, action: "BOOKING_RETURNED", entityType: "Booking", entityId: booking.manual,
      createdAt: daysFromNow(-18),
    },
  });
  await prisma.auditEntry.create({
    data: {
      userId: system.id, action: "BOOKING_RETURNED", entityType: "Booking", entityId: booking.auto,
      createdAt: daysFromNow(-28),
    },
  });

  // Замечания приёмки в киоске: по этой позиции — потеряшка 1 шт. и ремонт 2 шт.
  // Потеряшка по ДРУГОЙ позиции той же брони в замечания не попадает.
  const kioskItem = kiosk.items.find((i: any) => i.equipmentId === equipmentId);
  const otherItem = kiosk.items.find((i: any) => i.equipmentId === other.id);
  await prisma.problemItem.create({
    data: {
      bookingItemId: kioskItem.id, sourceBookingId: booking.kiosk, quantity: 1, reason: "LOST",
      comment: "не вернули", createdBy: "Иван", createdAt: daysFromNow(-8),
    },
  });
  await prisma.problemItem.create({
    data: {
      bookingItemId: otherItem.id, sourceBookingId: booking.kiosk, quantity: 4, reason: "LOST",
      comment: "решётки", createdBy: "Иван",
    },
  });
  await prisma.repair.create({
    data: { equipmentId, sourceBookingId: booking.kiosk, quantity: 2, reason: "порван", createdBy: "Иван" },
  });

  // Открытая ручная потеряшка и закрытая (FOUND) — последняя в след не входит.
  await prisma.problemItem.create({
    data: {
      equipmentId, quantity: 2, reason: "LOST", comment: "вручную", source: "MANUAL",
      createdBy: "sechenoff", createdAt: daysFromNow(-3),
    },
  });
  await prisma.problemItem.create({
    data: { equipmentId, quantity: 5, reason: "LOST", comment: "нашлись", status: "FOUND", createdBy: "sechenoff" },
  });

  // CONFIRMED, чей срок уже прошёл: ни выдачу, ни возврат никто не отметил.
  // По формуле §3 она уже «на полке», значит, в следе — кандидат, а не «у клиента».
  async function makeOn(
    eqId: string,
    key: string,
    status: string,
    startDays: number,
    endDays: number,
    qty: number,
  ) {
    const b = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: `Проект ${key}`,
        status,
        startDate: daysFromNow(startDays),
        endDate: daysFromNow(endDays),
        items: { create: [{ equipmentId: eqId, quantity: qty }] },
      },
    });
    booking[key] = b.id;
    return b;
  }

  const ended = await prisma.equipment.create({
    data: {
      importKey: "trail-ended",
      name: "Штанга",
      category: "Грип",
      totalQuantity: 5,
      rentalRatePerShift: "300",
      stockTrackingMode: "COUNT",
    },
  });
  endedId = ended.id;
  await makeOn(endedId, "endedSolo", "CONFIRMED", -5, -2, 2);

  // Та же развилка среди других броней: принятая в киоске, выданная, идущая
  // по календарю (срок кончается через час) и просроченная CONFIRMED.
  const mixed = await prisma.equipment.create({
    data: {
      importKey: "trail-mixed",
      name: "Журавль",
      category: "Грип",
      totalQuantity: 6,
      rentalRatePerShift: "900",
      stockTrackingMode: "COUNT",
    },
  });
  mixedId = mixed.id;
  await makeOn(mixedId, "mixKiosk", "RETURNED", -9, -8, 1);
  await makeOn(mixedId, "mixConfEnded", "CONFIRMED", -6, -4, 2);
  await makeOn(mixedId, "mixConfNow", "CONFIRMED", -1, 1 / 24, 1);
  await makeOn(mixedId, "mixIssued", "ISSUED", -2, 2, 1);
  await prisma.scanSession.create({
    data: {
      bookingId: booking.mixKiosk, workerName: "Иван", operation: "RETURN", status: "COMPLETED",
      completedAt: daysFromNow(-8),
    },
  });

  // Позиция с большим числом броней — потолок выдачи 50.
  for (let i = 0; i < 52; i++) {
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: `Массовая ${i}`,
        status: "RETURNED",
        startDate: daysFromNow(-50 + i * 0.5),
        endDate: daysFromNow(-49 + i * 0.5),
        items: { create: [{ equipmentId: manyId, quantity: 1 }] },
      },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("getEquipmentTrail", () => {
  it("окно по умолчанию — 60 дней, если позиция не сверялась", async () => {
    const trail = await getEquipmentTrail(equipmentId);
    expect(trail.windowIsDefault).toBe(true);
    const from = new Date(trail.windowFrom).getTime();
    expect(Math.abs(from - daysFromNow(-60).getTime())).toBeLessThan(60_000);

    // Архивная, черновик, будущая и старше окна — не в следе. Порядок — по startDate desc.
    expect(trail.bookings.map((b) => b.bookingId)).toEqual([
      booking.conf, booking.out, booking.kiosk, booking.manual, booking.auto, booking.noaudit,
    ]);
    expect(trail.totalBookings).toBe(6);
    expect(trail.name).toBe("Софтбокс 90");
    expect(trail.category).toBe("Свет");
  });

  it("режимы приёмки: киоск / кнопкой / системой / ещё у клиента", async () => {
    const trail = await getEquipmentTrail(equipmentId);
    const by = Object.fromEntries(trail.bookings.map((b) => [b.bookingId, b]));

    expect(by[booking.kiosk]).toMatchObject({
      returnMode: "KIOSK",
      returnedBy: "Иван",
      quantity: 3,
      status: "RETURNED",
      remarks: { problemQty: 1, repairQty: 2 },
      projectName: "Проект kiosk",
      clientName: "Клиент Следа",
    });
    // Выдача в киоске — не приёмка: возврат отмечен кнопкой.
    expect(by[booking.manual]).toMatchObject({ returnMode: "MANUAL", returnedBy: "sechenoff", remarks: null });
    // Отменённая приёмка не считается; вернула система.
    expect(by[booking.auto]).toMatchObject({ returnMode: "AUTO", returnedBy: "_system_", remarks: null });
    expect(by[booking.noaudit]).toMatchObject({ returnMode: "MANUAL", returnedBy: null });
    expect(by[booking.out]).toMatchObject({ returnMode: "OUT", status: "ISSUED" });
    expect(by[booking.conf]).toMatchObject({ returnMode: "OUT", status: "CONFIRMED" });

    expect(trail.verifiedReturns).toBe(1);
    // Кандидатов трое (кнопкой, системой, без следа) — подсказки нет.
    expect(trail.suggestedBookingId).toBeNull();
  });

  it("открытые потеряшки позиции и разбивка «на полке сейчас»", async () => {
    const trail = await getEquipmentTrail(equipmentId);
    expect(trail.openProblems.map((p) => [p.quantity, p.status, p.projectName])).toEqual([
      [1, "SEARCHING", "Проект kiosk"],
      [2, "SEARCHING", null],
    ]);
    // 10 − 2 у клиента − 1 по календарю − 2 в ремонте − 3 в потеряшках.
    expect(trail.onShelf).toEqual({ total: 10, issued: 2, calendar: 1, repair: 2, lost: 3, expected: 2 });
    expect(JSON.stringify(trail)).not.toMatch(/barcode/i);
  });

  it("окно от прошлой сверки: единственный кандидат становится подсказкой", async () => {
    await prisma.equipment.update({ where: { id: equipmentId }, data: { lastCountedAt: daysFromNow(-25) } });
    const trail = await getEquipmentTrail(equipmentId);
    expect(trail.windowIsDefault).toBe(false);
    expect(Math.abs(new Date(trail.windowFrom).getTime() - daysFromNow(-25).getTime())).toBeLessThan(60_000);
    expect(trail.bookings.map((b) => b.bookingId)).toEqual([
      booking.conf, booking.out, booking.kiosk, booking.manual,
    ]);
    expect(trail.suggestedBookingId).toBe(booking.manual);
  });

  it("явное начало окна важнее прошлой сверки; null — окно по умолчанию", async () => {
    const narrow = await getEquipmentTrail(equipmentId, { since: daysFromNow(-15) });
    expect(narrow.windowIsDefault).toBe(false);
    expect(narrow.bookings.map((b) => b.bookingId)).toEqual([booking.conf, booking.out, booking.kiosk]);
    // Остались только принятые в киоске и те, что у клиента, — подсказать нечего.
    expect(narrow.suggestedBookingId).toBeNull();

    const reset = await getEquipmentTrail(equipmentId, { since: null });
    expect(reset.windowIsDefault).toBe(true);
    expect(reset.totalBookings).toBe(6);
  });

  it("след на прошлый момент: брони, начавшиеся позже, не попадают", async () => {
    const trail = await getEquipmentTrail(equipmentId, { since: null, at: daysFromNow(-19) });
    expect(trail.bookings.map((b) => b.bookingId)).toEqual([booking.manual, booking.auto, booking.noaudit]);
  });

  it("CONFIRMED с прошедшим сроком — кандидат без «кто принял», а не «ещё у клиента»", async () => {
    const trail = await getEquipmentTrail(endedId);
    expect(trail.bookings).toHaveLength(1);
    expect(trail.bookings[0]).toMatchObject({
      bookingId: booking.endedSolo,
      status: "CONFIRMED",
      returnMode: "MANUAL",
      returnedBy: null,
      remarks: null,
    });
    expect(trail.verifiedReturns).toBe(0);
    expect(trail.suggestedBookingId).toBe(booking.endedSolo);
    // След согласован с формулой §3: просроченная CONFIRMED уже ждёт на полке.
    expect(trail.onShelf).toEqual({ total: 5, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 5 });
  });

  it("срок вышел — кандидат; идёт по календарю или выдана — «ещё у клиента»", async () => {
    const trail = await getEquipmentTrail(mixedId, { since: daysFromNow(-10) });
    const by = Object.fromEntries(trail.bookings.map((b) => [b.bookingId, b]));
    expect(trail.bookings.map((b) => b.bookingId)).toEqual([
      booking.mixConfNow, booking.mixIssued, booking.mixConfEnded, booking.mixKiosk,
    ]);
    expect(by[booking.mixConfEnded]).toMatchObject({ status: "CONFIRMED", returnMode: "MANUAL", returnedBy: null });
    // Граница: срок кончается через час — бронь ещё на съёмке по календарю.
    expect(by[booking.mixConfNow]).toMatchObject({ status: "CONFIRMED", returnMode: "OUT", returnedBy: null });
    expect(by[booking.mixIssued]).toMatchObject({ status: "ISSUED", returnMode: "OUT" });
    expect(by[booking.mixKiosk]).toMatchObject({ status: "RETURNED", returnMode: "KIOSK", returnedBy: "Иван" });
    expect(trail.verifiedReturns).toBe(1);
    // Единственная бронь не из киоска и не у клиента — она и есть подсказка.
    expect(trail.suggestedBookingId).toBe(booking.mixConfEnded);
    // Из «на полке должно быть» вычтены только выданная и идущая по календарю.
    expect(trail.onShelf).toEqual({ total: 6, issued: 1, calendar: 1, repair: 0, lost: 0, expected: 4 });
  });

  it("не больше 50 броней в ответе, но счётчики — по всему окну", async () => {
    const trail = await getEquipmentTrail(manyId);
    expect(trail.totalBookings).toBe(52);
    expect(trail.bookings).toHaveLength(50);
    expect(trail.bookings[0].projectName).toBe("Массовая 51");
  });

  it("несуществующая позиция → 404 EQUIPMENT_NOT_FOUND", async () => {
    await expect(getEquipmentTrail("no-such-equipment")).rejects.toMatchObject({
      status: 404,
      code: "EQUIPMENT_NOT_FOUND",
    });
  });
});

// ─── Поздние возвраты и мастерская ───────────────────────────────────────────

describe("getEquipmentTrail — поздние возвраты и события мастерской", () => {
  let client: any;
  let manager: any;

  async function position(key: string, lastCountedDays: number | null) {
    const e = await prisma.equipment.create({
      data: {
        importKey: `trail-late-${key}`,
        name: `Позиция ${key}`,
        category: "Поздние",
        totalQuantity: 8,
        rentalRatePerShift: "200",
        stockTrackingMode: "COUNT",
        lastCountedAt: lastCountedDays == null ? null : daysFromNow(lastCountedDays),
      },
    });
    return e.id as string;
  }

  async function overdue(eqId: string, key: string) {
    const b = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: `Просрочка ${key}`,
        status: "RETURNED",
        startDate: daysFromNow(-20),
        endDate: daysFromNow(-15),
        items: { create: [{ equipmentId: eqId, quantity: 2 }] },
      },
    });
    booking[key] = b.id;
    return b;
  }

  beforeAll(async () => {
    client = await prisma.client.findFirst({ where: { name: "Клиент Следа" } });
    manager = await prisma.adminUser.findFirst({ where: { username: "sechenoff" } });
  });

  it("просроченная бронь, принятая кнопкой после прошлой сверки, — в следе и подсказка", async () => {
    const eqId = await position("button", -10);
    await overdue(eqId, "lateButton");
    await prisma.auditEntry.create({
      data: {
        userId: manager.id, action: "BOOKING_RETURNED", entityType: "Booking", entityId: booking.lateButton,
        createdAt: daysFromNow(-3),
      },
    });
    const trail = await getEquipmentTrail(eqId);
    expect(trail.bookings.map((b) => b.bookingId)).toEqual([booking.lateButton]);
    expect(trail.bookings[0]).toMatchObject({ returnMode: "MANUAL", returnedBy: "sechenoff" });
    expect(trail.suggestedBookingId).toBe(booking.lateButton);

    // На момент до возврата она ещё была у клиента — вычтена из полки, а не кандидат.
    const before = await getEquipmentTrail(eqId, { at: daysFromNow(-5) });
    expect(before.bookings[0]).toMatchObject({ bookingId: booking.lateButton, returnMode: "OUT" });
    expect(before.suggestedBookingId).toBeNull();
  });

  it("просроченная бронь, принятая в киоске после прошлой сверки, — в следе как принятая с пересчётом", async () => {
    const eqId = await position("kiosk", -10);
    await overdue(eqId, "lateKiosk");
    await prisma.scanSession.create({
      data: {
        bookingId: booking.lateKiosk, workerName: "Олег", operation: "RETURN", status: "COMPLETED",
        completedAt: daysFromNow(-3),
      },
    });
    const trail = await getEquipmentTrail(eqId);
    expect(trail.bookings.map((b) => b.bookingId)).toEqual([booking.lateKiosk]);
    expect(trail.bookings[0]).toMatchObject({ returnMode: "KIOSK", returnedBy: "Олег" });
    expect(trail.verifiedReturns).toBe(1);
  });

  it("возврат до окна — вне следа, как и раньше", async () => {
    const eqId = await position("early", -10);
    await overdue(eqId, "earlyReturn");
    await prisma.auditEntry.create({
      data: {
        userId: manager.id, action: "BOOKING_RETURNED", entityType: "Booking", entityId: booking.earlyReturn,
        createdAt: daysFromNow(-14),
      },
    });
    const trail = await getEquipmentTrail(eqId);
    expect(trail.bookings).toEqual([]);
  });

  it("мастерская списала или починила — подсказки брони нет, события в следе", async () => {
    const eqId = await position("repair", -10);
    const b = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Единственная",
        status: "RETURNED",
        startDate: daysFromNow(-6),
        endDate: daysFromNow(-5),
        items: { create: [{ equipmentId: eqId, quantity: 1 }] },
      },
    });
    const clean = await getEquipmentTrail(eqId);
    expect(clean.suggestedBookingId).toBe(b.id);
    expect(clean.repairEvents).toEqual({ writtenOffQty: 0, readyForPickupQty: 0 });

    await prisma.repair.create({
      data: { equipmentId: eqId, quantity: 2, reason: "сгорели", status: "WROTE_OFF", closedAt: daysFromNow(-4), createdBy: "x" },
    });
    // Списание до окна и починенное больше недели назад — не в счёт.
    await prisma.repair.create({
      data: { equipmentId: eqId, quantity: 5, reason: "давно", status: "WROTE_OFF", closedAt: daysFromNow(-20), createdBy: "x" },
    });
    await prisma.repair.create({
      data: { equipmentId: eqId, quantity: 7, reason: "давно", status: "CLOSED", closedAt: daysFromNow(-9), createdBy: "x" },
    });
    await prisma.repair.create({
      data: { equipmentId: eqId, quantity: 1, reason: "перепаяли", status: "CLOSED", closedAt: daysFromNow(-2), createdBy: "x" },
    });
    const trail = await getEquipmentTrail(eqId);
    expect(trail.repairEvents).toEqual({ writtenOffQty: 2, readyForPickupQty: 1 });
    expect(trail.suggestedBookingId).toBeNull();
    expect(trail.bookings.map((x) => x.bookingId)).toEqual([b.id]);
  });
});
