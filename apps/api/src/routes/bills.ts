/**
 * /api/bills — счета на оплату контрагентам (печатный документ «Счёт на оплату»).
 *
 * GET    /              — реестр (фильтры status/year/clientId/q) + счётчики по статусам
 * GET    /next-number   — следующий номер за год (для подсказки в форме)
 * GET    /prefill       — заготовка счёта по брони (?bookingId=)
 * POST   /              — выставить счёт
 * GET    /:id           — счёт со строками
 * PATCH  /:id           — поправить счёт (шапка, строки, реквизиты контрагента)
 * POST   /:id/status    — ISSUED | PAID | CANCELLED
 * GET    /:id/pdf       — печатная форма (inline PDF)
 *
 * Литеральные маршруты объявлены ДО `/:id` — иначе express отдаст «prefill» в параметр.
 * Только SUPER_ADMIN (router-level guard в routes/index.ts): счета — это деньги и реквизиты.
 */
import express from "express";
import { z } from "zod";

import {
  BILL_STATUSES,
  createBill,
  getBill,
  listBills,
  nextBillNumber,
  prefillBillFromBooking,
  setBillStatus,
  updateBill,
  type BillWithLines,
  type ClientLegalInput,
} from "../services/billService";
import { renderBillPdf } from "../services/billDocument/renderBillPdf";
import { HttpError } from "../utils/errors";

export const billsRouter = express.Router();

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const legalFields = {
  legalName: optionalText(300),
  inn: z.string().trim().regex(/^\d{10}$|^\d{12}$/, "ИНН — 10 или 12 цифр").nullable().optional().or(z.literal("")),
  kpp: z.string().trim().regex(/^\d{9}$/, "КПП — 9 цифр").nullable().optional().or(z.literal("")),
  ogrn: z.string().trim().regex(/^\d{13}$|^\d{15}$/, "ОГРН — 13 цифр, ОГРНИП — 15").nullable().optional().or(z.literal("")),
  legalAddress: optionalText(500),
  postalAddress: optionalText(500),
  bankName: optionalText(300),
  bankBik: z.string().trim().regex(/^\d{9}$/, "БИК — 9 цифр").nullable().optional().or(z.literal("")),
  rschet: z.string().trim().regex(/^\d{20}$/, "Расчётный счёт — 20 цифр").nullable().optional().or(z.literal("")),
  kschet: z.string().trim().regex(/^\d{20}$/, "Корр. счёт — 20 цифр").nullable().optional().or(z.literal("")),
  phone: optionalText(50),
  email: z.string().trim().email("Некорректный e-mail").nullable().optional().or(z.literal("")),
};

const legalSchema = z.object(legalFields);

const lineSchema = z.object({
  name: z.string().trim().min(1, "Наименование обязательно").max(1000),
  unit: z.string().trim().max(20).nullable().optional(),
  quantity: z.union([z.number(), z.string().trim().min(1)]),
  price: z.union([z.number(), z.string().trim().min(1)]),
});

const isoDate = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

const createSchema = z
  .object({
    clientId: z.string().min(1).nullable().optional(),
    client: z.object({ name: z.string().trim().min(1, "Укажите контрагента").max(300), ...legalFields }).nullable().optional(),
    clientDetails: legalSchema.nullable().optional(),
    date: isoDate.nullable().optional(),
    number: z.number().int().positive().max(999999).nullable().optional(),
    basis: optionalText(500),
    dueDate: isoDate.nullable().optional(),
    notes: optionalText(2000),
    taxNote: optionalText(300),
    bookingId: z.string().min(1).nullable().optional(),
    lines: z.array(lineSchema).min(1, "В счёте нужна хотя бы одна позиция").max(100),
  })
  .refine((b) => Boolean(b.clientId) || Boolean(b.client?.name), {
    message: "Укажите контрагента",
    path: ["clientId"],
  });

const updateSchema = z.object({
  date: isoDate.optional(),
  number: z.number().int().positive().max(999999).optional(),
  basis: optionalText(500),
  dueDate: isoDate.nullable().optional(),
  notes: optionalText(2000),
  taxNote: optionalText(300),
  lines: z.array(lineSchema).min(1).max(100).optional(),
  clientDetails: legalSchema.nullable().optional(),
});

const statusSchema = z.object({ status: z.enum(BILL_STATUSES) });

const listQuerySchema = z.object({
  status: z.enum(BILL_STATUSES).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  clientId: z.string().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Дата из формы: «2026-09-16» — полдень по Москве, чтобы не уехать в соседний день при сдвиге зон. */
function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+03:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "Некорректная дата", "BILL_DATE_INVALID");
  return d;
}

