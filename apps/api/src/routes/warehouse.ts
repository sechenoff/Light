import express from "express";
import { z } from "zod";
import { authenticateWorker, hashPin } from "../services/warehouseAuth";
import { prisma } from "../prisma";

// ── Public router (mounted BEFORE apiKeyAuth) ─────────────────────────────────

export const warehousePublicRouter = express.Router();

const authBodySchema = z.object({
  name: z.string().min(1),
  pin: z.string().min(1),
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
    res.json({ token: result.token });
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
  pin: z.string().min(1),
});

const updateWorkerSchema = z.object({
  name: z.string().min(1).optional(),
  pin: z.string().min(1).optional(),
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
