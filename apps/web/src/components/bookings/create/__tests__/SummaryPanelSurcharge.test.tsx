/**
 * Надбавка за безналичный расчёт в панели «Расчёт»: строка «Безналичный расчёт
 * (+N %)» и итог с надбавкой — по ответу сервера и в предварительном расчёте.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { SummaryPanel } from "../SummaryPanel";
import type { QuoteResponse } from "../types";

const digitsOf = (s: string) => s.replace(/\D/g, "");

function quoteWith(extra: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    shifts: 2,
    subtotal: "10000",
    discountPercent: "0",
    discountAmount: "0",
    totalAfterDiscount: "10000",
    equipmentSubtotal: "10000",
    equipmentTotal: "10000",
    transportSubtotal: "0",
    grandTotal: "10000.00",
    lines: [],
    ...extra,
  } as unknown as QuoteResponse;
}

function renderPanel(props: Partial<React.ComponentProps<typeof SummaryPanel>> = {}) {
  return render(
    <SummaryPanel
      quote={null}
      localSubtotal={10000}
      localListedSubtotal={10000}
      localNegotiatedSubtotal={0}
      localDiscount={0}
      localTotal={10000}
      discountPercent={0}
      itemCount={1}
      shifts={2}
      checks={[]}
      isLoadingQuote={false}
      canSubmit={false}
      {...props}
    />,
  );
}

describe("SummaryPanel — надбавка за безнал", () => {
  it("по ответу сервера показывает строку и итог с надбавкой", () => {
    renderPanel({
      quote: quoteWith({ paymentForm: "CASHLESS", surchargePercent: "9", surchargeAmount: "900.00", grandTotal: "10900.00" }),
    });
    const row = screen.getByText("Безналичный расчёт (+9 %)");
    expect(row).toBeInTheDocument();
    expect(digitsOf(row.parentElement!.textContent ?? "")).toContain("900");
    const total = screen.getByText("Итого").parentElement!;
    expect(digitsOf(total.textContent ?? "")).toBe("10900");
  });

  it("наличные — строки нет", () => {
    renderPanel({ quote: quoteWith({ paymentForm: "CASH", surchargePercent: null, surchargeAmount: "0.00" }) });
    expect(screen.queryByText(/Безналичный расчёт/)).toBeNull();
  });

  it("без ответа сервера считает надбавку локально тем же правилом", () => {
    renderPanel({ quote: null, paymentForm: "CASHLESS", surchargePercent: 9 });
    expect(screen.getByText("Безналичный расчёт (+9 %)")).toBeInTheDocument();
    const total = screen.getByText("Итого").parentElement!;
    expect(digitsOf(total.textContent ?? "")).toBe("10900");
  });

  it("локально: наличные или процент не задан — итог без надбавки", () => {
    renderPanel({ quote: null, paymentForm: "CASHLESS", surchargePercent: null });
    expect(screen.queryByText(/Безналичный расчёт/)).toBeNull();
    const total = screen.getByText("Итого").parentElement!;
    expect(digitsOf(total.textContent ?? "")).toBe("10000");
  });
});
