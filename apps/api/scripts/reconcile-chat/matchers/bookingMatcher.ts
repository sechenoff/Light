import stringSimilarity from "string-similarity";
import { MatchAction, ChatEntryKind } from "../types";
import { normalizeClientName } from "../lib/normalize";

export interface BookingCandidate {
  id: string;
  clientName: string;
  startDateMs: number;
  finalAmount: number;
  paymentStatus: "PAID" | "OVERDUE" | "NOT_PAID" | "OVERPAID" | "PARTIAL";
}

export interface EntryForMatch {
  kind: ChatEntryKind;
  clientName: string;
  shootDate: string;
  totalRub: number;
}

export interface BookingMatchResult {
  action: MatchAction;
  candidates: string[];
  reason: string;
}

const DAY_MS = 24 * 3600 * 1000;
const DATE_TOLERANCE_DAYS = 2;
const NAME_SIM_THRESHOLD = 0.7;
const AMOUNT_TOLERANCE_PCT = 0.05;

function dateToMs(iso: string): number {
  return Date.parse(iso + "T00:00:00Z");
}

function withinAmount(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) / b <= AMOUNT_TOLERANCE_PCT;
}

export function matchBookingForEntry(entry: EntryForMatch, db: BookingCandidate[]): BookingMatchResult {
  const entryMs = dateToMs(entry.shootDate);
  const normEntry = normalizeClientName(entry.clientName);

  const dateAndClient = db.filter((b) => {
    const dateOk = Math.abs(b.startDateMs - entryMs) <= DATE_TOLERANCE_DAYS * DAY_MS;
    if (!dateOk) return false;
    const sim = stringSimilarity.compareTwoStrings(normEntry, normalizeClientName(b.clientName));
    return sim >= NAME_SIM_THRESHOLD;
  });

  if (entry.kind === "REQUEST_ONLY") {
    if (dateAndClient.length > 0) {
      return { action: "SKIP_DUP", candidates: dateAndClient.map((b) => b.id), reason: "request-only matched existing" };
    }
    return { action: "INSERT", candidates: [], reason: "request-only new" };
  }

  const withAmount = dateAndClient.filter((b) => withinAmount(b.finalAmount, entry.totalRub));

  if (withAmount.length === 0) {
    return { action: "INSERT", candidates: [], reason: "no candidate within amount tolerance" };
  }
  if (withAmount.length >= 2) {
    return {
      action: "CONFLICT_NEEDS_REVIEW",
      candidates: withAmount.map((b) => b.id),
      reason: `${withAmount.length} candidates match — manual review`,
    };
  }
  const c = withAmount[0];
  if (c.paymentStatus === "PAID" || c.paymentStatus === "OVERPAID") {
    return { action: "SKIP_PROTECTED", candidates: [c.id], reason: `payment ${c.paymentStatus}` };
  }
  return { action: "SKIP_NEEDS_UPDATE_REVIEW", candidates: [c.id], reason: `${c.paymentStatus} — defer to phase 7` };
}
