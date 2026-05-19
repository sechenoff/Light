/**
 * Интеграционный тест: problemItemService
 * Phase 2 — реестр «Потеряшки»: создание / резолв / авто-резолв проблемных единиц
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-problem-svc.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-problem-svc";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-problem-svc";
process.env.WAREHOUSE_SECRET = "test-warehouse-problem-svc";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-problem-svc-min16chars";

let prisma: any;
let adminId: string;

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

  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword } = await import("../services/auth");
  const hash = await hashPassword("problem-svc-pass");

  const admin = await prisma.adminUser.create({
    data: { username: "problem_svc_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  adminId = admin.id;
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

describe("createProblemItem", () => {
  it("LEFT_ON_SITE → status EXPECTED, unit MISSING, audit PROBLEM_ITEM_CREATE", async () => {
    const eq = await prisma.equipment.create({ data: { importKey: "ps1", name: "X", category: "C", rentalRatePerShift: 1, stockTrackingMode: "UNIT" } });
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "ISSUED" } });
    const { createProblemItem } = await import("../services/problemItemService");
    const pi = await createProblemItem({
      equipmentUnitId: unit.id, reason: "LEFT_ON_SITE", comment: "ночная смена",
      expectedBackDate: new Date("2026-06-20"), sourceBookingId: null, createdBy: adminId,
    });
    expect(pi.status).toBe("EXPECTED");
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("MISSING");
    const a = await prisma.auditEntry.findFirst({ where: { action: "PROBLEM_ITEM_CREATE", entityId: unit.id } });
    expect(a).not.toBeNull();
  });

  it("DESTROYED → status WROTE_OFF (closed), unit RETIRED", async () => {
    const eq = await prisma.equipment.create({ data: { importKey: "ps2", name: "Y", category: "C", rentalRatePerShift: 1, stockTrackingMode: "UNIT" } });
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "ISSUED" } });
    const { createProblemItem } = await import("../services/problemItemService");
    const pi = await createProblemItem({ equipmentUnitId: unit.id, reason: "DESTROYED", comment: "разбит", sourceBookingId: null, createdBy: adminId });
    expect(pi.status).toBe("WROTE_OFF");
    expect(pi.resolvedAt).not.toBeNull();
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("RETIRED");
  });

  it("resolveProblemItem FOUND → unit AVAILABLE, status FOUND, audit", async () => {
    const eq = await prisma.equipment.create({ data: { importKey: "ps3", name: "Z", category: "C", rentalRatePerShift: 1, stockTrackingMode: "UNIT" } });
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "ISSUED" } });
    const { createProblemItem, resolveProblemItem } = await import("../services/problemItemService");
    const pi = await createProblemItem({ equipmentUnitId: unit.id, reason: "LOST", comment: "пропал", sourceBookingId: null, createdBy: adminId });
    const r = await resolveProblemItem(pi.id, "FOUND", "нашёлся на складе", adminId);
    expect(r.status).toBe("FOUND");
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("AVAILABLE");
  });
});
