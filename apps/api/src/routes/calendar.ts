import express from "express";
import { z } from "zod";
import type { BookingStatus } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { parseBookingRangeBound, diffDaysInclusive, assertBookingRangeOrder } from "../utils/dates";

const router = express.Router();

const BLOCKING_STATUSES: BookingStatus[] = ["CONFIRMED", "ISSUED"];

// ──────────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────────

const calendarQuerySchema = z.object({
  start: z.string(),
  end: z.string(),
  category: z.string().optional(),
  search: z.string().optional(),
  includeDrafts: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const occupancyQuerySchema = z.object({
  start: z.string(),
  end: z.string(),
});

// ──────────────────────────────────────────────────────────────────
// GET /api/calendar
// ──────────────────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const q = calendarQuerySchema.parse(req.query);

    let start: Date;
    let end: Date;
    try {
      start = parseBookingRangeBound(q.start, "start");
      end = parseBookingRangeBound(q.end, "end");
      assertBookingRangeOrder(start, end);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Некорректный период");
    }

    const statuses: BookingStatus[] = q.includeDrafts
      ? ["DRAFT", ...BLOCKING_STATUSES]
      : BLOCKING_STATUSES;

    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: statuses },
        startDate: { lte: end },
        endDate: { gte: start },
      },
      include: {
        client: true,
        items: {
          include: {
            equipment: {
              select: {
                id: true,
                name: true,
                category: true,
                totalQuantity: true,
                stockTrackingMode: true,
              },
            },
          },
        },
      },
    });

    const searchLower = q.search?.trim().toLocaleLowerCase("ru-RU") ?? "";

    // Фильтрация по категории и поиску
    const filteredBookings = bookings.filter((b) => {
      if (q.category) {
        const hasCategory = b.items.some((item) => item.equipment.category === q.category);
        if (!hasCategory) return false;
      }
      if (searchLower) {
        const matchesProject = b.projectName.toLocaleLowerCase("ru-RU").includes(searchLower);
        const matchesClient = b.client.name.toLocaleLowerCase("ru-RU").includes(searchLower);
        if (!matchesProject && !matchesClient) return false;
      }
      return true;
    });

    // Собираем уникальные ресурсы из айтемов
    const resourcesMap = new Map<
      string,
      { id: string; name: string; category: string; totalQuantity: number; trackingMode: string }
    >();

    const events: Array<{
      id: string;
      bookingId: string;
      resourceId: string;
      title: string;
      clientName: string;
      start: string;
      end: string;
      quantity: number;
      status: BookingStatus;
    }> = [];

    for (const booking of filteredBookings) {
      for (const item of booking.items) {
        // Фильтрация по категории на уровне айтема
        if (q.category && item.equipment.category !== q.category) continue;

        const eq = item.equipment;
        if (!resourcesMap.has(eq.id)) {
          resourcesMap.set(eq.id, {
            id: eq.id,
            name: eq.name,
            category: eq.category,
            totalQuantity: eq.totalQuantity,
            trackingMode: eq.stockTrackingMode,
          });
        }

        events.push({
          id: item.id,
          bookingId: booking.id,
          resourceId: eq.id,
          title: booking.projectName,
          clientName: booking.client.name,
          start: booking.startDate.toISOString(),
          end: booking.endDate.toISOString(),
          quantity: item.quantity,
          status: booking.status,
        });
      }
    }

    res.json({
      resources: Array.from(resourcesMap.values()),
      events,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/calendar/occupancy
// ──────────────────────────────────────────────────────────────────

router.get("/occupancy", async (req, res, next) => {
  try {
    const q = occupancyQuerySchema.parse(req.query);

    let start: Date;
    let end: Date;
    try {
      start = parseBookingRangeBound(q.start, "start");
      end = parseBookingRangeBound(q.end, "end");
      assertBookingRangeOrder(start, end);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Некорректный период");
    }

    const dayCount = diffDaysInclusive(start, end);
    if (dayCount > 90) {
      throw new HttpError(400, "Максимальный период — 90 дней");
    }

    // Суммарная мощность всего оборудования
    const capacityResult = await prisma.equipment.aggregate({
      _sum: { totalQuantity: true },
    });
    const totalCapacity = capacityResult._sum.totalQuantity ?? 0;

    // Брони пересекающиеся с диапазоном (только CONFIRMED и ISSUED)
    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: BLOCKING_STATUSES },
        startDate: { lte: end },
        endDate: { gte: start },
      },
      include: {
        items: { select: { quantity: true } },
      },
    });

    // Генерируем массив дней в диапазоне
    const days: Array<{ date: string; bookingCount: number; occupancyPercent: number }> = [];

    for (let i = 0; i < dayCount; i++) {
      const dayStart = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate() + i,
        0, 0, 0, 0
      ));
      const dayEnd = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate() + i,
        23, 59, 59, 999
      ));

      const dateStr = dayStart.toISOString().slice(0, 10);

      // Брони пересекающиеся с этим днём
      const overlapping = bookings.filter(
        (b) => b.startDate <= dayEnd && b.endDate >= dayStart
      );

      const occupiedQuantity = overlapping.reduce(
        (sum, b) => sum + b.items.reduce((s, item) => s + item.quantity, 0),
        0
      );

      const occupancyPercent =
        totalCapacity > 0 ? Math.min(100, (occupiedQuantity / totalCapacity) * 100) : 0;

      days.push({
        date: dateStr,
        bookingCount: overlapping.length,
        occupancyPercent: Math.round(occupancyPercent * 100) / 100,
      });
    }

    res.json({ days, totalCapacity });
  } catch (err) {
    next(err);
  }
});

export { router as calendarRouter };
