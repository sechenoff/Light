import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { matchGafferRequestOrdered, type GafferOrderedRowMatch, type ParsedRequestItem } from "../services/equipmentMatcher";
import { getLlmProvider, type GafferExtractedLine } from "../services/llm";

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

    const forMatch = toParsedItems(lines);
    let matches: GafferOrderedRowMatch[];
    try {
      matches = await matchGafferRequestOrdered(forMatch);
    } catch (err) {
      console.error("[parse-gaffer-review] catalog match failed:", err);
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

    const items: GafferReviewApiItem[] = lines.map((line, i) => ({
      id: randomUUID(),
      gafferPhrase: line.gafferPhrase,
      interpretedName: line.interpretedName,
      quantity: line.quantity,
      match: matches[i] ?? { kind: "unmatched" as const },
    }));

    return res.json({ items });
  } catch (err) {
    next(err);
  }
});

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
