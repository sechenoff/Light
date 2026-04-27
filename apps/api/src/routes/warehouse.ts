import express from "express";
import { z } from "zod";
import { authenticateWorker, hashPin } from "../services/warehouseAuth";
import { prisma } from "../prisma";
import { warehouseAuth } from "../middleware/warehouseAuth";
import { rolesGuard } from "../middleware/rolesGuard";
import {
  createSession,
  recordScan,
  completeSession,
  cancelSession,
  getSessionWithDetails,
  getReconciliationPreview,
  type BrokenUnit,
} from "../services/warehouseScan";
import {
  checkUnit,
  uncheckUnit,
  getChecklistState,
  addExtraItem,
} from "../services/checklistService";

// ── Public router (mounted BEFORE apiKeyAuth) ─────────────────────────────────

export const warehousePublicRouter = express.Router();

const pinSchema = z.string().min(4, "PIN должен быть не менее 4 символов").regex(/^\d+$/, "PIN должен содержать только цифры");

const authBodySchema = z.object({
  name: z.string().min(1),
  pin: pinSchema,
});

/** POST /api/warehouse/auth — аутентификация сотрудника склада по PIN */
warehousePublicRouter.post("/auth", async (req, res, next) => {
  try {
    const { name, pin } = authBodySchema.parse(req.body);
    const result = await authenticateWorker(name, pin);
    if ("error" in result) {
      res.status(401).json({ message: result.error });
      return;
    }
    res.json({ token: result.token, name: result.name, expiresAt: result.expiresAt });
  } catch (err) {
    next(err);
  }
});

/** GET /api/warehouse/workers/names — список имён активных сотрудников */
warehousePublicRouter.get("/workers/names", async (_req, res, next) => {
  try {
    const workers = await prisma.warehousePin.findMany({
      where: { isActive: true },
      select: { name: true },
    });
    res.json({ names: workers.map((w) => w.name) });
  } catch (err) {
    next(err);
  }
});

// ── Admin router (mounted AFTER apiKeyAuth via routes/index.ts) ───────────────

export const warehouseRouter = express.Router();

const createWorkerSchema = z.object({
  name: z.string().min(1),
  pin: pinSchema,
});

const updateWorkerSchema = z.object({
  name: z.string().min(1).optional(),
  pin: pinSchema.optional(),
  isActive: z.boolean().optional(),
});

