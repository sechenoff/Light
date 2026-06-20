import path from "path";
import fs from "fs";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

export const PATHS = {
  repoRoot: REPO_ROOT,
  tmpDir: path.join(REPO_ROOT, "tmp/reconcile"),
  backupsDir: path.join(REPO_ROOT, "backups"),
  chatExport: "/Users/sechenov/Documents/Telegram/Kateyak/ChatExport_2026-05-24",
} as const;

export function ensureDirs(): void {
  fs.mkdirSync(PATHS.tmpDir, { recursive: true });
  fs.mkdirSync(PATHS.backupsDir, { recursive: true });
}

export function tmpFile(name: string): string {
  return path.join(PATHS.tmpDir, name);
}

export function snapshotPath(iso: string): string {
  return path.join(PATHS.backupsDir, `prod-snapshot-${iso}.db`);
}

export function workingCopyPath(iso: string): string {
  return path.join(PATHS.backupsDir, `working-copy-${iso}.db`);
}
