/**
 * Интеграционные тесты регистрации поломки из киоска:
 *  (a) GET /repair-targets — поиск по кириллице без учёта регистра,
 *      units с label без barcode, флаг inActiveRepair.
 *  (b) POST /repairs UNIT-путь — Repair создан, unit → MAINTENANCE;
 *      повторная регистрация той же единицы → 409 REPAIR_ACTIVE_EXISTS.
 *  (c) POST /repairs COUNT-путь — Repair без unitId с quantity.
 *  (d) POST /repairs/:id/photos — magic-bytes, RepairPhoto создан;
 *      чужая заявка → 403 REPAIR_NOT_OWN.
 *  (e) Валидация: короткий reason → 400; оба/ни одного target → 400.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-direct-repair.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-direct-repair";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-direct-repair";
process.env.JWT_SECRET = "test-jwt-secret-direct-repair-16";

let app: Express;
let prisma: any;
let pinToken: string;
let otherPinToken: string;
let unitEquipmentId: string;
let countEquipmentId: string;
let unitAId: string;
let unitBId: string;

/** Валидный минимальный JPEG (SOI + APP0 + EOI). */
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

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

  const { hashPin } = await import("../services/warehouseAuth");
  for (const [name, pin] of [["Иван Прямой", "1111"], ["Пётр Чужой", "2222"]] as const) {
    await prisma.warehousePin.create({
      data: { name, pinHash: await hashPin(pin), isActive: true },
    });
  }
  const auth1 = await request(app)
    .post("/api/warehouse/auth")
    .set({ "X-API-Key": "test-key-1" })
    .send({ name: "Иван Прямой", pin: "1111" });
  pinToken = auth1.body.token;
  const auth2 = await request(app)
    .post("/api/warehouse/auth")
    .set({ "X-API-Key": "test-key-1" })
    .send({ name: "Пётр Чужой", pin: "2222" });
  otherPinToken = auth2.body.token;

  const unitEq = await prisma.equipment.create({
    data: {
      importKey: "COB||ПРОЖЕКТОР ДР||GENERIC||DR-1",
      name: "Прожектор Директ",
      category: "COB",
      totalQuantity: 2,
      rentalRatePerShift: "1000",
      stockTrackingMode: "UNIT",
    },
  });
  unitEquipmentId = unitEq.id;
  const uA = await prisma.equipmentUnit.create({
    data: { equipmentId: unitEq.id, serialNumber: "SN-001", barcode: "LR-DR-001", status: "AVAILABLE" },
  });
  unitAId = uA.id;
  const uB = await prisma.equipmentUnit.create({
    data: { equipmentId: unitEq.id, barcode: "LR-DR-002", status: "AVAILABLE" },
  });
  unitBId = uB.id;

  const countEq = await prisma.equipment.create({
    data: {
      importKey: "GRIP||САНДБЭГ ДР||GENERIC||SB-DR",
      name: "Сандбэг Директ",
      category: "GRIP",
      totalQuantity: 20,
      rentalRatePerShift: "150",
      stockTrackingMode: "COUNT",
    },
  });
  countEquipmentId = countEq.id;
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

