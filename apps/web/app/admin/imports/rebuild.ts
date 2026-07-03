/**
 * Восстановление результата анализа импорт-сессии из истории.
 *
 * Раньше клик по прошлой сессии вёл в тупик «Данные анализа недоступны»:
 * handleSelectSession не загружал данные. Теперь строки дозагружаются через
 * GET /api/import-sessions/:id/rows, а результат собирается клиентски —
 * зеркально серверному analyzeWithAI (apps/api/src/services/importSession.ts).
 */

import type {
  ImportSession,
  ImportRow,
  ChangeGroup,
  AnalyzeResultOwn,
  AnalyzeResultCompetitor,
} from "@/components/admin/imports/types";

/** Сырая строка из GET /:id/rows (подмножество нужных полей). */
export type RawSessionRow = {
  id: string;
  sourceName: string;
  sourceCategory: string | null;
  sourcePrice: string | null;
  sourceQty: number | null;
  equipmentId: string | null;
  oldPrice: string | null;
  oldQty: number | null;
  priceDelta: string | null;
  matchMethod: string | null;
  matchSource: string | null;
  matchConfidence: string | null;
  action: string;
  status: string;
  aiDescription: string | null;
  equipment: { id: string; name: string; category: string } | null;
};

const OWN_ACTION_TYPES = ["PRICE_CHANGE", "QTY_CHANGE", "NEW_ITEM", "REMOVED_ITEM"] as const;
const PARITY_THRESHOLD = 5; // ±5% — как в серверном analyzeWithAI

function toImportRow(r: RawSessionRow): ImportRow {
  return {
    id: r.id,
    sourceName: r.sourceName,
    sourceCategory: r.sourceCategory,
    sourcePrice: r.sourcePrice,
    sourceQty: r.sourceQty,
    equipmentId: r.equipmentId,
    equipmentName: r.equipment?.name ?? null,
    equipmentCategory: r.equipment?.category ?? null,
    oldPrice: r.oldPrice,
    oldQty: r.oldQty,
    priceDelta: r.priceDelta,
    matchMethod: r.matchMethod,
    matchSource: r.matchSource,
    matchConfidence: r.matchConfidence != null ? parseFloat(r.matchConfidence) : null,
    action: r.action,
    status: r.status,
    aiDescription: r.aiDescription,
  };
}

export function buildOwnResultFromRows(
  session: ImportSession,
  rows: RawSessionRow[]
): AnalyzeResultOwn {
  const groups: ChangeGroup[] = [];
  for (const type of OWN_ACTION_TYPES) {
    const rowsForAction = rows.filter((r) => r.action === type).map(toImportRow);
    if (rowsForAction.length > 0) {
      groups.push({ type, count: rowsForAction.length, rows: rowsForAction });
    }
  }
  return {
    summary: session.aiSummary ?? "",
    groups,
    noChangeCount: rows.filter((r) => r.action === "NO_CHANGE").length,
  };
}

export function buildCompetitorResultFromRows(
  session: ImportSession,
  rows: RawSessionRow[]
): AnalyzeResultCompetitor {
  let cheaperCount = 0;
  let expensiveCount = 0;
  let parityCount = 0;
  let deltaSum = 0;
  let deltaCount = 0;

  const matched = rows
    .filter((r) => r.equipmentId !== null)
    .map((r) => {
      const our = r.oldPrice != null ? parseFloat(r.oldPrice) : NaN;
      const comp = r.sourcePrice != null ? parseFloat(r.sourcePrice) : NaN;
      let deltaPercent = 0;
      if (Number.isFinite(our) && Number.isFinite(comp) && comp > 0) {
        deltaPercent = ((our - comp) / comp) * 100;
        deltaSum += deltaPercent;
        deltaCount += 1;
        if (Math.abs(deltaPercent) <= PARITY_THRESHOLD) parityCount += 1;
        else if (our < comp) cheaperCount += 1;
        else expensiveCount += 1;
      }
      return {
        id: r.id,
        sourceName: r.sourceName,
        sourcePrice: r.sourcePrice,
        equipmentId: r.equipmentId as string,
        equipmentName: r.equipment?.name ?? "—",
        equipmentCategory: r.equipment?.category ?? "—",
        ourPrice: Number.isFinite(our) ? String(our) : "—",
        competitorPrice: Number.isFinite(comp) ? String(comp) : "—",
        deltaPercent: parseFloat(deltaPercent.toFixed(2)),
        matchSource: r.matchSource,
        matchConfidence: r.matchConfidence != null ? parseFloat(r.matchConfidence) : null,
      };
    });

  const unmatched = rows
    .filter((r) => r.equipmentId === null)
    .map((r) => ({ id: r.id, sourceName: r.sourceName, sourcePrice: r.sourcePrice }));

  return {
    summary: session.aiSummary ?? "",
    comparison: {
      matched,
      unmatched,
      kpis: {
        matchedCount: matched.length,
        totalCount: rows.length,
        cheaperCount,
        expensiveCount,
        parityCount,
        avgDeltaPercent: deltaCount > 0 ? parseFloat((deltaSum / deltaCount).toFixed(2)) : 0,
      },
    },
  };
}
