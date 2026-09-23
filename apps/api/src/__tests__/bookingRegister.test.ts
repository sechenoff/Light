import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "booking-register-")),
  db = path.join(dir, "test.db");
fs.writeFileSync(db, "");
process.env.DATABASE_URL = `file:${db}`;
process.env.JWT_SECRET = "register-test-secret-at-least-thirty-two";
process.env.WAREHOUSE_SECRET = "register-warehouse-test-secret";
process.env.BARCODE_SECRET = "register-barcode-test-secret";
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_DISABLED = "true";
let prisma: (typeof import("../prisma"))["prisma"],
  app: (typeof import("../app"))["app"],
  service: typeof import("../services/bookingRegister");
let uid: string, clientId: string, batchClient: string;
const tokens: Record<string, string> = {},
  ids: Record<string, string> = {};
const now = new Date("2026-09-17T12:00:00Z");
const H = (role = "SUPER_ADMIN") => ({
  "X-API-Key": "test-key-1",
  Authorization: `Bearer ${tokens[role]}`,
});
beforeAll(async () => {
  execFileSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../../../node_modules/prisma/build/index.js"),
      "db",
      "push",
      "--skip-generate",
      "--schema",
      path.resolve(__dirname, "../../prisma/schema.prisma"),
    ],
    { env: process.env, stdio: "pipe" },
  );
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  service = await import("../services/bookingRegister");
  const { signSession } = await import("../services/auth");
  for (const role of ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const) {
    const u = await prisma.adminUser.create({
      data: { username: `register-${role}`, passwordHash: "unused", role },
    });
    tokens[role] = signSession({ userId: u.id, username: u.username, role });
    if (role === "SUPER_ADMIN") uid = u.id;
  }
  clientId = (await prisma.client.create({ data: { name: "Одинаковое имя" } }))
    .id;
  batchClient = (
    await prisma.client.create({ data: { name: "Одинаковое имя 2" } })
  ).id;
  async function booking(name: string, data: Record<string, unknown> = {}) {
    const b = await prisma.booking.create({
      data: {
        clientId,
        projectName: name,
        status: "RETURNED",
        startDate: new Date("2026-09-01T06:00:00Z"),
        endDate: new Date("2026-09-20T18:00:00Z"),
        finalAmount: "1000",
        manualFinalAmount: "1000",
        amountPaid: "0",
        amountOutstanding: "1000",
        ...data,
      } as any,
    });
    ids[name] = b.id;
    return b;
  }
  await booking("paid", { amountPaid: "1000", amountOutstanding: "0" });
  await booking("paid-issued", {
    status: "ISSUED",
    amountPaid: "1000",
    amountOutstanding: "0",
  });
  await booking("partial-overdue", {
    amountPaid: "400",
    amountOutstanding: "600",
    expectedPaymentDate: new Date("2026-09-10T21:00:00Z"),
  });
  await booking("unpaid-future", {
    expectedPaymentDate: new Date("2026-09-20T21:00:00Z"),
  });
  await booking("zero", {
    finalAmount: "0",
    manualFinalAmount: "0",
    amountOutstanding: "0",
  });
  await booking("unpriced", {
    status: "DRAFT",
    finalAmount: "0",
    manualFinalAmount: null,
    amountOutstanding: "0",
  });
  await booking("settled", {
    amountPaid: "500",
    amountOutstanding: "0",
    writeOffAmount: "500",
  });
  await booking("credit", { amountPaid: "1100", amountOutstanding: "0" });
  await booking("same-day", {
    expectedPaymentDate: new Date("2026-09-17T09:00:00Z"),
  });
  await booking("archived", { deletedAt: now });
  await booking("open-problem", { amountPaid: "1000", amountOutstanding: "0" });
  await prisma.problemItem.create({
    data: {
      sourceBookingId: ids["open-problem"],
      reason: "LOST",
      comment: "test",
      createdBy: uid,
    },
  });
  const b = await booking("series", {
    mode: "PROJECT",
    endDate: new Date("2026-09-20T21:00:00Z"),
    status: "ISSUED",
    finalAmount: "2000",
    amountPaid: "500",
    amountOutstanding: "1500",
  });
  await prisma.bookingProject.create({
    data: { bookingId: b.id, billingCycle: "WEEKLY" },
  });
  for (const [n, from, through, due] of [
    [1, "2026-09-01", "2026-09-07", "2026-09-10"],
    [2, "2026-09-08", "2026-09-14", "2026-09-25"],
  ] as const) {
    await prisma.projectBillingPeriod.create({
      data: {
        bookingId: b.id,
        requestKey: `period-${n}`,
        fromDate: from,
        throughDate: through,
        amount: "1000",
        dueDate: new Date(`${due}T20:59:59Z`),
        linesJson: "[]",
        createdBy: uid,
      },
    });
  }
  const equipment = await prisma.equipment.create({
    data: {
      name: "Test light",
      importKey: "REGISTER-LIGHT",
      category: "Light",
      rentalRatePerShift: "100",
      totalQuantity: 10,
    } as any,
  });
  await prisma.projectLot.create({
    data: {
      bookingId: b.id,
      equipmentId: equipment.id,
      nameSnapshot: "Light",
      quantity: 4,
      ratePerShift: "100",
      fromDate: "2026-09-01",
      throughDate: "2026-09-17",
      status: "ISSUED",
      issuedAt: now,
      returns: {
        create: { quantity: 1, lastBillableDate: "2026-09-15", createdBy: uid },
      },
    },
  });
  await prisma.projectLot.create({
    data: {
      bookingId: b.id,
      equipmentId: equipment.id,
      nameSnapshot: "Addon",
      quantity: 2,
      ratePerShift: "100",
      fromDate: "2026-09-17",
      throughDate: "2026-09-20",
    },
  });
  const noCharges = await booking("no-charges", {
    mode: "PROJECT",
    finalAmount: "0",
    amountOutstanding: "0",
  });
  await prisma.bookingProject.create({ data: { bookingId: noCharges.id } });
  await prisma.booking.createMany({
    data: Array.from({ length: 65 }, (_, n) => ({
      id: `batch-${String(n).padStart(3, "0")}`,
      clientId: batchClient,
      projectName: `Пачка ${n}`,
      status: "CONFIRMED" as const,
      startDate: new Date("2026-09-17T06:00:00Z"),
      endDate: new Date("2026-09-17T18:00:00Z"),
      finalAmount: "100",
      amountOutstanding: "100",
      createdAt: now,
    })),
  });
});
afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
const list = (q: Record<string, unknown> = {}) =>
  service.listBookingRegister({ scope: "all", clientId, ...q }, now);
