/**
 * Роутер /api/problem-items — реестр «Потеряшки» (manager-facing).
 *
 * GET  /              — список карточек (keyset-пагинация, фильтры status / source)
 * GET  /trail         — «Как пропало»: след позиции для модалки ручного ввода
 * POST /              — завести потеряшку вручную (source MANUAL)
 * POST /:id/resolve   — ручной разбор открытой карточки (FOUND / NOT_FOUND)
 *
 * Доступ: SUPER_ADMIN + WAREHOUSE (router-level rolesGuard в routes/index.ts).
 * Тонкий контроллер: Zod → сервис → JSON. Жизненный цикл карточки — в
 * services/problemItemService.ts, след — в services/stockCount/equipmentTrail.ts.
 * Статичные пути (`/trail`) объявлены ДО `/:id`.
 *
 * NB: в выдачу НЕ попадает barcode единицы — только название/категория
 * оборудования (правило: никаких штрихкодов в API, питающем UX).
 */

import { Router, RequestHandler, Request } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import {
  createManualProblemItem,
  resolveProblemItem,
  type ProblemActor,
} from "../services/problemItemService";
import { getEquipmentTrail } from "../services/stockCount/equipmentTrail";

export const problemItemsRouter = Router();

// ─── Zod схемы ───────────────────────────────────────────────────────────────

const PROBLEM_REASONS = ["LEFT_ON_SITE", "LOST", "DESTROYED", "STOLEN", "NOT_ON_SHELF"] as const;

const listQuerySchema = z.object({
  status: z.enum(["EXPECTED", "SEARCHING", "FOUND", "NOT_FOUND", "WROTE_OFF"]).optional(),
  source: z.enum(["RETURN", "STOCK_COUNT", "MANUAL"]).optional(),
  bookingId: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const trailQuerySchema = z.object({
  equipmentId: z.string().min(1).max(100),
});

const createBodySchema = z.object({
  equipmentId: z.string().min(1).max(100),
  equipmentUnitId: z.string().min(1).max(100).nullable().optional(),
  quantity: z.number().int().min(1).max(100_000).nullable().optional(),
  reason: z.enum(PROBLEM_REASONS),
  // Минимальная длина проверяется сервисом (после trim) — с понятным кодом.
  comment: z.string().max(2000),
  /** ISO-8601, как у приёмки в киоске. Только для «Остался на площадке». */
  expectedBackDate: z.string().datetime().nullable().optional(),
  sourceBookingId: z.string().min(1).max(100).nullable().optional(),
});

const resolveBodySchema = z.object({
  outcome: z.enum(["FOUND", "NOT_FOUND"]),
  note: z.string().min(3),
});

const DEFAULT_LIMIT = 50;

/** Кто действует: только сессия сотрудника. */
function actorOf(req: Request): ProblemActor {
  const user = req.adminUser;
  if (!user) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
  return { userId: user.userId, username: user.username };
}

// ─── Выдача карточки ─────────────────────────────────────────────────────────

const ITEM_SELECT = {
  id: true,
  equipmentUnitId: true,
  equipmentId: true,
  sourceBookingId: true,
  reason: true,
  comment: true,
  expectedBackDate: true,
  status: true,
  source: true,
  stockCountId: true,
  createdBy: true,
  createdAt: true,
  resolvedAt: true,
  resolvedBy: true,
  resolutionNote: true,
  quantity: true,
  equipmentUnit: {
    select: {
      id: true,
      equipment: { select: { name: true, category: true } },
    },
  },
  // COUNT-mode с приёмки: equipmentUnit пуст; позиция — через BookingItem.
  bookingItem: {
    select: {
      id: true,
      bookingId: true,
      quantity: true,
      equipment: { select: { name: true, category: true } },
    },
  },
  // Ручные и из инвентаризации: ни брони, ни единицы — позиция напрямую.
  equipment: { select: { name: true, category: true } },
  stockCount: { select: { id: true, number: true } },
} satisfies Prisma.ProblemItemSelect;

type ItemRow = Prisma.ProblemItemGetPayload<{ select: typeof ITEM_SELECT }>;

/**
 * Карточки → выдача API. `equipment` — позиция по правилу системы:
 * единица → позиция брони → прямая ссылка (null — позиция удалена из каталога).
 *
 * Бронь (клиент + проект) добирается одним запросом на страницу: у
 * `ProblemItem.sourceBookingId` нет Prisma-relation. Менеджеру по потеряшке
 * первым делом нужно позвонить клиенту — без имени клиента и проекта карточка
 * была тупиком (#хвост-cuid). Barcode по-прежнему НЕ отдаём.
 */
async function serializeItems(rows: ItemRow[]) {
  const bookingIds = [
    ...new Set(rows.map((r) => r.sourceBookingId ?? r.bookingItem?.bookingId).filter((id): id is string => Boolean(id))),
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

  return rows.map((r) => ({
    ...r,
    equipment: r.equipmentUnit?.equipment ?? r.bookingItem?.equipment ?? r.equipment ?? null,
    booking: bookingMap.get(r.sourceBookingId ?? r.bookingItem?.bookingId ?? "") ?? null,
  }));
}

// ─── GET / ───────────────────────────────────────────────────────────────────

const listProblemItems: RequestHandler = async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const limit = q.limit ?? DEFAULT_LIMIT;

    const where: Prisma.ProblemItemWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.source) where.source = q.source;
    if (q.bookingId) where.OR = [{ sourceBookingId: q.bookingId }, { sourceBookingId: null, bookingItem: { bookingId: q.bookingId } }];

    // Keyset-пагинация по (createdAt desc, id) — зеркалит audit.ts.
    const rows = await prisma.problemItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: ITEM_SELECT,
    });

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      rows.pop(); // убираем probe-элемент
      nextCursor = rows[rows.length - 1].id; // курсор = последний возвращённый элемент
    }

    res.json({ items: await serializeItems(rows), nextCursor });
  } catch (err) {
    next(err);
  }
};

