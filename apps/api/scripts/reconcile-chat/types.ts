export type ChatEntryKind = "PAIR" | "XLSX_ONLY" | "REQUEST_ONLY" | "NON_ESTIMATE";

export interface ParsedItem {
  phrase: string;
  qty: number;
  equipmentId?: string;
  customName?: string;
  unitPrice?: number;
  lineSum?: number;
}

export interface ChatEntry {
  id: string;
  kind: ChatEntryKind;
  gafferName: string;
  shootDate: string;
  totalRub: number;
  projectName: string | null;
  pasteItems: ParsedItem[];
  xlsxItems: ParsedItem[];
  sourceMsgId: number;
  sourceXlsxPath: string | null;
  sourcePasteMsgId: number | null;
}

export type MatchAction =
  | "INSERT"
  | "SKIP_PROTECTED"
  | "SKIP_NEEDS_UPDATE_REVIEW"
  | "SKIP_DUP"
  | "CONFLICT_NEEDS_REVIEW";

export interface MatchPlanRow {
  entryId: string;
  action: MatchAction;
  candidateBookingIds: string[];
  canonicalClientId: string | null;
  reason: string;
}

export interface SlangCandidate {
  phraseOriginal: string;
  phraseNormalized: string;
  equipmentId: string;
  equipmentName: string;
  confidence: number;
  supportCount: number;
  decision: "AUTO" | "REVIEW";
  sourceMsgIds: number[];
}

export interface ClientMergePair {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  distance: number;
  auto: boolean;
}

export const KNOWN_SENDERS = [
  "Vitaly Sechenov",
  "Андрей Свет Водитель",
  "Петя Куб",
  "Старость",
  "Гена Белых",
  "Вова Митрофанов Светик",
  "Артёмка Иуда",
  "Захар Радомский Гаффер",
  "Джони Свет",
  "Владимир",
] as const;

export const GAFFER_SENDERS = KNOWN_SENDERS.filter(
  (s) => s !== "Vitaly Sechenov" && s !== "Андрей Свет Водитель"
);

export const SYSTEM_USER_ID = "system-reconcile";
