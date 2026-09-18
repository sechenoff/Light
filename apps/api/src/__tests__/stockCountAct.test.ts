/**
 * Акт инвентаризации (спека §7 «Акт»): модель документа, фразы решений,
 * выгрузка PDF/XLSX и пагинация длинного акта.
 *
 * Одна база, шаги одной истории (открытая инвентаризация на систему одна):
 *   черновик идущей инвентаризации → завершение → акт завершённой →
 *   длинная инвентаризация на 130 позиций → её отмена.
 *
 * Даты — только от Date.now(): зашитые календарные даты протухают.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-stock-count-act.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-stock-count-act";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-stock-count-act";
process.env.WAREHOUSE_SECRET = "test-warehouse-stock-count-act";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-stock-count-act-min16";
// Реквизиты — только из настроек: ENV-фолбэки сметы (ORG_*) из локального .env
// не должны просачиваться в проверку «пустое поле не печатается». Пустая
// строка, а не delete: dotenv не перезаписывает уже заданные переменные.
process.env.ORG_NAME = "";
process.env.ORG_PHONE = "";
process.env.ORG_ADDRESS = "";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let techToken: string;

const eq: Record<string, string> = {};
const problemCreatedAt: Record<string, Date> = {};
let sourceBookingId: string;
let countId: string;

const apiKey = { "X-API-Key": "test-key-stock-count-act" };
const auth = (token: string) => ({ ...apiKey, Authorization: `Bearer ${token}` });

/** Бинарное тело ответа (PDF/XLSX) — supertest по умолчанию его не собирает. */
const binary = (res: any, cb: (e: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

/** Страницы PDF: объекты `/Type /Page` (без `/Pages` — это корень дерева). */
const pdfPageCount = (buf: Buffer) => (buf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

async function createEquipment(key: string, name: string, category: string, totalQuantity: number, sortOrder = 0) {
  const row = await prisma.equipment.create({
    data: {
      importKey: `sca-${key}`,
      name,
      category,
      totalQuantity,
      rentalRatePerShift: "700",
      stockTrackingMode: "COUNT",
      sortOrder,
    },
  });
  eq[key] = row.id;
  return row;
}

async function openProblem(key: string, quantity: number, daysAgo: number) {
  const createdAt = daysFromNow(-daysAgo);
  problemCreatedAt[key] = createdAt;
  await prisma.problemItem.create({
    data: {
      equipmentId: eq[key],
      quantity,
      reason: "LOST",
      comment: "не вернули",
      source: "MANUAL",
      createdBy: "sca_super",
      createdAt,
    },
  });
}

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
  const hash = await hashPassword("stock-count-act-pass");
  const sa = await prisma.adminUser.create({ data: { username: "sca_super", passwordHash: hash, role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "sca_warehouse", passwordHash: hash, role: "WAREHOUSE" } });
  const tech = await prisma.adminUser.create({ data: { username: "sca_tech", passwordHash: hash, role: "TECHNICIAN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", legalName: "ИП Светов", inn: "771234567890", phone: "+7 916 000-00-00" },
    update: { legalName: "ИП Светов", inn: "771234567890" },
  });
  await prisma.appSetting.create({
    data: { key: "equipment_category_order", value: JSON.stringify(["Свет", "Грип"]) },
  });

  // Свет: A, B, G — недостачи; Грип: C, D, H — излишки, E сошлось, F не посчитано.
  await createEquipment("A", "Кабель 25 м", "Свет", 10, 1);
  await createEquipment("B", "Флоппи 48×48", "Свет", 5, 2);
  await createEquipment("G", "Удлинитель PCE 15 м", "Свет", 8, 3);
  await createEquipment("C", "Флаг 40×40", "Грип", 1, 1);
  await createEquipment("D", "Vmount", "Грип", 19, 2);
  await createEquipment("E", "Прищепка", "Грип", 20, 3);
  await createEquipment("F", "Сэндбэг", "Грип", 3, 4);
  await createEquipment("H", "Рамка 12×12", "Грип", 4, 5);

  await openProblem("C", 1, 7);
  await openProblem("H", 1, 3);

  const client = await prisma.client.create({ data: { name: "Клиент акта" } });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Северный ветер",
      status: "RETURNED",
      startDate: daysFromNow(-12),
      endDate: daysFromNow(-10),
      items: { create: [{ equipmentId: eq.A, quantity: 3 }] },
    },
  });
  sourceBookingId = booking.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
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

async function linesOf(id: string) {
  const res = await request(app).get(`/api/stock-counts/${id}/lines`).set(auth(saToken));
  expect(res.status).toBe(200);
  return res.body.lines as any[];
}

function lineId(lines: any[], key: string): string {
  const line = lines.find((l) => l.equipmentId === eq[key]);
  expect(line, `строка для ${key}`).toBeDefined();
  return line.id;
}

