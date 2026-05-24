import { ChatEntry, MatchPlanRow, SlangCandidate, ClientMergePair } from "../types";

export interface ReportInputs {
  entries: ChatEntry[];
  plan: MatchPlanRow[];
  merges: ClientMergePair[];
  slang: SlangCandidate[];
  bugfix: { deleted: number; merged: number };
  batchId: string;
}

export function buildDryRunReport(input: ReportInputs): string {
  const entriesById = new Map(input.entries.map((e) => [e.id, e] as const));
  const byAction: Record<string, MatchPlanRow[]> = {};
  for (const r of input.plan) {
    (byAction[r.action] = byAction[r.action] ?? []).push(r);
  }
  const slangByDecision = { AUTO: 0, REVIEW: 0 };
  for (const s of input.slang) slangByDecision[s.decision] += 1;

  const lines: string[] = [];
  lines.push(`# Reconcile Report — batch ${input.batchId}\n`);
  lines.push("## Summary\n");
  for (const [a, rows] of Object.entries(byAction)) {
    lines.push(`- **${a}**: ${rows.length}`);
  }
  lines.push(`\n- Client auto-merges: ${input.merges.filter((m) => m.auto).length}`);
  lines.push(`- Client suggested-merges (manual): ${input.merges.filter((m) => !m.auto).length}`);
  lines.push(`- Slang AUTO additions: ${slangByDecision.AUTO}`);
  lines.push(`- Slang REVIEW pile: ${slangByDecision.REVIEW}`);
  lines.push(`- Slang bugfix: deleted=${input.bugfix.deleted}, merged=${input.bugfix.merged}\n`);

  const autoMerges = input.merges.filter((p) => p.auto);
  if (autoMerges.length > 0) {
    lines.push("## Client auto-merges\n");
    lines.push("| from → to | distance |");
    lines.push("|---|---|");
    for (const m of autoMerges) {
      lines.push(`| ${m.fromName} → ${m.toName} | ${m.distance} |`);
    }
    lines.push("");
  }

  const suggestedMerges = input.merges.filter((p) => !p.auto);
  if (suggestedMerges.length > 0) {
    lines.push("## Client merges needing your review\n");
    lines.push("| candidate A | candidate B | distance |");
    lines.push("|---|---|---|");
    for (const m of suggestedMerges) {
      lines.push(`| ${m.fromName} | ${m.toName} | ${m.distance} |`);
    }
    lines.push("");
  }

  const inserts = byAction.INSERT ?? [];
  if (inserts.length > 0) {
    lines.push(`## INSERT preview (showing first 30 of ${inserts.length})\n`);
    lines.push("| entry | date | gaffer | total ₽ | paste/xlsx items | source |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of inserts.slice(0, 30)) {
      const e = entriesById.get(r.entryId)!;
      lines.push(`| ${e.id} | ${e.shootDate} | ${e.gafferName} | ${e.totalRub} | ${e.pasteItems.length}/${e.xlsxItems.length} | ${e.kind} |`);
    }
    lines.push("");
  }

  const conflicts = byAction.CONFLICT_NEEDS_REVIEW ?? [];
  if (conflicts.length > 0) {
    lines.push("## CONFLICT_NEEDS_REVIEW\n");
    lines.push("| entry | gaffer | date | total | candidates |");
    lines.push("|---|---|---|---|---|");
    for (const r of conflicts) {
      const e = entriesById.get(r.entryId)!;
      lines.push(`| ${e.id} | ${e.gafferName} | ${e.shootDate} | ${e.totalRub} | ${r.candidateBookingIds.join(", ")} |`);
    }
    lines.push("");
  }

  const topSlang = input.slang
    .filter((s) => s.decision === "AUTO")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20);
  if (topSlang.length > 0) {
    lines.push("## Slang AUTO top 20 (will INSERT into SlangAlias)\n");
    lines.push("| phrase | → equipment | confidence | support |");
    lines.push("|---|---|---|---|");
    for (const s of topSlang) {
      lines.push(`| ${s.phraseOriginal} | ${s.equipmentName} | ${s.confidence.toFixed(2)} | ${s.supportCount} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
