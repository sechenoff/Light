/**
 * Занятость склада по факту (P9): полуоткрытые интервалы и выданные брони.
 *
 *  - Выданное раньше срока занимает склад с момента выдачи: раньше прибор,
 *    уже уехавший к клиенту, до даты начала числился свободным и его сдавали
 *    второй раз.
 *  - Просроченная невозвращённая бронь занимает окно, в которое попадает
 *    текущий момент. Окна целиком в будущем свободны — исходим из того, что
 *    к ним вернут (решение владельца; строже заблокировало бы подтверждение
 *    будущих броней, пока не нажат «Вернуть»).
 *  - Стык-в-стык — не пересечение: бронь до 22:00 и бронь с 22:00 того же дня
 *    подтверждаются обе (прод 10.09, «Творчество» → «MK»).
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-availability-issued-interval.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-avail-issued";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-avail-issued";
process.env.WAREHOUSE_SECRET = "test-warehouse-avail-issued-16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-avail-issued-min16chars";
process.env.APPROVAL_MODE = "auto"; // как на проде

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const at = (ms: number) => new Date(NOW + ms);

let app: any;
let prisma: any;
let saToken: string;
let clientId: string;
let seq = 0;

const H = () => ({ "X-API-Key": "test-key-avail-issued", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({
    data: { username: "avis_sa", passwordHash: await hashPassword("avis-pass-12345"), role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Клиент занятости" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(TEST_DB_PATH + s); } catch { /* ignore */ }
  }
});

