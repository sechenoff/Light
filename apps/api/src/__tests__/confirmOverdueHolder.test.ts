/**
 * Подтверждение брони: кто держит прибор, штучный резерв по-русски, повтор
 * создания брони при таймауте транзакции.
 *
 *  - P9: подтверждение упиралось в непринятый возврат другой брони, а текст
 *    называл только цифры «нужно 1, свободно 0 из 1» — непонятно, где прибор.
 *    Теперь держатель назван: «…числится у клиента по брони «X» — возврат не
 *    отмечен с ДД.ММ; если техника на складе, отметьте возврат».
 *  - P21: при нехватке экземпляров на резерве — «Not enough free units during
 *    reservation.» без кода. Теперь 409 NOT_ENOUGH_UNITS по-русски.
 *  - P23: создание брони падало P2028 (таймаут транзакции) при конкурентной
 *    записи в SQLite (лог 28.09 00:30:45). Теперь один повтор.
 */
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-confirm-overdue-holder.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-coh";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-coh";
process.env.WAREHOUSE_SECRET = "test-warehouse-coh-16chars";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-coh-min16chars";

let app: any;
let prisma: any;
let saToken: string;
let clientId: string;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const H = (token: string) => ({ "X-API-Key": "test-key-coh", Authorization: `Bearer ${token}` });

