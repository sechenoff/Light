import fs from "fs";
import path from "path";
import { ChatEntry, ChatEntryKind, GAFFER_SENDERS, KNOWN_SENDERS, ParsedItem } from "../types";
import { extractQty, phraseNoQty } from "../lib/normalize";

export const GROUP_WINDOW_HOURS = 24;
const XLSX_FILENAME_RE = /^(\d{1,2})[.,](\d{1,2})\s+(.+?)\s+(\d+)\.xlsx$/i;
const NON_ESTIMATE_KEYWORDS = ["инвентар", "комплект", "база"];

interface RawMessage {
  id: number;
  type: string;
  date: string;
  from?: string;
  text: string | Array<string | { text: string }>;
  file?: string;
}

function rawText(t: RawMessage["text"]): string {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map((x) => (typeof x === "string" ? x : x.text)).join("");
  return "";
}

function parsePasteItems(text: string): { projectName: string | null; items: ParsedItem[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { projectName: null, items: [] };
  const projectName = lines[0];
  const items = lines.slice(1).map((line) => ({
    phrase: phraseNoQty(line),
    qty: extractQty(line),
  }));
  return { projectName, items };
}

function isMultilinePaste(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length >= 2;
}

function parseXlsxFilename(fname: string): { day: number; month: number; gaffer: string; total: number } | null {
  const base = path.basename(fname);
  const m = base.match(XLSX_FILENAME_RE);
  if (!m) return null;
  return {
    day: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    gaffer: m[3].trim(),
    total: parseInt(m[4], 10),
  };
}

function inferShootDateFromMsg(msgDate: string, day?: number, month?: number): string {
  const d = new Date(msgDate);
  const year = d.getUTCFullYear();
  if (day !== undefined && month !== undefined) {
    return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  }
  return msgDate.slice(0, 10);
}

export function parseTelegramChat(jsonPath: string): ChatEntry[] {
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { messages: RawMessage[] };
  const msgs = raw.messages.filter((m) => m.type === "message" && m.from && (KNOWN_SENDERS as readonly string[]).includes(m.from));

  const entries: ChatEntry[] = [];
  const usedPasteIds = new Set<number>();

  // First pass: all xlsx messages
  for (const m of msgs) {
    if (!m.file || !m.file.toLowerCase().endsWith(".xlsx")) continue;
    const isNonEstimate = NON_ESTIMATE_KEYWORDS.some((kw) => m.file!.toLowerCase().includes(kw));
    if (isNonEstimate) {
      entries.push({
        id: `entry-${m.id}`,
        kind: "NON_ESTIMATE",
        gafferName: m.from!,
        shootDate: m.date.slice(0, 10),
        totalRub: 0,
        projectName: null,
        pasteItems: [],
        xlsxItems: [],
        sourceMsgId: m.id,
        sourceXlsxPath: m.file,
        sourcePasteMsgId: null,
      });
      continue;
    }
    const parsed = parseXlsxFilename(m.file);
    const shootDate = inferShootDateFromMsg(m.date, parsed?.day, parsed?.month);
    const gafferFromName = parsed?.gaffer ?? m.from!;
    const xlsxTs = new Date(m.date).getTime();
    let pasteMsg: RawMessage | null = null;
    for (const c of msgs) {
      if (c.id >= m.id) break;
      if (!(GAFFER_SENDERS as readonly string[]).includes(c.from!)) continue;
      if (usedPasteIds.has(c.id)) continue;
      const text = rawText(c.text);
      if (!isMultilinePaste(text)) continue;
      const cTs = new Date(c.date).getTime();
      if (xlsxTs - cTs > GROUP_WINDOW_HOURS * 3600 * 1000) continue;
      pasteMsg = c;
    }
    let kind: ChatEntryKind = "XLSX_ONLY";
    let projectName: string | null = null;
    let pasteItems: ParsedItem[] = [];
    let sourcePasteMsgId: number | null = null;
    if (pasteMsg) {
      kind = "PAIR";
      usedPasteIds.add(pasteMsg.id);
      const parsedPaste = parsePasteItems(rawText(pasteMsg.text));
      projectName = parsedPaste.projectName;
      pasteItems = parsedPaste.items;
      sourcePasteMsgId = pasteMsg.id;
    }
    entries.push({
      id: `entry-${m.id}`,
      kind,
      gafferName: pasteMsg?.from ?? gafferFromName,
      shootDate,
      totalRub: parsed?.total ?? 0,
      projectName,
      pasteItems,
      xlsxItems: [],
      sourceMsgId: m.id,
      sourceXlsxPath: m.file,
      sourcePasteMsgId,
    });
  }

  // Second pass: REQUEST_ONLY
  for (const m of msgs) {
    if (m.file) continue;
    if (!(GAFFER_SENDERS as readonly string[]).includes(m.from!)) continue;
    if (usedPasteIds.has(m.id)) continue;
    const text = rawText(m.text);
    if (!isMultilinePaste(text)) continue;
    const parsed = parsePasteItems(text);
    entries.push({
      id: `entry-${m.id}`,
      kind: "REQUEST_ONLY",
      gafferName: m.from!,
      shootDate: m.date.slice(0, 10),
      totalRub: 0,
      projectName: parsed.projectName,
      pasteItems: parsed.items,
      xlsxItems: [],
      sourceMsgId: m.id,
      sourceXlsxPath: null,
      sourcePasteMsgId: m.id,
    });
  }

  return entries;
}
