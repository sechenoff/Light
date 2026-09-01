/**
 * Роутер /api/repairs — мастерская.
 *
 * GET    /              — список ремонтов (все три роли)
 * POST   /              — создать ремонт (все три роли)
 * GET    /:id           — детали ремонта (все три роли)
 * POST   /:id/work-log  — добавить запись работ (TECHNICIAN, SUPER_ADMIN)
 * PATCH  /:id/status    — сменить статус (TECHNICIAN, SUPER_ADMIN)
 * PATCH  /:id/eta       — назначить срок готовности (TECHNICIAN, SUPER_ADMIN)
 * POST   /:id/assign    — назначить техника (TECHNICIAN self, SUPER_ADMIN)
 * POST   /:id/close     — закрыть ремонт (TECHNICIAN, SUPER_ADMIN)
 * POST   /:id/write-off — списать единицу (SUPER_ADMIN)
 *
 * Всё, что превращает строку БД в понятную человеку карточку (название, риск,
 * имена, история), живёт в `services/repairView.ts` — роут только собирает ответ.
 */

import express from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { rolesGuard } from "../middleware/rolesGuard";
import {
  createRepair,
  assignRepair,
  setRepairStatus,
  setRepairEta,
  closeRepair,
  writeOffRepair,
  addWorkLog,
  takeRepair,
} from "../services/repairService";
import {
  enrichRepairs,
  buildRepairHistory,
  resolveActorNames,
  actorName,
} from "../services/repairView";
import {
  resolveUploadPath,
  validateMagicBytes,
  writeRepairPhoto,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
} from "../services/repairPhotoStorage";
import { fromMoscowDateString } from "../utils/moscowDate";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";

export const repairsRouter = express.Router();

// ── Multer для фото поломки ──────────────────────────────────────────────────
// Зеркалит настройку склада (`warehouse.ts`) и расходов: memoryStorage, 5 MB,
// только JPEG/PNG. Константы общие — из `repairPhotoStorage`, чтобы лимит и
// список типов не разъехались между двумя точками загрузки.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIME_TYPES.has(file.mimetype));
  },
});

// ─── Zod схемы ───────────────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Срок готовности. Принимаем и полный ISO, и голый `YYYY-MM-DD` из
 * `<input type="date">`: форма «когда починим» по природе своей про день, а не
 * про секунду, и заставлять фронт вручную дописывать время — ровно та ловушка,
 * на которой уже обожглась приёмка (см. `expectedBackDate` в CLAUDE.md).
 * Голая дата трактуется как полночь по Москве — единая семантика date-only.
 *
 * `null` — не «забыли заполнить», а осознанное «срок не назначен»: выдуманный
 * прогноз хуже честного пробела, по нему начнут планировать съёмку.
 */
