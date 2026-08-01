import express from "express";
import { z } from "zod";
import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "../services/audit";
import {
  listVehicles,
  getVehicleDetail,
  updateVehicleMeta,
  logMileageManual,
  addServiceLog,
} from "../services/vehicleService";
import { computeFleetDashboard, parseFleetPeriod } from "../services/fleetDashboard";

const router = express.Router();

// ── GET /api/vehicles — публичный список активных машин (все аутентифицированные роли) ──
// Кормит подбор транспорта в форме брони, поэтому здесь только `bookable`:
// генератор числится в парке и обслуживается, но машиной не является и в
// списке транспорта появляться не должен.
router.get("/", async (_req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { active: true, bookable: true },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        slug: true,
        name: true,
        shiftPriceRub: true,
        hasGeneratorOption: true,
        generatorPriceRub: true,
        shiftHours: true,
        overtimePercent: true,
        displayOrder: true,
      },
    });

    res.json({
      vehicles: vehicles.map((v) => ({
        ...v,
        shiftPriceRub: new Decimal(v.shiftPriceRub.toString()).toFixed(2),
        generatorPriceRub: v.generatorPriceRub != null ? new Decimal(v.generatorPriceRub.toString()).toFixed(2) : null,
        overtimePercent: new Decimal(v.overtimePercent.toString()).toFixed(2),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/vehicles — все машины включая неактивные (SUPER_ADMIN) ──
router.get("/admin", rolesGuard(["SUPER_ADMIN"]), async (_req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    });

    res.json({
      vehicles: vehicles.map((v) => ({
        ...v,
        shiftPriceRub: new Decimal(v.shiftPriceRub.toString()).toFixed(2),
        generatorPriceRub: v.generatorPriceRub != null ? new Decimal(v.generatorPriceRub.toString()).toFixed(2) : null,
        overtimePercent: new Decimal(v.overtimePercent.toString()).toFixed(2),
      })),
    });
  } catch (err) {
    next(err);
  }
});

const vehiclePatchSchema = z.object({
  shiftPriceRub: z.number().positive().optional(),
  generatorPriceRub: z.number().positive().nullable().optional(),
  shiftHours: z.number().int().positive().optional(),
  overtimePercent: z.number().min(0).max(100).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
  // slug and hasGeneratorOption are immutable — silently ignored if passed
});

// ── PATCH /api/admin/vehicles/:id — редактировать (SUPER_ADMIN) ──
router.patch("/admin/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = vehiclePatchSchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const existing = await prisma.vehicle.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Vehicle not found");

    const updateData: Record<string, unknown> = {};
    if (body.shiftPriceRub !== undefined) updateData.shiftPriceRub = new Decimal(body.shiftPriceRub).toFixed(2);
    if (body.generatorPriceRub !== undefined) updateData.generatorPriceRub = body.generatorPriceRub != null ? new Decimal(body.generatorPriceRub).toFixed(2) : null;
    if (body.shiftHours !== undefined) updateData.shiftHours = body.shiftHours;
    if (body.overtimePercent !== undefined) updateData.overtimePercent = new Decimal(body.overtimePercent).toFixed(2);
    if (body.active !== undefined) updateData.active = body.active;
    if (body.displayOrder !== undefined) updateData.displayOrder = body.displayOrder;

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.vehicle.update({
        where: { id },
        data: updateData,
      });

      await writeAuditEntry({
        tx,
        userId,
        action: "VEHICLE_UPDATED",
        entityType: "Vehicle",
        entityId: id,
        before: {
          shiftPriceRub: existing.shiftPriceRub.toString(),
          generatorPriceRub: existing.generatorPriceRub?.toString() ?? null,
          shiftHours: existing.shiftHours,
          overtimePercent: existing.overtimePercent.toString(),
          active: existing.active,
          displayOrder: existing.displayOrder,
        },
        after: {
          shiftPriceRub: result.shiftPriceRub.toString(),
          generatorPriceRub: result.generatorPriceRub?.toString() ?? null,
          shiftHours: result.shiftHours,
          overtimePercent: result.overtimePercent.toString(),
          active: result.active,
          displayOrder: result.displayOrder,
        },
      });

      return result;
    });

    res.json({
      vehicle: {
        ...updated,
        shiftPriceRub: new Decimal(updated.shiftPriceRub.toString()).toFixed(2),
        generatorPriceRub: updated.generatorPriceRub != null ? new Decimal(updated.generatorPriceRub.toString()).toFixed(2) : null,
        overtimePercent: new Decimal(updated.overtimePercent.toString()).toFixed(2),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fleet management — пробег, ТО, ремонты. Доступно SUPER_ADMIN + WAREHOUSE для
// мутаций; GET-эндпоинты — всем трём ролям (через router-level rolesGuard
// в routes/index.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/vehicles/fleet — список машин с пробегом и датой последнего ТО. */
router.get("/fleet", async (req, res, next) => {
  try {
    const includeInactive =
      req.query.includeInactive === "true" || req.query.includeInactive === "1";
    const vehicles = await listVehicles({ includeInactive });
    res.json({ vehicles });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/vehicles/fleet/dashboard?period=30|90|365 — витрина автопарка:
 * агрегаты пробега, обслуживания, выручки и загрузки + полоса занятости вперёд.
 *
 * Денежные поля (выручка, итог, суммарный расход по парку) отдаются только
 * SUPER_ADMIN: WAREHOUSE и TECHNICIAN видят ту же страницу без экономики —
 * консистентно с матрицей прав, где /api/finance/* закрыт для них.
 *
 * ВАЖНО: маршрут объявлен ДО "/fleet/:id", иначе ":id" перехватит "dashboard".
 */
router.get("/fleet/dashboard", async (req, res, next) => {
  try {
    const includeInactive =
      req.query.includeInactive === "true" || req.query.includeInactive === "1";
    const data = await computeFleetDashboard({
      period: parseFleetPeriod(req.query.period),
      includeInactive,
    });

    const canSeeMoney = req.adminUser?.role === "SUPER_ADMIN" || req.botAccess === true;
    if (canSeeMoney) {
      res.json(data);
      return;
    }

    res.json({
      ...data,
      totals: { ...data.totals, revenue: null, serviceCost: null, net: null },
      vehicles: data.vehicles.map((v) => ({
        ...v,
        lastServiceCost: null,
        stats: { ...v.stats, revenue: null, net: null, serviceCost: null },
        upcomingBookings: v.upcomingBookings.map((b) => ({ ...b, subtotalRub: null })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/vehicles/fleet/:id — детальная карточка машины + журналы. */
router.get("/fleet/:id", async (req, res, next) => {
  try {
    const detail = await getVehicleDetail(req.params.id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

const metaPatchSchema = z.object({
  licensePlate: z.string().trim().max(32).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  // Межсервисный интервал: 1 000–100 000 км. null — снять интервал (прогноз ТО
  // перестанет строиться и карточка честно покажет «интервал не задан»).
  serviceIntervalKm: z.number().int().min(1000).max(100000).nullable().optional(),
});

/** PATCH /api/vehicles/fleet/:id/meta — обновить гос. номер / заметки / интервал ТО. */
router.patch(
  "/fleet/:id/meta",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const body = metaPatchSchema.parse(req.body);
      if (!req.adminUser?.userId) {
        throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      }
      const v = await updateVehicleMeta(req.params.id, body, req.adminUser.userId);
      res.json({ vehicle: v });
    } catch (err) {
      next(err);
    }
  },
);

const manualMileageSchema = z.object({
  mileage: z.number().int().min(0),
  note: z.string().trim().max(500).nullable().optional(),
  /** true — режим корректировки (может уменьшать одометр, требует note). */
  correction: z.boolean().optional(),
});

/**
 * POST /api/vehicles/fleet/:id/mileage — записать пробег вручную.
 * С `correction: true` — корректировка ошибочного одометра (снимает запрет на
 * уменьшение, но требует `note`; source=CORRECTION, отдельный аудит).
 */
router.post(
  "/fleet/:id/mileage",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const body = manualMileageSchema.parse(req.body);
      if (!req.adminUser?.userId) {
        throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      }
      const log = await logMileageManual({
        vehicleId: req.params.id,
        mileage: body.mileage,
        note: body.note ?? null,
        correction: body.correction ?? false,
        recordedBy: req.adminUser.username,
        userId: req.adminUser.userId,
      });
      res.status(201).json({ log });
    } catch (err) {
      next(err);
    }
  },
);

const serviceKindEnum = z.enum([
  "SCHEDULED_TO",
  "OIL_CHANGE",
  "TIRE_CHANGE",
  "REPAIR",
  "INSPECTION",
  "OTHER",
]);

const addServiceSchema = z.object({
  kind: serviceKindEnum,
  performedAt: z.string().datetime(),
  mileage: z.number().int().min(0).nullable().optional(),
  description: z.string().trim().min(3).max(2000),
  cost: z.number().min(0).nullable().optional(),
});

/** POST /api/vehicles/fleet/:id/service — добавить запись ТО / ремонта. */
router.post(
  "/fleet/:id/service",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const body = addServiceSchema.parse(req.body);
      if (!req.adminUser?.userId) {
        throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      }
      const log = await addServiceLog({
        vehicleId: req.params.id,
        kind: body.kind,
        performedAt: new Date(body.performedAt),
        mileage: body.mileage ?? null,
        description: body.description,
        cost: body.cost ?? null,
        userId: req.adminUser.userId,
      });
      res.status(201).json({ log });
    } catch (err) {
      next(err);
    }
  },
);

export { router as vehiclesRouter };
