import express from "express";
import { z } from "zod";
import { rolesGuard } from "../middleware/rolesGuard";
import { getSettings, updateSettings } from "../services/organizationService";

const router = express.Router();

const updateSchema = z.object({
  legalName: z.string().optional(),
  // Пустая строка = очистка (колонка не-nullable с default "")
  inn: z
    .string()
    .regex(/^\d{10}(\d{2})?$/, "ИНН должен содержать 10 или 12 цифр")
    .or(z.literal(""))
    .optional(),
  // Nullable-колонки: null = очистка поля
  kpp: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  bankBik: z.string().nullable().optional(),
  rschet: z.string().nullable().optional(),
  kschet: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  invoiceNumberPrefix: z.string().min(1).max(10).optional(),
  migrationCutoffAt: z.string().datetime().optional(),
  defaultPaymentTermsDays: z.number().int().min(0).max(90).optional(),
});

/**
 * GET /api/settings/organization — SA only
 * Получить настройки организации.
 */
router.get("/organization", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/settings/organization — SA only
 * Обновить настройки организации (partial update).
 */
router.patch("/organization", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const settings = await updateSettings(
      {
        ...body,
        migrationCutoffAt: body.migrationCutoffAt ? new Date(body.migrationCutoffAt) : undefined,
      },
      userId,
    );

    res.json(settings);
  } catch (err) {
    next(err);
  }
});

export { router as organizationSettingsRouter };
