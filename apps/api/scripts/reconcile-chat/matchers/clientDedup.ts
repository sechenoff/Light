import levenshtein from "js-levenshtein";
import { ClientMergePair } from "../types";
import { normalizeClientName } from "../lib/normalize";

export interface ClientForDedup {
  id: string;
  name: string;
  bookingCount: number;
}

const AUTO_MAX_DIST = 2;
const AUTO_MAX_LEN = 8;
const SUGGEST_MAX_DIST = 4;

function isSingleToken(s: string): boolean {
  return !s.trim().includes(" ");
}

function chooseCanonical(a: ClientForDedup, b: ClientForDedup): { from: ClientForDedup; to: ClientForDedup } {
  if (a.bookingCount !== b.bookingCount) {
    return a.bookingCount > b.bookingCount ? { from: b, to: a } : { from: a, to: b };
  }
  return a.name.length >= b.name.length ? { from: b, to: a } : { from: a, to: b };
}

export function findDedupPairs(clients: ClientForDedup[]): ClientMergePair[] {
  const out: ClientMergePair[] = [];
  for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      const a = clients[i];
      const b = clients[j];
      const na = normalizeClientName(a.name);
      const nb = normalizeClientName(b.name);
      if (na === nb) continue;
      const dist = levenshtein(na, nb);
      const substringRelation = na.includes(nb) || nb.includes(na);
      // Skip if neither close enough nor in substring relation
      if (dist > SUGGEST_MAX_DIST && !substringRelation) continue;
      const bothShortSingle =
        na.length <= AUTO_MAX_LEN &&
        nb.length <= AUTO_MAX_LEN &&
        isSingleToken(na) &&
        isSingleToken(nb);
      const auto = dist <= AUTO_MAX_DIST && bothShortSingle;
      // For non-auto suggestions, require either substring relation or distance ≤ 2
      if (!auto && !substringRelation && dist > 2) continue;
      const { from, to } = chooseCanonical(a, b);
      out.push({ fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, distance: dist, auto });
    }
  }
  return out;
}
