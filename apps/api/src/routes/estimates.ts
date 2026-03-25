import express from "express";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { serializeEquipmentForJson, serializeEstimateForJson } from "../utils/serializeDecimal";
import { buildSmetaFromPersistedEstimate, writeSmetaPdf, writeSmetaXlsx } from "../services/smetaExport";
import { buildBookingHumanName, safeFileName } from "../utils/bookingName";

const router = express.Router();

router.get("/:estimateId", async (req, res, next) => {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: req.params.estimateId },
      include: {
        booking: { include: { client: true, items: { include: { equipment: true } } } },
        lines: true,
      },
    });
    if (!estimate) throw new HttpError(404, "Estimate not found.");
    res.json({
      estimate: {
        ...serializeEstimateForJson(estimate),
        booking: {
          ...estimate.booking,
          discountPercent: estimate.booking.discountPercent?.toString() ?? null,
          items: estimate.booking.items.map((it) => ({
            ...it,
            equipment: serializeEquipmentForJson(it.equipment),
          })),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:estimateId/export/xlsx", async (req, res, next) => {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: req.params.estimateId },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!estimate) throw new HttpError(404, "Estimate not found.");

    const doc = buildSmetaFromPersistedEstimate({
      booking: estimate.booking,
      estimate,
    });
    const human = buildBookingHumanName({
      startDate: estimate.booking.startDate,
      clientName: estimate.booking.client.name,
      totalAfterDiscount: estimate.totalAfterDiscount.toString(),
    });
    await writeSmetaXlsx(res, doc, `${safeFileName(human)}.xlsx`);
  } catch (err) {
    next(err);
  }
});

router.get("/:estimateId/export/pdf", async (req, res, next) => {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: req.params.estimateId },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!estimate) throw new HttpError(404, "Estimate not found.");

    const doc = buildSmetaFromPersistedEstimate({
      booking: estimate.booking,
      estimate,
    });
    const human = buildBookingHumanName({
      startDate: estimate.booking.startDate,
      clientName: estimate.booking.client.name,
      totalAfterDiscount: estimate.totalAfterDiscount.toString(),
    });
    writeSmetaPdf(res, doc, `${safeFileName(human)}.pdf`);
  } catch (err) {
    next(err);
  }
});

export { router as estimatesRouter };
