import type { ExpenseCategory, Expense, UserRole, Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

export interface CreateExpenseArgs {
  date: Date;
  category: ExpenseCategory;
  amount: Decimal | number | string;
  description: string;
  documentUrl?: string;
  linkedBookingId?: string;
  linkedRepairId?: string;
  createdBy: string;
  creatorRole: UserRole;
}

export async function createExpense(args: CreateExpenseArgs): Promise<Expense> {
  // GUARD: TECHNICIAN can only create REPAIR expenses
  if (args.creatorRole === "TECHNICIAN" && args.category !== "REPAIR") {
    throw new HttpError(403, "Техник может создавать только расходы категории REPAIR", "EXPENSE_CATEGORY_FORBIDDEN");
  }

  const approved = args.creatorRole === "SUPER_ADMIN";
  const amount = new Decimal(args.amount.toString());

  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        category: args.category,
        amount: amount,
        description: args.description,
        documentUrl: args.documentUrl ?? null,
        linkedRepairId: args.linkedRepairId ?? null,
        approved,
        createdBy: args.createdBy,
        bookingId: args.linkedBookingId ?? null,
        // Legacy backfill
        name: args.description.slice(0, 100),
        expenseDate: args.date,
        comment: args.description,
      },
    });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId: args.createdBy,
      action: "EXPENSE_CREATE",
      entityType: "Expense",
      entityId: expense.id,
      before: null,
      after: diffFields({ ...expense, amount: expense.amount.toString() } as Record<string, unknown>),
    });

    return expense;
  });
}

export async function approveExpense(id: string, userId: string): Promise<Expense> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.expense.findUniqueOrThrow({ where: { id } });

    if (before.approved) {
      throw new HttpError(409, "Expense already approved", "EXPENSE_ALREADY_APPROVED");
    }

    const after = await tx.expense.update({ where: { id }, data: { approved: true } });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "EXPENSE_APPROVE",
      entityType: "Expense",
      entityId: id,
      before: diffFields({ ...before, amount: before.amount.toString() } as Record<string, unknown>),
      after: diffFields({ ...after, amount: after.amount.toString() } as Record<string, unknown>),
    });

    return after;
  });
}

export async function updateExpense(
  id: string,
  patch: Partial<CreateExpenseArgs>,
  userId: string,
): Promise<Expense> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.expense.findUniqueOrThrow({ where: { id } });

    const data: Prisma.ExpenseUpdateInput = {};
    if (patch.amount !== undefined) data.amount = new Decimal(patch.amount.toString());
    if (patch.description !== undefined) {
      data.description = patch.description;
      data.name = patch.description.slice(0, 100); // legacy sync
      data.comment = patch.description; // legacy sync
    }
    if (patch.date !== undefined) data.expenseDate = patch.date;
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.documentUrl !== undefined) data.documentUrl = patch.documentUrl;

    const after = await tx.expense.update({ where: { id }, data });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "EXPENSE_UPDATE",
      entityType: "Expense",
      entityId: id,
      before: diffFields({ ...before, amount: before.amount.toString() } as Record<string, unknown>),
      after: diffFields({ ...after, amount: after.amount.toString() } as Record<string, unknown>),
    });

    return after;
  });
}

export async function deleteExpense(id: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.expense.findUniqueOrThrow({ where: { id } });

    await tx.expense.delete({ where: { id } });

    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "EXPENSE_DELETE",
      entityType: "Expense",
      entityId: id,
      before: diffFields({ ...before, amount: before.amount.toString() } as Record<string, unknown>),
      after: null,
    });
  });
}

export interface ListExpensesArgs {
  category?: ExpenseCategory;
  from?: Date;
  to?: Date;
  linkedBookingId?: string;
  approvedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listExpenses(args: ListExpensesArgs) {
  const limit = Math.min(args.limit ?? 50, 200);
  const offset = args.offset ?? 0;

  const andClauses: Prisma.ExpenseWhereInput[] = [];

  if (args.category) andClauses.push({ category: args.category });
  if (args.approvedOnly) andClauses.push({ approved: true });
  if (args.linkedBookingId) andClauses.push({ bookingId: args.linkedBookingId });

  if (args.from || args.to) {
    const dateFilter: Prisma.DateTimeFilter = {};
    if (args.from) dateFilter.gte = args.from;
    if (args.to) dateFilter.lte = args.to;
    andClauses.push({ expenseDate: dateFilter });
  }

  const where: Prisma.ExpenseWhereInput = andClauses.length > 0 ? { AND: andClauses } : {};

  const [items, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: {
        booking: { select: { id: true, projectName: true } },
        linkedRepair: { select: { id: true } },
      },
      orderBy: { expenseDate: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.expense.count({ where }),
  ]);

  return { items, total };
}
