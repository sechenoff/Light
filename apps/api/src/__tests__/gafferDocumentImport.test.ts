/**
 * Импорт заявки-документа: POST /api/bookings/parse-gaffer-document
 * (multipart → модель → матчинг → подбор клиента) и сервисные функции.
 * Модель подменена — проверяем контракт маршрута и обогащение, не сеть.
 */
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-document.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-gdoc";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-gaffer-document-min16chars";
process.env.BARCODE_SECRET = "test-barcode-gdoc";
process.env.WAREHOUSE_SECRET = "test-warehouse-gdoc-secret16";
process.env.VISION_PROVIDER = "mock";

const llm = vi.hoisted(() => ({
  extractGafferDocument: vi.fn(),
  hasVision: true,
}));

vi.mock("../services/llm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/llm")>();
  return {
    ...orig,
    getLlmProvider: () =>
      llm.hasVision
        ? { extractGafferLines: vi.fn(), extractGafferDocument: llm.extractGafferDocument }
        : { extractGafferLines: vi.fn() },
  };
});

// Сервис тянет prisma — грузим его динамически, ПОСЛЕ выставления DATABASE_URL:
// статический import выполнился бы раньше присваиваний env выше по файлу.
let svc: typeof import("../services/gafferDocumentImport");

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);

const META = {
  projectName: "Яндекс Книги",
  gafferName: "Белых Геннадий",
  phone: "+7 981 790-34-51",
  email: null,
  telegram: "Belyhph",
  startDate: "2026-09-02",
  endDate: null,
};

