import fs from "fs";
import { ensureDirs, tmpFile } from "../lib/paths";
import { takeSnapshot } from "../db/snapshot";
import { ensureSystemReconcileUser } from "../db/seedSystemUser";
import { fixSlangQtyMarker } from "../slang/bugfix";
import { withDb } from "../db/prisma";

export interface PrepareOutput {
  iso: string;
  snapshot: string;
  workingCopy: string;
  bugfix: { deleted: number; merged: number };
}

export async function runPrepare(): Promise<PrepareOutput> {
  ensureDirs();
  const snap = takeSnapshot();
  const bugfix = await withDb(snap.workingCopy, async (prisma) => {
    await ensureSystemReconcileUser(prisma);
    return await fixSlangQtyMarker(prisma);
  });

  fs.writeFileSync(tmpFile("slang-bugfix.log"), JSON.stringify(bugfix, null, 2));
  fs.writeFileSync(tmpFile("current-working-copy.txt"), snap.workingCopy);

  console.log(`[prepare] iso=${snap.iso}`);
  console.log(`[prepare] snapshot=${snap.snapshot}`);
  console.log(`[prepare] working-copy=${snap.workingCopy}`);
  console.log(`[prepare] bugfix: deleted=${bugfix.deleted} merged=${bugfix.merged}`);

  return { ...snap, bugfix: { deleted: bugfix.deleted, merged: bugfix.merged } };
}
