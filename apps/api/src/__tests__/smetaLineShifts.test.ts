/**
 * Смета читает смены строки (EstimateLine.shifts).
 *
 * - Старые снимки (shifts пустой у всех строк) печатаются как раньше.
 * - Строка, посчитанная на своё число смен, делит цену на СВОИ смены, и в PDF
 *   появляется колонка «Смен», в XLSX — подпись «на N смен» у названия.
 * - Своя позиция (вне каталога) на смены не делится: её цена — за весь срок.
 *   Раньше в брони на 2 смены колонка «цена / смена» печатала её половину.
 */

import { describe, it, expect } from "vitest";
import { PassThrough } from "stream";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

import { buildSmetaFromPersistedEstimate, lineShiftsNote } from "../services/smetaExport/buildDocument";
import { writeSmetaPdf } from "../services/smetaExport/renderPdf";
import { addSmetaSheetToWorkbook } from "../services/smetaExport/renderXlsx";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Без зашитых календарных дат: от ровного часа через неделю.
const START = new Date(Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR);

type Line = {
  equipmentId?: string | null;
  categorySnapshot: string;
  nameSnapshot: string;
  quantity: number;
  unitPrice: Decimal;
  lineSum: Decimal;
  listUnitPrice?: Decimal | null;
  shifts?: number | null;
};

function doc(shifts: number, lines: Line[]) {
  const total = lines.reduce((s, l) => s.add(l.lineSum), new Decimal(0));
  return buildSmetaFromPersistedEstimate({
    booking: {
      startDate: START,
      endDate: new Date(START.getTime() + shifts * DAY),
      projectName: "Реклама кофейни «Зерно»",
      comment: null,
      client: { name: "Продакшн «Сфера»" },
      docNumber: "СМ-0001",
    },
    estimate: {
      shifts,
      subtotal: total,
      discountPercent: null,
      discountAmount: new Decimal(0),
      totalAfterDiscount: total,
      commentSnapshot: null,
      optionalNote: null,
      includeOptionalInExport: false,
      hoursSummaryText: null,
      lines,
    },
  });
}

const catalog = (name: string, perShift: number, shifts: number, extra: Partial<Line> = {}): Line => ({
  equipmentId: `eq-${name}`,
  categorySnapshot: "Свет",
  nameSnapshot: name,
  quantity: 1,
  unitPrice: new Decimal(perShift * shifts),
  lineSum: new Decimal(perShift * shifts),
  listUnitPrice: null,
  ...extra,
});

describe("сборка сметы: смены строки", () => {
  it("старый снимок без смен по строкам — как раньше", () => {
    const d = doc(2, [catalog("Aputure LS 60x", 1200, 2)]);
    expect(d.showShiftsColumn).toBe(false);
    expect(d.lines[0].pricePerShift).toBe("1200.00");
    expect(d.lines[0].shifts).toBe(2);
  });

  it("позиция на 3 смены в брони на 2 — цена делится на свои смены, колонка нужна", () => {
    const d = doc(2, [
      catalog("Aputure STORM 400x", 4000, 3, { shifts: 3, listUnitPrice: new Decimal(15000) }),
      catalog("Стойка C-Stand", 300, 2, { shifts: 2 }),
    ]);
    expect(d.showShiftsColumn).toBe(true);
    const storm = d.lines.find((l) => l.name === "Aputure STORM 400x")!;
    expect(storm.pricePerShift).toBe("4000.00");
    expect(storm.listPricePerShift).toBe("5000.00");
    expect(storm.shifts).toBe(3);
  });

  it("своя позиция в брони на 2 смены не делится пополам", () => {
    const d = doc(2, [
      { ...catalog("Расходники", 0, 1), equipmentId: null, categorySnapshot: "Произвольная позиция", unitPrice: new Decimal(1500), lineSum: new Decimal(1500) },
    ]);
    expect(d.lines[0].pricePerShift).toBe("1500.00");
    expect(d.lines[0].shifts).toBeNull();
    // Своя позиция колонку «Смен» не включает: она про каталожные строки.
    expect(d.showShiftsColumn).toBe(false);
  });

  it("строка без equipmentId в данных (не выбран из базы) своей позицией не считается", () => {
    const line = catalog("Старый снимок", 1000, 2);
    delete line.equipmentId;
    expect(doc(2, [line]).lines[0].pricePerShift).toBe("1000.00");
  });
});

