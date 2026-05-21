import express from "express";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import { authenticateWorker, hashPin } from "../services/warehouseAuth";
import { prisma } from "../prisma";
import { warehouseAuth } from "../middleware/warehouseAuth";
import { rolesGuard } from "../middleware/rolesGuard";
import { HttpError } from "../utils/errors";
import {
  createSession,
  completeSession,
  cancelSession,
  getSessionWithDetails,
  getReconciliationPreview,
  type RepairUnit,
  type ProblemUnit,
} from "../services/warehouseScan";
import {
  checkUnit,
  uncheckUnit,
  getChecklistState,
  addExtraItem,
} from "../services/checklistService";
import { findAddonConflict } from "../services/addonAvailability";
import { getAvailability } from "../services/availability";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  UPLOAD_ROOT,
  validateMagicBytes,
  writeStagedPhoto,
  listStaged,
  stageDir,
  resolveUploadPath,
} from "../services/repairPhotoStorage";

// ── Multer для фото поломки (memoryStorage, 5 MB, только JPEG/PNG) ────────────
// Зеркалит expenses.ts; константы переиспользуются из repairPhotoStorage.

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("INVALID_FILE_TYPE"));
    }
  },
});

// ── Public router (mounted BEFORE apiKeyAuth) ─────────────────────────────────

export const warehousePublicRouter = express.Router();

const pinSchema = z.string().min(4, "PIN должен быть не менее 4 символов").regex(/^\d+$/, "PIN должен содержать только цифры");

const authBodySchema = z.object({
  name: z.string().min(1),
  pin: pinSchema,
});

/** POST /api/warehouse/auth — аутентификация сотрудника склада по PIN */
warehousePublicRouter.post("/auth", async (req, res, next) => {
  try {
    const { name, pin } = authBodySchema.parse(req.body);
    const result = await authenticateWorker(name, pin);
    if ("error" in result) {
      res.status(401).json({ message: result.error });
      return;
    }
    res.json({ token: result.token, name: result.name, expiresAt: result.expiresAt });
  } catch (err) {
    next(err);
  }
});

/** GET /api/warehouse/workers/names — список имён активных сотрудников */
warehousePublicRouter.get("/workers/names", async (_req, res, next) => {
  try {
    const workers = await prisma.warehousePin.findMany({
      where: { isActive: true },
      select: { name: true },
    });
    res.json({ names: workers.map((w) => w.name) });
  } catch (err) {
    next(err);
  }
});

// ── Admin router (mounted AFTER apiKeyAuth via routes/index.ts) ───────────────

export const warehouseRouter = express.Router();

const createWorkerSchema = z.object({
  name: z.string().min(1),
  pin: pinSchema,
});

const updateWorkerSchema = z.object({
  name: z.string().min(1).optional(),
  pin: pinSchema.optional(),
  isActive: z.boolean().optional(),
});

