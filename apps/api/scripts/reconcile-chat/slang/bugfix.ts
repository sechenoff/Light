import type { PrismaClient } from "@prisma/client";
import { phraseNoQty, normalizeRu } from "../lib/normalize";

export interface BugfixResult {
  deleted: number;
  merged: number;
  log: Array<{ id: string; phraseOriginal: string; cleanPhrase: string; action: "MERGED" | "RENAMED" }>;
}

export async function fixSlangQtyMarker(prisma: PrismaClient): Promise<BugfixResult> {
  const all = await prisma.slangAlias.findMany();
  const result: BugfixResult = { deleted: 0, merged: 0, log: [] };

  for (const row of all) {
    const clean = phraseNoQty(row.phraseOriginal);
    if (clean === row.phraseOriginal) continue;
    const cleanNorm = normalizeRu(clean);

    const existing = await prisma.slangAlias.findUnique({
      where: {
        phraseNormalized_equipmentId: {
          phraseNormalized: cleanNorm,
          equipmentId: row.equipmentId,
        },
      },
    });

    await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.slangAlias.update({
          where: { id: existing.id },
          data: {
            usageCount: existing.usageCount + row.usageCount,
            lastUsedAt: row.lastUsedAt > existing.lastUsedAt ? row.lastUsedAt : existing.lastUsedAt,
            confidence: Math.max(existing.confidence, row.confidence),
          },
        });
        await tx.slangAlias.delete({ where: { id: row.id } });
        result.merged += 1;
        result.deleted += 1;
        result.log.push({ id: row.id, phraseOriginal: row.phraseOriginal, cleanPhrase: clean, action: "MERGED" });
      } else {
        await tx.slangAlias.update({
          where: { id: row.id },
          data: { phraseOriginal: clean, phraseNormalized: cleanNorm },
        });
        result.log.push({ id: row.id, phraseOriginal: row.phraseOriginal, cleanPhrase: clean, action: "RENAMED" });
      }
    });
  }

  return result;
}
