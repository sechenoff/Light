import fs from "fs";
import path from "path";
import { ensureDirs, tmpFile, PATHS } from "../lib/paths";
import { parseTelegramChat } from "../parsers/telegramChat";
import { parseXlsxEstimate } from "../parsers/xlsxEstimate";
import { buildParsedChatStats } from "../reports/parsedChatStats";
import { ChatEntry, ParsedItem } from "../types";

export interface ParseOutput {
  entries: ChatEntry[];
  xlsxFailures: Array<{ entryId: string; xlsxPath: string; error: string }>;
}

function loadXlsxItemsForEntry(entry: ChatEntry): { items: ParsedItem[]; error?: string } {
  if (!entry.sourceXlsxPath) return { items: [] };
  const filePath = path.join(PATHS.chatExport, entry.sourceXlsxPath);
  try {
    const rows = parseXlsxEstimate(filePath);
    return {
      items: rows.map((r) => ({
        phrase: r.name,
        qty: r.qty,
        unitPrice: r.unitPrice,
        lineSum: r.lineSum,
      })),
    };
  } catch (e) {
    return { items: [], error: (e as Error).message };
  }
}

export async function runParse(): Promise<ParseOutput> {
  ensureDirs();
  const jsonPath = path.join(PATHS.chatExport, "result.json");
  const entries = parseTelegramChat(jsonPath);

  const xlsxFailures: ParseOutput["xlsxFailures"] = [];
  for (const e of entries) {
    if (e.kind === "NON_ESTIMATE") continue;
    if (!e.sourceXlsxPath) continue;
    const { items, error } = loadXlsxItemsForEntry(e);
    if (error) {
      xlsxFailures.push({ entryId: e.id, xlsxPath: e.sourceXlsxPath, error });
      continue;
    }
    e.xlsxItems = items;
  }

  // Intra-chat grouping: collapse [PAIR + REQUEST_ONLY] same (gaffer, date) → drop REQUEST_ONLY
  const grouped: ChatEntry[] = [];
  const groupKey = (e: ChatEntry) => `${e.gafferName}::${e.shootDate}`;
  const byKey = new Map<string, ChatEntry[]>();
  for (const e of entries) {
    const k = groupKey(e);
    const arr = byKey.get(k) ?? [];
    arr.push(e);
    byKey.set(k, arr);
  }
  for (const arr of byKey.values()) {
    const hasPair = arr.some((e) => e.kind === "PAIR" || e.kind === "XLSX_ONLY");
    for (const e of arr) {
      if (hasPair && e.kind === "REQUEST_ONLY") continue;
      grouped.push(e);
    }
  }

  fs.writeFileSync(tmpFile("parsed-chat.jsonl"), grouped.map((e) => JSON.stringify(e)).join("\n"));
  fs.writeFileSync(tmpFile("parsed-chat-stats.md"), buildParsedChatStats(grouped));
  if (xlsxFailures.length > 0) {
    fs.writeFileSync(tmpFile("xlsx-parse-failures.json"), JSON.stringify(xlsxFailures, null, 2));
  }

  console.log(`[parse] entries=${grouped.length}, xlsx failures=${xlsxFailures.length}`);
  return { entries: grouped, xlsxFailures };
}
