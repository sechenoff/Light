/**
 * Ручные кнопки карточки брони: понятные отказы и защита от гонок.
 *
 * До исправления:
 *  - отказ приходил ENUM-текстом «Недопустимый переход: ISSUED -> issue» и без
 *    кода — интерфейс не мог ни объяснить, ни перечитать бронь;
 *  - проверка статуса стояла ДО транзакции: «Отменить» (руководитель в реестре)
 *    и «Выдать» (склад на карточке) в одну секунду проходили обе, и выданная
 *    бронь становилась «Отменена» с записью «Выдано» в журнале; три быстрых
 *    «Вернуть» писали три события;
 *  - «Вернуть» бронь с машиной молча пропускал пробег.
 */
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-booking-status-messages.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-bsm";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-bsm";
process.env.WAREHOUSE_SECRET = "test-warehouse-bsm-16chars";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-bsm-min16chars";

let app: any;
let prisma: any;
let saToken: string;
let whToken: string;
let techToken: string;
let clientId: string;
let eqA: string;
let vehicleId: string;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const H = (token: string) => ({ "X-API-Key": "test-key-bsm", Authorization: `Bearer ${token}` });

async function mkBooking(opts: {
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  name: string;
  startOffset?: number;
  withVehicle?: boolean;
}) {
  const start = new Date(Date.now() + (opts.startOffset ?? -HOUR));
  const end = new Date(start.getTime() + DAY);
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: opts.name,
      startDate: start,
      endDate: end,
      status: opts.status,
      ...(opts.status === "ISSUED" || opts.status === "RETURNED" ? { issuedAt: start } : {}),
      totalEstimateAmount: "1000",
      discountAmount: "0",
      finalAmount: "1000",
      amountOutstanding: "1000",
      legacyFinance: false,
      items: { create: [{ equipmentId: eqA, quantity: 1 }] },
      ...(opts.withVehicle
        ? { vehicles: { create: [{ vehicleId, subtotalRub: "0" }] } }
        : {}),
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 1,
          subtotal: "1000",
          discountAmount: "0",
          totalAfterDiscount: "1000",
          lines: {
            create: [{ equipmentId: eqA, categorySnapshot: "Свет", nameSnapshot: "Прибор", quantity: 1, unitPrice: "1000", lineSum: "1000" }],
          },
        },
      },
    },
  });
  return b.id as string;
}

