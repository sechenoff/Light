/**
 * Роутер /api/repairs — Sprint 4: Repair Workflow
 *
 * GET    /              — список ремонтов (все три роли)
 * POST   /              — создать ремонт (все три роли)
 * GET    /:id           — детали ремонта (все три роли)
 * POST   /:id/work-log  — добавить запись работ (TECHNICIAN, SUPER_ADMIN)
 * PATCH  /:id/status    — сменить статус (TECHNICIAN, SUPER_ADMIN)
 * POST   /:id/assign    — назначить техника (TECHNICIAN self, SUPER_ADMIN)
 * POST   /:id/close     — закрыть ремонт (TECHNICIAN, SUPER_ADMIN)
 * POST   /:id/write-off — списать единицу (SUPER_ADMIN)
 */

import express from "express";
import { z } from "zod";
import { rolesGuard } from "../middleware/rolesGuard";
import {
  createRepair,
  assignRepair,
  setRepairStatus,
  closeRepair,
  writeOffRepair,
  addWorkLog,
  takeRepair,
} from "../services/repairService";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";

export const repairsRouter = express.Router();

// ─── Zod схемы ───────────────────────────────────────────────────────────────

const createRepairSchema = z.object({
  unitId: z.string().min(1),
  reason: z.string().min(1),
  urgency: z.enum(["NOT_URGENT", "NORMAL", "URGENT"]),
  sourceBookingId: z.string().optional(),
});

const workLogSchema = z.object({
  description: z.string().min(1),
  timeSpentHours: z.number().nonnegative(),
  partCost: z.number().nonnegative().default(0),
});

const statusSchema = z.object({
  status: z.enum(["IN_REPAIR", "WAITING_PARTS"]),
});

const assignSchema = z.object({
  assigneeId: z.string().min(1),
});

const REPAIR_STATUSES = ["WAITING_REPAIR", "IN_REPAIR", "WAITING_PARTS", "CLOSED", "WROTE_OFF"] as const;
const REPAIR_URGENCIES = ["NOT_URGENT", "NORMAL", "URGENT"] as const;

const listQuerySchema = z.object({
  status: z.string().optional().transform((s, ctx) => {
    if (!s) return undefined;
    const parts = s.split(",").map((p) => p.trim());
    for (const p of parts) {
      if (!(REPAIR_STATUSES as readonly string[]).includes(p)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Неверный статус: ${p}` });
        return z.NEVER;
      }
    }
    return parts as (typeof REPAIR_STATUSES[number])[];
  }),
  urgency: z.string().optional().transform((s, ctx) => {
    if (!s) return undefined;
    const parts = s.split(",").map((p) => p.trim());
    for (const p of parts) {
      if (!(REPAIR_URGENCIES as readonly string[]).includes(p)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Неверная срочность: ${p}` });
        return z.NEVER;
      }
    }
    return parts as (typeof REPAIR_URGENCIES[number])[];
  }),
  unitId: z.string().optional(),
  assignedTo: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

// ─── Serializer ──────────────────────────────────────────────────────────────

function serializeRepair(r: any) {
  return {
    ...r,
    partsCost: r.partsCost?.toString?.() ?? r.partsCost,
    totalTimeHours: r.totalTimeHours?.toString?.() ?? r.totalTimeHours,
    workLog: r.workLog?.map((l: any) => ({
      ...l,
      timeSpentHours: l.timeSpentHours?.toString?.() ?? l.timeSpentHours,
      partCost: l.partCost?.toString?.() ?? l.partCost,
    })),
    expenses: r.expenses?.map((e: any) => ({
      ...e,
      amount: e.amount?.toString?.() ?? e.amount,
    })),
  };
}

// ─── GET / ───────────────────────────────────────────────────────────────────

