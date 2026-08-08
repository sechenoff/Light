import fs from "fs";
import { sshExec, scpDown } from "../lib/ssh";
import { snapshotPath, workingCopyPath } from "../lib/paths";

const REMOTE_DB = "/opt/light-rental-system/apps/api/prisma/prod.db";
const REMOTE_TMP = "/tmp/reconcile-snapshot.db";

export interface SnapshotResult {
  iso: string;
  snapshot: string;
  workingCopy: string;
}

export function takeSnapshot(): SnapshotResult {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshot = snapshotPath(iso);
  const workingCopy = workingCopyPath(iso);

  // Use sqlite3 .backup for a consistent copy even while API is running (WAL-safe)
  sshExec(`sqlite3 ${REMOTE_DB} ".backup ${REMOTE_TMP}"`);
  scpDown(REMOTE_TMP, snapshot);
  sshExec(`rm -f ${REMOTE_TMP}`);

  fs.copyFileSync(snapshot, workingCopy);
  const sz = fs.statSync(snapshot).size;
  console.log(`[snapshot] saved ${sz} bytes → ${snapshot}`);
  console.log(`[snapshot] working copy → ${workingCopy}`);
  return { iso, snapshot, workingCopy };
}
