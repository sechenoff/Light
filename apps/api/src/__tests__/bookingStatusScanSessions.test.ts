/**
 * Ручные «Выдать» / «Вернуть» / «Отменить» / архивация и сессии киоска.
 *
 * До исправления (прод, 05.09 и 24.09): сессия, открытая в киоске и брошенная,
 * переживала ручную выдачу и приёмку и навсегда блокировала «+ Добор» со
 * страницы брони — совет «добавьте позицию в чек-листе киоска» был
 * невыполним, а кнопки закрыть сессию не было нигде. На проде 8 таких сессий
 * висели на уже принятых бронях.
 *
 * Правила (план «Выдача и приёмка», раздел 0):
 *  - ручные операции закрывают ACTIVE-сессии брони в своей транзакции и пишут
 *    аудит SCAN_SESSION_CANCELLED;
 *  - добор со страницы блокирует только ЖИВАЯ сессия С РАБОТОЙ (черновик,
 *    скан или добор этой сессии); «открыл и посмотрел» не блокирует;
 *  - карточка и списки видят, какая сессия устарела (`stale`), а какая живая
 *    (`liveScanSession`).
 */
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-booking-status-scan-sessions.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-bss";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-bss";
process.env.WAREHOUSE_SECRET = "test-warehouse-bss-16chars";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-bss-min16chars";

let app: any;
let prisma: any;
let saToken: string;
let whToken: string;
let saUsername: string;
let clientId: string;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const H = (token: string) => ({ "X-API-Key": "test-key-bss", Authorization: `Bearer ${token}` });

