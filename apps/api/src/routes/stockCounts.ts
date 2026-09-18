/**
 * /api/stock-counts — инвентаризация склада, десктоп (SUPER_ADMIN + WAREHOUSE).
 *
 * Гард висит на монтировании префикса в routes/index.ts. Тонкий контроллер:
 * Zod-валидация → сервис → JSON. Вся логика — в services/stockCount/.
 *
 * Статичные пути (`/active`, `/scope`) объявлены ДО `/:id`, иначе express
 * отдаст «active» / «scope» в параметр.
 */

import express from "express";
import { z } from "zod";

import { HttpError } from "../utils/errors";
import {
  cancelStockCount,
  completeStockCount,
  decideLine,
  getActiveStockCount,
  getStockCountDetail,
  getStockCountLineTrail,
  getStockCountScope,
  getTrailSuggestions,
  listStockCountLines,
  listStockCounts,
  recordCount,
  refreshExpectation,
  resetCount,
  startStockCount,
  MAX_COUNT_QTY,
  type StockCountActor,
} from "../services/stockCount/stockCountService";
import { buildStockCountAct, stockCountActFileBase } from "../services/stockCount/act/buildStockCountAct";
import { renderStockCountActPdf } from "../services/stockCount/act/renderStockCountActPdf";
import { renderStockCountActXlsx } from "../services/stockCount/act/renderStockCountActXlsx";
import { buildAttachmentContentDisposition } from "../utils/contentDisposition";

const router = express.Router();

export const startBodySchema = z.object({
  categories: z.array(z.string().max(200)).max(500).nullable().optional(),
});

export const linesQuerySchema = z.object({
  // Пустой `?category=` — «все категории», а не ошибка запроса.
  category: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined)),
  filter: z.enum(["all", "uncounted", "discrepancy", "undecided"]).optional(),
});

export const countBodySchema = z.object({
  qty: z.number().int().min(0).max(MAX_COUNT_QTY),
});

/**
 * Решение привязано к тому, что руководитель видел: счёт строки и «на полке
 * должно быть» (снапшот) обязательны для любого решения, кроме снятия
 * (`decision: null`). Строку пересчитали — 409 LINE_CHANGED.
 */
export const decisionBodySchema = z
  .object({
    decision: z.enum(["LOST", "ADJUST", "FOUND"]).nullable(),
    note: z.string().max(2000).nullable().optional(),
    sourceBookingId: z.string().min(1).max(100).nullable().optional(),
    seenCountedQty: z.number().int().min(0).max(MAX_COUNT_QTY).optional(),
    seenExpectedQty: z.number().int().min(0).max(MAX_COUNT_QTY).optional(),
    acknowledgeBooksChanged: z.boolean().optional(),
  })
  .refine((b) => b.decision === null || (b.seenCountedQty != null && b.seenExpectedQty != null), {
    message: "Укажите счёт и ожидание строки, которые вы видели",
    path: ["seenCountedQty"],
  });

/** Кто действует: только сессия сотрудника (бот-ключ сюда не пускается whitelist'ом). */
function actorOf(req: express.Request): StockCountActor {
  const user = req.adminUser;
  if (!user) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
  return { userId: user.userId, username: user.username };
}

/** GET /api/stock-counts — все инвентаризации, новые сверху */
router.get("/", async (_req, res, next) => {
  try {
    res.json({ items: await listStockCounts() });
  } catch (err) {
    next(err);
  }
});

