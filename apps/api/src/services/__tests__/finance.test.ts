import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { calcBookingPaymentStatus } from "../finance";

describe("calcBookingPaymentStatus", () => {
  it("returns OVERPAID when amountPaid > finalAmount (strict greater)", () => {
    const status = calcBookingPaymentStatus({
      finalAmount: new Decimal(3500),
      amountPaid: new Decimal(5000),
      expectedPaymentDate: null,
    });
    expect(status).toBe("OVERPAID");
  });

  it("OVERPAID has priority over OVERDUE when paid > final", () => {
    const past = new Date(Date.now() - 86400000);
    const status = calcBookingPaymentStatus({
      finalAmount: new Decimal(3500),
      amountPaid: new Decimal(5000),
      expectedPaymentDate: past,
    });
    expect(status).toBe("OVERPAID");
  });

  it("returns PAID (not OVERPAID) when amountPaid === finalAmount", () => {
    const status = calcBookingPaymentStatus({
      finalAmount: new Decimal(3500),
      amountPaid: new Decimal(3500),
      expectedPaymentDate: null,
    });
    expect(status).toBe("PAID");
  });
});