const AUTH = (t: string) => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${t}` });

describe("Киоск — регистрация поломки", () => {
  it("(a) repair-targets: кириллица без регистра, label без barcode", async () => {
    const res = await request(app)
      .get("/api/warehouse/repair-targets?q=прожектор")
      .set(AUTH(pinToken));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const r = res.body.results[0];
    expect(r.name).toBe("Прожектор Директ");
    expect(r.trackingMode).toBe("UNIT");
    expect(r.units).toHaveLength(2);
    expect(r.units[0].label).toBe("SN-001");
    expect(r.units[1].label).toBe("Единица 2");
    expect(JSON.stringify(res.body)).not.toContain("LR-DR");
  });

  it("(b) UNIT-путь: Repair создан, unit → MAINTENANCE, дубль → 409", async () => {
    const res = await request(app)
      .post("/api/warehouse/repairs")
      .set(AUTH(pinToken))
      .send({ equipmentUnitId: unitAId, reason: "не включается драйвер", urgency: "URGENT" });
    expect(res.status).toBe(201);
    expect(res.body.repair.id).toBeTruthy();

    const unit = await prisma.equipmentUnit.findUnique({ where: { id: unitAId } });
    expect(unit.status).toBe("MAINTENANCE");

    const repair = await prisma.repair.findUnique({ where: { id: res.body.repair.id } });
    expect(repair.createdBy).toBe("Иван Прямой");
    expect(repair.urgency).toBe("URGENT");

    const dup = await request(app)
      .post("/api/warehouse/repairs")
      .set(AUTH(pinToken))
      .send({ equipmentUnitId: unitAId, reason: "ещё раз" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("REPAIR_ACTIVE_EXISTS");

    // repair-targets теперь помечает единицу как inActiveRepair
    const targets = await request(app)
      .get("/api/warehouse/repair-targets?q=прожектор")
      .set(AUTH(pinToken));
    const unitRow = targets.body.results[0].units.find((u: any) => u.id === unitAId);
    expect(unitRow.inActiveRepair).toBe(true);
  });

  it("(c) COUNT-путь: Repair без unitId с quantity и названием в /problems", async () => {
    const res = await request(app)
      .post("/api/warehouse/repairs")
      .set(AUTH(pinToken))
      .send({ equipmentId: countEquipmentId, quantity: 3, reason: "порваны швы у трёх мешков" });
    expect(res.status).toBe(201);
    const repair = await prisma.repair.findUnique({ where: { id: res.body.repair.id } });
    expect(repair.unitId).toBeNull();
    expect(repair.equipmentId).toBe(countEquipmentId);
    expect(repair.quantity).toBe(3);
    expect(repair.status).toBe("WAITING_REPAIR");

    // /problems резолвит название через новую прямую связь Repair.equipment
    const problems = await request(app)
      .get("/api/warehouse/problems")
      .set(AUTH(pinToken));
    const row = problems.body.repairs.find((r: any) => r.id === repair.id);
    expect(row.equipmentName).toBe("Сандбэг Директ");
    expect(row.quantity).toBe(3);
  });

  it("(d) Фото: magic-bytes ок → RepairPhoto; чужая заявка → 403", async () => {
    const created = await request(app)
      .post("/api/warehouse/repairs")
      .set(AUTH(pinToken))
      .send({ equipmentUnitId: unitBId, reason: "трещина корпуса" });
    expect(created.status).toBe(201);
    const repairId = created.body.repair.id;

    const up = await request(app)
      .post(`/api/warehouse/repairs/${repairId}/photos`)
      .set(AUTH(pinToken))
      .attach("photo", JPEG_BYTES, { filename: "broken.jpg", contentType: "image/jpeg" });
    expect(up.status).toBe(201);
    expect(up.body.photosCount).toBe(1);

    const photos = await prisma.repairPhoto.findMany({ where: { repairId } });
    expect(photos).toHaveLength(1);
    expect(photos[0].createdBy).toBe("Иван Прямой");

    const foreign = await request(app)
      .post(`/api/warehouse/repairs/${repairId}/photos`)
      .set(AUTH(otherPinToken))
      .attach("photo", JPEG_BYTES, { filename: "x.jpg", contentType: "image/jpeg" });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("REPAIR_NOT_OWN");
  });

  it("(e) Валидация: короткий reason и неверный target → 400", async () => {
    const short = await request(app)
      .post("/api/warehouse/repairs")
      .set(AUTH(pinToken))
      .send({ equipmentId: countEquipmentId, reason: "ok" });
    expect(short.status).toBe(400);

    const both = await request(app)
      .post("/api/warehouse/repairs")
      .set(AUTH(pinToken))
      .send({ equipmentId: countEquipmentId, equipmentUnitId: unitBId, reason: "и то и то" });
    expect(both.status).toBe(400);

    const neither = await request(app)
      .post("/api/warehouse/repairs")
      .set(AUTH(pinToken))
      .send({ reason: "без цели" });
    expect(neither.status).toBe(400);
  });
});