async function mkEq(name: string, totalQuantity: number) {
  seq += 1;
  return (
    await prisma.equipment.create({
      data: { importKey: `avis-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: "COUNT", totalQuantity },
    })
  ).id as string;
}

async function mkBooking(status: string, start: Date, end: Date, items: Array<[string, number]>, extra: Record<string, unknown> = {}) {
  return (
    await prisma.booking.create({
      data: {
        clientId,
        projectName: `Бронь ${status}`,
        status,
        startDate: start,
        endDate: end,
        legacyFinance: false,
        ...extra,
        items: { create: items.map(([equipmentId, quantity]) => ({ equipmentId, quantity })) },
      },
    })
  ).id as string;
}

async function free(equipmentId: string, start: Date, end: Date): Promise<number> {
  const { getAvailability } = await import("../services/availability");
  const [row] = await getAvailability({ startDate: start, endDate: end, equipmentIds: [equipmentId] });
  return row.availableQuantity;
}

/** Черновик через API и публикация (при APPROVAL_MODE=auto — сразу подтверждение). */
async function draftAndSubmit(start: Date, end: Date, items: Array<{ equipmentId: string; quantity: number }>) {
  const d = await request(app).post("/api/bookings/draft").set(H()).send({
    client: { name: "Клиент занятости" },
    projectName: `Публикация ${++seq}`,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    items,
  });
  expect(d.status, JSON.stringify(d.body).slice(0, 300)).toBe(200);
  const id = d.body.booking?.id ?? d.body.id;
  const sub = await request(app).post(`/api/bookings/${id}/submit-for-approval`).set(H()).send({});
  return { id: id as string, submit: sub };
}

describe("интервал выданной брони", () => {
  it("выданное раньше срока занимает склад с момента выдачи", async () => {
    const eq = await mkEq("Единственный прибор C", 1);
    await mkBooking("ISSUED", at(5 * DAY), at(6 * DAY), [[eq, 1]], { issuedAt: new Date(NOW) });
    expect(await free(eq, at(2 * HOUR), at(26 * HOUR))).toBe(0); // раньше 1
    expect(await free(eq, at(7 * DAY), at(8 * DAY))).toBe(1); // после плановой даты возврата
  });

  it("просроченная невозвращённая бронь держит окно, в которое попадает «сейчас», но не будущие окна", async () => {
    const eq = await mkEq("Единственный прибор D", 1);
    await mkBooking("ISSUED", at(-3 * DAY), at(-DAY), [[eq, 1]], { issuedAt: at(-3 * DAY) });
    expect(await free(eq, at(-HOUR), at(26 * HOUR))).toBe(0);
    expect(await free(eq, new Date(), at(HOUR))).toBe(0); // окно «выдаю сейчас»
    const t = new Date();
    expect(await free(eq, t, t)).toBe(0); // «что занято в момент t»
    expect(await free(eq, at(2 * HOUR), at(26 * HOUR))).toBe(1); // решение владельца: будущее окно свободно
  });

  it("выданная в срок бронь не держит склад после плановой даты возврата", async () => {
    const eq = await mkEq("Прибор в срок", 2);
    const end = at(2 * DAY);
    await mkBooking("ISSUED", at(-DAY), end, [[eq, 2]], { issuedAt: at(-DAY) });
    expect(await free(eq, new Date(), at(HOUR))).toBe(0);
    expect(await free(eq, end, new Date(end.getTime() + DAY))).toBe(2);
  });

  it("выданная бронь без даты выдачи (старые данные) держит с плановой даты начала", async () => {
    const eq = await mkEq("Старая выдача", 1);
    await mkBooking("ISSUED", at(3 * DAY), at(4 * DAY), [[eq, 1]], { issuedAt: null });
    expect(await free(eq, at(HOUR), at(2 * DAY))).toBe(1);
    expect(await free(eq, at(3 * DAY), at(4 * DAY))).toBe(0);
  });

  it("потолок киоска и держатель видят просроченную выдачу: «свободно с» неизвестно", async () => {
    const eq = await mkEq("Просрочка в киоске", 1);
    await mkBooking("ISSUED", at(-3 * DAY), at(-DAY), [[eq, 1]], { issuedAt: at(-3 * DAY) });
    const target = await mkBooking("CONFIRMED", at(3 * HOUR), at(DAY), []);
    const { addonWindow, computeAddCaps } = await import("../services/stockCap");
    const { findAddonConflict } = await import("../services/addonAvailability");
    const booking = await prisma.booking.findUnique({ where: { id: target } });

    const window = addonWindow(booking, { issuingNow: true });
    const cap = (await computeAddCaps(prisma, { bookingId: target, equipmentIds: [eq], window })).get(eq)!;
    expect(cap).toMatchObject({ occupiedByOthers: 1, addCap: 0, ackCap: 1 });
    const conflict = await findAddonConflict(eq, window.start, window.end, target, { requested: 1 });
    expect(conflict).toMatchObject({ holderStatus: "ISSUED", overdue: true, freeFrom: null });

    // По плану (бронь ещё не выдают) окно начинается через 3 ч — прибор «вернут».
    const planCap = (await computeAddCaps(prisma, {
      bookingId: target,
      equipmentIds: [eq],
      window: addonWindow(booking, { issuingNow: false }),
    })).get(eq)!;
    expect(planCap.addCap).toBe(1);
  });
});

describe("полуоткрытые интервалы", () => {
  it("стык-в-стык не пересекается, на миллисекунду раньше — пересекается", async () => {
    const eq = await mkEq("Стык 2", 2);
    const d = at(40 * DAY);
    const aEnd = new Date(d.getTime() + DAY);
    await mkBooking("CONFIRMED", d, aEnd, [[eq, 2]]);
    expect(await free(eq, aEnd, new Date(aEnd.getTime() + DAY))).toBe(2); // раньше 0
    expect(await free(eq, new Date(aEnd.getTime() - 1), new Date(aEnd.getTime() + DAY))).toBe(0);
    // И в обратную сторону: окно, которое кончается ровно в момент начала брони.
    expect(await free(eq, new Date(d.getTime() - DAY), d)).toBe(2);
  });

  it("границы окна и резерва одни на пик и на «кто держит»", async () => {
    const { peakOccupancy, reservationOverlaps } = await import("../services/projectReservations");
    const r = (start: number, end: number, quantity = 1) => ({ equipmentId: "e", bookingId: `b${start}`, start, end, quantity });
    expect(reservationOverlaps(r(0, 10), 10, 20)).toBe(false);
    expect(reservationOverlaps(r(0, 10), 9, 20)).toBe(true);
    expect(reservationOverlaps(r(0, 10), 5, 5)).toBe(true); // окно-момент
    expect(reservationOverlaps(r(0, 10), 10, 10)).toBe(false);
    expect(peakOccupancy([r(0, 10, 2), r(10, 20, 2)], 0, 20)).toBe(2); // встык — не сумма
    expect(peakOccupancy([r(0, 11, 2), r(10, 20, 2)], 0, 20)).toBe(4);
  });
});

describe("подтверждение брони (как на проде, APPROVAL_MODE=auto)", () => {
  it("стык-в-стык: бронь до T публикуется при подтверждённой брони с T (1 шт. в парке)", async () => {
    const eq = await mkEq("Текстиль 8×8 SD Light", 1);
    const T = at(20 * DAY);
    T.setUTCHours(19, 0, 0, 0); // 22:00 МСК
    const mk = await draftAndSubmit(T, new Date(T.getTime() + DAY), [{ equipmentId: eq, quantity: 1 }]);
    expect(mk.submit.status, JSON.stringify(mk.submit.body).slice(0, 300)).toBe(200);
    const art = await draftAndSubmit(new Date(T.getTime() - DAY), T, [{ equipmentId: eq, quantity: 1 }]);
    expect(art.submit.status, JSON.stringify(art.submit.body).slice(0, 300)).toBe(200); // раньше 409 «свободно 0 из 1»
    expect((await prisma.booking.findUnique({ where: { id: art.id } })).status).toBe("CONFIRMED");
  });

  it("выданный заранее единственный прибор второй раз не подтверждается", async () => {
    const eq = await mkEq("Прибор выдан заранее", 1);
    const early = await draftAndSubmit(at(5 * DAY), at(6 * DAY), [{ equipmentId: eq, quantity: 1 }]);
    expect(early.submit.status).toBe(200);
    const issued = await request(app).post(`/api/bookings/${early.id}/status`).set(H()).send({ action: "issue", force: true });
    expect(issued.status, JSON.stringify(issued.body).slice(0, 300)).toBe(200);

    const second = await draftAndSubmit(at(2 * HOUR), at(26 * HOUR), [{ equipmentId: eq, quantity: 1 }]);
    expect(second.submit.status).toBe(409); // раньше 200: прибор у клиента числился свободным
    expect((await prisma.booking.findUnique({ where: { id: second.id } })).status).toBe("DRAFT");
  });

  it("просроченная невозвращённая бронь: бронь на «сейчас» не подтверждается, на завтра — подтверждается", async () => {
    const eq = await mkEq("Прибор D не вернули", 1);
    await mkBooking("ISSUED", at(-3 * DAY), at(-DAY), [[eq, 1]], { issuedAt: at(-3 * DAY) });

    const now = await draftAndSubmit(at(-HOUR), at(26 * HOUR), [{ equipmentId: eq, quantity: 1 }]);
    expect(now.submit.status).toBe(409);
    const tomorrow = await draftAndSubmit(at(DAY), at(2 * DAY), [{ equipmentId: eq, quantity: 1 }]);
    expect(tomorrow.submit.status).toBe(200);
  });
});
