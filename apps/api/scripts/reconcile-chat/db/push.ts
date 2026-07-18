import fs from "fs";
import { sshExec, scpUp } from "../lib/ssh";

const REMOTE_DB = "/opt/light-rental-system/apps/api/prisma/prod.db";

export interface PushResult {
  preReconcileBackupPath: string;
  rowCounts: { Booking: number; SlangAlias: number; Client: number; AuditEntry: number };
}

export function pushWorkingCopy(workingCopy: string): PushResult {
  if (!fs.existsSync(workingCopy)) throw new Error(`working copy not found: ${workingCopy}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preBackup = `/opt/light-rental-system/apps/api/prisma/prod-pre-reconcile-${stamp}.db`;

  sshExec("pm2 stop api");
  try {
    sshExec(`cp ${REMOTE_DB} ${preBackup}`);
    scpUp(workingCopy, REMOTE_DB);

    const counts = sshExec(
      `sqlite3 ${REMOTE_DB} "SELECT (SELECT count(*) FROM Booking),(SELECT count(*) FROM SlangAlias),(SELECT count(*) FROM Client),(SELECT count(*) FROM AuditEntry)"`
    )
      .trim()
      .split("|")
      .map((n) => parseInt(n, 10));

    return {
      preReconcileBackupPath: preBackup,
      rowCounts: { Booking: counts[0], SlangAlias: counts[1], Client: counts[2], AuditEntry: counts[3] },
    };
  } finally {
    sshExec("pm2 start api");
  }
}
