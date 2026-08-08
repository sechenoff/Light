import fs from "fs";
import stringSimilarity from "string-similarity";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { writeReconcileAudit } from "../audit/writers";
import { matchEquipmentName, EquipmentMatchInput } from "../matchers/equipmentMatcher";
import { findDedupPairs, ClientForDedup } from "../matchers/clientDedup";
import { matchBookingForEntry, BookingCandidate } from "../matchers/bookingMatcher";
import { extractSlangCandidates, ExtractInput } from "../slang/extractor";
import { normalizeRu } from "../lib/normalize";
import { ChatEntry, MatchPlanRow, SlangCandidate, ClientMergePair } from "../types";

function readParsed(): ChatEntry[] {
  const raw = fs.readFileSync(tmpFile("parsed-chat.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

function csvEsc(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export async function runMatch(): Promise<{
  plan: MatchPlanRow[];
  merges: ClientMergePair[];
  slang: SlangCandidate[];
}> {
  const entries = readParsed();
  const dbPath = getWorkingCopy();

  return await withDb(dbPath, async (prisma) => {
    // 1) Client dedup
    const clientsRaw = await prisma.client.findMany({
      include: { _count: { select: { bookings: true } } },
    });
    const clientsForDedup: ClientForDedup[] = clientsRaw.map((c) => ({
      id: c.id,
      name: c.name,
      bookingCount: c._count.bookings,
    }));
    const merges = findDedupPairs(clientsForDedup);

    for (const m of merges.filter((p) => p.auto)) {
      await prisma.$transaction(async (tx) => {
        const reassigned = await tx.booking.updateMany({
          where: { clientId: m.fromId },
          data: { clientId: m.toId },
        });
        await tx.client.delete({ where: { id: m.fromId } });
        await writeReconcileAudit(tx, {
          action: "CLIENT_MERGE",
          entityType: "Client",
          entityId: m.toId,
          metadata: {
            mergedFromId: m.fromId,
            mergedName: m.fromName,
            bookingsReassigned: reassigned.count,
          },
        });
      });
    }

    // 2) Re-load post-merge for canonical resolution
    const clientsPostMerge = await prisma.client.findMany();
    const normalizeName = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е");
    const resolveCanonical = (gafferName: string): string | null => {
      const norm = normalizeName(gafferName);
      const exact = clientsPostMerge.find((c) => normalizeName(c.name) === norm);
      if (exact) return exact.id;
      let best: { id: string; score: number } | null = null;
      for (const c of clientsPostMerge) {
        const sim = stringSimilarity.compareTwoStrings(norm, normalizeName(c.name));
        if (sim >= 0.7 && (!best || sim > best.score)) best = { id: c.id, score: sim };
      }
      return best ? best.id : null;
    };

    const bookings = await prisma.booking.findMany({ include: { client: true } });
    const dbBookings: BookingCandidate[] = bookings.map((b) => ({
      id: b.id,
      clientName: b.client.name,
      startDateMs: b.startDate.getTime(),
      finalAmount: parseFloat(b.finalAmount.toString()),
      paymentStatus: b.paymentStatus as BookingCandidate["paymentStatus"],
    }));

    const equipments = await prisma.equipment.findMany({ include: { slangAliases: true } });
    const catalog: EquipmentMatchInput[] = equipments.map((e) => ({
      id: e.id,
      name: e.name,
      importKey: e.importKey,
      aliases: e.slangAliases.map((a) => ({ phrase: a.phraseOriginal })),
    }));

    const plan: MatchPlanRow[] = [];
    const slangInputs: ExtractInput[] = [];

    for (const entry of entries) {
      if (entry.kind === "NON_ESTIMATE") {
        plan.push({
          entryId: entry.id,
          action: "SKIP_DUP",
          candidateBookingIds: [],
          canonicalClientId: null,
          reason: "non-estimate file (inventory)",
        });
        continue;
      }

      // Resolve equipmentId for each xlsx item
      for (const item of entry.xlsxItems) {
        const m = matchEquipmentName(item.phrase, catalog);
        if (m.equipmentId) item.equipmentId = m.equipmentId;
      }

      // PAIR slang extraction: fuzzy-align paste item ↔ xlsx item by name similarity.
      // xlsx is the ground-truth for equipmentId (already resolved above);
      // paste phrase is the gaffer's wording (= the slang we want to learn).
      if (entry.kind === "PAIR" && entry.pasteItems.length > 0 && entry.xlsxItems.length > 0) {
        const xlsxNorms = entry.xlsxItems.map((x) => normalizeRu(x.phrase));
        for (const paste of entry.pasteItems) {
          const pasteNorm = normalizeRu(paste.phrase);
          if (!pasteNorm) continue;
          const { ratings } = stringSimilarity.findBestMatch(pasteNorm, xlsxNorms);
          const best = ratings.reduce((a, b) => (b.rating > a.rating ? b : a), { rating: 0, target: "" });
          if (best.rating < 0.55) continue; // weak alignment — don't learn
          const idx = xlsxNorms.indexOf(best.target);
          const xlsx = entry.xlsxItems[idx];
          if (!xlsx.equipmentId) continue;
          const eqName = equipments.find((e) => e.id === xlsx.equipmentId)!.name;
          const eqNorm = normalizeRu(eqName);
          if (pasteNorm === eqNorm) continue; // not slang — paste matches equipment.name
          slangInputs.push({
            phrase: paste.phrase,
            equipmentId: xlsx.equipmentId,
            equipmentName: eqName,
            msgId: entry.sourcePasteMsgId!,
            nameSubstringMatch: eqNorm.includes(pasteNorm) || pasteNorm.includes(eqNorm),
          });
        }
      }

      const match = matchBookingForEntry(
        {
          kind: entry.kind,
          clientName: entry.gafferName,
          shootDate: entry.shootDate,
          totalRub: entry.totalRub,
        },
        dbBookings
      );
      plan.push({
        entryId: entry.id,
        action: match.action,
        candidateBookingIds: match.candidates,
        canonicalClientId: resolveCanonical(entry.gafferName),
        reason: match.reason,
      });
    }

    const slang = extractSlangCandidates(slangInputs);

    // Persist artifacts
    fs.writeFileSync(tmpFile("match-plan.jsonl"), plan.map((r) => JSON.stringify(r)).join("\n"));
    fs.writeFileSync(
      tmpFile("client-merges.csv"),
      "auto,fromName,fromId,toName,toId,distance\n" +
        merges
          .map((m) => `${m.auto},${csvEsc(m.fromName)},${m.fromId},${csvEsc(m.toName)},${m.toId},${m.distance}`)
          .join("\n")
    );
    fs.writeFileSync(
      tmpFile("slang-candidates.csv"),
      "decision,confidence,supportCount,phraseOriginal,phraseNormalized,equipmentId,equipmentName,sourceMsgIds\n" +
        slang
          .map((s) =>
            [
              s.decision,
              s.confidence.toFixed(3),
              s.supportCount,
              csvEsc(s.phraseOriginal),
              csvEsc(s.phraseNormalized),
              s.equipmentId,
              csvEsc(s.equipmentName),
              csvEsc(s.sourceMsgIds.join(";")),
            ].join(",")
          )
          .join("\n")
    );

    console.log(
      `[match] plan rows=${plan.length}, auto-merges=${merges.filter((m) => m.auto).length}, suggested-merges=${merges.filter((m) => !m.auto).length}, slang=${slang.length}`
    );
    return { plan, merges, slang };
  });
}
