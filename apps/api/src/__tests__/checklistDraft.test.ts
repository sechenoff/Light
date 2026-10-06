/**
 * Черновик чек-листа на сервере (P6): `PUT /api/warehouse/sessions/:id/draft`
 * и его отражение в `/state`.
 *
 * Раньше степпер, отметки и исходы приёмки жили в памяти планшета: смена
 * раздела, перезагрузка или второй планшет — и работа на 60+ строк пропадала,
 * а выдавался план, а не погруженное. Теперь черновик хранится в сессии,
 * ревизия не даёт двум устройствам молча затереть друг друга.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-checklist-draft.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-cl-draft";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-cl-draft";
process.env.WAREHOUSE_SECRET = "test-warehouse-cl-draft-16chars";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-cl-draft-min16chars000";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

let app: any;
let prisma: any;
let pinToken: string;
let pin2Token: string;
let clientId: string;
let eqId: string;
let seq = 0;

const H = (token: string) => ({ "X-API-Key": "test-key-cl-draft", Authorization: `Bearer ${token}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPin, generateToken } = await import("../services/warehouseAuth");
  await prisma.warehousePin.create({ data: { name: "Планшет у ворот", pinHash: await hashPin("135790"), isActive: true } });
  await prisma.warehousePin.create({ data: { name: "Планшет в зале", pinHash: await hashPin("975310"), isActive: true } });
  pinToken = generateToken("Планшет у ворот");
  pin2Token = generateToken("Планшет в зале");
  clientId = (await prisma.client.create({ data: { name: "Клиент черновика" } })).id;
  eqId = (
    await prisma.equipment.create({
      data: { importKey: "cl-draft-eq", name: "Мешок с песком", category: "Грип", rentalRatePerShift: "100", stockTrackingMode: "COUNT", totalQuantity: 50 },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(TEST_DB_PATH + s); } catch { /* ignore */ }
  }
});

