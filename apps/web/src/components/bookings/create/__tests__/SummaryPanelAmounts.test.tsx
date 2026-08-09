/**
 * Вёрстка сумм в панели «Расчёт».
 *
 * Копейки на этой поверхности — шум: прайс и договорные цены в прокате всегда
 * в целых рублях, дробная часть приезжает только из процентов транспорта.
 * При этом «,00» съедает четыре знака, и семизначный итог переставал
 * помещаться в поле — обрезался на последней цифре.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { SummaryPanel } from "../SummaryPanel";
import type { QuoteResponse } from "../types";

/** Пробел в ru-RU — неразрывный (U+00A0), сравниваем по цифрам. */
const digitsOf = (s: string) => s.replace(/\D/g, "");

function quoteWith(grandTotal: string, extra: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    shifts: 3,
    subtotal: "3774575.49",
    discountPercent: "0",
    discountAmount: "0",
    totalAfterDiscount: "3774575.49",
    equipmentSubtotal: "3774575.49",
    equipmentTotal: "3774575.49",
    transportSubtotal: "0",
    grandTotal,
    lines: [],
    ...extra,
  } as unknown as QuoteResponse;
}

function renderPanel(quote: QuoteResponse, negotiatedTotal: number | null = null) {
  return render(
    <SummaryPanel
      quote={quote}
      localSubtotal={0}
      localListedSubtotal={0}
      localNegotiatedSubtotal={0}
      localDiscount={0}
      localTotal={0}
      discountPercent={0}
      itemCount={3}
      shifts={3}
      negotiatedTotal={negotiatedTotal}
      onChangeNegotiatedTotal={vi.fn()}
      checks={[]}
      isLoadingQuote={false}
      canSubmit={false}
    />,
  );
}

describe("SummaryPanel — суммы", () => {
  it("крупный итог показывается без копеек", () => {
    renderPanel(quoteWith("3774575.49"));
    const total = screen.getByLabelText("Итоговая сумма брони") as HTMLInputElement;
    expect(digitsOf(total.value)).toBe("3774575");
    expect(total.value).not.toContain(",");
  });

  it("ширину задаёт невидимый двойник с тем же текстом и теми же стилями", () => {
    // Ширина не считается в ch — расчёт врал на величину отступов. Вместо
    // этого поле растянуто по двойнику, который содержит ровно ту же строку.
    renderPanel(quoteWith("3774575.49"));
    const total = screen.getByLabelText("Итоговая сумма брони") as HTMLInputElement;
    const sizer = total.parentElement!.querySelector("[aria-hidden]") as HTMLElement;
    expect(sizer).not.toBeNull();
    expect(sizer.textContent).toBe(total.value);
    // Двойник невидим, но занимает место; поле растянуто по нему.
    expect(sizer.className).toContain("invisible");
    expect(total.className).toContain("w-full");
    // Одинаковые метрики: шрифт, размер, отступы, рамка.
    for (const cls of ["mono-num", "text-[30px]", "px-2", "border"]) {
      expect(sizer.className).toContain(cls);
      expect(total.className).toContain(cls);
    }
  });

  it("двойник повторяет сумму целиком — длинное число не обрезается", () => {
    renderPanel(quoteWith("12345678"));
    const total = screen.getByLabelText("Итоговая сумма брони") as HTMLInputElement;
    const sizer = total.parentElement!.querySelector("[aria-hidden]") as HTMLElement;
    expect(digitsOf(sizer.textContent ?? "")).toBe("12345678");
  });

  it("строки разбивки тоже без копеек", () => {
    renderPanel(
      quoteWith("3774575.49", {
        discountPercent: "50",
        discountAmount: "1887287.50",
        totalAfterDiscount: "1887287.99",
      }),
    );
    const discount = screen.getByText(/Скидка 50%/).parentElement!;
    expect(discount.textContent).not.toMatch(/,\d\d/);
  });
});
