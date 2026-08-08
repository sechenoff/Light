import fs from "fs";
import { tmpFile } from "../lib/paths";
import { buildDryRunReport } from "../reports/dryRunReport";
import { ChatEntry, MatchPlanRow, SlangCandidate, ClientMergePair } from "../types";

function readJsonl<T>(name: string): T[] {
  return fs.readFileSync(tmpFile(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Minimal CSV reader that handles fields wrapped in double quotes
function readCsvRows(name: string): string[][] {
  const text = fs.readFileSync(tmpFile(name), "utf8");
  const out: string[][] = [];
  const lines = text.split("\n").filter(Boolean).slice(1);
  for (const line of lines) {
    const row: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === "," && !inQ) {
        row.push(cur); cur = "";
      } else {
        cur += ch;
      }
    }
    row.push(cur);
    out.push(row);
  }
  return out;
}

export async function runDryRun(batchId: string): Promise<void> {
  const entries = readJsonl<ChatEntry>("parsed-chat.jsonl");
  const plan = readJsonl<MatchPlanRow>("match-plan.jsonl");
  const mergesCsv = readCsvRows("client-merges.csv");
  const merges: ClientMergePair[] = mergesCsv.map((row) => ({
    auto: row[0] === "true",
    fromName: row[1],
    fromId: row[2],
    toName: row[3],
    toId: row[4],
    distance: parseInt(row[5], 10),
  }));
  const slangCsv = readCsvRows("slang-candidates.csv");
  const slang: SlangCandidate[] = slangCsv.map((row) => ({
    decision: row[0] as "AUTO" | "REVIEW",
    confidence: parseFloat(row[1]),
    supportCount: parseInt(row[2], 10),
    phraseOriginal: row[3],
    phraseNormalized: row[4],
    equipmentId: row[5],
    equipmentName: row[6],
    sourceMsgIds: row[7].split(";").map((n) => parseInt(n, 10)),
  }));
  const bugfix = JSON.parse(fs.readFileSync(tmpFile("slang-bugfix.log"), "utf8"));

  const report = buildDryRunReport({ entries, plan, merges, slang, bugfix, batchId });
  fs.writeFileSync(tmpFile("report.md"), report);
  console.log(`[dry-run] report → tmp/reconcile/report.md (${report.length} chars)`);
}
