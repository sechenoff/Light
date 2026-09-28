/**
 * Черновик чек-листа киоска (P6): количества со степпера, отметки строк и
 * исходы приёмки живут на сервере (`ScanSession.draftJson`), а не в памяти
 * планшета. Раньше смена раздела, перезагрузка или второй планшет стирали
 * работу на 60+ строк, и выдавался план, а не погруженное.
 *
 * Контракт (план, 2.5): `PUT /sessions/:id/draft { revision, draft }` →
 * `{ revision, savedAt }`. Ревизия — оптимистичная блокировка двух устройств:
 * сохранение от устаревшей ревизии получает 409 `DRAFT_OUTDATED` со свежим
 * черновиком, и клиент применяет его вместо своего.
 *
 * Черновик — подсказка экрану, а не учёт: сервер проверяет форму и размер, но
 * не сверяет строки с составом брони (это делает клиент при восстановлении).
 * Зеркало типов — `apps/web/src/components/warehouse/types.ts`
 * (`ChecklistDraftV1`, `CHECKLIST_DRAFT_LIMITS`).
 */

import { z } from "zod";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import {
  SCAN_ERR,
  SCAN_MSG,
  assertSessionWritable,
  closedSessionError,
} from "./scanSessionPolicy";

/** Лимиты черновика — те же, что `CHECKLIST_DRAFT_LIMITS` на web. */
export const CHECKLIST_DRAFT_LIMITS = {
  /** Размер JSON черновика в байтах UTF-8. */
  maxBytes: 256 * 1024,
  /** Суммарное число ключей во всех словарях черновика. */
  maxKeys: 500,
  /** Длина любой строки (комментарий к ремонту, потеряшке). */
  maxStringLength: 2000,
} as const;

/** Потолок ячеек одной сетки приёмки — страховка поверх лимита размера. */
const MAX_GRID_SLOTS = 2000;
/** Разумный потолок количества в строке черновика. */
const MAX_DRAFT_QTY = 100_000;

const draftText = z.string().max(CHECKLIST_DRAFT_LIMITS.maxStringLength);
const draftKey = z.string().min(1).max(64);

const problemDraftSchema = z.object({
  reason: z.enum(["LEFT_ON_SITE", "LOST", "DESTROYED", "STOLEN"]).nullable().optional(),
  comment: draftText.optional(),
  /** Сырое значение `<input type="date">` — `YYYY-MM-DD` или пусто. */
  expectedBackDate: z.string().max(32).nullable().optional(),
});

const issueRowSchema = z.object({
  qty: z.number().int().min(0).max(MAX_DRAFT_QTY),
  checked: z.boolean(),
  /** Запасной ключ, если позицию брони пересоздали. */
  equipmentId: z.string().max(64).nullable(),
  /** Строке разрешён потолок «под ответственность». */
  ack: z.boolean().optional(),
});

const returnUnitSchema = z.object({
  outcome: z.enum(["ACCEPTED", "REPAIR", "PROBLEM"]),
  repairComment: draftText.optional(),
  problem: problemDraftSchema.optional(),
});

const returnSlotSchema = z.object({
  status: z.enum(["PENDING", "ACCEPTED", "REPAIR", "PROBLEM"]),
  repairComment: draftText.optional(),
  problem: problemDraftSchema.optional(),
});

const returnGridSchema = z.object({
  equipmentId: z.string().max(64).nullable(),
  slots: z.array(returnSlotSchema).max(MAX_GRID_SLOTS),
});

/**
 * Черновик чек-листа v1. Лишние поля отбрасываются (tolerant reader): старый
 * планшет не должен ломать сохранение, если форма расширится.
 */
export const checklistDraftSchema = z.object({
  v: z.literal(1),
  issue: z.object({ rows: z.record(draftKey, issueRowSchema) }).optional(),
  return: z
    .object({
      units: z.record(draftKey, returnUnitSchema),
      grids: z.record(draftKey, returnGridSchema),
      // Не строже, чем /complete (целое ≥ 0): иначе одно показание, которое
      // «Готово» примет, сорвало бы сохранение всего черновика приёмки.
      mileages: z.record(draftKey, z.number().min(0).max(Number.MAX_SAFE_INTEGER).nullable()).optional(),
    })
    .optional(),
});

