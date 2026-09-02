import express from "express";
import { randomUUID } from "crypto";
import multer from "multer";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { matchGafferRequestOrdered, type GafferOrderedRowMatch, type ParsedRequestItem } from "../services/equipmentMatcher";
import { getLlmProvider, type GafferExtractedLine } from "../services/llm";
import {
  GAFFER_DOCUMENT_MAX_BYTES,
  importGafferDocument,
  isGafferDocumentMimeType,
  validateGafferDocumentBytes,
  type GafferDocumentImportResult,
} from "../services/gafferDocumentImport";
import { refineMatchesWithAi, type RefinedMatches } from "../services/catalogPicker";
import { HttpError } from "../utils/errors";

const router = express.Router();

/** Max chars for gaffer paste; keep in sync with bookings/new textarea maxLength. */
const MAX_REQUEST_TEXT_CHARS = 10_000;

const ParseRequestBody = z.object({
  requestText: z.string().min(1).max(MAX_REQUEST_TEXT_CHARS),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export type GafferReviewApiItem = {
  id: string;
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  match: GafferOrderedRowMatch;
};

export type { GafferExtractedLine };

function toParsedItems(lines: GafferExtractedLine[]): ParsedRequestItem[] {
  return lines.map((l) => ({ name: l.interpretedName, quantity: l.quantity, gafferPhrase: l.gafferPhrase }));
}

/** «МС все», «павослимы все» — всё наличие: количество = сколько есть у выбранной позиции. */
const WANTS_ALL_RE = /(^|[\s,(])(все|всё|all)([\s,.)!]|$)/i;
function quantityFor(line: GafferExtractedLine, match: GafferOrderedRowMatch): number {
  if (match.kind === "resolved" && line.quantity <= 1 && WANTS_ALL_RE.test(line.gafferPhrase)) {
    return Math.max(1, match.availableQuantity);
  }
  return line.quantity;
}

type MatchOutcome =
  | { ok: true; items: GafferReviewApiItem[] }
  | { ok: false; status: 503; body: { error: string; code: string } };

/**
 * Позиции от модели → поштучный матчинг каталога в исходном порядке.
 * Общий для текстовой заявки и заявки-документа. Ошибки каталога — 503
 * с кодом, по которому фронт различает «база» и «матчер».
 */
async function matchLinesToItems(lines: GafferExtractedLine[], logTag: string): Promise<MatchOutcome> {
  let matches: GafferOrderedRowMatch[];
  try {
    matches = await matchGafferRequestOrdered(toParsedItems(lines));
  } catch (err) {
    console.error(`[${logTag}] catalog match failed:`, err);
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return {
        ok: false,
        status: 503,
        body: {
          error: "Ошибка чтения каталога из базы. Проверьте миграции Prisma и перезапустите API.",
          code: "CATALOG_DB_ERROR",
        },
      };
    }
    return {
      ok: false,
      status: 503,
      body: { error: "Не удалось сопоставить позиции с каталогом. Попробуйте позже.", code: "MATCH_FAILED" },
    };
  }

  // AI-подбор для спорных строк: модель видит весь каталог и соседние строки.
  // Любой сбой здесь — не ошибка запроса: остаётся результат матчера.
  let extras: RefinedMatches["extras"] = [];
  try {
    const refined = await refineMatchesWithAi(lines, matches);
    matches = refined.matches;
    extras = refined.extras;
    if (refined.aiDecided > 0) console.info(`[${logTag}] AI-подбор каталога решил строк: ${refined.aiDecided}`);
  } catch (err: unknown) {
    console.warn(
      `[${logTag}] AI-подбор каталога не удался, остаётся результат матчера:`,
      (err as Error)?.message ?? err,
    );
  }

  const items: GafferReviewApiItem[] = [];
  lines.forEach((line, i) => {
    const match = matches[i] ?? { kind: "unmatched" as const };
    items.push({
      id: randomUUID(),
      gafferPhrase: line.gafferPhrase,
      interpretedName: line.interpretedName,
      quantity: quantityFor(line, match),
      match,
    });
    // Явно запрошенные дополнения («…с софтом» → софтбокс) — отдельными
    // позициями сразу после своей строки, с той же фразой гаффера.
    for (const extra of extras.filter((e) => e.lineIndex === i)) {
      items.push({
        id: randomUUID(),
        gafferPhrase: line.gafferPhrase,
        interpretedName: extra.match.catalogName,
        quantity: quantityFor(line, extra.match),
        match: extra.match,
      });
    }
  });
  return { ok: true, items };
}

/**
 * POST /api/bookings/parse-gaffer-review
 * LLM → список (гаффер / интерпретация / кол-во) + поштучный матчинг каталога в исходном порядке.
 */
router.post("/parse-gaffer-review", async (req, res, next) => {
  try {
    const body = ParseRequestBody.parse(req.body);

    let lines: GafferExtractedLine[];
    try {
      lines = await getLlmProvider().extractGafferLines(body.requestText);
    } catch (err: unknown) {
      console.error("[parse-gaffer-review] LLM extraction failed:", (err as Error)?.message ?? err);
      return res.status(503).json({
        error: "AI временно недоступен. Используйте ручной режим добавления оборудования.",
        code: "AI_UNAVAILABLE",
      });
    }

    if (lines.length === 0) {
      return res.json({
        items: [] as GafferReviewApiItem[],
        message: "AI не смог распознать позиции оборудования в тексте заявки.",
      });
    }

    const matched = await matchLinesToItems(lines, "parse-gaffer-review");
    if (!matched.ok) return res.status(matched.status).json(matched.body);
    return res.json({ items: matched.items });
  } catch (err) {
    next(err);
  }
});

// ── parse-gaffer-document ─────────────────────────────────────────────────────

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: GAFFER_DOCUMENT_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (isGafferDocumentMimeType(file.mimetype)) cb(null, true);
    else cb(new Error("INVALID_FILE_TYPE"));
  },
});