let app: Express;
let saToken: string;
let techToken: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  svc = await import("../services/gafferDocumentImport");
  const { prisma } = await import("../prisma");
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");
  const sa = await prisma.adminUser.create({ data: { username: "gdoc_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  const tech = await prisma.adminUser.create({ data: { username: "gdoc_tech", passwordHash: hash, role: "TECHNICIAN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  await prisma.equipment.create({
    data: {
      importKey: "gdoc-storm-700x",
      name: "Aputure STORM 700x",
      category: "COB Light",
      rentalRatePerShift: 5000,
      stockTrackingMode: "COUNT",
      totalQuantity: 2,
    },
  });
  await prisma.client.createMany({
    data: [
      { name: "Гена Белых", phone: "8 (981) 790 34 51" },
      { name: "Захар Радомский", email: "Zakhar@Example.com" },
      { name: "Иванов Пётр" },
      { name: "Иванов Сергей" },
    ],
  });
});

afterAll(async () => {
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

beforeEach(() => {
  llm.extractGafferDocument.mockReset();
  llm.hasVision = true;
});

function post() {
  return request(app)
    .post("/api/bookings/parse-gaffer-document")
    .set("X-API-Key", "test-key-gdoc")
    .set("Authorization", `Bearer ${saToken}`);
}

describe("POST /api/bookings/parse-gaffer-document", () => {
  it("TECHNICIAN → 403 (маршрут под гардом SUPER_ADMIN + WAREHOUSE)", async () => {
    const res = await request(app)
      .post("/api/bookings/parse-gaffer-document")
      .set("X-API-Key", "test-key-gdoc")
      .set("Authorization", `Bearer ${techToken}`)
      .attach("file", PDF, { filename: "z.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(403);
    expect(llm.extractGafferDocument).not.toHaveBeenCalled();
  });

  it("без файла → 400 NO_FILE", async () => {
    const res = await post().field("note", "x");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE");
  });

  it("чужой тип файла → 400 INVALID_FILE_TYPE", async () => {
    const res = await post().attach("file", Buffer.from("hello"), { filename: "a.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FILE_TYPE");
  });

  it("MIME говорит PDF, а байты — нет → 400 INVALID_FILE_FORMAT", async () => {
    const res = await post().attach("file", Buffer.from("not really a pdf file"), {
      filename: "fake.pdf",
      contentType: "application/pdf",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FILE_FORMAT");
    expect(llm.extractGafferDocument).not.toHaveBeenCalled();
  });

  it("PDF: позиции матчатся с каталогом, клиент подбирается по телефону, имя файла — кириллица", async () => {
    llm.extractGafferDocument.mockResolvedValue({
      lines: [
        { gafferPhrase: "Aputure STORM 700x", interpretedName: "aputure storm 700x", quantity: 1 },
        { gafferPhrase: "Хейзер 1800W Мощный", interpretedName: "hazer 1800w", quantity: 1 },
      ],
      meta: META,
    });

    const res = await post().attach("file", PDF, { filename: "заявка.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].gafferPhrase).toBe("Aputure STORM 700x");
    expect(res.body.items[0].quantity).toBe(1);
    expect(res.body.items[0].match.kind).not.toBe("unmatched");
    if (res.body.items[0].match.kind === "resolved") {
      expect(res.body.items[0].match.catalogName).toBe("Aputure STORM 700x");
    }
    expect(res.body.document).toEqual({ ...META, fileName: "заявка.pdf" });
    expect(res.body.client).toMatchObject({ name: "Гена Белых", matchedBy: "phone" });

    const arg = llm.extractGafferDocument.mock.calls[0][0];
    expect(arg.mimeType).toBe("application/pdf");
    expect(arg.fileName).toBe("заявка.pdf");
    expect(Buffer.isBuffer(arg.data) && arg.data.equals(PDF)).toBe(true);
  });

  it("фото JPEG принимается; без позиций — 200 с пустым списком и шапкой", async () => {
    llm.extractGafferDocument.mockResolvedValue({
      lines: [],
      meta: { ...META, phone: null, gafferName: "Кто-то Неизвестный", projectName: "Реклама" },
    });

    const res = await post().attach("file", JPEG, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.message).toMatch(/не нашёл позиций/);
    expect(res.body.document.projectName).toBe("Реклама");
    expect(res.body.client).toBeNull();
    expect(llm.extractGafferDocument.mock.calls[0][0].mimeType).toBe("image/jpeg");
  });

  it("модель упала → 503 AI_UNAVAILABLE", async () => {
    llm.extractGafferDocument.mockRejectedValue(new Error("529 overloaded"));
    const res = await post().attach("file", PDF, { filename: "z.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("AI_UNAVAILABLE");
  });

  it("провайдер без зрения → 503 AI_DOCUMENTS_UNSUPPORTED", async () => {
    llm.hasVision = false;
    const res = await post().attach("file", PDF, { filename: "z.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("AI_DOCUMENTS_UNSUPPORTED");
  });
});

describe("gafferDocumentImport — сервисные функции", () => {
  it("phoneKey: разные написания одного номера сходятся, короткие — null", () => {
    expect(svc.phoneKey("+7 981 790-34-51")).toBe("9817903451");
    expect(svc.phoneKey("8 (981) 790 34 51")).toBe("9817903451");
    expect(svc.phoneKey("9817903451")).toBe("9817903451");
    expect(svc.phoneKey("790-34-51")).toBeNull();
    expect(svc.phoneKey(null)).toBeNull();
  });

  it("validateGafferDocumentBytes: сигнатура должна совпадать с заявленным типом", () => {
    expect(svc.validateGafferDocumentBytes(PDF, "application/pdf")).toBe(true);
    expect(svc.validateGafferDocumentBytes(JPEG, "image/jpeg")).toBe(true);
    expect(svc.validateGafferDocumentBytes(WEBP, "image/webp")).toBe(true);
    expect(svc.validateGafferDocumentBytes(PDF, "image/png")).toBe(false);
    expect(svc.validateGafferDocumentBytes(Buffer.from("%PDF"), "application/pdf")).toBe(false); // слишком короткий
  });

  it("findClientForGaffer: телефон важнее имени, почта — без учёта регистра", async () => {
    const byPhone = await svc.findClientForGaffer({ gafferName: "Иванов", phone: "+7 981 790 34 51", email: null });
    expect(byPhone).toMatchObject({ name: "Гена Белых", matchedBy: "phone" });

    const byEmail = await svc.findClientForGaffer({ gafferName: null, phone: null, email: "zakhar@example.com" });
    expect(byEmail).toMatchObject({ name: "Захар Радомский", matchedBy: "email" });
  });

  it("findClientForGaffer: по имени — только однозначное совпадение", async () => {
    const unique = await svc.findClientForGaffer({ gafferName: "Радомский Захар (гаффер)", phone: null, email: null });
    expect(unique).toMatchObject({ name: "Захар Радомский", matchedBy: "name" });

    const ambiguous = await svc.findClientForGaffer({ gafferName: "Иванов", phone: null, email: null });
    expect(ambiguous).toBeNull();

    const nobody = await svc.findClientForGaffer({ gafferName: "Ли", phone: "123", email: null });
    expect(nobody).toBeNull();
  });
});
