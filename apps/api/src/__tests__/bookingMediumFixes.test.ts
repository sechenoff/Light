/**
 * Интеграционные тесты MEDIUM-фиксов аудита (кластер MA1 — backend броней):
 *
 *  (a) GET /?q= — поиск по клиенту/проекту регистронезависим для кириллицы
 *      («мосфильм» находит «Мосфильм»), пагинация и totalCount не ломаются.
 *  (b) GET / — сортировка «актуальные сверху»: сегодняшние/ближайшие смены
 *      (endDate >= сегодня) по startDate asc, затем прошедшие по startDate desc.
 *  (c) POST /draft — контракт clientPhone: новому клиенту телефон пишется,
 *      существующему без телефона дозаполняется, существующий НЕ перезаписывается.
 *  (d) POST /draft (не-dryRun) — сразу создаёт MAIN Estimate-снапшот со строками;
 *      последующий confirm не падает P2002 и пересоздаёт снапшот.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-medium-fixes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-medium-fixes";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-mmed-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-mmed-min16chars";

let app: Express;
let prisma: any;
let saToken: string;
let clientId: string;
let equipmentId: string;

const AUTH_SA = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${saToken}` });

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY_MS);

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
  prisma = (await import("../prisma")).prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");
  const sa = await prisma.adminUser.create({
    data: { username: "mmed_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const c = await prisma.client.create({ data: { name: "Мосфильм" } });
  clientId = c.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "СВЕТ||МЕДИУМ||GENERIC||MM-1",
      name: "Прожектор Медиум",
      category: "Свет",
      totalQuantity: 10,
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;
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

async function mkBooking(opts: { project: string; start: Date; end: Date; client?: string }) {
  let cid = clientId;
  if (opts.client) {
    const c = await prisma.client.upsert({
      where: { name: opts.client },
      update: {},
      create: { name: opts.client },
    });
    cid = c.id;
  }
  return prisma.booking.create({
    data: {
      clientId: cid,
      projectName: opts.project,
      startDate: opts.start,
      endDate: opts.end,
      status: "CONFIRMED",
      finalAmount: "1000",
    },
  });
}

async function list(qs: string): Promise<{ bookings: any[]; nextCursor: string | null; totalCount: number }> {
  const res = await request(app).get(`/api/bookings?${qs}`).set(AUTH_SA());
  expect(res.status).toBe(200);
  return res.body;
}

// ── (a) Регистронезависимый поиск по кириллице ───────────────────────────────

describe("(a) GET /?q= — кириллица без учёта регистра", () => {
  beforeAll(async () => {
    await mkBooking({ project: "Ночная СЪЁМКА", start: daysFromNow(3), end: daysFromNow(4) });
    await mkBooking({ project: "Другой проект", start: daysFromNow(5), end: daysFromNow(6), client: "Ленфильм Студия" });
  });

  it("«мосфильм» в нижнем регистре находит клиента «Мосфильм»", async () => {
    const body = await list("limit=50&q=мосфильм");
    expect(body.totalCount).toBeGreaterThan(0);
    expect(body.bookings.every((b: any) => b.client.name === "Мосфильм")).toBe(true);
  });

  it("«съёмка» находит проект «Ночная СЪЁМКА»", async () => {
    const body = await list("limit=50&q=съёмка");
    expect(body.bookings.some((b: any) => b.projectName === "Ночная СЪЁМКА")).toBe(true);
  });

  it("«ЛЕНФИЛЬМ» в верхнем регистре находит «Ленфильм Студия»", async () => {
    const body = await list("limit=50&q=ЛЕНФИЛЬМ");
    expect(body.bookings.length).toBe(1);
    expect(body.bookings[0].client.name).toBe("Ленфильм Студия");
  });

  it("мусорный запрос возвращает пусто с totalCount=0", async () => {
    const body = await list("limit=50&q=несуществующийзапрос12345");
    expect(body.bookings).toHaveLength(0);
    expect(body.totalCount).toBe(0);
  });
});

// ── (b) Сортировка «актуальные сверху» ───────────────────────────────────────

describe("(b) GET / — двухсегментная сортировка и пагинация", () => {
  const P = "SORT";
  beforeAll(async () => {
    // Прошлые: далёкая и свежая
    await mkBooking({ project: `${P} прошлое-давнее`, start: daysFromNow(-30), end: daysFromNow(-29) });
    await mkBooking({ project: `${P} прошлое-свежее`, start: daysFromNow(-3), end: daysFromNow(-2) });
    // Актуальные/будущие: активная сейчас, завтра, через месяц
    await mkBooking({ project: `${P} активная`, start: daysFromNow(-1), end: daysFromNow(1) });
    await mkBooking({ project: `${P} завтра`, start: daysFromNow(1), end: daysFromNow(2) });
    await mkBooking({ project: `${P} далёкое-будущее`, start: daysFromNow(30), end: daysFromNow(31) });
  });

  it("актуальные и ближайшие сверху (startDate asc), прошедшие в конце (desc)", async () => {
    const body = await list(`limit=200&q=${encodeURIComponent(P)}`);
    const names = body.bookings.map((b: any) => b.projectName);
    expect(names).toEqual([
      `${P} активная`,
      `${P} завтра`,
      `${P} далёкое-будущее`,
      `${P} прошлое-свежее`,
      `${P} прошлое-давнее`,
    ]);
  });

  it("keyset-пагинация переживает границу сегментов", async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const qs = `limit=2&q=${encodeURIComponent(P)}${cursor ? `&cursor=${cursor}` : ""}`;
      const body = await list(qs);
      collected.push(...body.bookings.map((b: any) => b.projectName));
      cursor = body.nextCursor;
      guard++;
    } while (cursor && guard < 10);

    expect(collected).toEqual([
      `${P} активная`,
      `${P} завтра`,
      `${P} далёкое-будущее`,
      `${P} прошлое-свежее`,
      `${P} прошлое-давнее`,
    ]);
  });
});

// ── (c) Контракт clientPhone на /draft ───────────────────────────────────────

describe("(c) POST /draft — clientPhone: дозаполнение без перезаписи", () => {
  const draftBody = (client: any, extra: Record<string, unknown> = {}) => ({
    client,
    projectName: `Телефонный контракт ${Date.now()}-${Math.random()}`,
    startDate: daysFromNow(10).toISOString(),
    endDate: daysFromNow(11).toISOString(),
    items: [{ equipmentId, quantity: 1 }],
    ...extra,
  });

  it("новый клиент создаётся с телефоном из плоского clientPhone", async () => {
    const name = `Новый Клиент ${Date.now()}`;
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(draftBody({ name }, { clientPhone: "+7-901-111-11-11" }));
    expect(res.status).toBe(200);

    const created = await prisma.client.findUnique({ where: { name } });
    expect(created).not.toBeNull();
    expect(created.phone).toBe("+7-901-111-11-11");
  });

  it("существующему клиенту БЕЗ телефона номер дозаполняется", async () => {
    const name = `Пустой Телефон ${Date.now()}`;
    await prisma.client.create({ data: { name, phone: null } });

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(draftBody({ name, phone: "+7-902-222-22-22" }));
    expect(res.status).toBe(200);

    const fresh = await prisma.client.findUnique({ where: { name } });
    expect(fresh.phone).toBe("+7-902-222-22-22");
  });

  it("существующий телефон НЕ перезаписывается", async () => {
    const name = `Занятый Телефон ${Date.now()}`;
    await prisma.client.create({ data: { name, phone: "+7-903-000-00-00" } });

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(draftBody({ name }, { clientPhone: "+7-999-999-99-99" }));
    expect(res.status).toBe(200);

    const fresh = await prisma.client.findUnique({ where: { name } });
    expect(fresh.phone).toBe("+7-903-000-00-00"); // старый номер сохранён
  });

  it("черновик без телефона не затирает ничего (регрессия)", async () => {
    const name = `Без Телефона ${Date.now()}`;
    await prisma.client.create({ data: { name, phone: "+7-904-444-44-44", email: "a@b.ru" } });

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(draftBody({ name }));
    expect(res.status).toBe(200);

    const fresh = await prisma.client.findUnique({ where: { name } });
    expect(fresh.phone).toBe("+7-904-444-44-44");
    expect(fresh.email).toBe("a@b.ru");
  });
});

// ── (d) MAIN Estimate-снапшот при создании черновика ─────────────────────────

describe("(d) POST /draft — MAIN Estimate создаётся сразу", () => {
  it("не-dryRun черновик имеет MAIN estimate со строками и суммами", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: "Мосфильм" },
        projectName: `Смета сразу ${Date.now()}`,
        startDate: daysFromNow(15).toISOString(),
        endDate: daysFromNow(16).toISOString(), // 1 смена
        discountPercent: 50,
        items: [{ equipmentId, quantity: 2 }], // 2 × 1000 = 2000, после скидки 1000
      });
    expect(res.status).toBe(200);
    const id = res.body.booking.id;

    const saved = await prisma.booking.findUnique({
      where: { id },
      include: { estimates: { include: { lines: true } } },
    });
    expect(saved.status).toBe("DRAFT");
    const main = saved.estimates.find((e: any) => e.kind === "MAIN");
    expect(main).toBeTruthy();
    expect(main.lines).toHaveLength(1);
    expect(Number(main.subtotal)).toBeCloseTo(2000, 2);
    expect(Number(main.totalAfterDiscount)).toBeCloseTo(1000, 2);

    // Ответ /draft тоже несёт снапшот (карточка брони рисует смету сразу)
    expect(res.body.booking.estimates?.length).toBeGreaterThan(0);
  });

  it("dryRun НЕ создаёт ни брони, ни estimate", async () => {
    const before = await prisma.estimate.count();
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: "Мосфильм" },
        projectName: "Превью без записи",
        startDate: daysFromNow(15).toISOString(),
        endDate: daysFromNow(16).toISOString(),
        items: [{ equipmentId, quantity: 1 }],
        dryRun: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBeNull();
    expect(await prisma.estimate.count()).toBe(before);
  });

  it("approve после submit пересоздаёт MAIN без P2002 (delete+create путь)", async () => {
    const draft = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: "Мосфильм" },
        projectName: `Смета confirm ${Date.now()}`,
        startDate: daysFromNow(20).toISOString(),
        endDate: daysFromNow(21).toISOString(),
        items: [{ equipmentId, quantity: 1 }],
      });
    expect(draft.status).toBe(200);
    const id = draft.body.booking.id;

    const submit = await request(app)
      .post(`/api/bookings/${id}/submit-for-approval`)
      .set(AUTH_SA())
      .send({});
    expect(submit.status).toBe(200);

    const approve = await request(app)
      .post(`/api/bookings/${id}/approve`)
      .set(AUTH_SA())
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.booking.status).toBe("CONFIRMED");

    const saved = await prisma.booking.findUnique({
      where: { id },
      include: { estimates: { include: { lines: true } } },
    });
    // Ровно один MAIN (пересоздан, не задублирован)
    const mains = saved.estimates.filter((e: any) => e.kind === "MAIN");
    expect(mains).toHaveLength(1);
    expect(mains[0].lines.length).toBeGreaterThan(0);
  });
});