let seq = 0;
async function mkEq(name: string, total: number, mode: "COUNT" | "UNIT" = "COUNT") {
  seq += 1;
  const eq = await prisma.equipment.create({
    data: { importKey: `bss-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: mode, totalQuantity: total },
  });
  if (mode === "UNIT") {
    for (let i = 1; i <= total; i++) {
      await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "AVAILABLE", internalInventoryNumber: `BSS-${seq}-${i}` } });
    }
  }
  return eq.id as string;
}

/** Бронь с MAIN-сметой (1 смена, без скидки) — как после confirmBooking. Начало час назад. */
async function mkBooking(opts: {
  status: "CONFIRMED" | "ISSUED" | "RETURNED";
  name: string;
  items: Array<{ equipmentId: string; quantity: number }>;
}) {
  const start = new Date(Date.now() - HOUR);
  const end = new Date(start.getTime() + DAY);
  const total = opts.items.reduce((s, i) => s + i.quantity * 1000, 0);
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: opts.name,
      startDate: start,
      endDate: end,
      status: opts.status,
      ...(opts.status !== "CONFIRMED" ? { issuedAt: start } : {}),
      confirmedAt: new Date(),
      totalEstimateAmount: String(total),
      discountAmount: "0",
      finalAmount: String(total),
      amountOutstanding: String(total),
      legacyFinance: false,
      items: { create: opts.items.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 1,
          subtotal: String(total),
          discountAmount: "0",
          totalAfterDiscount: String(total),
          lines: {
            create: opts.items.map((i, idx) => ({
              equipmentId: i.equipmentId,
              categorySnapshot: "Свет",
              nameSnapshot: `Позиция ${idx + 1}`,
              quantity: i.quantity,
              unitPrice: "1000",
              lineSum: String(i.quantity * 1000),
            })),
          },
        },
      },
    },
  });
  return b.id as string;
}

/** Сессия киоска прямо в базе: открыта и брошена. `draft` — в ней уже есть работа. */
async function mkSession(bookingId: string, operation: "ISSUE" | "RETURN", opts: { draft?: boolean; worker?: string } = {}) {
  const s = await prisma.scanSession.create({
    data: {
      bookingId,
      operation,
      workerName: opts.worker ?? "Иван Кладовщик",
      status: "ACTIVE",
      ...(opts.draft ? { draftJson: JSON.stringify({ v: 1 }), draftRevision: 1, draftSavedAt: new Date(), draftSavedBy: "Иван Кладовщик" } : {}),
    },
  });
  return s.id as string;
}

const status = (id: string, action: string, token = saToken, extra: Record<string, unknown> = {}) =>
  request(app).post(`/api/bookings/${id}/status`).set(H(token)).send({ action, ...extra });
const addon = (id: string, equipmentId: string, quantity = 1) =>
  request(app).post(`/api/bookings/${id}/addon-items`).set(H(saToken)).send({ items: [{ equipmentId, quantity }], mode: "ADDON" });
const session = (id: string) => prisma.scanSession.findUnique({ where: { id } });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("bss-pass-123456");
  const sa = await prisma.adminUser.create({ data: { username: "bss_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saUsername = sa.username;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({ data: { username: "bss_wh", passwordHash: hash, role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  clientId = (await prisma.client.create({ data: { name: "Клиент сессий", phone: "+70000004242" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("ручные операции закрывают сессии киоска", () => {
  it("«Вернуть» закрывает брошенную приёмку: CANCELLED, причина, автор, аудит в журнале брони", async () => {
    const eqA = await mkEq("Приёмка брошена", 5);
    const bookingId = await mkBooking({ status: "ISSUED", name: "Вернуть закрывает", items: [{ equipmentId: eqA, quantity: 1 }] });
    const sid = await mkSession(bookingId, "RETURN", { draft: true });

    const res = await status(bookingId, "return");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closedScanSessions).toBe(1);

    const s = await session(sid);
    expect(s.status).toBe("CANCELLED");
    expect(s.cancelReason).toBe("BOOKING_RETURNED_MANUALLY");
    expect(s.cancelledBy).toBe(saUsername);
    expect(s.cancelledAt).toBeTruthy();

    const cancelledAudit = await prisma.auditEntry.findMany({ where: { entityId: bookingId, action: "SCAN_SESSION_CANCELLED" } });
    expect(cancelledAudit).toHaveLength(1);
    expect(JSON.parse(cancelledAudit[0].after)).toMatchObject({ sessionId: sid, operation: "RETURN", reason: "BOOKING_RETURNED_MANUALLY" });

    const returned = await prisma.auditEntry.findMany({ where: { entityId: bookingId, action: "BOOKING_RETURNED" } });
    expect(returned).toHaveLength(1);
    expect(JSON.parse(returned[0].after).closedScanSessions).toBe(1);
  });

  it("«Выдать» закрывает брошенную выдачу — «+ Добор» со страницы доступен, киоск выдачу не откроет", async () => {
    const eqA = await mkEq("Выдача брошена", 5);
    const eqB = await mkEq("Добор после выдачи", 5);
    const bookingId = await mkBooking({ status: "CONFIRMED", name: "Выдать закрывает", items: [{ equipmentId: eqA, quantity: 1 }] });
    const sid = await mkSession(bookingId, "ISSUE", { draft: true });

    const res = await status(bookingId, "issue", whToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closedScanSessions).toBe(1);
    const s = await session(sid);
    expect(s.status).toBe("CANCELLED");
    expect(s.cancelReason).toBe("BOOKING_ISSUED_MANUALLY");

    const add = await addon(bookingId, eqB);
    expect(add.body.code).not.toBe("SCAN_SESSION_ACTIVE");
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    const reopen = await request(app).post("/api/warehouse/sessions").set(H(whToken)).send({ bookingId, operation: "ISSUE" });
    expect(reopen.status).toBe(409);
    expect(reopen.body.code).toBe("BOOKING_WRONG_STATUS");
  });

  it("«Отменить» закрывает открытую выдачу (BOOKING_CANCELLED)", async () => {
    const eqA = await mkEq("Отмена с сессией", 5);
    const bookingId = await mkBooking({ status: "CONFIRMED", name: "Отмена закрывает", items: [{ equipmentId: eqA, quantity: 1 }] });
    const sid = await mkSession(bookingId, "ISSUE");

    const res = await status(bookingId, "cancel");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.booking.status).toBe("CANCELLED");
    expect(res.body.closedScanSessions).toBe(1);
    const s = await session(sid);
    expect(s.status).toBe("CANCELLED");
    expect(s.cancelReason).toBe("BOOKING_CANCELLED");
  });

  it("отмена с депозитом закрывает брошенную выдачу; выданную так не отменить — 409 по-русски", async () => {
    const eqA = await mkEq("Депозит прибор", 5);
    const pay = (bookingId: string) =>
      prisma.payment.create({
        data: { bookingId, amount: "500", direction: "INCOME", status: "RECEIVED", paymentMethod: "CASH", receivedAt: new Date() },
      });
    const cancelWithDeposit = (bookingId: string) =>
      request(app).post(`/api/bookings/${bookingId}/cancel-with-deposit`).set(H(saToken)).send({ disposition: "FORFEIT" });

    const bookingId = await mkBooking({ status: "CONFIRMED", name: "Отмена с депозитом", items: [{ equipmentId: eqA, quantity: 1 }] });
    const sid = await mkSession(bookingId, "ISSUE", { draft: true });
    await pay(bookingId);

    const res = await cancelWithDeposit(bookingId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.booking.status).toBe("CANCELLED");
    const s = await session(sid);
    expect(s.status).toBe("CANCELLED");
    expect(s.cancelReason).toBe("BOOKING_CANCELLED");
    const released = await prisma.auditEntry.findFirst({ where: { entityId: bookingId, action: "BOOKING_UNITS_RELEASED" } });
    expect(JSON.parse(released.after)).toMatchObject({ via: "cancel-with-deposit", closedScanSessions: 1 });

    // Раньше — «Нельзя отменить бронь в статусе ISSUED».
    const issuedId = await mkBooking({ status: "ISSUED", name: "Депозит выданная", items: [{ equipmentId: eqA, quantity: 1 }] });
    await pay(issuedId);
    const refused = await cancelWithDeposit(issuedId);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("INVALID_BOOKING_STATE");
    expect(refused.body.message).toBe("Выданную бронь нельзя отменить — сначала примите возврат");
    expect(refused.body.details).toMatchObject({ status: "ISSUED", action: "cancel" });
  });

  it("отмена с депозитом ‖ «Выдать» в одну секунду: проходит ровно одно, отменённая бронь не числится выданной", async () => {
    const eqA = await mkEq("Депозит гонка", 50);
    for (let k = 0; k < 3; k++) {
      const bookingId = await mkBooking({ status: "CONFIRMED", name: `Депозит гонка ${k}`, items: [{ equipmentId: eqA, quantity: 1 }] });
      await prisma.payment.create({
        data: { bookingId, amount: "500", direction: "INCOME", status: "RECEIVED", paymentMethod: "CASH", receivedAt: new Date() },
      });
      const [cancel, issue] = await Promise.all([
        request(app).post(`/api/bookings/${bookingId}/cancel-with-deposit`).set(H(saToken)).send({ disposition: "FORFEIT" }),
        status(bookingId, "issue", whToken),
      ]);
      expect([cancel.status, issue.status].sort()).toEqual([200, 409]);
      const loser = cancel.status === 409 ? cancel : issue;
      expect(loser.body.code).toBe("INVALID_BOOKING_STATE");

      const b = await prisma.booking.findUnique({ where: { id: bookingId } });
      const actions = (await prisma.auditEntry.findMany({ where: { entityId: bookingId } })).map((a: any) => a.action);
      if (b.status === "CANCELLED") {
        expect(actions).not.toContain("BOOKING_ISSUED");
      } else {
        // Выдача выиграла — удержание депозита откатилось вместе с отменой.
        expect(b.status).toBe("ISSUED");
        expect(b.forfeitedAt).toBeNull();
        expect(actions).not.toContain("BOOKING_CANCEL_WITH_DEPOSIT");
        expect(actions).not.toContain("BOOKING_DEPOSIT_FORFEITED");
      }
    }
  });

  it("архивация закрывает сессии (BOOKING_ARCHIVED)", async () => {
    const eqA = await mkEq("Архив с сессией", 5);
    const bookingId = await mkBooking({ status: "CONFIRMED", name: "Архив закрывает", items: [{ equipmentId: eqA, quantity: 1 }] });
    const sid = await mkSession(bookingId, "ISSUE", { draft: true });

    const res = await request(app).delete(`/api/bookings/${bookingId}`).set(H(saToken));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closedScanSessions).toBe(1);
    const s = await session(sid);
    expect(s.status).toBe("CANCELLED");
    expect(s.cancelReason).toBe("BOOKING_ARCHIVED");
  });

  it("основной путь прода без сессий: выдача и возврат кнопкой, closedScanSessions 0, аудит по одной записи, сумма не меняется", async () => {
    const eqA = await mkEq("Без киоска", 5);
    const eqU = await mkEq("Без киоска штучный", 2, "UNIT");
    const bookingId = await mkBooking({
      status: "CONFIRMED",
      name: "Кнопками",
      items: [
        { equipmentId: eqA, quantity: 2 },
        { equipmentId: eqU, quantity: 1 },
      ],
    });
    const unitItem = await prisma.bookingItem.findFirst({ where: { bookingId, equipmentId: eqU } });
    const unit = await prisma.equipmentUnit.findFirst({ where: { equipmentId: eqU } });
    await prisma.bookingItemUnit.create({ data: { bookingItemId: unitItem.id, equipmentUnitId: unit.id } });
    const before = await prisma.booking.findUnique({ where: { id: bookingId } });

    const iss = await status(bookingId, "issue", whToken);
    expect(iss.status).toBe(200);
    expect(iss.body.closedScanSessions).toBe(0);
    expect(iss.body.booking.status).toBe("ISSUED");
    expect((await prisma.equipmentUnit.findUnique({ where: { id: unit.id } })).status).toBe("ISSUED");

    const ret = await status(bookingId, "return", whToken);
    expect(ret.status).toBe(200);
    expect(ret.body.closedScanSessions).toBe(0);
    expect(ret.body.booking.status).toBe("RETURNED");
    expect((await prisma.equipmentUnit.findUnique({ where: { id: unit.id } })).status).toBe("AVAILABLE");

    expect(await prisma.auditEntry.count({ where: { entityId: bookingId, action: "BOOKING_ISSUED" } })).toBe(1);
    expect(await prisma.auditEntry.count({ where: { entityId: bookingId, action: "BOOKING_RETURNED" } })).toBe(1);
    expect(await prisma.auditEntry.count({ where: { entityId: bookingId, action: "SCAN_SESSION_CANCELLED" } })).toBe(0);
    const after = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(after.finalAmount.toString()).toBe(before.finalAmount.toString());
  });
});

describe("что блокирует «+ Добор» со страницы", () => {
  it("приёмку открыли «посмотреть» (без работы) — добор проходит", async () => {
    const eqA = await mkEq("Посмотреть прибор", 5);
    const eqB = await mkEq("Посмотреть добор", 5);
    const bookingId = await mkBooking({ status: "ISSUED", name: "Посмотрели", items: [{ equipmentId: eqA, quantity: 1 }] });
    const open = await request(app).post("/api/warehouse/sessions").set(H(whToken)).send({ bookingId, operation: "RETURN" });
    expect(open.status).toBe(201);

    const add = await addon(bookingId, eqB);
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  });

  it("приёмка с черновиком блокирует: 409 SCAN_SESSION_ACTIVE, кто и с какого времени, совет «прервите»", async () => {
    const eqA = await mkEq("Черновик прибор", 5);
    const eqB = await mkEq("Черновик добор", 5);
    const bookingId = await mkBooking({ status: "ISSUED", name: "С черновиком", items: [{ equipmentId: eqA, quantity: 1 }] });
    const sid = await mkSession(bookingId, "RETURN", { draft: true, worker: "Пётр Кладовщик" });

    const add = await addon(bookingId, eqB);
    expect(add.status).toBe(409);
    expect(add.body.code).toBe("SCAN_SESSION_ACTIVE");
    expect(add.body.message).toMatch(/идёт приёмка/);
    expect(add.body.message).toMatch(/Пётр Кладовщик/);
    expect(add.body.message).toMatch(/прервите/);
    expect(add.body.details).toMatchObject({ sessionId: sid, operation: "RETURN", workerName: "Пётр Кладовщик", hasDraft: true });
    // Ничего не записано.
    expect(await prisma.bookingItem.count({ where: { bookingId, equipmentId: eqB } })).toBe(0);
  });

  it("выдача, где уже добрали на месте (AddonRecord сессии), блокирует добор со страницы", async () => {
    const eqA = await mkEq("Выдача с добором прибор", 5);
    const eqB = await mkEq("Выдача с добором добор", 5);
    const bookingId = await mkBooking({ status: "CONFIRMED", name: "Добор в киоске", items: [{ equipmentId: eqA, quantity: 1 }] });
    const sid = await mkSession(bookingId, "ISSUE");
    const item = await prisma.bookingItem.findFirst({ where: { bookingId } });
    await prisma.addonRecord.create({
      data: { bookingId, sessionId: sid, bookingItemId: item.id, equipmentId: eqA, quantity: 1, createdBy: "Иван Кладовщик" },
    });

    const add = await addon(bookingId, eqB);
    expect(add.status).toBe(409);
    expect(add.body.code).toBe("SCAN_SESSION_ACTIVE");
    expect(add.body.details.operation).toBe("ISSUE");
    expect(add.body.details.hasDraft).toBe(false);
  });

  it("устаревшая сессия (выдача на уже выданной брони) ничего не блокирует", async () => {
    const eqA = await mkEq("Устаревшая прибор", 5);
    const eqB = await mkEq("Устаревшая добор", 5);
    const bookingId = await mkBooking({ status: "ISSUED", name: "Устаревшая", items: [{ equipmentId: eqA, quantity: 1 }] });
    await mkSession(bookingId, "ISSUE", { draft: true });

    const add = await addon(bookingId, eqB);
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  });
});

describe("карточка брони и списки видят состояние сессий", () => {
  it("GET /:id: stale, hasDraft, completedBy, cancelReason, cancelledAt", async () => {
    const eqA = await mkEq("Карточка прибор", 5);
    const bookingId = await mkBooking({ status: "ISSUED", name: "Карточка", items: [{ equipmentId: eqA, quantity: 1 }] });
    const staleIssue = await mkSession(bookingId, "ISSUE");
    const liveReturn = await mkSession(bookingId, "RETURN", { draft: true });
    const done = await prisma.scanSession.create({
      data: { bookingId, operation: "ISSUE", workerName: "Иван", status: "COMPLETED", completedAt: new Date(), completedBy: "Мария" },
    });
    const aborted = await prisma.scanSession.create({
      data: { bookingId, operation: "RETURN", workerName: "Иван", status: "CANCELLED", cancelledAt: new Date(), cancelReason: "KIOSK_ABORT", cancelledBy: "Иван" },
    });

    const res = await request(app).get(`/api/bookings/${bookingId}`).set(H(saToken));
    expect(res.status).toBe(200);
    const byId = new Map<string, any>(res.body.booking.scanSessions.map((s: any) => [s.id, s]));
    expect(byId.get(staleIssue)).toMatchObject({ status: "ACTIVE", stale: true, hasDraft: false });
    expect(byId.get(liveReturn)).toMatchObject({ status: "ACTIVE", stale: false, hasDraft: true });
    expect(byId.get(done.id)).toMatchObject({ status: "COMPLETED", stale: false, completedBy: "Мария" });
    expect(byId.get(aborted.id)).toMatchObject({ status: "CANCELLED", cancelReason: "KIOSK_ABORT", cancelledBy: "Иван" });
    expect(byId.get(aborted.id).cancelledAt).toBeTruthy();
  });

  it("список броней и реестр: liveScanSession только у живой ACTIVE-сессии", async () => {
    const eqA = await mkEq("Списки прибор", 5);
    const live = await mkBooking({ status: "CONFIRMED", name: "Реестр живая сессия", items: [{ equipmentId: eqA, quantity: 1 }] });
    await mkSession(live, "ISSUE");
    const stale = await mkBooking({ status: "RETURNED", name: "Реестр устаревшая сессия", items: [{ equipmentId: eqA, quantity: 1 }] });
    await mkSession(stale, "RETURN");
    const none = await mkBooking({ status: "CONFIRMED", name: "Реестр без сессии", items: [{ equipmentId: eqA, quantity: 1 }] });

    const list = await request(app).get("/api/bookings?limit=200").set(H(saToken));
    expect(list.status).toBe(200);
    const row = (id: string) => list.body.bookings.find((b: any) => b.id === id);
    expect(row(live).liveScanSession).toBe(true);
    expect(row(stale).liveScanSession).toBe(false);
    expect(row(stale).hasScanSessions).toBe(true);
    expect(row(none).liveScanSession).toBe(false);

    const reg = await request(app).get("/api/bookings/register?q=Реестр&limit=100").set(H(saToken));
    expect(reg.status, JSON.stringify(reg.body).slice(0, 300)).toBe(200);
    const regRow = (id: string) => reg.body.bookings.find((b: any) => b.id === id);
    expect(regRow(live).liveScanSession).toBe(true);
    expect(regRow(stale).liveScanSession).toBe(false);
    expect(regRow(none).liveScanSession).toBe(false);
  });
});
