import { describe, expect, test } from "vitest";

import {
  daysOverdue,
  filtersToQueryString,
  formatBookingPeriod,
  paymentPill,
  paymentTooltip,
  readListFiltersFromParams,
  type BookingListFilters,
  type PaymentPillInput,
} from "../bookingListHelpers";
import { formatRub } from "../../../lib/format";

const NOW = new Date("2026-07-03T12:00:00.000Z").getTime();

function pillInput(overrides: Partial<PaymentPillInput> = {}): PaymentPillInput {
  return {
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
    amountOutstanding: "100000",
    finalAmount: "100000",
    expectedPaymentDate: null,
    ...overrides,
  };
}

describe("readListFiltersFromParams", () => {
  test("читает все фильтры из URL", () => {
    const params = new URLSearchParams(
      "status=ISSUED&paid=UNPAID&from=2026-06-01&to=2026-06-30&q=мосфильм"
    );
    expect(readListFiltersFromParams(params)).toEqual({
      status: "ISSUED",
      paid: "UNPAID",
      from: "2026-06-01",
      to: "2026-06-30",
      q: "мосфильм",
    });
  });

  test("мусорные status и paid отбрасываются (иначе сервер вернул бы 400)", () => {
    const params = new URLSearchParams("status=GARBAGE&paid=MAYBE");
    const f = readListFiltersFromParams(params);
    expect(f.status).toBe("");
    expect(f.paid).toBe("");
  });

  test("null params → пустые фильтры", () => {
    expect(readListFiltersFromParams(null)).toEqual({
      status: "",
      paid: "",
      from: "",
      to: "",
      q: "",
    });
  });
});

describe("filtersToQueryString", () => {
  test("пустые значения опускаются, q триммится", () => {
    const f: BookingListFilters = { status: "", paid: "PAID", from: "", to: "", q: "  свет  " };
    expect(filtersToQueryString(f)).toBe("paid=PAID&q=%D1%81%D0%B2%D0%B5%D1%82");
  });

  test("полностью пустые фильтры → пустая строка", () => {
    expect(filtersToQueryString({ status: "", paid: "", from: "", to: "", q: "" })).toBe("");
  });

  test("roundtrip: сериализация → чтение возвращает те же фильтры", () => {
    const f: BookingListFilters = {
      status: "CONFIRMED",
      paid: "UNPAID",
      from: "2026-06-01",
      to: "2026-06-30",
      q: "проект",
    };
    expect(readListFiltersFromParams(new URLSearchParams(filtersToQueryString(f)))).toEqual(f);
  });
});

describe("formatBookingPeriod", () => {
  test("многодневная аренда — период «дд.мм — дд.мм.гггг»", () => {
    expect(formatBookingPeriod("2026-07-01T09:00:00.000Z", "2026-07-10T18:00:00.000Z")).toBe(
      "01.07 — 10.07.2026"
    );
  });

  test("однодневная бронь — одиночная дата", () => {
    expect(formatBookingPeriod("2026-07-01T06:00:00.000Z", "2026-07-01T18:00:00.000Z")).toBe(
      "01.07.2026"
    );
  });

  test("разные годы — год у обеих дат", () => {
    expect(formatBookingPeriod("2026-12-30T09:00:00.000Z", "2027-01-02T18:00:00.000Z")).toBe(
      "30.12.2026 — 02.01.2027"
    );
  });
});

describe("daysOverdue", () => {
  test("0 если дата не задана или не наступила", () => {
    expect(daysOverdue(null, NOW)).toBe(0);
    expect(daysOverdue("2026-07-10T00:00:00.000Z", NOW)).toBe(0);
  });

  test("считает целые дни просрочки", () => {
    expect(daysOverdue("2026-06-30T12:00:00.000Z", NOW)).toBe(3);
  });
});

describe("paymentPill", () => {
  test("PAID → «Оплачено» (ok)", () => {
    const pill = paymentPill(pillInput({ paymentStatus: "PAID", amountPaid: "100000", amountOutstanding: "0" }), NOW);
    expect(pill).toEqual({ variant: "ok", label: "Оплачено", sub: null });
  });

  test("частичная оплата → «Частично» (amber) с суммами N из M", () => {
    const pill = paymentPill(
      pillInput({
        paymentStatus: "PARTIALLY_PAID",
        amountPaid: "40000",
        amountOutstanding: "60000",
        finalAmount: "100000",
      }),
      NOW
    );
    expect(pill.variant).toBe("warn");
    expect(pill.label).toBe("Частично");
    expect(pill.sub).toBe(`${formatRub("40000")} из ${formatRub("100000")}`);
  });

  test("частичная оплата распознаётся по суммам даже без enum PARTIALLY_PAID", () => {
    // Семантика: amountPaid > 0 && amountOutstanding > 0 — клиент с 90%
    // предоплаты не должен выглядеть как не заплативший ни рубля.
    const pill = paymentPill(
      pillInput({ paymentStatus: "NOT_PAID", amountPaid: "90000", amountOutstanding: "10000" }),
      NOW
    );
    expect(pill.variant).toBe("warn");
    expect(pill.label).toBe("Частично");
  });

  test("не оплачено без просрочки → серая «Не оплачено»", () => {
    const pill = paymentPill(pillInput(), NOW);
    expect(pill).toEqual({ variant: "none", label: "Не оплачено", sub: null });
  });

  test("просрочка по expectedPaymentDate → alert", () => {
    const pill = paymentPill(pillInput({ expectedPaymentDate: "2026-06-01T00:00:00.000Z" }), NOW);
    expect(pill.variant).toBe("alert");
  });

  test("серверный OVERDUE без expectedPaymentDate → alert (не серый)", () => {
    // Регрессия: раньше окраска считалась только от expectedPaymentDate на
    // клиенте, и OVERDUE без даты выглядел нейтрально.
    const pill = paymentPill(pillInput({ paymentStatus: "OVERDUE" }), NOW);
    expect(pill.variant).toBe("alert");
    expect(pill.label).toBe("Не оплачено");
  });

  test("частичная оплата остаётся amber даже при просрочке", () => {
    const pill = paymentPill(
      pillInput({
        paymentStatus: "OVERDUE",
        amountPaid: "40000",
        amountOutstanding: "60000",
        expectedPaymentDate: "2026-06-01T00:00:00.000Z",
      }),
      NOW
    );
    expect(pill.variant).toBe("warn");
    expect(pill.label).toBe("Частично");
  });
});

describe("paymentTooltip", () => {
  test("PAID → «Платёж получен»", () => {
    expect(paymentTooltip(pillInput({ paymentStatus: "PAID" }), NOW)).toBe("Платёж получен");
  });

  test("просрочка → дни с русской плюрализацией", () => {
    expect(paymentTooltip(pillInput({ expectedPaymentDate: "2026-06-30T12:00:00.000Z" }), NOW)).toBe(
      "Просрочено на 3 дня"
    );
  });

  test("срок оплаты в будущем → дата", () => {
    expect(paymentTooltip(pillInput({ expectedPaymentDate: "2026-07-10T00:00:00.000Z" }), NOW)).toBe(
      "Срок оплаты: 10.07.2026"
    );
  });

  test("частичная оплата без срока → «Частично оплачено»", () => {
    expect(
      paymentTooltip(pillInput({ amountPaid: "40000", amountOutstanding: "60000" }), NOW)
    ).toBe("Частично оплачено");
  });

  test("ничего не внесено и срока нет → «Не оплачено»", () => {
    expect(paymentTooltip(pillInput(), NOW)).toBe("Не оплачено");
  });
});