/** GET /api/stock-counts/active — идущая инвентаризация или null */
router.get("/active", async (_req, res, next) => {
  try {
    res.json({ stockCount: await getActiveStockCount() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stock-counts/scope — охват для «Начать инвентаризацию»: категории
 * каталога и сколько в каждой позиций с учётом количеством (их посчитают) и
 * штучных (сверяются в карточке единиц).
 */
router.get("/scope", async (_req, res, next) => {
  try {
    res.json(await getStockCountScope());
  } catch (err) {
    next(err);
  }
});

/** POST /api/stock-counts — начать инвентаризацию */
router.post("/", async (req, res, next) => {
  try {
    const body = startBodySchema.parse(req.body ?? {});
    const stockCount = await startStockCount({ categories: body.categories }, actorOf(req));
    res.status(201).json({ stockCount });
  } catch (err) {
    next(err);
  }
});

/** GET /api/stock-counts/:id */
router.get("/:id", async (req, res, next) => {
  try {
    res.json({ stockCount: await getStockCountDetail(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/stock-counts/:id/lines?category=&filter= */
router.get("/:id/lines", async (req, res, next) => {
  try {
    const query = linesQuerySchema.parse(req.query);
    res.json({ lines: await listStockCountLines(req.params.id, query) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/stock-counts/:id/lines/:lineId/count { qty } */
router.post("/:id/lines/:lineId/count", async (req, res, next) => {
  try {
    const { qty } = countBodySchema.parse(req.body);
    const line = await recordCount(req.params.id, req.params.lineId, qty, actorOf(req).username);
    res.json({ line });
  } catch (err) {
    next(err);
  }
});

/** POST /api/stock-counts/:id/lines/:lineId/reset — «Пересчитать» */
router.post("/:id/lines/:lineId/reset", async (req, res, next) => {
  try {
    res.json({ line: await resetCount(req.params.id, req.params.lineId) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stock-counts/:id/lines/:lineId/refresh-expected — «Обновить
 * ожидание»: снапшот заново по живому учёту, счёт полки остаётся.
 */
router.post("/:id/lines/:lineId/refresh-expected", async (req, res, next) => {
  try {
    res.json({ line: await refreshExpectation(req.params.id, req.params.lineId) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stock-counts/:id/lines/:lineId/decision
 * { decision, note?, sourceBookingId?, seenCountedQty, seenExpectedQty, acknowledgeBooksChanged? }
 */
router.post("/:id/lines/:lineId/decision", async (req, res, next) => {
  try {
    const body = decisionBodySchema.parse(req.body);
    const line = await decideLine(req.params.id, req.params.lineId, body, actorOf(req));
    res.json({ line });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stock-counts/:id/trail-suggestions — подсказки «Как пропало» для всех
 * недостач разом ({ suggestions: { [lineId]: бронь | null } }), чтобы «Итог» не
 * строил полный след на каждую строку.
 */
router.get("/:id/trail-suggestions", async (req, res, next) => {
  try {
    res.json({ suggestions: await getTrailSuggestions(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/stock-counts/:id/lines/:lineId/trail — «Как пропало» */
router.get("/:id/lines/:lineId/trail", async (req, res, next) => {
  try {
    res.json({ trail: await getStockCountLineTrail(req.params.id, req.params.lineId) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/stock-counts/:id/complete — применить решения одной транзакцией */
router.post("/:id/complete", async (req, res, next) => {
  try {
    res.json(await completeStockCount(req.params.id, actorOf(req)));
  } catch (err) {
    next(err);
  }
});

/** POST /api/stock-counts/:id/cancel — отменить без последствий */
router.post("/:id/cancel", async (req, res, next) => {
  try {
    res.json({ stockCount: await cancelStockCount(req.params.id, actorOf(req)) });
  } catch (err) {
    next(err);
  }
});

// ── Акт инвентаризации (спека §7 «Акт») ──────────────────────────────────────

/**
 * GET /api/stock-counts/:id/act.pdf — акт, A4 альбомный. Пока инвентаризация
 * идёт — черновик с пометкой «ЧЕРНОВИК». inline: фронт открывает и печатает
 * документ из вкладки, не скачивая его.
 */
router.get("/:id/act.pdf", async (req, res, next) => {
  try {
    const act = await buildStockCountAct(req.params.id);
    const pdf = await renderStockCountActPdf(act);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildAttachmentContentDisposition(`${stockCountActFileBase(act)}.pdf`, "stock-count-act.pdf").replace(
        "attachment;",
        "inline;",
      ),
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  } catch (err) {
    next(err);
  }
});

/** GET /api/stock-counts/:id/act.xlsx — акт в XLSX: «Расхождения» + «Все позиции». */
router.get("/:id/act.xlsx", async (req, res, next) => {
  try {
    const act = await buildStockCountAct(req.params.id);
    const buf = await renderStockCountActXlsx(act);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      buildAttachmentContentDisposition(`${stockCountActFileBase(act)}.xlsx`, "stock-count-act.xlsx"),
    );
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
  } catch (err) {
    next(err);
  }
});

export { router as stockCountsRouter };
