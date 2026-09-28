/**
 * «+ Добор» со страницы брони: окно проверки склада и правила конфликта.
 *
 * До исправления:
 *  - просроченная выданная бронь проверялась на СВОИ ПРОШЕДШИЕ даты — добор
 *    проходил «свободно», хотя сегодня весь прибор у другой брони (P10);
 *  - «под ответственность» работало только когда чужая бронь держала ВЕСЬ
 *    склад: склад 4, чужая 3, наша 1 → «нет на складе» и 409 даже с
 *    подтверждением (P4);
 *  - поиск считал пик, а отправка — сумму броней: поиск «свободно ×1», отправка
 *    «занято другой бронью» (P4).
 *
 * Теперь окно — `addonWindow`: у выданной брони [сейчас, конец), у
 * подтверждённой — даты брони; потолок и конфликт — одна формула
 * (`computeAddCaps` / `findAddonConflict` с запрошенным количеством).
 */
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-booking-addon-window.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-baw";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-baw";
process.env.WAREHOUSE_SECRET = "test-warehouse-baw-16chars";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-baw-min16chars";

let app: any;
let prisma: any;
let whToken: string;
let clientId: string;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const H = (token: string) => ({ "X-API-Key": "test-key-baw", Authorization: `Bearer ${token}` });

