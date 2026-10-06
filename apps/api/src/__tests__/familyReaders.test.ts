/**
 * Экраны и документы понимают продолжение брони (этап 8, чтение).
 *
 * Семья пишется прямо в базу: основная бронь RETURNED и продолжение ISSUED с
 * оставленным у клиента. Проверяем акт, реестр, карточку, статистику клиента,
 * документ сметы продолжения, список «В работе» киоска и заготовку счёта.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-family-readers.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-frd";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-family-readers";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-frd";
process.env.JWT_SECRET = "test-jwt-family-readers-16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const N = Math.floor(Date.now() / HOUR) * HOUR;
const ROOT_START = new Date(N - 2 * DAY);
const ROOT_END = new Date(N - DAY);

let app: Express;
let prisma: any;
let saToken: string;
let clientId: string;
let storm: string;
let seq = 0;

const AUTH = () => ({ "X-API-Key": "test-key-frd", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-frd", passwordHash: "x", role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Продакшн «Сфера»" } })).id;
  storm = (
    await prisma.equipment.create({
      data: { importKey: "frd-storm", name: "Aputure STORM 400x", category: "Свет", totalQuantity: 20, rentalRatePerShift: 1000, stockTrackingMode: "COUNT" },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** Основная (RETURNED, оплачена) и продолжение (ISSUED, 2 шт до завтра, 1 200 ₽). */
async function mkFamily() {
  seq += 1;
  const root = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Съёмка ${seq}`,
      docNumber: `СМ-T-${seq}`,
      status: "RETURNED",
      startDate: ROOT_START,
      endDate: ROOT_END,
      issuedAt: ROOT_START,
      finalAmount: 5000,
      amountPaid: 5000,
      amountOutstanding: 0,
      paymentStatus: "PAID",
      items: { create: [{ equipmentId: storm, quantity: 6 }] },
    },
  });
  const child = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Съёмка ${seq}`,
      docNumber: `СМ-T-${seq}-1`,
      status: "ISSUED",
      startDate: ROOT_END,
      endDate: new Date(N + DAY),
      issuedAt: ROOT_END,
      confirmedAt: ROOT_END,
      parentBookingId: root.id,
      rootBookingId: root.id,
      finalAmount: 1200,
      amountOutstanding: 1200,
      items: { create: [{ equipmentId: storm, quantity: 2, coveredShifts: 1, shiftAnchorAt: ROOT_START, listRatePerShift: 1000 }] },
    },
  });
  return { root, child };
}

describe("акт", () => {
  it("по основной брони ждёт, пока продолжение у клиента", async () => {
    const { root, child } = await mkFamily();
    const waiting = await request(app).get(`/api/bookings/${root.id}/act.pdf`).set(AUTH());
    expect(waiting.status).toBe(409);
    expect(waiting.body.code).toBe("ACT_NOT_AVAILABLE");
    await prisma.booking.update({ where: { id: child.id }, data: { status: "RETURNED" } });
    const ready = await request(app).get(`/api/bookings/${root.id}/act.pdf`).set(AUTH());
    expect(ready.status).toBe(200);
  });
});

describe("реестр", () => {
  it("основная — «возвращена частично» и не завершена, продолжение знает основную", async () => {
    const { root, child } = await mkFamily();
    const { listBookingRegister } = await import("../services/bookingRegister");
    const res = await listBookingRegister({ limit: 200 });
    const rootRow = res.bookings.find((r) => r.id === root.id)!;
    const childRow = res.bookings.find((r) => r.id === child.id)!;
    expect(rootRow.partiallyReturned).toBe(true);
    expect(rootRow.continuationsOnHand).toBe(2);
    expect(rootRow.completed).toBe(false);
    expect(childRow.continuationOf).toEqual({ id: root.id, docNumber: root.docNumber });
    // Продолжение рождается выданным: «выдачи» у него в повестке нет.
    expect(res.day.events.some((e) => e.bookingId === child.id && e.kind === "ISSUE")).toBe(false);
  });
});

