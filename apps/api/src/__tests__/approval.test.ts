/**
 * Интеграционные тесты approval workflow: submit-for-approval / approve / reject.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-approval.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,openclaw-test-bot";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-approval";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-approval";
process.env.JWT_SECRET = "test-jwt-secret-approval-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

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

  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "appr_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "appr_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "appr_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

let _bookingCounter = 0;

async function createDraftBooking() {
  const uid = `${Date.now()}_${++_bookingCounter}`;
  const client = await prisma.client.create({ data: { name: `ТК Тест ${uid}` } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `СВЕТ||ТЕСТ||${uid}||`,
      name: `Прожектор ${uid}`,
      category: "Свет",
      totalQuantity: 5,
      rentalRatePerShift: 1000,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тестовый проект",
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T10:00:00Z"),
      status: "DRAFT",
      items: {
        create: [{ equipmentId: equipment.id, quantity: 2 }],
      },
    },
  });
  return booking;
}

describe("POST /api/bookings/:id/submit-for-approval", () => {
  it("WAREHOUSE переводит DRAFT → PENDING_APPROVAL и очищает rejectionReason", async () => {
    const booking = await createDraftBooking();
    // Предварительно выставим rejectionReason, чтобы проверить очистку
    await prisma.booking.update({ where: { id: booking.id }, data: { rejectionReason: "старая причина" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");
    expect(res.body.booking.rejectionReason).toBeNull();

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_SUBMITTED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("SUPER_ADMIN тоже может отправить на согласование", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");
  });

  it("TECHNICIAN получает 403", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_TECH())
      .send({});
    expect(res.status).toBe(403);
  });

  it("CONFIRMED бронь → PENDING_APPROVAL (повторное согласование после правок)", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(200);
    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after?.status).toBe("PENDING_APPROVAL");
  });

  it("выданную (ISSUED) бронь нельзя отправить на согласование → 409", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "ISSUED" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("INVALID_BOOKING_STATE");
  });

  it("несуществующая бронь → 404", async () => {
    const res = await request(app)
      .post(`/api/bookings/does-not-exist/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/bookings/:id/approve", () => {
  it("SUPER_ADMIN переводит PENDING_APPROVAL → CONFIRMED", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("CONFIRMED");

    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.confirmedAt).not.toBeNull();

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_APPROVED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("WAREHOUSE получает 403", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(403);
  });

  it("не-PENDING_APPROVAL → 409", async () => {
    const booking = await createDraftBooking(); // DRAFT
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("INVALID_BOOKING_STATE");
  });
});

describe("POST /api/bookings/:id/reject", () => {
  it("SUPER_ADMIN отклоняет с причиной: PENDING_APPROVAL → DRAFT + rejectionReason", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "Слишком высокая скидка, пересчитайте" });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("DRAFT");
    expect(res.body.booking.rejectionReason).toBe("Слишком высокая скидка, пересчитайте");

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_REJECTED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("пустая причина → 400", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "" });
    expect(res.status).toBe(400);
  });

  it("отсутствие reason в теле → 400", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(400);
  });

  it("WAREHOUSE получает 403", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_WH())
      .send({ reason: "test" });
    expect(res.status).toBe(403);
  });

  it("не-PENDING_APPROVAL → 409", async () => {
    const booking = await createDraftBooking(); // DRAFT
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "test" });
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("INVALID_BOOKING_STATE");
  });
});

describe("PATCH /api/bookings/:id — edit-prevention для PENDING_APPROVAL", () => {
  it("PATCH по PENDING_APPROVAL возвращает 409", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_WH())
      .send({ projectName: "Новое имя" });

    expect(res.status).toBe(409);
  });

  it("PATCH по DRAFT по-прежнему разрешён", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_WH())
      .send({ projectName: "Обновлённое имя" });
    expect(res.status).toBe(200);
    expect(res.body.booking.projectName).toBe("Обновлённое имя");
  });
});

describe("GET /api/bookings?status=PENDING_APPROVAL", () => {
  it("фильтрация по PENDING_APPROVAL возвращает только брони на согласовании", async () => {
    const b1 = await createDraftBooking(); // DRAFT
    const b2 = await createDraftBooking();
    await prisma.booking.update({ where: { id: b2.id }, data: { status: "PENDING_APPROVAL" } });
    const b3 = await createDraftBooking();
    await prisma.booking.update({ where: { id: b3.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .get(`/api/bookings?status=PENDING_APPROVAL&limit=100`)
      .set(AUTH_WH());

    expect(res.status).toBe(200);
    const ids = res.body.bookings.map((b: any) => b.id);
    expect(ids).toContain(b2.id);
    expect(ids).toContain(b3.id);
    expect(ids).not.toContain(b1.id);
    for (const b of res.body.bookings) {
      expect(b.status).toBe("PENDING_APPROVAL");
    }
  });
});

describe("CRITICAL 1 — legacy confirm bypass", () => {
  it("legacy POST /api/bookings/:id/status {action: 'confirm'} blocked for DRAFT (closes approval bypass)", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/status`)
      .set(AUTH_WH())
      .send({ action: "confirm" });
    expect(res.status).toBe(409);
    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.status).toBe("DRAFT");
  });

  it("WAREHOUSE POST /api/bookings/:id/confirm на DRAFT → 403, бронь остаётся DRAFT (bypass закрыт)", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/confirm`)
      .set(AUTH_WH())
      .send({});
    // rolesGuard(["SUPER_ADMIN"]) → WAREHOUSE с JWT-сессией получает 403
    expect(res.status).toBe(403);
    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.status).toBe("DRAFT");
  });

  it("SUPER_ADMIN POST /api/bookings/:id/confirm на DRAFT → 409 USE_APPROVAL_FLOW (веб обязан идти через согласование)", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/confirm`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("USE_APPROVAL_FLOW");
    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.status).toBe("DRAFT");
  });

  it("SUPER_ADMIN POST /api/bookings/:id/confirm на PENDING_APPROVAL → 409 USE_APPROVAL_FLOW", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/confirm`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("USE_APPROVAL_FLOW");
  });

  it("бот POST /api/bookings/:id/confirm на DRAFT → CONFIRMED + AuditEntry BOOKING_CONFIRMED_VIA_BOT", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/confirm`)
      .set({ "X-API-Key": "openclaw-test-bot" })
      .send({});
    expect(res.status).toBe(200);
    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.status).toBe("CONFIRMED");
    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_CONFIRMED_VIA_BOT" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit.before)).toEqual({ status: "DRAFT" });
    expect(JSON.parse(audit.after)).toEqual({ status: "CONFIRMED", via: "bot" });
  });
});

describe("CRITICAL 2 — approveBooking via confirmBooking (estimate snapshot)", () => {
  it("approveBooking создаёт snapshot сметы (estimate non-null после approve)", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("CONFIRMED");

    const fresh = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: { estimates: { include: { lines: true } } },
    });
    expect(fresh!.confirmedAt).not.toBeNull();
    const mainEst = fresh!.estimates.find((e) => e.kind === "MAIN");
    expect(mainEst).toBeTruthy();
    expect(mainEst!.lines.length).toBeGreaterThan(0);
  });

  it("approveBooking: audit entry содержит правильный userId", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const sa = await prisma.adminUser.findFirst({ where: { role: "SUPER_ADMIN" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(200);

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_APPROVED" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(sa.id);
  });
});

describe("HIGH — status filter validation", () => {
  it("GET /api/bookings?status=garbage → 400", async () => {
    const res = await request(app)
      .get("/api/bookings?status=garbage")
      .set(AUTH_WH());
    expect(res.status).toBe(400);
  });
});

describe("MEDIUM 4+5 — stronger audit assertions + resubmit roundtrip", () => {
  it("SUPER_ADMIN отклоняет с причиной: audit.after содержит rejectionReason", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "Слишком высокая скидка, пересчитайте" });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("DRAFT");
    expect(res.body.booking.rejectionReason).toBe("Слишком высокая скидка, пересчитайте");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_REJECTED" },
    });
    expect(audit).not.toBeNull();
    const sa = await prisma.adminUser.findFirst({ where: { role: "SUPER_ADMIN" } });
    expect(audit!.userId).toBe(sa.id);

    // Assert after.rejectionReason — parse JSON if stored as string
    const afterJson = typeof audit!.after === "string" ? JSON.parse(audit!.after) : audit!.after;
    expect(afterJson.rejectionReason).toBe("Слишком высокая скидка, пересчитайте");
  });

  it("полный цикл: submit → reject → resubmit очищает rejectionReason", async () => {
    const booking = await createDraftBooking();

    // Step 1: WAREHOUSE submits
    let res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");

    // Step 2: SA rejects
    res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "пересчитайте" });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("DRAFT");
    expect(res.body.booking.rejectionReason).toBe("пересчитайте");

    // Step 3: WAREHOUSE resubmits — should clear rejectionReason
    res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");
    expect(res.body.booking.rejectionReason).toBeNull();

    // 3 audit entries: SUBMITTED, REJECTED, SUBMITTED
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a: any) => a.action)).toEqual(["BOOKING_SUBMITTED", "BOOKING_REJECTED", "BOOKING_SUBMITTED"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Новые тесты: persist-quote-on-draft + SA edit during review + audit
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/bookings/draft — сохранение суммы при создании", () => {
  it("создание через HTTP-роут заполняет finalAmount, totalEstimateAmount, discountAmount", async () => {
    const uid = `${Date.now()}_draft_totals`;
    // Создаём клиента и оборудование напрямую для изоляции теста
    const client = await prisma.client.create({ data: { name: `Клиент Тест ${uid}` } });
    const eq1 = await prisma.equipment.create({
      data: {
        importKey: `СВЕТ||НОВЫЙ||${uid}A||`,
        name: `Прожектор A ${uid}`,
        category: "Свет",
        totalQuantity: 10,
        rentalRatePerShift: 2000,
      },
    });
    const eq2 = await prisma.equipment.create({
      data: {
        importKey: `СВЕТ||НОВЫЙ||${uid}B||`,
        name: `Прожектор B ${uid}`,
        category: "Свет",
        totalQuantity: 10,
        rentalRatePerShift: 1500,
      },
    });

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: client.name },
        projectName: "Тест суммы",
        startDate: "2026-06-01T10:00:00Z",
        endDate: "2026-06-03T10:00:00Z",
        discountPercent: 10,
        items: [
          { equipmentId: eq1.id, quantity: 1 },
          { equipmentId: eq2.id, quantity: 2 },
        ],
      });

    expect(res.status).toBe(200);
    const bookingId = res.body.booking?.id ?? res.body.id;
    expect(bookingId).toBeTruthy();

    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(Number(fresh!.finalAmount)).toBeGreaterThan(0);
    expect(Number(fresh!.totalEstimateAmount)).toBeGreaterThan(0);
    expect(Number(fresh!.discountAmount)).toBeGreaterThan(0);
  });
});

describe("PATCH /api/bookings/:id — PENDING_APPROVAL: роль-зависимое редактирование", () => {
  it("SUPER_ADMIN может редактировать бронь в статусе PENDING_APPROVAL (200)", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_SA())
      .send({ projectName: "Правка руководителя" });

    expect(res.status).toBe(200);
    expect(res.body.booking.projectName).toBe("Правка руководителя");
  });

  it("WAREHOUSE не может редактировать бронь в статусе PENDING_APPROVAL (409)", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_WH())
      .send({ projectName: "Попытка склада" });

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("BOOKING_EDIT_FORBIDDEN");
  });

  it("SUPER_ADMIN редактирует PENDING_APPROVAL → finalAmount обновляется + пишется BOOKING_EDITED_IN_REVIEW", async () => {
    const uid = `${Date.now()}_edit_in_review`;
    const client = await prisma.client.create({ data: { name: `Клиент Ревью ${uid}` } });
    const eq1 = await prisma.equipment.create({
      data: {
        importKey: `СВЕТ||РЕВЬЮ||${uid}A||`,
        name: `Прибор A ${uid}`,
        category: "Свет",
        totalQuantity: 10,
        rentalRatePerShift: 3000,
      },
    });
    const eq2 = await prisma.equipment.create({
      data: {
        importKey: `СВЕТ||РЕВЬЮ||${uid}B||`,
        name: `Прибор B ${uid}`,
        category: "Свет",
        totalQuantity: 10,
        rentalRatePerShift: 5000,
      },
    });

    // Создаём бронь с первым оборудованием
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект ревью",
        startDate: new Date("2026-07-01T10:00:00Z"),
        endDate: new Date("2026-07-03T10:00:00Z"),
        status: "PENDING_APPROVAL",
        finalAmount: 100,
        items: { create: [{ equipmentId: eq1.id, quantity: 1 }] },
      },
    });

    // SA меняет позиции на более дорогое оборудование
    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_SA())
      .send({ items: [{ equipmentId: eq2.id, quantity: 2 }] });

    expect(res.status).toBe(200);

    // finalAmount должен обновиться
    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(Number(fresh!.finalAmount)).toBeGreaterThan(0);
    // Новая сумма должна быть выше исходных 100 ₽
    expect(Number(fresh!.finalAmount)).toBeGreaterThan(100);

    // Аудит-запись BOOKING_EDITED_IN_REVIEW должна существовать
    const auditEntry = await prisma.auditEntry.findFirst({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_EDITED_IN_REVIEW" },
    });
    expect(auditEntry).not.toBeNull();

    // before.finalAmount и after.finalAmount должны отличаться
    const beforeJson = typeof auditEntry!.before === "string"
      ? JSON.parse(auditEntry!.before)
      : auditEntry!.before;
    const afterJson = typeof auditEntry!.after === "string"
      ? JSON.parse(auditEntry!.after)
      : auditEntry!.after;
    expect(beforeJson.finalAmount).not.toBe(afterJson.finalAmount);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// C2 — releaseBookingUnits при отмене брони
// ──────────────────────────────────────────────────────────────────────────────

let _c2Counter = 0;

/** Создаёт CONFIRMED бронь с UNIT-резервом: equipment(UNIT) + 1 unit + BookingItemUnit */
async function createConfirmedBookingWithUnit() {
  const uid = `${Date.now()}_${++_c2Counter}`;
  const client = await prisma.client.create({ data: { name: `ТК C2 ${uid}` } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `СВЕТ||C2||${uid}||`,
      name: `UNIT-прожектор ${uid}`,
      category: "Свет",
      totalQuantity: 1,
      rentalRatePerShift: 1000,
      stockTrackingMode: "UNIT",
    },
  });
  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId: equipment.id, barcode: `C2-${uid}`, status: "ISSUED" },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "C2 проект",
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T10:00:00Z"),
      status: "CONFIRMED",
      items: { create: [{ equipmentId: equipment.id, quantity: 1 }] },
    },
    include: { items: true },
  });
  const bookingItem = booking.items[0];
  await prisma.bookingItemUnit.create({
    data: { bookingItemId: bookingItem.id, equipmentUnitId: unit.id },
  });
  return { booking, unit, equipment };
}

