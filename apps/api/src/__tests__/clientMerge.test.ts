/**
 * Клиенты-дубли: один и тот же человек заведён несколько раз под разным
 * написанием («Петя Куб», «петя куб», «Пётр Куб»).
 *
 *  - поиск находит клиента без учёта регистра и «ё/е»;
 *  - новое написание того же имени не заводит вторую карточку;
 *  - «Похожие имена» подсказывают дубль;
 *  - объединение переносит в одну карточку брони, счета на оплату,
 *    кредит-ноты, задачи и доступ в кабинет, а дубль удаляет.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-client-merge.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-cmerge";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-client-merge";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-cmerge";
process.env.JWT_SECRET = "test-jwt-client-merge-16chars";
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-lk-session-client-merge";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-lk-token-client-merge";

const DAY = 24 * 3_600_000;

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let saId: string;
let equipmentId: string;
let seq = 0;

const AUTH = () => ({ "X-API-Key": "test-key-cmerge", Authorization: `Bearer ${saToken}` });
const AUTH_WH = () => ({ "X-API-Key": "test-key-cmerge", Authorization: `Bearer ${whToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-cmerge", passwordHash: "x", role: "SUPER_ADMIN" } });
  saId = sa.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({ data: { username: "wh-cmerge", passwordHash: "x", role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  equipmentId = (
    await prisma.equipment.create({
      data: { importKey: "cmerge-lamp", name: "Aputure 600d", category: "Свет", totalQuantity: 50, rentalRatePerShift: 1000, stockTrackingMode: "COUNT" },
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

/**
 * Уникальная фамилия на тест: «Тест» + две буквы + «ов». Длина кода
 * постоянная — одна фамилия не бывает подстрокой другой, и поиск одного теста
 * не цепляет клиентов соседних.
 */
function surname(): string {
  seq += 1;
  const letter = (n: number) => String.fromCharCode(0x430 + (n % 32));
  return `Тест${letter(seq)}${letter(Math.floor(seq / 32))}ов`;
}

const mkClient = (name: string, extra: Record<string, unknown> = {}) => prisma.client.create({ data: { name, ...extra } });

const mkBooking = (clientId: string, extra: Record<string, unknown> = {}) =>
  prisma.booking.create({
    data: {
      clientId,
      projectName: `Съёмка ${++seq}`,
      status: "CONFIRMED",
      startDate: new Date(Date.now() + 10 * DAY),
      endDate: new Date(Date.now() + 11 * DAY),
      ...extra,
    },
  });

const merge = (sourceId: string, intoClientId: string, auth = AUTH()) =>
  request(app).post(`/api/clients/${sourceId}/merge`).set(auth).send({ intoClientId });

const names = (res: any): string[] => res.body.clients.map((c: any) => c.name);

describe("поиск клиентов", () => {
  it("без учёта регистра и «ё/е»: «петя» находит «Петя …», «петр» — «Пётр …»", async () => {
    const s = surname();
    await mkClient(`Петя ${s}`);
    await mkClient(`Пётр ${s}`);
    await mkClient(`Анна Смирнова ${s}`);
    const lower = await request(app).get(`/api/clients?search=${encodeURIComponent("петя")}`).set(AUTH());
    expect(lower.status).toBe(200);
    expect(names(lower)).toContain(`Петя ${s}`);
    const yo = await request(app).get(`/api/clients?search=${encodeURIComponent("ПЕТР " + s.toUpperCase())}`).set(AUTH());
    expect(names(yo)).toEqual([`Пётр ${s}`]);
    const bySurname = await request(app).get(`/api/clients?search=${encodeURIComponent(s.toLowerCase())}`).set(AUTH());
    expect(names(bySurname).sort()).toEqual([`Анна Смирнова ${s}`, `Петя ${s}`, `Пётр ${s}`].sort());
  });

  it("сначала имена, которые начинаются с введённого, лимит соблюдается", async () => {
    const s = surname();
    await mkClient(`Студия ${s}`);
    await mkClient(`${s} Продакшн`);
    const res = await request(app).get(`/api/clients?search=${encodeURIComponent(s.toLowerCase())}&limit=1`).set(AUTH());
    expect(names(res)).toEqual([`${s} Продакшн`]);
  });
});

