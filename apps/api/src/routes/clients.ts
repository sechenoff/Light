import express from "express";
import { Decimal } from "@prisma/client/runtime/library";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { rolesGuard } from "../middleware/rolesGuard";

const router = express.Router();

/**
 * GET /api/clients/:id/stats
 * Статистика клиента для экрана согласования брони.
 * Доступ: SUPER_ADMIN, WAREHOUSE.
 */
router.get(
  "/:id/stats",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const client = await prisma.client.findUnique({ where: { id } });
      if (!client) {
        throw new HttpError(404, "Клиент не найден");
      }

      const bookings = await prisma.booking.findMany({
        where: { clientId: id, status: { not: "CANCELLED" } },
        select: {
          finalAmount: true,
          amountOutstanding: true,
          startDate: true,
        },
      });

      const bookingCount = bookings.length;

      let totalRevenue = new Decimal(0);
      let outstandingDebt = new Decimal(0);
      let lastBookingDate: Date | null = null;
      let amountPositiveCount = 0;
      let amountPositiveSum = new Decimal(0);

      for (const b of bookings) {
        totalRevenue = totalRevenue.add(b.finalAmount);
        outstandingDebt = outstandingDebt.add(b.amountOutstanding);

        if (b.finalAmount.greaterThan(0)) {
          amountPositiveCount += 1;
          amountPositiveSum = amountPositiveSum.add(b.finalAmount);
        }

        if (!lastBookingDate || b.startDate > lastBookingDate) {
          lastBookingDate = b.startDate;
        }
      }

      const averageCheck =
        amountPositiveCount > 0
          ? amountPositiveSum.dividedBy(amountPositiveCount)
          : new Decimal(0);

      res.json({
        clientId: client.id,
        clientName: client.name,
        bookingCount,
        averageCheck: averageCheck.toNumber(),
        totalRevenue: totalRevenue.toNumber(),
        outstandingDebt: outstandingDebt.toNumber(),
        hasDebt: outstandingDebt.greaterThan(0),
        lastBookingDate: lastBookingDate ? lastBookingDate.toISOString() : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as clientsRouter };
