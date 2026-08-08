import { ChatEntry } from "../types";

export function buildParsedChatStats(entries: ChatEntry[]): string {
  const byKind: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  const byGaffer: Record<string, number> = {};
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const month = e.shootDate.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + 1;
    byGaffer[e.gafferName] = (byGaffer[e.gafferName] ?? 0) + 1;
  }
  const sortedMonths = Object.keys(byMonth).sort();
  const sortedGaffers = Object.entries(byGaffer).sort((a, b) => b[1] - a[1]);

  const lines: string[] = [];
  lines.push("# Parsed chat stats");
  lines.push("\n## By kind\n");
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  lines.push("\n## By month\n");
  for (const m of sortedMonths) lines.push(`- ${m}: ${byMonth[m]}`);
  lines.push("\n## By gaffer\n");
  for (const [g, v] of sortedGaffers) lines.push(`- ${g}: ${v}`);
  lines.push(`\n## Total: ${entries.length}`);
  return lines.join("\n");
}
