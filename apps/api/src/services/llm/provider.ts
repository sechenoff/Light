import { z } from "zod";

export type GafferExtractedLine = {
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
};

export interface LlmProvider {
  /**
   * Extract equipment lines from gaffer's free-form Russian text.
   * Should handle retries and JSON parsing quirks internally.
   */
  extractGafferLines(text: string): Promise<GafferExtractedLine[]>;
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