describe("карточка брони", () => {
  it("у основной — продолжения и итог вместе с ними, у продолжения — основная", async () => {
    const { root, child } = await mkFamily();
    const rootRes = await request(app).get(`/api/bookings/${root.id}`).set(AUTH());
    const fam = rootRes.body.booking.family;
    expect(fam.partiallyReturned).toBe(true);
    expect(fam.continuations).toHaveLength(1);
    expect(fam.continuations[0]).toMatchObject({ id: child.id, docNumber: child.docNumber, status: "ISSUED", quantity: 2 });
    expect(fam.totals).toEqual({ finalAmount: "6200.00", amountPaid: "5000.00", amountOutstanding: "1200.00" });
    const childRes = await request(app).get(`/api/bookings/${child.id}`).set(AUTH());
    expect(childRes.body.booking.family.parent).toEqual({ id: root.id, docNumber: root.docNumber });
  });

  it("у обычной брони семьи нет", async () => {
    seq += 1;
    const plain = await prisma.booking.create({
      data: { clientId, projectName: `Обычная ${seq}`, status: "DRAFT", startDate: ROOT_START, endDate: ROOT_END },
    });
    const res = await request(app).get(`/api/bookings/${plain.id}`).set(AUTH());
    expect(res.body.booking.family).toBeNull();
  });
});

describe("статистика клиента", () => {
  it("продолжение — та же аренда: в число броней не входит, сумма — к своей основной", async () => {
    const lone = await prisma.client.create({ data: { name: "Студия «Пикчер»" } });
    const root = await prisma.booking.create({
      data: { clientId: lone.id, projectName: "Клип", status: "RETURNED", startDate: ROOT_START, endDate: ROOT_END, finalAmount: 4000 },
    });
    await prisma.booking.create({
      data: {
        clientId: lone.id,
        projectName: "Клип",
        status: "ISSUED",
        startDate: ROOT_END,
        endDate: new Date(N + DAY),
        parentBookingId: root.id,
        rootBookingId: root.id,
        finalAmount: 2000,
      },
    });
    const { getClientStats } = await import("../services/clientStats");
    const stats = await getClientStats(lone.id);
    expect(stats.bookingCount).toBe(1);
    expect(stats.totalRevenue).toBe(6000);
    expect(stats.averageCheck).toBe(6000);
  });
});

describe("статистика спроса по оборудованию", () => {
  it("продолжение не считается второй арендой, штуки в пределах оплаченного — 0 смен", async () => {
    const eq = await prisma.equipment.create({
      data: { importKey: "frd-demand", name: "Генератор спроса", category: "Свет", totalQuantity: 9, rentalRatePerShift: 1000, stockTrackingMode: "COUNT" },
    });
    const start = new Date(N - 3 * DAY);
    const root = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Спрос",
        status: "RETURNED",
        startDate: start,
        endDate: new Date(start.getTime() + DAY),
        items: { create: [{ equipmentId: eq.id, quantity: 3 }] },
        estimates: { create: { kind: "MAIN", shifts: 1, subtotal: 3000, discountAmount: 0, totalAfterDiscount: 3000, lines: { create: [{ equipmentId: eq.id, categorySnapshot: "Свет", nameSnapshot: "Генератор спроса", quantity: 3, unitPrice: 1000, lineSum: 3000, shifts: 1 }] } } },
      },
    });
    await prisma.booking.create({
      data: {
        clientId,
        projectName: "Спрос",
        status: "ISSUED",
        startDate: new Date(start.getTime() + DAY),
        endDate: new Date(start.getTime() + 2 * DAY),
        parentBookingId: root.id,
        rootBookingId: root.id,
        items: { create: [{ equipmentId: eq.id, quantity: 1, coveredShifts: 2, shiftAnchorAt: start }] },
        estimates: { create: { kind: "MAIN", shifts: 1, subtotal: 0, discountAmount: 0, totalAfterDiscount: 0, lines: { create: [{ equipmentId: eq.id, categorySnapshot: "Свет", nameSnapshot: "Генератор спроса", quantity: 1, unitPrice: 0, lineSum: 0, shifts: 0 }] } } },
      },
    });
    const { computeEquipmentStats } = await import("../services/equipmentStats");
    const stats: any = await computeEquipmentStats(30, prisma);
    const row = JSON.stringify(stats).includes(eq.id) ? findRow(stats, eq.id) : null;
    expect(row).not.toBeNull();
    expect(row.bookingsCount).toBe(1);
    expect(row.qtyShifts).toBe(3);
  });
});

/** Строка позиции в ответе статистики — где бы она ни лежала. */
function findRow(node: any, equipmentId: string): any {
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findRow(x, equipmentId);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    if ((node.equipmentId === equipmentId || node.id === equipmentId) && "qtyShifts" in node) return node;
    for (const v of Object.values(node)) {
      const r = findRow(v, equipmentId);
      if (r) return r;
    }
  }
  return null;
}

