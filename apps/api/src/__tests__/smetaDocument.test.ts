import { describe, it, expect } from "vitest";
import { PassThrough } from "stream";
import Decimal from "decimal.js";
import PDFDocument from "pdfkit";

import {
  buildSmetaFromPersistedEstimate,
  clientSafeComment,
  smetaOrgFromSettings,
} from "../services/smetaExport/buildDocument";
import { buildFullSmeta } from "../services/smetaExport/buildFullDocument";
import { writeFullSmetaPdf } from "../services/smetaExport/renderFullPdf";

const SETTINGS = {
  legalName: "ИП Сеченов Виталий Андреевич",
  inn: "771577899514",
  kpp: null,
  bankName: 'АО "АЛЬФА-БАНК"',
  bankBik: "044525593",
  rschet: "40802810202810000838",
  kschet: "30101810200000000593",
  address: "Москва, ул. Илимская, 6",
  phone: "+79100003787",
  email: "mail@example.com",
};

function mkEstimate(over: Partial<Record<string, unknown>> = {}) {
  return {
    shifts: 2,
    createdAt: new Date("2026-05-14T09:00:00Z"),
    subtotal: new Decimal(30000),
    discountPercent: new Decimal(50),
    discountAmount: new Decimal(15000),
    totalAfterDiscount: new Decimal(15000),
    commentSnapshot: null,
    optionalNote: null,
    includeOptionalInExport: false,
    hoursSummaryText: null,
    lines: [
      {
        categorySnapshot: "COB Light",
        nameSnapshot: "Aputure LS 1200x",
        quantity: 2,
        unitPrice: new Decimal(14000),
        lineSum: new Decimal(28000),
        listUnitPrice: null,
      },
    ],
    ...over,
  } as Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"];
}

const BOOKING = {
  startDate: new Date("2026-06-01T07:00:00Z"),
  endDate: new Date("2026-06-03T07:00:00Z"),
  projectName: "Клип «Лето»",
  comment: null,
  client: { name: "Студия «Пикчер»" },
  docNumber: "СМ-2026-0042",
  expectedPaymentDate: new Date("2026-06-10T00:00:00Z"),
};

