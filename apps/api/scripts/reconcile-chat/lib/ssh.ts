import { spawnSync } from "child_process";

const SSH_HOST = "root@195.63.128.245";
const SSH_KEY = process.env.HOME + "/.ssh/id_ed25519_gaffercrm";
const SSH_BASE_ARGS = ["-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=no"];

export function sshExec(cmd: string): string {
  const res = spawnSync("ssh", [...SSH_BASE_ARGS, SSH_HOST, cmd], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`ssh failed (exit=${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

export function scpDown(remotePath: string, localPath: string): void {
  const res = spawnSync("scp", [...SSH_BASE_ARGS, `${SSH_HOST}:${remotePath}`, localPath], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`scp down failed: ${remotePath} → ${localPath}`);
}

export function scpUp(localPath: string, remotePath: string): void {
  const res = spawnSync("scp", [...SSH_BASE_ARGS, localPath, `${SSH_HOST}:${remotePath}`], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`scp up failed: ${localPath} → ${remotePath}`);
}
