import express from "express";
import { z } from "zod";
import { authenticateWorker, hashPin } from "../services/warehouseAuth";
import { prisma } from "../prisma";
import { warehouseAuth } from "../middleware/warehouseAuth";
import {
  createSession,
  recordScan,
  completeSession,
  cancelSession,
  getSessionWithDetails,
} from "../services/warehouseScan";

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
warehouseRouter.get("/workers", async (_req, res, next) => {
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
warehouseRouter.post("/workers", async (req, res, next) => {
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
warehouseRouter.patch("/workers/:id", async (req, res, next) => {
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
warehouseRouter.delete("/workers/:id", async (req, res, next) => {
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

// All routes in this router require a valid warehouse worker token
warehouseScanRouter.use(warehouseAuth);

const operationSchema = z.enum(["ISSUE", "RETURN"]);

const createSessionBodySchema = z.object({
  bookingId: z.string().min(1),
  operation: operationSchema,
});

const scanBodySchema = z.object({
  barcodePayload: z.string().min(1),
});

/** GET /api/warehouse/bookings — список броней, доступных для сканирования */
warehouseScanRouter.get("/bookings", async (req, res, next) => {
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
        project: true,
        startDate: true,
        endDate: true,
        status: true,
        _count: { select: { items: true } },
      },
    });

    res.json({
      bookings: bookings.map((b) => ({
        id: b.id,
        client: b.client,
        project: b.project,
        startDate: b.startDate,
        endDate: b.endDate,
        status: b.status,
        itemCount: b._count.items,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions — создать сессию сканирования */
warehouseScanRouter.post("/sessions", async (req, res, next) => {
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
warehouseScanRouter.get("/sessions/:id", async (req, res, next) => {
  try {
    const result = await getSessionWithDetails(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/scan — зарегистрировать сканирование */
warehouseScanRouter.post("/sessions/:id/scan", async (req, res, next) => {
  try {
    const { barcodePayload } = scanBodySchema.parse(req.body);
    const result = await recordScan(req.params.id, barcodePayload);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/complete — завершить сессию */
warehouseScanRouter.post("/sessions/:id/complete", async (req, res, next) => {
  try {
    const summary = await completeSession(req.params.id);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/cancel — отменить сессию */
warehouseScanRouter.post("/sessions/:id/cancel", async (req, res, next) => {
  try {
    const session = await cancelSession(req.params.id);
    res.json(session);
  } catch (err) {
    next(err);
  }
});