const expectedReadyAtField = z
  .union([z.string().min(1), z.null()])
  .transform((v, ctx) => {
    if (v === null) return null;
    if (DATE_ONLY_RE.test(v)) return fromMoscowDateString(v);
    const parsed = new Date(v);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Некорректная дата готовности: ${v}` });
      return z.NEVER;
    }
    return parsed;
  });

const partsNoteField = z.union([z.string().trim().max(500), z.null()]);

const createRepairSchema = z.object({
  // Ни одно из трёх полей не обязательно по отдельности, но что-то указать надо:
  // проверку делает сервис (400 REPAIR_TARGET_REQUIRED) — так у ошибки есть код.
  equipmentId: z.string().min(1).optional(),
  unitId: z.string().min(1).optional(),
  bookingItemId: z.string().min(1).optional(),
  quantity: z.coerce.number().int().min(1).max(999).optional(),
  reason: z.string().trim().min(1),
  urgency: z.enum(["NOT_URGENT", "NORMAL", "URGENT"]).default("NORMAL"),
  sourceBookingId: z.string().optional(),
  expectedReadyAt: expectedReadyAtField.optional(),
  partsNote: partsNoteField.optional(),
  // Конфликт с бронью НЕ блокирует создание: прибор сломан по факту, а не по
  // учёту. Поле принимаем, чтобы фронт мог его слать, но на серверную логику
  // оно не влияет — риск в любом случае возвращается в ответе.
  acknowledgedConflict: z.boolean().optional(),
});

const etaSchema = z
  .object({
    expectedReadyAt: expectedReadyAtField.optional(),
    partsNote: partsNoteField.optional(),
  })
  .refine((d) => d.expectedReadyAt !== undefined || d.partsNote !== undefined, {
    message: "Нечего менять: укажите срок готовности или заметку о запчастях",
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

// Опциональный расход при закрытии — создаётся атомарно с close в одной
// транзакции (см. closeRepair в services/repairService.ts).
const closeSchema = z.object({
  expense: z
    .object({
      amount: z.number().positive(),
      description: z.string().min(1),
    })
    .optional(),
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
  // `active=true` — то, что лежит в мастерской прямо сейчас; `active=false` —
  // архив. Без параметра — всё подряд (совместимость со старыми вызовами).
  active: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const CLOSED_REPAIR_STATUSES: (typeof REPAIR_STATUSES[number])[] = ["CLOSED", "WROTE_OFF"];

// ─── Общий include ───────────────────────────────────────────────────────────

/**
 * Связи, без которых карточку не собрать: позиция каталога приезжает тремя
 * путями (юнит → прямая ссылка → строка сметы), и все три нужны и списку, и
 * деталям — иначе `resolveRepairTitle` возвращал бы «Позиция удалена из
 * каталога» там, где позиция на месте.
 */
const REPAIR_INCLUDE = {
  unit: {
    include: {
      equipment: { select: { id: true, name: true, category: true } },
    },
  },
  bookingItem: {
    select: {
      id: true,
      quantity: true,
      equipmentId: true,
      equipment: { select: { id: true, name: true, category: true } },
    },
  },
  equipment: { select: { id: true, name: true, category: true } },
  sourceBooking: {
    select: {
      id: true,
      projectName: true,
      startDate: true,
      endDate: true,
      client: { select: { name: true } },
    },
  },
  _count: { select: { workLog: true, photos: true } },
} satisfies Prisma.RepairInclude;

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

/** Счётчики выносим в плоские поля — `_count` оставлен для старого фронта. */
function withCounts(r: { _count?: { workLog?: number; photos?: number } }) {
  return {
    workLogCount: r._count?.workLog ?? 0,
    photoCount: r._count?.photos ?? 0,
  };
}

// ─── GET / ───────────────────────────────────────────────────────────────────

repairsRouter.get(
  "/",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const { status, unitId, assignedTo, urgency, active, limit, cursor } =
        listQuerySchema.parse(req.query);

      // status/urgency уже провалидированы схемой в массивы.
      const and: Prisma.RepairWhereInput[] = [];
      if (status) and.push({ status: { in: status } });
      if (active === true) and.push({ status: { notIn: CLOSED_REPAIR_STATUSES } });
      if (active === false) and.push({ status: { in: CLOSED_REPAIR_STATUSES } });

      const where: Prisma.RepairWhereInput = {
        ...(and.length ? { AND: and } : {}),
        ...(unitId ? { unitId } : {}),
        ...(assignedTo ? { assignedTo } : {}),
        ...(urgency ? { urgency: { in: urgency } } : {}),
        // orderBy: id desc → курсор листает через lt (не gt)
        ...(cursor ? { id: { lt: cursor } } : {}),
      };

      const repairs = await prisma.repair.findMany({
        where,
        take: limit,
        // cuid() почти монотонен — id desc ≈ createdAt desc, без составного курсора
        orderBy: { id: "desc" },
        include: REPAIR_INCLUDE,
      });

      const nextCursor = repairs.length === limit ? repairs[repairs.length - 1].id : null;

      const enrichment = await enrichRepairs(repairs);

      res.json({
        repairs: repairs.map((r) => ({
          ...serializeRepair(r),
          ...withCounts(r),
          ...enrichment.get(r.id)!,
        })),
        nextCursor,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST / ──────────────────────────────────────────────────────────────────

/**
 * Перечитывает ремонт в той же форме, что отдаёт список: название, риск, имена,
 * счётчики. Нужен там, где мутация вернула сырую строку, а UI ждёт карточку.
 */
async function loadRepairCard(id: string) {
  const row = await prisma.repair.findUnique({ where: { id }, include: REPAIR_INCLUDE });
  if (!row) throw new HttpError(404, "Ремонт не найден", "REPAIR_NOT_FOUND");
  const enrichment = await enrichRepairs([row]);
  return { ...serializeRepair(row), ...withCounts(row), ...enrichment.get(row.id)! };
}

repairsRouter.post(
  "/",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const { acknowledgedConflict: _ack, ...body } = createRepairSchema.parse(req.body);
      const created = await createRepair({
        ...body,
        createdBy: req.adminUser!.userId,
      });
      // Возвращаем карточку целиком: в ответе приезжает `risk`, и UI сразу
      // показывает «эта поломка срывает бронь #A1B2C3» — предупреждением,
      // а не отказом. Создание конфликт не блокирует.
      res.status(201).json({ repair: await loadRepairCard(created.id) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /:id/eta ──────────────────────────────────────────────────────────

/**
 * Назначить или сдвинуть срок готовности (и заметку о запчастях).
 *
 * Кладовщика сюда не пускаем: срок называет тот, кто чинит. Ответ — карточка
 * целиком, потому что назначенный срок пересчитывает `risk`: «сорвёт бронь»
 * превращается в «успеваем, запас 4 дня» ровно в этот момент.
 */
repairsRouter.patch(
  "/:id/eta",
  rolesGuard(["SUPER_ADMIN", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const body = etaSchema.parse(req.body ?? {});
      await setRepairEta(req.params.id, body, req.adminUser!.userId);
      res.json({ repair: await loadRepairCard(req.params.id) });
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
          ...REPAIR_INCLUDE,
          workLog: { orderBy: { loggedAt: "desc" } },
          photos: { select: { id: true, filePath: true }, orderBy: { createdAt: "asc" } },
        },
      });

      if (!repair) {
        throw new HttpError(404, "Ремонт не найден", "REPAIR_NOT_FOUND");
      }

      // Три независимых обогащения — параллельно: карточка открывается по клику,
      // и лишние 200 мс здесь человек замечает.
      const [enrichment, history, loggerNames] = await Promise.all([
        enrichRepairs([repair]),
        buildRepairHistory(repair),
        resolveActorNames(repair.workLog.map((l) => l.loggedBy)),
      ]);

      const serialized = serializeRepair(repair);

      res.json({
        repair: {
          ...serialized,
          ...withCounts(repair),
          ...enrichment.get(repair.id)!,
          history,
          workLog: serialized.workLog.map((l: any) => ({
            ...l,
            loggedByName: actorName(loggerNames, l.loggedBy),
          })),
          photos: repair.photos.map((p) => ({
            id: p.id,
            url: `/api/repairs/${repair.id}/photos/${p.id}`,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/photos — приложить снимок к карточке ──────────────────────────

/**
 * Снимок поломки из админского интерфейса (модалка «Завести поломку», карточка
 * ремонта). У склада своя ручка под PIN-входом — она требует, чтобы карточку
 * завёл тот же кладовщик, и из обычной сессии отвечает 403; здесь гард по роли.
 *
 * Фото — доказательство состояния прибора, поэтому к закрытой карточке их
 * дописывать нельзя: закрытый ремонт уже лёг в историю и в деньги.
 */
repairsRouter.post(
  "/:id/photos",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  (req, res, next) => {
    // Ошибки multer конвертируем в HttpError сами: иначе превышение лимита
    // прилетает пользователю как 500 (образец — expenses.ts и warehouse.ts).
    photoUpload.single("photo")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return next(new HttpError(400, "Файл больше 5 МБ", "FILE_TOO_LARGE"));
        }
        return next(new HttpError(400, "Не удалось принять файл", "INVALID_FILE_TYPE"));
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const repairId = req.params.id;
      const file = req.file;
      if (!file) throw new HttpError(400, "Файл не передан (поле photo)", "FILE_REQUIRED");
      // Расширение и Content-Type подделываются тривиально — проверяем сигнатуру.
      if (!validateMagicBytes(file.buffer, file.mimetype)) {
        throw new HttpError(400, "Файл не похож на JPEG/PNG", "INVALID_FILE_TYPE");
      }

      const repair = await prisma.repair.findUnique({
        where: { id: repairId },
        select: { id: true, status: true },
      });
      if (!repair) throw new HttpError(404, "Карточка ремонта не найдена", "NOT_FOUND");
      if (repair.status === "CLOSED" || repair.status === "WROTE_OFF") {
        throw new HttpError(409, "Карточка ремонта уже закрыта", "REPAIR_ALREADY_CLOSED");
      }

      const rel = writeRepairPhoto(repairId, file.buffer, file.originalname);
      const photo = await prisma.repairPhoto.create({
        data: { repairId, filePath: rel, createdBy: req.adminUser?.userId ?? "_unknown_" },
      });
      const photosCount = await prisma.repairPhoto.count({ where: { repairId } });

      res.status(201).json({
        photo: { id: photo.id, url: `/api/repairs/${repairId}/photos/${photo.id}` },
        photosCount,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:id/photos/:photoId — стрим фото поломки ───────────────────────────

repairsRouter.get(
  "/:id/photos/:photoId",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const photo = await prisma.repairPhoto.findUnique({
        where: { id: req.params.photoId },
        select: { filePath: true, repairId: true },
      });
      if (!photo || photo.repairId !== req.params.id) {
        throw new HttpError(404, "Фото не найдено", "REPAIR_PHOTO_NOT_FOUND");
      }

      // Резолв относительного пути в абсолютный с guard от path traversal
      const abs = resolveUploadPath(photo.filePath);
      if (!abs) throw new HttpError(404, "Файл не найден на диске", "FILE_NOT_FOUND");
      if (!fs.existsSync(abs)) throw new HttpError(404, "Файл не найден на диске", "FILE_NOT_FOUND");

      const ext = path.extname(abs).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : "image/jpeg";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename="${path.basename(abs)}"`);
      fs.createReadStream(abs).pipe(res);
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
      const { expense } = closeSchema.parse(req.body ?? {});
      const repair = await closeRepair(
        req.params.id,
        req.adminUser!.userId,
        expense,
        req.adminUser!.role as string,
      );
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