repairsRouter.get(
  "/",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const { status, unitId, assignedTo, urgency, limit, cursor } =
        listQuerySchema.parse(req.query);

      const where: Record<string, unknown> = {};

      // status and urgency are already validated arrays from listQuerySchema
      if (status) where.status = { in: status };
      if (unitId) where.unitId = unitId;
      if (assignedTo) where.assignedTo = assignedTo;
      if (urgency) where.urgency = { in: urgency };
      if (cursor) {
        // orderBy: id desc → cursor paginates with lt (not gt)
        where.id = { lt: cursor };
      }

      const repairs = await prisma.repair.findMany({
        where,
        take: limit,
        // cuid() is ~monotonically increasing — id desc ≈ createdAt desc, avoids composite cursor
        orderBy: { id: "desc" },
        include: {
          unit: {
            include: {
              equipment: { select: { name: true, category: true } },
            },
          },
          sourceBooking: {
            select: {
              id: true,
              projectName: true,
              client: { select: { name: true } },
            },
          },
          _count: { select: { workLog: true } },
        },
      });

      const nextCursor = repairs.length === limit ? repairs[repairs.length - 1].id : null;

      res.json({
        repairs: repairs.map(serializeRepair),
        nextCursor,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST / ──────────────────────────────────────────────────────────────────

repairsRouter.post(
  "/",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const body = createRepairSchema.parse(req.body);
      const repair = await createRepair({
        ...body,
        createdBy: req.adminUser!.userId,
      });
      res.status(201).json({ repair: serializeRepair(repair) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:id ────────────────────────────────────────────────────────────────

repairsRouter.get(
  "/:id",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const repair = await prisma.repair.findUnique({
        where: { id: req.params.id },
        include: {
          unit: {
            include: {
              equipment: { select: { name: true, category: true } },
            },
          },
          sourceBooking: {
            select: {
              id: true,
              projectName: true,
              startDate: true,
              endDate: true,
              client: { select: { name: true } },
            },
          },
          workLog: { orderBy: { loggedAt: "desc" } },
        },
      });

      if (!repair) {
        throw new HttpError(404, "Ремонт не найден", "REPAIR_NOT_FOUND");
      }

      res.json({ repair: serializeRepair(repair) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/work-log ──────────────────────────────────────────────────────

repairsRouter.post(
  "/:id/work-log",
  rolesGuard(["TECHNICIAN", "SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const body = workLogSchema.parse(req.body);
      const role = req.adminUser!.role as string;
      const loggedBy = req.adminUser!.userId;

      const updated = await addWorkLog(
        req.params.id,
        { ...body, loggedBy },
        role,
      );

      res.status(201).json({ repair: serializeRepair(updated) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /:id/status ───────────────────────────────────────────────────────

repairsRouter.patch(
  "/:id/status",
  rolesGuard(["TECHNICIAN", "SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const { status } = statusSchema.parse(req.body);
      const updated = await setRepairStatus(req.params.id, status, req.adminUser!.userId);
      res.json({ repair: serializeRepair(updated) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/assign ────────────────────────────────────────────────────────

repairsRouter.post(
  "/:id/assign",
  rolesGuard(["TECHNICIAN", "SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const { assigneeId } = assignSchema.parse(req.body);
      const currentUserId = req.adminUser!.userId;
      const currentRole = req.adminUser!.role as string;

      // TECHNICIAN может назначать только сам себя
      if (currentRole === "TECHNICIAN" && assigneeId !== currentUserId) {
        throw new HttpError(
          403,
          "Техник может назначать только себя",
          "ASSIGN_SELF_ONLY",
        );
      }

      const updated = await assignRepair(req.params.id, assigneeId, currentUserId);
      res.json({ repair: serializeRepair(updated) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/close ─────────────────────────────────────────────────────────

repairsRouter.post(
  "/:id/close",
  rolesGuard(["TECHNICIAN", "SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const repair = await closeRepair(req.params.id, req.adminUser!.userId);
      res.json({ repair: serializeRepair(repair) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/write-off ─────────────────────────────────────────────────────

repairsRouter.post(
  "/:id/write-off",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const repair = await writeOffRepair(req.params.id, req.adminUser!.userId);
      res.json({ repair: serializeRepair(repair) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/take ──────────────────────────────────────────────────────────

repairsRouter.post(
  "/:id/take",
  rolesGuard(["TECHNICIAN", "SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const repair = await takeRepair(req.params.id, req.adminUser!.userId);
      res.status(201).json({ repair: serializeRepair(repair) });
    } catch (err) {
      next(err);
    }
  },
);
