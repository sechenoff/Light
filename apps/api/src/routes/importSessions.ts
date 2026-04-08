import express from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../prisma";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { HttpError } from "../utils/errors";
import {
  createSession,
  mapAndMatch,
  updateRowStatus,
  bulkAction,
  applyChanges,
  exportComparison,
  cleanExpired,
  rematchUnmatched,
} from "../services/importSession";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

export const importSessionsRouter = express.Router();

importSessionsRouter.use(apiKeyAuth);

// ──────────────────────────────────────────────────────────────────
// POST /upload — загрузить файл и создать сессию
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.post("/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new HttpError(400, "Файл не передан");
    }
    const result = await createSession(req.file);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET / — список сессий
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.get("/", async (_req, res, next) => {
  try {
    await cleanExpired();
    const sessions = await prisma.importSession.findMany({
      where: { status: { notIn: ["EXPIRED" as any] } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        status: true,
        fileName: true,
        fileSize: true,
        totalRows: true,
        matchedRows: true,
        unmatchedRows: true,
        appliedCount: true,
        competitorName: true,
        columnMapping: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /:id — детали сессии
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const session = await prisma.importSession.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        fileName: true,
        fileSize: true,
        totalRows: true,
        matchedRows: true,
        unmatchedRows: true,
        appliedCount: true,
        competitorName: true,
        columnMapping: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!session) {
      throw new HttpError(404, "Сессия не найдена");
    }
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /:id/rows — пагинированные строки
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.get("/:id/rows", async (req, res, next) => {
  try {
    const { id } = req.params;
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { sessionId: id };
    if (req.query.action) where.action = req.query.action;
    if (req.query.status) where.status = req.query.status;
    if (req.query.category) where.sourceCategory = req.query.category;
    if (req.query.changed === "true") where.action = { notIn: ["NO_CHANGE"] };
    if (req.query.unmatched === "true") where.equipmentId = null;

    const [rows, total] = await Promise.all([
      prisma.importSessionRow.findMany({
        where,
        skip,
        take: limit,
        include: { equipment: true },
        orderBy: { sourceIndex: "asc" },
      }),
      prisma.importSessionRow.count({ where }),
    ]);

    // Batch query hasActiveBookings for REMOVED_ITEM rows (avoid N+1)
    const removedEquipmentIds = rows
      .filter((r: any) => r.action === "REMOVED_ITEM" && r.equipmentId)
      .map((r: any) => r.equipmentId as string);

    const activeBookingSet = new Set<string>();
    if (removedEquipmentIds.length > 0) {
      const activeBookings = await prisma.bookingItem.findMany({
        where: {
          equipmentId: { in: removedEquipmentIds },
          booking: { status: { in: ["CONFIRMED", "ISSUED"] } },
        },
        select: { equipmentId: true },
        distinct: ["equipmentId"],
      });
      for (const b of activeBookings) {
        activeBookingSet.add(b.equipmentId);
      }
    }

    const enrichedRows = rows.map((row: any) => {
        const hasActiveBookings = row.action === "REMOVED_ITEM" && row.equipmentId
          ? activeBookingSet.has(row.equipmentId)
          : false;

        // Сериализуем Decimal поля
        return {
          ...row,
          sourcePrice: row.sourcePrice?.toString() ?? null,
          sourcePrice2: row.sourcePrice2?.toString() ?? null,
          sourcePriceProject: row.sourcePriceProject?.toString() ?? null,
          oldPrice: row.oldPrice?.toString() ?? null,
          oldPrice2: row.oldPrice2?.toString() ?? null,
          oldPriceProject: row.oldPriceProject?.toString() ?? null,
          priceDelta: row.priceDelta?.toString() ?? null,
          matchConfidence: row.matchConfidence?.toString() ?? null,
          hasActiveBookings,
          equipment: row.equipment
            ? {
                ...row.equipment,
                rentalRatePerShift: row.equipment.rentalRatePerShift?.toString() ?? null,
                rentalRateTwoShifts: row.equipment.rentalRateTwoShifts?.toString() ?? null,
                rentalRatePerProject: row.equipment.rentalRatePerProject?.toString() ?? null,
              }
            : null,
        };
    });

    const totalPages = Math.ceil(total / limit);
    res.json({ rows: enrichedRows, total, totalPages });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/map — задать маппинг и запустить матчинг
// ──────────────────────────────────────────────────────────────────

const mapBodySchema = z
  .object({
    type: z.enum(["OWN_PRICE_UPDATE", "COMPETITOR_IMPORT"]),
    mapping: z.object({
      name: z.string().min(1),
      category: z.string().optional(),
      brand: z.string().optional(),
      model: z.string().optional(),
      quantity: z.string().optional(),
      rentalRatePerShift: z.string().optional(),
      rentalRateTwoShifts: z.string().optional(),
      rentalRatePerProject: z.string().optional(),
    }),
    competitorName: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "OWN_PRICE_UPDATE" && !data.mapping.rentalRatePerShift) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Для OWN_PRICE_UPDATE необходимо указать rentalRatePerShift в mapping",
        path: ["mapping", "rentalRatePerShift"],
      });
    }
    if (data.type === "COMPETITOR_IMPORT" && !data.competitorName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Для COMPETITOR_IMPORT необходимо указать competitorName",
        path: ["competitorName"],
      });
    }
  });

importSessionsRouter.post("/:id/map", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, mapping, competitorName } = mapBodySchema.parse(req.body);
    await mapAndMatch(id, type, mapping, competitorName);

    // Возвращаем session + stats per spec
    const session = await prisma.importSession.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        totalRows: true,
        matchedRows: true,
        unmatchedRows: true,
      },
    });

    // Aggregate stats by action from rows
    const actionCounts = await prisma.importSessionRow.groupBy({
      by: ["action"],
      where: { sessionId: id },
      _count: { action: true },
    });
    const stats: Record<string, number> = {
      priceChanges: 0, newItems: 0, removedItems: 0, qtyChanges: 0, noChange: 0,
    };
    for (const ac of actionCounts) {
      if (ac.action === "PRICE_CHANGE") stats.priceChanges = ac._count.action;
      else if (ac.action === "NEW_ITEM") stats.newItems = ac._count.action;
      else if (ac.action === "REMOVED_ITEM") stats.removedItems = ac._count.action;
      else if (ac.action === "QTY_CHANGE") stats.qtyChanges = ac._count.action;
      else if (ac.action === "NO_CHANGE") stats.noChange = ac._count.action;
    }

    res.json({ session, stats });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/match — повторный матчинг несопоставленных строк (Gemini)
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.post("/:id/match", async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await rematchUnmatched(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// PATCH /:id/rows/:rowId — обновить статус строки или ручной матч
// ──────────────────────────────────────────────────────────────────

const rowUpdateSchema = z.object({
  status: z.enum(["ACCEPTED", "REJECTED"]),
  equipmentId: z.string().optional(),
});

importSessionsRouter.patch("/:id/rows/:rowId", async (req, res, next) => {
  try {
    const { rowId } = req.params;
    const { status, equipmentId } = rowUpdateSchema.parse(req.body);
    await updateRowStatus(rowId, status, equipmentId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/bulk-action — массовое принятие/отклонение
// ──────────────────────────────────────────────────────────────────

const bulkActionSchema = z.object({
  action: z.enum(["ACCEPTED", "REJECTED"]),
  filter: z
    .object({
      action: z.string().optional(),
      category: z.string().optional(),
    })
    .default({}),
});

importSessionsRouter.post("/:id/bulk-action", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action, filter } = bulkActionSchema.parse(req.body);
    const result = await bulkAction(id, action, filter);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/apply — применить изменения
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.post("/:id/apply", async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await applyChanges(id);
    res.json(result);
  } catch (err) {
    // Пробрасываем HttpError(409) как есть — centralized handler вернёт правильный статус
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /:id/export — скачать XLSX сравнения
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.get("/:id/export", async (req, res, next) => {
  try {
    const { id } = req.params;
    const buffer = await exportComparison(id);

    const session = await prisma.importSession.findUnique({
      where: { id },
      select: { fileName: true },
    });
    const baseName = session?.fileName?.replace(/\.[^.]+$/, "") ?? "export";
    const filename = `${baseName}-comparison.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE /:id — удалить сессию
// ──────────────────────────────────────────────────────────────────

importSessionsRouter.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.importSession.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
