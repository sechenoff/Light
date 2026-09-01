/**
 * POST /api/repairs/:id/photos — снимок поломки из админского интерфейса.
 *
 * Ручка появилась по итогам приёмки: модалка «Завести поломку» уже слала на неё
 * снимки, а маршрута не существовало — фото молча терялись (склад грузит свои
 * через `/api/warehouse/repairs/:id/photos`, но та ручка живёт под PIN-входом и
 * требует, чтобы карточку завёл тот же кладовщик, поэтому из обычной сессии
 * отвечает 403).
 *
 * Фиксируем: happy-path трёх ролей, magic-byte проверку (расширение и
 * Content-Type подделываются тривиально), отказ дописывать снимки к закрытой
 * карточке и то, что загруженное фото сразу видно в `GET /:id`.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repair-photo-upload.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-repair-photo-upload";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repair-photo-upload";
process.env.WAREHOUSE_SECRET = "test-warehouse-repair-photo-upload16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-repair-photo-upload-min16";

/** Минимальный валидный 1x1 PNG (тот же буфер, что в repairPhotosRoutes.test.ts). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=",
  "base64",
);

let app: Express;
let prisma: any;
let equipmentId: string;
let saToken: string;
let whToken: string;
let techToken: string;

const apiKey = { "X-API-Key": "test-key-repair-photo-upload" };
const auth = (token: string) => ({ ...apiKey, Authorization: `Bearer ${token}` });

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

  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("photo-upload-pass");

  const sa = await prisma.adminUser.create({
    data: { username: "Пётр Руководитель", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const wh = await prisma.adminUser.create({
    data: { username: "Иван Кладовщик", passwordHash: hash, role: "WAREHOUSE" },
  });
  const tech = await prisma.adminUser.create({
    data: { username: "Сергей Техник", passwordHash: hash, role: "TECHNICIAN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const eq = await prisma.equipment.create({
    data: {
      importKey: "photo-upload-eq",
      name: "Кабель питания 25 м",
      category: "Кабели",
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
      totalQuantity: 4,
    },
  });
  equipmentId = eq.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});

async function makeRepair(): Promise<string> {
  const repair = await prisma.repair.create({
    data: { equipmentId, quantity: 1, reason: "Перебит кабель", createdBy: "тест" },
  });
  return repair.id;
}

describe("POST /api/repairs/:id/photos", () => {
  it("принимает снимок от руководителя и отдаёт ссылку на него", async () => {
    const repairId = await makeRepair();

    const res = await request(app)
      .post(`/api/repairs/${repairId}/photos`)
      .set(auth(saToken))
      .attach("photo", PNG, "полом.png");

    expect(res.status).toBe(201);
    expect(res.body.photosCount).toBe(1);
    expect(res.body.photo.url).toBe(`/api/repairs/${repairId}/photos/${res.body.photo.id}`);

    // Снимок сразу виден в карточке — ради этого ручка и заводилась.
    const detail = await request(app).get(`/api/repairs/${repairId}`).set(auth(saToken));
    expect(detail.status).toBe(200);
    expect(detail.body.repair.photos).toHaveLength(1);
    expect(detail.body.repair.photos[0].id).toBe(res.body.photo.id);

    // И скачивается тем же URL, которым его отдали.
    const file = await request(app).get(res.body.photo.url).set(auth(saToken));
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("image/png");
  });

  it("принимает снимок от кладовщика и от техника — фото делают оба", async () => {
    for (const token of [whToken, techToken]) {
      const repairId = await makeRepair();
      const res = await request(app)
        .post(`/api/repairs/${repairId}/photos`)
        .set(auth(token))
        .attach("photo", PNG, "полом.png");
      expect(res.status).toBe(201);
    }
  });

  it("отвергает файл, который только притворяется картинкой", async () => {
    const repairId = await makeRepair();

    const res = await request(app)
      .post(`/api/repairs/${repairId}/photos`)
      .set(auth(saToken))
      .attach("photo", Buffer.from("%PDF-1.4 совсем не картинка"), {
        filename: "полом.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FILE_TYPE");
    expect(await prisma.repairPhoto.count({ where: { repairId } })).toBe(0);
  });

  it("не даёт дописать снимок к закрытой карточке", async () => {
    const repairId = await makeRepair();
    await prisma.repair.update({
      where: { id: repairId },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    const res = await request(app)
      .post(`/api/repairs/${repairId}/photos`)
      .set(auth(saToken))
      .attach("photo", PNG, "полом.png");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REPAIR_ALREADY_CLOSED");
  });

  it("на несуществующую карточку отвечает 404, а не 500", async () => {
    const res = await request(app)
      .post("/api/repairs/нет-такого/photos")
      .set(auth(saToken))
      .attach("photo", PNG, "полом.png");

    expect(res.status).toBe(404);
  });
});
