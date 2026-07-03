/**
 * Тесты восстановления результата анализа импорт-сессии из истории
 * (клик по прошлой сессии на /admin/imports больше не ведёт в тупик).
 * Логика зеркалит серверный analyzeWithAI (services/importSession.ts).
 */
import { describe, it, expect } from "vitest";

import {
  buildOwnResultFromRows,
  buildCompetitorResultFromRows,
  type RawSessionRow,
} from "../../../../app/admin/imports/rebuild";
import type { ImportSession } from "../imports/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    id: "s1",
    type: "OWN_PRICE_UPDATE",
    status: "APPLIED",
    competitorName: null,
    fileName: "prices.xlsx",
    fileSize: 1000,
    totalRows: 4,
    matchedRows: 3,
    unmatchedRows: 1,
    acceptedCount: 2,
    rejectedCount: 0,
    appliedCount: 2,
    aiSummary: "Итоги анализа",
    createdAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function makeRow(overrides: Partial<RawSessionRow> = {}): RawSessionRow {
  return {
    id: "r1",
    sourceName: "ARRI SkyPanel S60",
    sourceCategory: "Свет",
    sourcePrice: "5000",
    sourceQty: 2,
    equipmentId: "eq1",
    oldPrice: "4500",
    oldQty: 2,
    priceDelta: "500",
    matchMethod: "exact",
    matchSource: "exact",
    matchConfidence: "0.95",
    action: "PRICE_CHANGE",
    status: "PENDING",
    aiDescription: null,
    equipment: { id: "eq1", name: "ARRI SkyPanel S60", category: "Свет" },
    ...overrides,
  };
}

// ── OWN_PRICE_UPDATE ──────────────────────────────────────────────────────────

describe("buildOwnResultFromRows", () => {
  it("группирует строки по action и считает noChangeCount", () => {
    const rows: RawSessionRow[] = [
      makeRow({ id: "r1", action: "PRICE_CHANGE" }),
      makeRow({ id: "r2", action: "PRICE_CHANGE" }),
      makeRow({ id: "r3", action: "NEW_ITEM", equipmentId: null, equipment: null }),
      makeRow({ id: "r4", action: "NO_CHANGE" }),
      makeRow({ id: "r5", action: "NO_CHANGE" }),
    ];
    const result = buildOwnResultFromRows(makeSession(), rows);

    expect(result.summary).toBe("Итоги анализа");
    expect(result.noChangeCount).toBe(2);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({ type: "PRICE_CHANGE", count: 2 });
    expect(result.groups[1]).toMatchObject({ type: "NEW_ITEM", count: 1 });
  });

  it("маппит строку в ImportRow: имя/категория из equipment, confidence → число", () => {
    const result = buildOwnResultFromRows(makeSession(), [makeRow()]);
    const row = result.groups[0].rows[0];

    expect(row.equipmentName).toBe("ARRI SkyPanel S60");
    expect(row.equipmentCategory).toBe("Свет");
    expect(row.matchConfidence).toBeCloseTo(0.95);
  });

  it("пустой aiSummary → пустая строка, группы без строк не создаются", () => {
    const result = buildOwnResultFromRows(makeSession({ aiSummary: null }), []);
    expect(result.summary).toBe("");
    expect(result.groups).toHaveLength(0);
    expect(result.noChangeCount).toBe(0);
  });
});

// ── COMPETITOR_IMPORT ─────────────────────────────────────────────────────────

describe("buildCompetitorResultFromRows", () => {
  it("делит на matched/unmatched и считает KPI как сервер (±5% паритет)", () => {
    const rows: RawSessionRow[] = [
      // мы дешевле: our=4000, comp=5000 → delta -20%
      makeRow({ id: "m1", oldPrice: "4000", sourcePrice: "5000" }),
      // мы дороже: our=6000, comp=5000 → delta +20%
      makeRow({ id: "m2", oldPrice: "6000", sourcePrice: "5000" }),
      // паритет: our=5100, comp=5000 → delta +2%
      makeRow({ id: "m3", oldPrice: "5100", sourcePrice: "5000" }),
      // не сматчено
      makeRow({ id: "u1", equipmentId: null, equipment: null }),
    ];
    const result = buildCompetitorResultFromRows(
      makeSession({ type: "COMPETITOR_IMPORT" }),
      rows
    );

    expect(result.comparison.matched).toHaveLength(3);
    expect(result.comparison.unmatched).toHaveLength(1);
    expect(result.comparison.kpis).toMatchObject({
      matchedCount: 3,
      totalCount: 4,
      cheaperCount: 1,
      expensiveCount: 1,
      parityCount: 1,
    });

    const m1 = result.comparison.matched.find((r) => r.id === "m1")!;
    expect(m1.ourPrice).toBe("4000");
    expect(m1.competitorPrice).toBe("5000");
    expect(m1.deltaPercent).toBeCloseTo(-20);
  });

  it("строки без цен не ломают KPI (delta=0, в счётчики не попадают)", () => {
    const rows: RawSessionRow[] = [
      makeRow({ id: "m1", oldPrice: null, sourcePrice: null }),
    ];
    const result = buildCompetitorResultFromRows(
      makeSession({ type: "COMPETITOR_IMPORT" }),
      rows
    );

    expect(result.comparison.matched[0].ourPrice).toBe("—");
    expect(result.comparison.matched[0].competitorPrice).toBe("—");
    expect(result.comparison.kpis.avgDeltaPercent).toBe(0);
    expect(result.comparison.kpis.cheaperCount).toBe(0);
    expect(result.comparison.kpis.expensiveCount).toBe(0);
    expect(result.comparison.kpis.parityCount).toBe(0);
  });
});
