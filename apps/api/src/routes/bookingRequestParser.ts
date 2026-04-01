import express from "express";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Prisma } from "@prisma/client";
import { matchGafferRequest, type ParsedRequestItem } from "../services/equipmentMatcher";

const router = express.Router();

// ── Validation ────────────────────────────────────────────────────────────────

/** Max chars for gaffer paste; keep in sync with bookings/new textarea maxLength. */
const MAX_REQUEST_TEXT_CHARS = 10_000;

const ParseRequestBody = z.object({
  requestText: z.string().min(1).max(MAX_REQUEST_TEXT_CHARS),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// ── LLM extraction ─────────────────────────────────────────────────────────────

const EXTRACT_PROMPT = `You are an equipment list parser for a film/photo lighting rental company.

Extract ALL equipment items from the gaffer's request text below.
For each item, extract:
- name: the equipment name (as written, do NOT translate or normalize)
- quantity: integer quantity (default 1 if not specified)
- notes: any additional notes about the item (optional)

CRITICAL: Respond with ONLY a valid JSON array. No markdown, no extra text.

Example:
[
  { "name": "52xt", "quantity": 2 },
  { "name": "nova p300", "quantity": 1, "notes": "с мягкой коробкой" },
  { "name": "c-stand", "quantity": 4 }
]

If no equipment items can be identified, return an empty array: []

Gaffer request:
`;

/** Gemini SDK may throw from response.text() when candidates are empty, blocked, or malformed. */
function readGeminiText(result: { response: { text: () => string; candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }> } }): string {
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

async function extractItemsWithLLM(text: string): Promise<ParsedRequestItem[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const modelName = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: modelName,
    generationConfig: {
      /** Long lists need a large JSON array; was 2048 and truncated for ~50+ lines. */
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  });

  let raw = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const result = await model.generateContent(EXTRACT_PROMPT + text);
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

  // Robust JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (mdMatch?.[1]) {
      try { parsed = JSON.parse(mdMatch[1].trim()); } catch {}
    }
    if (!parsed) {
      const arrMatch = raw.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try { parsed = JSON.parse(arrMatch[0]); } catch {}
      }
    }
  }

  if (!Array.isArray(parsed)) return [];

  const ItemSchema = z.object({
    name: z.string().min(1),
    /** Модель может опустить quantity или отдать строкой. */
    quantity: z.preprocess((v) => {
      if (v === undefined || v === null || v === "") return 1;
      if (typeof v === "number" && Number.isFinite(v)) return Math.max(1, Math.round(v));
      const n = Number(String(v).trim().replace(",", "."));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
    }, z.number().int().positive()),
    notes: z.string().optional(),
  });

  return parsed
    .map((item) => {
      const r = ItemSchema.safeParse(item);
      return r.success ? r.data : null;
    })
    .filter((x): x is ParsedRequestItem => x !== null);
}

// ── Route ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/bookings/parse-request
 * Parses free-form gaffer equipment request text with AI and matches to catalog.
 */
router.post("/parse-request", async (req, res, next) => {
  try {
    const { requestText } = ParseRequestBody.parse(req.body);

    // Step 1: LLM extracts structured items from free-form text
    let extractedItems: ParsedRequestItem[];
    try {
      extractedItems = await extractItemsWithLLM(requestText);
    } catch (err: any) {
      console.error("[parse-request] LLM extraction failed:", err?.message ?? err);
      return res.status(503).json({
        error: "AI временно недоступен. Используйте ручной режим добавления оборудования.",
        code: "AI_UNAVAILABLE",
      });
    }

    if (extractedItems.length === 0) {
      return res.json({
        resolved: [],
        needsReview: [],
        unmatched: [],
        message: "AI не смог распознать позиции оборудования в тексте заявки.",
      });
    }

    // Step 2: Match extracted items to catalog
    let matchResult;
    try {
      matchResult = await matchGafferRequest(extractedItems);
    } catch (err) {
      console.error("[parse-request] catalog match failed:", err);
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

    return res.json(matchResult);
  } catch (err) {
    next(err);
  }
});

export { router as bookingRequestParserRouter };