describe("смета как платёжный документ", () => {
  it("реквизиты для оплаты доходят до документа", () => {
    // Лист называет сумму к оплате — и обязан сказать, куда её платить.
    // Раньше тип реквизитов знал только пять полей из тринадцати.
    const org = smetaOrgFromSettings(SETTINGS);
    expect(org.bankName).toBe('АО "АЛЬФА-БАНК"');
    expect(org.bankBik).toBe("044525593");
    expect(org.rschet).toBe("40802810202810000838");
    expect(org.kschet).toBe("30101810200000000593");
  });

  it("номер и дата составления берутся из брони и сметы, а не из «сегодня»", () => {
    // Скачали в мае, переслали в августе — документ обязан выглядеть так же.
    const doc = buildSmetaFromPersistedEstimate({ booking: BOOKING, estimate: mkEstimate() });
    expect(doc.docNumber).toBe("СМ-2026-0042");
    expect(doc.issuedAtLabel).toMatch(/мая 2026/);
    expect(doc.paymentDueLabel).toMatch(/июня 2026/);
  });

  it("число смен доезжает до реквизитов документа", () => {
    // Без него строка «14 000 ₽ × 2 = 28 000 ₽» на двухсменной брони читается
    // как арифметическая ошибка.
    const doc = buildSmetaFromPersistedEstimate({ booking: BOOKING, estimate: mkEstimate() });
    expect(doc.shiftsCount).toBe(2);
  });

  it("служебный комментарий импорта на клиентский лист не попадает", () => {
    expect(clientSafeComment("[hard-reset-2026-05-25] from xlsx files/28.02 куб.xlsx")).toBeNull();
    expect(clientSafeComment("Imported from Смета SvetoBaza 02.2026.xlsx")).toBeNull();
    expect(clientSafeComment("  ")).toBeNull();
    expect(clientSafeComment("Погрузка со двора")).toBe("Погрузка со двора");
  });

  it("плашка просчёта часов не заполняется шаблонной фразой", () => {
    // Число смен теперь стоит отдельной ячейкой, и фолбэк «1 смена = 24 ч»
    // повторял её же, занимая треть первого экрана.
    const doc = buildSmetaFromPersistedEstimate({ booking: BOOKING, estimate: mkEstimate() });
    expect(doc.hourCalculationText).toBe("");

    const withText = buildSmetaFromPersistedEstimate({
      booking: BOOKING,
      estimate: mkEstimate({ hoursSummaryText: "2 смены = 24 ч. · 1 сут. 8 ч." }),
    });
    expect(withText.hourCalculationText).toBe("2 смены = 24 ч. · 1 сут. 8 ч.");
  });

  it("договорной итог доезжает до документа отдельно от расчётного", () => {
    // Счёт договорную сумму уже чтит; без неё смета спорила бы со счётом.
    const full = buildFullSmeta({
      booking: { ...BOOKING, vehicles: [] },
      main: mkEstimate(),
      addon: null,
      agreedTotal: new Decimal(14000),
    });
    expect(full.grandTotal).toBe("15000");
    expect(full.agreedTotal).toBe("14000");
  });

  it("без договорного итога поле пустое — подменять нечего", () => {
    const full = buildFullSmeta({
      booking: { ...BOOKING, vehicles: [] },
      main: mkEstimate(),
      addon: null,
    });
    expect(full.agreedTotal).toBeNull();
  });

  it("транспорт входит в расчётный итог", () => {
    const full = buildFullSmeta({
      booking: {
        ...BOOKING,
        vehicles: [
          {
            withGenerator: true,
            shiftHours: 12,
            kmOutsideMkad: 40,
            ttkEntry: false,
            subtotalRub: new Decimal(15400),
            vehicle: { name: "Ивеко" },
          },
        ],
      },
      main: mkEstimate(),
      addon: null,
    });
    expect(full.transport?.subtotal).toBe("15400");
    expect(full.transport?.lines[0].details).toBe("с генератором · смена 12 ч · за МКАД 40 км");
    expect(full.grandTotal).toBe("30400");
  });

  it("у доб-сметы свой номер — два документа под одним не различить", () => {
    const addon = buildSmetaFromPersistedEstimate({
      booking: BOOKING,
      estimate: mkEstimate({ kind: "ADDON" }),
    });
    expect(addon.docNumber).toBe("СМ-2026-0042/д");
    expect(addon.documentTitleRu).toBe("Смета-добор");
  });

  it("договорная сумма печатается и без добора, и без транспорта", async () => {
    // Самый частый случай: обычная бронь, где итог зафиксировали вручную.
    // Общий блок итога включался только при доборе или транспорте, поэтому
    // лист печатал расчётную сумму и спорил со счётом — тот договорную чтит.
    const drawn: string[] = [];
    const proto = PDFDocument.prototype as unknown as { text: (...a: unknown[]) => unknown };
    const original = proto.text;
    proto.text = function patched(t: unknown, ...rest: unknown[]) {
      if (typeof t === "string") drawn.push(t);
      return original.call(this, t, ...rest);
    };

    try {
      const full = buildFullSmeta({
        booking: { ...BOOKING, vehicles: [] },
        main: mkEstimate(),
        addon: null,
        org: smetaOrgFromSettings(SETTINGS),
        agreedTotal: new Decimal(9000),
      });

      const stream = new PassThrough();
      stream.resume();
      const done = new Promise<void>((resolve) => stream.on("end", () => resolve()));
      const res = Object.assign(stream, { setHeader: () => {}, status: () => res });
      writeFullSmetaPdf(res as never, full, "test");
      await done;
    } finally {
      proto.text = original;
    }

    const money = drawn.filter((t) => t.includes("₽"));
    expect(drawn).toContain("ИТОГО К ОПЛАТЕ");
    expect(drawn).toContain("Итого по расчёту");
    expect(money.some((t) => /9\s?000/.test(t))).toBe(true);
    // Последняя денежная строка — сумма в акцентной плашке.
    expect(money[money.length - 1]).toMatch(/9\s?000/);
    // Реквизиты для оплаты нужны независимо от состава сметы.
    expect(drawn).toContain("РЕКВИЗИТЫ ДЛЯ ОПЛАТЫ");
  });
});