/** GET /api/warehouse/workers — список всех сотрудников (для администратора) */
warehouseRouter.get("/workers", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (_req, res, next) => {
  try {
    const workers = await prisma.warehousePin.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        lastLoginAt: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    res.json({ workers });
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/workers — создать нового сотрудника */
warehouseRouter.post("/workers", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { name, pin } = createWorkerSchema.parse(req.body);
    const pinHash = await hashPin(pin);
    const worker = await prisma.warehousePin.create({
      data: { name, pinHash },
      select: {
        id: true,
        name: true,
        isActive: true,
        lastLoginAt: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    res.status(201).json({ worker });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/warehouse/workers/:id — обновить сотрудника */
warehouseRouter.patch("/workers/:id", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = updateWorkerSchema.parse(req.body);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.pin !== undefined) data.pinHash = await hashPin(body.pin);
    if (body.isActive !== undefined) data.isActive = body.isActive;

    const worker = await prisma.warehousePin.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        isActive: true,
        lastLoginAt: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    res.json({ worker });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/warehouse/workers/:id — удалить сотрудника */
warehouseRouter.delete("/workers/:id", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.warehousePin.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Scan session router (Bearer token auth, mounted BEFORE apiKeyAuth) ────────

export const warehouseScanRouter = express.Router();

const operationSchema = z.enum(["ISSUE", "RETURN"]);

const createSessionBodySchema = z.object({
  bookingId: z.string().min(1),
  operation: operationSchema,
});

/** GET /api/warehouse/bookings — список броней, доступных для сканирования */
warehouseScanRouter.get("/bookings", warehouseAuth, async (req, res, next) => {
  try {
    const parseResult = operationSchema.safeParse(req.query.operation);
    if (!parseResult.success) {
      res.status(400).json({ message: "Параметр operation обязателен и должен быть ISSUE или RETURN" });
      return;
    }
    const operation = parseResult.data;
    const status = operation === "ISSUE" ? "CONFIRMED" : "ISSUED";

    const bookings = await prisma.booking.findMany({
      where: { status },
      select: {
        id: true,
        client: true,
        projectName: true,
        startDate: true,
        endDate: true,
        status: true,
        items: { select: { id: true } },
      },
    });

    res.json({
      bookings: bookings.map((b) => ({
        id: b.id,
        client: b.client,
        projectName: b.projectName,
        startDate: b.startDate,
        endDate: b.endDate,
        status: b.status,
        items: b.items.map((i) => ({ id: i.id })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions — создать сессию сканирования */
warehouseScanRouter.post("/sessions", warehouseAuth, async (req, res, next) => {
  try {
    const { bookingId, operation } = createSessionBodySchema.parse(req.body);
    const workerName = req.warehouseWorker!.name;
    const session = await createSession(bookingId, workerName, operation);
    res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

/** GET /api/warehouse/sessions/:id — получить детали сессии */
warehouseScanRouter.get("/sessions/:id", warehouseAuth, async (req, res, next) => {
  try {
    const result = await getSessionWithDetails(req.params.id);
    // Rename trackingMode→scanMode and scanned→scannedCount to match frontend contract
    res.json({
      ...result,
      bookingItems: result.bookingItems.map((item) => ({
        ...item,
        scanMode: item.trackingMode,
        scannedCount: item.scanned ?? 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/warehouse/sessions/:id/scan — REMOVED (dead barcode-scan path).
// Складской UI использует чек-лист: /check, /uncheck, /state, /items, /complete.

/** GET /api/warehouse/sessions/:id/summary — предварительная сверка (без завершения) */
warehouseScanRouter.get("/sessions/:id/summary", warehouseAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const summary = await getReconciliationPreview(id);

    // Enrich unit ID arrays with name and barcode data
    const [missingUnits, substitutedUnits] = await Promise.all([
      summary.missing.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.missing } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
      summary.substituted.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.substituted } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    // Fetch session for sessionId and operation fields
    const session = await prisma.scanSession.findUnique({
      where: { id },
      select: { id: true, operation: true },
    });

    res.json({
      sessionId: session?.id ?? id,
      operation: session?.operation ?? "ISSUE",
      scannedCount: summary.scanned,
      expectedCount: summary.expected,
      missingItems: missingUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
      substitutedItems: substitutedUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
      // Обогащённый «зарезервирован, но недоступен» — служит источником
      // для строки «⛔ Резерв недоступен» на экране сверки ISSUE-флоу.
      // Сервис уже отдал name+ordinal+status; здесь просто пробрасываем.
      reservedButUnavailable: summary.reservedButUnavailable,
      // Финансовая разбивка (для preview-фазы фронт не использует — там
      // нули; но shape-consistency важна, чтобы клиент мог типизировать
      // SummaryResult одним типом для обоих endpoint'ов).
      mainAfterDiscount: summary.mainAfterDiscount,
      addonAfterDiscount: summary.addonAfterDiscount,
      finalAmount: summary.finalAmount,
    });
  } catch (err) {
    next(err);
  }
});

const repairUnitSchema = z.object({
  equipmentUnitId: z.string().min(1),
  comment: z.string().min(1),
  urgency: z.enum(["NOT_URGENT", "NORMAL", "URGENT"]).optional(),
});

const problemUnitSchema = z.object({
  equipmentUnitId: z.string().min(1),
  reason: z.enum(["LEFT_ON_SITE", "LOST", "DESTROYED", "STOLEN"]),
  comment: z.string().min(1),
  expectedBackDate: z.string().datetime().optional(),
});

const issuanceAdjustmentSchema = z.object({
  bookingItemId: z.string().min(1),
  actualQuantity: z.number().int().min(0),
});

const completeSessionBodySchema = z.object({
  repairUnits: z.array(repairUnitSchema).optional(),
  problemUnits: z.array(problemUnitSchema).optional(),
  // Task 8: per-position quantity adjustments (ISSUE only).
  // Forwarded to completeSession(...).options.issuanceAdjustments.
  issuanceAdjustments: z.array(issuanceAdjustmentSchema).optional(),
}).optional();

/** POST /api/warehouse/sessions/:id/complete — завершить сессию */
warehouseScanRouter.post("/sessions/:id/complete", warehouseAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = completeSessionBodySchema.parse(req.body);
    const repairUnits = body?.repairUnits as RepairUnit[] | undefined;
    const problemUnits = body?.problemUnits as ProblemUnit[] | undefined;
    const summary = await completeSession(id, {
      repairUnits,
      problemUnits,
      createdBy: req.warehouseWorker?.name,
      issuanceAdjustments: body?.issuanceAdjustments,
    });

    // Enrich unit ID arrays with name and barcode data
    const [missingUnits, substitutedUnits] = await Promise.all([
      summary.missing.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.missing } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
      summary.substituted.length > 0
        ? prisma.equipmentUnit.findMany({
            where: { id: { in: summary.substituted } },
            select: { id: true, barcode: true, equipment: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    // Fetch session for operation field (status is now COMPLETED)
    const session = await prisma.scanSession.findUnique({
      where: { id },
      select: { id: true, operation: true },
    });

    res.json({
      sessionId: session?.id ?? id,
      operation: session?.operation ?? "ISSUE",
      scannedCount: summary.scanned,
      expectedCount: summary.expected,
      missingItems: missingUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
      substitutedItems: substitutedUnits.map((u) => ({
        id: u.id,
        name: u.equipment.name,
        barcode: u.barcode ?? "",
      })),
      createdRepairIds: summary.createdRepairIds,
      failedBrokenUnits: summary.failedBrokenUnits,
      createdProblemItemIds: summary.createdProblemItemIds,
      failedProblemUnits: summary.failedProblemUnits,
      // НОВОЕ: финансовая разбивка после recompute (см. completeSession §4.6).
      // Используется на result-screen фронта для блока «Финансы»
      // (Согласовано / Доб-смета / К оплате).
      reservedButUnavailable: summary.reservedButUnavailable,
      mainAfterDiscount: summary.mainAfterDiscount,
      addonAfterDiscount: summary.addonAfterDiscount,
      finalAmount: summary.finalAmount,
      // Task 8: snapshot MAIN.totalAfterDiscount ДО issuanceAdjustments
      // в этой сессии. Если adjustments не применялись — равен mainAfterDiscount.
      mainOriginalAfterDiscount: summary.mainOriginalAfterDiscount,
    });
  } catch (err) {
    next(err);
  }
});

// ── Фото поломки (staging во время сессии возврата) ──────────────────────────
// Фото загружаются в uploads/scan-sessions/{sessionId}/{unitId}/ и переносятся
// в uploads/repairs/{repairId}/ на completeSession (см. warehouseScan.ts).

/** POST /api/warehouse/sessions/:id/units/:unitId/photos — загрузить фото поломки */
warehouseScanRouter.post(
  "/sessions/:id/units/:unitId/photos",
  warehouseAuth,
  (req, res, next) => {
    // Прогоняем multer, конвертируем его ошибки в HttpError (как в expenses.ts)
    photoUpload.single("photo")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return next(new HttpError(413, "Файл превышает 5 МБ", "FILE_TOO_LARGE"));
        }
        if (err instanceof Error && err.message === "INVALID_FILE_TYPE") {
          return next(new HttpError(400, "Недопустимый тип файла. Разрешены: JPEG, PNG", "INVALID_FILE_TYPE"));
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const { id: sessionId, unitId } = req.params;
      if (!req.file) {
        throw new HttpError(400, "Файл не приложен", "NO_FILE");
      }
      // Валидация magic-байтов против подмены MIME-типа
      if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
        throw new HttpError(400, "Содержимое файла не соответствует указанному типу", "INVALID_FILE_FORMAT");
      }
      writeStagedPhoto(sessionId, unitId, req.file.buffer, req.file.originalname);
      res.json({ photos: listStaged(sessionId, unitId) });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/warehouse/sessions/:id/units/:unitId/photos — список staged-фото */
warehouseScanRouter.get(
  "/sessions/:id/units/:unitId/photos",
  warehouseAuth,
  async (req, res, next) => {
    try {
      const { id: sessionId, unitId } = req.params;
      res.json({ photos: listStaged(sessionId, unitId) });
    } catch (err) {
      next(err);
    }
  },
);

/** DELETE /api/warehouse/sessions/:id/units/:unitId/photos/:name — удалить одно staged-фото */
warehouseScanRouter.delete(
  "/sessions/:id/units/:unitId/photos/:name",
  warehouseAuth,
  async (req, res, next) => {
    try {
      const { id: sessionId, unitId, name } = req.params;
      // Guard: только basename, никаких разделителей путей в имени
      if (name !== path.basename(name) || name.includes("/") || name.includes("\\")) {
        throw new HttpError(404, "Файл не найден", "PHOTO_NOT_FOUND");
      }
      const abs = resolveUploadPath(path.join(stageDir(sessionId, unitId), name));
      if (!abs || !abs.startsWith(UPLOAD_ROOT + path.sep) || !fs.existsSync(abs)) {
        throw new HttpError(404, "Файл не найден", "PHOTO_NOT_FOUND");
      }
      fs.unlinkSync(abs);
      res.json({ photos: listStaged(sessionId, unitId) });
    } catch (err) {
      next(err);
    }
  },
);

// ── Checklist endpoints (без сканера) ─────────────────────────────────────────

const checkBodySchema = z.object({
  equipmentUnitId: z.string().min(1),
});

const uncheckBodySchema = z.object({
  equipmentUnitId: z.string().min(1),
});

const addItemBodySchema = z.object({
  equipmentId: z.string().min(1),
  quantity: z.number().int().positive(),
  acknowledgedConflict: z.boolean().optional(),
});

const addonSearchQuerySchema = z.object({
  q: z.string().min(1).max(100),
});

/** GET /api/warehouse/sessions/:id/state — текущее состояние чек-листа */
warehouseScanRouter.get("/sessions/:id/state", warehouseAuth, async (req, res, next) => {
  try {
    const state = await getChecklistState(req.params.id);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/check — отметить UNIT-позицию */
warehouseScanRouter.post("/sessions/:id/check", warehouseAuth, async (req, res, next) => {
  try {
    const { equipmentUnitId } = checkBodySchema.parse(req.body);
    const result = await checkUnit(req.params.id, equipmentUnitId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/uncheck — снять отметку с UNIT-позиции */
warehouseScanRouter.post("/sessions/:id/uncheck", warehouseAuth, async (req, res, next) => {
  try {
    const { equipmentUnitId } = uncheckBodySchema.parse(req.body);
    const result = await uncheckUnit(req.params.id, equipmentUnitId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/warehouse/sessions/:id/addon-search — поиск артикулов для quick-add */
warehouseScanRouter.get("/sessions/:id/addon-search", warehouseAuth, async (req, res, next) => {
  try {
    const { q } = addonSearchQuerySchema.parse(req.query);

    const session = await prisma.scanSession.findUnique({
      where: { id: req.params.id },
      select: { bookingId: true },
    });
    if (!session) {
      res.status(404).json({ message: "Сессия не найдена", code: "SESSION_NOT_FOUND" });
      return;
    }

    const booking = await prisma.booking.findUnique({
      where: { id: session.bookingId },
      select: { startDate: true, endDate: true },
    });
    if (!booking) {
      res.status(404).json({ message: "Бронь не найдена", code: "BOOKING_NOT_FOUND" });
      return;
    }

    const rows = await getAvailability({
      startDate: booking.startDate,
      endDate: booking.endDate,
      search: q,
      excludeBookingId: session.bookingId,
    });

    const trimmedRows = rows.slice(0, 30);

    // Batch-load BookingItem.quantity for the current booking × visible equipment.
    // addCap = max(0, availableQuantity − alreadyInThisBooking). `availableQuantity`
    // уже исключает текущую бронь через excludeBookingId, поэтому остаётся вычесть
    // только то, что эта же бронь уже держит.
    const visibleEquipmentIds = trimmedRows.map((r) => r.equipment.id);
    const existingItems =
      visibleEquipmentIds.length > 0
        ? await prisma.bookingItem.findMany({
            where: {
              bookingId: session.bookingId,
              equipmentId: { in: visibleEquipmentIds },
            },
            select: { equipmentId: true, quantity: true },
          })
        : [];
    const alreadyMineByEquipment = new Map<string, number>();
    for (const it of existingItems) {
      if (it.equipmentId) alreadyMineByEquipment.set(it.equipmentId, it.quantity);
    }

    const results = await Promise.all(
      trimmedRows.map(async (row) => {
        const availability = row.availableQuantity > 0 ? "AVAILABLE" : "UNAVAILABLE";
        const conflict =
          availability === "UNAVAILABLE"
            ? await findAddonConflict(
                row.equipment.id,
                booking.startDate,
                booking.endDate,
                session.bookingId,
              )
            : null;
        const alreadyMine = alreadyMineByEquipment.get(row.equipment.id) ?? 0;
        const addCap = Math.max(0, row.availableQuantity - alreadyMine);
        return {
          equipmentId: row.equipment.id,
          name: row.equipment.name,
          category: row.equipment.category,
          availableQuantity: row.availableQuantity,
          addCap,
          availability,
          conflict,
        };
      }),
    );

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/items — быстрое добавление позиции в бронь */
warehouseScanRouter.post("/sessions/:id/items", warehouseAuth, async (req, res, next) => {
  try {
    const { equipmentId, quantity, acknowledgedConflict } = addItemBodySchema.parse(req.body);
    const createdBy = req.warehouseWorker?.name ?? "warehouse";
    const result = await addExtraItem(
      req.params.id,
      equipmentId,
      quantity,
      createdBy,
      acknowledgedConflict ?? false,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/warehouse/sessions/:id/cancel — отменить сессию */
warehouseScanRouter.post("/sessions/:id/cancel", warehouseAuth, async (req, res, next) => {
  try {
    const session = await cancelSession(req.params.id);
    res.json(session);
  } catch (err) {
    next(err);
  }
});
