import express from "express";
import { z } from "zod";
import { rolesGuard } from "../middleware/rolesGuard";
import { HttpError } from "../utils/errors";
import { getAvailability } from "../services/availability";
import {
  projectDate,
  projectMidnight,
  nextDate,
  projectDates,
} from "../services/projectPricing";
import * as service from "../services/bookingProjects";
import { exportProjectDocument } from "../services/projectDocuments";

const router = express.Router();
const date = z.string().refine((v) => {
  try {
    return projectDate(v) === v;
  } catch {
    return false;
  }
}, "Некорректная дата");
const rev = { revision: z.number().int().nonnegative() };
const key = z.string().min(8).max(100);
const money = z.number().finite().nonnegative().max(100_000_000);
const unitIds = z.array(z.string().min(1)).max(500).default([]);
const author = (req: express.Request) => req.adminUser?.userId ?? "system";
const sa = rolesGuard(["SUPER_ADMIN"]);
router.use(rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]));
router.get("/catalog", async (req, res, next) => {
  try {
    const q = z
      .object({
        fromDate: date,
        throughDate: date,
        q: z.string().max(200).default(""),
      })
      .parse(req.query);
    projectDates(q.fromDate, q.throughDate);
    const rows = await getAvailability({
      startDate: projectMidnight(q.fromDate),
      endDate: new Date(projectMidnight(nextDate(q.throughDate)).getTime() - 1),
      search: q.q,
    });
    res.json({ rows: rows.slice(0, 100) });
  } catch (e) {
    next(e);
  }
});
router.post("/", async (req, res, next) => {
  try {
    const body = z
      .object({
        clientId: z.string().min(1),
        projectName: z.string().trim().min(1).max(200),
        fromDate: date,
        throughDate: date,
        restFactor: z.number().min(0).max(1).default(0.5),
        billingCycle: z.enum(["WEEKLY", "MONTHLY"]).default("WEEKLY"),
        paymentTermsDays: z.number().int().min(0).max(365).default(7),
        paymentForm: z.enum(["CASH", "CASHLESS"]).default("CASH"),
        cashlessSurchargePercent: z.number().min(0).max(100).default(0),
      })
      .parse(req.body);
    res.status(201).json(await service.createProject(body, author(req)));
  } catch (e) {
    next(e);
  }
});
router.get("/:id", async (req, res, next) => {
  try {
    res.json(await service.projectDetail(req.params.id));
  } catch (e) {
    next(e);
  }
});
router.post("/:id/confirm", sa, async (req, res, next) => {
  try {
    const b = z.object(rev).parse(req.body);
    await service.confirmProject(req.params.id, b.revision, author(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/lots", async (req, res, next) => {
  try {
    const b = z
      .object({
        ...rev,
        equipmentId: z.string().min(1),
        quantity: z.number().int().min(1).max(10000),
        ratePerShift: money.optional(),
        fromDate: date,
        throughDate: date,
      })
      .parse(req.body);
    res
      .status(201)
      .json(await service.addProjectLot(req.params.id, b, author(req)));
  } catch (e) {
    next(e);
  }
});
router.patch("/:id/calendar", async (req, res, next) => {
  try {
    const b = z
      .object({
        ...rev,
        fromDate: date,
        throughDate: date,
        kind: z.enum(["SHOOT", "REST", "WEEKDAYS"]),
      })
      .parse(req.body);
    await service.updateProjectDays(req.params.id, b, author(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/lots/:lotId/issue", async (req, res, next) => {
  try {
    const b = z.object({ ...rev, fromDate: date, unitIds }).parse(req.body);
    await service.issueProjectLot(
      req.params.id,
      req.params.lotId,
      b,
      author(req),
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/lots/:lotId/return", async (req, res, next) => {
  try {
    const b = z
      .object({
        ...rev,
        quantity: z.number().int().min(1).max(10000),
        lastBillableDate: date,
        unitIds,
        condition: z.enum(["OK", "REPAIR", "MISSING"]).default("OK"),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);
    await service.returnProjectLot(
      req.params.id,
      req.params.lotId,
      b,
      author(req),
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.patch("/:id/lots/:lotId", async (req, res, next) => {
  try {
    const b = z
      .object({
        ...rev,
        action: z.enum(["CANCEL", "EXTEND"]),
        throughDate: date.optional(),
      })
      .parse(req.body);
    await service.changeProjectLot(
      req.params.id,
      req.params.lotId,
      b,
      author(req),
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/charges", sa, async (req, res, next) => {
  try {
    const b = z
      .object({
        ...rev,
        date,
        description: z.string().trim().min(1).max(300),
        amount: money,
      })
      .parse(req.body);
    await service.addProjectCharge(req.params.id, b, author(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.get("/:id/period-preview", async (req, res, next) => {
  try {
    const q = z.object({ throughDate: date }).parse(req.query);
    res.json(await service.previewProjectPeriod(req.params.id, q.throughDate));
  } catch (e) {
    next(e);
  }
});
router.post("/:id/periods", sa, async (req, res, next) => {
  try {
    const b = z
      .object({ ...rev, throughDate: date, requestKey: key })
      .parse(req.body);
    res
      .status(201)
      .json(await service.closeProjectPeriod(req.params.id, b, author(req)));
  } catch (e) {
    next(e);
  }
});
router.post(
  "/:id/periods/:periodId/corrections",
  sa,
  async (req, res, next) => {
    try {
      const b = z
        .object({
          ...rev,
          amount: z
            .number()
            .finite()
            .min(-100_000_000)
            .max(100_000_000)
            .refine((n) => n !== 0),
          reason: z.string().trim().min(3).max(1000),
          requestKey: key,
        })
        .parse(req.body);
      res
        .status(201)
        .json(
          await service.correctProjectPeriod(
            req.params.id,
            req.params.periodId,
            b,
            author(req),
          ),
        );
    } catch (e) {
      next(e);
    }
  },
);
router.post("/:id/payments", sa, async (req, res, next) => {
  try {
    const b = z
      .object({
        ...rev,
        amount: money.refine((v) => v > 0),
        method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]),
        comment: z.string().max(1000).optional(),
      })
      .parse(req.body);
    await service.recordProjectPayment(req.params.id, b, author(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/cancel", sa, async (req, res, next) => {
  try {
    const b = z.object(rev).parse(req.body);
    await service.cancelProject(req.params.id, b.revision, author(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.post("/:id/finish", async (req, res, next) => {
  try {
    const b = z.object(rev).parse(req.body);
    await service.finishProject(req.params.id, b.revision, author(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
router.get("/:id/documents/:documentId/:format", async (req, res, next) => {
  try {
    const format = z.enum(["pdf", "xlsx"]).parse(req.params.format);
    const document = await exportProjectDocument(
      req.params.id,
      req.params.documentId,
      format,
    );
    res.setHeader(
      "Content-Type",
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="project-${req.params.documentId}.${format}"`,
    );
    res.send(document);
  } catch (e) {
    next(e);
  }
});
export { router as bookingProjectsRouter };
