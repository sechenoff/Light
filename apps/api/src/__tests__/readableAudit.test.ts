import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";

const db = path.resolve(__dirname, "../../prisma/test-readable-audit.db");
Object.assign(process.env, {
  DATABASE_URL: `file:${db}`,
  RATE_LIMIT_DISABLED: "true",
  API_KEYS: "audit-local-key",
  AUTH_MODE: "enforce",
  NODE_ENV: "test",
  JWT_SECRET: "readable-audit-local-secret-only",
  BARCODE_SECRET: "audit-barcode-local",
  WAREHOUSE_SECRET: "audit-warehouse-local",
  VISION_PROVIDER: "mock",
});
let app: Express,
  prisma: PrismaClient,
  sa: string,
  wh: string,
  actorId: string,
  targetId: string,
  bookingId: string;
const auth = () => ({
  "X-API-Key": "audit-local-key",
  Authorization: `Bearer ${sa}`,
});
beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const passwordHash = await hashPassword("audit-fixture-password");
  const admin = await prisma.adminUser.create({
    data: { username: "audit_manager", passwordHash, role: "SUPER_ADMIN" },
  });
  const worker = await prisma.adminUser.create({
    data: { username: "audit_worker", passwordHash, role: "WAREHOUSE" },
  });
  actorId = admin.id;
  targetId = worker.id;
  sa = signSession({
    userId: actorId,
    username: admin.username,
    role: "SUPER_ADMIN",
  });
  wh = signSession({
    userId: targetId,
    username: worker.username,
    role: "WAREHOUSE",
  });
});
afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(db + suffix, { force: true });
});

