import { z } from "zod";

export type GafferExtractedLine = {
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
};

/** MIME-типы документов заявки, которые умеем читать (PDF и фото/скан). */
export const GAFFER_DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type GafferDocumentMimeType = (typeof GAFFER_DOCUMENT_MIME_TYPES)[number];

/** Документ заявки, который прислал гаффер: PDF из его программы или фото листка. */
export type GafferDocumentInput = {
  data: Buffer;
  mimeType: GafferDocumentMimeType;
  /** Только для логов и подсказки модели. */
  fileName?: string;
};

/** Что удалось вычитать из документа помимо позиций. `null` — в документе этого нет. */
export type GafferDocumentMeta = {
  projectName: string | null;
  gafferName: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  /** Даты съёмки в формате YYYY-MM-DD. */
  startDate: string | null;
  endDate: string | null;
};

export type GafferDocumentExtraction = {
  lines: GafferExtractedLine[];
  meta: GafferDocumentMeta;
};

export interface LlmProvider {
  /**
   * Extract equipment lines from gaffer's free-form Russian text.
   * Should handle retries and JSON parsing quirks internally.
   */
  extractGafferLines(text: string): Promise<GafferExtractedLine[]>;
  /**
   * Прочитать заявку-документ (PDF/фото): позиции + шапка (проект, контакты, даты).
   * Не у каждого провайдера есть зрение — у таких метод отсутствует, и
   * цепочка fallback такие ноги пропускает.
   */
  extractGafferDocument?(doc: GafferDocumentInput): Promise<GafferDocumentExtraction>;
}

/** System prompt for gaffer text extraction (shared across providers). */
export const EXTRACT_PROMPT_REVIEW = `You are an equipment list parser for a film/photo lighting rental company.

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

/**
 * Промпт для заявки-документа (PDF/фото). Общий для провайдеров со зрением:
 * у Claude форму ответа дополнительно держит structured output, у Gemini —
 * JSON-режим плюс описание формы в самом промпте.
 */
export const EXTRACT_DOCUMENT_PROMPT = `You are reading an equipment request that a gaffer sent to a film lighting rental house. The input is a PDF or a photo/scan of that request.

Typical layout: a header with the gaffer's name and contacts (phone, email, Telegram, Instagram), a project title, a date or a date range, then a table of equipment lines with a quantity column ("Кол-во"), often grouped under section headings such as СВЕТ / ГРИП / ПРОЧЕЕ. Layouts vary — use judgement.

Extract:
- projectName: the production/project title only — without the rental house name, dates or separators. null if absent.
- gafferName, phone, email, telegram: contacts of the person who sent the request. Keep the phone digits as written. null when absent.
- startDate / endDate: shooting dates as YYYY-MM-DD. A range fills both; a single date fills startDate and leaves endDate null. A date printed next to the project title counts as the shooting start date. null when there is no date at all.
- items: EVERY equipment line in document order. For each line:
  - gafferPhrase: the line text exactly as written in the document;
  - interpretedName: a short normalized equipment name for inventory matching (Latin/brand/model style when obvious, e.g. "aputure 1200x pro", "c-stand"). Do NOT put quantity here;
  - quantity: integer from the quantity column; 1 if missing.

Skip section headings, page headers/footers, logos, totals and empty rows. Do not merge or split lines. Do not invent items that are not in the document.

Respond with ONLY a JSON object of this shape, no markdown:
{ "projectName": string|null, "gafferName": string|null, "phone": string|null, "email": string|null, "telegram": string|null, "startDate": string|null, "endDate": string|null, "items": [ { "gafferPhrase": string, "interpretedName": string, "quantity": integer } ] }
`;

/** Coerce "2", 2, "2шт", null → integer; default 1 */
const quantityPreprocess = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 1;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(1, Math.round(v));
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
}, z.number().int().positive());

const rawLineSchema = z.object({
  gafferPhrase: z.string().optional(),
  interpretedName: z.string().optional(),
  /** Совместимость со старым форматом ответа модели */
  name: z.string().optional(),
  quantity: quantityPreprocess,
  notes: z.string().optional(),
});

/**
 * Accept raw LLM JSON (either a bare array or { items: [...] }) and
 * validate it into GafferExtractedLine[]. Skips invalid rows silently.
 */
export function normalizeRawLines(raw: unknown): GafferExtractedLine[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && "items" in raw && Array.isArray((raw as { items: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];

  const out: GafferExtractedLine[] = [];
  for (const item of arr) {
    const res = rawLineSchema.safeParse(item);
    if (!res.success) continue;
    const data = res.data;
    const interpreted = (data.interpretedName ?? data.name ?? "").trim();
    if (!interpreted) continue;
    const gaffer = (data.gafferPhrase ?? data.name ?? interpreted).trim() || interpreted;
    out.push({ gafferPhrase: gaffer, interpretedName: interpreted, quantity: data.quantity });
  }
  return out;
}

/** Пустая шапка — когда модель ничего не нашла или ответила не по форме. */
export const EMPTY_DOCUMENT_META: GafferDocumentMeta = {
  projectName: null,
  gafferName: null,
  phone: null,
  email: null,
  telegram: null,
  startDate: null,
  endDate: null,
};

/**
 * Дату из документа приводим к YYYY-MM-DD. Модель просят отдавать ISO, но в
 * заявках даты пишут «02.09.2026», и модели порой копируют как есть.
 */
export function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const ru = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (ru) [y, m, d] = [Number(ru[3]), Number(ru[2]), Number(ru[1])];
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const nullableText = z.preprocess(
  (v) => (typeof v === "string" && v.trim() ? v.trim() : null),
  z.string().nullable(),
);

const rawDocumentSchema = z.object({
  projectName: nullableText.optional(),
  gafferName: nullableText.optional(),
  phone: nullableText.optional(),
  email: nullableText.optional(),
  telegram: nullableText.optional(),
  startDate: z.unknown().optional(),
  endDate: z.unknown().optional(),
});

/**
 * Сырой JSON ответа по документу → строго типизированный результат.
 * Позиции идут через тот же normalizeRawLines, что и текстовая заявка;
 * незнакомая форма ответа даёт пустой список и пустую шапку, а не исключение.
 */
export function normalizeDocumentExtraction(raw: unknown): GafferDocumentExtraction {
  const lines = normalizeRawLines(raw);
  const parsed = rawDocumentSchema.safeParse(raw);
  if (!parsed.success) return { lines, meta: { ...EMPTY_DOCUMENT_META } };
  const d = parsed.data;
  return {
    lines,
    meta: {
      projectName: d.projectName ?? null,
      gafferName: d.gafferName ?? null,
      phone: d.phone ?? null,
      email: d.email ?? null,
      telegram: d.telegram ?? null,
      startDate: normalizeIsoDate(d.startDate),
      endDate: normalizeIsoDate(d.endDate),
    },
  };
}