/**
 * Имя файла из multipart приходит через busboy как latin1: «Заявка.pdf»
 * превращается в «Ð—Ð°ÑÐ²ÐºÐ°.pdf». Если в имени только байты 0x80–0xFF и
 * ни одного символа выше — это как раз такой случай, перекодируем.
 * Настоящая кириллица (U+0400+) остаётся как есть.
 */
function decodeOriginalName(name: string): string {
  if (!/[-ÿ]/.test(name) || /[Ā-￿]/.test(name)) return name;
  const fixed = Buffer.from(name, "latin1").toString("utf8");
  return fixed.includes("�") ? name : fixed;
}

/**
 * POST /api/bookings/parse-gaffer-document — multipart, поле `file`.
 * Заявка-документ (PDF/JPEG/PNG/WEBP): модель читает позиции и шапку
 * (проект, контакты гаффера, даты), позиции матчатся с каталогом как у
 * текстовой заявки, клиент подбирается по телефону/почте/имени.
 */
router.post(
  "/parse-gaffer-document",
  (req, res, next) => {
    documentUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          const mb = Math.round(GAFFER_DOCUMENT_MAX_BYTES / 1024 / 1024);
          return next(new HttpError(413, `Файл больше ${mb} МБ`, "FILE_TOO_LARGE"));
        }
        if (err instanceof Error && err.message === "INVALID_FILE_TYPE") {
          return next(new HttpError(400, "Недопустимый тип файла. Разрешены: PDF, JPEG, PNG, WEBP", "INVALID_FILE_TYPE"));
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) throw new HttpError(400, "Файл не приложен", "NO_FILE");
      const mimeType = file.mimetype;
      if (!isGafferDocumentMimeType(mimeType) || !validateGafferDocumentBytes(file.buffer, mimeType)) {
        throw new HttpError(400, "Содержимое файла не соответствует указанному типу", "INVALID_FILE_FORMAT");
      }
      const fileName = decodeOriginalName(file.originalname);

      let result: GafferDocumentImportResult;
      try {
        result = await importGafferDocument({ buffer: file.buffer, mimeType, fileName });
      } catch (err: unknown) {
        if (err instanceof HttpError) throw err;
        console.error("[parse-gaffer-document] LLM extraction failed:", (err as Error)?.message ?? err);
        return res.status(503).json({
          error: "AI временно недоступен. Вставьте текст заявки или добавьте оборудование вручную.",
          code: "AI_UNAVAILABLE",
        });
      }

      const document = { ...result.meta, fileName };
      if (result.lines.length === 0) {
        return res.json({
          items: [] as GafferReviewApiItem[],
          document,
          client: result.client,
          message: "AI не нашёл позиций оборудования в документе.",
        });
      }

      const matched = await matchLinesToItems(result.lines, "parse-gaffer-document");
      if (!matched.ok) return res.status(matched.status).json(matched.body);
      return res.json({ items: matched.items, document, client: result.client });
    } catch (err) {
      next(err);
    }
  },
);

// ── match-equipment endpoint ──────────────────────────────────────────────────

/** Coerce "2", 2, "2шт", null → integer; default 1 (for request body validation) */
const quantityPreprocess = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 1;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(1, Math.round(v));
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
}, z.number().int().positive());

const MatchEquipmentItemSchema = z.object({
  name: z.string().min(1),
  quantity: quantityPreprocess,
  gafferPhrase: z.string().optional(),
});

const MatchEquipmentBody = z.object({
  items: z.array(MatchEquipmentItemSchema),
});

/**
 * POST /api/bookings/match-equipment
 * Принимает уже извлечённые позиции (name + quantity + gafferPhrase опционально)
 * и запускает matchGafferRequestOrdered() — без вызова LLM.
 */
router.post("/match-equipment", async (req, res, next) => {
  try {
    const body = MatchEquipmentBody.parse(req.body);

    if (body.items.length === 0) {
      return res.json({ items: [] as GafferReviewApiItem[] });
    }

    const forMatch: ParsedRequestItem[] = body.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      gafferPhrase: item.gafferPhrase,
    }));

    let matches: GafferOrderedRowMatch[];
    try {
      matches = await matchGafferRequestOrdered(forMatch);
    } catch (err) {
      console.error("[match-equipment] catalog match failed:", err);
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        return res.status(503).json({
          error: "Ошибка чтения каталога из базы. Проверьте миграции Prisma и перезапустите API.",
          code: "CATALOG_DB_ERROR",
        });
      }
      return res.status(503).json({
        error: "Не удалось сопоставить позиции с каталогом. Попробуйте позже.",
        code: "MATCH_FAILED",
      });
    }

    const items: GafferReviewApiItem[] = body.items.map((item, i) => ({
      id: randomUUID(),
      gafferPhrase: item.gafferPhrase ?? item.name,
      interpretedName: item.name,
      quantity: item.quantity,
      match: matches[i] ?? { kind: "unmatched" as const },
    }));

    return res.json({ items });
  } catch (err) {
    next(err);
  }
});

export { router as bookingRequestParserRouter };
