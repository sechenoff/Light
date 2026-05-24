#!/usr/bin/env tsx

const PHASES = [
  "prepare", "parse", "match", "dry-run", "apply",
  "apply-slang-manual", "apply-update-overdue", "rollback",
] as const;
type Phase = (typeof PHASES)[number];

interface Argv {
  phase: Phase;
  confirm: boolean;
  batchId?: string;
  workingCopy?: string;
}

function parseArgv(argv: string[]): Argv {
  const args: Partial<Argv> = { confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phase") args.phase = argv[++i] as Phase;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--batch-id") args.batchId = argv[++i];
    else if (a === "--working-copy") args.workingCopy = argv[++i];
  }
  if (!args.phase || !PHASES.includes(args.phase)) {
    console.error(`Usage: tsx reconcile-chat/index.ts --phase <${PHASES.join("|")}> [--confirm] [--batch-id <id>] [--working-copy <path>]`);
    process.exit(1);
  }
  return args as Argv;
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  console.log(`[reconcile] phase=${argv.phase} confirm=${argv.confirm}`);
  console.error("phases not implemented yet");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
