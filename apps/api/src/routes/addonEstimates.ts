import express from "express";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { serializeEstimateForJson } from "../utils/serializeDecimal";
import {
  buildSmetaFromPersistedEstimate,
  loadSmetaLineOrdering,
  writeSmetaPdf,
  writeSmetaXlsx,
  smetaOrgFromSettings,
} from "../services/smetaExport";
import { getSettings } from "../services/organizationService";
import { estimateLineKey, sortLinesByCatalogAsync } from "../services/lineOrder";
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
    // Строки добора — в порядке каталога, как в основной смете и в PDF.
    const lines = await sortLinesByCatalogAsync(addon.lines, estimateLineKey);
    res.json({ addon: serializeEstimateForJson({ ...addon, lines }) });
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
    const doc = buildSmetaFromPersistedEstimate({
      booking: addon.booking,
      estimate: addon,
      org: smetaOrgFromSettings(await getSettings()),
      ordering: await loadSmetaLineOrdering(addon),
    });
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
    const doc = buildSmetaFromPersistedEstimate({
      booking: addon.booking,
      estimate: addon,
      org: smetaOrgFromSettings(await getSettings()),
      ordering: await loadSmetaLineOrdering(addon),
    });
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