async function decide(id: string, lId: string, body: Record<string, unknown>) {
  const res = await request(app).post(`/api/stock-counts/${id}/lines/${lId}/decision`).set(auth(saToken)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

function rowByName(act: any, name: string) {
  const row = act.discrepancies.find((r: any) => r.name === name);
  expect(row, `расхождение «${name}»`).toBeDefined();
  return row;
}

/**
 * Синтетический завершённый акт одной категории поверх настоящего: разделы
 * заменены, сводка пересчитана по ним. Раскладка страниц зависит от высоты
 * шапки, сводки и пояснений — поэтому сводка своя, а не от исходного акта.
 */
function syntheticAct(
  base: any,
  parts: { discrepancies?: any[]; matched?: number; uncounted?: number; counters?: string[] },
) {
  const discrepancies = parts.discrepancies ?? [];
  const matched = Array.from({ length: parts.matched ?? 0 }, (_, i) => ({
    lineId: `synthetic-m-${i}`,
    name: `Сошедшаяся позиция № ${i + 1}`,
    category: "Массовая",
    qty: 10,
    countedBy: "Иван",
    countedAt: base.generatedAt,
  }));
  const uncounted = Array.from({ length: parts.uncounted ?? 0 }, (_, i) => ({
    lineId: `synthetic-u-${i}`,
    name: `Непосчитанная позиция № ${i + 1}`,
    category: "Массовая",
  }));
  const shortage = discrepancies.filter((r) => r.diff < 0);
  const surplus = discrepancies.filter((r) => r.diff > 0);
  const lines = discrepancies.length + matched.length + uncounted.length;
  return {
    ...base,
    status: "CLOSED",
    isDraft: false,
    docDate: base.generatedAt,
    closedAt: base.generatedAt,
    closedBy: "sca_super",
    cancelledAt: null,
    counters: parts.counters ?? ["Иван", "Олег"],
    scope: { categories: ["Массовая"], label: `Массовая, ${lines} позиций` },
    summary: {
      lines,
      counted: lines - uncounted.length,
      uncounted: uncounted.length,
      matched: matched.length,
      shortagePositions: shortage.length,
      shortageQty: shortage.reduce((s, r) => s - r.diff, 0),
      surplusPositions: surplus.length,
      surplusQty: surplus.reduce((s, r) => s + r.diff, 0),
      undecided: 0,
    },
    discrepancies,
    matched,
    uncounted,
  };
}

// ─── Фразы решений (чистые функции) ───────────────────────────────────────────

describe("describeDecision / foundLabel", () => {
  const at = (d: number) => daysFromNow(-d);

  it("удалённая позиция и штучный учёт не дают эффектов", async () => {
    const { describeDecision } = await import("../services/stockCount/act/buildStockCountAct");
    const base = { decision: "LOST" as const, diff: -2, totalAtCount: 5 };
    expect(describeDecision({ ...base, hasEquipment: false }, { status: "CLOSED", isUnitMode: false, sourceProjectName: null })).toEqual({
      label: "позиция удалена из каталога — без последствий",
      state: "skipped",
    });
    expect(
      describeDecision({ ...base, hasEquipment: true }, { status: "OPEN", isUnitMode: true, sourceProjectName: null }).label,
    ).toBe("позиция на штучном учёте — сверяется по единицам");
    // Завершённая: потеряшка заведена — значит, строка применена, даже если
    // позицию перевели на штучный учёт уже после завершения.
    expect(
      describeDecision(
        { ...base, hasEquipment: true },
        { status: "CLOSED", isUnitMode: true, sourceProjectName: null, lostCreatedQty: 2 },
      ),
    ).toEqual({ label: "пропажа → потеряшка", state: "applied" });
    expect(
      describeDecision({ ...base, hasEquipment: true }, { status: "CLOSED", isUnitMode: true, sourceProjectName: null })
        .state,
    ).toBe("skipped");
  });

  it("удалённая позиция у завершённой: эффекты записаны — фраза применённого решения с пометкой", async () => {
    const { describeDecision } = await import("../services/stockCount/act/buildStockCountAct");
    const { fmtDayMonth } = await import("../services/stockCount/act/format");
    const closed = { status: "CLOSED" as const, isUnitMode: false, sourceProjectName: null };
    expect(
      describeDecision(
        { decision: "ADJUST", diff: -2, totalAtCount: 2, hasEquipment: false },
        { ...closed, adjustApplied: { before: 2, after: 0 } },
      ),
    ).toEqual({ label: "ошибка учёта: 2 → 0 (позиция позже удалена из каталога)", state: "applied" });
    expect(
      describeDecision(
        { decision: "LOST", diff: -2, totalAtCount: 3, hasEquipment: false },
        { ...closed, sourceProjectName: "Северный ветер", lostCreatedQty: 2 },
      ),
    ).toEqual({ label: "пропажа → «Северный ветер» (позиция позже удалена из каталога)", state: "applied" });
    expect(
      describeDecision(
        { decision: "FOUND", diff: 1, totalAtCount: 2, hasEquipment: false },
        { ...closed, foundProblems: [{ quantity: 1, createdAt: at(4) }] },
      ),
    ).toEqual({
      label: `нашлось (потеряшка от ${fmtDayMonth(at(4))}) (позиция позже удалена из каталога)`,
      state: "applied",
    });
    // Улик нет — позицию удалили до завершения, и завершение строку пропустило.
    expect(
      describeDecision({ decision: "ADJUST", diff: -2, totalAtCount: 2, hasEquipment: false }, { ...closed, adjustApplied: null }),
    ).toEqual({ label: "позиция удалена из каталога — без последствий", state: "skipped" });
  });

  it("удалённая позиция у идущей и отменённой: без подходящего решения — «решение не принято»", async () => {
    const { describeDecision } = await import("../services/stockCount/act/buildStockCountAct");
    const open = { status: "OPEN" as const, isUnitMode: false, sourceProjectName: null };
    expect(describeDecision({ decision: null, diff: -1, totalAtCount: 3, hasEquipment: false }, open)).toEqual({
      label: "позиция удалена из каталога — решение не принято",
      state: "none",
    });
    expect(describeDecision({ decision: "ADJUST", diff: -1, totalAtCount: 3, hasEquipment: false }, open)).toEqual({
      label: "позиция удалена из каталога",
      state: "skipped",
    });
    // «Пропало» на излишке не подходит — такое решение считается отсутствующим.
    expect(describeDecision({ decision: "LOST", diff: 1, totalAtCount: 3, hasEquipment: false }, open).state).toBe("none");
    expect(
      describeDecision(
        { decision: null, diff: -1, totalAtCount: 3, hasEquipment: false },
        { ...open, status: "CANCELLED" as const },
      ).state,
    ).toBe("none");
  });

  it("решение, не подходящее знаку, — «решение не принято»", async () => {
    const { describeDecision } = await import("../services/stockCount/act/buildStockCountAct");
    const facts = { status: "OPEN" as const, isUnitMode: false, sourceProjectName: null };
    expect(describeDecision({ decision: "LOST", diff: 2, totalAtCount: 3, hasEquipment: true }, facts)).toEqual({
      label: "решение не принято",
      state: "none",
    });
    expect(describeDecision({ decision: null, diff: -1, totalAtCount: 3, hasEquipment: true }, facts).label).toBe(
      "решение не принято",
    );
  });

  it("пропажа: с бронью — проект в кавычках; ошибка учёта — по снапшоту, не ниже нуля", async () => {
    const { describeDecision } = await import("../services/stockCount/act/buildStockCountAct");
    expect(
      describeDecision(
        { decision: "LOST", diff: -4, totalAtCount: 42, hasEquipment: true },
        { status: "OPEN", isUnitMode: false, sourceProjectName: "Северный ветер" },
      ),
    ).toEqual({ label: "пропажа → «Северный ветер»", state: "planned" });
    expect(
      describeDecision(
        { decision: "ADJUST", diff: -3, totalAtCount: 1, hasEquipment: true },
        { status: "OPEN", isUnitMode: false, sourceProjectName: null },
      ).label,
    ).toBe("ошибка учёта: 1 → 0");
    // У завершённой — то, что реально записано в журнал.
    expect(
      describeDecision(
        { decision: "ADJUST", diff: 2, totalAtCount: 19, hasEquipment: true },
        { status: "CLOSED", isUnitMode: false, sourceProjectName: null, adjustApplied: { before: 20, after: 22 } },
      ),
    ).toEqual({ label: "ошибка учёта: 20 → 22", state: "applied" });
  });

  it("нашлось: целиком, частично, нечего закрыть, много дат", async () => {
    const { foundLabel } = await import("../services/stockCount/act/buildStockCountAct");
    const { fmtDayMonth } = await import("../services/stockCount/act/format");
    expect(foundLabel(1, [{ quantity: 1, createdAt: at(7) }])).toBe(`нашлось (потеряшка от ${fmtDayMonth(at(7))})`);
    expect(foundLabel(3, [{ quantity: 1, createdAt: at(3) }])).toBe(
      `нашлось 1 (потеряшка от ${fmtDayMonth(at(3))}), ещё 2 без объяснения`,
    );
    expect(foundLabel(2, [])).toBe("лишнее без объяснения: 2");
    const many = [1, 2, 3, 4, 5].map((d) => ({ quantity: 1, createdAt: at(d * 10) }));
    expect(foundLabel(5, many)).toMatch(/^нашлось \(потеряшки от \d\d\.\d\d, \d\d\.\d\d, \d\d\.\d\d и ещё 2\)$/);
  });
});

// ─── Черновик: идущая инвентаризация ─────────────────────────────────────────

describe("акт идущей инвентаризации — черновик", () => {
  beforeAll(async () => {
    const start = await request(app).post("/api/stock-counts").set(auth(whToken)).send({});
    expect(start.status).toBe(201);
    countId = start.body.stockCount.id;
    const lines = await linesOf(countId);
    const { recordCount } = await import("../services/stockCount/stockCountService");

    // Десктоп (кладовщик) и киоск («Иван») — два счётчика.
    const deskCounts: Array<[string, number]> = [
      ["A", 7],
      ["B", 3],
      ["G", 6],
    ];
    for (const [key, qty] of deskCounts) {
      const res = await request(app)
        .post(`/api/stock-counts/${countId}/lines/${lineId(lines, key)}/count`)
        .set(auth(whToken))
        .send({ qty });
      expect(res.status).toBe(200);
    }
    await recordCount(countId, lineId(lines, "C"), 1, "Иван");
    await recordCount(countId, lineId(lines, "D"), 21, "Иван");
    await recordCount(countId, lineId(lines, "E"), 20, "Иван");
    await recordCount(countId, lineId(lines, "H"), 6, "Иван");

    await decide(countId, lineId(lines, "A"), { decision: "LOST", sourceBookingId });
    await decide(countId, lineId(lines, "B"), { decision: "ADJUST", note: "ошибка при импорте каталога" });
    await decide(countId, lineId(lines, "G"), { decision: "LOST" });
    await decide(countId, lineId(lines, "C"), { decision: "FOUND" });
    await decide(countId, lineId(lines, "H"), { decision: "FOUND" });
    // D (Vmount, +2) — без решения.
  });

  it("модель: черновик, сводка, разделы и порядок расхождений", async () => {
    const { buildStockCountAct, stockCountActFileBase, actStamp } = await import(
      "../services/stockCount/act/buildStockCountAct"
    );
    const act = await buildStockCountAct(countId);
    expect(act.status).toBe("OPEN");
    expect(act.isDraft).toBe(true);
    expect(actStamp(act)).toBe("ЧЕРНОВИК");
    expect(stockCountActFileBase(act)).toBe("Акт инвентаризации № 1 — черновик");
    expect(act.org).toMatchObject({ name: "ИП Светов", inn: "771234567890" });
    expect(act.org.address).toBeNull();
    expect(act.scope.label).toBe("весь склад, 8\u00A0позиций");
    expect(act.counters).toEqual(["sca_warehouse", "Иван"]);
    expect(act.startedBy).toBe("sca_warehouse");
    expect(act.countingFrom).toBeInstanceOf(Date);
    expect(act.summary).toEqual({
      lines: 8,
      counted: 7,
      uncounted: 1,
      matched: 1,
      shortagePositions: 3,
      shortageQty: 7,
      surplusPositions: 3,
      surplusQty: 6,
      undecided: 1,
    });
    // Сначала недостачи, потом излишки; внутри — порядок каталога.
    expect(act.discrepancies.map((r) => r.name)).toEqual([
      "Кабель 25 м",
      "Флоппи 48×48",
      "Удлинитель PCE 15 м",
      "Флаг 40×40",
      "Vmount",
      "Рамка 12×12",
    ]);
    expect(act.matched.map((r) => [r.name, r.qty])).toEqual([["Прищепка", 20]]);
    expect(act.uncounted.map((r) => r.name)).toEqual(["Сэндбэг"]);
  });

  it("решения черновика — план, без решения — «решение не принято»", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { fmtDayMonth } = await import("../services/stockCount/act/format");
    const act = await buildStockCountAct(countId);
    expect(rowByName(act, "Кабель 25 м")).toMatchObject({
      expected: 10,
      counted: 7,
      diff: -3,
      decisionLabel: "пропажа → «Северный ветер»",
      decisionState: "planned",
    });
    expect(rowByName(act, "Флоппи 48×48")).toMatchObject({
      decisionLabel: "ошибка учёта: 5 → 3",
      note: "ошибка при импорте каталога",
    });
    expect(rowByName(act, "Удлинитель PCE 15 м").decisionLabel).toBe("пропажа → потеряшка");
    expect(rowByName(act, "Флаг 40×40")).toMatchObject({
      expected: 0,
      counted: 1,
      diff: 1,
      decisionLabel: `нашлось (потеряшка от ${fmtDayMonth(problemCreatedAt.C)})`,
    });
    expect(rowByName(act, "Vmount")).toMatchObject({ decisionLabel: "решение не принято", decisionState: "none" });
    expect(rowByName(act, "Рамка 12×12").decisionLabel).toBe(
      `нашлось 1 (потеряшка от ${fmtDayMonth(problemCreatedAt.H)}), ещё 2 без объяснения`,
    );
  });

  it("GET act.pdf — 200, PDF inline, кириллица в имени файла", async () => {
    const res = await request(app).get(`/api/stock-counts/${countId}/act.pdf`).set(auth(whToken)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const cd = res.headers["content-disposition"] as string;
    expect(cd.startsWith("inline;")).toBe(true);
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("Акт инвентаризации № 1 — черновик.pdf")}`);
    expect(cd).toMatch(/filename="[\x20-\x7E]+"/);
    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(5_000);
    expect(body.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("GET act.xlsx — 200, два листа, количества — числами", async () => {
    const res = await request(app).get(`/api/stock-counts/${countId}/act.xlsx`).set(auth(saToken)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("Акт инвентаризации № 1 — черновик.xlsx")}`,
    );
    const body = res.body as Buffer;
    expect(body.subarray(0, 2).toString()).toBe("PK");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Расхождения", "Все позиции"]);
    const disc = wb.getWorksheet("Расхождения")!;
    expect(disc.pageSetup.orientation).toBe("landscape");
    expect(disc.pageSetup.paperSize).toBe(9);
    let cable: ExcelJS.Row | undefined;
    disc.eachRow((row) => {
      if (row.getCell(2).value === "Кабель 25 м") cable = row;
    });
    expect(cable).toBeDefined();
    expect(cable!.getCell(4).value).toBe(10);
    expect(cable!.getCell(5).value).toBe(7);
    expect(cable!.getCell(6).value).toBe(-3);
    expect(cable!.getCell(7).value).toBe("пропажа → «Северный ветер»");

    const all = wb.getWorksheet("Все позиции")!;
    const results: string[] = [];
    all.eachRow((row, n) => {
      if (n > 3) results.push(String(row.getCell(4).value));
    });
    expect(results.sort()).toEqual(
      ["излишек", "излишек", "излишек", "недостача", "недостача", "недостача", "не посчитано", "сошлось"].sort(),
    );
  });

  it("права и 404: техник — 403, неизвестная инвентаризация — 404", async () => {
    for (const suffix of ["act.pdf", "act.xlsx"]) {
      const tech = await request(app).get(`/api/stock-counts/${countId}/${suffix}`).set(auth(techToken));
      expect(tech.status).toBe(403);
      const anon = await request(app).get(`/api/stock-counts/${countId}/${suffix}`).set(apiKey);
      expect(anon.status).toBe(401);
      const missing = await request(app).get(`/api/stock-counts/nope-404/${suffix}`).set(auth(saToken));
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("STOCK_COUNT_NOT_FOUND");
    }
  });
});

