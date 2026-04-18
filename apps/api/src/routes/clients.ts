import express from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import { getClientStats } from "../services/clientStats";
import { writeAuditEntry, diffFields } from "../services/audit";
import { HttpError } from "../utils/errors";

const router = express.Router();

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const clientBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).optional().or(z.literal("").transform(() => undefined)),
  email: z
    .string()
    .trim()
    .email()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  comment: z.string().trim().max(1000).optional().or(z.literal("").transform(() => undefined)),
});

const clientPatchSchema = clientBodySchema.partial();

/**
 * GET /api/clients
 * Список клиентов для селектов/автокомплита.
 * Доступ: SUPER_ADMIN, WAREHOUSE.
 */
router.get("/", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const where = q.search
      ? { name: { contains: q.search } }
      : {};
    const clients = await prisma.client.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        comment: true,
        createdAt: true,
        _count: { select: { bookings: true } },
      },
      orderBy: { name: "asc" },
      take: q.limit,
    });
    res.json({
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        comment: c.comment,
        createdAt: c.createdAt,
        bookingCount: c._count.bookings,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/clients
 * Создать клиента.
 * Доступ: SUPER_ADMIN.
 */
router.post("/", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = clientBodySchema.parse(req.body);
    const userId = req.adminUser!.userId;
    let created: { id: string; name: string; phone: string | null; email: string | null; comment: string | null; createdAt: Date };
    try {
      created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const client = await tx.client.create({
          data: {
            name: body.name,
            phone: body.phone ?? null,
            email: body.email ?? null,
            comment: body.comment ?? null,
          },
          select: { id: true, name: true, phone: true, email: true, comment: true, createdAt: true },
        });
        await writeAuditEntry({
          tx,
          userId,
          action: "CLIENT_CREATE",
          entityType: "Client",
          entityId: client.id,
          before: null,
          after: { name: client.name, phone: client.phone, email: client.email, comment: client.comment },
        });
        return client;
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        throw new HttpError(409, "Клиент с таким именем уже существует", "CLIENT_NAME_TAKEN");
      }
      throw err;
    }
    res.status(201).json({ client: { ...created, bookingCount: 0 } });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/clients/:id
 * Обновить клиента (partial update).
 * Доступ: SUPER_ADMIN.
 */
router.patch("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = clientPatchSchema.parse(req.body);
    const { id } = req.params;
    const userId = req.adminUser!.userId;
    let updated: { id: string; name: string; phone: string | null; email: string | null; comment: string | null; createdAt: Date };
    try {
      updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const existing = await tx.client.findUnique({
          where: { id },
          select: { id: true, name: true, phone: true, email: true, comment: true, createdAt: true },
        });
        if (!existing) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");
        const client = await tx.client.update({
          where: { id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.phone !== undefined ? { phone: body.phone ?? null } : {}),
            ...(body.email !== undefined ? { email: body.email ?? null } : {}),
            ...(body.comment !== undefined ? { comment: body.comment ?? null } : {}),
          },
          select: { id: true, name: true, phone: true, email: true, comment: true, createdAt: true },
        });
        await writeAuditEntry({
          tx,
          userId,
          action: "CLIENT_UPDATE",
          entityType: "Client",
          entityId: id,
          before: diffFields({ name: existing.name, phone: existing.phone, email: existing.email, comment: existing.comment } as Record<string, unknown>),
          after: diffFields({ name: client.name, phone: client.phone, email: client.email, comment: client.comment } as Record<string, unknown>),
        });
        return client;
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        throw new HttpError(409, "Клиент с таким именем уже существует", "CLIENT_NAME_TAKEN");
      }
      throw err;
    }
    res.json({ client: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/clients/:id
 * Удалить клиента (только без броней).
 * Доступ: SUPER_ADMIN.
 */
router.delete("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.adminUser!.userId;
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const existing = await tx.client.findUnique({
          where: { id },
          select: { id: true, name: true, phone: true, email: true, comment: true },
        });
        if (!existing) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");
        await tx.client.delete({ where: { id } });
        await writeAuditEntry({
          tx,
          userId,
          action: "CLIENT_DELETE",
          entityType: "Client",
          entityId: id,
          before: { name: existing.name, phone: existing.phone, email: existing.email, comment: existing.comment },
          after: null,
        });
      });
    } catch (err: any) {
      if (err?.code === "P2003") {
        throw new HttpError(409, "Нельзя удалить клиента с активными бронями", "CLIENT_HAS_BOOKINGS");
      }
      throw err;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients/:id/stats
 * Статистика клиента для экрана согласования брони.
 * Доступ: SUPER_ADMIN, WAREHOUSE.
 */
router.get(
  "/:id/stats",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const stats = await getClientStats(req.params.id);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  }
);

export { router as clientsRouter };
