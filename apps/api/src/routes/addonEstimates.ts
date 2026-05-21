import express from "express";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { serializeEstimateForJson } from "../utils/serializeDecimal";
import {
  buildSmetaFromPersistedEstimate,
  writeSmetaPdf,
  writeSmetaXlsx,
} from "../services/smetaExport";
import { buildBookingHumanName, safeFileName } from "../utils/bookingName";

const router = express.Router();

router.get("/:bookingId", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!addon) {
      res.json({ addon: null });
      return;
    }
    res.json({ addon: serializeEstimateForJson(addon) });
  } catch (err) {
    next(err);
  }
});

router.get("/:bookingId/export/pdf", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!addon) {
      throw new HttpError(404, "Доб-сметы нет — доборы не делали", "ADDON_ESTIMATE_NOT_FOUND");
    }
    const doc = buildSmetaFromPersistedEstimate({ booking: addon.booking, estimate: addon });
    const human = buildBookingHumanName({
      startDate: addon.booking.startDate,
      clientName: addon.booking.client.name,
      totalAfterDiscount: addon.totalAfterDiscount.toString(),
    });
    writeSmetaPdf(res, doc, `${safeFileName(human)}-добор.pdf`);
  } catch (err) {
    next(err);
  }
});

router.get("/:bookingId/export/xlsx", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!addon) {
      throw new HttpError(404, "Доб-сметы нет — доборы не делали", "ADDON_ESTIMATE_NOT_FOUND");
    }
    const doc = buildSmetaFromPersistedEstimate({ booking: addon.booking, estimate: addon });
    const human = buildBookingHumanName({
      startDate: addon.booking.startDate,
      clientName: addon.booking.client.name,
      totalAfterDiscount: addon.totalAfterDiscount.toString(),
    });
    await writeSmetaXlsx(res, doc, `${safeFileName(human)}-добор.xlsx`);
  } catch (err) {
    next(err);
  }
});

export { router as addonEstimatesRouter };