async function issueSession(extraBooking: Record<string, unknown> = {}, extraSession: Record<string, unknown> = {}) {
  seq += 1;
  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Черновик ${seq}`,
      startDate: new Date(NOW + HOUR),
      endDate: new Date(NOW + DAY),
      status: "CONFIRMED",
      items: { create: [{ equipmentId: eqId, quantity: 10 }] },
      ...extraBooking,
    },
    include: { items: true },
  });
  const session = await prisma.scanSession.create({
    data: { bookingId: booking.id, workerName: "Планшет у ворот", operation: "ISSUE", status: "ACTIVE", ...extraSession },
  });
  return { bookingId: booking.id as string, bookingItemId: booking.items[0].id as string, sessionId: session.id as string };
}

const putDraft = (sessionId: string, body: unknown, token = pinToken) =>
  request(app).put(`/api/warehouse/sessions/${sessionId}/draft`).set(H(token)).send(body as object);

const issueDraft = (bookingItemId: string, qty: number, checked = true) => ({
  v: 1,
  issue: { rows: { [bookingItemId]: { qty, checked, equipmentId: eqId } } },
});

describe("сохранение и восстановление", () => {
  it("первое сохранение от ревизии 0; /state отдаёт черновик, ревизию, время и автора", async () => {
    const { bookingItemId, sessionId } = await issueSession();
    const saved = await putDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 8) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.revision).toBe(1);
    expect(Number.isNaN(Date.parse(saved.body.savedAt))).toBe(false);

    const st = await request(app).get(`/api/warehouse/sessions/${sessionId}/state`).set(H(pinToken));
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({
      draft: issueDraft(bookingItemId, 8),
      draftRevision: 1,
      draftSavedAt: saved.body.savedAt,
      draftSavedBy: "Планшет у ворот",
    });
  });

  it("второй планшет со старой ревизией получает 409 DRAFT_OUTDATED со свежим черновиком и ничего не затирает", async () => {
    const { bookingItemId, sessionId } = await issueSession();
    expect((await putDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 7) })).status).toBe(200);

    const stale = await putDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 3) }, pin2Token);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("DRAFT_OUTDATED");
    expect(stale.body.message).toBe("Чек-лист изменили на другом устройстве — загружена свежая версия");
    expect(stale.body.details).toMatchObject({
      revision: 1,
      draft: issueDraft(bookingItemId, 7),
      savedBy: "Планшет у ворот",
    });

    // Второй планшет применил свежую версию и сохраняет от неё.
    const next = await putDraft(sessionId, { revision: 1, draft: issueDraft(bookingItemId, 6) }, pin2Token);
    expect(next.body.revision).toBe(2);
    const row = await prisma.scanSession.findUnique({ where: { id: sessionId } });
    expect(JSON.parse(row.draftJson).issue.rows[bookingItemId].qty).toBe(6);
    expect(row.draftSavedBy).toBe("Планшет в зале");
  });

  it("два одновременных сохранения от одной ревизии: проходит ровно одно", async () => {
    const { bookingItemId, sessionId } = await issueSession();
    const { saveChecklistDraft } = await import("../services/checklistService");
    const results = await Promise.allSettled([
      saveChecklistDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 1) }, "А"),
      saveChecklistDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 2) }, "Б"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: "DRAFT_OUTDATED" });
    expect((await prisma.scanSession.findUnique({ where: { id: sessionId } })).draftRevision).toBe(1);
  });

  it("черновик приёмки: исходы единиц, сетки по количеству и пробег переживают перезагрузку", async () => {
    const { bookingItemId, sessionId } = await issueSession();
    const draft = {
      v: 1,
      return: {
        units: { "unit-1": { outcome: "REPAIR", repairComment: "не включается" } },
        grids: {
          [bookingItemId]: {
            equipmentId: eqId,
            slots: [
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "PROBLEM", repairComment: "", problem: { reason: "LEFT_ON_SITE", comment: "на площадке", expectedBackDate: new Date(NOW + 3 * DAY).toISOString().slice(0, 10) } },
            ],
          },
        },
        mileages: { "vehicle-1": 120450, "vehicle-2": null },
        // «Остаётся у клиента» (этап 15): иначе перезагрузка вернула бы строку целиком.
        stays: {
          [bookingItemId]: { quantity: 1, unitIds: [], until: new Date(NOW + DAY).toISOString(), choice: 1, acknowledged: true },
        },
      },
    };
    expect((await putDraft(sessionId, { revision: 0, draft })).status).toBe(200);
    const st = await request(app).get(`/api/warehouse/sessions/${sessionId}/state`).set(H(pinToken));
    expect(st.body.draft).toEqual(draft);

    // Показание, которое примет «Готово» (любое целое ≥ 0), не должно срывать
    // сохранение всего черновика приёмки.
    const bigMileage = { ...draft, return: { ...draft.return, mileages: { "vehicle-1": 1_204_500_000 } } };
    const saved = await putDraft(sessionId, { revision: 1, draft: bigMileage });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });

  it("лишние поля отбрасываются, повреждённый черновик в базе читается как «черновика нет»", async () => {
    const { bookingItemId, sessionId } = await issueSession();
    const withJunk = { ...issueDraft(bookingItemId, 4), extra: "мусор", issue: { rows: { [bookingItemId]: { qty: 4, checked: false, equipmentId: null, junk: 1 } } } };
    expect((await putDraft(sessionId, { revision: 0, draft: withJunk })).status).toBe(200);
    const row = await prisma.scanSession.findUnique({ where: { id: sessionId } });
    expect(JSON.parse(row.draftJson)).toEqual({ v: 1, issue: { rows: { [bookingItemId]: { qty: 4, checked: false, equipmentId: null } } } });

    await prisma.scanSession.update({ where: { id: sessionId }, data: { draftJson: "{не json" } });
    const st = await request(app).get(`/api/warehouse/sessions/${sessionId}/state`).set(H(pinToken));
    expect(st.status).toBe(200);
    expect(st.body.draft).toBeNull();
    expect(st.body.draftRevision).toBe(1);
  });
});

describe("проверки черновика", () => {
  it("больше 256 КБ — 413 DRAFT_TOO_LARGE, в базе ничего не меняется", async () => {
    const { bookingItemId, sessionId } = await issueSession();
    const big = {
      v: 1,
      return: {
        units: Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [`u${i}`, { outcome: "REPAIR", repairComment: "ж".repeat(1500) }]),
        ),
        grids: {},
      },
    };
    const res = await putDraft(sessionId, { revision: 0, draft: big });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("DRAFT_TOO_LARGE");
    expect(res.body.message).toBe("Черновик слишком большой");
    expect((await prisma.scanSession.findUnique({ where: { id: sessionId } })).draftJson).toBeNull();
    expect(bookingItemId).toBeTruthy();
  });

  it("больше 500 ключей — 413 DRAFT_TOO_LARGE", async () => {
    const { sessionId } = await issueSession();
    const rows = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`bi${i}`, { qty: 1, checked: false, equipmentId: null }]));
    const res = await putDraft(sessionId, { revision: 0, draft: { v: 1, issue: { rows } } });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("DRAFT_TOO_LARGE");
  });

  it("неверная форма — 400: чужая версия, отрицательное количество, строка длиннее 2000", async () => {
    const { bookingItemId, sessionId } = await issueSession();
    for (const draft of [
      { v: 2 },
      issueDraft(bookingItemId, -1),
      { v: 1, return: { units: { u: { outcome: "REPAIR", repairComment: "x".repeat(2001) } }, grids: {} } },
      { v: 1, return: { units: { u: { outcome: "УКРАЛИ" } }, grids: {} } },
    ]) {
      const res = await putDraft(sessionId, { revision: 0, draft });
      expect(res.status, JSON.stringify(draft).slice(0, 80)).toBe(400);
    }
    expect((await putDraft(sessionId, { draft: issueDraft(bookingItemId, 1) })).status).toBe(400); // нет ревизии
  });
});

describe("черновик только в живую сессию", () => {
  it("завершённая сессия — 409 SESSION_ALREADY_COMPLETED (keepalive после «Готово»)", async () => {
    const { bookingItemId, sessionId } = await issueSession({}, { status: "COMPLETED", completedAt: new Date(), completedBy: "Планшет в зале" });
    const res = await putDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 1) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_ALREADY_COMPLETED");
    expect(res.body.details).toMatchObject({ operation: "ISSUE", completedBy: "Планшет в зале" });
  });

  it("бронь выдали кнопкой — 409 SESSION_STALE, сессия закрыта, черновик не записан", async () => {
    const { bookingItemId, sessionId } = await issueSession({ status: "ISSUED", issuedAt: new Date() });
    const res = await putDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 1) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_STALE");
    const row = await prisma.scanSession.findUnique({ where: { id: sessionId } });
    expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "STALE", draftJson: null });
  });

  it("прерванная сессия — 409 SESSION_CANCELLED", async () => {
    const { bookingItemId, sessionId } = await issueSession({}, { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "KIOSK_ABORT" });
    const res = await putDraft(sessionId, { revision: 0, draft: issueDraft(bookingItemId, 1) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_CANCELLED");
  });
});
