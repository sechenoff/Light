/**
 * Интеграционные тесты APPROVAL_MODE=auto (согласование выключено).
 *
 * Ключевая граница: «auto» отменяет ШАГ СОГЛАСОВАНИЯ, а не сам черновик.
 * Создание заявки остаётся созданием ЧЕРНОВИКА — публикует её только явное
 * действие (submit-for-approval), которое в этом режиме сразу подтверждает.
 *
 *  (a) POST /draft → бронь остаётся DRAFT: MAIN-смета есть, аудита
 *      BOOKING_AUTO_CONFIRMED нет, склад не занят.
 *  (a2) Черновик не резервирует оборудование: два черновика на единственный
 *      экземпляр сохраняются оба, стоку мешает только подтверждение.
 *  (b) POST /draft с количеством больше парка → тоже обычный DRAFT:
 *      сохранить черновик можно всегда, конфликт всплывает на публикации.
 *  (c) POST /:id/submit-for-approval для DRAFT в auto → сразу CONFIRMED
 *      (WAREHOUSE может — руководитель не нужен).
 *  (d) Конфликтная бронь после правки количества подтверждается повторным
 *      submit-for-approval (сценарий «старые заявки с ошибками»).
 *  (e) GET /api/auth/me отдаёт approvalMode: "auto".
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-autoconfirm.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-autoconfirm";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-autoconfirm";
process.env.JWT_SECRET = "test-jwt-secret-autoconfirm-16ch";
process.env.APPROVAL_MODE = "auto";

let app: Express;
let prisma: any;
let warehouseToken: string;
let equipmentId: string;
let scarceEquipmentId: string;

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
  const hash = await hashPassword("test-pass-123");
  const wh = await prisma.adminUser.create({
    data: { username: "ac_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ AC||GENERIC||LED-AC",
      name: "Панель AC",
      category: "LED",
      totalQuantity: 5,
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;

  const scarce = await prisma.equipment.create({
    data: {
      importKey: "COB||РЕДКИЙ ПРИБОР AC||GENERIC||COB-AC",
      name: "Редкий прибор AC",
      category: "COB",
      totalQuantity: 1,
      rentalRatePerShift: "5000",
      stockTrackingMode: "COUNT",
    },
  });
  scarceEquipmentId = scarce.id;
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

const AUTH_WH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` });

let seq = 0;
function dates() {
  seq += 1;
  const day = 10 + seq;
  return {
    startDate: `2026-09-${String(day).padStart(2, "0")}T09:00:00.000Z`,
    endDate: `2026-09-${String(day + 1).padStart(2, "0")}T09:00:00.000Z`,
  };
}

describe("APPROVAL_MODE=auto", () => {
  it("(e) /api/auth/me отдаёт approvalMode auto", async () => {
    const res = await request(app).get("/api/auth/me").set(AUTH_WH());
    expect(res.status).toBe(200);
    expect(res.body.approvalMode).toBe("auto");
  });

  it("(a) POST /draft → бронь остаётся черновиком, аудита автоподтверждения нет", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: "Авто-Клиент 1" },
        projectName: "Авто-проект",
        ...dates(),
        items: [{ equipmentId, quantity: 2 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("DRAFT");
    // Смета-снапшот у черновика есть — печатать и согласовывать можно сразу.
    expect(res.body.booking.estimate).toBeTruthy();
    // Никаких сюрпризов в ответе: черновик сохранён, и всё.
    expect(res.body.autoConfirm).toBeUndefined();

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_AUTO_CONFIRMED", entityId: res.body.booking.id },
    });
    expect(audit).toBeNull();
  });

  it("(a2) черновик не занимает склад — публикует только submit", async () => {
    const d = dates();
    const mk = (name: string) =>
      request(app)
        .post("/api/bookings/draft")
        .set(AUTH_WH())
        .send({
          client: { name },
          projectName: "Единственный экземпляр",
          ...d,
          items: [{ equipmentId: scarceEquipmentId, quantity: 1 }],
        });

    const first = await mk("Авто-Клиент 1a");
    const second = await mk("Авто-Клиент 1b");
    expect(first.body.booking.status).toBe("DRAFT");
    expect(second.body.booking.status).toBe("DRAFT");

    // Публикуем первый — вот теперь единственный экземпляр занят.
    const published = await request(app)
      .post(`/api/bookings/${first.body.booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(published.status).toBe(200);
    expect(published.body.booking.status).toBe("CONFIRMED");

    const conflict = await request(app)
      .post(`/api/bookings/${second.body.booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toContain("Редкий прибор AC");
  });

  it("(b) POST /draft с превышением парка → всё равно сохраняется черновиком", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: "Авто-Клиент 2" },
        projectName: "Жадный проект",
        ...dates(),
        items: [{ equipmentId: scarceEquipmentId, quantity: 4 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("DRAFT");
    // Черновик — рабочий документ: копить позиции можно и сверх парка,
    // нехватку показывает публикация (тест (d)), а не сохранение.
    expect(res.body.autoConfirm).toBeUndefined();
  });

  it("(c) submit-for-approval из DRAFT в auto → сразу CONFIRMED от WAREHOUSE", async () => {
    // Создаём DRAFT через dryRun=false с конфликтом... нет — обычный DRAFT
    // руками (минуя auto): пишем прямо в БД.
    const client = await prisma.client.create({ data: { name: "Авто-Клиент 3" } });
    const d = dates();
    const draft = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Ручной черновик",
        startDate: new Date(d.startDate),
        endDate: new Date(d.endDate),
        status: "DRAFT",
        items: { create: [{ equipmentId, quantity: 1 }] },
      },
    });

    const res = await request(app)
      .post(`/api/bookings/${draft.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("CONFIRMED");
  });

  it("(d) конфликтная заявка: правка количества → повторный submit проходит", async () => {
    // Черновик, требующий больше парка (как заявки бота на проде)
    const client = await prisma.client.create({ data: { name: "Авто-Клиент 4" } });
    const d = dates();
    const draft = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Как у бота",
        startDate: new Date(d.startDate),
        endDate: new Date(d.endDate),
        status: "DRAFT",
        items: { create: [{ equipmentId: scarceEquipmentId, quantity: 3 }] },
      },
    });

    const fail = await request(app)
      .post(`/api/bookings/${draft.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(fail.status).toBe(409);
    expect(fail.body.message).toContain("Редкий прибор AC");

    // Оператор поправил количество до доступного
    await prisma.bookingItem.updateMany({
      where: { bookingId: draft.id },
      data: { quantity: 1 },
    });

    const ok = await request(app)
      .post(`/api/bookings/${draft.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.booking.status).toBe("CONFIRMED");
  });
});
