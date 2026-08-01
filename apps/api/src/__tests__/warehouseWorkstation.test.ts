/**
 * Интеграционные тесты «Рабочий стол кладовщика v2»:
 *  (a) GET /shift — лента дня: выдача CONFIRMED → PENDING, возврат сегодня → PENDING,
 *      просрочка отдельным массивом, счётчики.
 *  (b) GET /shift — после завершения ISSUE-сессии выдача становится DONE,
 *      myShift считает сессию и позиции.
 *  (c) GET /journal — завершённая сессия в ленте с длительностью; scope=me
 *      фильтрует по workerName; perDay содержит 7 дней.
 *  (d) GET /problems — активный Repair и открытый ProblemItem видны; без barcode.
 *  (e) Все три эндпоинта требуют warehouseAuth (401 без токена).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-workstation.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-workstation";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-workstation";
process.env.JWT_SECRET = "test-jwt-secret-workstation-min16";

let app: Express;
let prisma: any;
let warehouseToken: string;
let pinToken: string;
let equipmentId: string;
let unitId: string;

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
  const { hashPin } = await import("../services/warehouseAuth");
  const hash = await hashPassword("test-pass-123");

  const wh = await prisma.adminUser.create({
    data: { username: "ws_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const pinHash = await hashPin("4321");
  await prisma.warehousePin.create({
    data: { name: "Иван Смена", pinHash, isActive: true },
  });
  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .set({ "X-API-Key": "test-key-1" })
    .send({ name: "Иван Смена", pin: "4321" });
  expect(authRes.status).toBe(200);
  pinToken = authRes.body.token;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ WS||GENERIC||LED-WS",
      name: "Панель WS",
      category: "LED",
      totalQuantity: 10,
      rentalRatePerShift: "1000",
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = eq.id;
  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "LR-WS-001", status: "MAINTENANCE" },
  });
  unitId = unit.id;
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

const AUTH_PIN = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${pinToken}` });
const AUTH_WH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` });

/** Московская полночь сегодня + смещение часов — стабильные даты внутри дня. */
function todayAt(hoursUtc: number): Date {
  const d = new Date();
  d.setUTCHours(hoursUtc, 0, 0, 0);
  return d;
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}

async function makeClient(name: string) {
  return prisma.client.create({ data: { name, phone: "+7 900 000-00-00" } });
}

async function makeBooking(args: {
  status: string;
  startDate: Date;
  endDate: Date;
  project: string;
  issuedAt?: Date | null;
}) {
  const client = await makeClient(`Клиент ${args.project}`);
  return prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: args.project,
      startDate: args.startDate,
      endDate: args.endDate,
      status: args.status,
      issuedAt: args.issuedAt ?? null,
      items: { create: [{ equipmentId, quantity: 2 }] },
    },
  });
}