describe("Booking control read model", () => {
  it("includes fully paid completed bookings when the request omits scope", async () => {
    const response = await request(app).get("/api/bookings/register").set(H()).query({ clientId });
    expect(response.status).toBe(200);
    const rows = response.body.bookings;
    expect(rows.some((r: { id: string }) => r.id === ids.paid)).toBe(true);
    expect(rows.some((r: { id: string }) => r.id === ids["partial-overdue"])).toBe(true);
    expect(rows.some((r: { id: string }) => r.id === ids.archived)).toBe(false);
  });
  it("keeps operational and financial obligations separate; hides only completed in active", async () => {
    const d = await list(),
      by = Object.fromEntries(d.bookings.map((r) => [r.projectName, r]));
    expect(by.paid.completed).toBe(true);
    expect(by["paid-issued"].completed).toBe(false);
    expect(by["partial-overdue"].financeState).toBe("PARTIAL");
    expect(by["partial-overdue"].overdueAmount).toBe("600.00");
    expect(by.zero.financeState).toBe("ZERO");
    expect(by.unpriced.financeState).toBe("UNPRICED");
    expect(by.settled.financeState).toBe("SETTLED");
    expect(by.credit.completed).toBe(false);
    expect(by["open-problem"].completed).toBe(false);
    expect(by["open-problem"].openProblems).toBe(1);
    expect(by["no-charges"].financeState).toBe("NO_CHARGES");
    expect(by.archived).toBeUndefined();
    const active = await list({ scope: "active" });
    expect(active.bookings.some((r) => r.id === ids.paid)).toBe(false);
  });
  it("allocates period payments oldest first; only overdue part is red", async () => {
    const d = await list({ projectId: ids.series });
    const r = d.bookings[0];
    expect(r.amountOutstanding).toBe("1500.00");
    expect(r.overdueAmount).toBe("500.00");
    expect(r.onHand).toBe(3);
    expect(r.projectSummary).toMatchObject({
      plannedQuantity: 2,
      periodCount: 2,
      closedThrough: "2026-09-14",
      unclosedBilling: true,
      nextCloseDate: "2026-09-20",
    });
    expect(d.day.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["ADDON", "RETURN"]),
    );
  });
  it("uses the last rental day for exclusive project end boundaries", async () => {
    const d = await list({ projectId: ids.series });
    expect(d.bookings[0].endDate).toBe("2026-09-20T20:59:59.999Z");
    expect(
      (
        await list({
          projectId: ids.series,
          from: "2026-09-21",
          to: "2026-09-21",
        })
      ).totalCount,
    ).toBe(0);
  });
  it("counts overlap and exact Moscow day boundaries", async () => {
    expect(
      (
        await list({
          from: "2026-09-12",
          to: "2026-09-12",
          dateField: "rental",
        })
      ).totalCount,
    ).toBeGreaterThan(0);
    expect(
      (await list({ from: "2026-09-12", to: "2026-09-12", dateField: "start" }))
        .totalCount,
    ).toBe(0);
    const d = await list({ projectId: ids["same-day"] });
    expect(d.bookings[0].overdueDays).toBe(0);
    expect(d.bookings[0].overdueAmount).toBe("1000.00");
  });
  it("filters clients by identity, statuses by OR, money and actions across all rows", async () => {
    const d = await list({
      clientId: batchClient,
      status: "CONFIRMED,ISSUED",
      min: 100,
      max: 100,
      action: "issue",
      limit: 10,
    });
    expect(d.totalCount).toBe(65);
    expect(d.totals.outstanding).toBe("6500.00");
    expect(d.bookings).toHaveLength(10);
    expect(d.day.events).toHaveLength(65);
    expect(d.bookings.every((b) => b.client.id === batchClient)).toBe(true);
  });
  it("stable cursors traverse ties exactly once in both directions", async () => {
    for (const direction of ["asc", "desc"]) {
      let cursor: string | null = null;
      const seen: string[] = [];
      do {
        const d = await list({
          clientId: batchClient,
          limit: 11,
          sort: "startDate",
          direction,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...d.bookings.map((r) => r.id));
        cursor = d.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(65);
      expect(new Set(seen).size).toBe(65);
      expect(seen[0]).toBe(direction === "asc" ? "batch-000" : "batch-064");
    }
  });
  it("rejects invalid dates, inverted ranges and cursors for another filter", async () => {
    await expect(list({ from: "2026-02-30" })).rejects.toThrow();
    await expect(list({ min: 20, max: 10 })).rejects.toThrow();
    await expect(
      list({ from: "2026-10-01", to: "2026-09-01" }),
    ).rejects.toThrow();
    const d = await list({ clientId: batchClient, limit: 1 });
    await expect(
      list({ cursor: d.nextCursor, payment: "paid" }),
    ).rejects.toThrow("Список изменился");
  });
  it("never writes finance, dates, archive flags, periods or audit while reading", async () => {
    const before = JSON.stringify(
      await prisma.booking.findMany({ orderBy: { id: "asc" } }),
    );
    const audit = await prisma.auditEntry.count();
    await list();
    await list({ scope: "completed" });
    expect(
      JSON.stringify(await prisma.booking.findMany({ orderBy: { id: "asc" } })),
    ).toBe(before);
    expect(await prisma.auditEntry.count()).toBe(audit);
  });
  it("requires authorization and keeps warehouse access", async () => {
    expect(
      (
        await request(app)
          .get("/api/bookings/register")
          .set({ "X-API-Key": "test-key-1" })
      ).status,
    ).toBe(401);
    expect(
      (await request(app).get("/api/bookings/register").set(H("TECHNICIAN")))
        .status,
    ).toBe(403);
    expect(
      (await request(app).get("/api/bookings/register").set(H("WAREHOUSE")))
        .status,
    ).toBe(200);
  });
});
describe("Payment retries", () => {
  it("replays one payment once and rejects a changed payload", async () => {
    const body = {
      bookingId: ids["unpaid-future"],
      amount: 100,
      method: "CASH",
      receivedAt: now.toISOString(),
      requestKey: randomUUID(),
    };
    const first = await request(app).post("/api/payments").set(H()).send(body);
    expect(first.status).toBe(201);
    const retry = await request(app).post("/api/payments").set(H()).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.payment.id).toBe(first.body.payment.id);
    expect(
      await prisma.payment.count({ where: { id: first.body.payment.id } }),
    ).toBe(1);
    expect(
      (
        await prisma.booking.findUniqueOrThrow({
          where: { id: body.bookingId },
        })
      ).amountPaid.toString(),
    ).toBe("100");
    expect(
      (
        await request(app)
          .post("/api/payments")
          .set(H())
          .send({ ...body, amount: 200 })
      ).status,
    ).toBe(409);
  });
  it("protects concurrent retries and still enforces warehouse limits", async () => {
    const body = {
      bookingId: ids["paid-issued"],
      amount: 50,
      method: "CASH",
      receivedAt: now.toISOString(),
      requestKey: randomUUID(),
    };
    const results = await Promise.all([
      request(app).post("/api/payments").set(H()).send(body),
      request(app).post("/api/payments").set(H()).send(body),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body.payment.id).toBe(results[1].body.payment.id);
    expect(
      (
        await request(app)
          .post("/api/payments")
          .set(H("WAREHOUSE"))
          .send({ ...body, amount: 100001, requestKey: randomUUID() })
      ).status,
    ).toBe(403);
  });
});