export type ChecklistDraftV1 = z.infer<typeof checklistDraftSchema>;

/** Тело `PUT /api/warehouse/sessions/:id/draft`. Сам черновик проверяет `saveChecklistDraft`. */
export const saveChecklistDraftBodySchema = z.object({
  revision: z.number().int().min(0),
  draft: z.unknown(),
});

function draftTooLarge(): HttpError {
  return new HttpError(413, SCAN_MSG.DRAFT_TOO_LARGE, SCAN_ERR.DRAFT_TOO_LARGE);
}

function countDraftKeys(d: ChecklistDraftV1): number {
  const size = (o: Record<string, unknown> | undefined) => (o ? Object.keys(o).length : 0);
  return (
    size(d.issue?.rows) +
    size(d.return?.units) +
    size(d.return?.grids) +
    size(d.return?.mileages)
  );
}

/**
 * Проверяет черновик: размер JSON (413), форму (400 через ZodError) и число
 * ключей (413). Возвращает очищенный черновик и его JSON для записи.
 */
export function validateChecklistDraft(raw: unknown): { draft: ChecklistDraftV1; json: string } {
  const rawJson = JSON.stringify(raw ?? null);
  if (Buffer.byteLength(rawJson, "utf8") > CHECKLIST_DRAFT_LIMITS.maxBytes) throw draftTooLarge();
  const draft = checklistDraftSchema.parse(raw);
  if (countDraftKeys(draft) > CHECKLIST_DRAFT_LIMITS.maxKeys) throw draftTooLarge();
  return { draft, json: JSON.stringify(draft) };
}

/**
 * Черновик из базы для `/state` и 409 `DRAFT_OUTDATED`. Повреждённый или
 * записанный в старом формате — null: клиент начнёт с плана брони, а не упадёт.
 */
export function parseStoredDraft(json: string | null): ChecklistDraftV1 | null {
  if (!json) return null;
  try {
    const parsed = checklistDraftSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Сохраняет черновик чек-листа в ACTIVE-сессию, если на сервере та же ревизия,
 * от которой клиент строил черновик. Запись и проверка ревизии — одним
 * условным updateMany: два планшета не затрут друг друга молча.
 *
 *  - сессии нет / завершена / прервана / устарела → коды `SESSION_*`
 *    (устаревшая при этом закрывается — assertSessionWritable);
 *  - ревизия устарела → 409 `DRAFT_OUTDATED` { revision, draft, savedAt, savedBy }.
 *
 * `savedBy` — кто сохранил (имя PIN-кладовщика или логин сотрудника).
 */
export async function saveChecklistDraft(
  sessionId: string,
  input: { revision: number; draft: unknown },
  savedBy: string | null,
): Promise<{ revision: number; savedAt: string }> {
  const { json } = validateChecklistDraft(input.draft);
  await assertSessionWritable(prisma, sessionId);

  const savedAt = new Date();
  const res = await prisma.scanSession.updateMany({
    where: { id: sessionId, status: "ACTIVE", draftRevision: input.revision },
    data: {
      draftJson: json,
      draftRevision: { increment: 1 },
      draftSavedAt: savedAt,
      draftSavedBy: savedBy?.trim() || null,
    },
  });
  if (res.count === 1) return { revision: input.revision + 1, savedAt: savedAt.toISOString() };

  const fresh = await prisma.scanSession.findUnique({ where: { id: sessionId } });
  if (!fresh) throw new HttpError(404, SCAN_MSG.SESSION_NOT_FOUND, SCAN_ERR.SESSION_NOT_FOUND);
  const closed = closedSessionError(fresh);
  if (closed) throw closed;
  throw new HttpError(409, SCAN_MSG.DRAFT_OUTDATED, SCAN_ERR.DRAFT_OUTDATED, {
    revision: fresh.draftRevision,
    draft: parseStoredDraft(fresh.draftJson),
    savedAt: fresh.draftSavedAt?.toISOString() ?? null,
    savedBy: fresh.draftSavedBy ?? null,
  });
}
