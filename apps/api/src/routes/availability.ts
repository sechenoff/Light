import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { getAvailability } from "../services/availability";
import { HttpError } from "../utils/errors";
import { assertBookingRangeOrder, parseBookingRangeBound } from "../utils/dates";

const router = express.Router();

const querySchema = z.object({
  start: z.string(),
  end: z.string(),
  search: z.string().optional(),
  category: z.string().optional(),
  excludeBookingId: z.string().optional(),
});

router.get("/", async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    let start: Date;
    let end: Date;
    try {
      start = parseBookingRangeBound(q.start, "start");
      end = parseBookingRangeBound(q.end, "end");
      assertBookingRangeOrder(start, end);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Некорректный период");
    }

    const rows = await getAvailability({
      startDate: start,
      endDate: end,
      search: q.search,
      category: q.category,
      excludeBookingId: q.excludeBookingId,
      tx: prisma,
    });

    const response = rows.map((r) => ({
      equipmentId: r.equipment.id,
      category: r.equipment.category,
      name: r.equipment.name,
      brand: r.equipment.brand,
      model: r.equipment.model,
      stockTrackingMode: r.equipment.stockTrackingMode,
      totalQuantity: r.equipment.totalQuantity,
      // Prisma Decimal иначе уходит в JSON как объект — фронт показывал «0.00»
      rentalRatePerShift: r.equipment.rentalRatePerShift.toString(),
      occupiedQuantity: r.occupiedQuantity,
      availableQuantity: r.availableQuantity,
      // «Частично» = есть реальные брони, но не всё разобрано. Порог считаем от
      // фактической занятости (occupiedQuantity), а НЕ от totalQuantity: у UNIT-
      // позиций база доступности = число пригодных единиц (usableUnitBase), которая
      // меньше totalQuantity при наличии единиц в ремонте/списании. Сравнение с
      // totalQuantity ложно давало «Частично» при нуле броней (5 всего, 1 в ремонте,
      // 0 забронировано → available=4 < 5). Теперь PARTIAL строго при occupied > 0.
      availability:
        r.availableQuantity <= 0
          ? "UNAVAILABLE"
          : r.occupiedQuantity > 0
            ? "PARTIAL"
            : "AVAILABLE",
      comment: r.equipment.comment,
    }));

    res.json({ rows: response });
  } catch (err) {
    next(err);
  }
});

export { router as availabilityRouter };