describe("Рабочий стол кладовщика v2", () => {
  it("(e) без warehouse-токена — 401", async () => {
    for (const p of ["/api/warehouse/shift", "/api/warehouse/journal", "/api/warehouse/problems"]) {
      const res = await request(app).get(p).set({ "X-API-Key": "test-key-1" });
      expect(res.status).toBe(401);
    }
  });

  it("(a) /shift: план дня, просрочка, счётчики", async () => {
    // Выдача сегодня (CONFIRMED — ещё не выдана)
    await makeBooking({
      status: "CONFIRMED",
      startDate: todayAt(11),
      endDate: new Date(Date.now() + 3 * 86400000),
      project: "Выдача сегодня",
    });
    // Возврат сегодня (ISSUED — ждём)
    await makeBooking({
      status: "ISSUED",
      startDate: daysAgo(2),
      endDate: todayAt(15),
      project: "Возврат сегодня",
      issuedAt: daysAgo(2),
    });
    // Просрочен (ISSUED, endDate 3 дня назад)
    await makeBooking({
      status: "ISSUED",
      startDate: daysAgo(6),
      endDate: daysAgo(3),
      project: "Просроченный",
      issuedAt: daysAgo(6),
    });

    const res = await request(app).get("/api/warehouse/shift").set(AUTH_PIN());
    expect(res.status).toBe(200);

    const issue = res.body.timeline.find((t: any) => t.projectName === "Выдача сегодня");
    expect(issue).toBeTruthy();
    expect(issue.kind).toBe("ISSUE");
    expect(issue.status).toBe("PENDING");
    expect(issue.itemsCount).toBe(1);
    expect(issue.displayNo).toMatch(/^#[A-Z0-9]{6}$/);

    const ret = res.body.timeline.find((t: any) => t.projectName === "Возврат сегодня");
    expect(ret.kind).toBe("RETURN");
    expect(ret.status).toBe("PENDING");

    expect(res.body.overdue).toHaveLength(1);
    expect(res.body.overdue[0].projectName).toBe("Просроченный");
    expect(res.body.overdue[0].overdueDays).toBeGreaterThanOrEqual(2);

    expect(res.body.counters.issuesPlanned).toBe(1);
    expect(res.body.counters.issuesDone).toBe(0);
    expect(res.body.counters.returnsPlanned).toBe(1);
    expect(res.body.counters.overdue).toBe(1);
    expect(res.body.counters.inWork).toBe(2); // возврат сегодня + просроченный
    expect(res.body.myShift.workerName).toBe("Иван Смена");
    expect(res.body.myShift.sessions).toBe(0);
  });

  it("(b) /shift: завершённая сессия попадает в myShift; выдача → DONE", async () => {
    const b = await makeBooking({
      status: "ISSUED",
      startDate: todayAt(9),
      endDate: new Date(Date.now() + 2 * 86400000),
      project: "Выдано утром",
      issuedAt: todayAt(9),
    });
    await prisma.scanSession.create({
      data: {
        bookingId: b.id,
        workerName: "Иван Смена",
        operation: "ISSUE",
        status: "COMPLETED",
        startedAt: todayAt(9),
        completedAt: new Date(todayAt(9).getTime() + 20 * 60000),
      },
    });

    const res = await request(app).get("/api/warehouse/shift").set(AUTH_PIN());
    expect(res.status).toBe(200);

    const done = res.body.timeline.find((t: any) => t.projectName === "Выдано утром");
    expect(done.status).toBe("DONE");
    expect(done.doneAt).toBeTruthy();

    expect(res.body.myShift.sessions).toBe(1);
    expect(res.body.myShift.items).toBe(1);
    expect(res.body.myShift.avgMinutes).toBe(20);
    expect(res.body.myShift.firstAt).toBeTruthy();
  });

  it("(c) /journal: лента + длительность + scope=me + perDay", async () => {
    // Чужая сессия — не должна попасть в scope=me
    const other = await makeBooking({
      status: "RETURNED",
      startDate: daysAgo(1),
      endDate: daysAgo(1),
      project: "Чужая приёмка",
    });
    await prisma.scanSession.create({
      data: {
        bookingId: other.id,
        workerName: "Пётр Другой",
        operation: "RETURN",
        status: "COMPLETED",
        startedAt: daysAgo(1),
        completedAt: new Date(daysAgo(1).getTime() + 30 * 60000),
      },
    });

    const mine = await request(app)
      .get("/api/warehouse/journal?days=7&scope=me")
      .set(AUTH_PIN());
    expect(mine.status).toBe(200);
    const mineSessions = mine.body.entries.filter((e: any) => e.kind === "SESSION");
    expect(mineSessions.every((e: any) => e.workerName === "Иван Смена")).toBe(true);
    expect(mineSessions.length).toBeGreaterThanOrEqual(1);
    expect(mineSessions[0].durationMinutes).toBe(20);
    expect(mine.body.stats.perDay).toHaveLength(7);

    const all = await request(app)
      .get("/api/warehouse/journal?days=7&scope=all")
      .set(AUTH_PIN());
    const workers = new Set(
      all.body.entries.filter((e: any) => e.kind === "SESSION").map((e: any) => e.workerName),
    );
    expect(workers.has("Пётр Другой")).toBe(true);

    // perDay суммарно содержит все завершённые сессии недели (issue + return)
    const totalOps = all.body.stats.perDay.reduce(
      (s: number, d: any) => s + d.issues + d.returns,
      0,
    );
    expect(totalOps).toBeGreaterThanOrEqual(2);
  });

  it("(d) /problems: ремонт и потеряшка без barcode", async () => {
    await prisma.repair.create({
      data: {
        unitId,
        status: "IN_REPAIR",
        urgency: "NORMAL",
        reason: "не включается драйвер",
        createdBy: "Иван Смена",
      },
    });
    await prisma.problemItem.create({
      data: {
        equipmentUnitId: unitId,
        reason: "LEFT_ON_SITE",
        comment: "оставлен на площадке",
        status: "EXPECTED",
        createdBy: "Иван Смена",
      },
    });

    const res = await request(app).get("/api/warehouse/problems").set(AUTH_PIN());
    expect(res.status).toBe(200);
    expect(res.body.repairs.length).toBeGreaterThanOrEqual(1);
    expect(res.body.repairs[0].equipmentName).toBe("Панель WS");
    expect(res.body.problems.length).toBeGreaterThanOrEqual(1);
    expect(res.body.problems[0].status).toBe("EXPECTED");
    // Конвенция «No Barcodes in UX»: в ответе нет строк вида LR-XXX
    expect(JSON.stringify(res.body)).not.toContain("LR-WS-001");
  });

  it("(e2) JWT-fallback (WAREHOUSE main session) тоже проходит", async () => {
    const res = await request(app).get("/api/warehouse/shift").set(AUTH_WH());
    expect(res.status).toBe(200);
    expect(res.body.myShift.workerName).toBe("ws_wh");
  });
});
