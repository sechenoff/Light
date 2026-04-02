import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Prisma } from "@prisma/client";
import { matchGafferRequestOrdered, type GafferOrderedRowMatch, type ParsedRequestItem } from "../services/equipmentMatcher";

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

// ── LLM extraction (review table: как написал гаффер / как поняла модель) ─────

const EXTRACT_PROMPT_REVIEW = `You are an equipment list parser for a film/photo lighting rental company.

Extract ALL equipment items from the gaffer's request text below.

For EACH item output a JSON object with:
- gafferPhrase: copy the phrase EXACTLY as it appears in the request (include quantity words if they are on the same line, e.g. "2x 52xt"). If impossible, use the shortest faithful quote from the request.
- interpretedName: a short normalized equipment name for inventory matching (Latin/brand/model style when obvious, e.g. "52xt", "nova p300"). Do NOT put quantity here.
- quantity: integer, default 1 if not specified in the request.

CRITICAL: Respond with ONLY a valid JSON array. No markdown, no extra text.

Example:
[
  { "gafferPhrase": "2 шт 52xt blair", "interpretedName": "52xt", "quantity": 2 },
  { "gafferPhrase": "nova p300 с софтом", "interpretedName": "nova p300", "quantity": 1 },
  { "gafferPhrase": "c-stand", "interpretedName": "c-stand", "quantity": 4 }
]

If no equipment items can be identified, return an empty array: []

Gaffer request:
`;

function readGeminiText(result: {
  response: {
    text: () => string;
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  };
}): string {
  try {
    return result.response.text();
  } catch (first: unknown) {
    const c = result.response.candidates?.[0];
    const reason = c?.finishReason;
    if (reason && reason !== "STOP") {
      throw new Error(`Gemini завершила ответ со статусом ${reason}`);
    }
    const parts = c?.content?.parts;
    if (Array.isArray(parts)) {
      const joined = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
      if (joined.trim()) return joined;
    }
    const msg = first instanceof Error ? first.message : String(first);
    throw new Error(`Пустой ответ AI: ${msg}`);
  }
}

const quantityPreprocess = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 1;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(1, Math.round(v));
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
}, z.number().int().positive());

const RawLineSchema = z.object({
  gafferPhrase: z.string().optional(),
  interpretedName: z.string().optional(),
  /** Совместимость со старым форматом ответа модели */
  name: z.string().optional(),
  quantity: quantityPreprocess,
  notes: z.string().optional(),
});

export type GafferExtractedLine = {
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
};

function normalizeExtractedLine(raw: z.infer<typeof RawLineSchema>): GafferExtractedLine | null {
  const interpreted = (raw.interpretedName ?? raw.name ?? "").trim();
  if (!interpreted) return null;
  const gaffer = (raw.gafferPhrase ?? raw.name ?? interpreted).trim() || interpreted;
  return { gafferPhrase: gaffer, interpretedName: interpreted, quantity: raw.quantity };
}

async function extractGafferLinesForReview(text: string): Promise<GafferExtractedLine[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const modelName = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: modelName,
    generationConfig: {
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  let raw = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const result = await model.generateContent(EXTRACT_PROMPT_REVIEW + text);
      raw = readGeminiText(result);
      break;
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      if ((status === 503 || status === 429) && attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }

  console.log(`[parse-gaffer] raw response length=${raw.length}, last 50: ...${raw.slice(-50)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (mdMatch?.[1]) {
      try {
        parsed = JSON.parse(mdMatch[1].trim());
      } catch {}
    }
    if (!parsed) {
      const arrMatch = raw.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try {
          parsed = JSON.parse(arrMatch[0]);
        } catch {}
      }
    }
    // Попытка починить обрезанный JSON: закрыть незавершённые структуры
    if (!parsed && raw.startsWith("[")) {
      const lastComplete = raw.lastIndexOf("}");
      if (lastComplete > 0) {
        try {
          parsed = JSON.parse(raw.slice(0, lastComplete + 1) + "]");
          console.log(`[parse-gaffer] repaired truncated JSON, recovered array`);
        } catch {}
      }
    }
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[parse-gaffer] failed to parse as array, raw start: ${raw.slice(0, 200)}`);
    return [];
  }

  const out: GafferExtractedLine[] = [];
  for (const row of parsed) {
    const r = RawLineSchema.safeParse(row);
    if (!r.success) continue;
    const n = normalizeExtractedLine(r.data);
    if (n) out.push(n);
  }
  return out;
}

function toParsedItems(lines: GafferExtractedLine[]): ParsedRequestItem[] {
  return lines.map((l) => ({ name: l.interpretedName, quantity: l.quantity }));
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
      lines = await extractGafferLinesForReview(body.requestText);
    } catch (err: any) {
      console.error("[parse-gaffer-review] LLM extraction failed:", err?.message ?? err);
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

export { router as bookingRequestParserRouter };
