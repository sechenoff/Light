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
  switch (argv.phase) {
    case "prepare": {
      const { runPrepare } = await import("./phases/prepare");
      await runPrepare();
      break;
    }
    case "parse": {
      const { runParse } = await import("./phases/parse");
      await runParse();
      break;
    }
    case "match": {
      const { runMatch } = await import("./phases/match");
      await runMatch();
      break;
    }
    case "dry-run": {
      const { runDryRun } = await import("./phases/dryRun");
      const batchId = argv.batchId ?? new Date().toISOString();
      await runDryRun(batchId);
      break;
    }
    case "apply": {
      const { runApply } = await import("./phases/apply");
      const batchId = argv.batchId ?? new Date().toISOString();
      const skipPush = process.argv.includes("--skip-push");
      await runApply({ batchId, confirm: argv.confirm, skipPush });
      break;
    }
    case "apply-slang-manual": {
      const { runApplySlangManual } = await import("./phases/applySlangManual");
      const batchId = argv.batchId ?? new Date().toISOString();
      const skipPush = process.argv.includes("--skip-push");
      await runApplySlangManual(batchId, argv.confirm, skipPush);
      break;
    }
    case "apply-update-overdue": {
      const { runApplyUpdateOverdue } = await import("./phases/applyUpdateOverdue");
      const batchId = argv.batchId ?? new Date().toISOString();
      const skipPush = process.argv.includes("--skip-push");
      await runApplyUpdateOverdue(batchId, argv.confirm, skipPush);
      break;
    }
    case "rollback": {
      const { runRollback } = await import("./phases/rollback");
      if (!argv.batchId) { console.error("--batch-id required for rollback"); process.exit(1); }
      await runRollback(argv.batchId, argv.confirm);
      break;
    }
    default:
      console.error(`phase ${argv.phase} not implemented yet`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