describe("документ сметы продолжения", () => {
  it("«Дополнительная смета», строка о продолжении, оплаченное — с прочерком", async () => {
    const { root } = await mkFamily();
    const Decimal = (await import("decimal.js")).default;
    const { buildSmetaFromPersistedEstimate } = await import("../services/smetaExport/buildDocument");
    const doc = buildSmetaFromPersistedEstimate({
      booking: {
        startDate: ROOT_END,
        endDate: new Date(N + DAY),
        projectName: "Съёмка",
        comment: null,
        client: { name: "Продакшн «Сфера»" },
        docNumber: `${root.docNumber}-1`,
        continuationOf: { docNumber: root.docNumber, createdAt: root.createdAt },
      },
      estimate: {
        shifts: 2,
        subtotal: new Decimal(2400),
        discountPercent: null,
        discountAmount: new Decimal(0),
        totalAfterDiscount: new Decimal(2400),
        commentSnapshot: null,
        optionalNote: null,
        includeOptionalInExport: false,
        hoursSummaryText: null,
        lines: [
          { equipmentId: "eq-a", categorySnapshot: "Свет", nameSnapshot: "Оплачено", quantity: 2, unitPrice: new Decimal(0), lineSum: new Decimal(0), listUnitPrice: null, shifts: 0 },
          { equipmentId: "eq-b", categorySnapshot: "Свет", nameSnapshot: "Продлено", quantity: 2, unitPrice: new Decimal(1200), lineSum: new Decimal(2400), listUnitPrice: null, shifts: 2 },
        ],
      },
    });
    expect(doc.documentTitleRu).toBe("Дополнительная смета");
    expect(doc.documentTitleEn).toContain(`продолжение к смете № ${root.docNumber} от`);
    const covered = doc.lines.find((l) => l.name === "Оплачено")!;
    expect(covered.shifts).toBe(0);
    expect(doc.showShiftsColumn).toBe(true);
    const { lineShiftsNote } = await import("../services/smetaExport/shiftsNote");
    expect(lineShiftsNote(covered, doc, { withCount: false })).toBe("оплачено в основной смете");
  });

  it("своя позиция продолжения тоже «оплачено в основной смете»", async () => {
    const Decimal = (await import("decimal.js")).default;
    const { buildSmetaFromPersistedEstimate } = await import("../services/smetaExport/buildDocument");
    const doc = buildSmetaFromPersistedEstimate({
      booking: { startDate: ROOT_END, endDate: new Date(N + DAY), projectName: "Съёмка", comment: null, client: { name: "Клиент" } },
      estimate: {
        shifts: 2, subtotal: new Decimal(0), discountPercent: null, discountAmount: new Decimal(0), totalAfterDiscount: new Decimal(0),
        commentSnapshot: null, optionalNote: null, includeOptionalInExport: false, hoursSummaryText: null,
        lines: [{ equipmentId: null, categorySnapshot: "Произвольная позиция", nameSnapshot: "Расходники", quantity: 1, unitPrice: new Decimal(0), lineSum: new Decimal(0), listUnitPrice: null, shifts: 0 }],
      },
    });
    const { lineShiftsNote } = await import("../services/smetaExport/shiftsNote");
    expect(doc.lines[0].shifts).toBe(0);
    expect(lineShiftsNote(doc.lines[0], doc, { withCount: false })).toBe("оплачено в основной смете");
  });
});

describe("киоск «В работе» и счёт", () => {
  it("у продолжения «взято» — когда выдали основную, и номер основной", async () => {
    const { root, child } = await mkFamily();
    const res = await request(app).get("/api/warehouse/in-work").set(AUTH());
    expect(res.status).toBe(200);
    const row = res.body.bookings.find((b: any) => b.bookingId === child.id);
    expect(row.issuedAt).toBe(ROOT_START.toISOString());
    expect(row.continuationOf).toEqual({ docNumber: root.docNumber });
  });

  it("заготовка счёта по продолжению — по дополнительной смете к основной", async () => {
    const { root, child } = await mkFamily();
    const { prefillBillFromBooking } = await import("../services/billService");
    const prefill = await prefillBillFromBooking(child.id);
    expect(prefill.lines[0].name).toContain(`по дополнительной смете № ${child.docNumber} к смете № ${root.docNumber}`);
  });
});
