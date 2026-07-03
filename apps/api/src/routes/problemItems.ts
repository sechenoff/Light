/**
 * Роутер /api/problem-items — реестр «Потеряшки» (manager-facing).
 *
 * GET  /              — список проблемных карточек (keyset-пагинация, фильтр по status)
 * POST /:id/resolve   — ручной разбор открытой карточки (FOUND / NOT_FOUND)
 *
 * Доступ: SUPER_ADMIN + WAREHOUSE (router-level rolesGuard в routes/index.ts).
 * Жизненный цикл карточки — в services/problemItemService.ts.
 *
 * NB: в выдачу НЕ попадает barcode единицы — только название/категория
 * оборудования (правило: никаких штрихкодов в API, питающем UX).
 */

import { Router, RequestHandler } from "express";
import { z } from "zod";
import { prisma } from "../prisma";
import { resolveProblemItem } from "../services/problemItemService";

export const problemItemsRouter = Router();

// ─── Zod схемы ───────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  status: z.enum(["EXPECTED", "SEARCHING", "FOUND", "NOT_FOUND", "WROTE_OFF"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const resolveBodySchema = z.object({
  outcome: z.enum(["FOUND", "NOT_FOUND"]),
  note: z.string().min(3),
});

const DEFAULT_LIMIT = 50;

// ─── GET / ───────────────────────────────────────────────────────────────────

const listProblemItems: RequestHandler = async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const limit = q.limit ?? DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;

    // Keyset-пагинация по (createdAt desc, id) — зеркалит audit.ts.
    const rows = await prisma.problemItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        equipmentUnitId: true,
        sourceBookingId: true,
        reason: true,
        comment: true,
        expectedBackDate: true,
        status: true,
        createdBy: true,
        createdAt: true,
        resolvedAt: true,
        resolvedBy: true,
        resolutionNote: true,
        equipmentUnit: {
          select: {
            id: true,
            equipment: { select: { name: true, category: true } },
          },
        },
        // COUNT-mode: equipmentUnit is null; expose equipment via BookingItem
        // so the frontend can show the item name on cards.
        bookingItem: {
          select: {
            id: true,
            quantity: true,
            equipment: { select: { name: true, category: true } },
          },
        },
        quantity: true,
      },
    });

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      rows.pop(); // убираем probe-элемент
      nextCursor = rows[rows.length - 1].id; // курсор = последний возвращённый элемент
    }

    // Обогащение бронью (клиент + проект): у ProblemItem.sourceBookingId нет
    // Prisma-relation, поэтому batch-fetch одним запросом (без N+1). Менеджеру
    // по потеряшке первым делом нужно позвонить клиенту — без имени клиента
    // и проекта карточка была тупиком (#хвост-cuid). Barcode по-прежнему
    // НЕ отдаём.
    const bookingIds = [
      ...new Set(
        rows
          .map((r) => r.sourceBookingId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const bookings = bookingIds.length
      ? await prisma.booking.findMany({
          where: { id: { in: bookingIds } },
          select: {
            id: true,
            projectName: true,
            client: { select: { name: true, phone: true } },
          },
        })
      : [];
    const bookingMap = new Map(bookings.map((b) => [b.id, b]));

    const items = rows.map((r) => ({
      ...r,
      booking: r.sourceBookingId
        ? (bookingMap.get(r.sourceBookingId) ?? null)
        : null,
    }));

    res.json({ items, nextCursor });
  } catch (err) {
    next(err);
  }
};

problemItemsRouter.get("/", listProblemItems);

// ─── POST /:id/resolve ───────────────────────────────────────────────────────

const resolveHandler: RequestHandler = async (req, res, next) => {
  try {
    const { outcome, note } = resolveBodySchema.parse(req.body);
    const item = await resolveProblemItem(
      req.params.id,
      outcome,
      note,
      req.adminUser!.userId,
    );
    res.json({ item });
  } catch (err) {
    next(err);
  }
};

problemItemsRouter.post("/:id/resolve", resolveHandler);
