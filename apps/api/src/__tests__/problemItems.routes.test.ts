/**
 * HTTP-тесты /api/problem-items — реестр «Потеряшки» (list + resolve)
 * Матрица прав: SUPER_ADMIN / WAREHOUSE → доступ; TECHNICIAN → 403.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-problem-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-problem-routes";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-problem-routes";
process.env.WAREHOUSE_SECRET = "test-warehouse-problem-routes";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-problem-routes-min16chars";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

let superAdminId: string;
let equipmentId: string;
let searchingUnitId: string;
let foundUnitId: string;
let searchingItemId: string;
let foundItemId: string;
let resolveUnitId: string;
let resolveItemId: string;
let notFoundUnitId: string;
let notFoundItemId: string;
let closedUnitId: string;
let closedItemId: string;
let sourceBookingId: string;

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
  const { createProblemItem } = await import("../services/problemItemService");
  const hash = await hashPassword("problem-routes-pass");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "pi_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const warehouse = await prisma.adminUser.create({
    data: { username: "pi_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  const technician = await prisma.adminUser.create({
    data: { username: "pi_technician", passwordHash: hash, role: "TECHNICIAN" },
  });

  superAdminId = superAdmin.id;

  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: warehouse.id, username: warehouse.username, role: "WAREHOUSE" });
  technicianToken = signSession({ userId: technician.id, username: technician.username, role: "TECHNICIAN" });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "pi-test-equipment-001",
      name: "Прожектор Потеряшка",
      category: "Осветительные приборы",
      rentalRatePerShift: 500,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;

  // Клиент + бронь для обогащения списка (клиент · проект в реестре)
  const client = await prisma.client.create({
    data: { name: "Клиент Потеряшкин", phone: "+7 900 000-00-00" },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Съёмка «Потеряшки»",
      startDate: new Date("2026-06-01T09:00:00.000Z"),
      endDate: new Date("2026-06-03T18:00:00.000Z"),
      status: "ISSUED",
    },
  });
  sourceBookingId = booking.id;

  const su = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "PI-SEARCH-001", status: "AVAILABLE" },
  });
  searchingUnitId = su.id;
  const fu = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "PI-FOUND-001", status: "AVAILABLE" },
  });
  foundUnitId = fu.id;
  const ru = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "PI-RESOLVE-001", status: "AVAILABLE" },
  });
  resolveUnitId = ru.id;
  const nu = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "PI-NOTFOUND-001", status: "AVAILABLE" },
  });
  notFoundUnitId = nu.id;
  const cu = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "PI-CLOSED-001", status: "AVAILABLE" },
  });
  closedUnitId = cu.id;

  // SEARCHING item (reason LOST → status SEARCHING, unit MISSING),
  // привязан к брони — список должен обогатить его booking.client/projectName
  const searching = await createProblemItem({
    equipmentUnitId: searchingUnitId,
    sourceBookingId,
    reason: "LOST",
    comment: "Не вернулся с площадки",
    createdBy: superAdminId,
  });
  searchingItemId = searching.id;

  // Another SEARCHING that we then resolve to FOUND, so it must NOT appear in ?status=SEARCHING
  const willBeFound = await createProblemItem({
    equipmentUnitId: foundUnitId,
    reason: "STOLEN",
    comment: "Разбираемся со страховой",
    createdBy: superAdminId,
  });
  foundItemId = willBeFound.id;
  await prisma.problemItem.update({
    where: { id: foundItemId },
    data: { status: "FOUND", resolvedAt: new Date(), resolvedBy: superAdminId, resolutionNote: "нашёлся ранее" },
  });

  // Item that the resolve test will close
  const toResolve = await createProblemItem({
    equipmentUnitId: resolveUnitId,
    reason: "LOST",
    comment: "Будет разобран в тесте",
    createdBy: superAdminId,
  });
  resolveItemId = toResolve.id;

  // Item for NOT_FOUND resolve
  const toNotFound = await createProblemItem({
    equipmentUnitId: notFoundUnitId,
    reason: "LOST",
    comment: "Будет помечен ненайденным",
    createdBy: superAdminId,
  });
  notFoundItemId = toNotFound.id;

  // Already-closed item (resolve → 409)
  const alreadyClosed = await createProblemItem({
    equipmentUnitId: closedUnitId,
    reason: "DESTROYED",
    comment: "Уничтожено при приёмке",
    createdBy: superAdminId,
  });
  closedItemId = alreadyClosed.id; // DESTROYED → status WROTE_OFF (already closed)
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

const apiKey = { "X-API-Key": "test-key-problem-routes" };
function auth(token: string) {
  return { ...apiKey, "Authorization": `Bearer ${token}` };
}

// ─── GET /api/problem-items ──────────────────────────────────────────────────

describe("GET /api/problem-items", () => {
  it("200 — SUPER_ADMIN, ?status=SEARCHING возвращает только SEARCHING, обогащённые названием оборудования", async () => {
    const res = await request(app)
      .get("/api/problem-items?status=SEARCHING")
      .set(auth(superAdminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect("nextCursor" in res.body).toBe(true);

    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toContain(searchingItemId);
    expect(ids).toContain(resolveItemId);
    expect(ids).toContain(notFoundItemId);
    // FOUND и WROTE_OFF не попадают
    expect(ids).not.toContain(foundItemId);
    expect(ids).not.toContain(closedItemId);

    for (const item of res.body.items) {
      expect(item.status).toBe("SEARCHING");
      // обогащение названием оборудования через equipmentUnit.equipment
      expect(item.equipmentUnit?.equipment?.name).toBe("Прожектор Потеряшка");
      expect(item.equipmentUnit?.equipment?.category).toBe("Осветительные приборы");
      // никаких barcode в выдаче
      expect(item.equipmentUnit?.barcode).toBeUndefined();
    }
  });

  it("200 — карточка с sourceBookingId обогащена booking (клиент + проект), без barcode", async () => {
    const res = await request(app)
      .get("/api/problem-items")
      .set(auth(superAdminToken));
    expect(res.status).toBe(200);

    const withBooking = res.body.items.find((i: any) => i.id === searchingItemId);
    expect(withBooking).toBeDefined();
    expect(withBooking.booking).toEqual({
      id: sourceBookingId,
      projectName: "Съёмка «Потеряшки»",
      client: { name: "Клиент Потеряшкин", phone: "+7 900 000-00-00" },
    });

    // карточка без брони → booking: null
    const withoutBooking = res.body.items.find((i: any) => i.id === closedItemId);
    expect(withoutBooking).toBeDefined();
    expect(withoutBooking.booking).toBeNull();

    // никаких barcode нигде в ответе
    expect(JSON.stringify(res.body)).not.toMatch(/"barcode"/);
  });

  it("200 — WAREHOUSE имеет доступ", async () => {
    const res = await request(app)
      .get("/api/problem-items")
      .set(auth(warehouseToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("403 FORBIDDEN_BY_ROLE — TECHNICIAN не имеет доступа", async () => {
    const res = await request(app)
      .get("/api/problem-items")
      .set(auth(technicianToken));
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });
});

// ─── POST /api/problem-items/:id/resolve ─────────────────────────────────────

describe("POST /api/problem-items/:id/resolve", () => {
  it("200 — FOUND: карточка закрывается, unit становится AVAILABLE", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${resolveItemId}/resolve`)
      .set(auth(superAdminToken))
      .send({ outcome: "FOUND", note: "нашёлся" });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("FOUND");
    expect(res.body.item.resolutionNote).toBe("нашёлся");

    const updated = await prisma.problemItem.findUnique({ where: { id: resolveItemId } });
    expect(updated.status).toBe("FOUND");
    const unit = await prisma.equipmentUnit.findUnique({ where: { id: resolveUnitId } });
    expect(unit.status).toBe("AVAILABLE");
  });

  it("200 — NOT_FOUND: статус NOT_FOUND", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${notFoundItemId}/resolve`)
      .set(auth(superAdminToken))
      .send({ outcome: "NOT_FOUND", note: "xx2" });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("NOT_FOUND");

    const updated = await prisma.problemItem.findUnique({ where: { id: notFoundItemId } });
    expect(updated.status).toBe("NOT_FOUND");
  });

  it("400 — note короче 3 символов (Zod)", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${searchingItemId}/resolve`)
      .set(auth(superAdminToken))
      .send({ outcome: "FOUND", note: "xx" });
    expect(res.status).toBe(400);
  });

  it("409 PROBLEM_ITEM_CLOSED — повторный разбор закрытой карточки", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${closedItemId}/resolve`)
      .set(auth(superAdminToken))
      .send({ outcome: "FOUND", note: "уже закрыто" });
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("PROBLEM_ITEM_CLOSED");
  });

  it("403 FORBIDDEN_BY_ROLE — TECHNICIAN не может разбирать", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${searchingItemId}/resolve`)
      .set(auth(technicianToken))
      .send({ outcome: "FOUND", note: "нашёлся" });
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });
});