problemItemsRouter.get("/", listProblemItems);

// ─── GET /trail ──────────────────────────────────────────────────────────────

/** «Где видели в последний раз» — окно с прошлой сверки позиции (или 60 дней). */
problemItemsRouter.get("/trail", async (req, res, next) => {
  try {
    const { equipmentId } = trailQuerySchema.parse(req.query);
    res.json({ trail: await getEquipmentTrail(equipmentId) });
  } catch (err) {
    next(err);
  }
});

// ─── POST / ──────────────────────────────────────────────────────────────────

problemItemsRouter.post("/", async (req, res, next) => {
  try {
    const actor = actorOf(req);
    const body = createBodySchema.parse(req.body);
    const created = await createManualProblemItem(
      {
        equipmentId: body.equipmentId,
        equipmentUnitId: body.equipmentUnitId ?? null,
        quantity: body.quantity ?? null,
        reason: body.reason,
        comment: body.comment,
        expectedBackDate: body.expectedBackDate ? new Date(body.expectedBackDate) : null,
        sourceBookingId: body.sourceBookingId ?? null,
      },
      actor,
    );
    const row = await prisma.problemItem.findUniqueOrThrow({
      where: { id: created.id },
      select: ITEM_SELECT,
    });
    const [item] = await serializeItems([row]);
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

// ─── POST /:id/resolve ───────────────────────────────────────────────────────

const resolveHandler: RequestHandler = async (req, res, next) => {
  try {
    const actor = actorOf(req);
    const { outcome, note } = resolveBodySchema.parse(req.body);
    const item = await resolveProblemItem(req.params.id, outcome, note, actor);
    res.json({ item });
  } catch (err) {
    next(err);
  }
};

problemItemsRouter.post("/:id/resolve", resolveHandler);
