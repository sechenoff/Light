/**
 * Russian-aware normalization helpers used across the reconcile pipeline.
 * Pure: no DB, no I/O.
 */

const QTY_TRAILING_RE = /\s*\(\s*(\d+)\s*\)\s*$/;

export function normalizeRu(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,;:!?"'`«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeClientName(name: string): string {
  return normalizeRu(name);
}

export function phraseNoQty(phrase: string): string {
  return phrase.replace(QTY_TRAILING_RE, "").trim();
}

export function extractQty(phrase: string): number {
  const m = phrase.match(QTY_TRAILING_RE);
  return m ? parseInt(m[1], 10) : 1;
}
