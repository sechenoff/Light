import stringSimilarity from "string-similarity";
import { normalizeRu } from "../lib/normalize";

export interface EquipmentMatchInput {
  id: string;
  name: string;
  importKey: string | null;
  aliases: { phrase: string }[];
}

export interface EquipmentMatchResult {
  equipmentId: string | null;
  method: "importKey" | "alias" | "similarity" | "none";
  score: number;
}

const SIM_THRESHOLD = 0.7;

export function matchEquipmentName(rawName: string, catalog: EquipmentMatchInput[]): EquipmentMatchResult {
  const norm = normalizeRu(rawName);
  if (!norm) return { equipmentId: null, method: "none", score: 0 };

  const byKey = catalog.find((e) => e.importKey && normalizeRu(e.importKey) === norm);
  if (byKey) return { equipmentId: byKey.id, method: "importKey", score: 1 };

  for (const e of catalog) {
    for (const a of e.aliases) {
      if (normalizeRu(a.phrase) === norm) {
        return { equipmentId: e.id, method: "alias", score: 1 };
      }
    }
  }

  const namesNorm = catalog.map((e) => normalizeRu(e.name));
  if (namesNorm.length === 0) return { equipmentId: null, method: "none", score: 0 };
  const { ratings } = stringSimilarity.findBestMatch(norm, namesNorm);
  const best = ratings.reduce((a, b) => (b.rating > a.rating ? b : a), { rating: 0, target: "" });
  if (best.rating >= SIM_THRESHOLD) {
    const idx = namesNorm.indexOf(best.target);
    return { equipmentId: catalog[idx].id, method: "similarity", score: best.rating };
  }

  return { equipmentId: null, method: "none", score: best.rating };
}