/** GET /api/warehouse/workers — список всех сотрудников (для администратора) */
warehouseRouter.get("/workers", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (_req, res, next) => {
  try {
    const workers = await prisma.warehousePin.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        lastLoginAt: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    res.json({ workers });
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/workers — создать нового сотрудника */
warehouseRouter.post("/workers", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { name, pin } = createWorkerSchema.parse(req.body);
    const pinHash = await hashPin(pin);
    const worker = await prisma.warehousePin.create({
      data: { name, pinHash },
      select: {
        id: true,
        name: true,
        isActive: true,
        lastLoginAt: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    res.status(201).json({ worker });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/warehouse/workers/:id — обновить сотрудника */
warehouseRouter.patch("/workers/:id", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = updateWorkerSchema.parse(req.body);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.pin !== undefined) data.pinHash = await hashPin(body.pin);
    if (body.isActive !== undefined) data.isActive = body.isActive;

    const worker = await prisma.warehousePin.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        isActive: true,
        lastLoginAt: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    res.json({ worker });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/warehouse/workers/:id — удалить сотрудника */
warehouseRouter.delete("/workers/:id", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.warehousePin.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Scan session router (Bearer token auth, mounted BEFORE apiKeyAuth) ────────

export const warehouseScanRouter = express.Router();

const operationSchema = z.enum(["ISSUE", "RETURN"]);

const createSessionBodySchema = z.object({
  bookingId: z.string().min(1),
  operation: operationSchema,
});

const scanBodySchema = z.object({
  barcodePayload: z.string().min(1),
});

/** GET /api/warehouse/bookings — список броней, доступных для сканирования */
warehouseScanRouter.get("/bookings", warehouseAuth, async (req, res, next) => {
  try {
    const parseResult = operationSchema.safeParse(req.query.operation);
    if (!parseResult.success) {
      res.status(400).json({ message: "Параметр operation обязателен и должен быть ISSUE или RETURN" });
      return;
    }
    const operation = parseResult.data;
    const status = operation === "ISSUE" ? "CONFIRMED" : "ISSUED";

    const bookings = await prisma.booking.findMany({
      where: { status },
      select: {
        id: true,
        client: true,
        projectName: true,
        startDate: true,
        endDate: true,
        status: true,
        items: { select: { id: true } },
      },
    });

    res.json({
      bookings: bookings.map((b) => ({
        id: b.id,
        client: b.client,
        projectName: b.projectName,
        startDate: b.startDate,
        endDate: b.endDate,
        status: b.status,
        items: b.items.map((i) => ({ id: i.id })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions — создать сессию сканирования */
warehouseScanRouter.post("/sessions", warehouseAuth, async (req, res, next) => {
  try {
    const { bookingId, operation } = createSessionBodySchema.parse(req.body);
    const workerName = req.warehouseWorker!.name;
    const session = await createSession(bookingId, workerName, operation);
    res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

/** GET /api/warehouse/sessions/:id — получить детали сессии */
warehouseScanRouter.get("/sessions/:id", warehouseAuth, async (req, res, next) => {
  try {
    const result = await getSessionWithDetails(req.params.id);
    // Rename trackingMode→scanMode and scanned→scannedCount to match frontend contract
    res.json({
      ...result,
      bookingItems: result.bookingItems.map((item) => ({
        ...item,
        scanMode: item.trackingMode,
        scannedCount: item.scanned ?? 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/scan — зарегистрировать сканирование */
warehouseScanRouter.post("/sessions/:id/scan", warehouseAuth, async (req, res, next) => {
  try {
    const { barcodePayload } = scanBodySchema.parse(req.body);
    const result = await recordScan(req.params.id, barcodePayload);
    if ("error" in result) {
      res.status(400).json({ status: "error", message: result.error });
      return;
    }
    res.json({ status: "ok", ...result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/warehouse/sessions/:id/summary — предварительная сверка (без завершения) */
warehouseScanRouter.get("/sessions/:id/summary", warehouseAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const summary = await getReconciliationPreview(id);

    // Enrich unit ID arrays with name and barcode data
    const [missingUnits, substitutedUnits] = await Promise.all([
      summary.missing.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.missing } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
      summary.substituted.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.substituted } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    // Fetch session for sessionId and operation fields
    const session = await prisma.scanSession.findUnique({
      where: { id },
      select: { id: true, operation: true },
    });

    res.json({
      sessionId: session?.id ?? id,
      operation: session?.operation ?? "ISSUE",
      scannedCount: summary.scanned,
      expectedCount: summary.expected,
      missingItems: missingUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
      substitutedItems: substitutedUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
    });
  } catch (err) {
    next(err);
  }
});

const brokenUnitSchema = z.object({
  equipmentUnitId: z.string().min(1),
  reason: z.string().min(1),
  urgency: z.enum(["NOT_URGENT", "NORMAL", "URGENT"]),
});

const completeSessionBodySchema = z.object({
  brokenUnits: z.array(brokenUnitSchema).optional(),
}).optional();

/** POST /api/warehouse/sessions/:id/complete — завершить сессию */
warehouseScanRouter.post("/sessions/:id/complete", warehouseAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = completeSessionBodySchema.parse(req.body);
    const brokenUnits = body?.brokenUnits as BrokenUnit[] | undefined;
    const summary = await completeSession(id, {
      brokenUnits,
      createdBy: req.warehouseWorker?.name,
    });

    // Enrich unit ID arrays with name and barcode data
    const [missingUnits, substitutedUnits] = await Promise.all([
      summary.missing.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.missing } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
      summary.substituted.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.substituted } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    // Fetch session for operation field (status is now COMPLETED)
    const session = await prisma.scanSession.findUnique({
      where: { id },
      select: { id: true, operation: true },
    });

    res.json({
      sessionId: session?.id ?? id,
      operation: session?.operation ?? "ISSUE",
      scannedCount: summary.scanned,
      expectedCount: summary.expected,
      missingItems: missingUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
      substitutedItems: substitutedUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
      createdRepairIds: summary.createdRepairIds,
      failedBrokenUnits: summary.failedBrokenUnits,
    });
  } catch (err) {
    next(err);
  }
});

// ── Checklist endpoints (без сканера) ─────────────────────────────────────────

const checkBodySchema = z.object({
  equipmentUnitId: z.string().min(1),
});

const uncheckBodySchema = z.object({
  equipmentUnitId: z.string().min(1),
});

const addItemBodySchema = z.object({
  equipmentId: z.string().min(1),
  quantity: z.number().int().positive(),
});

/** GET /api/warehouse/sessions/:id/state — текущее состояние чек-листа */
warehouseScanRouter.get("/sessions/:id/state", warehouseAuth, async (req, res, next) => {
  try {
    const state = await getChecklistState(req.params.id);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/check — отметить UNIT-позицию */
warehouseScanRouter.post("/sessions/:id/check", warehouseAuth, async (req, res, next) => {
  try {
    const { equipmentUnitId } = checkBodySchema.parse(req.body);
    const result = await checkUnit(req.params.id, equipmentUnitId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/uncheck — снять отметку с UNIT-позиции */
warehouseScanRouter.post("/sessions/:id/uncheck", warehouseAuth, async (req, res, next) => {
  try {
    const { equipmentUnitId } = uncheckBodySchema.parse(req.body);
    const result = await uncheckUnit(req.params.id, equipmentUnitId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/items — быстрое добавление позиции в бронь */
warehouseScanRouter.post("/sessions/:id/items", warehouseAuth, async (req, res, next) => {
  try {
    const { equipmentId, quantity } = addItemBodySchema.parse(req.body);
    const createdBy = req.warehouseWorker?.name ?? "warehouse";
    const result = await addExtraItem(req.params.id, equipmentId, quantity, createdBy);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/cancel — отменить сессию */
warehouseScanRouter.post("/sessions/:id/cancel", warehouseAuth, async (req, res, next) => {
  try {
    const session = await cancelSession(req.params.id);
    res.json(session);
  } catch (err) {
    next(err);
  }
});
