import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { parseBookingRangeBound } from "../utils/dates";

const router = express.Router();

const querySchema = z.object({
  date: z.string().optional(),
});

/**
 * GET /api/dashboard/today
 * Возвращает брони для дашборда: pickups, returns, active.
 */
router.get("/today", async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);

    let todayStart: Date;
    let todayEnd: Date;

    if (q.date) {
      try {
        todayStart = parseBookingRangeBound(q.date, "start");
        todayEnd = parseBookingRangeBound(q.date, "end");
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Некорректный формат даты");
      }
    } else {
      const now = new Date();
      todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
      todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    }

    const includeArgs = {
      client: true,
      items: {
        include: {
          equipment: { select: { name: true } },
        },
      },
    } as const;

    const [pickupsRaw, returnsRaw, activeRaw] = await Promise.all([
      // Pickups: CONFIRMED брони начинающиеся сегодня
      prisma.booking.findMany({
        where: {
          status: "CONFIRMED",
          startDate: { gte: todayStart, lte: todayEnd },
        },
        include: includeArgs,
      }),
      // Returns: ISSUED брони заканчивающиеся сегодня
      prisma.booking.findMany({
        where: {
          status: "ISSUED",
          endDate: { gte: todayStart, lte: todayEnd },
        },
        include: includeArgs,
      }),
      // Active: все ISSUED брони
      prisma.booking.findMany({
        where: { status: "ISSUED" },
        include: includeArgs,
      }),
    ]);

    function mapBooking(b: typeof pickupsRaw[number]) {
      return {
        id: b.id,
        projectName: b.projectName,
        clientName: b.client.name,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        status: b.status,
        finalAmount: b.finalAmount.toString(),
        itemCount: b.items.length,
        items: b.items.map((item) => ({
          equipmentName: item.equipment.name,
          quantity: item.quantity,
        })),
      };
    }

    res.json({
      pickups: pickupsRaw.map(mapBooking),
      returns: returnsRaw.map(mapBooking),
      active: activeRaw.map(mapBooking),
    });
  } catch (err) {
    next(err);
  }
});

export { router as dashboardRouter };
