/**
 * Счета на оплату контрагентам — печатный документ «Счёт на оплату».
 *
 * Отдельный реестр от `Invoice`: тот — финансовое обязательство по броне, к
 * которому привязаны платежи и дебиторка. Bill — то, что ИП выставляет и
 * печатает: может быть без брони (монтаж ролика, консультация), а может быть
 * выписан по брони одной-тремя строками (`prefillBillFromBooking`).
 *
 * Снапшоты сторон: реквизиты продавца и покупателя копируются в счёт на момент
 * выставления. Выписанный документ не должен меняться задним числом, когда
 * поправили карточку клиента или настройки организации.
 */
import Decimal from "decimal.js";
import type { Bill, BillLine, Client, OrganizationSettings, Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { toMoscowDateString } from "../utils/moscowDate";
import { writeAuditEntry, diffFields } from "./audit";
import { getSettings } from "./organizationService";
import { formatPercent, resolveSurchargePercent } from "./paymentForm";

type TxClient = Prisma.TransactionClient;

export const BILL_STATUSES = ["ISSUED", "PAID", "CANCELLED"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_UNITS = ["усл. ед.", "шт.", "смена", "час", "день", "компл."] as const;

/** Реквизиты продавца, зафиксированные в счёте. */
export interface SellerSnapshot {
  name: string;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankBik: string | null;
  rschet: string | null;
  kschet: string | null;
  signerName: string | null;
  signerTitle: string | null;
}

/** Реквизиты покупателя, зафиксированные в счёте. */
export interface PayerSnapshot {
  name: string;
  legalName: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  postalAddress: string | null;
  bankName: string | null;
  bankBik: string | null;
  rschet: string | null;
  kschet: string | null;
  phone: string | null;
  email: string | null;
}

export interface BillLineInput {
  name: string;
  unit?: string | null;
  quantity: number | string;
  price: number | string;
}

/** Реквизиты контрагента, которые форма счёта может дописать в карточку клиента. */
export interface ClientLegalInput {
  legalName?: string | null;
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  legalAddress?: string | null;
  postalAddress?: string | null;
  bankName?: string | null;
  bankBik?: string | null;
  rschet?: string | null;
  kschet?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface CreateBillArgs {
  /** Существующий клиент — или новый по имени (`client.name`). */
  clientId?: string | null;
  client?: ({ name: string } & ClientLegalInput) | null;
  /** Реквизиты, которые нужно дописать/обновить в карточке клиента перед снапшотом. */
  clientDetails?: ClientLegalInput | null;
  date?: Date | null;
  /** Ручной номер (например, продолжить бумажную нумерацию). Иначе — следующий за год. */
  number?: number | null;
  basis?: string | null;
  dueDate?: Date | null;
  notes?: string | null;
  /** null — не печатать пометку о налоге; undefined — взять из настроек. */
  taxNote?: string | null;
  bookingId?: string | null;
  lines: BillLineInput[];
}

export interface UpdateBillArgs {
  date?: Date;
  number?: number;
  basis?: string | null;
  dueDate?: Date | null;
  notes?: string | null;
  taxNote?: string | null;
  lines?: BillLineInput[];
  clientDetails?: ClientLegalInput | null;
}

export type BillWithLines = Bill & { lines: BillLine[]; client: Pick<Client, "id" | "name"> };

const MAX_NUMBER_RETRIES = 5;

// ── Снапшоты ─────────────────────────────────────────────────────────────────

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export function buildSellerSnapshot(s: OrganizationSettings): SellerSnapshot {
  return {
    name: clean(s.legalName) ?? "",
    inn: clean(s.inn),
    kpp: clean(s.kpp),
    ogrn: clean(s.ogrn),
    address: clean(s.address),
    phone: clean(s.phone),
    email: clean(s.email),
    bankName: clean(s.bankName),
    bankBik: clean(s.bankBik),
    rschet: clean(s.rschet),
    kschet: clean(s.kschet),
    signerName: clean(s.signerName),
    signerTitle: clean(s.signerTitle),
  };
}

export function buildPayerSnapshot(c: Client): PayerSnapshot {
  return {
    name: c.name,
    legalName: clean(c.legalName),
    inn: clean(c.inn),
    kpp: clean(c.kpp),
    ogrn: clean(c.ogrn),
    legalAddress: clean(c.legalAddress),
    postalAddress: clean(c.postalAddress),
    bankName: clean(c.bankName),
    bankBik: clean(c.bankBik),
    rschet: clean(c.rschet),
    kschet: clean(c.kschet),
    phone: clean(c.phone),
    email: clean(c.email),
  };
}

export function parseSellerSnapshot(raw: string): SellerSnapshot {
  return JSON.parse(raw) as SellerSnapshot;
}

export function parsePayerSnapshot(raw: string): PayerSnapshot {
  return JSON.parse(raw) as PayerSnapshot;
}

// ── Строки и итоги ───────────────────────────────────────────────────────────

type NormalizedLine = { position: number; name: string; unit: string; quantity: Decimal; price: Decimal; sum: Decimal };

function normalizeLines(lines: BillLineInput[]): { lines: NormalizedLine[]; total: Decimal } {
  if (lines.length === 0) throw new HttpError(400, "В счёте нужна хотя бы одна позиция", "BILL_LINES_EMPTY");
  const normalized = lines.map((l, i) => {
    const name = l.name.trim();
    if (!name) throw new HttpError(400, `Позиция ${i + 1}: пустое наименование`, "BILL_LINE_NAME_EMPTY");
    const quantity = new Decimal(l.quantity.toString());
    const price = new Decimal(l.price.toString());
    if (!quantity.isFinite() || quantity.lte(0)) {
      throw new HttpError(400, `Позиция ${i + 1}: количество должно быть больше нуля`, "BILL_LINE_QTY_INVALID");
    }
    if (!price.isFinite() || price.isNegative()) {
      throw new HttpError(400, `Позиция ${i + 1}: цена не может быть отрицательной`, "BILL_LINE_PRICE_INVALID");
    }
    return {
      position: i + 1,
      name,
      unit: clean(l.unit) ?? "усл. ед.",
      quantity: quantity.toDecimalPlaces(3),
      price: price.toDecimalPlaces(2),
      sum: quantity.mul(price).toDecimalPlaces(2),
    };
  });
  const total = normalized.reduce((acc, l) => acc.add(l.sum), new Decimal(0));
  return { lines: normalized, total };
}

/** Год документа — по московской дате: счёт от 31.12 23:30 МСК относится к уходящему году. */
export function billYearOf(date: Date): number {
  return Number(toMoscowDateString(date).slice(0, 4));
}

export async function nextBillNumber(year: number, client: TxClient | typeof prisma = prisma): Promise<number> {
  const last = await client.bill.findFirst({ where: { year }, orderBy: { number: "desc" }, select: { number: true } });
  return (last?.number ?? 0) + 1;
}

// ── Клиент-контрагент ────────────────────────────────────────────────────────

function legalDataFrom(input: ClientLegalInput): Prisma.ClientUpdateInput {
  const data: Prisma.ClientUpdateInput = {};
  const keys: Array<keyof ClientLegalInput> = [
    "legalName", "inn", "kpp", "ogrn", "legalAddress", "postalAddress",
    "bankName", "bankBik", "rschet", "kschet", "phone", "email",
  ];
  for (const key of keys) {
    if (input[key] !== undefined) (data as Record<string, unknown>)[key] = clean(input[key]);
  }
  return data;
}

/**
 * Находит или создаёт контрагента и дописывает реквизиты из формы. Правки
 * реквизитов ложатся в карточку клиента: следующий счёт этому контрагенту
 * подставит их сам.
 */
async function resolveClient(
  tx: TxClient,
  args: Pick<CreateBillArgs, "clientId" | "client" | "clientDetails">,
): Promise<Client> {
  const details: ClientLegalInput = { ...(args.client ?? {}), ...(args.clientDetails ?? {}) };
  delete (details as { name?: string }).name;
  const patch = legalDataFrom(details);

  if (args.clientId) {
    const existing = await tx.client.findUnique({ where: { id: args.clientId } });
    if (!existing) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");
    return Object.keys(patch).length > 0 ? tx.client.update({ where: { id: existing.id }, data: patch }) : existing;
  }
  const name = args.client?.name?.trim();
  if (!name) throw new HttpError(400, "Укажите контрагента", "BILL_CLIENT_REQUIRED");
  const byName = await tx.client.findUnique({ where: { name } });
  if (byName) {
    return Object.keys(patch).length > 0 ? tx.client.update({ where: { id: byName.id }, data: patch }) : byName;
  }
  return tx.client.create({ data: { ...(patch as Omit<Prisma.ClientCreateInput, "name">), name } });
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

const billInclude = { lines: { orderBy: { position: "asc" as const } }, client: { select: { id: true, name: true } } };

export async function createBill(args: CreateBillArgs, userId: string): Promise<BillWithLines> {
  const settings = await getSettings();
  const { lines, total } = normalizeLines(args.lines);
  const date = args.date ?? new Date();
  const year = billYearOf(date);
  const taxNote = args.taxNote === undefined ? clean(settings.taxNote) : clean(args.taxNote);

  if (args.bookingId) {
    const booking = await prisma.booking.findUnique({ where: { id: args.bookingId }, select: { id: true } });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  }

  // Номер резервируется записью: два одновременных «Выставить» получают один
  // и тот же «следующий» и второй падает на @@unique([year, number]) — ретраим
  // только автоматический номер. Ручной номер, занятый другим счётом, — ошибка.
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const client = await resolveClient(tx, args);
        const number = args.number ?? (await nextBillNumber(year, tx));
        const bill = await tx.bill.create({
          data: {
            year,
            number,
            date,
            status: "ISSUED",
            clientId: client.id,
            bookingId: args.bookingId ?? null,
            basis: clean(args.basis),
            taxNote,
            dueDate: args.dueDate ?? null,
            total: total.toString(),
            sellerSnapshot: JSON.stringify(buildSellerSnapshot(settings)),
            payerSnapshot: JSON.stringify(buildPayerSnapshot(client)),
            notes: clean(args.notes),
            createdBy: userId,
            lines: {
              create: lines.map((l) => ({
                position: l.position,
                name: l.name,
                unit: l.unit,
                quantity: l.quantity.toString(),
                price: l.price.toString(),
                sum: l.sum.toString(),
              })),
            },
          },
          include: billInclude,
        });
        await writeAuditEntry({
          tx,
          userId,
          action: "BILL_CREATE",
          entityType: "Bill",
          entityId: bill.id,
          before: null,
          after: { year, number, clientName: client.name, total: total.toString(), bookingId: args.bookingId ?? null, linesCount: lines.length },
        });
        return bill;
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // P2002 внутри транзакции — либо номер счёта, либо имя клиента (два
        // одновременных «Выставить» новому контрагенту). Клиента ретрай найдёт
        // по имени; занятый ручной номер — ошибка сразу.
        if (args.number != null && uniqueTargetIsBillNumber(err)) {
          throw new HttpError(409, `Счёт № ${args.number} за ${year} год уже есть`, "BILL_NUMBER_TAKEN", { year, number: args.number });
        }
        if (attempt < MAX_NUMBER_RETRIES - 1) continue;
        throw new HttpError(409, "Не удалось зарезервировать номер счёта — попробуйте ещё раз", "BILL_NUMBER_RACE", { year });
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/** Prisma кладёт поля индекса в `meta.target`; у @@unique([year, number]) там year/number. */
function uniqueTargetIsBillNumber(err: unknown): boolean {
  const target = (err as { meta?: { target?: unknown } } | null)?.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((f) => /number|year/i.test(f));
}

export async function getBill(id: string): Promise<BillWithLines> {
  const bill = await prisma.bill.findUnique({ where: { id }, include: billInclude });
  if (!bill) throw new HttpError(404, "Счёт не найден", "BILL_NOT_FOUND");
  return bill;
}

export async function updateBill(id: string, args: UpdateBillArgs, userId: string): Promise<BillWithLines> {
  const existing = await getBill(id);
  if (existing.status === "CANCELLED") {
    throw new HttpError(409, "Отменённый счёт не редактируется — выставьте новый", "BILL_CANCELLED");
  }
  const settings = await getSettings();
  const normalized = args.lines ? normalizeLines(args.lines) : null;
  const date = args.date ?? existing.date;
  const year = billYearOf(date);
  const number = args.number ?? existing.number;

  try {
    return await prisma.$transaction(async (tx) => {
      // Реквизиты контрагента могли уточнить прямо в форме счёта — дописываем
      // в карточку и переснимаем снапшот покупателя. Снапшот продавца тоже
      // обновляем: правка счёта — осознанное действие «перевыставить».
      let client = await tx.client.findUnique({ where: { id: existing.clientId } });
      if (!client) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");
      if (args.clientDetails) {
        const patch = legalDataFrom(args.clientDetails);
        if (Object.keys(patch).length > 0) client = await tx.client.update({ where: { id: client.id }, data: patch });
      }
      if (normalized) {
        await tx.billLine.deleteMany({ where: { billId: id } });
      }
      const bill = await tx.bill.update({
        where: { id },
        data: {
          date,
          year,
          number,
          basis: args.basis === undefined ? undefined : clean(args.basis),
          dueDate: args.dueDate === undefined ? undefined : args.dueDate,
          notes: args.notes === undefined ? undefined : clean(args.notes),
          taxNote: args.taxNote === undefined ? undefined : clean(args.taxNote),
          total: normalized ? normalized.total.toString() : undefined,
          sellerSnapshot: JSON.stringify(buildSellerSnapshot(settings)),
          payerSnapshot: JSON.stringify(buildPayerSnapshot(client)),
          lines: normalized
            ? {
                create: normalized.lines.map((l) => ({
                  position: l.position,
                  name: l.name,
                  unit: l.unit,
                  quantity: l.quantity.toString(),
                  price: l.price.toString(),
                  sum: l.sum.toString(),
                })),
              }
            : undefined,
        },
        include: billInclude,
      });
      await writeAuditEntry({
        tx,
        userId,
        action: "BILL_UPDATE",
        entityType: "Bill",
        entityId: id,
        before: diffFields({ number: existing.number, year: existing.year, total: existing.total.toString(), basis: existing.basis }),
        after: diffFields({ number: bill.number, year: bill.year, total: bill.total.toString(), basis: bill.basis }),
      });
      return bill;
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, `Счёт № ${number} за ${year} год уже есть`, "BILL_NUMBER_TAKEN", { year, number });
    }
    throw err;
  }
}

export async function setBillStatus(id: string, status: BillStatus, userId: string): Promise<BillWithLines> {
  const existing = await getBill(id);
  if (existing.status === status) return existing;
  return prisma.$transaction(async (tx) => {
    const bill = await tx.bill.update({
      where: { id },
      data: {
        status,
        paidAt: status === "PAID" ? new Date() : status === "ISSUED" ? null : existing.paidAt,
        cancelledAt: status === "CANCELLED" ? new Date() : null,
      },
      include: billInclude,
    });
    await writeAuditEntry({
      tx,
      userId,
      action: "BILL_STATUS",
      entityType: "Bill",
      entityId: id,
      before: { status: existing.status },
      after: { status, number: bill.number, year: bill.year },
    });
    return bill;
  });
}

export interface ListBillsArgs {
  status?: BillStatus | null;
  year?: number | null;
  clientId?: string | null;
  /** Поиск по имени контрагента или номеру. */
  q?: string | null;
  limit?: number;
}

export async function listBills(args: ListBillsArgs) {
  const where: Prisma.BillWhereInput = {
    ...(args.status ? { status: args.status } : {}),
    ...(args.year ? { year: args.year } : {}),
    ...(args.clientId ? { clientId: args.clientId } : {}),
  };
  const q = clean(args.q ?? null);
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
  const [fetched, grouped, years] = await Promise.all([
    prisma.bill.findMany({
      where,
      include: billInclude,
      orderBy: [{ date: "desc" }, { number: "desc" }],
      // Поиск фильтруется в приложении (см. ниже) — берём весь реестр за
      // выборку; счетов у ИП — сотни в год, это не каталог.
      take: q ? 5000 : limit,
    }),
    prisma.bill.groupBy({
      by: ["status"],
      where: { ...(args.year ? { year: args.year } : {}) },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.bill.findMany({ distinct: ["year"], select: { year: true }, orderBy: { year: "desc" } }),
  ]);
  // Поиск регистронезависим для кириллицы через toLocaleLowerCase("ru-RU"):
  // SQLite LIKE не понимает регистр за пределами ASCII (паттерн как в availability.ts).
  const items = (() => {
    if (!q) return fetched;
    const needle = q.toLocaleLowerCase("ru-RU");
    const asNumber = Number(q.replace(/^№\s*/, ""));
    const byNumber = Number.isInteger(asNumber) && asNumber > 0 ? asNumber : null;
    return fetched
      .filter((b) => {
        if (byNumber !== null && b.number === byNumber) return true;
        const payer = parsePayerSnapshot(b.payerSnapshot);
        return [b.client.name, payer.legalName, payer.inn]
          .filter((v): v is string => Boolean(v))
          .some((v) => v.toLocaleLowerCase("ru-RU").includes(needle));
      })
      .slice(0, limit);
  })();
  const counts: Record<string, number> = { ALL: 0 };
  const sums: Record<string, string> = {};
  for (const g of grouped) {
    counts[g.status] = g._count._all;
    counts.ALL += g._count._all;
    sums[g.status] = (g._sum.total ?? new Decimal(0)).toString();
  }
  return { items, counts, sums, years: years.map((y) => y.year) };
}

// ── Предзаполнение по брони ──────────────────────────────────────────────────

export interface BillPrefill {
  bookingId: string;
  clientId: string;
  client: PayerSnapshot & { id: string };
  basis: string | null;
  dueDate: string | null;
  lines: Array<{ name: string; unit: string; quantity: string; price: string }>;
  /** Что должно сойтись: итог брони по финансам. */
  expectedTotal: string;
  paymentForm: string;
  taxNote: string | null;
}

function fmtDate(d: Date): string {
  const [y, m, day] = toMoscowDateString(d).split("-");
  return `${day}.${m}.${y}`;
}

/**
 * Строки счёта по брони — зеркало разбивки «Из чего складывается сумма»:
 * оборудование (основная + доп-смета после скидки), транспорт, надбавка за
 * безнал. При договорном итоге — одна строка на всю сумму: разбивать
 * договорённость по расчётным частям было бы выдумкой.
 */
export async function prefillBillFromBooking(bookingId: string): Promise<BillPrefill> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, estimates: true, vehicles: { include: { vehicle: true } } },
  });
  if (!booking || booking.deletedAt) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  const settings = await getSettings();

  const main = booking.estimates.find((e) => e.kind === "MAIN") ?? null;
  const addon = booking.estimates.find((e) => e.kind === "ADDON") ?? null;
  const shifts = main?.shifts ?? 1;
  const period = `${fmtDate(booking.startDate)}–${fmtDate(booking.endDate)}`;
  const shiftsLabel = `${shifts} ${shifts === 1 ? "смена" : shifts < 5 ? "смены" : "смен"}`;
  const basis = booking.docNumber
    ? `Смета № ${booking.docNumber} от ${fmtDate(booking.createdAt)}`
    : `Бронь #${booking.id.slice(-6).toUpperCase()} от ${fmtDate(booking.createdAt)}`;
  const rentalName = `Аренда светового оборудования${booking.docNumber ? ` по смете № ${booking.docNumber}` : ""} (${period}, ${shiftsLabel})`;

  const lines: BillPrefill["lines"] = [];
  const finalAmount = new Decimal(booking.finalAmount.toString());

  if (booking.manualFinalAmount != null || !main) {
    lines.push({ name: rentalName, unit: "усл. ед.", quantity: "1", price: finalAmount.toDecimalPlaces(2).toString() });
  } else {
    const equipment = new Decimal(main.totalAfterDiscount.toString()).add(
      addon ? new Decimal(addon.totalAfterDiscount.toString()) : 0,
    );
    if (equipment.gt(0)) lines.push({ name: rentalName, unit: "усл. ед.", quantity: "1", price: equipment.toDecimalPlaces(2).toString() });
    const transport = booking.transportSubtotalRub ? new Decimal(booking.transportSubtotalRub.toString()) : new Decimal(0);
    if (transport.gt(0)) {
      const names = booking.vehicles.map((v) => v.vehicle?.name).filter(Boolean).join(", ");
      lines.push({ name: `Транспорт${names ? ` (${names})` : ""}`, unit: "усл. ед.", quantity: "1", price: transport.toDecimalPlaces(2).toString() });
    }
    const percent = resolveSurchargePercent({
      paymentForm: booking.paymentForm,
      cashlessSurchargePercent: booking.cashlessSurchargePercent,
    });
    const surcharge = new Decimal(booking.surchargeAmount.toString());
    if (percent && surcharge.gt(0)) {
      lines.push({ name: `Безналичный расчёт, +${formatPercent(percent)} %`, unit: "усл. ед.", quantity: "1", price: surcharge.toDecimalPlaces(2).toString() });
    }
  }

  return {
    bookingId: booking.id,
    clientId: booking.client.id,
    client: { id: booking.client.id, ...buildPayerSnapshot(booking.client) },
    basis,
    dueDate: booking.expectedPaymentDate?.toISOString() ?? null,
    lines,
    expectedTotal: finalAmount.toDecimalPlaces(2).toString(),
    paymentForm: booking.paymentForm,
    taxNote: clean(settings.taxNote),
  };
}
