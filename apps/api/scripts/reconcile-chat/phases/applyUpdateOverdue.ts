import fs from "fs";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { writeReconcileAudit } from "../audit/writers";
import { pushWorkingCopy } from "../db/push";

const APPROVED_FILE = "report-update-candidates-approved.csv";

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

/** Approved CSV format: `bookingId,newTotalRub` (one per line). */
export async function runApplyUpdateOverdue(batchId: string, confirm: boolean, skipPush: boolean): Promise<void> {
  if (!confirm) {
    console.error("[apply-update-overdue] refused: --confirm required");
    process.exit(2);
  }
  const file = tmpFile(APPROVED_FILE);
  if (!fs.existsSync(file)) {
    console.error(`[apply-update-overdue] expected ${file}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(1);
  const dbPath = getWorkingCopy();
  let updated = 0;

  await withDb(dbPath, async (prisma) => {
    for (const line of lines) {
      const [bookingId, newTotalStr] = line.split(",");
      const newTotal = parseFloat(newTotalStr);
      if (!bookingId || isNaN(newTotal)) continue;
      const before = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!before || before.paymentStatus === "PAID" || before.paymentStatus === "OVERPAID") {
        console.warn(`[apply-update-overdue] skip ${bookingId}: PAID/OVERPAID or missing`);
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: bookingId },
          data: { finalAmount: newTotal, totalEstimateAmount: newTotal },
        });
        await writeReconcileAudit(tx, {
          action: "BOOKING_RECONCILE_UPDATE",
          entityType: "Booking",
          entityId: bookingId,
          metadata: { batchId },
          before: { finalAmount: parseFloat(before.finalAmount.toString()) },
          after: { finalAmount: newTotal },
        });
      });
      updated += 1;
    }
  });

  console.log(`[apply-update-overdue] updated=${updated}`);
  if (!skipPush) {
    const push = pushWorkingCopy(dbPath);
    console.log(`[apply-update-overdue] push complete: ${JSON.stringify(push.rowCounts)}`);
  }
}
