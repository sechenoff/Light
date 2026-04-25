/**
 * Unit tests для numberingService.generateInvoiceNumber.
 * Используют изолированную SQLite БД.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-numbering.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-num";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-num";
process.env.JWT_SECRET = "test-jwt-secret-numbering-min16";
process.env.API_KEYS = "test-key-num";
process.env.AUTH_MODE = "warn";

let prisma: any;

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

describe("generateInvoiceNumber", () => {
  it("returns LR-YEAR-0001 when no invoices exist for year", async () => {
    const { generateInvoiceNumber } = await import("../services/numberingService");
    const num = await generateInvoiceNumber("LR", 2026);
    expect(num).toBe("LR-2026-0001");
  });

  it("increments from last existing: 0042 → 0043", async () => {
    const { generateInvoiceNumber } = await import("../services/numberingService");

    // Create a booking to attach invoice to
    const client = await prisma.client.create({ data: { name: `num-client-${Date.now()}` } });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "num-test",
        startDate: new Date(),
        endDate: new Date(),
      },
    });

    // Seed an invoice with number 0042
    await prisma.invoice.create({
      data: {
        number: "LR-2026-0042",
        bookingId: booking.id,
        kind: "FULL",
        status: "ISSUED",
        total: "1000",
        paidAmount: "0",
        createdBy: "test",
      },
    });

    const num = await generateInvoiceNumber("LR", 2026);
    expect(num).toBe("LR-2026-0043");
  });

  it("year boundary: max 2026 does not affect 2027 counter → LR-2027-0001", async () => {
    const { generateInvoiceNumber } = await import("../services/numberingService");
    // 2026 already has 0042 from previous test
    // 2027 has nothing → should start at 0001
    const num = await generateInvoiceNumber("LR", 2027);
    expect(num).toBe("LR-2027-0001");
  });

  it("generates unique sequential numbers when invoices are actually inserted between calls", async () => {
    // generateInvoiceNumber reads from the DB — for unique numbers, caller must insert
    // the invoice with the returned number before the next call.
    const { generateInvoiceNumber } = await import("../services/numberingService");

    // Create a booking to attach invoice to
    const client = await prisma.client.create({ data: { name: `seq-client-${Date.now()}` } });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "seq-test",
        startDate: new Date(),
        endDate: new Date(),
      },
    });

    // First call for 2029 → 0001
    const n1 = await generateInvoiceNumber("LR", 2029);
    expect(n1).toBe("LR-2029-0001");

    // Insert the invoice with that number
    await prisma.invoice.create({
      data: {
        number: n1,
        bookingId: booking.id,
        kind: "FULL",
        status: "ISSUED",
        total: "500",
        paidAmount: "0",
        createdBy: "test",
      },
    });

    // Second call → 0002
    const n2 = await generateInvoiceNumber("LR", 2029);
    expect(n2).toBe("LR-2029-0002");
  });
});