describe("защита от новых дублей", () => {
  it("завести клиента с тем же именем в другом написании — 409 с названием существующего", async () => {
    const s = surname();
    const existing = await mkClient(`Петя ${s}`);
    const res = await request(app).post("/api/clients").set(AUTH()).send({ name: `  петя   ${s.toUpperCase()} ` });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CLIENT_NAME_TAKEN");
    expect(res.body.message).toContain(`«Петя ${s}»`);
    expect(res.body.details).toMatchObject({ clientId: existing.id, name: `Петя ${s}` });
  });

  it("переименовать в имя другого клиента — 409; поменять регистр своего имени — можно", async () => {
    const s = surname();
    const a = await mkClient(`Петя ${s}`);
    const b = await mkClient(`Пётр ${s}`);
    const clash = await request(app).patch(`/api/clients/${b.id}`).set(AUTH()).send({ name: `ПЕТЯ ${s}` });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("CLIENT_NAME_TAKEN");
    expect(clash.body.details).toMatchObject({ clientId: a.id });
    const own = await request(app).patch(`/api/clients/${a.id}`).set(AUTH()).send({ name: `петя ${s.toLowerCase()}` });
    expect(own.status).toBe(200);
    expect(own.body.client.name).toBe(`петя ${s.toLowerCase()}`);
  });

  it("у уже заведённых «близнецов» можно править контакты, не трогая имя", async () => {
    const s = surname();
    const a = await mkClient(`Петя ${s}`);
    await mkClient(`петя ${s.toLowerCase()}`);
    // Форма редактирования шлёт имя всегда — неизменное имя не проверяется.
    const res = await request(app).patch(`/api/clients/${a.id}`).set(AUTH()).send({ name: `Петя ${s}`, phone: "+7 900 000-00-07" });
    expect(res.status).toBe(200);
    expect(res.body.client.phone).toBe("+7 900 000-00-07");
  });

  it("бронь с именем в другом написании прикрепляется к существующему клиенту", async () => {
    const s = surname();
    const existing = await mkClient(`Петя ${s}`, { phone: "+7 900 000-00-01" });
    const before = await prisma.client.count();
    const draft = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: `петя ${s.toLowerCase()}` },
        projectName: "Клип",
        startDate: new Date(Date.now() + 20 * DAY).toISOString(),
        endDate: new Date(Date.now() + 21 * DAY).toISOString(),
        items: [{ equipmentId, quantity: 1 }],
      });
    expect(draft.status).toBe(200);
    expect(draft.body.booking.clientId ?? draft.body.booking.client?.id).toBe(existing.id);
    const quick = await request(app)
      .post("/api/bookings/quick")
      .set(AUTH())
      .send({ client: { name: `ПЕТЯ  ${s}`, phone: "+7 999 999-99-99" }, amount: 1000 });
    expect(quick.status).toBe(201);
    expect(quick.body.booking.clientId ?? quick.body.booking.client?.id).toBe(existing.id);
    expect(await prisma.client.count()).toBe(before);
    // Телефон существующего клиента не перезаписан.
    expect((await prisma.client.findUnique({ where: { id: existing.id } })).phone).toBe("+7 900 000-00-01");
  });
});

describe("похожие имена", () => {
  it("подсказывает дубли по написанию: сначала совпадающие без учёта регистра, без себя и посторонних", async () => {
    const s = surname();
    const self = await mkClient(`петя ${s.toLowerCase()}`);
    const same = await mkClient(`Петя ${s}`);
    const reordered = await mkClient(`${s} Петя`);
    const variant = await mkClient(`Петр ${s}`);
    await mkClient(`Анна Смирнова`);
    const res = await request(app).get(`/api/clients/${self.id}/similar`).set(AUTH());
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: any) => c.id);
    expect(ids[0]).toBe(same.id);
    expect(ids).toEqual(expect.arrayContaining([same.id, reordered.id, variant.id]));
    expect(ids).not.toContain(self.id);
    expect(res.body.clients.map((c: any) => c.name)).not.toContain("Анна Смирнова");
    expect(res.body.clients[0]).toMatchObject({ bookingCount: 0 });
  });
});

