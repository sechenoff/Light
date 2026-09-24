/**
 * Порядок строк в документах сметы: по каталогу (категории как на
 * /equipment/manage, внутри — sortOrder, произвольные позиции — в конце), а
 * номер строки — в порядке печати, в PDF и XLSX одинаково.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";

import { buildSmetaFromPersistedEstimate } from "../services/smetaExport/buildDocument";
import { buildFullSmeta } from "../services/smetaExport/buildFullDocument";
import { addSmetaSheetToWorkbook } from "../services/smetaExport/renderXlsx";
import type { LineOrdering } from "../services/lineOrder";
import type { SmetaExportDocument } from "../services/smetaExport/types";

const ordering: LineOrdering = {
  categoryOrder: ["COB Light", "Грип"],
  sortOrderById: new Map([
    ["storm", 1],
    ["ls1200", 2],
    ["cstand", 1],
    ["flag", 2],
  ]),
};

function line(equipmentId: string | null, categorySnapshot: string, nameSnapshot: string) {
  return {
    equipmentId,
    categorySnapshot,
    nameSnapshot,
    quantity: 1,
    unitPrice: new Decimal(1000),
    lineSum: new Decimal(1000),
    listUnitPrice: null,
  };
}

// Порядок добавления: вперемешку, произвольная позиция — посередине.
const MIXED_LINES = [
  line("flag", "Грип", "Флаг 4x4"),
  line("ls1200", "COB Light", "Aputure LS 1200x"),
  line(null, "Произвольная позиция", "Доставка на площадку"),
  line("cstand", "Грип", "C-стенд"),
  line("storm", "COB Light", "Electric Storm 52XT"),
];

function mkEstimate(lines = MIXED_LINES) {
  return {
    shifts: 1,
    subtotal: new Decimal(5000),
    discountPercent: new Decimal(0),
    discountAmount: new Decimal(0),
    totalAfterDiscount: new Decimal(5000),
    commentSnapshot: null,
    optionalNote: null,
    includeOptionalInExport: false,
    hoursSummaryText: null,
    lines,
  } as unknown as Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"];
}

const BOOKING = {
  startDate: new Date("2026-06-01T07:00:00Z"),
  endDate: new Date("2026-06-02T07:00:00Z"),
  projectName: "Клип",
  comment: null,
  client: { name: "Студия" },
};

const EXPECTED_ORDER = [
  "Electric Storm 52XT",
  "Aputure LS 1200x",
  "C-стенд",
  "Флаг 4x4",
  "Доставка на площадку",
];

describe("смета: порядок строк по каталогу", () => {
  it("buildSmetaFromPersistedEstimate расставляет строки по каталогу и нумерует после сортировки", () => {
    const doc = buildSmetaFromPersistedEstimate({ booking: BOOKING, estimate: mkEstimate(), ordering });
    expect(doc.lines.map((l) => l.name)).toEqual(EXPECTED_ORDER);
    expect(doc.lines.map((l) => l.index)).toEqual([1, 2, 3, 4, 5]);
    expect(doc.lines.map((l) => l.category)).toEqual([
      "COB Light",
      "COB Light",
      "Грип",
      "Грип",
      "Произвольная позиция",
    ]);
  });

  it("без порядка каталога строки всё равно идут подряд по категориям, и № совпадает с печатью", () => {
    const doc = buildSmetaFromPersistedEstimate({ booking: BOOKING, estimate: mkEstimate() });
    expect(doc.lines.map((l) => l.name)).toEqual([
      "Флаг 4x4",
      "C-стенд",
      "Aputure LS 1200x",
      "Electric Storm 52XT",
      "Доставка на площадку",
    ]);
    expect(doc.lines.map((l) => l.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("buildFullSmeta упорядочивает и основную смету, и добор", () => {
    const addonLines = [
      line("cstand", "Грип", "C-стенд"),
      line("storm", "COB Light", "Electric Storm 52XT"),
    ];
    const full = buildFullSmeta({
      booking: BOOKING,
      main: mkEstimate(),
      addon: mkEstimate(addonLines),
      ordering,
    });
    expect(full.main.lines.map((l) => l.name)).toEqual(EXPECTED_ORDER);
    expect(full.addon?.lines.map((l) => l.name)).toEqual(["Electric Storm 52XT", "C-стенд"]);
    expect(full.addon?.lines.map((l) => l.index)).toEqual([1, 2]);
  });

  it("XLSX нумерует строки в порядке печати, даже если категории пришли вперемешку", () => {
    const base = buildSmetaFromPersistedEstimate({ booking: BOOKING, estimate: mkEstimate([]) });
    // Документ со строками вне порядка категорий: рендерер сгруппирует их, и
    // № обязан идти 1, 2, 3 по листу, а не 1, 3, 2 по исходному индексу.
    const doc: SmetaExportDocument = {
      ...base,
      lines: [
        { index: 1, name: "Флаг 4x4", category: "Грип", quantity: 1, pricePerShift: "1000.00", lineSum: "1000.00" },
        { index: 2, name: "Aputure LS 1200x", category: "COB Light", quantity: 1, pricePerShift: "1000.00", lineSum: "1000.00" },
        { index: 3, name: "C-стенд", category: "Грип", quantity: 1, pricePerShift: "1000.00", lineSum: "1000.00" },
      ],
    };
    const wb = new ExcelJS.Workbook();
    const { sheet } = addSmetaSheetToWorkbook(wb, doc, "Смета");

    const printed: Array<{ index: unknown; name: unknown }> = [];
    const names = new Set(doc.lines.map((l) => l.name));
    sheet.eachRow((row) => {
      const name = row.getCell(2).value;
      if (typeof name === "string" && names.has(name)) printed.push({ index: row.getCell(1).value, name });
    });
    expect(printed).toEqual([
      { index: 1, name: "Флаг 4x4" },
      { index: 2, name: "C-стенд" },
      { index: 3, name: "Aputure LS 1200x" },
    ]);
  });
});
