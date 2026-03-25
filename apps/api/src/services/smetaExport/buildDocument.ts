import Decimal from "decimal.js";
import type { Decimal as PrismaDecimal } from "@prisma/client/runtime/library";

import type { QuoteLine } from "../bookings";
import type { SmetaExportDocument, SmetaExportLine } from "./types";

function fmtRuDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function fmtRuTime(d: Date): string {
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function buildSmetaExportDocument(args: {
  startDate: Date;
  endDate: Date;
  clientName: string;
  projectName: string;
  comment: string | null;
  optionalNote: string | null;
  includeOptionalInExport: boolean;
  hourCalculationText: string;
  shifts: number;
  discountPercent: string;
  subtotal: string;
  discountAmount: string;
  totalAfterDiscount: string;
  lines: QuoteLine[];
}): SmetaExportDocument {
  const shiftDec = new Decimal(Math.max(1, args.shifts));
  const rows: SmetaExportLine[] = args.lines.map((l, i) => {
    const unit = new Decimal(l.unitPrice.toString());
    const perShift = shiftDec.gt(0) ? unit.div(shiftDec) : unit;
    return {
      index: i + 1,
      name: l.nameSnapshot,
      category: l.categorySnapshot,
      quantity: l.quantity,
      pricePerShift: perShift.toDecimalPlaces(2).toFixed(2),
      lineSum: new Decimal(l.lineSum.toString()).toDecimalPlaces(2).toFixed(2),
    };
  });

  return {
    documentTitleRu: "Смета аренды оборудования",
    documentTitleEn: "Rental Estimate",
    issueDateLabel: fmtRuDate(args.startDate),
    returnDateLabel: fmtRuDate(args.endDate),
    loadOutTimeLabel: fmtRuTime(args.startDate),
    returnLoadTimeLabel: fmtRuTime(args.endDate),
    hourCalculationText: args.hourCalculationText,
    clientName: args.clientName,
    projectName: args.projectName,
    comment: args.comment,
    optionalNote: args.optionalNote,
    includeOptionalInExport: args.includeOptionalInExport,
    lines: rows,
    subtotal: args.subtotal,
    discountPercent: args.discountPercent,
    discountAmount: args.discountAmount,
    totalAfterDiscount: args.totalAfterDiscount,
    currency: "RUB",
  };
}

type MoneyField = string | number | { toString(): string };

type PersistedLine = {
  categorySnapshot: string;
  nameSnapshot: string;
  quantity: number;
  unitPrice: MoneyField;
  lineSum: MoneyField;
};

/** Смета из БД (Estimate + Booking) для экспорта после подтверждения. */
export function buildSmetaFromPersistedEstimate(args: {
  booking: {
    startDate: Date;
    endDate: Date;
    projectName: string;
    comment: string | null;
    client: { name: string };
  };
  estimate: {
    shifts: number;
    subtotal: PrismaDecimal;
    discountPercent: PrismaDecimal | null;
    discountAmount: PrismaDecimal;
    totalAfterDiscount: PrismaDecimal;
    commentSnapshot: string | null;
    optionalNote: string | null;
    includeOptionalInExport: boolean;
    hoursSummaryText: string | null;
    lines: PersistedLine[];
  };
}): SmetaExportDocument {
  const quoteLikeLines: QuoteLine[] = args.estimate.lines.map((l) => ({
    equipmentId: "",
    categorySnapshot: l.categorySnapshot,
    nameSnapshot: l.nameSnapshot,
    brandSnapshot: null,
    modelSnapshot: null,
    quantity: l.quantity,
    unitPrice: new Decimal(l.unitPrice.toString()),
    lineSum: new Decimal(l.lineSum.toString()),
    pricingMode: "SHIFT",
  }));

  return buildSmetaExportDocument({
    startDate: args.booking.startDate,
    endDate: args.booking.endDate,
    clientName: args.booking.client.name,
    projectName: args.booking.projectName,
    comment: args.booking.comment ?? args.estimate.commentSnapshot,
    optionalNote: args.estimate.optionalNote,
    includeOptionalInExport: args.estimate.includeOptionalInExport,
    hourCalculationText:
      args.estimate.hoursSummaryText?.trim() ||
      `1 смена = 24 ч. · смен в периоде: ${args.estimate.shifts}`,
    shifts: args.estimate.shifts,
    discountPercent: args.estimate.discountPercent?.toString() ?? "0",
    subtotal: new Decimal(args.estimate.subtotal.toString()).toDecimalPlaces(2).toString(),
    discountAmount: new Decimal(args.estimate.discountAmount.toString()).toDecimalPlaces(2).toString(),
    totalAfterDiscount: new Decimal(args.estimate.totalAfterDiscount.toString()).toDecimalPlaces(2).toString(),
    lines: quoteLikeLines,
  });
}
