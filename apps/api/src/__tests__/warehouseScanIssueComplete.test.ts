/**
 * Интеграционный тест: ISSUE-завершение
 *  · Task 1: getReconciliationPreview обогащает reservedButUnavailable name+ordinal+status.
 *  · Task 2: completeSession(ISSUE) переводит booking.status CONFIRMED → ISSUED + идемпотентно.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-scan-issue.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-scan-issue";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-scan-issue";
process.env.WAREHOUSE_SECRET = "test-warehouse-scan-issue";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-scan-issue-min16chars";

let prisma: any;
let superAdminId: string;
let clientId: string;
let equipmentId: string;
let availableUnitId: string;
let maintenanceUnitId: string;
let bookingId: string;
let bookingItemId: string;
let sessionId: string;

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
  const hash = await hashPassword("scan-issue-pass");

  const su = await prisma.adminUser.create({
    data: { username: "scan_issue_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = su.id;

  const client = await prisma.client.create({
    data: { name: "Тест ISSUE", phone: "+70000000111" },
  });
  clientId = client.id;

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "scan-issue-eq-001",
      name: "SkyPanel S60",
      category: "Свет",
      rentalRatePerShift: 1000,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;

  const u1 = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "SKY-001", status: "AVAILABLE" },
  });
  availableUnitId = u1.id;

  const u2 = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "SKY-002", status: "MAINTENANCE" },
  });
  maintenanceUnitId = u2.id;

  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Реклама «Орбита»",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-03"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  bookingId = booking.id;

  const bi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 2 },
  });
  bookingItemId = bi.id;

  // Two reservations: one AVAILABLE, one MAINTENANCE → "прибор 2 из 2" unavailable.
  await prisma.bookingItemUnit.create({
    data: { bookingItemId, equipmentUnitId: availableUnitId },
  });
  await prisma.bookingItemUnit.create({
    data: { bookingItemId, equipmentUnitId: maintenanceUnitId },
  });

  const session = await prisma.scanSession.create({
    data: { bookingId, workerName: "Тест склад", operation: "ISSUE", status: "ACTIVE" },
  });
  sessionId = session.id;

  // The worker scans only the available unit.
  await prisma.scanRecord.create({
    data: { sessionId, equipmentUnitId: availableUnitId, hmacVerified: false },
  });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("warehouseScan — ISSUE completion", () => {
  it("getReconciliationPreview enriches reservedButUnavailable with name + ordinal + status", async () => {
    const svc = await import("../services/warehouseScan");
    const preview = await svc.getReconciliationPreview(sessionId);

    expect(preview.reservedButUnavailable).toBeDefined();
    expect(preview.reservedButUnavailable).toHaveLength(1);
    expect(preview.reservedButUnavailable[0]).toEqual({
      equipmentUnitId: maintenanceUnitId,
      equipmentName: "SkyPanel S60",
      ordinalLabel: "прибор 2 из 2",
      status: "MAINTENANCE",
    });
  });

  it("completeSession(ISSUE) transitions booking CONFIRMED → ISSUED", async () => {
    const svc = await import("../services/warehouseScan");
    const result = await svc.completeSession(sessionId, { createdBy: superAdminId });

    // Physical changes already covered by other tests — we assert ONLY the
    // booking transition here.
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking?.status).toBe("ISSUED");
    // Session marked COMPLETED in the same transaction.
    const session = await prisma.scanSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("COMPLETED");
    // Sanity: returned shape includes scanned/expected.
    expect(result.scanned).toBe(1);
    expect(result.expected).toBe(2);
  });

  it("re-running completeSession on the now-ISSUED booking does not crash and keeps booking ISSUED", async () => {
    const svc = await import("../services/warehouseScan");
    // Session is already COMPLETED → completeSession refuses (existing guard).
    await expect(
      svc.completeSession(sessionId, { createdBy: superAdminId }),
    ).rejects.toThrow(/должна быть активной/i);

    // Booking still ISSUED — no rollback.
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking?.status).toBe("ISSUED");
  });
});