describe("подпись срока строки", () => {
  it("своя позиция многосменной брони — «цена за весь срок аренды», односменной — без подписи", () => {
    expect(lineShiftsNote({ shifts: null }, { shiftsCount: 2, showShiftsColumn: false }, { withCount: false })).toBe(
      "цена за весь срок аренды",
    );
    expect(lineShiftsNote({ shifts: null }, { shiftsCount: 1, showShiftsColumn: false }, { withCount: true })).toBeNull();
  });

  it("каталожная строка со своими сменами подписывается только там, где нет колонки", () => {
    const d = { shiftsCount: 1, showShiftsColumn: true };
    expect(lineShiftsNote({ shifts: 2 }, d, { withCount: true })).toBe("на 2 смены");
    expect(lineShiftsNote({ shifts: 5 }, d, { withCount: true })).toBe("на 5 смен");
    expect(lineShiftsNote({ shifts: 1 }, d, { withCount: true })).toBeNull();
    expect(lineShiftsNote({ shifts: 2 }, d, { withCount: false })).toBeNull();
  });
});

async function drawnPdfText(data: ReturnType<typeof doc>): Promise<string[]> {
  const drawn: string[] = [];
  const proto = PDFDocument.prototype as unknown as { text: (...a: unknown[]) => unknown };
  const original = proto.text;
  proto.text = function patched(t: unknown, ...rest: unknown[]) {
    if (typeof t === "string") drawn.push(t);
    return original.call(this, t, ...rest);
  };
  try {
    const stream = new PassThrough();
    stream.resume();
    const done = new Promise<void>((resolve) => stream.on("end", () => resolve()));
    const res = Object.assign(stream, { setHeader: () => {}, status: () => res });
    writeSmetaPdf(res as never, data, "test");
    await done;
  } finally {
    proto.text = original;
  }
  return drawn;
}

describe("PDF", () => {
  it("колонка «Смен» и «Смен по брони» — только когда у строк разные смены", async () => {
    const mixed = await drawnPdfText(
      doc(1, [catalog("Aputure STORM 400x", 4000, 2, { shifts: 2 }), catalog("Стойка C-Stand", 300, 1, { shifts: 1 })]),
    );
    expect(mixed).toContain("СМЕН");
    expect(mixed).toContain("СМЕН ПО БРОНИ");

    const plain = await drawnPdfText(doc(2, [catalog("Aputure LS 60x", 1200, 2)]));
    expect(plain).not.toContain("СМЕН");
    expect(plain).toContain("СМЕН В ПЕРИОДЕ");
  });

  it("своя позиция многосменной брони подписана «цена за весь срок аренды»", async () => {
    const drawn = await drawnPdfText(
      doc(2, [
        catalog("Aputure LS 60x", 1200, 2),
        { ...catalog("Расходники", 0, 1), equipmentId: null, categorySnapshot: "Произвольная позиция", unitPrice: new Decimal(1500), lineSum: new Decimal(1500) },
      ]),
    );
    expect(drawn).toContain("цена за весь срок аренды");
  });
});

describe("XLSX", () => {
  it("строка со своими сменами подписана «на N смены», в шапке — «Смен по брони»", () => {
    const wb = new ExcelJS.Workbook();
    const { sheet } = addSmetaSheetToWorkbook(
      wb,
      doc(1, [catalog("Aputure STORM 400x", 4000, 2, { shifts: 2 }), catalog("Стойка C-Stand", 300, 1, { shifts: 1 })]),
      "Смета",
    );
    const values: string[] = [];
    sheet.eachRow((row) => row.eachCell((c) => values.push(String(c.value ?? ""))));
    expect(values).toContain("Aputure STORM 400x\nна 2 смены");
    expect(values).toContain("Стойка C-Stand");
    expect(values).toContain("СМЕН ПО БРОНИ");
  });
});