describe("CRITICAL 2 — releaseBookingUnits при отмене", () => {
  it("CONFIRMED + UNIT-резерв → cancel: unit AVAILABLE, BookingItemUnit снят, аудит BOOKING_UNITS_RELEASED", async () => {
    const { booking, unit } = await createConfirmedBookingWithUnit();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/status`)
      .set(AUTH_WH())
      .send({ action: "cancel" });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("CANCELLED");

    // Unit вернулся в AVAILABLE
    const freshUnit = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(freshUnit.status).toBe("AVAILABLE");

    // BookingItemUnit-резерв снят
    const remainingReservations = await prisma.bookingItemUnit.count({
      where: { bookingItem: { bookingId: booking.id } },
    });
    expect(remainingReservations).toBe(0);

    // Аудит BOOKING_UNITS_RELEASED
    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_UNITS_RELEASED" },
    });
    expect(audit).not.toBeNull();
  });

  it("повторный cancel идемпотентен — не падает, unit остаётся AVAILABLE", async () => {
    const { booking, unit } = await createConfirmedBookingWithUnit();

    const r1 = await request(app)
      .post(`/api/bookings/${booking.id}/status`)
      .set(AUTH_WH())
      .send({ action: "cancel" });
    expect(r1.status).toBe(200);

    // Повторная отмена: CANCELLED → cancel недопустим по allowedActionsByStatus
    // (409), но releaseBookingUnits сам по себе идемпотентен. Проверяем напрямую
    // через сервис, что повторный вызов не бросает.
    const { releaseBookingUnits } = await import("../services/bookings");
    const result = await prisma.$transaction((tx: any) => releaseBookingUnits(booking.id, tx));
    expect(result.releasedReservations).toBe(0);
    expect(result.freedUnitIds).toHaveLength(0);

    const freshUnit = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(freshUnit.status).toBe("AVAILABLE");
  });

  it("releaseBookingUnits НЕ трогает MAINTENANCE/RETIRED юниты", async () => {
    const { booking, unit } = await createConfirmedBookingWithUnit();
    // Юнит ушёл в ремонт, пока бронь жива
    await prisma.equipmentUnit.update({ where: { id: unit.id }, data: { status: "MAINTENANCE" } });

    const { releaseBookingUnits } = await import("../services/bookings");
    const result = await prisma.$transaction((tx: any) => releaseBookingUnits(booking.id, tx));

    // Резерв снят, но статус MAINTENANCE сохранён (не перезатёрт в AVAILABLE)
    expect(result.releasedReservations).toBe(1);
    expect(result.freedUnitIds).toHaveLength(0);
    const freshUnit = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(freshUnit.status).toBe("MAINTENANCE");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// C3 — dashboard overdue считается live (единый источник с computeDebts)
// ──────────────────────────────────────────────────────────────────────────────

describe("CRITICAL 3 — live overdue: dashboard == debts", () => {
  it("бронь expectedPaymentDate в прошлом + outstanding>0 + paymentStatus НЕ синхрон → dashboard и debts дают одинаковое overdue", async () => {
    const uid = `${Date.now()}_c3`;
    const client = await prisma.client.create({ data: { name: `ТК C3 ${uid}` } });
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 дней назад

    // Намеренно НЕ синхронизируем paymentStatus: оставляем NOT_PAID,
    // хотя expectedPaymentDate в прошлом и есть долг → раньше dashboard
    // занижал overdue (смотрел только на stored paymentStatus).
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "C3 просроченная",
        startDate: new Date("2026-04-01T10:00:00Z"),
        endDate: new Date("2026-04-03T10:00:00Z"),
        status: "CONFIRMED",
        finalAmount: "5000",
        amountPaid: "0",
        amountOutstanding: "5000",
        paymentStatus: "NOT_PAID", // <-- НЕ синхронизирован (должен бы быть OVERDUE)
        expectedPaymentDate: pastDate,
      },
    });

    // dashboardMetrics удалён (2026-07 аудит) — единый источник истины теперь
    // computeFinanceDashboard.summary.overdueReceivables, считающийся тем же
    // isBookingOverdue, что и computeDebts.
    const { computeDebts, computeFinanceDashboard } = await import("../services/finance");

    const debts = await computeDebts();
    const finDash = await computeFinanceDashboard();

    // Строковые представления отличаются (.toFixed(2) vs .toString()), но
    // ЧИСЛА должны совпадать. Инвариант C3 = единый источник истины по overdue.
    const debtsOverdue = Number(debts.summary.totalOverdue);
    const finDashOverdue = Number(finDash.summary.overdueReceivables);

    // Оба учитывают просроченную бронь идентично (≥5000), несмотря на
    // рассинхронизированный paymentStatus.
    expect(debtsOverdue).toBeGreaterThanOrEqual(5000);
    expect(finDashOverdue).toBe(debtsOverdue);

    // Клиент с просрочкой виден в счётчике дашборда тем же критерием.
    expect(finDash.overdueClientsCount).toBeGreaterThanOrEqual(1);
  });
});