// ─── Завершённая инвентаризация ──────────────────────────────────────────────

describe("акт завершённой инвентаризации", () => {
  beforeAll(async () => {
    const lines = await linesOf(countId);
    await decide(countId, lineId(lines, "D"), { decision: "ADJUST", note: "две банки не внесли в каталог" });
    // Пока шла инвентаризация, «Флоппи» докупили: 5 → 6. Поправка ляжет дельтой
    // к текущему значению (6 − 2 = 4), и акт должен напечатать записанное.
    await prisma.equipment.update({ where: { id: eq.B }, data: { totalQuantity: 6 } });
    const res = await request(app).post(`/api/stock-counts/${countId}/complete`).set(auth(saToken));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("решения — то, что записано: потеряшки, поправки по журналу, закрытые потеряшки", async () => {
    const { buildStockCountAct, stockCountActFileBase, actStamp } = await import(
      "../services/stockCount/act/buildStockCountAct"
    );
    const { fmtDayMonth } = await import("../services/stockCount/act/format");
    const act = await buildStockCountAct(countId);
    expect(act.status).toBe("CLOSED");
    expect(act.isDraft).toBe(false);
    expect(actStamp(act)).toBeNull();
    expect(stockCountActFileBase(act)).toBe("Акт инвентаризации № 1");
    expect(act.closedBy).toBe("sca_super");
    expect(act.docDate.getTime()).toBe(act.closedAt!.getTime());
    expect(act.summary.undecided).toBe(0);

    expect(rowByName(act, "Кабель 25 м")).toMatchObject({
      decisionLabel: "пропажа → «Северный ветер»",
      decisionState: "applied",
    });
    expect(rowByName(act, "Флоппи 48×48").decisionLabel).toBe("ошибка учёта: 6 → 4");
    expect(rowByName(act, "Удлинитель PCE 15 м").decisionLabel).toBe("пропажа → потеряшка");
    expect(rowByName(act, "Vmount").decisionLabel).toBe("ошибка учёта: 19 → 21");
    expect(rowByName(act, "Флаг 40×40").decisionLabel).toBe(
      `нашлось (потеряшка от ${fmtDayMonth(problemCreatedAt.C)})`,
    );
    expect(rowByName(act, "Рамка 12×12").decisionLabel).toBe(
      `нашлось 1 (потеряшка от ${fmtDayMonth(problemCreatedAt.H)}), ещё 2 без объяснения`,
    );
    expect(act.discrepancies.every((r) => r.decisionState === "applied")).toBe(true);
    expect(act.uncounted.map((r) => r.name)).toEqual(["Сэндбэг"]);
  });

  it("PDF и XLSX завершённого акта — без пометки «черновик» в имени", async () => {
    const pdf = await request(app).get(`/api/stock-counts/${countId}/act.pdf`).set(auth(saToken)).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("Акт инвентаризации № 1.pdf")}`,
    );
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect(pdfPageCount(pdf.body as Buffer)).toBe(1);

    const xlsx = await request(app).get(`/api/stock-counts/${countId}/act.xlsx`).set(auth(whToken)).buffer(true).parse(binary);
    expect(xlsx.status).toBe(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");
  });
});

// ─── Длинная инвентаризация: пагинация ───────────────────────────────────────

describe("длинный акт — страницы без пустых листов", () => {
  let longId: string;
  const LONG_LINES = 130;
  const UNCOUNTED = 10;

  beforeAll(async () => {
    for (let i = 0; i < LONG_LINES; i++) {
      await prisma.equipment.create({
        data: {
          importKey: `sca-long-${i}`,
          name: `Позиция массового склада № ${i + 1} с длинным названием, которое не помещается в одну строку колонки`,
          category: "Массовая",
          totalQuantity: 10,
          rentalRatePerShift: "300",
          stockTrackingMode: "COUNT",
          sortOrder: i,
        },
      });
    }
    const start = await request(app).post("/api/stock-counts").set(auth(saToken)).send({ categories: ["Массовая"] });
    expect(start.status).toBe(201);
    longId = start.body.stockCount.id;

    const { recordCount, decideLine } = await import("../services/stockCount/stockCountService");
    const lines = await prisma.stockCountLine.findMany({ where: { stockCountId: longId }, orderBy: { position: "asc" } });
    expect(lines).toHaveLength(LONG_LINES);
    for (let i = 0; i < LONG_LINES - UNCOUNTED; i++) {
      const discrepant = i % 5 === 0;
      await recordCount(longId, lines[i].id, discrepant ? 8 : 10, i % 2 === 0 ? "Иван" : "Олег");
      if (discrepant && i % 10 === 0) {
        await decideLine(
          longId,
          lines[i].id,
          {
            decision: "ADJUST",
            note: "Длинная причина поправки: при импорте каталога количество завели по старой накладной, пересчёт на полке это подтвердил, коробки сверены вдвоём.",
          },
          "sca_super",
        );
      }
    }
  });

  it("≥ 120 строк: несколько страниц, на каждой есть содержимое", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { renderStockCountActPdfDetailed } = await import("../services/stockCount/act/renderStockCountActPdf");
    const act = await buildStockCountAct(longId);
    expect(act.summary.lines).toBe(LONG_LINES);
    expect(act.discrepancies).toHaveLength(24);
    expect(act.matched).toHaveLength(96);
    expect(act.uncounted).toHaveLength(UNCOUNTED);
    expect(act.counters).toEqual(["Иван", "Олег"]);

    const { buffer, pageBlocks } = await renderStockCountActPdfDetailed(act);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    const pages = pdfPageCount(buffer);
    expect(pages).toBe(pageBlocks.length);
    expect(pages).toBeGreaterThanOrEqual(2);
    // 24 строки расхождений + 96 сошедшихся в две колонки + 10 непосчитанных —
    // это три-четыре листа; pdfkit с ненулевыми полями разносил бы на десяток.
    expect(pages).toBeLessThanOrEqual(5);
    expect(pageBlocks.every((n) => n > 0)).toBe(true);
  });

  it("300 длинных расхождений — таблица переносится, пустых страниц нет", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { renderStockCountActPdfDetailed } = await import("../services/stockCount/act/renderStockCountActPdf");
    const base = await buildStockCountAct(longId);
    const template = base.discrepancies[0];
    const discrepancies = Array.from({ length: 300 }, (_, i) => ({
      ...template,
      lineId: `synthetic-${i}`,
      name: `${template.name} · копия ${i + 1}`,
      note: i % 3 === 0 ? `${template.note ?? ""} ${"Очень подробное примечание. ".repeat(6)}` : template.note,
    }));
    const { buffer, pageBlocks } = await renderStockCountActPdfDetailed({ ...base, discrepancies });
    const pages = pdfPageCount(buffer);
    expect(pages).toBe(pageBlocks.length);
    expect(pages).toBeGreaterThan(5);
    expect(pages).toBeLessThanOrEqual(30);
    expect(pageBlocks.every((n) => n > 0)).toBe(true);
  });

  // Подписи — не содержимое: лист, на котором только «Пересчитали» и
  // «Руководитель», оторван от акта (подписанный лист можно подменить).
  it("подписи не уезжают одни на последний лист: 40 сошедшихся, без расхождений", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { renderStockCountActPdfDetailed } = await import("../services/stockCount/act/renderStockCountActPdf");
    const base = await buildStockCountAct(longId);
    const act = syntheticAct(base, { matched: 40, counters: ["Иван", "Олег"] });
    const { buffer, pageBlocks } = await renderStockCountActPdfDetailed(act);
    expect(pdfPageCount(buffer)).toBe(pageBlocks.length);
    expect(pageBlocks.every((n) => n > 0), `раскладка ${JSON.stringify(pageBlocks)}`).toBe(true);
  });

  it("подписи не уезжают одни на последний лист: 8–16 расхождений с длинными примечаниями", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { renderStockCountActPdfDetailed } = await import("../services/stockCount/act/renderStockCountActPdf");
    const base = await buildStockCountAct(longId);
    const template = base.discrepancies[0];
    // Около 11 строк таблица доходит до низа листа, и разделы 2–3 с подписями
    // оказываются на границе — диапазон, а не одно число, чтобы проверка не
    // зависела от точной высоты шапки.
    const bad: string[] = [];
    for (let n = 8; n <= 16; n++) {
      const discrepancies = Array.from({ length: n }, (_, i) => ({
        ...template,
        lineId: `synthetic-d-${i}`,
        name: `${template.name} · копия ${i + 1}`,
        note: `${template.note ?? ""} ${"Очень подробное примечание. ".repeat(6)}`,
      }));
      const { buffer, pageBlocks } = await renderStockCountActPdfDetailed(syntheticAct(base, { discrepancies }));
      if (pdfPageCount(buffer) !== pageBlocks.length || !pageBlocks.every((b) => b > 0)) {
        bad.push(`${n}: ${JSON.stringify(pageBlocks)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("подписи не уезжают одни на последний лист: перебор раскладок", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { renderStockCountActPdfDetailed } = await import("../services/stockCount/act/renderStockCountActPdf");
    const base = await buildStockCountAct(longId);
    const bad: string[] = [];
    for (let matched = 0; matched <= 90; matched++) {
      for (const uncounted of [0, 1, 2, 5, 40]) {
        const { buffer, pageBlocks } = await renderStockCountActPdfDetailed(
          syntheticAct(base, { matched, uncounted }),
        );
        if (pdfPageCount(buffer) !== pageBlocks.length || !pageBlocks.every((n) => n > 0)) {
          bad.push(`${matched}/${uncounted}: ${JSON.stringify(pageBlocks)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it("отменённая — метка «ОТМЕНЕНА», решения не применены", async () => {
    const cancel = await request(app).post(`/api/stock-counts/${longId}/cancel`).set(auth(saToken));
    expect(cancel.status).toBe(200);
    const { buildStockCountAct, actStamp, actStatusNotes, stockCountActFileBase } = await import(
      "../services/stockCount/act/buildStockCountAct"
    );
    const act = await buildStockCountAct(longId);
    expect(act.status).toBe("CANCELLED");
    expect(actStamp(act)).toBe("ОТМЕНЕНА");
    expect(stockCountActFileBase(act)).toBe("Акт инвентаризации № 2 — отменена");
    expect(actStatusNotes(act)[0]).toContain("решения не применялись");
    expect(act.discrepancies.some((r) => r.decisionState === "applied")).toBe(false);

    const res = await request(app).get(`/api/stock-counts/${longId}/act.pdf`).set(auth(saToken)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("Акт инвентаризации № 2 — отменена.pdf")}`,
    );
  });
});

// ─── Позиция удалена из каталога: акт говорит то, что записано ───────────────

describe("позиция удалена из каталога — до и после завершения", () => {
  let delId: string;
  const lineIds: Record<string, string> = {};
  const DELETED_LATER = " (позиция позже удалена из каталога)";

  beforeAll(async () => {
    // Типичная первая инвентаризация: дубль строки импорта сводят к нулю, потом
    // удаляют из каталога. «Списанный» удаляют ещё до завершения.
    await createEquipment("DUP", "Дубль из импорта", "Удаление", 2, 1);
    await createEquipment("GONE", "Пропавший прибор", "Удаление", 3, 2);
    await createEquipment("FND", "Найденный штатив", "Удаление", 2, 3);
    await createEquipment("EARLY", "Списанный до завершения", "Удаление", 4, 4);
    await openProblem("FND", 1, 5);

    const start = await request(app).post("/api/stock-counts").set(auth(saToken)).send({ categories: ["Удаление"] });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    delId = start.body.stockCount.id;
    const lines = await linesOf(delId);
    for (const key of ["DUP", "GONE", "FND", "EARLY"]) lineIds[key] = lineId(lines, key);

    const counts: Array<[string, number]> = [
      ["DUP", 0],
      ["GONE", 1],
      ["FND", 2],
      ["EARLY", 3],
    ];
    for (const [key, qty] of counts) {
      const res = await request(app)
        .post(`/api/stock-counts/${delId}/lines/${lineIds[key]}/count`)
        .set(auth(saToken))
        .send({ qty });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    await decide(delId, lineIds.DUP, { decision: "ADJUST", note: "дубль строки из импорта" });
    await decide(delId, lineIds.GONE, { decision: "LOST" });
    await decide(delId, lineIds.FND, { decision: "FOUND" });
  });

  it("черновик: удалённая без решения видна как «решение не принято» и совпадает с «Без решения»", async () => {
    const { buildStockCountAct, actStatusNotes } = await import("../services/stockCount/act/buildStockCountAct");
    await prisma.equipment.delete({ where: { id: eq.EARLY } });

    const draft = await buildStockCountAct(delId);
    expect(draft.summary.undecided).toBe(1);
    expect(rowByName(draft, "Списанный до завершения")).toMatchObject({
      equipmentId: null,
      decisionLabel: "позиция удалена из каталога — решение не принято",
      decisionState: "none",
    });
    expect(draft.discrepancies.filter((r) => r.decisionState === "none").length).toBe(draft.summary.undecided);
    expect(actStatusNotes(draft)[0]).toContain("Без решения: 1 расхождение");

    // Решение есть — строка больше не ждёт, но эффектов не даст.
    await decide(delId, lineIds.EARLY, { decision: "ADJUST", note: "списан до конца счёта" });
    const decided = await buildStockCountAct(delId);
    expect(decided.summary.undecided).toBe(0);
    expect(rowByName(decided, "Списанный до завершения")).toMatchObject({
      decisionLabel: "позиция удалена из каталога",
      decisionState: "skipped",
    });
  });

  it("завершённая: удалённая до завершения — «без последствий», остальные применены", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { fmtDayMonth } = await import("../services/stockCount/act/format");
    const res = await request(app).post(`/api/stock-counts/${delId}/complete`).set(auth(saToken));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const act = await buildStockCountAct(delId);
    expect(rowByName(act, "Дубль из импорта")).toMatchObject({
      decisionLabel: "ошибка учёта: 2 → 0",
      decisionState: "applied",
    });
    expect(rowByName(act, "Пропавший прибор")).toMatchObject({
      decisionLabel: "пропажа → потеряшка",
      decisionState: "applied",
    });
    expect(rowByName(act, "Найденный штатив")).toMatchObject({
      decisionLabel: `нашлось (потеряшка от ${fmtDayMonth(problemCreatedAt.FND)})`,
      decisionState: "applied",
    });
    expect(rowByName(act, "Списанный до завершения")).toMatchObject({
      decisionLabel: "позиция удалена из каталога — без последствий",
      decisionState: "skipped",
    });
  });

  it("позиции удалили после завершения — акт по-прежнему говорит, что записано", async () => {
    const { buildStockCountAct } = await import("../services/stockCount/act/buildStockCountAct");
    const { fmtDayMonth } = await import("../services/stockCount/act/format");
    for (const key of ["DUP", "GONE", "FND"]) await prisma.equipment.delete({ where: { id: eq[key] } });

    // Записанное никуда не делось: поправка в журнале, потеряшка ищется.
    const audits = await prisma.auditEntry.findMany({ where: { action: "STOCK_ADJUST", entityId: eq.DUP } });
    expect(audits).toHaveLength(1);
    const lost = await prisma.problemItem.findMany({ where: { stockCountId: delId, source: "STOCK_COUNT" } });
    expect(lost.map((p: any) => [p.equipmentId, p.quantity, p.status])).toEqual([[null, 2, "SEARCHING"]]);

    const act = await buildStockCountAct(delId);
    expect(rowByName(act, "Дубль из импорта")).toMatchObject({
      equipmentId: null,
      decisionLabel: `ошибка учёта: 2 → 0${DELETED_LATER}`,
      decisionState: "applied",
    });
    expect(rowByName(act, "Пропавший прибор")).toMatchObject({
      equipmentId: null,
      decisionLabel: `пропажа → потеряшка${DELETED_LATER}`,
      decisionState: "applied",
    });
    expect(rowByName(act, "Найденный штатив")).toMatchObject({
      equipmentId: null,
      decisionLabel: `нашлось (потеряшка от ${fmtDayMonth(problemCreatedAt.FND)})${DELETED_LATER}`,
      decisionState: "applied",
    });
    // Удалённая до завершения — без последствий: улик нет и быть не может.
    expect(rowByName(act, "Списанный до завершения")).toMatchObject({
      decisionLabel: "позиция удалена из каталога — без последствий",
      decisionState: "skipped",
    });
  });
});
