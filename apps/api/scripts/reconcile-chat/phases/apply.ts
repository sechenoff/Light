import fs from "fs";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { pushWorkingCopy } from "../db/push";
import { writeReconcileAudit } from "../audit/writers";
import { ChatEntry, MatchPlanRow, SlangCandidate } from "../types";

function readJsonl<T>(name: string): T[] {
  return fs.readFileSync(tmpFile(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function readCsvRows(name: string): string[][] {
  const text = fs.readFileSync(tmpFile(name), "utf8");
  const out: string[][] = [];
  const lines = text.split("\n").filter(Boolean).slice(1);
  for (const line of lines) {
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
    out.push(row);
  }
  return out;
}

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

export interface ApplyOptions {
  batchId: string;
  confirm: boolean;
  skipPush?: boolean;
}

export async function runApply(opts: ApplyOptions): Promise<void> {
  if (!opts.confirm) {
    console.error("[apply] refused: --confirm required");
    process.exit(2);
  }

  const entries = readJsonl<ChatEntry>("parsed-chat.jsonl");
  const plan = readJsonl<MatchPlanRow>("match-plan.jsonl");
  const slangCsv = readCsvRows("slang-candidates.csv");

  const slangAuto: SlangCandidate[] = slangCsv
    .filter((row) => row[0] === "AUTO")
    .map((row) => ({
      decision: "AUTO" as const,
      confidence: parseFloat(row[1]),
      supportCount: parseInt(row[2], 10),
      phraseOriginal: row[3],
      phraseNormalized: row[4],
      equipmentId: row[5],
      equipmentName: row[6],
      sourceMsgIds: row[7].split(";").map((n) => parseInt(n, 10)),
    }));

  const entriesById = new Map(entries.map((e) => [e.id, e] as const));
  const dbPath = getWorkingCopy();
  const auditTrail: Array<{ entryId?: string; bookingId?: string; aliasId?: string; action: string }> = [];

  let createdBookings = 0;
  let failedBookings = 0;
  let createdSlang = 0;
  let mergedSlang = 0;
  let failedSlang = 0;

  await withDb(dbPath, async (prisma) => {
    // 1) INSERT bookings
    for (const row of plan.filter((p) => p.action === "INSERT")) {
      const entry = entriesById.get(row.entryId);
      if (!entry) continue;

      let clientId = row.canonicalClientId;
      if (!clientId) {
        const upserted = await prisma.client.upsert({
          where: { name: entry.gafferName },
          create: { name: entry.gafferName },
          update: {},
        });
        clientId = upserted.id;
      }

      const isDraft = entry.kind === "REQUEST_ONLY";
      const items = isDraft ? entry.pasteItems : entry.xlsxItems;

      const startDate = new Date(entry.shootDate + "T00:00:00Z");
      const endDate = new Date(startDate.getTime() + 24 * 3600 * 1000);

      try {
        await prisma.$transaction(async (tx) => {
          const booking = await tx.booking.create({
            data: {
              clientId,
              projectName: entry.projectName ?? `${entry.gafferName} ${entry.shootDate}`,
              startDate,
              endDate,
              status: isDraft ? "DRAFT" : "RETURNED",
              totalEstimateAmount: entry.totalRub,
              finalAmount: entry.totalRub,
              paymentStatus: "NOT_PAID",
              isFullyPaid: false,
              comment: `reconciled from chat msg ${entry.sourceMsgId}`,
            },
          });

          for (const it of items) {
            await tx.bookingItem.create({
              data: {
                bookingId: booking.id,
                equipmentId: it.equipmentId ?? null,
                quantity: it.qty,
                customName: it.equipmentId ? null : it.phrase,
                customCategory: it.equipmentId ? null : "Прочее",
                customUnitPrice: it.equipmentId ? null : (it.unitPrice ?? 0),
              },
            });
          }

          if (!isDraft && items.length > 0) {
            const subtotal = items.reduce((s, it) => s + (it.lineSum ?? (it.unitPrice ?? 0) * it.qty), 0);
            const discountAmount = Math.max(0, subtotal - entry.totalRub);
            const estimate = await tx.estimate.create({
              data: {
                bookingId: booking.id,
                kind: "MAIN",
                currency: "RUB",
                shifts: 1,
                subtotal,
                discountAmount,
                totalAfterDiscount: entry.totalRub,
                commentSnapshot: `reconciled from chat msg ${entry.sourceMsgId}`,
              },
            });
            for (const it of items) {
              await tx.estimateLine.create({
                data: {
                  estimateId: estimate.id,
                  equipmentId: it.equipmentId ?? null,
                  categorySnapshot: "Прочее",
                  nameSnapshot: it.phrase,
                  quantity: it.qty,
                  unitPrice: it.unitPrice ?? 0,
                  lineSum: it.lineSum ?? (it.unitPrice ?? 0) * it.qty,
                },
              });
            }
          }

          await writeReconcileAudit(tx, {
            action: "BOOKING_RECONCILE_INSERT",
            entityType: "Booking",
            entityId: booking.id,
            metadata: {
              batchId: opts.batchId,
              sourceMsgId: entry.sourceMsgId,
              xlsxFile: entry.sourceXlsxPath,
              entryId: entry.id,
              kind: entry.kind,
            },
          });

          auditTrail.push({ entryId: entry.id, bookingId: booking.id, action: "BOOKING_RECONCILE_INSERT" });
        });
        createdBookings += 1;
      } catch (e) {
        console.error(`[apply] FAILED entry=${entry.id}: ${(e as Error).message}`);
        failedBookings += 1;
      }
    }

    // 2) Insert / merge slang AUTO
    for (const s of slangAuto) {
      try {
        const existing = await prisma.slangAlias.findUnique({
          where: { phraseNormalized_equipmentId: { phraseNormalized: s.phraseNormalized, equipmentId: s.equipmentId } },
        });
        await prisma.$transaction(async (tx) => {
          let aliasId: string;
          if (existing) {
            const upd = await tx.slangAlias.update({
              where: { id: existing.id },
              data: {
                usageCount: existing.usageCount + s.supportCount,
                lastUsedAt: new Date(),
                confidence: Math.max(existing.confidence, s.confidence),
              },
            });
            aliasId = upd.id;
            mergedSlang += 1;
          } else {
            const created = await tx.slangAlias.create({
              data: {
                phraseOriginal: s.phraseOriginal,
                phraseNormalized: s.phraseNormalized,
                equipmentId: s.equipmentId,
                source: "AUTO_LEARNED",
                confidence: s.confidence,
                usageCount: s.supportCount,
              },
            });
            aliasId = created.id;
            createdSlang += 1;
          }
          await writeReconcileAudit(tx, {
            action: "SLANG_RECONCILE_INSERT",
            entityType: "SlangAlias",
            entityId: aliasId,
            metadata: {
              batchId: opts.batchId,
              confidence: s.confidence,
              supportCount: s.supportCount,
              sourceMsgIds: s.sourceMsgIds,
              mergedExisting: !!existing,
            },
          });
          auditTrail.push({ aliasId, action: "SLANG_RECONCILE_INSERT" });
        });
      } catch (e) {
        console.error(`[apply] FAILED slang ${s.phraseOriginal} → ${s.equipmentId}: ${(e as Error).message}`);
        failedSlang += 1;
      }
    }
  });

  fs.writeFileSync(tmpFile("audit-trail.jsonl"), auditTrail.map((a) => JSON.stringify(a)).join("\n"));

  const updateRows = plan.filter((p) => p.action === "SKIP_NEEDS_UPDATE_REVIEW");
  fs.writeFileSync(
    tmpFile("report-update-candidates.csv"),
    "entryId,bookingId,gaffer,date,xlsxTotal\n" +
      updateRows
        .map((r) => {
          const e = entriesById.get(r.entryId)!;
          return `${r.entryId},${r.candidateBookingIds[0]},"${e.gafferName.replace(/"/g, '""')}",${e.shootDate},${e.totalRub}`;
        })
        .join("\n")
  );

  const reviewSlang = slangCsv.filter((row) => row[0] === "REVIEW");
  fs.writeFileSync(
    tmpFile("slang-review-pile.csv"),
    "decision,confidence,supportCount,phraseOriginal,phraseNormalized,equipmentId,equipmentName,sourceMsgIds\n" +
      reviewSlang
        .map((r) => [r[0], r[1], r[2], `"${r[3].replace(/"/g, '""')}"`, `"${r[4].replace(/"/g, '""')}"`, r[5], `"${r[6].replace(/"/g, '""')}"`, `"${r[7].replace(/"/g, '""')}"`].join(","))
        .join("\n")
  );

  console.log(
    `[apply] local: createdBookings=${createdBookings} failedBookings=${failedBookings} createdSlang=${createdSlang} mergedSlang=${mergedSlang} failedSlang=${failedSlang}`
  );
  console.log(`[apply] audit-trail entries=${auditTrail.length}`);

  if (opts.skipPush) {
    console.log("[apply] --skip-push: local only, no push to prod");
    return;
  }
  console.log("[apply] pushing working-copy → prod");
  const push = pushWorkingCopy(dbPath);
  console.log(`[apply] push complete. prod row counts: ${JSON.stringify(push.rowCounts)}`);
  console.log(`[apply] pre-reconcile backup on prod: ${push.preReconcileBackupPath}`);
}