describe("человекочитаемый аудит", () => {
  it("создание быстрой брони сохраняет автора из сессии и поля атомарно", async () => {
    const res = await request(app)
      .post("/api/bookings/quick")
      .set(auth())
      .send({
        client: { name: "Тестовый заказчик журнала" },
        amount: 1200,
        projectName: "До изменения",
        userId: targetId,
      });
    expect(res.status).toBe(201);
    bookingId = res.body.booking.id;
    const entries = await prisma.auditEntry.findMany({
      where: { entityId: bookingId, action: "BOOKING_QUICK_CREATE" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe(actorId);
    expect(JSON.parse(entries[0].after!)).toMatchObject({
      projectName: "До изменения",
      manualFinalAmount: "1200",
    });
  });
  it("редактирование брони фиксирует старое и новое значение, включая обнуление", async () => {
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(auth())
      .send({ projectName: "После изменения", comment: "Проверка журнала" });
    expect(res.status).toBe(200);
    const entry = await prisma.auditEntry.findFirstOrThrow({
      where: { entityId: bookingId, action: "BOOKING_UPDATE" },
    });
    expect(entry.userId).toBe(actorId);
    expect(JSON.parse(entry.before!)).toMatchObject({
      projectName: "До изменения",
      comment: null,
    });
    expect(JSON.parse(entry.after!)).toMatchObject({
      projectName: "После изменения",
      comment: "Проверка журнала",
    });
    const finance = await prisma.bookingFinanceEvent.findFirstOrThrow({
      where: { bookingId, eventType: "BOOKING_EDITED" },
    });
    expect(JSON.parse(finance.payloadJson!).auditActor).toMatchObject({
      id: actorId,
      username: "audit_manager",
    });
  });
  it("обычный черновик и изменение состава сохраняют автора в обоих режимах согласования", async () => {
    const previousMode = process.env.APPROVAL_MODE;
    try {
      for (const mode of ["manual", "auto"]) {
        process.env.APPROVAL_MODE = mode;
        const now = Date.now();
        const created = await request(app)
          .post("/api/bookings/draft")
          .set(auth())
          .send({
            client: { name: `Заказчик черновика ${mode}` },
            projectName: `Черновик ${mode}`,
            startDate: new Date(now + 86400000).toISOString(),
            endDate: new Date(now + 172800000).toISOString(),
            items: [
              {
                customName: "Световая панель",
                customUnitPrice: 500,
                quantity: 1,
              },
            ],
          });
        expect(created.status).toBe(200);
        expect(created.body.booking.status).toBe("DRAFT");
        const id = created.body.booking.id;
        const creation = await prisma.auditEntry.findFirstOrThrow({
          where: { entityId: id, action: "BOOKING_CREATE" },
        });
        expect(creation.userId).toBe(actorId);
        const updated = await request(app)
          .patch(`/api/bookings/${id}`)
          .set(auth())
          .send({
            items: [
              {
                customName: "Световая панель",
                customUnitPrice: 500,
                quantity: 3,
              },
            ],
          });
        expect(updated.status).toBe(200);
        const edit = await prisma.auditEntry.findFirstOrThrow({
          where: { entityId: id, action: "BOOKING_UPDATE" },
        });
        expect(
          JSON.parse(edit.before!).itemsDetails["Световая панель"].quantity,
        ).toBe(1);
        expect(
          JSON.parse(edit.after!).itemsDetails["Световая панель"].quantity,
        ).toBe(3);
      }
    } finally {
      if (previousMode === undefined) delete process.env.APPROVAL_MODE;
      else process.env.APPROVAL_MODE = previousMode;
    }
  });
  it("ошибка записи аудита откатывает изменение брони", async () => {
    const audit = await import("../services/audit");
    const spy = vi
      .spyOn(audit, "writeAuditEntry")
      .mockRejectedValueOnce(new Error("audit fixture failure"));
    try {
      const res = await request(app)
        .patch(`/api/bookings/${bookingId}`)
        .set(auth())
        .send({ projectName: "Не должно сохраниться" });
      expect(res.status).toBe(500);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
          .projectName,
      ).toBe("После изменения");
    } finally {
      spy.mockRestore();
    }
  });
  it("очередь создания сохраняет аккаунт каждого запроса и освобождается после отката", async () => {
    const audit = await import("../services/audit");
    const { auditContext } = await import("../services/auditContext");
    const { createBookingDraft, createQuickBooking } = await import(
      "../services/bookings"
    );
    const client = await prisma.client.create({
      data: { name: "Клиент конкурентного аудита" },
    });
    const startDate = new Date(Date.now() + 86400000);
    const endDate = new Date(Date.now() + 172800000);
    const create = (index: number) =>
      new Promise<{ id: string }>((resolve, reject) => {
        const userId = index % 2 ? targetId : actorId;
        auditContext(
          {
            adminUser: {
              userId,
              username: `actor-${index % 2}`,
              role: "SUPER_ADMIN",
            },
          } as never,
          {} as never,
          () => {
            const common = {
              clientId: client.id,
              startDate,
              endDate,
              projectName: `Параллельная запись ${index}`,
            };
            const operation =
              index % 2
                ? createQuickBooking({ ...common, amount: 100 })
                : createBookingDraft({
                    ...common,
                    items: [
                      {
                        customName: "Панель",
                        customUnitPrice: 100,
                        quantity: 1,
                      },
                    ],
                  });
            operation.then(resolve, reject);
          },
        );
      });
    const spy = vi
      .spyOn(audit, "writeAuditEntry")
      .mockRejectedValueOnce(new Error("creation audit failure"));
    try {
      await expect(create(0)).rejects.toThrow("creation audit failure");
      expect(
        await prisma.booking.count({ where: { clientId: client.id } }),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create(i)),
    );
    for (const [index, booking] of results.entries()) {
      const entries = await prisma.auditEntry.findMany({
        where: { entityId: booking.id },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe(index % 2 ? targetId : actorId);
    }
  });
  it("смена пароля оставляет факт изменения без пароля и хеша", async () => {
    const res = await request(app)
      .patch(`/api/admin-users/${targetId}`)
      .set(auth())
      .send({ password: "new-fixture-password" });
    expect(res.status).toBe(200);
    const history = await request(app)
      .get(`/api/audit?entityType=AdminUser&entityId=${targetId}`)
      .set(auth());
    expect(history.status).toBe(200);
    expect(history.body.items[0].entityLabel).toBe("audit_worker");
    expect(history.body.items[0].user.username).toBe("audit_manager");
    expect(JSON.parse(history.body.items[0].after).passwordChanged).toBe(true);
    expect(JSON.stringify(history.body)).not.toContain("new-fixture-password");
    expect(JSON.stringify(history.body)).not.toContain("passwordHash");
  });
  it("фильтр действий работает до пагинации, одинаковое время не теряет записи", async () => {
    const at = new Date(Date.now() - 10_000);
    await prisma.auditEntry.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        userId: actorId,
        action: i % 2 ? "FIXTURE_OTHER" : "FIXTURE_SELECTED",
        entityType: "Client",
        entityId: "audit-pagination-fixture",
        createdAt: at,
      })),
    });
    const base =
      "/api/audit?entityId=audit-pagination-fixture&action=FIXTURE_SELECTED&limit=2";
    const one = await request(app).get(base).set(auth());
    const two = await request(app)
      .get(`${base}&cursor=${one.body.nextCursor}`)
      .set(auth());
    expect(one.body.items).toHaveLength(2);
    expect(two.body.items).toHaveLength(1);
    const ids = [...one.body.items, ...two.body.items].map(
      (e: { id: string }) => e.id,
    );
    expect(new Set(ids).size).toBe(3);
    expect(two.body.nextCursor).toBeNull();
  });
  it("история брони включает её платежи и не включает чужие", async () => {
    const payment = await prisma.payment.create({
      data: {
        bookingId,
        amount: "100",
        direction: "INCOME",
        paymentMethod: "CASH",
      },
    });
    await prisma.auditEntry.createMany({
      data: [
        {
          userId: actorId,
          action: "PAYMENT_CREATE",
          entityType: "Payment",
          entityId: payment.id,
          after: JSON.stringify({ amount: "100" }),
        },
        {
          userId: actorId,
          action: "PAYMENT_CREATE",
          entityType: "Payment",
          entityId: "other-booking-payment",
        },
      ],
    });
    const res = await request(app)
      .get(`/api/audit?bookingId=${bookingId}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(
      res.body.items.some(
        (e: { entityId: string }) => e.entityId === payment.id,
      ),
    ).toBe(true);
    expect(
      res.body.items.some(
        (e: { entityId: string }) => e.entityId === "other-booking-payment",
      ),
    ).toBe(false);
  });
  it("старые секреты очищаются на чтении; фильтр сотрудника возвращает только его действия", async () => {
    await prisma.auditEntry.create({
      data: {
        userId: targetId,
        action: "TASK_UPDATE",
        entityType: "Task",
        entityId: "audit-secret-fixture",
        after: JSON.stringify({
          passwordHash: "legacy-hash",
          nested: { token: "legacy-token", status: "DONE" },
        }),
      },
    });
    const res = await request(app)
      .get(`/api/audit?userId=${targetId}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(
      res.body.items.every(
        (entry: { userId: string }) => entry.userId === targetId,
      ),
    ).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/legacy-hash|legacy-token/);
    expect(
      res.body.items.find(
        (entry: { entityId: string }) =>
          entry.entityId === "audit-secret-fixture",
      ).after,
    ).toContain("DONE");
  });
  it("параллельные запросы не смешивают аккаунты, фоновые события отмечены системой", async () => {
    const { auditContext } = await import("../services/auditContext");
    const { createFinanceEvent } = await import("../services/finance");
    const actors = [
      { userId: actorId, username: "audit_manager", role: "SUPER_ADMIN" },
      { userId: targetId, username: "audit_worker", role: "WAREHOUSE" },
    ];
    await Promise.all(
      actors.map(
        (adminUser, i) =>
          new Promise<void>((resolve, reject) => {
            auditContext({ adminUser } as never, {} as never, () => {
              setTimeout(
                () => {
                  createFinanceEvent({
                    bookingId,
                    eventType: `ACTOR_ISOLATION_${i}`,
                    payload: { auditActor: { username: "forged" } },
                  }).then(() => resolve(), reject);
                },
                i ? 0 : 10,
              );
            });
          }),
      ),
    );
    for (let i = 0; i < actors.length; i++) {
      const event = await prisma.bookingFinanceEvent.findFirstOrThrow({
        where: { bookingId, eventType: `ACTOR_ISOLATION_${i}` },
      });
      expect(JSON.parse(event.payloadJson!).auditActor.id).toBe(
        actors[i].userId,
      );
    }
    await createFinanceEvent({ bookingId, eventType: "BACKGROUND_FIXTURE" });
    const background = await prisma.bookingFinanceEvent.findFirstOrThrow({
      where: { bookingId, eventType: "BACKGROUND_FIXTURE" },
    });
    expect(JSON.parse(background.payloadJson!)).toMatchObject({
      auditActor: null,
      auditSource: "system",
    });
  });
  it("снимок состава большой брони не теряется при превышении прежнего лимита", async () => {
    const { writeAuditEntry } = await import("../services/audit");
    const itemsDetails = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [
        `Оборудование с длинным названием ${i}`,
        { quantity: i + 1, negotiatedRatePerShift: "1500" },
      ]),
    );
    await writeAuditEntry({
      userId: actorId,
      action: "LARGE_BOOKING_FIXTURE",
      entityType: "Booking",
      entityId: bookingId,
      before: null,
      after: { itemsDetails },
      maxSnapshotBytes: 2 * 1024 * 1024,
    });
    const row = await prisma.auditEntry.findFirstOrThrow({
      where: { action: "LARGE_BOOKING_FIXTURE" },
    });
    expect(Object.keys(JSON.parse(row.after!).itemsDetails)).toHaveLength(250);
  });
  it("период проверяется на сервере, чужие роли не получают аудит", async () => {
    const now = Date.now();
    const bad = await request(app)
      .get("/api/audit")
      .query({
        from: new Date(now + 1000).toISOString(),
        to: new Date(now).toISOString(),
      })
      .set(auth());
    expect(bad.status).toBe(400);
    const forbidden = await request(app)
      .get(`/api/audit?userId=${actorId}`)
      .set({ "X-API-Key": "audit-local-key", Authorization: `Bearer ${wh}` });
    expect(forbidden.status).toBe(403);
  });
});
