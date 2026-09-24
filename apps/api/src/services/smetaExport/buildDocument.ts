import Decimal from "decimal.js";
import type { Decimal as PrismaDecimal } from "@prisma/client/runtime/library";

import type { QuoteLine } from "../bookings";
import { estimateLineKey, loadLineOrdering, sortLinesByCatalog, type LineOrdering } from "../lineOrder";
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
    kpp?: string | null;
    bankName?: string | null;
    bankBik?: string | null;
    rschet?: string | null;
    kschet?: string | null;
  } | null,
): SmetaOrgInfo {
  return {
    name: cleanField(s?.legalName) ?? cleanField(process.env.ORG_NAME),
    phone: cleanField(s?.phone) ?? cleanField(process.env.ORG_PHONE),
    email: cleanField(s?.email),
    address: cleanField(s?.address) ?? cleanField(process.env.ORG_ADDRESS),
    inn: cleanField(s?.inn),
    kpp: cleanField(s?.kpp),
    bankName: cleanField(s?.bankName),
    bankBik: cleanField(s?.bankBik),
    rschet: cleanField(s?.rschet),
    kschet: cleanField(s?.kschet),
  };
}

/**
 * Комментарий, годный для клиентского документа.
 *
 * Поле `Booking.comment` у исторических броней содержит след разового импорта
 * («[hard-reset-2026-05-25] from xlsx files/28.02 куб 43150.xlsx»). Печатать
 * это заказчику нельзя, а чистить базу задним числом — отдельная работа: на
 * листе такой комментарий просто не показываем.
 */
export function clientSafeComment(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (/^\[[a-z0-9-]+\]/i.test(text)) return null;
  if (/from xlsx files\//i.test(text)) return null;
  if (/^imported from/i.test(text)) return null;
  return text;
}

/** Порядок каталога для строк одной или нескольких смет — один запрос на документ. */
export function loadSmetaLineOrdering(
  ...estimates: Array<{ lines: ReadonlyArray<{ equipmentId?: string | null }> } | null | undefined>
): Promise<LineOrdering> {
  return loadLineOrdering(estimates.flatMap((e) => e?.lines.map((l) => l.equipmentId) ?? []));
}

/** Ключ группы на листе — тот же, по которому режут на категории рендереры. */
function printedCategoryKey(category: string | null | undefined): string {
  return category?.trim() || "Прочее";
}

/**
 * Строки подряд по категориям, в порядке первого появления категории — ровно
 * так их печатают renderPdf/renderXlsx. Номер строки присваивается ПОСЛЕ этого
 * шага, поэтому № совпадает с порядком печати в обоих форматах.
 */
function contiguousByCategory<T extends { categorySnapshot: string }>(lines: ReadonlyArray<T>): T[] {
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const key = printedCategoryKey(line.categorySnapshot);
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  return Array.from(groups.values()).flat();
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
  docNumber?: string | null;
  /** Дата составления документа; по умолчанию — сегодня (превью из формы). */
  issuedAt?: Date | null;
  paymentDueDate?: Date | null;
  /**
   * Порядок каталога (lineOrder.ts): категории как на /equipment/manage, внутри —
   * sortOrder и имя, произвольные позиции — в конце. Без него остаётся порядок
   * добавления (строки лишь собираются подряд по категориям).
   */
  ordering?: LineOrdering | null;
}): SmetaExportDocument {
  const shiftDec = new Decimal(Math.max(1, args.shifts));
  const sorted = args.ordering ? sortLinesByCatalog(args.lines, estimateLineKey, args.ordering) : args.lines;
  const rows: SmetaExportLine[] = contiguousByCategory(sorted).map((l, i) => {
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
    docNumber: args.docNumber ?? null,
    issuedAtLabel: fmtRuDate(args.issuedAt ?? new Date()),
    paymentDueLabel: args.paymentDueDate ? fmtRuDate(args.paymentDueDate) : null,
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
  /** null — произвольная позиция; нужен, чтобы расставить строки по каталогу. */
  equipmentId?: string | null;
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
    docNumber?: string | null;
    expectedPaymentDate?: Date | null;
    createdAt?: Date;
  };
  estimate: {
    kind?: "MAIN" | "ADDON";
    createdAt?: Date;
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
  /** Порядок каталога — см. buildSmetaExportDocument. */
  ordering?: LineOrdering | null;
}): SmetaExportDocument {
  const quoteLikeLines: QuoteLine[] = args.estimate.lines.map((l) => ({
    equipmentId: l.equipmentId ?? null,
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
    comment: clientSafeComment(args.booking.comment ?? args.estimate.commentSnapshot),
    optionalNote: args.estimate.optionalNote,
    includeOptionalInExport: args.estimate.includeOptionalInExport,
    // Фолбэка «1 смена = 24 ч · смен в периоде: N» больше нет: число смен
    // теперь стоит отдельной ячейкой в реквизитах, и плашка повторяла её же,
    // занимая треть первого экрана шаблонной фразой.
    hourCalculationText: args.estimate.hoursSummaryText?.trim() || "",
    shifts: args.estimate.shifts,
    discountPercent: args.estimate.discountPercent?.toString() ?? "0",
    subtotal: new Decimal(args.estimate.subtotal.toString()).toDecimalPlaces(2).toString(),
    discountAmount: new Decimal(args.estimate.discountAmount.toString()).toDecimalPlaces(2).toString(),
    totalAfterDiscount: new Decimal(args.estimate.totalAfterDiscount.toString()).toDecimalPlaces(2).toString(),
    lines: quoteLikeLines,
    org: args.org ?? null,
    docNumber: args.booking.docNumber ?? null,
    // Дата документа — с БРОНИ, не со сметы. Смета пересобирается при каждой
    // правке через delete+create, и её createdAt уезжает на дату последнего
    // редактирования: документ, выписанный в мае, в августе датировался бы
    // августом. Бронь создаётся один раз — там же живёт и номер.
    issuedAt: args.booking.createdAt ?? args.estimate.createdAt ?? null,
    paymentDueDate: args.booking.expectedPaymentDate ?? null,
    ordering: args.ordering ?? null,
  });

  if (args.estimate.kind === "ADDON") {
    return {
      ...baseDoc,
      documentTitleRu: "Смета-добор",
      documentTitleEn: "Additional Estimate",
      // Добор — отдельный документ, и номер у него обязан отличаться: два
      // платёжных документа под одним номером не различить ни в переписке,
      // ни в бухгалтерии.
      docNumber: baseDoc.docNumber ? `${baseDoc.docNumber}/д` : null,
    };
  }
  return baseDoc;
}
