import { SlangCandidate } from "../types";
import { normalizeRu } from "../lib/normalize";

export interface ExtractInput {
  phrase: string;
  equipmentId: string;
  equipmentName: string;
  msgId: number;
  nameSubstringMatch: boolean;
}

const AUTO_THRESHOLD = 0.85;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function extractSlangCandidates(inputs: ExtractInput[]): SlangCandidate[] {
  const map = new Map<string, {
    phraseOriginal: string;
    phraseNormalized: string;
    equipmentId: string;
    equipmentName: string;
    msgIds: number[];
    substringMatchAny: boolean;
  }>();

  for (const i of inputs) {
    const norm = normalizeRu(i.phrase);
    const key = `${norm}::${i.equipmentId}`;
    const existing = map.get(key);
    if (existing) {
      existing.msgIds.push(i.msgId);
      existing.substringMatchAny = existing.substringMatchAny || i.nameSubstringMatch;
    } else {
      map.set(key, {
        phraseOriginal: i.phrase,
        phraseNormalized: norm,
        equipmentId: i.equipmentId,
        equipmentName: i.equipmentName,
        msgIds: [i.msgId],
        substringMatchAny: i.nameSubstringMatch,
      });
    }
  }

  const phraseTotal = new Map<string, number>();
  for (const entry of map.values()) {
    phraseTotal.set(entry.phraseNormalized, (phraseTotal.get(entry.phraseNormalized) ?? 0) + entry.msgIds.length);
  }

  const out: SlangCandidate[] = [];
  for (const entry of map.values()) {
    const support = entry.msgIds.length;
    const total = phraseTotal.get(entry.phraseNormalized) ?? support;
    const dominant = support / total >= 0.8;

    let confidence = 0.5;
    confidence += 0.1 * Math.log10(support + 1);
    if (support >= 2) confidence += 0.1;
    if (dominant) confidence += 0.2;
    if (entry.substringMatchAny) confidence += 0.2;
    confidence = clamp(confidence, 0, 1);

    out.push({
      phraseOriginal: entry.phraseOriginal,
      phraseNormalized: entry.phraseNormalized,
      equipmentId: entry.equipmentId,
      equipmentName: entry.equipmentName,
      confidence,
      supportCount: support,
      decision: confidence >= AUTO_THRESHOLD ? "AUTO" : "REVIEW",
      sourceMsgIds: entry.msgIds,
    });
  }

  return out;
}
