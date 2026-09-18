import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "booking-issues-"));
fs.writeFileSync(path.join(dir, "test.db"), "");
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.JWT_SECRET = "issues-test-secret-at-least-thirty-two";
process.env.WAREHOUSE_SECRET = "issues-warehouse-test-secret";
process.env.BARCODE_SECRET = "issues-barcode-test-secret";
process.env.RATE_LIMIT_DISABLED = "true";
let prisma: (typeof import("../prisma"))["prisma"], app: (typeof import("../app"))["app"];
let issues: typeof import("../services/bookingIssues"), register: typeof import("../services/bookingRegister");
let bookingId: string, secondId: string, clientId: string, uid: string, lossId: string, repairId: string;
const tokens: Record<string, string> = {};
const now = new Date("2026-09-18T09:00:00Z");
const H = (role = "SUPER_ADMIN") => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${tokens[role]}` });
beforeAll(async () => {
  execFileSync(process.execPath, [path.resolve(__dirname, "../../../../node_modules/prisma/build/index.js"), "db", "push", "--skip-generate", "--schema", path.resolve(__dirname, "../../prisma/schema.prisma")], { env: process.env, stdio: "pipe" });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  issues = await import("../services/bookingIssues"); register = await import("../services/bookingRegister");
  const { signSession } = await import("../services/auth");
  for (const role of ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const) {
    const u = await prisma.adminUser.create({ data: { username: `issues-${role}`, passwordHash: "unused", role } });
    tokens[role] = signSession({ userId: u.id, username: u.username, role });
    if (role === "SUPER_ADMIN") uid = u.id;
  }
  clientId = (await prisma.client.create({ data: { name: "Клиент" } })).id;
  for (const title of ["С недостачей", "Только ремонт"]) {
    const b = await prisma.booking.create({ data: { clientId, projectName: title, status: "RETURNED", startDate: now, endDate: now, finalAmount: "1000", amountPaid: "1000", amountOutstanding: "0" } });
    if (!bookingId) bookingId = b.id; else secondId = b.id;
  }
  const equipment = await prisma.equipment.create({ data: { name: "Кабель", importKey: "ISSUES-CABLE", category: "Кабели", rentalRatePerShift: "100", totalQuantity: 10 } });
  const item = await prisma.bookingItem.create({ data: { bookingId, equipmentId: equipment.id, quantity: 5 } });
  lossId = (await prisma.problemItem.create({ data: { bookingItemId: item.id, quantity: 3, reason: "LEFT_ON_SITE", status: "EXPECTED", comment: "Клиент привезёт после смены", expectedBackDate: new Date("2026-09-16T21:00:00Z"), createdBy: uid } })).id;
  await prisma.problemItem.create({ data: { sourceBookingId: bookingId, quantity: 7, reason: "LOST", status: "FOUND", comment: "Нашли", resolvedAt: now, resolutionNote: "Вернули в кофре", createdBy: uid, resolvedBy: uid } });
  repairId = (await prisma.repair.create({ data: { sourceBookingId: secondId, equipmentId: equipment.id, quantity: 2, reason: "Повреждён разъём", expectedReadyAt: new Date("2026-09-17T21:00:00Z"), assignedTo: uid, createdBy: uid, photos: { create: { filePath: "test-only.jpg", createdBy: uid } }, workLog: { create: { description: "Проверили питание", loggedBy: uid, timeSpentHours: 1 } } } })).id;
  await prisma.repair.create({ data: { sourceBookingId: bookingId, equipmentId: equipment.id, quantity: 8, status: "CLOSED", closedAt: now, reason: "Старая поломка", createdBy: uid } });
  // Explicit source must win over legacy booking-item fallback: no cross-project leaks.
  await prisma.repair.create({ data: { sourceBookingId: secondId, bookingItemId: item.id, quantity: 1, reason: "На другом проекте", createdBy: uid } });
}, 30_000);
afterAll(async () => { await prisma?.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
describe("Booking issues read model", () => {
  it("shows directly linked manual shortage records without a booking item", async () => {
    const equipment = await prisma.equipment.findFirstOrThrow();
    const item = await prisma.problemItem.create({ data: { equipmentId: equipment.id, sourceBookingId: secondId, source: "MANUAL", reason: "NOT_ON_SHELF", quantity: 2, status: "SEARCHING", comment: "Не найдено при проверке", createdBy: uid } });
    try {
      const data = await issues.getBookingIssues(secondId, now);
      expect(data.items.find(i => i.id === item.id)).toMatchObject({ equipmentName: "Кабель", quantity: 2, title: "Не найдено на складе" });
      const response = await request(app).get("/api/problem-items").query({ bookingId: secondId, source: "MANUAL" }).set(H());
      expect(response.status).toBe(200);
      expect(response.body.items.map((i: {id: string}) => i.id)).toEqual([item.id]);
    } finally { await prisma.problemItem.delete({ where: { id: item.id } }); }
  });
  it("separates cases from quantities and retains closed history without counting it as open", async () => {
    const d = await issues.getBookingIssues(bookingId, now);
    expect(d.summary).toEqual({ openCases: 1, missingCases: 1, missingQuantity: 3, damageCases: 0, damageQuantity: 0, waitingCases: 1, overdueCases: 1, closedCases: 2 });
    expect(d.items[0]).toMatchObject({ id: lossId, equipmentName: "Кабель", quantity: 3, createdBy: "issues-SUPER_ADMIN", overdue: true });
    expect(d.items).toHaveLength(3);
    expect(d.items.some(i => i.id === repairId)).toBe(false);
  });
  it("resolves workshop names, authenticated photo links and latest work record", async () => {
    const d = await issues.getBookingIssues(secondId, now);
    expect(d.summary.damageQuantity).toBe(3);
    const item = d.items.find(i => i.id === repairId)!;
    expect(item).toMatchObject({ assignedTo: "issues-SUPER_ADMIN", resolution: "Проверили питание", overdue: false, href: `/repair/${repairId}` });
    expect(item.photos[0].url).toMatch(new RegExp(`^/api/repairs/${repairId}/photos/`));
  });
  it("keeps paid returned bookings active while a repair is open and supports issue filters", async () => {
    const query = { clientId, scope: "active" };
    const d = await register.listBookingRegister(query, now);
    expect(d.bookings.map(b => b.id)).toContain(secondId);
    for (const [issue, expected] of [["missing", bookingId], ["damage", secondId], ["waiting", bookingId], ["overdue", bookingId]] as const) {
      const r = await register.listBookingRegister({ ...query, issue }, now);
      expect(r.bookings.map(b => b.id)).toEqual([expected]);
    }
  });
  it("does not change booking finances, stock or records when reading", async () => {
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await issues.getBookingIssues(bookingId, now); await register.listBookingRegister({}, now);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toEqual(before);
    expect(await prisma.problemItem.count()).toBe(2);
    expect((await prisma.equipment.findFirstOrThrow()).totalQuantity).toBe(10);
  });
  it("applies Moscow calendar deadlines, including midnight", () => {
    expect(issues.issueDateOverdue(new Date("2026-09-17T21:00:00Z"), now)).toBe(false);
    expect(issues.issueDateOverdue(new Date("2026-09-17T20:59:59Z"), now)).toBe(true);
    expect(issues.issueDateOverdue(null, now)).toBe(false);
  });
  it("guards issue details by role and returns 404 for an unknown booking", async () => {
    for (const role of ["SUPER_ADMIN", "WAREHOUSE"]) expect((await request(app).get(`/api/bookings/${bookingId}/issues`).set(H(role))).status).toBe(200);
    expect((await request(app).get(`/api/bookings/${bookingId}/issues`).set(H("TECHNICIAN"))).status).toBe(403);
    expect((await request(app).get(`/api/bookings/${bookingId}/issues`).set("X-API-Key", "test-key-1")).status).toBe(401);
    expect((await request(app).get("/api/bookings/unknown/issues").set(H())).status).toBe(404);
  });
  it("filters the existing lost-items page by source booking, including legacy COUNT rows", async () => {
    const r = await request(app).get("/api/problem-items").query({ bookingId }).set(H());
    expect(r.body.items.find((i: { id: string }) => i.id === lossId).booking.id).toBe(bookingId);
    expect(r.status).toBe(200); expect(r.body.items.map((i: { id: string }) => i.id)).toContain(lossId);
    expect((await request(app).get("/api/problem-items").query({ bookingId: secondId }).set(H())).body.items).toHaveLength(0);
  });
});
