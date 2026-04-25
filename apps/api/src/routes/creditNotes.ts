import express from "express";
import { z } from "zod";
import { rolesGuard } from "../middleware/rolesGuard";
import { createCreditNote, applyCreditNote, listCreditNotes } from "../services/creditNoteService";

const router = express.Router();

const createSchema = z.object({
  contactClientId: z.string().min(1),
  bookingId: z.string().optional(),
  amount: z.number().positive(),
  reason: z.string().min(3, "Причина обязательна (минимум 3 символа)"),
  expiresAt: z.string().datetime().optional(),
});

const applySchema = z.object({
  applyToBookingId: z.string().min(1),
});

/**
 * POST /api/credit-notes — SA only
 * Создать кредит-ноту.
 */
router.post("/", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const note = await createCreditNote(
      {
        contactClientId: body.contactClientId,
        bookingId: body.bookingId,
        amount: body.amount,
        reason: body.reason,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      },
      userId,
    );

    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/credit-notes/:id/apply — SA only
 * Применить кредит-ноту к броне.
 */
router.post("/:id/apply", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const { applyToBookingId } = applySchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const note = await applyCreditNote(req.params.id, applyToBookingId, userId);

    res.json(note);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/credit-notes — SA + WH (read)
 * Список кредит-нот.
 */
router.get("/", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { contactClientId, bookingId, limit, offset } = req.query;

    const result = await listCreditNotes({
      contactClientId: contactClientId as string | undefined,
      bookingId: bookingId as string | undefined,
      limit: parseInt(limit as string) || undefined,
      offset: parseInt(offset as string) || undefined,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export { router as creditNotesRouter };
