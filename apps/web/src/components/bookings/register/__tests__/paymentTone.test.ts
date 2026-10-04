import { describe, it, expect } from "vitest";
import {
  REGISTER_STATUSES,
  type RegisterFinanceState,
} from "@light-rental/shared";
import { paymentTone } from "../paymentTone";

const DEALS = ["CONFIRMED", "ISSUED", "RETURNED"] as const;
const NOT_DEALS = REGISTER_STATUSES.filter(
  (s) => !(DEALS as readonly string[]).includes(s),
);

describe("paymentTone — цвет строки реестра по оплате", () => {
  it.each(DEALS)("%s: долга нет — зелёный", (status) => {
    for (const financeState of ["PAID", "SETTLED", "CREDIT"] as const)
      expect(paymentTone({ status, financeState })).toBe("paid");
  });

  it.each(DEALS)(
    "%s: есть остаток — красный, в том числе частичная оплата",
    (status) => {
      for (const financeState of ["UNPAID", "PARTIAL"] as const)
        expect(paymentTone({ status, financeState })).toBe("unpaid");
    },
  );

  it.each(DEALS)("%s: нечего оплачивать — без цвета", (status) => {
    for (const financeState of ["ZERO", "UNPRICED", "NO_CHARGES"] as const)
      expect(paymentTone({ status, financeState })).toBeNull();
  });

  it.each(NOT_DEALS)(
    "%s: денег никто не ждёт — без цвета при любой оплате",
    (status) => {
      const states: RegisterFinanceState[] = [
        "UNPAID",
        "PARTIAL",
        "PAID",
        "SETTLED",
        "CREDIT",
        "ZERO",
        "UNPRICED",
        "NO_CHARGES",
      ];
      for (const financeState of states)
        expect(paymentTone({ status, financeState })).toBeNull();
    },
  );
});
