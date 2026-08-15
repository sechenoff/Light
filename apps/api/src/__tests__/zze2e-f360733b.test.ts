/* Temp e2e repro (devil's advocate session f360733b). Delete after use. */
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-zze2e-f360733b.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-zze2e";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-zze2e";
process.env.WAREHOUSE_SECRET = "test-warehouse-zze2e-secret16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-zze2e-min16characters";

let app: any;
let prisma: any;
let token: string;
let bookingId: string;

function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

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
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");

  const admin = await prisma.adminUser.create({
    data: { username: "zze2e-admin", passwordHash: await hashPassword("pwd"), role: "SUPER_ADMIN" },
  });
  token = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const client = await prisma.client.create({ data: { name: "Клиент Договорной" } });
  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    update: { legalName: "ООО «Тест Рент»", inn: "7700000001" },
    create: { id: "singleton", legalName: "ООО «Тест Рент»", inn: "7700000001" },
  });

  // Бронь: договорной итог 100000, БЕЗ добора и БЕЗ транспорта.
  const b = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Без добора и транспорта",
      startDate: new Date("2026-08-01T09:00:00Z"),
      endDate: new Date("2026-08-03T18:00:00Z"),
      status: "CONFIRMED",
      finalAmount: "100000",
      manualFinalAmount: "100000",
      amountOutstanding: "100000",
    },
  });
  bookingId = b.id;

  await prisma.estimate.create({
    data: {
      bookingId: b.id,
      kind: "MAIN",
      shifts: 3,
      subtotal: "300000",
      discountPercent: "50",
      discountAmount: "150000",
      totalAfterDiscount: "150000",
      lines: {
        create: [
          {
            equipmentId: null,
            categorySnapshot: "Свет",
            nameSnapshot: "ARRI SkyPanel S60",
            quantity: 2,
            unitPrice: "50000",
            lineSum: "300000",
          },
        ],
      },
    },
  });
});

describe("e2e: full-estimate PDF с договорным итогом", () => {
  it("печатает согласованную сумму", async () => {
    const res = await request(app)
      .get(`/api/bookings/${bookingId}/full-estimate/export/pdf`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-API-Key", "test-key-zze2e")
      .buffer()
      .parse(binaryParser as any);

    expect(res.status).toBe(200);
    // Путь был прибит к scratchpad сессии, в которой этот репро писался, —
    // на любой другой машине тест падал с ENOENT ещё до проверки. Пишем во
    // временный каталог ОС.
    const out = path.join(os.tmpdir(), "zze2e-f360733b-estimate.pdf");
    fs.writeFileSync(out, res.body);
    const txt = execSync(`pdftotext -layout ${out} -`).toString();
    // eslint-disable-next-line no-console
    console.log("--- PDF TEXT ---\n" + txt);
    console.log("содержит 100 000:", /100\s?000/.test(txt));
    console.log("содержит 150 000:", /150\s?000/.test(txt));

    // Инвойс по той же брони
    const inv = await request(app)
      .post(`/api/bookings/${bookingId}/invoice`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-API-Key", "test-key-zze2e")
      .send({});
    console.log("invoice status:", inv.status, JSON.stringify(inv.body).slice(0, 400));
  }, 120000);
});
