/**
 * Интеграционный тест (HTTP-уровень): security-guard'ы маршрутов фото поломки.
 *
 * Покрывает два security-relevant guard'а на warehouseScanRouter, отмеченные
 * code-review как «ship untested»:
 *
 *  1. POST /sessions/:id/units/:unitId/photos — magic-byte валидация.
 *     Файл с content-type image/png, но НЕ-PNG телом → 400 INVALID_FILE_FORMAT.
 *     (+ happy-path: реальный PNG → 200, body.photos непустой — фиксируем контракт.)
 *
 *  2. DELETE /sessions/:id/units/:unitId/photos/:name — basename / traversal guard.
 *     `:name` с попыткой выхода за uploads/ → 404 PHOTO_NOT_FOUND
 *     (никогда 200, никогда 500, ничего не удаляется за пределами UPLOAD_ROOT).
 *
 * Гарнесс (env-заголовки, bootstrap app, warehouse Bearer-токен через PIN-auth
 * /api/warehouse/auth, prisma db push с изолированной БД) скопирован из
 * checklistRoutes.test.ts. Фикстура return-сессии — паттерн setupReturnSession
 * из repairPhotos.test.ts.
 *
 * Tests-only: production-код не модифицируется.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repair-photos-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-repair-photos-routes";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repair-photos-routes";
process.env.WAREHOUSE_SECRET = "test-warehouse-repair-photos-routes16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-repair-photos-routes-min16";

const API_KEY = "test-key-repair-photos-routes";

// Минимальный валидный 1x1 PNG (тот же буфер, что в repairPhotos.test.ts).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=",
  "base64",
);

let app: any;
let prisma: any;
let warehouseToken: string;
let sessionId: string;
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

  const pmod = await import("../prisma");
  prisma = pmod.prisma;
  const { app: expressApp } = await import("../app");
  app = expressApp;

  // Warehouse PIN-работник для аутентификации (kiosk-сценарий).
  const { hashPin } = await import("../services/warehouseAuth");
  const pinHash = await hashPin("1234");
  await prisma.warehousePin.create({
    data: { name: "Тест кладовщик rp-routes", pinHash, isActive: true },
  });

  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .send({ name: "Тест кладовщик rp-routes", pin: "1234" });
  expect(authRes.status).toBe(200);
  warehouseToken = authRes.body.token;

  // Фикстура: клиент + UNIT-оборудование + ISSUED unit + ACTIVE RETURN сессия.
  const client = await prisma.client.create({
    data: { name: "Тест клиент rp-routes", phone: "+70000000091" },
  });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "rp-routes-equipment-001",
      name: "Арри Алекса",
      category: "Камеры",
      rentalRatePerShift: 10000,
      stockTrackingMode: "UNIT",
    },
  });

  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId: equipment.id, barcode: "RP-ROUTES-1", status: "ISSUED" },
  });
  unitId = unit.id;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тест маршруты фото поломки",
      startDate: new Date("2026-04-01"),
      endDate: new Date("2026-04-05"),
      status: "ISSUED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });

  const bookingItem = await prisma.bookingItem.create({
    data: { bookingId: booking.id, equipmentId: equipment.id, quantity: 1 },
  });

  await prisma.bookingItemUnit.create({
    data: { bookingItemId: bookingItem.id, equipmentUnitId: unit.id },
  });

  const session = await prisma.scanSession.create({
    data: {
      bookingId: booking.id,
      workerName: "Тест кладовщик rp-routes",
      operation: "RETURN",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;

  await prisma.scanRecord.create({
    data: { sessionId: session.id, equipmentUnitId: unit.id, hmacVerified: false },
  });

  // Контрольный sentinel ВНЕ UPLOAD_ROOT создаётся ДО traversal-попытки,
  // чтобы ассерт «файл не тронут» был содержательным (файл реально существует).
  fs.writeFileSync(secretSentinelPath(), SENTINEL_CONTENT);
});

afterAll(async () => {
  await prisma.$disconnect();
  // Удаляем изолированную БД-файлы + sentinel (uploads/ — gitignored).
  const cleanup = [
    ...["", "-wal", "-shm", "-journal"].map((s) => TEST_DB_PATH + s),
    secretSentinelPath(),
  ];
  for (const f of cleanup) {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});

const auth = (r: request.Test) =>
  r.set("X-API-Key", API_KEY).set("Authorization", `Bearer ${warehouseToken}`);

describe("POST /api/warehouse/sessions/:id/units/:unitId/photos — magic-byte guard", () => {
  it("отклоняет файл с image/png content-type, но не-PNG телом → 400 INVALID_FILE_FORMAT", async () => {
    const res = await auth(
      request(app)
        .post(`/api/warehouse/sessions/${sessionId}/units/${unitId}/photos`)
        .attach("photo", Buffer.from("this is not a png"), {
          filename: "fake.png",
          contentType: "image/png",
        }),
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FILE_FORMAT");
  });

  it("happy-path: реальный PNG → 200, body.photos непустой (контракт)", async () => {
    const res = await auth(
      request(app)
        .post(`/api/warehouse/sessions/${sessionId}/units/${unitId}/photos`)
        .attach("photo", PNG, { filename: "ok.png", contentType: "image/png" }),
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.photos)).toBe(true);
    expect(res.body.photos.length).toBeGreaterThanOrEqual(1);
  });
});

describe("DELETE /api/warehouse/sessions/:id/units/:unitId/photos/:name — traversal guard", () => {
  it("encodeURIComponent('../../secret') → 404 PHOTO_NOT_FOUND (не 200/500, ничего не удалено вне uploads/)", async () => {
    const before = readSecretSentinel();
    const res = await auth(
      request(app).delete(
        `/api/warehouse/sessions/${sessionId}/units/${unitId}/photos/` +
          encodeURIComponent("../../secret"),
      ),
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PHOTO_NOT_FOUND");
    // sentinel за пределами UPLOAD_ROOT не тронут
    expect(readSecretSentinel()).toBe(before);
  });

  it("плоский ..%2F..%2Fx вариант → 404 (никогда 200, никогда 500)", async () => {
    const res = await auth(
      request(app).delete(
        `/api/warehouse/sessions/${sessionId}/units/${unitId}/photos/..%2F..%2Fx`,
      ),
    );

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(500);
  });

  it("несуществующее, но in-bounds имя → 404 (sanity)", async () => {
    const res = await auth(
      request(app).delete(
        `/api/warehouse/sessions/${sessionId}/units/${unitId}/photos/does-not-exist.png`,
      ),
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PHOTO_NOT_FOUND");
  });
});

/**
 * Контрольный «секрет» вне UPLOAD_ROOT (apps/api/uploads). Помещаем его в
 * apps/api/prisma/ (sibling каталога uploads/) — если traversal-guard пробит,
 * `../../secret` из uploads/scan-sessions/{sid}/{uid}/ дотянулся бы наружу.
 * Создаётся в beforeAll, ассертится «не тронут», удаляется в afterAll.
 */
const SENTINEL_CONTENT = "UNTOUCHED-SENTINEL";

function secretSentinelPath(): string {
  return path.resolve(__dirname, "../../prisma/test-rp-routes-sentinel.txt");
}

function readSecretSentinel(): string {
  return fs.readFileSync(secretSentinelPath(), "utf8");
}
