import { Router, RequestHandler } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { presentAuditEntries } from "../services/auditPresentation";
import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";

const router = Router();

const querySchema = z.object({
  entityType: z.string().optional(),
  /**
   * Фильтр по конкретной сущности. ApprovalTimeline на карточке брони шлёт
   * `?entityType=Booking&entityId=<id>` — без этого фильтра ответ содержал
   * записи ВСЕХ броней, и в «Историю согласования» одной брони попадали
   * чужие «Отправлено/Одобрено/Отклонено» (fix 2026-08-05).
   */
  entityId: z.string().optional(),
  userId: z.string().optional(),
  action: z.string().optional(),
  bookingId: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to:   z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
}).refine(q => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
  message: "Начало периода позже окончания", path: ["to"],
});

const listAudit: RequestHandler = async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const where: Prisma.AuditEntryWhereInput = {};
    if (q.action) where.action = q.action;
    if (q.bookingId) {
      const bookingId = q.bookingId;
      const [payments, invoices, expenses, refunds, bills] = await Promise.all([
        prisma.payment.findMany({ where: { bookingId }, select: { id: true } }),
        prisma.invoice.findMany({ where: { bookingId }, select: { id: true } }),
        prisma.expense.findMany({ where: { bookingId }, select: { id: true } }),
        prisma.refund.findMany({ where: { bookingId }, select: { id: true } }),
        prisma.bill.findMany({ where: { bookingId }, select: { id: true } }),
      ]);
      where.OR = [{ entityType: "Booking", entityId: bookingId },
        // Удалённый расход/счёт остаётся в истории по снимку связи с бронью.
        { entityType: { in: ["Payment", "Invoice", "Expense", "Refund", "Bill", "CreditNote"] }, OR: [
          { before: { contains: `"bookingId":${JSON.stringify(bookingId)}` } },
          { after: { contains: `"bookingId":${JSON.stringify(bookingId)}` } },
        ] },
        ...([["Payment", payments], ["Invoice", invoices], ["Expense", expenses], ["Refund", refunds], ["Bill", bills]] as const)
          .map(([entityType, list]) => ({ entityType, entityId: { in: list.map(r => r.id) } }))];
    }
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId)   where.entityId   = q.entityId;
    if (q.userId)     where.userId     = q.userId;
    if (q.from || q.to) {
      const createdAt: Record<string, Date> = {};
      if (q.from) createdAt.gte = new Date(q.from);
      if (q.to)   createdAt.lte = new Date(q.to);
      where.createdAt = createdAt;
    }
    const rows = await prisma.auditEntry.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { user: { select: { id: true, username: true, role: true } } },
    });
    let nextCursor: string | null = null;
    if (rows.length > q.limit) {
      rows.pop(); // убираем probe-элемент
      nextCursor = rows[rows.length - 1].id; // курсор = последний возвращённый элемент
    }
    res.json({ items: await presentAuditEntries(rows), nextCursor });
  } catch (err) { next(err); }
};

router.get("/", rolesGuard(["SUPER_ADMIN"]), listAudit);
export default router;
