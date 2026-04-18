/**
 * Роутер /api/gaffer/contacts — CRUD контактов Gaffer CRM.
 *
 * GET    /                    — список контактов
 * GET    /:id                 — один контакт
 * POST   /                    — создать контакт
 * PATCH  /:id                 — обновить контакт
 * POST   /:id/archive         — архивировать
 * POST   /:id/unarchive       — разархивировать
 * DELETE /:id                 — удалить
 */

import express from "express";
import { z } from "zod";
import { HttpError } from "../../utils/errors";
import {
  listContacts,
  getContact,
  createContact,
  updateContact,
  archiveContact,
  unarchiveContact,
  deleteContact,
  getContactDebtSummary,
  getContactsSummary,
} from "../../services/gaffer/contactService";

const router = express.Router();

// ─── Zod-схемы ───────────────────────────────────────────────────────────────

const contactTypeSchema = z.enum(["CLIENT", "TEAM_MEMBER"]);

const createContactSchema = z.object({
  type: contactTypeSchema,
  name: z.string().trim().min(1, "Имя обязательно").max(100),
  phone: z.string().trim().max(50).optional(),
  telegram: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
});

const updateContactSchema = createContactSchema
  .partial()
  .omit({ type: true });

const listQuerySchema = z.object({
  type: contactTypeSchema.optional(),
  isArchived: z
    .enum(["true", "false", "all"])
    .transform((v): boolean | "all" => v === "all" ? "all" : v === "true")
    .optional(),
  search: z.string().optional(),
  withAggregates: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

// ─── Нормализация telegram ────────────────────────────────────────────────────

function normalizeTelegram(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Strip URL prefixes (case-insensitive): https://t.me/, http://t.me/, t.me/
  let clean = trimmed.replace(/^https?:\/\/t\.me\//i, "").replace(/^t\.me\//i, "");

  // Strip leading @ signs (possibly multiple)
  clean = clean.replace(/^@+/, "");

  if (!/^[A-Za-z0-9_]{3,32}$/.test(clean)) {
    throw new HttpError(400, "Некорректный Telegram-логин", "INVALID_TELEGRAM");
  }

  return `@${clean}`;
}

function normalizeOptionalString(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ─── Маршруты ─────────────────────────────────────────────────────────────────

/**
 * GET /api/gaffer/contacts/summary
 * Сводка контактов: totals + counts.
 * Должен быть ПЕРЕД /:id чтобы не попасть под параметрический маршрут.
 */
router.get("/summary", async (req, res, next) => {
  try {
    const summary = await getContactsSummary(req);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gaffer/contacts
 * Список контактов с фильтрами type / isArchived / search / withAggregates.
 */
router.get("/", async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const items = await listContacts(req, query);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gaffer/contacts/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const contact = await getContact(req, req.params.id);
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/contacts
 */
router.post("/", async (req, res, next) => {
  try {
    const body = createContactSchema.parse(req.body);
    const contact = await createContact(req, {
      type: body.type,
      name: body.name,
      phone: normalizeOptionalString(body.phone),
      telegram: normalizeTelegram(body.telegram),
      note: normalizeOptionalString(body.note),
    });
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/gaffer/contacts/:id
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const body = updateContactSchema.parse(req.body);
    const contact = await updateContact(req, req.params.id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.phone !== undefined && { phone: normalizeOptionalString(body.phone) ?? null }),
      ...(body.telegram !== undefined && { telegram: normalizeTelegram(body.telegram) ?? null }),
      ...(body.note !== undefined && { note: normalizeOptionalString(body.note) ?? null }),
    });
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/contacts/:id/archive
 */
router.post("/:id/archive", async (req, res, next) => {
  try {
    const contact = await archiveContact(req, req.params.id);
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/contacts/:id/unarchive
 */
router.post("/:id/unarchive", async (req, res, next) => {
  try {
    const contact = await unarchiveContact(req, req.params.id);
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gaffer/contacts/:id/debt-summary
 * Сводка долга: для CLIENT — проекты + clientRemaining, для TEAM_MEMBER — членства + remaining.
 * Должен быть ДО /:id, но Express сам правильно разрешает /:id/debt-summary vs /:id.
 */
router.get("/:id/debt-summary", async (req, res, next) => {
  try {
    const summary = await getContactDebtSummary(req, req.params.id);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gaffer/contacts/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    await deleteContact(req, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { router as contactsRouter };
