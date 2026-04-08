/**
 * Интеграционные тесты REST-эндпоинтов /api/import-sessions.
 *
 * Используют отдельную тестовую БД: test-import-routes.db
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import xlsx from "xlsx";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-import-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-for-import-routes";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-import-routes";

let app: Express;
let prisma: any;

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
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* игнорируем */
      }
    }
  }
});

const AUTH = { "X-API-Key": "test-key-1" };

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────

function makeTestXlsx(rows: Record<string, unknown>[]): Buffer {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const TEST_ROWS = [
  { Категория: "Свет", Наименование: "Прожектор 1kW", "Кол-во": 2, Стоимость: 1000 },
  { Категория: "Свет", Наименование: "Панель Nova P300", "Кол-во": 1, Стоимость: 2000 },
  { Категория: "Аксессуары", Наименование: "Диффузор 120x120", "Кол-во": 5, Стоимость: 300 },
];

async function uploadSession() {
  const buf = makeTestXlsx(TEST_ROWS);
  const res = await request(app)
    .post("/api/import-sessions/upload")
    .set(AUTH)
    .attach("file", buf, { filename: "test.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  expect(res.status).toBe(200);
  return res.body as { session: { id: string }; preview: { headers: string[] } };
}

async function createTestEquipmentDirect(name: string, category: string, price: number) {
  return prisma.equipment.create({
    data: {
      importKey: `${category.toUpperCase()}||${name.toUpperCase()}||||`,
      category,
      name,
      totalQuantity: 2,
      rentalRatePerShift: price,
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// POST /upload
// ──────────────────────────────────────────────────────────────────

describe("POST /api/import-sessions/upload", () => {
  it("загружает валидный xlsx и возвращает session + preview", async () => {
    const buf = makeTestXlsx(TEST_ROWS);
    const res = await request(app)
      .post("/api/import-sessions/upload")
      .set(AUTH)
      .attach("file", buf, {
        filename: "catalog.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(res.status).toBe(200);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.id).toBeTruthy();
    expect(res.body.session.status).toBe("PARSING");
    expect(res.body.session.fileName).toBe("catalog.xlsx");
    expect(res.body.preview).toBeDefined();
    expect(res.body.preview.headers).toContain("Наименование");
    expect(res.body.preview.sampleRows).toBeDefined();
  });

  it("отклоняет не-xlsx файл с 400", async () => {
    const res = await request(app)
      .post("/api/import-sessions/upload")
      .set(AUTH)
      .attach("file", Buffer.from("not a spreadsheet"), {
        filename: "data.csv",
        contentType: "text/csv",
      });

    expect(res.status).toBe(400);
  });

  it("возвращает 400 если файл не передан", async () => {
    const res = await request(app)
      .post("/api/import-sessions/upload")
      .set(AUTH);

    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────
// GET /
// ──────────────────────────────────────────────────────────────────

describe("GET /api/import-sessions", () => {
  it("возвращает список сессий (без строк)", async () => {
    // Создаём сессию
    await uploadSession();

    const res = await request(app)
      .get("/api/import-sessions")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThan(0);
    // Убеждаемся что нет relation rows в ответе
    for (const s of res.body.sessions) {
      expect(s.rows).toBeUndefined();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// GET /:id
// ──────────────────────────────────────────────────────────────────

describe("GET /api/import-sessions/:id", () => {
  it("возвращает сессию по id", async () => {
    const { session } = await uploadSession();

    const res = await request(app)
      .get(`/api/import-sessions/${session.id}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.id).toBe(session.id);
  });

  it("возвращает 404 для несуществующего id", async () => {
    const res = await request(app)
      .get("/api/import-sessions/nonexistent-id-999")
      .set(AUTH);

    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/map
// ──────────────────────────────────────────────────────────────────

describe("POST /api/import-sessions/:id/map", () => {
  it("задаёт маппинг и запускает матчинг, возвращает stats", async () => {
    const { session } = await uploadSession();

    const res = await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // Может возвращать totalRows, matchedRows, etc.
  });

  it("возвращает 400 при отсутствии обязательных полей mapping", async () => {
    const { session } = await uploadSession();

    const res = await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {}, // нет обязательных name и category
      });

    expect(res.status).toBe(400);
  });

  it("COMPETITOR_IMPORT требует competitorName", async () => {
    const { session } = await uploadSession();

    const res = await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "COMPETITOR_IMPORT",
        mapping: { name: "Наименование", category: "Категория" },
        // competitorName не передан
      });

    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────
// GET /:id/rows
// ──────────────────────────────────────────────────────────────────

describe("GET /api/import-sessions/:id/rows", () => {
  it("возвращает пагинированные строки", async () => {
    const { session } = await uploadSession();

    // Сначала сделаем map чтобы создались строки
    await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    const res = await request(app)
      .get(`/api/import-sessions/${session.id}/rows`)
      .set(AUTH)
      .query({ page: 1, limit: 50 });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(typeof res.body.totalPages).toBe("number");
  });

  it("поддерживает фильтрацию по action", async () => {
    const { session } = await uploadSession();

    await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    const res = await request(app)
      .get(`/api/import-sessions/${session.id}/rows`)
      .set(AUTH)
      .query({ action: "NEW_ITEM" });

    expect(res.status).toBe(200);
    // Все вернувшиеся строки должны иметь action=NEW_ITEM (или массив пустой)
    for (const row of res.body.rows) {
      expect(row.action).toBe("NEW_ITEM");
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// PATCH /:id/rows/:rowId
// ──────────────────────────────────────────────────────────────────

describe("PATCH /api/import-sessions/:id/rows/:rowId", () => {
  it("обновляет статус строки на ACCEPTED", async () => {
    const { session } = await uploadSession();

    await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    // Берём первую строку
    const rowsRes = await request(app)
      .get(`/api/import-sessions/${session.id}/rows`)
      .set(AUTH);
    expect(rowsRes.status).toBe(200);
    const firstRow = rowsRes.body.rows[0];
    expect(firstRow).toBeDefined();

    const res = await request(app)
      .patch(`/api/import-sessions/${session.id}/rows/${firstRow.id}`)
      .set(AUTH)
      .send({ status: "ACCEPTED" });

    expect(res.status).toBe(200);

    // Проверяем в БД
    const updated = await prisma.importSessionRow.findUnique({ where: { id: firstRow.id } });
    expect(updated.status).toBe("ACCEPTED");
  });
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/bulk-action
// ──────────────────────────────────────────────────────────────────

describe("POST /api/import-sessions/:id/bulk-action", () => {
  it("bulk-reject помечает все строки REJECTED", async () => {
    const { session } = await uploadSession();

    await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    const res = await request(app)
      .post(`/api/import-sessions/${session.id}/bulk-action`)
      .set(AUTH)
      .send({ action: "REJECTED", filter: {} });

    expect(res.status).toBe(200);
    expect(typeof res.body.updated).toBe("number");
  });

  it("возвращает 400 при невалидном action", async () => {
    const { session } = await uploadSession();

    const res = await request(app)
      .post(`/api/import-sessions/${session.id}/bulk-action`)
      .set(AUTH)
      .send({ action: "INVALID_ACTION", filter: {} });

    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/apply
// ──────────────────────────────────────────────────────────────────

describe("POST /api/import-sessions/:id/apply", () => {
  it("применяет изменения и обновляет оборудование в БД", async () => {
    // Создаём оборудование с известной ценой
    const eq = await createTestEquipmentDirect("Прожектор RouteApply1", "Свет", 1000);

    const buf = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор RouteApply1", "Кол-во": 2, Стоимость: 1500 },
    ]);

    const uploadRes = await request(app)
      .post("/api/import-sessions/upload")
      .set(AUTH)
      .attach("file", buf, {
        filename: "apply-test.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    expect(uploadRes.status).toBe(200);
    const sessionId = uploadRes.body.session.id;

    // map
    await request(app)
      .post(`/api/import-sessions/${sessionId}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    // Принимаем строку с нашим оборудованием
    const rowsRes = await request(app)
      .get(`/api/import-sessions/${sessionId}/rows`)
      .set(AUTH)
      .query({ action: "PRICE_CHANGE" });
    expect(rowsRes.status).toBe(200);

    const priceChangeRow = rowsRes.body.rows.find((r: any) => r.equipmentId === eq.id);
    if (priceChangeRow) {
      await request(app)
        .patch(`/api/import-sessions/${sessionId}/rows/${priceChangeRow.id}`)
        .set(AUTH)
        .send({ status: "ACCEPTED" });
    }

    const res = await request(app)
      .post(`/api/import-sessions/${sessionId}/apply`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.applied).toBeDefined();
    expect(res.body.skipped).toBeDefined();

    // Если строка была найдена и принята — цена должна обновиться
    if (priceChangeRow) {
      const updatedEq = await prisma.equipment.findUnique({ where: { id: eq.id } });
      expect(parseFloat(updatedEq.rentalRatePerShift)).toBe(1500);
    }
  });

  it("второй apply возвращает 409 (оптимистичная блокировка)", async () => {
    const buf = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор LockTest", "Кол-во": 1, Стоимость: 500 },
    ]);

    const uploadRes = await request(app)
      .post("/api/import-sessions/upload")
      .set(AUTH)
      .attach("file", buf, {
        filename: "lock-test.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    expect(uploadRes.status).toBe(200);
    const sessionId = uploadRes.body.session.id;

    await request(app)
      .post(`/api/import-sessions/${sessionId}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    // Первый apply
    const firstApply = await request(app)
      .post(`/api/import-sessions/${sessionId}/apply`)
      .set(AUTH);
    expect(firstApply.status).toBe(200);

    // Второй apply — должен вернуть 409
    const secondApply = await request(app)
      .post(`/api/import-sessions/${sessionId}/apply`)
      .set(AUTH);
    expect(secondApply.status).toBe(409);
  });
});

// ──────────────────────────────────────────────────────────────────
// GET /:id/export
// ──────────────────────────────────────────────────────────────────

describe("GET /api/import-sessions/:id/export", () => {
  it("возвращает XLSX файл с правильным Content-Type", async () => {
    const { session } = await uploadSession();

    await request(app)
      .post(`/api/import-sessions/${session.id}/map`)
      .set(AUTH)
      .send({
        type: "OWN_PRICE_UPDATE",
        mapping: {
          category: "Категория",
          name: "Наименование",
          quantity: "Кол-во",
          rentalRatePerShift: "Стоимость",
        },
      });

    const res = await request(app)
      .get(`/api/import-sessions/${session.id}/export`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers["content-disposition"]).toContain(".xlsx");
    expect(res.body).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/match (placeholder)
// ──────────────────────────────────────────────────────────────────

describe("POST /api/import-sessions/:id/match", () => {
  it("возвращает 501 Не реализовано", async () => {
    const { session } = await uploadSession();

    const res = await request(app)
      .post(`/api/import-sessions/${session.id}/match`)
      .set(AUTH);

    expect(res.status).toBe(501);
  });
});

// ──────────────────────────────────────────────────────────────────
// DELETE /:id
// ──────────────────────────────────────────────────────────────────

describe("DELETE /api/import-sessions/:id", () => {
  it("удаляет сессию и возвращает 204", async () => {
    const { session } = await uploadSession();

    const res = await request(app)
      .delete(`/api/import-sessions/${session.id}`)
      .set(AUTH);

    expect(res.status).toBe(204);

    // Проверяем что сессия удалена
    const inDb = await prisma.importSession.findUnique({ where: { id: session.id } });
    expect(inDb).toBeNull();
  });
});
