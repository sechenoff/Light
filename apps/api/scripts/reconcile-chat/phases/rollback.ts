import fs from "fs";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

export async function runRollback(batchId: string, confirm: boolean): Promise<void> {
  if (!confirm) {
    console.error("[rollback] refused: --confirm required");
    process.exit(2);
  }
  const dbPath = getWorkingCopy();
  let deletedBookings = 0;
  let deletedAliases = 0;

  await withDb(dbPath, async (prisma) => {
    const allEntries = await prisma.auditEntry.findMany({
      where: { OR: [{ action: { startsWith: "BOOKING_RECONCILE" } }, { action: "SLANG_RECONCILE_INSERT" }] },
    });
    const targetBookingIds: string[] = [];
    const targetAliasIds: string[] = [];
    for (const e of allEntries) {
      const after = e.after ? JSON.parse(e.after) : null;
      const meta = after?._meta;
      if (meta?.batchId !== batchId) continue;
      if (e.entityType === "Booking" && e.action === "BOOKING_RECONCILE_INSERT") {
        targetBookingIds.push(e.entityId);
      } else if (e.entityType === "SlangAlias" && e.action === "SLANG_RECONCILE_INSERT") {
        // Skip aliases that merged into existing — deletion would remove a pre-existing alias
        if (meta?.mergedExisting) continue;
        targetAliasIds.push(e.entityId);
      }
    }
    if (targetBookingIds.length > 0) {
      deletedBookings = (await prisma.booking.deleteMany({ where: { id: { in: targetBookingIds } } })).count;
    }
    if (targetAliasIds.length > 0) {
      deletedAliases = (await prisma.slangAlias.deleteMany({ where: { id: { in: targetAliasIds } } })).count;
    }
  });

  console.log(`[rollback] deletedBookings=${deletedBookings} deletedAliases=${deletedAliases}`);
  console.warn("[rollback] CLIENT_MERGE actions are not reversible — restore from snapshot if needed");
}
