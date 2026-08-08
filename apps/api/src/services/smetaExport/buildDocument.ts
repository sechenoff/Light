import Decimal from "decimal.js";
import type { Decimal as PrismaDecimal } from "@prisma/client/runtime/library";

import type { QuoteLine } from "../bookings";
import type { SmetaExportDocument, SmetaExportLine, SmetaOrgInfo } from "./types";

function fmtRuDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function fmtRuTime(d: Date): string {
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function cleanField(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/**
 * Реквизиты организации для шапки сметы из OrganizationSettings.
 * ENV-фолбэки только для name/phone/address (первичное развёртывание);
 * фейковых хардкодов (как в счёте) здесь нет — пустое поле просто не печатается.
 */
export function smetaOrgFromSettings(
  s: {
    legalName?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    inn?: string | null;
  } | null,
): SmetaOrgInfo {
  return {
    name: cleanField(s?.legalName) ?? cleanField(process.env.ORG_NAME),
    phone: cleanField(s?.phone) ?? cleanField(process.env.ORG_PHONE),
    email: cleanField(s?.email),
    address: cleanField(s?.address) ?? cleanField(process.env.ORG_ADDRESS),
    inn: cleanField(s?.inn),
  };
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
  org?: SmetaOrgInfo | null;
}): SmetaExportDocument {
  const shiftDec = new Decimal(Math.max(1, args.shifts));
  const rows: SmetaExportLine[] = args.lines.map((l, i) => {
    const unit = new Decimal(l.unitPrice.toString());
    const perShift = shiftDec.gt(0) ? unit.div(shiftDec) : unit;
    // Прайсовую цену тоже приводим к «за смену» — обе цифры в одной единице,
    // иначе в документе рядом окажутся цена за смену и цена за период.
    const listPerShift = l.listUnitPrice
      ? new Decimal(l.listUnitPrice.toString()).div(shiftDec)
      : null;
    return {
      index: i + 1,
      name: l.nameSnapshot,
      category: l.categorySnapshot,
      quantity: l.quantity,
      pricePerShift: perShift.toDecimalPlaces(2).toFixed(2),
      lineSum: new Decimal(l.lineSum.toString()).toDecimalPlaces(2).toFixed(2),
      listPricePerShift: listPerShift ? listPerShift.toDecimalPlaces(2).toFixed(2) : null,
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
    shiftsCount: args.shifts,
    org: args.org ?? null,
    lines: rows,
    subtotal: args.subtotal,
    ...(() => {
      const negotiated = args.lines.filter((l) => l.listUnitPrice != null);
      if (negotiated.length === 0) return {};
      const sum = (xs: typeof args.lines) =>
        xs.reduce((a, l) => a.add(new Decimal(l.lineSum.toString())), new Decimal(0));
      return {
        listedSubtotal: sum(args.lines.filter((l) => l.listUnitPrice == null))
          .toDecimalPlaces(2)
          .toFixed(2),
        negotiatedSubtotal: sum(negotiated).toDecimalPlaces(2).toFixed(2),
      };
    })(),
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
  listUnitPrice?: MoneyField | null;
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
    kind?: "MAIN" | "ADDON";
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
  org?: SmetaOrgInfo | null;
}): SmetaExportDocument {
  const quoteLikeLines: QuoteLine[] = args.estimate.lines.map((l) => ({
    equipmentId: null,
    categorySnapshot: l.categorySnapshot,
    nameSnapshot: l.nameSnapshot,
    brandSnapshot: null,
    modelSnapshot: null,
    quantity: l.quantity,
    unitPrice: new Decimal(l.unitPrice.toString()),
    lineSum: new Decimal(l.lineSum.toString()),
    pricingMode: "SHIFT",
    isCustom: false,
    listUnitPrice: l.listUnitPrice != null ? new Decimal(l.listUnitPrice.toString()) : null,
    isNegotiated: l.listUnitPrice != null,
  }));

  const baseDoc = buildSmetaExportDocument({
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
    org: args.org ?? null,
  });

  if (args.estimate.kind === "ADDON") {
    return { ...baseDoc, documentTitleRu: "Смета-добор", documentTitleEn: "Additional Estimate" };
  }
  return baseDoc;
}