/** Пустые строки из формы («») — это «поле очищено», а не значение. */
function normalizeLegal(input: z.infer<typeof legalSchema> | null | undefined): ClientLegalInput | null | undefined {
  if (input == null) return input;
  const out: ClientLegalInput = {};
  for (const [key, value] of Object.entries(input) as Array<[keyof ClientLegalInput, string | null | undefined]>) {
    if (value === undefined) continue;
    out[key] = value === "" ? null : value;
  }
  return out;
}

function serializeBill(bill: BillWithLines) {
  return {
    id: bill.id,
    year: bill.year,
    number: bill.number,
    numberLabel: `${bill.number}`,
    date: bill.date.toISOString(),
    status: bill.status,
    clientId: bill.clientId,
    clientName: bill.client.name,
    bookingId: bill.bookingId,
    basis: bill.basis,
    taxNote: bill.taxNote,
    dueDate: bill.dueDate?.toISOString() ?? null,
    total: bill.total.toString(),
    seller: JSON.parse(bill.sellerSnapshot) as unknown,
    payer: JSON.parse(bill.payerSnapshot) as unknown,
    notes: bill.notes,
    paidAt: bill.paidAt?.toISOString() ?? null,
    cancelledAt: bill.cancelledAt?.toISOString() ?? null,
    createdBy: bill.createdBy,
    createdAt: bill.createdAt.toISOString(),
    updatedAt: bill.updatedAt.toISOString(),
    lines: bill.lines.map((l) => ({
      id: l.id,
      position: l.position,
      name: l.name,
      unit: l.unit,
      quantity: l.quantity.toString(),
      price: l.price.toString(),
      sum: l.sum.toString(),
    })),
  };
}

function actorId(req: express.Request): string {
  const id = req.adminUser?.userId;
  if (!id) throw new HttpError(401, "Требуется вход", "UNAUTHENTICATED");
  return id;
}

billsRouter.get("/", async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const result = await listBills(q);
    res.json({ items: result.items.map(serializeBill), counts: result.counts, sums: result.sums, years: result.years });
  } catch (err) {
    next(err);
  }
});

billsRouter.get("/next-number", async (req, res, next) => {
  try {
    const year = z.coerce.number().int().min(2000).max(2100).optional().parse(req.query.year) ?? new Date().getFullYear();
    res.json({ year, number: await nextBillNumber(year) });
  } catch (err) {
    next(err);
  }
});

billsRouter.get("/prefill", async (req, res, next) => {
  try {
    const bookingId = z.string().min(1).parse(req.query.bookingId);
    res.json(await prefillBillFromBooking(bookingId));
  } catch (err) {
    next(err);
  }
});

billsRouter.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const client = body.client
      ? { name: body.client.name, ...(normalizeLegal({ ...body.client, name: undefined } as never) ?? {}) }
      : null;
    const bill = await createBill(
      {
        clientId: body.clientId ?? null,
        client,
        clientDetails: normalizeLegal(body.clientDetails),
        date: parseDate(body.date),
        number: body.number ?? null,
        basis: body.basis,
        dueDate: parseDate(body.dueDate),
        notes: body.notes,
        taxNote: body.taxNote,
        bookingId: body.bookingId ?? null,
        lines: body.lines,
      },
      actorId(req),
    );
    res.status(201).json(serializeBill(bill));
  } catch (err) {
    next(err);
  }
});

billsRouter.get("/:id", async (req, res, next) => {
  try {
    res.json(serializeBill(await getBill(req.params.id)));
  } catch (err) {
    next(err);
  }
});

billsRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const bill = await updateBill(
      req.params.id,
      {
        date: parseDate(body.date) ?? undefined,
        number: body.number,
        basis: body.basis,
        dueDate: parseDate(body.dueDate),
        notes: body.notes,
        taxNote: body.taxNote,
        lines: body.lines,
        clientDetails: normalizeLegal(body.clientDetails),
      },
      actorId(req),
    );
    res.json(serializeBill(bill));
  } catch (err) {
    next(err);
  }
});

billsRouter.post("/:id/status", async (req, res, next) => {
  try {
    const { status } = statusSchema.parse(req.body);
    res.json(serializeBill(await setBillStatus(req.params.id, status, actorId(req))));
  } catch (err) {
    next(err);
  }
});

billsRouter.get("/:id/pdf", async (req, res, next) => {
  try {
    const bill = await getBill(req.params.id);
    const pdf = await renderBillPdf(bill);
    const fileName = `schet-${bill.number}-${bill.year}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(`Счёт № ${bill.number} от ${bill.year}.pdf`)}`);
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  } catch (err) {
    next(err);
  }
});