const status = (id: string, action: string, token = saToken, extra: Record<string, unknown> = {}) =>
  request(app).post(`/api/bookings/${id}/status`).set(H(token)).send({ action, ...extra });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("bsm-pass-123456");
  const sa = await prisma.adminUser.create({ data: { username: "bsm_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({ data: { username: "bsm_wh", passwordHash: hash, role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  const tech = await prisma.adminUser.create({ data: { username: "bsm_tech", passwordHash: hash, role: "TECHNICIAN" } });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
  clientId = (await prisma.client.create({ data: { name: "Клиент сообщений", phone: "+70000004343" } })).id;
  eqA = (await prisma.equipment.create({
    data: { importKey: "bsm-a", name: "Прибор сообщений", category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: "COUNT", totalQuantity: 500 },
  })).id;
  vehicleId = (await prisma.vehicle.create({
    data: { name: "Форд сообщений", slug: "bsm-ford", shiftPriceRub: "10000", currentMileage: 1000, serviceIntervalKm: 10000 },
  })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("отказ ручной кнопки — по-русски, с кодом и статусом", () => {
  const cases: Array<{ from: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED"; action: string; message: string }> = [
    { from: "ISSUED", action: "issue", message: "Бронь уже выдана — обновите страницу" },
    { from: "RETURNED", action: "issue", message: "Бронь уже принята — обновите страницу" },
    { from: "CANCELLED", action: "issue", message: "Бронь отменена — обновите страницу" },
    { from: "DRAFT", action: "issue", message: "Черновик нельзя выдать — сначала подтвердите бронь" },
    { from: "PENDING_APPROVAL", action: "issue", message: "Бронь на согласовании — выдать можно после подтверждения" },
    { from: "CONFIRMED", action: "return", message: "Бронь ещё не выдана — сначала отметьте выдачу" },
    { from: "PENDING_APPROVAL", action: "return", message: "Бронь ещё не выдана — сначала отметьте выдачу" },
    { from: "DRAFT", action: "return", message: "Бронь ещё не выдана — сначала отметьте выдачу" },
    { from: "RETURNED", action: "return", message: "Бронь уже принята — обновите страницу" },
    { from: "ISSUED", action: "cancel", message: "Выданную бронь нельзя отменить — сначала примите возврат" },
    { from: "RETURNED", action: "cancel", message: "Принятую бронь нельзя отменить" },
  ];
  for (const c of cases) {
    it(`${c.from} × ${c.action} → «${c.message}»`, async () => {
      const id = await mkBooking({ status: c.from, name: `Сообщение ${c.from} ${c.action}` });
      const res = await status(id, c.action);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_BOOKING_STATE");
      expect(res.body.message).toBe(c.message);
      expect(res.body.details).toMatchObject({ status: c.from, action: c.action });
    });
  }

  it("групповая отмена выданной брони — тот же текст (cancelBooking)", async () => {
    const id = await mkBooking({ status: "ISSUED", name: "Групповая отмена выданной" });
    const res = await request(app).post("/api/bookings/bulk").set(H(saToken)).send({ action: "cancel", ids: [id] });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ ok: false, code: "INVALID_BOOKING_STATE", message: "Выданную бронь нельзя отменить — сначала примите возврат" });
  });

  it("ранняя выдача: прежний текст ISSUE_TOO_EARLY и повтор с force", async () => {
    const id = await mkBooking({ status: "CONFIRMED", name: "Ранняя выдача", startOffset: 5 * DAY });
    const res = await status(id, "issue", whToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ISSUE_TOO_EARLY");
    expect(res.body.message).toMatch(/^Аренда начинается \d{2}\.\d{2}\.\d{4} — до начала больше суток\. Проверьте бронь; если выдаёте заранее осознанно, подтвердите выдачу\.$/);
    const forced = await status(id, "issue", whToken, { force: true });
    expect(forced.status).toBe(200);
    const audit = await prisma.auditEntry.findFirst({ where: { entityId: id, action: "BOOKING_ISSUED" } });
    expect(JSON.parse(audit.after).forcedEarlyIssue).toBe(true);
  });

  it("граница ранней выдачи — 24 ч: за 24 ч 5 мин — 409, за 23 ч 55 мин — выдаётся", async () => {
    const early = await mkBooking({ status: "CONFIRMED", name: "Граница плюс", startOffset: 24 * HOUR + 5 * 60_000 });
    const r = await status(early, "issue", whToken);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ISSUE_TOO_EARLY");
    const inTime = await mkBooking({ status: "CONFIRMED", name: "Граница минус", startOffset: 24 * HOUR - 5 * 60_000 });
    expect((await status(inTime, "issue", whToken)).status).toBe(200);
  });

  it("техник кнопкой не выдаёт (403), архивную бронь выдать нельзя", async () => {
    const id = await mkBooking({ status: "CONFIRMED", name: "Роли и архив" });
    expect((await status(id, "issue", techToken)).status).toBe(403);
    await prisma.booking.update({ where: { id }, data: { deletedAt: new Date() } });
    const r = await status(id, "issue");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("BOOKING_ARCHIVED");
    expect((await prisma.booking.findUnique({ where: { id } })).status).toBe("CONFIRMED");
  });
});

describe("гонки двух сотрудников", () => {
  it("«Отменить» ‖ «Выдать» в одну секунду: проходит ровно одно действие, итог сходится с журналом", async () => {
    for (let k = 0; k < 3; k++) {
      const id = await mkBooking({ status: "CONFIRMED", name: `Гонка отмены ${k}` });
      const [cancel, issue] = await Promise.all([status(id, "cancel"), status(id, "issue", whToken)]);
      const statuses = [cancel.status, issue.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = cancel.status === 409 ? cancel : issue;
      expect(loser.body.code).toBe("INVALID_BOOKING_STATE");

      const b = await prisma.booking.findUnique({ where: { id } });
      const actions = (await prisma.auditEntry.findMany({ where: { entityId: id } })).map((a: any) => a.action);
      if (b.status === "CANCELLED") expect(actions).not.toContain("BOOKING_ISSUED");
      else {
        expect(b.status).toBe("ISSUED");
        expect(actions).toContain("BOOKING_ISSUED");
      }
    }
  });

  it("три быстрых «Вернуть» подряд: одна запись в журнале и одно финсобытие, остальные — 409", async () => {
    const id = await mkBooking({ status: "ISSUED", name: "Тройной тап" });
    const rs = await Promise.all([status(id, "return", whToken), status(id, "return"), status(id, "return", whToken)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const rejected = rs.filter((r) => r.status !== 200);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("INVALID_BOOKING_STATE");
    }
    expect(await prisma.auditEntry.count({ where: { entityId: id, action: "BOOKING_RETURNED" } })).toBe(1);
    expect(
      await prisma.bookingFinanceEvent.count({ where: { bookingId: id, eventType: "BOOKING_STATUS_CHANGED" } }),
    ).toBe(1);
  });

  it("две параллельные «Выдать»: одна выдача в журнале", async () => {
    const id = await mkBooking({ status: "CONFIRMED", name: "Двойной клик" });
    const [r1, r2] = await Promise.all([status(id, "issue", whToken), status(id, "issue")]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditEntry.count({ where: { entityId: id, action: "BOOKING_ISSUED" } })).toBe(1);
  });
});

describe("пробег при ручной приёмке", () => {
  it("«Вернуть» бронь с машиной — предупреждение внести пробег в карточке машины", async () => {
    const id = await mkBooking({ status: "ISSUED", name: "С машиной", withVehicle: true });
    const res = await status(id, "return", whToken);
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/Пробег машин не записан — внесите его в карточке машины/);
  });

  it("без машины предупреждения нет", async () => {
    const id = await mkBooking({ status: "ISSUED", name: "Без машины" });
    const res = await status(id, "return", whToken);
    expect(res.status).toBe(200);
    expect(res.body.warning ?? null).toBeNull();
  });
});
