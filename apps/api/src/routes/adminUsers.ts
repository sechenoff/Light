import express from "express";
import { z } from "zod";
import type { Prisma as PrismaNamespace } from "@prisma/client";

import { prisma } from "../prisma";
import { hashPassword, normalizeUsername } from "../services/auth";
import { requireRole } from "../middleware/sessionAuth";
import { rolesGuard } from "../middleware/rolesGuard";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "../services/audit";

const router = express.Router();

// ──────────────────────────────────────────────
// GET /assignable — минимальный список пользователей для назначения задач/ремонтов.
// Доступно всем 3 ролям: WAREHOUSE/TECHNICIAN тоже должны уметь назначать задачи.
// Безопасный subset: только id+username+role, без passwordHash/timestamps.
// Размещено ДО router.use(requireRole("SUPER_ADMIN")), чтобы не падать на 403.
// ──────────────────────────────────────────────
router.get(
  "/assignable",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (_req, res, next) => {
    try {
      const users = await prisma.adminUser.findMany({
        select: { id: true, username: true, role: true },
        orderBy: { username: "asc" },
      });
      res.json({ users });
    } catch (err) {
      next(err);
    }
  },
);

// Все остальные маршруты доступны только SUPER_ADMIN.
router.use(requireRole("SUPER_ADMIN"));

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Логин должен быть не короче 3 символов")
    .max(50, "Логин должен быть не длиннее 50 символов")
    .regex(/^[a-zA-Z0-9_.-]+$/, "Логин: только латиница, цифры, дефис, подчёркивание, точка")
    .transform(normalizeUsername),
  password: z.string().min(3, "Пароль не короче 3 символов").max(200),
  role: z.enum(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]).default("WAREHOUSE"),
});

const updateSchema = z.object({
  password: z.string().min(3).max(200).optional(),
  role: z.enum(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]).optional(),
});

// ──────────────────────────────────────────────
// GET / — список пользователей
// ──────────────────────────────────────────────
router.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.adminUser.findMany({
      select: { id: true, username: true, role: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// POST / — создать пользователя
// ──────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const actorId = req.adminUser!.userId;
    const existing = await prisma.adminUser.findUnique({ where: { username: body.username } });
    if (existing) {
      return res.status(409).json({ message: "Пользователь с таким логином уже существует" });
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.adminUser.create({
        data: { username: body.username, passwordHash, role: body.role },
        select: { id: true, username: true, role: true, createdAt: true, updatedAt: true },
      });
      await writeAuditEntry({
        tx,
        userId: actorId,
        action: "ADMIN_USER_CREATE",
        entityType: "AdminUser",
        entityId: created.id,
        before: null,
        after: diffFields({ username: created.username, role: created.role } as Record<string, unknown>),
      });
      return created;
    });
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// PATCH /:id — изменить пароль или роль
// ──────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const actorId = req.adminUser!.userId;
    const body = updateSchema.parse(req.body);

    const existing = await prisma.adminUser.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Пользователь не найден");

    const before = diffFields({ username: existing.username, role: existing.role } as Record<string, unknown>);

    const data: { passwordHash?: string; role?: "SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN" } = {};
    if (body.password) data.passwordHash = await hashPassword(body.password);
    if (body.role) data.role = body.role;

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.adminUser.update({
        where: { id },
        data,
        select: { id: true, username: true, role: true, createdAt: true, updatedAt: true },
      });
      await writeAuditEntry({
        tx,
        userId: actorId,
        action: "ADMIN_USER_UPDATE",
        entityType: "AdminUser",
        entityId: id,
        before,
        after: diffFields({ username: updated.username, role: updated.role } as Record<string, unknown>),
      });
      return updated;
    });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// DELETE /:id — удалить пользователя
// ──────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const actorId = req.adminUser!.userId;
    const existing = await prisma.adminUser.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Пользователь не найден");

    // Нельзя удалить себя — чтобы не потерять доступ.
    if (req.adminUser?.userId === id) {
      return res.status(409).json({ message: "Нельзя удалить собственную учётную запись" });
    }

    // Нельзя удалить последнего SUPER_ADMIN.
    if (existing.role === "SUPER_ADMIN") {
      const superAdminCount = await prisma.adminUser.count({ where: { role: "SUPER_ADMIN" } });
      if (superAdminCount <= 1) {
        return res.status(409).json({ message: "Нельзя удалить последнего супер-администратора" });
      }
    }

    const before = diffFields({ username: existing.username, role: existing.role } as Record<string, unknown>);
    try {
      await prisma.$transaction(async (tx) => {
        await writeAuditEntry({
          tx,
          userId: actorId,
          action: "ADMIN_USER_DELETE",
          entityType: "AdminUser",
          entityId: id,
          before,
          after: null,
        });
        await tx.adminUser.delete({ where: { id } });
      });
    } catch (err) {
      // P2003 = FK constraint — у пользователя есть записи аудита
      if ((err as PrismaNamespace.PrismaClientKnownRequestError).code === "P2003") {
        return res.status(409).json({ code: "ADMIN_HAS_AUDIT_HISTORY", message: "Невозможно удалить: у пользователя есть записи аудита" });
      }
      throw err;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { router as adminUsersRouter };
