import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { hashPassword, normalizeUsername } from "../services/auth";
import { requireRole } from "../middleware/sessionAuth";
import { HttpError } from "../utils/errors";

const router = express.Router();

// Все маршруты доступны только SUPER_ADMIN.
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
  role: z.enum(["SUPER_ADMIN", "RENTAL_ADMIN"]).default("RENTAL_ADMIN"),
});

const updateSchema = z.object({
  password: z.string().min(3).max(200).optional(),
  role: z.enum(["SUPER_ADMIN", "RENTAL_ADMIN"]).optional(),
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
    const existing = await prisma.adminUser.findUnique({ where: { username: body.username } });
    if (existing) {
      return res.status(409).json({ message: "Пользователь с таким логином уже существует" });
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.adminUser.create({
      data: { username: body.username, passwordHash, role: body.role },
      select: { id: true, username: true, role: true, createdAt: true, updatedAt: true },
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
    const body = updateSchema.parse(req.body);

    const existing = await prisma.adminUser.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Пользователь не найден");

    const data: { passwordHash?: string; role?: "SUPER_ADMIN" | "RENTAL_ADMIN" } = {};
    if (body.password) data.passwordHash = await hashPassword(body.password);
    if (body.role) data.role = body.role;

    const user = await prisma.adminUser.update({
      where: { id },
      data,
      select: { id: true, username: true, role: true, createdAt: true, updatedAt: true },
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

    await prisma.adminUser.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { router as adminUsersRouter };
