import { describe, it, expect } from "vitest";

import { integerToWords, pluralForm, rublesInWords } from "../utils/amountInWords";
import { computeSurcharge, formatPercent, resolveSurchargePercent, surchargeLabel } from "../services/paymentForm";
import Decimal from "decimal.js";

describe("amountInWords", () => {
  it("склоняет рубли и копейки", () => {
    expect(pluralForm(1, ["рубль", "рубля", "рублей"])).toBe("рубль");
    expect(pluralForm(2, ["рубль", "рубля", "рублей"])).toBe("рубля");
    expect(pluralForm(5, ["рубль", "рубля", "рублей"])).toBe("рублей");
    expect(pluralForm(11, ["рубль", "рубля", "рублей"])).toBe("рублей");
    expect(pluralForm(21, ["рубль", "рубля", "рублей"])).toBe("рубль");
    expect(pluralForm(112, ["рубль", "рубля", "рублей"])).toBe("рублей");
  });

  it("пишет целые числа словами с женским родом у тысяч", () => {
    expect(integerToWords(0)).toBe("ноль");
    expect(integerToWords(1)).toBe("один");
    expect(integerToWords(21)).toBe("двадцать один");
    expect(integerToWords(1000)).toBe("одна тысяча");
    expect(integerToWords(2000)).toBe("две тысячи");
    expect(integerToWords(52102)).toBe("пятьдесят две тысячи сто два");
    expect(integerToWords(1_000_000)).toBe("один миллион");
    expect(integerToWords(2_345_678)).toBe("два миллиона триста сорок пять тысяч шестьсот семьдесят восемь");
    expect(integerToWords(100_000)).toBe("сто тысяч");
    expect(integerToWords(1_000_001)).toBe("один миллион один");
  });

  it("сумма прописью — как в счёте", () => {
    expect(rublesInWords("52102.00")).toBe("Пятьдесят две тысячи сто два рубля 00 копеек");
    expect(rublesInWords("1.01")).toBe("Один рубль 01 копейка");
    expect(rublesInWords("0.50")).toBe("Ноль рублей 50 копеек");
    expect(rublesInWords(new Decimal("1500000.99"))).toBe(
      "Один миллион пятьсот тысяч рублей 99 копеек",
    );
    expect(rublesInWords("21.02")).toBe("Двадцать один рубль 02 копейки");
  });

  it("отрицательные суммы в счёте не встречаются", () => {
    expect(() => rublesInWords("-1")).toThrow();
  });
});

describe("paymentForm", () => {
  it("надбавка только для безнала с положительным процентом", () => {
    expect(resolveSurchargePercent({ paymentForm: "CASH", cashlessSurchargePercent: 9 })).toBeNull();
    expect(resolveSurchargePercent({ paymentForm: "CASHLESS", cashlessSurchargePercent: null })).toBeNull();
    expect(resolveSurchargePercent({ paymentForm: "CASHLESS", cashlessSurchargePercent: 0 })).toBeNull();
    expect(resolveSurchargePercent({ paymentForm: "CASHLESS", cashlessSurchargePercent: "9" })?.toString()).toBe("9");
    expect(
      resolveSurchargePercent({ paymentForm: "CASHLESS", cashlessSurchargePercent: null, fallbackPercent: new Decimal(9) })?.toString(),
    ).toBe("9");
  });

  it("считает надбавку с округлением до копеек", () => {
    const r = computeSurcharge(new Decimal("10000"), new Decimal(9));
    expect(r.amount.toString()).toBe("900");
    expect(r.total.toString()).toBe("10900");
    const odd = computeSurcharge(new Decimal("333.33"), new Decimal("9.5"));
    expect(odd.amount.toString()).toBe("31.67");
    expect(computeSurcharge(new Decimal("100"), null).amount.toString()).toBe("0");
  });

  it("подписи процента без хвостовых нулей", () => {
    expect(formatPercent("9.00")).toBe("9");
    expect(formatPercent("9.50")).toBe("9.5");
    expect(surchargeLabel(9)).toBe("Безналичный расчёт (+9 %)");
  });
});
