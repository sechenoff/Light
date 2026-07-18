import fs from "fs";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { writeReconcileAudit } from "../audit/writers";
import { pushWorkingCopy } from "../db/push";

const APPROVED_FILE = "slang-approved-manual.csv";

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

// Parse CSV row (handles quoted fields, "" escape)
function parseRow(line: string): string[] {
  const row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      row.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  row.push(cur);
  return row;
}

export async function runApplySlangManual(batchId: string, confirm: boolean, skipPush: boolean): Promise<void> {
  if (!confirm) {
    console.error("[apply-slang-manual] refused: --confirm required");
    process.exit(2);
  }
  const file = tmpFile(APPROVED_FILE);
  if (!fs.existsSync(file)) {
    console.error(`[apply-slang-manual] expected ${file}`);
    console.error("Copy slang-review-pile.csv → slang-approved-manual.csv, prune unwanted rows, then re-run.");
    process.exit(1);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(1);
  const dbPath = getWorkingCopy();
  let added = 0;
  let merged = 0;

  await withDb(dbPath, async (prisma) => {
    for (const line of lines) {
      const row = parseRow(line);
      const phraseOriginal = row[3];
      const phraseNormalized = row[4];
      const equipmentId = row[5];
      if (!phraseOriginal || !phraseNormalized || !equipmentId) continue;

      await prisma.$transaction(async (tx) => {
        const existing = await tx.slangAlias.findUnique({
          where: { phraseNormalized_equipmentId: { phraseNormalized, equipmentId } },
        });
        let aliasId: string;
        if (existing) {
          const upd = await tx.slangAlias.update({
            where: { id: existing.id },
            data: { source: "MANUAL_ADMIN", confidence: 1.0, lastUsedAt: new Date() },
          });
          aliasId = upd.id;
          merged += 1;
        } else {
          const created = await tx.slangAlias.create({
            data: { phraseOriginal, phraseNormalized, equipmentId, source: "MANUAL_ADMIN", confidence: 1.0, usageCount: 1 },
          });
          aliasId = created.id;
          added += 1;
        }
        await writeReconcileAudit(tx, {
          action: "SLANG_RECONCILE_INSERT",
          entityType: "SlangAlias",
          entityId: aliasId,
          metadata: { batchId, source: "MANUAL_ADMIN" },
        });
      });
    }
  });

  console.log(`[apply-slang-manual] added=${added} merged=${merged}`);
  if (!skipPush) {
    const push = pushWorkingCopy(dbPath);
    console.log(`[apply-slang-manual] push complete: ${JSON.stringify(push.rowCounts)}`);
  }
}
