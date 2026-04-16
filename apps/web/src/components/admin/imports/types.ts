export interface ImportSession {
  id: string;
  type: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT";
  status: string;
  competitorName: string | null;
  fileName: string;
  fileSize: number;
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  acceptedCount: number;
  rejectedCount: number;
  appliedCount: number;
  aiSummary: string | null;
  createdAt: string;
}

export interface ImportRow {
  id: string;
  sourceName: string;
  sourceCategory: string | null;
  sourcePrice: string | null;
  sourceQty: number | null;
  equipmentId: string | null;
  equipmentName: string | null;
  equipmentCategory: string | null;
  oldPrice: string | null;
  oldQty: number | null;
  priceDelta: string | null;
  matchMethod: string | null;
  matchSource: string | null;
  matchConfidence: number | null;
  action: string;
  status: string;
  aiDescription: string | null;
}

export interface ChangeGroup {
  type: "PRICE_CHANGE" | "QTY_CHANGE" | "NEW_ITEM" | "REMOVED_ITEM";
  count: number;
  rows: ImportRow[];
}

export interface ComparisonRow {
  id: string;
  sourceName: string;
  sourcePrice: string | null;
  equipmentId: string;
  equipmentName: string;
  equipmentCategory: string;
  ourPrice: string;
  competitorPrice: string;
  deltaPercent: number;
  matchSource: string | null;
  matchConfidence: number | null;
}

export interface UnmatchedRow {
  id: string;
  sourceName: string;
  sourcePrice: string | null;
}

export interface ComparisonKpis {
  matchedCount: number;
  totalCount: number;
  cheaperCount: number;
  expensiveCount: number;
  parityCount: number;
  avgDeltaPercent: number;
}

export interface AnalyzeResultOwn {
  summary: string;
  groups: ChangeGroup[];
  noChangeCount: number;
}

export interface AnalyzeResultCompetitor {
  summary: string;
  comparison: {
    matched: ComparisonRow[];
    unmatched: UnmatchedRow[];
    kpis: ComparisonKpis;
  };
}

export type DeltaDirection = "cheaper" | "expensive" | "parity";

export interface EquipmentSearchResult {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  rentalRatePerShift: string;
}