describe("объединение клиентов", () => {
  async function duplicatePair() {
    const s = surname();
    const target = await mkClient(`Петя ${s}`, { email: "petya@example.com" });
    const source = await mkClient(`петя ${s.toLowerCase()}`, { phone: "+7 900 111-22-33", comment: "Гаффер, любит Aputure" });
    const own = await mkBooking(target.id);
    const moved = [
      await mkBooking(source.id),
      // Архивная бронь тоже переезжает: иначе дубль не удалить.
      await mkBooking(source.id, { status: "RETURNED", deletedAt: new Date(), deletedBy: saId }),
    ];
    const bill = await prisma.bill.create({
      data: {
        year: 2026, number: 9000 + seq, date: new Date(), clientId: source.id, total: 1000,
        sellerSnapshot: "{}", payerSnapshot: JSON.stringify({ name: source.name }), createdBy: saId,
      },
    });
    const credit = await prisma.creditNote.create({
      data: { contactClientId: source.id, amount: 500, remaining: 500, reason: "Залог", createdBy: saId },
    });
    const task = await prisma.task.create({ data: { title: "Позвонить", createdBy: saId, relatedClientId: source.id } });
    return { s, target, source, own, moved, bill, credit, task };
  }

  it("предпросмотр: что переедет и что будет с контактами — ничего не меняет", async () => {
    const { target, source } = await duplicatePair();
    const res = await request(app).get(`/api/clients/${source.id}/merge-preview?into=${target.id}`).set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: { id: source.id, name: source.name, bookingCount: 2 },
      target: { id: target.id, name: target.name, bookingCount: 1 },
      moves: { bookings: 2, bills: 1, creditNotes: 1, tasks: 1 },
      contact: { phone: "fill", email: "keep", comment: "fill" },
      portal: { outcome: "none" },
    });
    expect(await prisma.client.findUnique({ where: { id: source.id } })).not.toBeNull();
    expect(await prisma.booking.count({ where: { clientId: source.id } })).toBe(2);
  });

  it("всё переезжает к основной карточке, дубль удалён, журнал помнит, откуда пришло", async () => {
    const { target, source, own, moved, bill, credit, task } = await duplicatePair();
    const res = await merge(source.id, target.id);
    expect(res.status).toBe(200);
    expect(res.body.client).toMatchObject({
      id: target.id,
      name: target.name,
      phone: "+7 900 111-22-33",
      email: "petya@example.com",
      comment: "Гаффер, любит Aputure",
    });
    expect(res.body.moved).toEqual({ bookings: 2, bills: 1, creditNotes: 1, tasks: 1 });
    expect(await prisma.client.findUnique({ where: { id: source.id } })).toBeNull();
    const bookingIds = (await prisma.booking.findMany({ where: { clientId: target.id }, select: { id: true } })).map((b: any) => b.id);
    expect(bookingIds.sort()).toEqual([own.id, ...moved.map((b: any) => b.id)].sort());
    expect((await prisma.bill.findUnique({ where: { id: bill.id } })).clientId).toBe(target.id);
    // Выписанный счёт задним числом не меняется — плательщик в снимке прежний.
    expect(JSON.parse((await prisma.bill.findUnique({ where: { id: bill.id } })).payerSnapshot).name).toBe(source.name);
    expect((await prisma.creditNote.findUnique({ where: { id: credit.id } })).contactClientId).toBe(target.id);
    expect((await prisma.task.findUnique({ where: { id: task.id } })).relatedClientId).toBe(target.id);

    const onTarget = await prisma.auditEntry.findFirst({ where: { entityId: target.id, action: "CLIENT_MERGE" } });
    const after = JSON.parse(onTarget.after);
    expect(after).toMatchObject({ mergedClientId: source.id, mergedClientName: source.name, movedBookings: 2 });
    const onSource = await prisma.auditEntry.findFirst({ where: { entityId: source.id, action: "CLIENT_MERGED_INTO" } });
    expect(JSON.parse(onSource.after)).toMatchObject({ name: source.name, mergedIntoClientId: target.id, mergedIntoClientName: target.name });
    for (const b of moved) {
      const entry = await prisma.auditEntry.findFirst({ where: { entityId: b.id, action: "BOOKING_CLIENT_CHANGED" } });
      expect(JSON.parse(entry.before)).toMatchObject({ clientId: source.id, clientName: source.name });
      expect(JSON.parse(entry.after)).toMatchObject({ clientId: target.id, clientName: target.name });
    }
  });

  it("разные телефон, почта и реквизиты: у основной свои, чужие — в комментарии; реквизиты целиком, только если своих нет", async () => {
    const s = surname();
    const target = await mkClient(`Петя ${s}`, { phone: "+7 900 000-00-00", email: "a@example.com", comment: "Основной", inn: "7701234567" });
    const source = await mkClient(`Петр ${s}`, { phone: "+7 911 111-11-11", email: "b@example.com", inn: "500100732259", bankName: "Т-Банк" });
    const res = await merge(source.id, target.id);
    expect(res.status).toBe(200);
    const merged = await prisma.client.findUnique({ where: { id: target.id } });
    expect(merged).toMatchObject({ phone: "+7 900 000-00-00", email: "a@example.com", inn: "7701234567", bankName: null });
    expect(merged.comment).toContain("Основной");
    expect(merged.comment).toContain(`Из «Петр ${s}»`);
    expect(merged.comment).toContain("+7 911 111-11-11");
    expect(merged.comment).toContain("b@example.com");
    expect(merged.comment).toContain("ИНН 500100732259");

    // Тот же ИНН — один плательщик: пустые поля основной дополняются.
    const s3 = surname();
    const partial = await mkClient(`Коля ${s3}`, { inn: "7701234567" });
    const full = await mkClient(`коля ${s3.toLowerCase()}`, { inn: "7701234567", bankName: "Т-Банк", bankBik: "044525974" });
    const p3 = await request(app).get(`/api/clients/${full.id}/merge-preview?into=${partial.id}`).set(AUTH());
    expect(p3.body.contact.requisites).toBe("complete");
    expect((await merge(full.id, partial.id)).status).toBe(200);
    expect(await prisma.client.findUnique({ where: { id: partial.id } })).toMatchObject({
      inn: "7701234567", bankName: "Т-Банк", bankBik: "044525974", comment: null,
    });

    const s2 = surname();
    const bare = await mkClient(`Вася ${s2}`);
    const withLegal = await mkClient(`вася ${s2.toLowerCase()}`, { legalName: "ИП Васильев", inn: "500100732259", bankBik: "044525974" });
    expect((await merge(withLegal.id, bare.id)).status).toBe(200);
    expect(await prisma.client.findUnique({ where: { id: bare.id } })).toMatchObject({
      legalName: "ИП Васильев", inn: "500100732259", bankBik: "044525974",
    });
  });

  it("долги складываются: в реестре долгов один клиент на обе карточки", async () => {
    const s = surname();
    const target = await mkClient(`Петя ${s}`);
    const source = await mkClient(`петя ${s.toLowerCase()}`);
    await mkBooking(target.id, { finalAmount: 1000, amountOutstanding: 1000 });
    await mkBooking(source.id, { finalAmount: 500, amountOutstanding: 500 });
    expect((await merge(source.id, target.id)).status).toBe(200);
    const { computeDebts } = await import("../services/finance");
    const { debts } = await computeDebts({});
    const mine = debts.filter((d: any) => d.clientName.toLowerCase().includes(s.toLowerCase()));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ clientId: target.id, totalOutstanding: "1500.00" });
  });

  it("кабинет есть только у дубля — переезжает; вход дубля видит брони основной карточки", async () => {
    const s = surname();
    const target = await mkClient(`Петя ${s}`);
    const source = await mkClient(`петя ${s.toLowerCase()}`);
    const booking = await mkBooking(target.id);
    const account = await prisma.clientPortalAccount.create({
      data: { clientId: source.id, email: `lk-${seq}@example.com`, status: "ACTIVE" },
    });
    const preview = await request(app).get(`/api/clients/${source.id}/merge-preview?into=${target.id}`).set(AUTH());
    expect(preview.body.portal).toMatchObject({ outcome: "move", keptEmail: account.email, droppedEmail: null });
    expect((await merge(source.id, target.id)).status).toBe(200);
    expect((await prisma.clientPortalAccount.findUnique({ where: { id: account.id } })).clientId).toBe(target.id);

    // Сессия выдана до объединения — в ней ещё id удалённого дубля.
    const { signLkSession } = await import("../services/clientPortal/session");
    const token = signLkSession({ accountId: account.id, clientId: source.id, email: account.email });
    const lk = await request(app).get("/api/lk/bookings").set({ Authorization: `Bearer ${token}` });
    expect(lk.status).toBe(200);
    expect(lk.body.items.map((b: any) => b.id)).toContain(booking.id);
  });

  it("кабинет у обоих — остаётся кабинет основной карточки, кабинет дубля закрывается", async () => {
    const s = surname();
    const target = await mkClient(`Петя ${s}`);
    const source = await mkClient(`петя ${s.toLowerCase()}`);
    const kept = await prisma.clientPortalAccount.create({ data: { clientId: target.id, email: `kept-${seq}@example.com`, status: "ACTIVE" } });
    const dropped = await prisma.clientPortalAccount.create({ data: { clientId: source.id, email: `dropped-${seq}@example.com`, status: "PENDING" } });
    const preview = await request(app).get(`/api/clients/${source.id}/merge-preview?into=${target.id}`).set(AUTH());
    expect(preview.body.portal).toEqual({
      outcome: "drop", keptEmail: kept.email, droppedEmail: dropped.email,
      keptFrom: "target", keptStatus: "ACTIVE", droppedStatus: "PENDING",
    });
    expect((await merge(source.id, target.id)).status).toBe(200);
    expect(await prisma.clientPortalAccount.findUnique({ where: { id: dropped.id } })).toBeNull();
    expect((await prisma.clientPortalAccount.findUnique({ where: { id: kept.id } })).clientId).toBe(target.id);
  });

  it("кабинет у обоих, но пользуются кабинетом дубля — остаётся он, приглашение основной закрывается", async () => {
    const s = surname();
    const target = await mkClient(`Петя ${s}`);
    const source = await mkClient(`петя ${s.toLowerCase()}`);
    const pending = await prisma.clientPortalAccount.create({ data: { clientId: target.id, email: `pending-${seq}@example.com`, status: "PENDING" } });
    const active = await prisma.clientPortalAccount.create({
      data: { clientId: source.id, email: `active-${seq}@example.com`, status: "ACTIVE", lastLoginAt: new Date() },
    });
    const preview = await request(app).get(`/api/clients/${source.id}/merge-preview?into=${target.id}`).set(AUTH());
    expect(preview.body.portal).toMatchObject({ outcome: "drop", keptEmail: active.email, droppedEmail: pending.email, keptFrom: "source" });
    expect((await merge(source.id, target.id)).status).toBe(200);
    expect(await prisma.clientPortalAccount.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await prisma.clientPortalAccount.findUnique({ where: { id: active.id } })).toMatchObject({ clientId: target.id, status: "ACTIVE" });
  });

  it("отказы: с самим собой — 400, несуществующий — 404, кладовщику — 403", async () => {
    const s = surname();
    const a = await mkClient(`Петя ${s}`);
    const self = await merge(a.id, a.id);
    expect(self.status).toBe(400);
    expect(self.body.code).toBe("CLIENT_MERGE_SAME");
    const missing = await merge(a.id, "no-such-client");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("CLIENT_NOT_FOUND");
    const b = await mkClient(`петя ${s.toLowerCase()}`);
    const wh = await merge(b.id, a.id, AUTH_WH());
    expect(wh.status).toBe(403);
    const whPreview = await request(app).get(`/api/clients/${b.id}/merge-preview?into=${a.id}`).set(AUTH_WH());
    expect(whPreview.status).toBe(403);
    expect(await prisma.client.findUnique({ where: { id: b.id } })).not.toBeNull();
  });
});