let seq = 0;
async function mkEq(name: string, total: number, mode: "COUNT" | "UNIT" = "COUNT") {
  seq += 1;
  const eq = await prisma.equipment.create({
    data: { importKey: `baw-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: mode, totalQuantity: total },
  });
  if (mode === "UNIT") {
    for (let i = 1; i <= total; i++) {
      await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "AVAILABLE", internalInventoryNumber: `BAW-${seq}-${i}` } });
    }
  }
  return eq.id as string;
}

async function mkBooking(opts: {
  status: "CONFIRMED" | "ISSUED";
  start: Date;
  end: Date;
  items: Array<{ equipmentId: string; quantity: number }>;
  project: string;
}) {
  const total = opts.items.reduce((s, i) => s + i.quantity * 1000, 0);
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: opts.project,
      startDate: opts.start,
      endDate: opts.end,
      status: opts.status,
      issuedAt: opts.status === "ISSUED" ? opts.start : null,
      confirmedAt: new Date(),
      totalEstimateAmount: String(total),
      discountAmount: "0",
      finalAmount: String(total),
      amountOutstanding: String(total),
      legacyFinance: false,
      items: { create: opts.items.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 1,
          subtotal: String(total),
          discountAmount: "0",
          totalAfterDiscount: String(total),
          lines: {
            create: opts.items.map((i) => ({
              equipmentId: i.equipmentId,
              categorySnapshot: "Свет",
              nameSnapshot: "Позиция",
              quantity: i.quantity,
              unitPrice: "1000",
              lineSum: String(i.quantity * 1000),
            })),
          },
        },
      },
    },
  });
  return b.id as string;
}

const search = async (bookingId: string, q: string, equipmentId: string) => {
  const res = await request(app).get(`/api/bookings/${bookingId}/addon-search`).query({ q }).set(H(whToken));
  expect(res.status).toBe(200);
  return res.body.results.find((r: any) => r.equipmentId === equipmentId);
};
const addon = (bookingId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/bookings/${bookingId}/addon-items`).set(H(whToken)).send({ mode: "ADDON", ...body });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("baw-pass-123456");
  const wh = await prisma.adminUser.create({ data: { username: "baw_wh", passwordHash: hash, role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  clientId = (await prisma.client.create({ data: { name: "Клиент окна", phone: "+70000004444" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("P10: добор в просроченную выданную бронь проверяется на СЕЙЧАС", () => {
  it("X просрочена, Y сегодня держит весь прибор: поиск — «занято», отправка — ADDON_CONFLICT, под ответственность — можно", async () => {
    const eq = await mkEq("Окно прибор", 2);
    const filler = await mkEq("Окно заполнитель", 5);
    const x = await mkBooking({
      status: "ISSUED",
      start: new Date(Date.now() - 4 * DAY),
      end: new Date(Date.now() - 3 * DAY),
      items: [{ equipmentId: filler, quantity: 1 }],
      project: "X просрочена",
    });
    const y = await mkBooking({
      status: "CONFIRMED",
      start: new Date(Date.now() - HOUR),
      end: new Date(Date.now() + DAY),
      items: [{ equipmentId: eq, quantity: 2 }],
      project: "Y сегодня",
    });

    const row = await search(x, "Окно прибор", eq);
    expect(row.addCap).toBe(0);
    expect(row.ackCap).toBe(2);
    expect(row.availability).toBe("UNAVAILABLE");
    expect(row.conflict).toMatchObject({ bookingId: y, projectName: "Y сегодня", holderStatus: "CONFIRMED", clientName: "Клиент окна" });

    const plain = await addon(x, { items: [{ equipmentId: eq, quantity: 2 }] });
    expect(plain.status).toBe(409);
    expect(plain.body.code).toBe("ADDON_CONFLICT");
    expect(plain.body.details.bookingId).toBe(y);

    const ack = await addon(x, { items: [{ equipmentId: eq, quantity: 2 }], acknowledgedConflict: true });
    expect(ack.status, JSON.stringify(ack.body)).toBe(201);
    expect(ack.body.added[0].hadConflict).toBe(true);
  });

  it("подтверждённая бронь на будущее проверяется на свои даты, а не на «сейчас»", async () => {
    const eq = await mkEq("Будущее прибор", 1);
    const filler = await mkEq("Будущее заполнитель", 5);
    // Сегодня прибор у другой брони, но наша начинается через неделю — добор свободен.
    await mkBooking({
      status: "ISSUED",
      start: new Date(Date.now() - HOUR),
      end: new Date(Date.now() + DAY),
      items: [{ equipmentId: eq, quantity: 1 }],
      project: "Сегодня у клиента",
    });
    const future = await mkBooking({
      status: "CONFIRMED",
      start: new Date(Date.now() + 7 * DAY),
      end: new Date(Date.now() + 8 * DAY),
      items: [{ equipmentId: filler, quantity: 1 }],
      project: "Через неделю",
    });
    const row = await search(future, "Будущее прибор", eq);
    expect(row.addCap).toBe(1);
    expect(row.conflict).toBeNull();
    const add = await addon(future, { items: [{ equipmentId: eq, quantity: 1 }] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.added[0].hadConflict).toBe(false);
  });

  it("киоск (issuingNow) проверяет подтверждённую бронь на «сейчас»", async () => {
    const { searchAddonCandidates } = await import("../services/bookingAddon");
    const eq = await mkEq("Киоск сейчас прибор", 1);
    const filler = await mkEq("Киоск сейчас заполнитель", 5);
    await mkBooking({
      status: "ISSUED",
      start: new Date(Date.now() - HOUR),
      end: new Date(Date.now() + DAY),
      items: [{ equipmentId: eq, quantity: 1 }],
      project: "Держит сейчас",
    });
    const early = await mkBooking({
      status: "CONFIRMED",
      start: new Date(Date.now() + 5 * DAY),
      end: new Date(Date.now() + 6 * DAY),
      items: [{ equipmentId: filler, quantity: 1 }],
      project: "Выдают заранее",
    });
    const plan = (await searchAddonCandidates({ bookingId: early, q: "Киоск сейчас прибор" })).find((r) => r.equipmentId === eq)!;
    expect(plan.addCap).toBe(1);
    const now = (await searchAddonCandidates({ bookingId: early, q: "Киоск сейчас прибор", issuingNow: true })).find((r) => r.equipmentId === eq)!;
    expect(now.addCap).toBe(0);
    expect(now.conflict?.projectName).toBe("Держит сейчас");
  });
});

describe("P4: одна формула конфликта в поиске и на отправке", () => {
  it("склад 4, чужая 3, наша 1: без подтверждения — конфликт, под ответственность — можно добрать", async () => {
    const eq = await mkEq("Штатив ответственность", 4);
    const start = new Date(Date.now() - HOUR);
    const end = new Date(Date.now() + DAY);
    const mine = await mkBooking({ status: "ISSUED", start, end, items: [{ equipmentId: eq, quantity: 1 }], project: "Наша" });
    const other = await mkBooking({ status: "CONFIRMED", start, end, items: [{ equipmentId: eq, quantity: 3 }], project: "Чужая" });

    const row = await search(mine, "Штатив ответственность", eq);
    expect(row.addCap).toBe(0);
    expect(row.ackCap).toBe(3);
    expect(row.alreadyInBooking).toBe(1);
    expect(row.conflict).toMatchObject({ bookingId: other, freeForUs: 0, ackCap: 3 });

    const plain = await addon(mine, { items: [{ equipmentId: eq, quantity: 1 }] });
    expect(plain.status).toBe(409);
    expect(plain.body.code).toBe("ADDON_CONFLICT");

    const ack = await addon(mine, { items: [{ equipmentId: eq, quantity: 1 }], acknowledgedConflict: true });
    expect(ack.status, JSON.stringify(ack.body)).toBe(201);
  });

  it("склад 4, чужая 3, наша 0: просим 2 под ответственность — можно; просим 5 — «можно ещё 4»", async () => {
    const eq = await mkEq("Прибор два под ответственность", 4);
    const filler = await mkEq("Прибор два заполнитель", 5);
    const start = new Date(Date.now() - HOUR);
    const end = new Date(Date.now() + DAY);
    const mine = await mkBooking({ status: "ISSUED", start, end, items: [{ equipmentId: filler, quantity: 1 }], project: "Наша 2" });
    await mkBooking({ status: "CONFIRMED", start, end, items: [{ equipmentId: eq, quantity: 3 }], project: "Чужая 2" });

    const tooMany = await addon(mine, { items: [{ equipmentId: eq, quantity: 5 }], acknowledgedConflict: true });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe("ADDON_OVER_STOCK");
    expect(tooMany.body.details).toMatchObject({ equipmentId: eq, addCap: 4, requested: 5 });
    expect(tooMany.body.message).toMatch(/можно добрать ещё 4/);

    const ok = await addon(mine, { items: [{ equipmentId: eq, quantity: 2 }], acknowledgedConflict: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("пик чужой занятости 2 из 3 (брони в разные дни): поиск «свободно ×1», отправка 1 — без конфликта", async () => {
    const eq = await mkEq("Пик прибор", 3);
    const filler = await mkEq("Пик заполнитель", 5);
    const start = new Date(Date.now() - HOUR);
    const mine = await mkBooking({ status: "ISSUED", start, end: new Date(start.getTime() + 3 * DAY), items: [{ equipmentId: filler, quantity: 1 }], project: "Наша пик" });
    await mkBooking({ status: "CONFIRMED", start: new Date(start.getTime() + 2 * HOUR), end: new Date(start.getTime() + 10 * HOUR), items: [{ equipmentId: eq, quantity: 2 }], project: "Утро" });
    await mkBooking({ status: "CONFIRMED", start: new Date(start.getTime() + 2 * DAY), end: new Date(start.getTime() + 2 * DAY + 10 * HOUR), items: [{ equipmentId: eq, quantity: 2 }], project: "Послезавтра" });

    const row = await search(mine, "Пик прибор", eq);
    expect(row.availability).toBe("AVAILABLE");
    expect(row.addCap).toBe(1);
    expect(row.conflict).toBeNull();

    const add = await addon(mine, { items: [{ equipmentId: eq, quantity: 1 }] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.added[0].hadConflict).toBe(false);
    const rec = await prisma.addonRecord.findFirst({ where: { bookingId: mine, equipmentId: eq } });
    expect(rec.acknowledgedConflict).toBe(false);

    // Вторая штука уже не помещается: пик 2 + наша 1 = весь склад.
    const second = await addon(mine, { items: [{ equipmentId: eq, quantity: 1 }] });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("ADDON_CONFLICT");
  });

  it("мастерская не «подвигается»: склад 2, одна в ремонте, другая у чужой брони — под ответственность только 1", async () => {
    const eq = await mkEq("Ремонт прибор", 2);
    const filler = await mkEq("Ремонт заполнитель", 5);
    const start = new Date(Date.now() - HOUR);
    const end = new Date(Date.now() + DAY);
    const mine = await mkBooking({ status: "ISSUED", start, end, items: [{ equipmentId: filler, quantity: 1 }], project: "Наша ремонт" });
    await mkBooking({ status: "CONFIRMED", start, end, items: [{ equipmentId: eq, quantity: 1 }], project: "Чужая ремонт" });
    await prisma.repair.create({ data: { equipmentId: eq, reason: "Не включается", createdBy: "тест", status: "WAITING_REPAIR" } });

    const row = await search(mine, "Ремонт прибор", eq);
    expect(row.addCap).toBe(0);
    expect(row.ackCap).toBe(1);
    const two = await addon(mine, { items: [{ equipmentId: eq, quantity: 2 }], acknowledgedConflict: true });
    expect(two.status).toBe(409);
    expect(two.body.code).toBe("ADDON_OVER_STOCK");
    const one = await addon(mine, { items: [{ equipmentId: eq, quantity: 1 }], acknowledgedConflict: true });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
  });
});

describe("штучный учёт: резерв экземпляров на окно добора", () => {
  it("выданная бронь: экземпляры резервируются и сразу уходят в ISSUED", async () => {
    const eq = await mkEq("Штучный окно", 2, "UNIT");
    const filler = await mkEq("Штучный заполнитель", 5);
    const mine = await mkBooking({
      status: "ISSUED",
      start: new Date(Date.now() - 3 * DAY),
      end: new Date(Date.now() - DAY),
      items: [{ equipmentId: filler, quantity: 1 }],
      project: "Штучный просрочена",
    });
    const add = await addon(mine, { items: [{ equipmentId: eq, quantity: 1 }] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.added[0]).toMatchObject({ unitsReserved: 1, unitsIssued: 1 });
    const units = async () => (await prisma.equipmentUnit.findMany({ where: { equipmentId: eq } })).map((u: any) => u.status).sort();
    expect(await units()).toEqual(["AVAILABLE", "ISSUED"]);

    // Ручная «Вернуть» освобождает довезённый экземпляр — основной путь прода.
    const ret = await request(app).post(`/api/bookings/${mine}/status`).set(H(whToken)).send({ action: "return" });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    expect(await units()).toEqual(["AVAILABLE", "AVAILABLE"]);
  });
});
