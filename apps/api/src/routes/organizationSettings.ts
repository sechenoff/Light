import express from "express";
import { z } from "zod";
import { rolesGuard } from "../middleware/rolesGuard";
import { getSettings, updateSettings } from "../services/organizationService";

const router = express.Router();

const updateSchema = z.object({
  legalName: z.string().optional(),
  inn: z.string().regex(/^\d{10}(\d{2})?$/, "ИНН должен содержать 10 или 12 цифр").optional(),
  kpp: z.string().optional(),
  bankName: z.string().optional(),
  bankBik: z.string().optional(),
  rschet: z.string().optional(),
  kschet: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
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
