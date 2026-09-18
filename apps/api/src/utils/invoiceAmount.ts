import Decimal from "decimal.js";

/** Current receivable, preserving the original document total separately. */
export function invoiceAmount(invoice: {
  total: { toString(): string };
  adjustmentAmount: { toString(): string };
}) {
  return new Decimal(invoice.total.toString()).add(
    invoice.adjustmentAmount.toString(),
  );
}
export function invoiceReadModel<
  T extends {
    total: { toString(): string };
    adjustmentAmount: { toString(): string };
  },
>(invoice: T) {
  return {
    ...invoice,
    originalTotal: invoice.total.toString(),
    total: invoiceAmount(invoice).toFixed(2),
  };
}