let seq = 0;
async function mkEq(name: string, total: number, mode: "COUNT" | "UNIT" = "COUNT") {
  seq += 1;
  return (
    await prisma.equipment.create({
      data: { importKey: `coh-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: mode, totalQuantity: total },
    })
  ).id as string;
}

async function mkBooking(opts: {
  status: "PENDING_APPROVAL" | "ISSUED";
  start: Date;
  end: Date;
  items: Array<{ equipmentId: string; quantity: number; units?: string[] }>;
  project: string;
}) {
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: opts.project,
      startDate: opts.start,
      endDate: opts.end,
      status: opts.status,
      issuedAt: opts.status === "ISSUED" ? opts.start : null,
      finalAmount: "1000",
      legacyFinance: false,
      items: {
        create: opts.items.map((i) => ({
          equipmentId: i.equipmentId,
          quantity: i.quantity,
          ...(i.units ? { unitReservations: { create: i.units.map((u) => ({ equipmentUnitId: u })) } } : {}),
        })),
      },
    },
  });
  return b.id as string;
}

const approve = (id: string) => request(app).post(`/api/bookings/${id}/approve`).set(H(saToken)).send({});

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("coh-pass-123456");
  const sa = await prisma.adminUser.create({ data: { username: "coh_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Клиент подтверждения", phone: "+70000004646" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("P9: подтверждение называет держателя, если возврат не отмечен", () => {
  it("прибор числится у просроченной выданной брони — текст подсказывает отметить возврат", async () => {
    const eq = await mkEq("Скайпанель держатель", 1);
    const holderEnd = new Date(Date.now() - DAY);
    await mkBooking({
      status: "ISSUED",
      start: new Date(Date.now() - 5 * DAY),
      end: holderEnd,
      items: [{ equipmentId: eq, quantity: 1 }],
      project: "Сериал Дора",
    });
    // Наша бронь уже началась (подтверждают задним числом): пересекается со
    // сроком держателя при любом правиле хвоста выданной брони.
    const mine = await mkBooking({
      status: "PENDING_APPROVAL",
      start: new Date(Date.now() - 2 * DAY),
      end: new Date(Date.now() + DAY),
      items: [{ equipmentId: eq, quantity: 1 }],
      project: "Новая съёмка",
    });

    const res = await approve(mine);
    expect(res.status).toBe(409);
    const { toMoscowDateString } = await import("../utils/moscowDate");
    const [, m, d] = toMoscowDateString(holderEnd).split("-");
    expect(res.body.message).toContain("Не хватает оборудования на выбранные даты");
    expect(res.body.message).toContain("«Скайпанель держатель» числится у клиента по брони «Сериал Дора»");
    expect(res.body.message).toContain(`возврат не отмечен с ${d}.${m}; если техника на складе, отметьте возврат`);
    const conflict = res.body.details.conflicts.find((c: any) => c.equipmentId === eq);
    expect(conflict.holder).toMatchObject({ projectName: "Сериал Дора", holderStatus: "ISSUED", overdue: true });
    expect((await prisma.booking.findUnique({ where: { id: mine } })).status).toBe("PENDING_APPROVAL");
  });

  it("обычный держатель (подтверждённая бронь) — прежний текст без подсказки про возврат", async () => {
    const eq = await mkEq("Штатив занят", 1);
    const start = new Date(Date.now() + 3 * DAY);
    const end = new Date(start.getTime() + DAY);
    const other = await mkBooking({ status: "PENDING_APPROVAL", start, end, items: [{ equipmentId: eq, quantity: 1 }], project: "Первая" });
    expect((await approve(other)).status).toBe(200);
    const mine = await mkBooking({ status: "PENDING_APPROVAL", start, end, items: [{ equipmentId: eq, quantity: 1 }], project: "Вторая" });
    const res = await approve(mine);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Штатив занят: нужно 1, свободно 0 из 1");
    expect(res.body.message).not.toContain("отметьте возврат");
  });
});

describe("P21: нехватка экземпляров при резерве — по-русски и с кодом", () => {
  it("экземпляр застрял «Выдан» у старой брони с чужими датами → 409 NOT_ENOUGH_UNITS", async () => {
    const eq = await mkEq("Штучный застрял", 1, "UNIT");
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq, status: "ISSUED", internalInventoryNumber: "COH-U-1" } });
    await mkBooking({
      status: "ISSUED",
      start: new Date(Date.now() - 20 * DAY),
      end: new Date(Date.now() - 18 * DAY),
      items: [{ equipmentId: eq, quantity: 1, units: [unit.id] }],
      project: "Старая выдача",
    });
    const start = new Date(Date.now() + 10 * DAY);
    const mine = await mkBooking({ status: "PENDING_APPROVAL", start, end: new Date(start.getTime() + DAY), items: [{ equipmentId: eq, quantity: 1 }], project: "Хотим штучный" });

    const res = await approve(mine);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_ENOUGH_UNITS");
    expect(res.body.message).toMatch(/Штучный застрял.*свободных экземпляров 0, нужно 1/);
    expect(res.body.details).toMatchObject({ equipmentId: eq, available: 0, requested: 1 });
  });
});

describe("P23: повтор транзакции создания при таймауте (P2028)", () => {
  it("один повтор после P2028, второй таймаут — наружу; прочие ошибки не повторяются", async () => {
    const { Prisma } = await import("@prisma/client");
    const { withTxTimeoutRetry } = await import("../services/bookings");
    const timeout = () => new Prisma.PrismaClientKnownRequestError("Transaction API error: expired", { code: "P2028", clientVersion: "test" });

    let calls = 0;
    const ok = await withTxTimeoutRetry(async () => {
      calls += 1;
      if (calls === 1) throw timeout();
      return "создано";
    });
    expect(ok).toBe("создано");
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      withTxTimeoutRetry(async () => {
        calls += 1;
        throw timeout();
      }),
    ).rejects.toMatchObject({ code: "P2028" });
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      withTxTimeoutRetry(async () => {
        calls += 1;
        throw new Error("другая ошибка");
      }),
    ).rejects.toThrow("другая ошибка");
    expect(calls).toBe(1);
  });

  it("создание черновика по-прежнему работает (транзакция с увеличенным таймаутом)", async () => {
    const eq = await mkEq("Черновик прибор", 5);
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(H(saToken))
      .send({
        client: { name: "Клиент подтверждения" },
        projectName: "Черновик после таймаута",
        startDate: new Date(Date.now() + DAY).toISOString(),
        endDate: new Date(Date.now() + 2 * DAY).toISOString(),
        items: [{ equipmentId: eq, quantity: 1 }],
      });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  });
});
