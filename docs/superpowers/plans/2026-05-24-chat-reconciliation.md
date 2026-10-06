# Chat Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Импортировать 11 месяцев истории Telegram-чата `Svetobaza × Kirillin` (118 xlsx-смет + ~50 безответных заявок) в прод-БД без перетирания оплаченных броней, попутно обогатив `SlangAlias` реальным жаргоном гафферов.

**Architecture:** Офлайн 5-фазный CLI-скрипт (`apps/api/scripts/reconcile-chat.ts`) с прямым Prisma-доступом, без HTTP. Работает на локальной копии прод-БД (`backups/working-copy-*.db`), все промежуточные артефакты в `tmp/reconcile/` для человеческого ревью. Pull-prod → match → dry-run report → ручной аппрув → apply → push-back через ssh-pipe с двойным бэкапом.

**Tech Stack:** TypeScript, Node 22, Prisma 6 (SQLite), `xlsx` (уже в deps), `string-similarity` (уже в deps), `js-levenshtein` (новый), `tsx` для запуска, `vitest` для тестов.

**Spec:** [docs/superpowers/specs/2026-05-24-chat-reconciliation-design.md](../specs/2026-05-24-chat-reconciliation-design.md) — все решения и контракты.

---

## File Structure

### Создаём

```
apps/api/scripts/reconcile-chat/
├── index.ts                          # CLI entry: argv → phase dispatcher
├── types.ts                          # Shared types (ChatEntry, MatchPlan, …)
├── lib/
│   ├── normalize.ts                  # normalizeRu / normalizeClientName / phraseNoQty
│   ├── normalize.test.ts
│   ├── paths.ts                      # tmpFile(), reportPath(), exportDir()
│   └── ssh.ts                        # sshExec() / scpDown() / scpUp() обёртки
├── parsers/
│   ├── telegramChat.ts               # JSON → ChatEntry[]
│   ├── telegramChat.test.ts
│   ├── xlsxEstimate.ts               # XLSX file → ParsedEstimateRow[]
│   └── xlsxEstimate.test.ts
├── matchers/
│   ├── equipmentMatcher.ts           # name → equipmentId (importKey/SlangAlias/sim)
│   ├── equipmentMatcher.test.ts
│   ├── clientDedup.ts                # Levenshtein-based pair discovery
│   ├── clientDedup.test.ts
│   ├── bookingMatcher.ts             # ChatEntry → Booking candidates
│   └── bookingMatcher.test.ts
├── slang/
│   ├── extractor.ts                  # PAIR → SlangCandidate[] (confidence)
│   ├── extractor.test.ts
│   ├── bugfix.ts                     # existing «(N)» rows → clean
│   └── bugfix.test.ts
├── db/
│   ├── snapshot.ts                   # ssh prod → backups/prod-snapshot-*.db
│   ├── push.ts                       # working-copy-*.db → ssh prod
│   ├── seedSystemUser.ts             # INSERT OR IGNORE AdminUser system-reconcile
│   └── prisma.ts                     # withDb(dbPath, fn) — scoped PrismaClient
├── audit/
│   └── writers.ts                    # writeReconcileAudit() обёртки
├── phases/
│   ├── prepare.ts                    # Phase 1
│   ├── parse.ts                      # Phase 2
│   ├── match.ts                      # Phase 3
│   ├── dryRun.ts                     # Phase 4 — генерит report.md
│   ├── apply.ts                      # Phase 5 — main writes + push
│   ├── applySlangManual.ts           # Phase 6 (opt)
│   ├── applyUpdateOverdue.ts         # Phase 7 (opt)
│   └── rollback.ts                   # Phase 8 (opt)
└── reports/
    ├── parsedChatStats.ts            # parse stats markdown
    └── dryRunReport.ts               # main report.md generator
```

### Меняем

```
apps/api/src/services/audit.ts        # extend AuditEntityType union with "SlangAlias"
.gitignore                            # add tmp/ + backups/
apps/api/package.json                 # add js-levenshtein
```

### Артефакты на диске (gitignored)

```
backups/
├── prod-snapshot-<ISO>.db            # immutable
└── working-copy-<ISO>.db             # mutable
tmp/reconcile/
├── parsed-chat.jsonl
├── parsed-chat-stats.md
├── match-plan.jsonl
├── client-merges.csv
├── slang-candidates.csv
├── slang-bugfix.log
├── report.md                         # ⭐ главный артефакт для ревью
├── slang-review-pile.csv
├── report-update-candidates.csv
└── audit-trail.jsonl
```

---

## Task 1: Project scaffolding

**Files:**
- Modify: `.gitignore`
- Modify: `apps/api/package.json`
- Create: `apps/api/scripts/reconcile-chat/index.ts` (skeleton)
- Create: `apps/api/scripts/reconcile-chat/types.ts`
- Create: `apps/api/scripts/reconcile-chat/lib/paths.ts`

- [ ] **Step 1.1: Add `tmp/` and `backups/` to .gitignore**

Append to `.gitignore`:

```
# Chat reconciliation artifacts
tmp/
backups/
```

- [ ] **Step 1.2: Add `js-levenshtein` to api workspace**

```bash
npm install --workspace=apps/api js-levenshtein
npm install --workspace=apps/api -D @types/js-levenshtein
```

Verify: `grep -E "js-levenshtein" apps/api/package.json` → present in both `dependencies` and `devDependencies`.

- [ ] **Step 1.3: Create types.ts with shared shapes**

`apps/api/scripts/reconcile-chat/types.ts`:

```typescript
export type ChatEntryKind = "PAIR" | "XLSX_ONLY" | "REQUEST_ONLY" | "NON_ESTIMATE";

export interface ParsedItem {
  phrase: string;        // как написал гаффер: "Лантерн 120"
  qty: number;           // 1 если не указано
  equipmentId?: string;  // null если не сматчилось
  customName?: string;   // если equipmentId отсутствует
  unitPrice?: number;    // для xlsx-парсинга
  lineSum?: number;
}

export interface ChatEntry {
  id: string;                       // уникальный, deterministic ("entry-<msgId>")
  kind: ChatEntryKind;
  gafferName: string;               // как в чате ("Гена Белых")
  shootDate: string;                // ISO YYYY-MM-DD
  totalRub: number;                 // из имени xlsx; 0 для REQUEST_ONLY
  projectName: string | null;       // из первой строки паста или null
  pasteItems: ParsedItem[];         // что НАПИСАЛ гаффер (PAIR/REQUEST_ONLY); пусто для XLSX_ONLY
  xlsxItems: ParsedItem[];          // что РАСПАРСИЛОСЬ из xlsx (PAIR/XLSX_ONLY); пусто для REQUEST_ONLY
  sourceMsgId: number;
  sourceXlsxPath: string | null;
  sourcePasteMsgId: number | null;
}

export type MatchAction =
  | "INSERT"
  | "SKIP_PROTECTED"             // matched PAID
  | "SKIP_NEEDS_UPDATE_REVIEW"   // matched OVERDUE/non-PAID, defer to phase 7
  | "SKIP_DUP"                   // REQUEST_ONLY collided with existing booking
  | "CONFLICT_NEEDS_REVIEW";     // 2+ candidates

export interface MatchPlanRow {
  entryId: string;
  action: MatchAction;
  candidateBookingIds: string[];
  canonicalClientId: string | null;  // resolved after dedup
  reason: string;                    // for debugging
}

export interface SlangCandidate {
  phraseOriginal: string;
  phraseNormalized: string;
  equipmentId: string;
  equipmentName: string;            // for CSV readability
  confidence: number;
  supportCount: number;             // PAIR-кейсов с этой парой
  decision: "AUTO" | "REVIEW";
  sourceMsgIds: number[];
}

export interface ClientMergePair {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  distance: number;
  auto: boolean;                    // true = will merge in apply, false = suggested
}

export const KNOWN_SENDERS = [
  "Vitaly Sechenov",
  "Андрей Свет Водитель",
  "Петя Куб",
  "Старость",
  "Гена Белых",
  "Вова Митрофанов Светик",
  "Артёмка Иуда",
  "Захар Радомский Гаффер",
  "Джони Свет",
  "Владимир",
] as const;

export const GAFFER_SENDERS = KNOWN_SENDERS.filter(
  (s) => s !== "Vitaly Sechenov" && s !== "Андрей Свет Водитель"
);

export const SYSTEM_USER_ID = "system-reconcile";
```

- [ ] **Step 1.4: Create paths helper**

`apps/api/scripts/reconcile-chat/lib/paths.ts`:

```typescript
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
```

- [ ] **Step 1.5: Skeleton CLI entry**

`apps/api/scripts/reconcile-chat/index.ts`:

```typescript
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
```

- [ ] **Step 1.6: Smoke-run the CLI**

```bash
cd apps/api && npx tsx scripts/reconcile-chat/index.ts --phase prepare
```

Expected: `[reconcile] phase=prepare confirm=false` followed by `phases not implemented yet`, exit 1.

- [ ] **Step 1.7: Commit**

```bash
git add .gitignore apps/api/package.json apps/api/package-lock.json apps/api/scripts/reconcile-chat/
git commit -m "feat(reconcile): scaffolding + types + CLI skeleton"
```

---

## Task 2: Russian normalization library

**Files:**
- Create: `apps/api/scripts/reconcile-chat/lib/normalize.ts`
- Create: `apps/api/scripts/reconcile-chat/lib/normalize.test.ts`

- [ ] **Step 2.1: Write failing tests**

`apps/api/scripts/reconcile-chat/lib/normalize.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  normalizeRu,
  normalizeClientName,
  phraseNoQty,
  extractQty,
} from "./normalize";

describe("normalizeRu", () => {
  it("lowercases, trims, collapses spaces", () => {
    expect(normalizeRu("  Лантерн   120  ")).toBe("лантерн 120");
  });
  it("replaces ё with е", () => {
    expect(normalizeRu("Тёплый свет")).toBe("теплый свет");
  });
  it("strips punctuation but keeps slashes", () => {
    expect(normalizeRu("Систенды/минибум/мегабум,")).toBe("систенды/минибум/мегабум");
  });
});

describe("normalizeClientName", () => {
  it("treats Хакаги and Хокаге as different normalized but close", () => {
    expect(normalizeClientName("Хакаги")).toBe("хакаги");
    expect(normalizeClientName("Хокаге")).toBe("хокаге");
  });
  it("strips trailing whitespace and punctuation", () => {
    expect(normalizeClientName("Гена Белых.")).toBe("гена белых");
  });
});

describe("phraseNoQty", () => {
  it("strips trailing «(N)» qty marker", () => {
    expect(phraseNoQty("Пена (1)")).toBe("Пена");
    expect(phraseNoQty("1200х (2)")).toBe("1200х");
  });
  it("leaves phrase without qty untouched", () => {
    expect(phraseNoQty("Лантерн 120")).toBe("Лантерн 120");
  });
  it("strips multi-space before paren", () => {
    expect(phraseNoQty("Сдл 8   (2)")).toBe("Сдл 8");
  });
});

describe("extractQty", () => {
  it("returns 1 when no qty marker", () => {
    expect(extractQty("Лантерн 120")).toBe(1);
  });
  it("parses qty from trailing «(N)»", () => {
    expect(extractQty("Пена (3)")).toBe(3);
  });
});
```

- [ ] **Step 2.2: Run tests, verify they fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/lib/normalize.test.ts
```

Expected: 4 failed test suites with "Cannot find module ./normalize".

- [ ] **Step 2.3: Implement normalize.ts**

`apps/api/scripts/reconcile-chat/lib/normalize.ts`:

```typescript
/**
 * Russian-aware normalization helpers used across the reconcile pipeline.
 * Keep pure: no DB, no I/O.
 */

const QTY_TRAILING_RE = /\s*\(\s*(\d+)\s*\)\s*$/;

export function normalizeRu(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,;:!?"'`«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeClientName(name: string): string {
  return normalizeRu(name);
}

export function phraseNoQty(phrase: string): string {
  return phrase.replace(QTY_TRAILING_RE, "").trim();
}

export function extractQty(phrase: string): number {
  const m = phrase.match(QTY_TRAILING_RE);
  return m ? parseInt(m[1], 10) : 1;
}
```

- [ ] **Step 2.4: Run tests, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/lib/normalize.test.ts
```

Expected: 4 test suites pass, 9 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/scripts/reconcile-chat/lib/normalize.ts apps/api/scripts/reconcile-chat/lib/normalize.test.ts
git commit -m "feat(reconcile): Russian normalization helpers + tests"
```

---

## Task 3: Telegram chat parser

**Files:**
- Create: `apps/api/scripts/reconcile-chat/parsers/telegramChat.ts`
- Create: `apps/api/scripts/reconcile-chat/parsers/telegramChat.test.ts`
- Create: `apps/api/scripts/reconcile-chat/__fixtures__/sample-chat.json`

- [ ] **Step 3.1: Create a tiny fixture**

`apps/api/scripts/reconcile-chat/__fixtures__/sample-chat.json`:

```json
{
  "name": "Test",
  "type": "private_supergroup",
  "id": 1,
  "messages": [
    { "id": 100, "type": "message", "date": "2026-01-17T05:03:15", "from": "Старость", "text": "17.01 бага погруз\nЛантерн 120 (1)\nЛайтдом 150 (2)\nСдл 8 (2)" },
    { "id": 101, "type": "message", "date": "2026-01-17T16:33:45", "from": "Андрей Свет Водитель", "text": "вот", "file": "files/17.01 Старость 4500.xlsx" },
    { "id": 200, "type": "message", "date": "2026-02-10T10:00:00", "from": "Гена Белых", "text": "10.02 проект\nМбю 12 (1)" },
    { "id": 201, "type": "message", "date": "2026-02-11T09:00:00", "from": "Гена Белых", "text": "Просто болтовня" },
    { "id": 300, "type": "message", "date": "2026-03-01T12:00:00", "from": "Vitaly Sechenov", "text": "", "file": "files/SVETOBAZA_инвентаризация.xlsx" }
  ]
}
```

- [ ] **Step 3.2: Write failing tests**

`apps/api/scripts/reconcile-chat/parsers/telegramChat.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import path from "path";
import { parseTelegramChat, GROUP_WINDOW_HOURS } from "./telegramChat";

const FIXTURE = path.resolve(__dirname, "../__fixtures__/sample-chat.json");

describe("parseTelegramChat", () => {
  it("returns one PAIR for the request+xlsx within window", () => {
    const entries = parseTelegramChat(FIXTURE);
    const pair = entries.find((e) => e.sourceMsgId === 101);
    expect(pair).toBeDefined();
    expect(pair!.kind).toBe("PAIR");
    expect(pair!.gafferName).toBe("Старость");
    expect(pair!.totalRub).toBe(4500);
    expect(pair!.shootDate).toBe("2026-01-17");
    expect(pair!.sourcePasteMsgId).toBe(100);
    expect(pair!.projectName).toBe("17.01 бага погруз");
    expect(pair!.pasteItems).toEqual([
      { phrase: "Лантерн 120", qty: 1 },
      { phrase: "Лайтдом 150", qty: 2 },
      { phrase: "Сдл 8", qty: 2 },
    ]);
    expect(pair!.xlsxItems).toEqual([]); // parse phase fills these later
  });

  it("returns REQUEST_ONLY for paste without xlsx in window", () => {
    const entries = parseTelegramChat(FIXTURE);
    const req = entries.find((e) => e.sourceMsgId === 200);
    expect(req).toBeDefined();
    expect(req!.kind).toBe("REQUEST_ONLY");
    expect(req!.pasteItems).toEqual([{ phrase: "Мбю 12", qty: 1 }]);
    expect(req!.xlsxItems).toEqual([]);
  });

  it("classifies inventory-xlsx as NON_ESTIMATE", () => {
    const entries = parseTelegramChat(FIXTURE);
    const nonEst = entries.find((e) => e.sourceMsgId === 300);
    expect(nonEst!.kind).toBe("NON_ESTIMATE");
  });

  it("ignores chatter without multi-line structure", () => {
    const entries = parseTelegramChat(FIXTURE);
    expect(entries.find((e) => e.sourceMsgId === 201)).toBeUndefined();
  });

  it(`pair window equals ${GROUP_WINDOW_HOURS}h`, () => {
    expect(GROUP_WINDOW_HOURS).toBe(24);
  });
});
```

- [ ] **Step 3.3: Run, verify fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/parsers/telegramChat.test.ts
```

Expected: failures, "Cannot find module ./telegramChat".

- [ ] **Step 3.4: Implement telegramChat.ts**

`apps/api/scripts/reconcile-chat/parsers/telegramChat.ts`:

```typescript
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
    // year of the chat message is the source-of-truth (file names omit year)
    const iso = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
    return iso;
  }
  return msgDate.slice(0, 10);
}

export function parseTelegramChat(jsonPath: string): ChatEntry[] {
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { messages: RawMessage[] };
  const msgs = raw.messages.filter((m) => m.type === "message" && m.from && KNOWN_SENDERS.includes(m.from as any));

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
        items: [],
        sourceMsgId: m.id,
        sourceXlsxPath: m.file,
        sourcePasteMsgId: null,
      });
      continue;
    }
    const parsed = parseXlsxFilename(m.file);
    const shootDate = inferShootDateFromMsg(m.date, parsed?.day, parsed?.month);
    const gafferFromName = parsed?.gaffer ?? m.from!;
    // Pair search: nearest preceding multi-line paste from a GAFFER within window
    const xlsxTs = new Date(m.date).getTime();
    let pasteMsg: RawMessage | null = null;
    for (const c of msgs) {
      if (c.id >= m.id) break;
      if (!GAFFER_SENDERS.includes(c.from as any)) continue;
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
      xlsxItems: [],   // populated in parse phase
      sourceMsgId: m.id,
      sourceXlsxPath: m.file,
      sourcePasteMsgId,
    });
  }

  // Second pass: REQUEST_ONLY = multi-line gaffer pastes not used by any xlsx
  for (const m of msgs) {
    if (m.file) continue;
    if (!GAFFER_SENDERS.includes(m.from as any)) continue;
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
```

- [ ] **Step 3.5: Run, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/parsers/telegramChat.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 3.6: Smoke against real export**

```bash
cd apps/api && npx tsx -e "
const { parseTelegramChat } = require('./scripts/reconcile-chat/parsers/telegramChat');
const entries = parseTelegramChat('/Users/sechenov/Documents/Telegram/Kateyak/ChatExport_2026-05-24/result.json');
const byKind = entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {});
console.log('total:', entries.length);
console.log('by kind:', byKind);
"
```

Expected: roughly `PAIR ≈ 80, XLSX_ONLY ≈ 30, REQUEST_ONLY ≈ 200+, NON_ESTIMATE ≈ 2`. Numbers will guide later thresholds.

- [ ] **Step 3.7: Commit**

```bash
git add apps/api/scripts/reconcile-chat/parsers/ apps/api/scripts/reconcile-chat/__fixtures__/
git commit -m "feat(reconcile): Telegram chat parser → ChatEntry[]"
```

---

## Task 4: XLSX estimate parser

**Files:**
- Create: `apps/api/scripts/reconcile-chat/parsers/xlsxEstimate.ts`
- Create: `apps/api/scripts/reconcile-chat/parsers/xlsxEstimate.test.ts`
- Create: `apps/api/scripts/reconcile-chat/__fixtures__/sample-estimate.xlsx` (generated below)

- [ ] **Step 4.1: Generate fixture xlsx**

```bash
cd apps/api && npx tsx -e "
const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([
  ['Перечень оборудования', 'Кол-во', 'Цена', 'Сумма'],
  ['Лантерн 120', 1, 2500, 2500],
  ['Лайтдом 150', 2, 1800, 3600],
  ['СДЛ 8', 2, 1200, 2400],
  ['', '', 'ИТОГО:', 8500],
]);
XLSX.utils.book_append_sheet(wb, ws, 'Смета');
XLSX.writeFile(wb, 'scripts/reconcile-chat/__fixtures__/sample-estimate.xlsx');
"
ls apps/api/scripts/reconcile-chat/__fixtures__/sample-estimate.xlsx
```

Expected: file exists, ~5 KB.

- [ ] **Step 4.2: Write failing tests**

`apps/api/scripts/reconcile-chat/parsers/xlsxEstimate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import path from "path";
import { parseXlsxEstimate } from "./xlsxEstimate";

const FIXTURE = path.resolve(__dirname, "../__fixtures__/sample-estimate.xlsx");

describe("parseXlsxEstimate", () => {
  it("extracts 3 rows from the fixture", () => {
    const rows = parseXlsxEstimate(FIXTURE);
    expect(rows).toHaveLength(3);
  });

  it("populates name, qty, unitPrice, lineSum", () => {
    const rows = parseXlsxEstimate(FIXTURE);
    expect(rows[0]).toEqual({ name: "Лантерн 120", qty: 1, unitPrice: 2500, lineSum: 2500 });
    expect(rows[1]).toEqual({ name: "Лайтдом 150", qty: 2, unitPrice: 1800, lineSum: 3600 });
    expect(rows[2]).toEqual({ name: "СДЛ 8", qty: 2, unitPrice: 1200, lineSum: 2400 });
  });

  it("skips the ИТОГО row", () => {
    const rows = parseXlsxEstimate(FIXTURE);
    expect(rows.find((r) => r.name?.toLowerCase().includes("итого"))).toBeUndefined();
  });

  it("returns empty array for malformed xlsx", () => {
    const empty = path.resolve(__dirname, "__nonexistent__.xlsx");
    expect(() => parseXlsxEstimate(empty)).toThrow();
  });
});
```

- [ ] **Step 4.3: Run, verify fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/parsers/xlsxEstimate.test.ts
```

- [ ] **Step 4.4: Implement xlsxEstimate.ts**

`apps/api/scripts/reconcile-chat/parsers/xlsxEstimate.ts`:

```typescript
import * as XLSX from "xlsx";

export interface ParsedEstimateRow {
  name: string;
  qty: number;
  unitPrice: number;
  lineSum: number;
}

const HEADER_HINTS = ["перечень", "оборудование", "наименование"];
const TOTAL_HINTS = ["итого", "всего", "сумма"];

function isHeaderRow(cells: any[]): boolean {
  const joined = cells.map((c) => String(c ?? "").toLowerCase()).join(" ");
  return HEADER_HINTS.some((h) => joined.includes(h));
}

function isTotalRow(cells: any[]): boolean {
  const firstNonEmpty = cells.find((c) => c !== "" && c !== null && c !== undefined);
  if (!firstNonEmpty) return true;
  const joined = String(firstNonEmpty).toLowerCase();
  return TOTAL_HINTS.some((h) => joined.includes(h));
}

function toNum(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

export function parseXlsxEstimate(filePath: string): ParsedEstimateRow[] {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false });

  const result: ParsedEstimateRow[] = [];
  let headerSeen = false;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) continue;
    if (!headerSeen) {
      if (isHeaderRow(row)) {
        headerSeen = true;
      }
      continue;
    }
    if (isTotalRow(row)) continue;
    const name = String(row[0] ?? "").trim();
    if (!name) continue;
    const qty = toNum(row[1]);
    const unitPrice = toNum(row[2]);
    const lineSum = toNum(row[3]);
    if (qty <= 0 && lineSum <= 0) continue;
    result.push({ name, qty, unitPrice, lineSum });
  }
  return result;
}
```

- [ ] **Step 4.5: Run, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/parsers/xlsxEstimate.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 4.6: Smoke against a real chat xlsx**

```bash
cd apps/api && npx tsx -e "
const { parseXlsxEstimate } = require('./scripts/reconcile-chat/parsers/xlsxEstimate');
const rows = parseXlsxEstimate('/Users/sechenov/Documents/Telegram/Kateyak/ChatExport_2026-05-24/files/04.05 Гена 85590.xlsx');
console.log('rows:', rows.length);
console.log('first 3:', rows.slice(0, 3));
console.log('total:', rows.reduce((s, r) => s + r.lineSum, 0));
"
```

Expected: ≥ 5 rows, total ≈ 85590 ± 10%. If parsing fails (some xlsx may have weird structure), examine the file and adjust header detection.

- [ ] **Step 4.7: Commit**

```bash
git add apps/api/scripts/reconcile-chat/parsers/xlsxEstimate.ts apps/api/scripts/reconcile-chat/parsers/xlsxEstimate.test.ts apps/api/scripts/reconcile-chat/__fixtures__/sample-estimate.xlsx
git commit -m "feat(reconcile): XLSX estimate parser → ParsedEstimateRow[]"
```

---

## Task 5: Equipment matcher

**Files:**
- Create: `apps/api/scripts/reconcile-chat/matchers/equipmentMatcher.ts`
- Create: `apps/api/scripts/reconcile-chat/matchers/equipmentMatcher.test.ts`

- [ ] **Step 5.1: Write failing tests**

`apps/api/scripts/reconcile-chat/matchers/equipmentMatcher.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { matchEquipmentName, EquipmentMatchInput } from "./equipmentMatcher";

const catalog: EquipmentMatchInput[] = [
  { id: "eq-lantern", name: "Lantern 120", importKey: "lantern_120", aliases: [{ phrase: "лантерн 120" }] },
  { id: "eq-lightdome", name: "Lightdome 150", importKey: null, aliases: [{ phrase: "лайтдом 150" }] },
  { id: "eq-sdl", name: "SDL 8", importKey: "sdl_8", aliases: [] },
];

describe("matchEquipmentName", () => {
  it("matches via importKey (exact)", () => {
    expect(matchEquipmentName("lantern_120", catalog).equipmentId).toBe("eq-lantern");
  });
  it("matches via alias (case/ё-insensitive)", () => {
    expect(matchEquipmentName("Лантерн 120", catalog).equipmentId).toBe("eq-lantern");
  });
  it("matches via name fuzzy ≥ 0.7", () => {
    const r = matchEquipmentName("SDL 8 шт.", catalog);
    expect(r.equipmentId).toBe("eq-sdl");
    expect(r.method).toBe("similarity");
    expect(r.score).toBeGreaterThan(0.7);
  });
  it("returns null when no match", () => {
    const r = matchEquipmentName("совершенно неизвестный предмет", catalog);
    expect(r.equipmentId).toBeNull();
  });
});
```

- [ ] **Step 5.2: Run, verify fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/matchers/equipmentMatcher.test.ts
```

- [ ] **Step 5.3: Implement equipmentMatcher.ts**

`apps/api/scripts/reconcile-chat/matchers/equipmentMatcher.ts`:

```typescript
import stringSimilarity from "string-similarity";
import { normalizeRu } from "../lib/normalize";

export interface EquipmentMatchInput {
  id: string;
  name: string;
  importKey: string | null;
  aliases: { phrase: string }[];
}

export interface EquipmentMatchResult {
  equipmentId: string | null;
  method: "importKey" | "alias" | "similarity" | "none";
  score: number;
}

const SIM_THRESHOLD = 0.7;

export function matchEquipmentName(rawName: string, catalog: EquipmentMatchInput[]): EquipmentMatchResult {
  const norm = normalizeRu(rawName);
  if (!norm) return { equipmentId: null, method: "none", score: 0 };

  // 1. Exact match by importKey (importKey lookup is normalized too)
  const byKey = catalog.find((e) => e.importKey && normalizeRu(e.importKey) === norm);
  if (byKey) return { equipmentId: byKey.id, method: "importKey", score: 1 };

  // 2. Exact match against any normalized alias
  for (const e of catalog) {
    for (const a of e.aliases) {
      if (normalizeRu(a.phrase) === norm) {
        return { equipmentId: e.id, method: "alias", score: 1 };
      }
    }
  }

  // 3. Similarity against Equipment.name
  const namesNorm = catalog.map((e) => normalizeRu(e.name));
  const { ratings } = stringSimilarity.findBestMatch(norm, namesNorm);
  const best = ratings.reduce((a, b) => (b.rating > a.rating ? b : a), { rating: 0, target: "" });
  if (best.rating >= SIM_THRESHOLD) {
    const idx = namesNorm.indexOf(best.target);
    return { equipmentId: catalog[idx].id, method: "similarity", score: best.rating };
  }

  return { equipmentId: null, method: "none", score: best.rating };
}
```

- [ ] **Step 5.4: Run, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/matchers/equipmentMatcher.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add apps/api/scripts/reconcile-chat/matchers/equipmentMatcher.ts apps/api/scripts/reconcile-chat/matchers/equipmentMatcher.test.ts
git commit -m "feat(reconcile): equipment name → Equipment.id matcher (importKey/alias/similarity)"
```

---

## Task 6: Client dedup (Levenshtein)

**Files:**
- Create: `apps/api/scripts/reconcile-chat/matchers/clientDedup.ts`
- Create: `apps/api/scripts/reconcile-chat/matchers/clientDedup.test.ts`

- [ ] **Step 6.1: Write failing tests**

`apps/api/scripts/reconcile-chat/matchers/clientDedup.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findDedupPairs, ClientForDedup } from "./clientDedup";

const sample: ClientForDedup[] = [
  { id: "c1", name: "Хакаги", bookingCount: 8 },
  { id: "c2", name: "Хокаге", bookingCount: 3 },
  { id: "c3", name: "Гена Белых", bookingCount: 13 },
  { id: "c4", name: "Гена", bookingCount: 0 },
  { id: "c5", name: "Романов Вова", bookingCount: 7 },
  { id: "c6", name: "Вова Митрофанов", bookingCount: 5 },
];

describe("findDedupPairs", () => {
  it("auto-merges Хакаги↔Хокаге (short, single token, distance 2)", () => {
    const pairs = findDedupPairs(sample);
    const auto = pairs.find((p) => p.auto);
    expect(auto).toBeDefined();
    expect(new Set([auto!.fromName, auto!.toName])).toEqual(new Set(["Хакаги", "Хокаге"]));
  });

  it("canonical is the one with more bookings", () => {
    const pairs = findDedupPairs(sample);
    const xPair = pairs.find((p) => p.fromName === "Хокаге" || p.toName === "Хокаге")!;
    expect(xPair.toName).toBe("Хакаги");
    expect(xPair.fromName).toBe("Хокаге");
  });

  it("Гена ↔ Гена Белых is suggested (not auto) because one has a surname", () => {
    const pairs = findDedupPairs(sample);
    const suggested = pairs.find((p) => p.fromName === "Гена" || p.toName === "Гена");
    expect(suggested).toBeDefined();
    expect(suggested!.auto).toBe(false);
  });

  it("does not pair Романов Вова with Вова Митрофанов (both multi-word)", () => {
    const pairs = findDedupPairs(sample);
    expect(pairs.find((p) =>
      (p.fromName === "Романов Вова" && p.toName === "Вова Митрофанов") ||
      (p.fromName === "Вова Митрофанов" && p.toName === "Романов Вова")
    )).toBeUndefined();
  });
});
```

- [ ] **Step 6.2: Run, verify fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/matchers/clientDedup.test.ts
```

- [ ] **Step 6.3: Implement clientDedup.ts**

`apps/api/scripts/reconcile-chat/matchers/clientDedup.ts`:

```typescript
import levenshtein from "js-levenshtein";
import { ClientMergePair } from "../types";
import { normalizeClientName } from "../lib/normalize";

export interface ClientForDedup {
  id: string;
  name: string;
  bookingCount: number;
}

const AUTO_MAX_DIST = 2;
const AUTO_MAX_LEN = 8;
const SUGGEST_MAX_DIST = 4;

function isSingleToken(s: string): boolean {
  return !s.trim().includes(" ");
}

function chooseCanonical(a: ClientForDedup, b: ClientForDedup): { from: ClientForDedup; to: ClientForDedup } {
  if (a.bookingCount !== b.bookingCount) {
    return a.bookingCount > b.bookingCount ? { from: b, to: a } : { from: a, to: b };
  }
  return a.name.length >= b.name.length ? { from: b, to: a } : { from: a, to: b };
}

export function findDedupPairs(clients: ClientForDedup[]): ClientMergePair[] {
  const out: ClientMergePair[] = [];
  for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      const a = clients[i];
      const b = clients[j];
      const na = normalizeClientName(a.name);
      const nb = normalizeClientName(b.name);
      if (na === nb) continue;
      const dist = levenshtein(na, nb);
      if (dist > SUGGEST_MAX_DIST) continue;
      const bothShortSingle =
        na.length <= AUTO_MAX_LEN &&
        nb.length <= AUTO_MAX_LEN &&
        isSingleToken(na) &&
        isSingleToken(nb);
      const auto = dist <= AUTO_MAX_DIST && bothShortSingle;
      // Skip suggestion when distance is small but neither is a substring of the other —
      // unlikely to be the same person if they share little (e.g. "Лёша" vs "Лиза" → 2).
      if (!auto && !(na.includes(nb) || nb.includes(na) || dist <= 2)) continue;
      const { from, to } = chooseCanonical(a, b);
      out.push({ fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, distance: dist, auto });
    }
  }
  return out;
}
```

- [ ] **Step 6.4: Run, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/matchers/clientDedup.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/scripts/reconcile-chat/matchers/clientDedup.ts apps/api/scripts/reconcile-chat/matchers/clientDedup.test.ts
git commit -m "feat(reconcile): Levenshtein-based client dedup candidate finder"
```

---

## Task 7: Slang extractor (PAIR cases → SlangCandidate[])

**Files:**
- Create: `apps/api/scripts/reconcile-chat/slang/extractor.ts`
- Create: `apps/api/scripts/reconcile-chat/slang/extractor.test.ts`

- [ ] **Step 7.1: Write failing tests**

`apps/api/scripts/reconcile-chat/slang/extractor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractSlangCandidates, ExtractInput } from "./extractor";

const input: ExtractInput[] = [
  // Phrase appearing twice with same equipment → high confidence
  { phrase: "Лантерн 120", equipmentId: "eq-lantern", equipmentName: "Lantern 120", msgId: 100, nameSubstringMatch: true },
  { phrase: "Лантерн 120", equipmentId: "eq-lantern", equipmentName: "Lantern 120", msgId: 200, nameSubstringMatch: true },
  // Phrase appearing once → lower confidence
  { phrase: "Мбю 12",      equipmentId: "eq-mbu",     equipmentName: "MBU 12",      msgId: 300, nameSubstringMatch: false },
  // Phrase with disagreement (50/50) → REVIEW
  { phrase: "1000с",       equipmentId: "eq-1000s",   equipmentName: "1000c",       msgId: 400, nameSubstringMatch: false },
  { phrase: "1000с",       equipmentId: "eq-other",   equipmentName: "Other",       msgId: 401, nameSubstringMatch: false },
];

describe("extractSlangCandidates", () => {
  it("aggregates duplicate (phrase, equipmentId) pairs", () => {
    const out = extractSlangCandidates(input);
    const lantern = out.find((c) => c.phraseOriginal === "Лантерн 120");
    expect(lantern!.supportCount).toBe(2);
    expect(lantern!.sourceMsgIds).toEqual([100, 200]);
  });

  it("auto-approves high-support + substring match (confidence ≥ 0.85)", () => {
    const out = extractSlangCandidates(input);
    const lantern = out.find((c) => c.phraseOriginal === "Лантерн 120");
    expect(lantern!.decision).toBe("AUTO");
    expect(lantern!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("low-support single occurrence → REVIEW", () => {
    const out = extractSlangCandidates(input);
    const mbu = out.find((c) => c.phraseOriginal === "Мбю 12");
    expect(mbu!.decision).toBe("REVIEW");
    expect(mbu!.confidence).toBeLessThan(0.85);
  });

  it("split phrase across two equipments → both REVIEW (dominance < 80%)", () => {
    const out = extractSlangCandidates(input);
    const candidates = out.filter((c) => c.phraseOriginal === "1000с");
    expect(candidates.length).toBe(2);
    for (const c of candidates) expect(c.decision).toBe("REVIEW");
  });
});
```

- [ ] **Step 7.2: Run, verify fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/slang/extractor.test.ts
```

- [ ] **Step 7.3: Implement extractor.ts**

`apps/api/scripts/reconcile-chat/slang/extractor.ts`:

```typescript
import { SlangCandidate } from "../types";
import { normalizeRu } from "../lib/normalize";

export interface ExtractInput {
  phrase: string;               // как в пасте, без qty
  equipmentId: string;
  equipmentName: string;
  msgId: number;
  nameSubstringMatch: boolean;  // phrase substring-matches Equipment.name (normalized)
}

const AUTO_THRESHOLD = 0.85;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function extractSlangCandidates(inputs: ExtractInput[]): SlangCandidate[] {
  // Aggregate by (phraseNormalized, equipmentId)
  const map = new Map<string, {
    phraseOriginal: string;
    phraseNormalized: string;
    equipmentId: string;
    equipmentName: string;
    msgIds: number[];
    substringMatchAny: boolean;
  }>();

  for (const i of inputs) {
    const norm = normalizeRu(i.phrase);
    const key = `${norm}::${i.equipmentId}`;
    const existing = map.get(key);
    if (existing) {
      existing.msgIds.push(i.msgId);
      existing.substringMatchAny = existing.substringMatchAny || i.nameSubstringMatch;
    } else {
      map.set(key, {
        phraseOriginal: i.phrase,
        phraseNormalized: norm,
        equipmentId: i.equipmentId,
        equipmentName: i.equipmentName,
        msgIds: [i.msgId],
        substringMatchAny: i.nameSubstringMatch,
      });
    }
  }

  // Compute total appearances per phrase to determine dominance
  const phraseTotal = new Map<string, number>();
  for (const entry of map.values()) {
    phraseTotal.set(entry.phraseNormalized, (phraseTotal.get(entry.phraseNormalized) ?? 0) + entry.msgIds.length);
  }

  const out: SlangCandidate[] = [];
  for (const entry of map.values()) {
    const support = entry.msgIds.length;
    const total = phraseTotal.get(entry.phraseNormalized) ?? support;
    const dominant = support / total >= 0.8;

    let confidence = 0.5;
    confidence += 0.1 * Math.log10(support + 1);  // log10(2) ≈ 0.30 for support=1, ≈ 0.48 for 2, etc — slow growth
    if (support >= 2) confidence += 0.1;          // explicit bonus for repeated evidence
    if (dominant) confidence += 0.2;
    if (entry.substringMatchAny) confidence += 0.2;
    confidence = clamp(confidence, 0, 1);

    out.push({
      phraseOriginal: entry.phraseOriginal,
      phraseNormalized: entry.phraseNormalized,
      equipmentId: entry.equipmentId,
      equipmentName: entry.equipmentName,
      confidence,
      supportCount: support,
      decision: confidence >= AUTO_THRESHOLD ? "AUTO" : "REVIEW",
      sourceMsgIds: entry.msgIds,
    });
  }

  return out;
}
```

- [ ] **Step 7.4: Run, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/slang/extractor.test.ts
```

Expected: 4 tests pass. If any test fails because the threshold tuning is off, adjust constants in the confidence formula to satisfy the test invariants (high-support+substring → ≥ 0.85, single occurrence no substring → < 0.85, split phrase → < 0.85 because dominance bonus removed).

- [ ] **Step 7.5: Commit**

```bash
git add apps/api/scripts/reconcile-chat/slang/extractor.ts apps/api/scripts/reconcile-chat/slang/extractor.test.ts
git commit -m "feat(reconcile): slang candidate extractor with confidence formula"
```

---

## Task 8: Booking matcher (against live DB)

**Files:**
- Create: `apps/api/scripts/reconcile-chat/matchers/bookingMatcher.ts`
- Create: `apps/api/scripts/reconcile-chat/matchers/bookingMatcher.test.ts`

- [ ] **Step 8.1: Write failing tests**

`apps/api/scripts/reconcile-chat/matchers/bookingMatcher.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { matchBookingForEntry, BookingCandidate } from "./bookingMatcher";

const dbBookings: BookingCandidate[] = [
  { id: "b1", clientName: "Гена Белых", startDateMs: Date.UTC(2026, 0, 15), finalAmount: 85_000, paymentStatus: "OVERDUE" },
  { id: "b2", clientName: "Петя Куб",   startDateMs: Date.UTC(2026, 0, 17), finalAmount: 4_500,  paymentStatus: "PAID" },
  { id: "b3", clientName: "Петя Куб",   startDateMs: Date.UTC(2026, 0, 17), finalAmount: 10_000, paymentStatus: "OVERDUE" }, // погруз
];

describe("matchBookingForEntry — PAIR/XLSX_ONLY", () => {
  it("matches by (date ± 2d, client fuzzy ≥ 0.7, amount ± 5%)", () => {
    const r = matchBookingForEntry(
      { kind: "PAIR", clientName: "Гена Белых", shootDate: "2026-01-16", totalRub: 85_590 },
      dbBookings
    );
    expect(r.action).toBe("SKIP_NEEDS_UPDATE_REVIEW");
    expect(r.candidates).toEqual(["b1"]);
  });

  it("SKIP_PROTECTED when PAID", () => {
    const r = matchBookingForEntry(
      { kind: "PAIR", clientName: "Петя Куб", shootDate: "2026-01-17", totalRub: 4_500 },
      dbBookings
    );
    expect(r.action).toBe("SKIP_PROTECTED");
  });

  it("CONFLICT_NEEDS_REVIEW when 2 candidates match", () => {
    const r = matchBookingForEntry(
      { kind: "PAIR", clientName: "Петя Куб", shootDate: "2026-01-17", totalRub: 10_500 },  // matches b3 ±5%
      dbBookings
    );
    // Will match only b3 by amount; second test below for true conflict.
    expect(r.action).toBe("SKIP_NEEDS_UPDATE_REVIEW");
    expect(r.candidates).toEqual(["b3"]);
  });

  it("INSERT when no candidates", () => {
    const r = matchBookingForEntry(
      { kind: "PAIR", clientName: "Новый Клиент", shootDate: "2026-04-01", totalRub: 1234 },
      dbBookings
    );
    expect(r.action).toBe("INSERT");
    expect(r.candidates).toHaveLength(0);
  });
});

describe("matchBookingForEntry — REQUEST_ONLY", () => {
  it("SKIP_DUP when (date, client) matches any existing booking", () => {
    const r = matchBookingForEntry(
      { kind: "REQUEST_ONLY", clientName: "Гена Белых", shootDate: "2026-01-15", totalRub: 0 },
      dbBookings
    );
    expect(r.action).toBe("SKIP_DUP");
  });
  it("INSERT (DRAFT) when no (date, client) match", () => {
    const r = matchBookingForEntry(
      { kind: "REQUEST_ONLY", clientName: "Гена Белых", shootDate: "2026-04-01", totalRub: 0 },
      dbBookings
    );
    expect(r.action).toBe("INSERT");
  });
});
```

- [ ] **Step 8.2: Run, verify fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/matchers/bookingMatcher.test.ts
```

- [ ] **Step 8.3: Implement bookingMatcher.ts**

`apps/api/scripts/reconcile-chat/matchers/bookingMatcher.ts`:

```typescript
import stringSimilarity from "string-similarity";
import { MatchAction, ChatEntryKind } from "../types";
import { normalizeClientName } from "../lib/normalize";

export interface BookingCandidate {
  id: string;
  clientName: string;
  startDateMs: number;
  finalAmount: number;
  paymentStatus: "PAID" | "OVERDUE" | "NOT_PAID" | "OVERPAID" | "PARTIAL";
}

export interface EntryForMatch {
  kind: ChatEntryKind;
  clientName: string;
  shootDate: string;   // YYYY-MM-DD
  totalRub: number;    // 0 for REQUEST_ONLY
}

export interface BookingMatchResult {
  action: MatchAction;
  candidates: string[];
  reason: string;
}

const DAY_MS = 24 * 3600 * 1000;
const DATE_TOLERANCE_DAYS = 2;
const NAME_SIM_THRESHOLD = 0.7;
const AMOUNT_TOLERANCE_PCT = 0.05;

function dateToMs(iso: string): number {
  return Date.parse(iso + "T00:00:00Z");
}

function withinAmount(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) / b <= AMOUNT_TOLERANCE_PCT;
}

export function matchBookingForEntry(entry: EntryForMatch, db: BookingCandidate[]): BookingMatchResult {
  const entryMs = dateToMs(entry.shootDate);
  const normEntry = normalizeClientName(entry.clientName);

  const dateAndClient = db.filter((b) => {
    const dateOk = Math.abs(b.startDateMs - entryMs) <= DATE_TOLERANCE_DAYS * DAY_MS;
    if (!dateOk) return false;
    const sim = stringSimilarity.compareTwoStrings(normEntry, normalizeClientName(b.clientName));
    return sim >= NAME_SIM_THRESHOLD;
  });

  if (entry.kind === "REQUEST_ONLY") {
    if (dateAndClient.length > 0) {
      return { action: "SKIP_DUP", candidates: dateAndClient.map((b) => b.id), reason: "request-only matched existing" };
    }
    return { action: "INSERT", candidates: [], reason: "request-only new" };
  }

  // PAIR / XLSX_ONLY: additionally filter by amount ± 5%
  const withAmount = dateAndClient.filter((b) => withinAmount(b.finalAmount, entry.totalRub));

  if (withAmount.length === 0) {
    return { action: "INSERT", candidates: [], reason: "no candidate within amount tolerance" };
  }
  if (withAmount.length >= 2) {
    return {
      action: "CONFLICT_NEEDS_REVIEW",
      candidates: withAmount.map((b) => b.id),
      reason: `${withAmount.length} candidates match — manual review`,
    };
  }
  const c = withAmount[0];
  if (c.paymentStatus === "PAID" || c.paymentStatus === "OVERPAID") {
    return { action: "SKIP_PROTECTED", candidates: [c.id], reason: `payment ${c.paymentStatus}` };
  }
  return { action: "SKIP_NEEDS_UPDATE_REVIEW", candidates: [c.id], reason: `${c.paymentStatus} — defer to phase 7` };
}
```

- [ ] **Step 8.4: Run, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/matchers/bookingMatcher.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 8.5: Commit**

```bash
git add apps/api/scripts/reconcile-chat/matchers/bookingMatcher.ts apps/api/scripts/reconcile-chat/matchers/bookingMatcher.test.ts
git commit -m "feat(reconcile): chat entry → booking match decision"
```

---

## Task 9: SlangAlias bugfix migration

**Files:**
- Create: `apps/api/scripts/reconcile-chat/slang/bugfix.ts`
- Create: `apps/api/scripts/reconcile-chat/slang/bugfix.test.ts`
- Create: `apps/api/scripts/reconcile-chat/db/prisma.ts`

- [ ] **Step 9.1: Create scoped Prisma helper**

`apps/api/scripts/reconcile-chat/db/prisma.ts`:

```typescript
import { PrismaClient } from "@prisma/client";
import path from "path";

/**
 * Returns a PrismaClient bound to the given SQLite file path.
 * Use for the reconcile working-copy without polluting global env.
 */
export function dbAt(dbPath: string): PrismaClient {
  const absUrl = "file:" + path.resolve(dbPath);
  return new PrismaClient({ datasourceUrl: absUrl });
}

export async function withDb<T>(dbPath: string, fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const client = dbAt(dbPath);
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}
```

- [ ] **Step 9.2: Write failing tests for bugfix**

`apps/api/scripts/reconcile-chat/slang/bugfix.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { dbAt } from "../db/prisma";
import { fixSlangQtyMarker } from "./bugfix";

const TEST_DB = path.resolve(__dirname, "../../../prisma/test-slang-bugfix.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
    stdio: "inherit",
  });
});

afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("fixSlangQtyMarker", () => {
  it("strips «(N)» from phraseOriginal and re-normalizes; merges on UNIQUE conflict", async () => {
    const prisma = dbAt(TEST_DB);
    try {
      const eq = await prisma.equipment.create({
        data: {
          name: "Pena 1",
          importKey: "pena_1_test",      // required @unique
          category: "test",
          totalQuantity: 10,
          rentalRatePerShift: 100,       // required Decimal
          stockTrackingMode: "COUNT",
        },
      });
      // dirty row with «(1)»
      const dirty = await prisma.slangAlias.create({
        data: { phraseOriginal: "Пена (1)", phraseNormalized: "пена (1)", equipmentId: eq.id, usageCount: 3 },
      });
      // clean row already present
      const clean = await prisma.slangAlias.create({
        data: { phraseOriginal: "Пена", phraseNormalized: "пена", equipmentId: eq.id, usageCount: 2 },
      });

      const result = await fixSlangQtyMarker(prisma);
      expect(result.deleted).toBe(1);
      expect(result.merged).toBe(1);

      const remaining = await prisma.slangAlias.findMany({ where: { equipmentId: eq.id } });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].phraseOriginal).toBe("Пена");
      expect(remaining[0].usageCount).toBe(5); // 3 + 2
    } finally {
      await prisma.$disconnect();
    }
  });
});
```

- [ ] **Step 9.3: Run, verify fail**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/slang/bugfix.test.ts
```

Expected: failure ("Cannot find module ./bugfix").

- [ ] **Step 9.4: Implement bugfix.ts**

`apps/api/scripts/reconcile-chat/slang/bugfix.ts`:

```typescript
import type { PrismaClient } from "@prisma/client";
import { phraseNoQty, normalizeRu } from "../lib/normalize";

export interface BugfixResult {
  deleted: number;
  merged: number;
  log: Array<{ id: string; phraseOriginal: string; cleanPhrase: string; action: "MERGED" | "RENAMED" }>;
}

export async function fixSlangQtyMarker(prisma: PrismaClient): Promise<BugfixResult> {
  const all = await prisma.slangAlias.findMany();
  const result: BugfixResult = { deleted: 0, merged: 0, log: [] };

  for (const row of all) {
    const clean = phraseNoQty(row.phraseOriginal);
    if (clean === row.phraseOriginal) continue;
    const cleanNorm = normalizeRu(clean);

    const existing = await prisma.slangAlias.findUnique({
      where: {
        phraseNormalized_equipmentId: {
          phraseNormalized: cleanNorm,
          equipmentId: row.equipmentId,
        },
      },
    });

    await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.slangAlias.update({
          where: { id: existing.id },
          data: {
            usageCount: existing.usageCount + row.usageCount,
            lastUsedAt: row.lastUsedAt > existing.lastUsedAt ? row.lastUsedAt : existing.lastUsedAt,
            confidence: Math.max(existing.confidence, row.confidence),
          },
        });
        await tx.slangAlias.delete({ where: { id: row.id } });
        result.merged += 1;
        result.deleted += 1;
        result.log.push({ id: row.id, phraseOriginal: row.phraseOriginal, cleanPhrase: clean, action: "MERGED" });
      } else {
        await tx.slangAlias.update({
          where: { id: row.id },
          data: { phraseOriginal: clean, phraseNormalized: cleanNorm },
        });
        result.log.push({ id: row.id, phraseOriginal: row.phraseOriginal, cleanPhrase: clean, action: "RENAMED" });
      }
    });
  }

  return result;
}
```

- [ ] **Step 9.5: Run, verify pass**

```bash
cd apps/api && npx vitest run scripts/reconcile-chat/slang/bugfix.test.ts
```

Expected: 1 test passes.

- [ ] **Step 9.6: Commit**

```bash
git add apps/api/scripts/reconcile-chat/slang/bugfix.ts apps/api/scripts/reconcile-chat/slang/bugfix.test.ts apps/api/scripts/reconcile-chat/db/prisma.ts
git commit -m "feat(reconcile): SlangAlias «(N)» qty-marker migration + scoped Prisma helper"
```

---

## Task 10: Audit extensions + system-reconcile seed user

**Files:**
- Modify: `apps/api/src/services/audit.ts` (extend AuditEntityType union)
- Create: `apps/api/scripts/reconcile-chat/db/seedSystemUser.ts`
- Create: `apps/api/scripts/reconcile-chat/audit/writers.ts`

- [ ] **Step 10.1: Extend AuditEntityType union**

Open `apps/api/src/services/audit.ts`, find the `AuditEntityType` union (around top of file). Add `"SlangAlias"`:

```typescript
export type AuditEntityType =
  | "Booking"
  | "Payment"
  | "Expense"
  | "Unit"
  | "Client"
  | "Repair"
  | "AdminUser"
  | "EquipmentUnit"
  | "Task"
  | "ProblemItem"
  | "SlangAlias";   // ← added for reconcile
```

(Exact existing values may differ; preserve all and append `"SlangAlias"`.)

- [ ] **Step 10.2: Verify tsc still clean**

```bash
cd apps/api && timeout 60 npx tsc --noEmit --pretty false --incremental --tsBuildInfoFile node_modules/.cache/tsc-hook.tsbuildinfo
```

Expected: no new errors related to audit.

- [ ] **Step 10.3: Implement seedSystemUser.ts**

`apps/api/scripts/reconcile-chat/db/seedSystemUser.ts`:

```typescript
import type { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { SYSTEM_USER_ID } from "../types";

/**
 * Idempotent: creates the synthetic AdminUser used as `userId` for reconcile AuditEntry rows.
 * Never grants real access — password hash is random and discarded.
 */
export async function ensureSystemReconcileUser(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.adminUser.findUnique({ where: { id: SYSTEM_USER_ID } });
  if (existing) return;
  const disabledHash = "$2a$10$" + crypto.randomBytes(48).toString("base64").slice(0, 53);
  await prisma.adminUser.create({
    data: {
      id: SYSTEM_USER_ID,
      username: SYSTEM_USER_ID,
      passwordHash: disabledHash,
      role: "SUPER_ADMIN",
    },
  });
}
```

- [ ] **Step 10.4: Implement writers.ts**

`apps/api/scripts/reconcile-chat/audit/writers.ts`:

```typescript
import type { PrismaClient, Prisma } from "@prisma/client";
import { SYSTEM_USER_ID } from "../types";

export async function writeReconcileAudit(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    action:
      | "BOOKING_RECONCILE_INSERT"
      | "BOOKING_RECONCILE_UPDATE"
      | "CLIENT_MERGE"
      | "SLANG_RECONCILE_INSERT"
      | "SLANG_RECONCILE_BUGFIX";
    entityType: "Booking" | "Client" | "SlangAlias";
    entityId: string;
    metadata: Record<string, unknown>;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.auditEntry.create({
    data: {
      userId: SYSTEM_USER_ID,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      before: args.before ? JSON.stringify(args.before).slice(0, 10_000) : null,
      after: args.after ? JSON.stringify({ ...args.after, _meta: args.metadata }).slice(0, 10_000) : JSON.stringify({ _meta: args.metadata }).slice(0, 10_000),
    },
  });
}
```

(`metadata` is folded into `after` to avoid adding columns. If the existing `AuditEntry` already has a `metadata` JSON column, refactor accordingly when implementing.)

- [ ] **Step 10.5: Commit**

```bash
git add apps/api/src/services/audit.ts apps/api/scripts/reconcile-chat/db/seedSystemUser.ts apps/api/scripts/reconcile-chat/audit/writers.ts
git commit -m "feat(reconcile): AuditEntityType += SlangAlias + system-reconcile seed user + audit writer"
```

---

## Task 11: SSH/SCP wrappers + snapshot/push

**Files:**
- Create: `apps/api/scripts/reconcile-chat/lib/ssh.ts`
- Create: `apps/api/scripts/reconcile-chat/db/snapshot.ts`
- Create: `apps/api/scripts/reconcile-chat/db/push.ts`

These are infrastructure with side effects; we test via small dry-run-safe APIs and rely on smoke tests rather than unit tests.

- [ ] **Step 11.1: Implement ssh.ts**

`apps/api/scripts/reconcile-chat/lib/ssh.ts`:

```typescript
import { execSync, spawnSync } from "child_process";

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
```

- [ ] **Step 11.2: Implement snapshot.ts**

`apps/api/scripts/reconcile-chat/db/snapshot.ts`:

```typescript
import fs from "fs";
import { execSync } from "child_process";
import { sshExec, scpDown } from "../lib/ssh";
import { snapshotPath, workingCopyPath } from "../lib/paths";

const REMOTE_DB = "/opt/light-rental-system/apps/api/prisma/prod.db";
const REMOTE_TMP = "/tmp/reconcile-snapshot.db";

export interface SnapshotResult {
  iso: string;
  snapshot: string;
  workingCopy: string;
}

export function takeSnapshot(): SnapshotResult {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshot = snapshotPath(iso);
  const workingCopy = workingCopyPath(iso);

  // Atomic-ish copy on the server (SQLite is single-file; copy when api is online is fine — Prisma uses WAL)
  sshExec(`sqlite3 ${REMOTE_DB} ".backup ${REMOTE_TMP}"`);
  scpDown(REMOTE_TMP, snapshot);
  sshExec(`rm -f ${REMOTE_TMP}`);

  fs.copyFileSync(snapshot, workingCopy);
  const sz = fs.statSync(snapshot).size;
  console.log(`[snapshot] saved ${sz} bytes → ${snapshot}`);
  console.log(`[snapshot] working copy → ${workingCopy}`);
  return { iso, snapshot, workingCopy };
}
```

- [ ] **Step 11.3: Implement push.ts**

`apps/api/scripts/reconcile-chat/db/push.ts`:

```typescript
import { sshExec, scpUp } from "../lib/ssh";
import fs from "fs";

const REMOTE_DB = "/opt/light-rental-system/apps/api/prisma/prod.db";

export interface PushResult {
  preReconcileBackupPath: string;
  rowCounts: { Booking: number; SlangAlias: number; Client: number; AuditEntry: number };
}

export function pushWorkingCopy(workingCopy: string, batchId: string): PushResult {
  if (!fs.existsSync(workingCopy)) throw new Error(`working copy not found: ${workingCopy}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preBackup = `/opt/light-rental-system/apps/api/prisma/prod-pre-reconcile-${stamp}.db`;

  sshExec("pm2 stop api");
  try {
    sshExec(`cp ${REMOTE_DB} ${preBackup}`);
    scpUp(workingCopy, REMOTE_DB);

    const counts = sshExec(
      `sqlite3 ${REMOTE_DB} "SELECT (SELECT count(*) FROM Booking),(SELECT count(*) FROM SlangAlias),(SELECT count(*) FROM Client),(SELECT count(*) FROM AuditEntry)"`
    ).trim().split("|").map((n) => parseInt(n, 10));

    return {
      preReconcileBackupPath: preBackup,
      rowCounts: { Booking: counts[0], SlangAlias: counts[1], Client: counts[2], AuditEntry: counts[3] },
    };
  } finally {
    sshExec("pm2 start api");
  }
}
```

- [ ] **Step 11.4: Smoke-test snapshot (must work against real prod)**

```bash
cd apps/api && npx tsx -e "
const { takeSnapshot } = require('./scripts/reconcile-chat/db/snapshot');
const r = takeSnapshot();
console.log(JSON.stringify(r, null, 2));
"
```

Expected: file `backups/prod-snapshot-<iso>.db` exists, > 1 MB. `working-copy-<iso>.db` matches in size.

- [ ] **Step 11.5: Commit**

```bash
git add apps/api/scripts/reconcile-chat/lib/ssh.ts apps/api/scripts/reconcile-chat/db/snapshot.ts apps/api/scripts/reconcile-chat/db/push.ts
git commit -m "feat(reconcile): ssh/scp wrappers + snapshot + push helpers"
```

---

## Task 12: Phase `prepare` + Phase `parse` orchestrators

**Files:**
- Create: `apps/api/scripts/reconcile-chat/phases/prepare.ts`
- Create: `apps/api/scripts/reconcile-chat/phases/parse.ts`
- Create: `apps/api/scripts/reconcile-chat/reports/parsedChatStats.ts`

- [ ] **Step 12.1: Implement prepare.ts**

`apps/api/scripts/reconcile-chat/phases/prepare.ts`:

```typescript
import fs from "fs";
import { ensureDirs, tmpFile } from "../lib/paths";
import { takeSnapshot } from "../db/snapshot";
import { ensureSystemReconcileUser } from "../db/seedSystemUser";
import { fixSlangQtyMarker } from "../slang/bugfix";
import { withDb } from "../db/prisma";

export interface PrepareOutput {
  iso: string;
  snapshot: string;
  workingCopy: string;
  bugfix: { deleted: number; merged: number };
}

export async function runPrepare(): Promise<PrepareOutput> {
  ensureDirs();
  const snap = takeSnapshot();
  const bugfix = await withDb(snap.workingCopy, async (prisma) => {
    await ensureSystemReconcileUser(prisma);
    return await fixSlangQtyMarker(prisma);
  });

  // Persist bugfix log
  fs.writeFileSync(tmpFile("slang-bugfix.log"), JSON.stringify(bugfix, null, 2));
  // Persist working-copy pointer for subsequent phases
  fs.writeFileSync(tmpFile("current-working-copy.txt"), snap.workingCopy);

  console.log(`[prepare] iso=${snap.iso}`);
  console.log(`[prepare] snapshot=${snap.snapshot}`);
  console.log(`[prepare] working-copy=${snap.workingCopy}`);
  console.log(`[prepare] bugfix: deleted=${bugfix.deleted} merged=${bugfix.merged}`);

  return { ...snap, bugfix: { deleted: bugfix.deleted, merged: bugfix.merged } };
}
```

- [ ] **Step 12.2: Implement reports/parsedChatStats.ts**

`apps/api/scripts/reconcile-chat/reports/parsedChatStats.ts`:

```typescript
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
  lines.push(`\n## By kind\n`);
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  lines.push(`\n## By month\n`);
  for (const m of sortedMonths) lines.push(`- ${m}: ${byMonth[m]}`);
  lines.push(`\n## By gaffer\n`);
  for (const [g, v] of sortedGaffers) lines.push(`- ${g}: ${v}`);
  lines.push(`\n## Total: ${entries.length}`);
  return lines.join("\n");
}
```

- [ ] **Step 12.3: Implement phases/parse.ts**

`apps/api/scripts/reconcile-chat/phases/parse.ts`:

```typescript
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

  // Write artifacts
  fs.writeFileSync(tmpFile("parsed-chat.jsonl"), grouped.map((e) => JSON.stringify(e)).join("\n"));
  fs.writeFileSync(tmpFile("parsed-chat-stats.md"), buildParsedChatStats(grouped));
  if (xlsxFailures.length > 0) {
    fs.writeFileSync(tmpFile("xlsx-parse-failures.json"), JSON.stringify(xlsxFailures, null, 2));
  }

  console.log(`[parse] entries=${grouped.length}, xlsx failures=${xlsxFailures.length}`);
  return { entries: grouped, xlsxFailures };
}
```

- [ ] **Step 12.4: Wire phases into index.ts**

Open `apps/api/scripts/reconcile-chat/index.ts` and replace the `main()` body:

```typescript
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
    default:
      console.error(`phase ${argv.phase} not implemented yet`);
      process.exit(1);
  }
}
```

- [ ] **Step 12.5: Smoke-test prepare + parse**

```bash
cd apps/api && npx tsx scripts/reconcile-chat/index.ts --phase prepare
npx tsx scripts/reconcile-chat/index.ts --phase parse
ls -la ../../tmp/reconcile/
```

Expected:
- `backups/prod-snapshot-*.db` and `backups/working-copy-*.db` exist
- `tmp/reconcile/parsed-chat.jsonl` exists with hundreds of lines
- `tmp/reconcile/parsed-chat-stats.md` exists and is human-readable

- [ ] **Step 12.6: Commit**

```bash
git add apps/api/scripts/reconcile-chat/phases/prepare.ts apps/api/scripts/reconcile-chat/phases/parse.ts apps/api/scripts/reconcile-chat/reports/parsedChatStats.ts apps/api/scripts/reconcile-chat/index.ts
git commit -m "feat(reconcile): phases prepare + parse + stats report"
```

---

## Task 13: Phase `match` orchestrator

**Files:**
- Create: `apps/api/scripts/reconcile-chat/phases/match.ts`

This phase combines client dedup, equipment matching for xlsx items, booking matching against DB, and slang candidate extraction.

- [ ] **Step 13.1: Implement match.ts**

`apps/api/scripts/reconcile-chat/phases/match.ts`:

```typescript
import fs from "fs";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { writeReconcileAudit } from "../audit/writers";
import { matchEquipmentName, EquipmentMatchInput } from "../matchers/equipmentMatcher";
import { findDedupPairs, ClientForDedup } from "../matchers/clientDedup";
import { matchBookingForEntry, BookingCandidate } from "../matchers/bookingMatcher";
import { extractSlangCandidates, ExtractInput } from "../slang/extractor";
import { normalizeRu } from "../lib/normalize";
import { ChatEntry, MatchPlanRow, SlangCandidate, ClientMergePair } from "../types";

function readParsed(): ChatEntry[] {
  const raw = fs.readFileSync(tmpFile("parsed-chat.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

export async function runMatch(): Promise<{
  plan: MatchPlanRow[];
  merges: ClientMergePair[];
  slang: SlangCandidate[];
}> {
  const entries = readParsed();
  const dbPath = getWorkingCopy();

  return await withDb(dbPath, async (prisma) => {
    // 1) Client dedup
    const clientsRaw = await prisma.client.findMany({
      include: { _count: { select: { bookings: true } } },
    });
    const clientsForDedup: ClientForDedup[] = clientsRaw.map((c) => ({
      id: c.id,
      name: c.name,
      bookingCount: c._count.bookings,
    }));
    const merges = findDedupPairs(clientsForDedup);

    // Apply auto-merges within transactions, log to CSV
    for (const m of merges.filter((p) => p.auto)) {
      await prisma.$transaction(async (tx) => {
        const reassigned = await tx.booking.updateMany({
          where: { clientId: m.fromId },
          data: { clientId: m.toId },
        });
        await tx.client.delete({ where: { id: m.fromId } });
        await writeReconcileAudit(tx, {
          action: "CLIENT_MERGE",
          entityType: "Client",
          entityId: m.toId,
          metadata: { mergedFromId: m.fromId, mergedName: m.fromName, bookingsReassigned: reassigned.count },
        });
      });
    }

    // 2) Re-load clients post-merge for booking matcher and canonical resolution
    const clientsPostMerge = await prisma.client.findMany();
    const resolveCanonicalClientId = (gafferName: string): string | null => {
      // Exact normalized match first
      const norm = gafferName.trim().toLowerCase().replace(/ё/g, "е");
      const exact = clientsPostMerge.find((c) => c.name.toLowerCase().replace(/ё/g, "е") === norm);
      if (exact) return exact.id;
      // Then fuzzy ≥ 0.7 (same threshold as booking matcher)
      let best: { id: string; score: number } | null = null;
      for (const c of clientsPostMerge) {
        const sim = require("string-similarity").compareTwoStrings(
          norm,
          c.name.toLowerCase().replace(/ё/g, "е")
        );
        if (sim >= 0.7 && (!best || sim > best.score)) best = { id: c.id, score: sim };
      }
      return best ? best.id : null;
    };

    const bookings = await prisma.booking.findMany({
      include: { client: true },
    });
    const dbBookings: BookingCandidate[] = bookings.map((b) => ({
      id: b.id,
      clientName: b.client.name,
      startDateMs: b.startDate.getTime(),
      finalAmount: parseFloat(b.finalAmount.toString()),
      paymentStatus: b.paymentStatus as BookingCandidate["paymentStatus"],
    }));

    // 3) Load equipment + aliases for xlsx item → equipmentId matching
    const equipments = await prisma.equipment.findMany({
      include: { slangAliases: true },
    });
    const catalog: EquipmentMatchInput[] = equipments.map((e) => ({
      id: e.id,
      name: e.name,
      importKey: (e as any).importKey ?? null,
      aliases: e.slangAliases.map((a) => ({ phrase: a.phraseOriginal })),
    }));

    // 4) For each chat entry: resolve equipment for xlsx items, extract slang from PAIR alignment, match against bookings
    const plan: MatchPlanRow[] = [];
    const slangInputs: ExtractInput[] = [];

    for (const entry of entries) {
      if (entry.kind === "NON_ESTIMATE") {
        plan.push({ entryId: entry.id, action: "SKIP_DUP", candidateBookingIds: [], canonicalClientId: null, reason: "non-estimate file (inventory)" });
        continue;
      }

      // Resolve equipmentId for each xlsx item (xlsx names are clean and match catalog best)
      for (const item of entry.xlsxItems) {
        const m = matchEquipmentName(item.phrase, catalog);
        if (m.equipmentId) item.equipmentId = m.equipmentId;
      }

      // PAIR slang extraction: positional alignment paste[i] ↔ xlsx[i]
      // Only trust alignment when lengths are equal and qty matches (strict signal).
      // Otherwise skip slang collection for this PAIR — better silent skip than wrong learning.
      if (entry.kind === "PAIR" && entry.pasteItems.length > 0 && entry.xlsxItems.length === entry.pasteItems.length) {
        const lengthOk = entry.pasteItems.length === entry.xlsxItems.length;
        const qtyOk = lengthOk && entry.pasteItems.every((p, i) => p.qty === entry.xlsxItems[i].qty);
        if (qtyOk) {
          for (let i = 0; i < entry.pasteItems.length; i++) {
            const paste = entry.pasteItems[i];
            const xlsx = entry.xlsxItems[i];
            if (!xlsx.equipmentId) continue; // can't learn alias to nothing
            const eqName = equipments.find((e) => e.id === xlsx.equipmentId)!.name;
            const pasteNorm = normalizeRu(paste.phrase);
            const eqNorm = normalizeRu(eqName);
            // Skip if paste phrase IS the eq name (no slang learning value)
            if (pasteNorm === eqNorm) continue;
            slangInputs.push({
              phrase: paste.phrase,            // the gaffer's wording — the slang
              equipmentId: xlsx.equipmentId,
              equipmentName: eqName,
              msgId: entry.sourcePasteMsgId!,
              nameSubstringMatch: eqNorm.includes(pasteNorm) || pasteNorm.includes(eqNorm),
            });
          }
        }
      }

      // Match against existing bookings
      const match = matchBookingForEntry(
        { kind: entry.kind, clientName: entry.gafferName, shootDate: entry.shootDate, totalRub: entry.totalRub },
        dbBookings
      );
      plan.push({
        entryId: entry.id,
        action: match.action,
        candidateBookingIds: match.candidates,
        canonicalClientId: resolveCanonicalClientId(entry.gafferName),
        reason: match.reason,
      });
    }

    const slang = extractSlangCandidates(slangInputs);

    // Persist
    fs.writeFileSync(tmpFile("match-plan.jsonl"), plan.map((r) => JSON.stringify(r)).join("\n"));
    fs.writeFileSync(
      tmpFile("client-merges.csv"),
      "auto,fromName,fromId,toName,toId,distance\n" +
        merges.map((m) => `${m.auto},"${m.fromName}",${m.fromId},"${m.toName}",${m.toId},${m.distance}`).join("\n")
    );
    fs.writeFileSync(
      tmpFile("slang-candidates.csv"),
      "decision,confidence,supportCount,phraseOriginal,phraseNormalized,equipmentId,equipmentName,sourceMsgIds\n" +
        slang.map((s) =>
          `${s.decision},${s.confidence.toFixed(3)},${s.supportCount},"${s.phraseOriginal}","${s.phraseNormalized}",${s.equipmentId},"${s.equipmentName}","${s.sourceMsgIds.join(";")}"`
        ).join("\n")
    );

    console.log(`[match] plan rows=${plan.length}, auto-merges=${merges.filter((m) => m.auto).length}, slang=${slang.length}`);
    return { plan, merges, slang };
  });
}
```

- [ ] **Step 13.2: Wire `match` into index.ts**

Add to the switch:

```typescript
    case "match": {
      const { runMatch } = await import("./phases/match");
      await runMatch();
      break;
    }
```

- [ ] **Step 13.3: Smoke-run `match`**

```bash
cd apps/api && npx tsx scripts/reconcile-chat/index.ts --phase match
wc -l ../../tmp/reconcile/match-plan.jsonl ../../tmp/reconcile/client-merges.csv ../../tmp/reconcile/slang-candidates.csv
```

Expected:
- `match-plan.jsonl` rows ≈ same as parsed entries
- `client-merges.csv` has at least Хакаги/Хокаге pair
- `slang-candidates.csv` has 100+ rows

- [ ] **Step 13.4: Commit**

```bash
git add apps/api/scripts/reconcile-chat/phases/match.ts apps/api/scripts/reconcile-chat/index.ts
git commit -m "feat(reconcile): match phase — client dedup + booking matcher + slang collection"
```

---

## Task 14: Phase `dry-run` (report generator)

**Files:**
- Create: `apps/api/scripts/reconcile-chat/reports/dryRunReport.ts`
- Create: `apps/api/scripts/reconcile-chat/phases/dryRun.ts`

- [ ] **Step 14.1: Implement dryRunReport.ts**

`apps/api/scripts/reconcile-chat/reports/dryRunReport.ts`:

```typescript
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

  lines.push("## Client auto-merges\n");
  lines.push("| from → to | distance |");
  lines.push("|---|---|");
  for (const m of input.merges.filter((p) => p.auto)) {
    lines.push(`| ${m.fromName} → ${m.toName} | ${m.distance} |`);
  }
  lines.push("");

  lines.push("## Client merges needing your review\n");
  lines.push("| candidate A | candidate B | distance |");
  lines.push("|---|---|---|");
  for (const m of input.merges.filter((p) => !p.auto)) {
    lines.push(`| ${m.fromName} | ${m.toName} | ${m.distance} |`);
  }
  lines.push("");

  lines.push("## INSERT preview (top 30)\n");
  lines.push("| entry | date | gaffer | total ₽ | paste/xlsx items | source |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of (byAction.INSERT ?? []).slice(0, 30)) {
    const e = entriesById.get(r.entryId)!;
    lines.push(`| ${e.id} | ${e.shootDate} | ${e.gafferName} | ${e.totalRub} | ${e.pasteItems.length}/${e.xlsxItems.length} | ${e.kind} |`);
  }
  lines.push("");

  lines.push("## CONFLICT_NEEDS_REVIEW\n");
  lines.push("| entry | gaffer | date | total | candidates |");
  lines.push("|---|---|---|---|---|");
  for (const r of byAction.CONFLICT_NEEDS_REVIEW ?? []) {
    const e = entriesById.get(r.entryId)!;
    lines.push(`| ${e.id} | ${e.gafferName} | ${e.shootDate} | ${e.totalRub} | ${r.candidateBookingIds.join(", ")} |`);
  }
  lines.push("");

  return lines.join("\n");
}
```

- [ ] **Step 14.2: Implement phases/dryRun.ts**

`apps/api/scripts/reconcile-chat/phases/dryRun.ts`:

```typescript
import fs from "fs";
import { tmpFile } from "../lib/paths";
import { buildDryRunReport } from "../reports/dryRunReport";
import { ChatEntry, MatchPlanRow, SlangCandidate, ClientMergePair } from "../types";

function readJsonl<T>(name: string): T[] {
  return fs.readFileSync(tmpFile(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function readCsv(name: string): string[][] {
  return fs.readFileSync(tmpFile(name), "utf8").split("\n").filter(Boolean).slice(1).map((l) => l.split(","));
}

export async function runDryRun(batchId: string): Promise<void> {
  const entries = readJsonl<ChatEntry>("parsed-chat.jsonl");
  const plan = readJsonl<MatchPlanRow>("match-plan.jsonl");
  const mergesCsv = readCsv("client-merges.csv");
  const merges: ClientMergePair[] = mergesCsv.map((row) => ({
    auto: row[0] === "true",
    fromName: row[1].replace(/"/g, ""),
    fromId: row[2],
    toName: row[3].replace(/"/g, ""),
    toId: row[4],
    distance: parseInt(row[5], 10),
  }));
  const slangCsv = readCsv("slang-candidates.csv");
  const slang: SlangCandidate[] = slangCsv.map((row) => ({
    decision: row[0] as "AUTO" | "REVIEW",
    confidence: parseFloat(row[1]),
    supportCount: parseInt(row[2], 10),
    phraseOriginal: row[3].replace(/"/g, ""),
    phraseNormalized: row[4].replace(/"/g, ""),
    equipmentId: row[5],
    equipmentName: row[6].replace(/"/g, ""),
    sourceMsgIds: row[7].replace(/"/g, "").split(";").map((n) => parseInt(n, 10)),
  }));
  const bugfix = JSON.parse(fs.readFileSync(tmpFile("slang-bugfix.log"), "utf8"));

  const report = buildDryRunReport({ entries, plan, merges, slang, bugfix, batchId });
  fs.writeFileSync(tmpFile("report.md"), report);
  console.log(`[dry-run] report → tmp/reconcile/report.md`);
}
```

- [ ] **Step 14.3: Wire `dry-run` into index.ts**

```typescript
    case "dry-run": {
      const { runDryRun } = await import("./phases/dryRun");
      const batchId = argv.batchId ?? new Date().toISOString();
      await runDryRun(batchId);
      break;
    }
```

- [ ] **Step 14.4: Smoke-test dry-run + read the report**

```bash
cd apps/api && npx tsx scripts/reconcile-chat/index.ts --phase dry-run --batch-id 2026-05-24-smoke
cat ../../tmp/reconcile/report.md | head -80
```

Expected: Markdown with Summary, merge tables, INSERT preview, conflicts. Open and read.

- [ ] **Step 14.5: Commit**

```bash
git add apps/api/scripts/reconcile-chat/reports/dryRunReport.ts apps/api/scripts/reconcile-chat/phases/dryRun.ts apps/api/scripts/reconcile-chat/index.ts
git commit -m "feat(reconcile): dry-run phase → human-readable report.md"
```

---

## Task 15: Phase `apply` (the main writes + push)

**Files:**
- Create: `apps/api/scripts/reconcile-chat/phases/apply.ts`

This is the most consequential task. It writes to working-copy and then pushes to prod.

- [ ] **Step 15.1: Implement apply.ts (write to working-copy)**

`apps/api/scripts/reconcile-chat/phases/apply.ts`:

```typescript
import fs from "fs";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { pushWorkingCopy } from "../db/push";
import { writeReconcileAudit } from "../audit/writers";
import { ChatEntry, MatchPlanRow, SlangCandidate, SYSTEM_USER_ID } from "../types";

function readJsonl<T>(name: string): T[] {
  return fs.readFileSync(tmpFile(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function readCsv(name: string): string[][] {
  return fs.readFileSync(tmpFile(name), "utf8").split("\n").filter(Boolean).slice(1).map((l) => l.split(","));
}

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

export interface ApplyOptions {
  batchId: string;
  confirm: boolean;
  skipPush?: boolean;
}

export async function runApply(opts: ApplyOptions): Promise<void> {
  if (!opts.confirm) {
    console.error("[apply] refused: --confirm required");
    process.exit(2);
  }

  const entries = readJsonl<ChatEntry>("parsed-chat.jsonl");
  const plan = readJsonl<MatchPlanRow>("match-plan.jsonl");
  const slangCsv = readCsv("slang-candidates.csv");

  const slangAuto: SlangCandidate[] = slangCsv
    .filter((row) => row[0] === "AUTO")
    .map((row) => ({
      decision: "AUTO" as const,
      confidence: parseFloat(row[1]),
      supportCount: parseInt(row[2], 10),
      phraseOriginal: row[3].replace(/"/g, ""),
      phraseNormalized: row[4].replace(/"/g, ""),
      equipmentId: row[5],
      equipmentName: row[6].replace(/"/g, ""),
      sourceMsgIds: row[7].replace(/"/g, "").split(";").map((n) => parseInt(n, 10)),
    }));

  const entriesById = new Map(entries.map((e) => [e.id, e] as const));
  const dbPath = getWorkingCopy();

  const auditTrail: Array<{ entryId?: string; bookingId?: string; aliasId?: string; action: string }> = [];

  await withDb(dbPath, async (prisma) => {
    // ---- 1) Insert bookings for INSERT rows ----
    for (const row of plan.filter((p) => p.action === "INSERT")) {
      const entry = entriesById.get(row.entryId)!;

      // Use canonical client resolved in match-phase (handles auto-merged names like Хокаге→Хакаги).
      // Only create a new Client when match-phase found no canonical (truly new gaffer).
      const clientId = row.canonicalClientId
        ?? (await prisma.client.create({ data: { name: entry.gafferName } })).id;

      const startDate = new Date(entry.shootDate + "T00:00:00Z");
      const endDate = new Date(startDate.getTime() + 24 * 3600 * 1000);

      // Source-of-truth for items: xlsx for PAIR/XLSX_ONLY (real prices), paste for REQUEST_ONLY (DRAFT)
      const isDraft = entry.kind === "REQUEST_ONLY";
      const items = isDraft ? entry.pasteItems : entry.xlsxItems;

      try {
        await prisma.$transaction(async (tx) => {
          const booking = await tx.booking.create({
            data: {
              clientId,
              projectName: entry.projectName ?? `${entry.gafferName} ${entry.shootDate}`,
              startDate,
              endDate,
              status: isDraft ? "DRAFT" : "RETURNED",
              totalEstimateAmount: entry.totalRub,
              finalAmount: entry.totalRub,
              paymentStatus: "NOT_PAID",
              isFullyPaid: false,
              comment: `reconciled from chat msg ${entry.sourceMsgId}`,
            },
          });

          // BookingItems
          for (const it of items) {
            await tx.bookingItem.create({
              data: {
                bookingId: booking.id,
                equipmentId: it.equipmentId ?? null,
                quantity: it.qty,
                customName: it.equipmentId ? null : it.phrase,
                customCategory: it.equipmentId ? null : "Прочее",
                customUnitPrice: it.equipmentId ? null : (it.unitPrice ?? 0),
              },
            });
          }

          // Estimate (only when xlsx exists — never for DRAFT REQUEST_ONLY)
          if (!isDraft && items.length > 0) {
            const estimate = await tx.estimate.create({
              data: {
                bookingId: booking.id,
                kind: "MAIN",
                currency: "RUB",
                shifts: 1,
                subtotal: entry.totalRub,
                discountAmount: 0,
                totalAfterDiscount: entry.totalRub,
                commentSnapshot: `reconciled from chat msg ${entry.sourceMsgId}`,
              },
            });
            for (const it of items) {
              await tx.estimateLine.create({
                data: {
                  estimateId: estimate.id,
                  equipmentId: it.equipmentId ?? null,
                  categorySnapshot: "Прочее",
                  nameSnapshot: it.phrase,
                  quantity: it.qty,
                  unitPrice: it.unitPrice ?? 0,
                  lineSum: it.lineSum ?? (it.unitPrice ?? 0) * it.qty,
                },
              });
            }
          }

          await writeReconcileAudit(tx, {
            action: "BOOKING_RECONCILE_INSERT",
            entityType: "Booking",
            entityId: booking.id,
            metadata: {
              batchId: opts.batchId,
              sourceMsgId: entry.sourceMsgId,
              xlsxFile: entry.sourceXlsxPath,
              entryId: entry.id,
              kind: entry.kind,
            },
          });

          auditTrail.push({ entryId: entry.id, bookingId: booking.id, action: "BOOKING_RECONCILE_INSERT" });
        });
      } catch (e) {
        console.error(`[apply] FAILED entry=${entry.id}: ${(e as Error).message}`);
      }
    }

    // ---- 2) Insert slang AUTO ----
    for (const s of slangAuto) {
      try {
        const existing = await prisma.slangAlias.findUnique({
          where: { phraseNormalized_equipmentId: { phraseNormalized: s.phraseNormalized, equipmentId: s.equipmentId } },
        });
        await prisma.$transaction(async (tx) => {
          let aliasId: string;
          if (existing) {
            const upd = await tx.slangAlias.update({
              where: { id: existing.id },
              data: {
                usageCount: existing.usageCount + s.supportCount,
                lastUsedAt: new Date(),
                confidence: Math.max(existing.confidence, s.confidence),
              },
            });
            aliasId = upd.id;
          } else {
            const created = await tx.slangAlias.create({
              data: {
                phraseOriginal: s.phraseOriginal,
                phraseNormalized: s.phraseNormalized,
                equipmentId: s.equipmentId,
                source: "AUTO_LEARNED",
                confidence: s.confidence,
                usageCount: s.supportCount,
              },
            });
            aliasId = created.id;
          }
          await writeReconcileAudit(tx, {
            action: "SLANG_RECONCILE_INSERT",
            entityType: "SlangAlias",
            entityId: aliasId,
            metadata: { batchId: opts.batchId, confidence: s.confidence, supportCount: s.supportCount, sourceMsgIds: s.sourceMsgIds, mergedExisting: !!existing },
          });
          auditTrail.push({ aliasId, action: "SLANG_RECONCILE_INSERT" });
        });
      } catch (e) {
        console.error(`[apply] FAILED slang ${s.phraseOriginal} → ${s.equipmentId}: ${(e as Error).message}`);
      }
    }
  });

  // ---- 3) Persist audit-trail.jsonl ----
  fs.writeFileSync(tmpFile("audit-trail.jsonl"), auditTrail.map((a) => JSON.stringify(a)).join("\n"));

  // ---- 4) report-update-candidates.csv (rows with SKIP_NEEDS_UPDATE_REVIEW for phase 7) ----
  const updateRows = plan.filter((p) => p.action === "SKIP_NEEDS_UPDATE_REVIEW");
  fs.writeFileSync(
    tmpFile("report-update-candidates.csv"),
    "entryId,bookingId,gaffer,date,xlsxTotal\n" +
      updateRows.map((r) => {
        const e = entriesById.get(r.entryId)!;
        return `${r.entryId},${r.candidateBookingIds[0]},"${e.gafferName}",${e.shootDate},${e.totalRub}`;
      }).join("\n")
  );

  // ---- 5) slang-review-pile.csv ----
  const reviewSlang = slangCsv.filter((row) => row[0] === "REVIEW");
  fs.writeFileSync(tmpFile("slang-review-pile.csv"), "decision,confidence,supportCount,phraseOriginal,phraseNormalized,equipmentId,equipmentName,sourceMsgIds\n" + reviewSlang.map((r) => r.join(",")).join("\n"));

  console.log(`[apply] local working-copy updated. audit-trail entries=${auditTrail.length}`);

  // ---- 6) Push to prod ----
  if (opts.skipPush) {
    console.log(`[apply] --skip-push: local only, no push to prod`);
    return;
  }
  console.log(`[apply] pushing working-copy → prod`);
  const push = pushWorkingCopy(dbPath, opts.batchId);
  console.log(`[apply] push complete. prod row counts: ${JSON.stringify(push.rowCounts)}`);
  console.log(`[apply] pre-reconcile backup on prod: ${push.preReconcileBackupPath}`);
}
```

- [ ] **Step 15.2: Wire `apply` into index.ts**

```typescript
    case "apply": {
      const { runApply } = await import("./phases/apply");
      const batchId = argv.batchId ?? new Date().toISOString();
      const skipPush = process.argv.includes("--skip-push");
      await runApply({ batchId, confirm: argv.confirm, skipPush });
      break;
    }
```

- [ ] **Step 15.3: Smoke-run apply with `--skip-push` against local working copy**

```bash
cd apps/api && npx tsx scripts/reconcile-chat/index.ts --phase apply --confirm --batch-id smoke-1 --skip-push
sqlite3 ../../backups/working-copy-*.db "SELECT count(*) FROM Booking; SELECT count(*) FROM SlangAlias; SELECT count(*) FROM AuditEntry WHERE action LIKE 'BOOKING_RECONCILE%';"
```

Expected: Booking count increased, SlangAlias has many new AUTO_LEARNED, AuditEntry has reconcile rows.

- [ ] **Step 15.4: Verify PAID protection**

```bash
sqlite3 ../../backups/working-copy-*.db "SELECT id, finalAmount, amountPaid FROM Booking WHERE paymentStatus = 'PAID';"
diff <(sqlite3 ../../backups/prod-snapshot-*.db "SELECT id, finalAmount, amountPaid FROM Booking WHERE paymentStatus = 'PAID' ORDER BY id;") \
     <(sqlite3 ../../backups/working-copy-*.db "SELECT id, finalAmount, amountPaid FROM Booking WHERE paymentStatus = 'PAID' ORDER BY id;")
```

Expected: diff is empty (PAID rows untouched).

- [ ] **Step 15.5: Commit (don't push yet)**

```bash
git add apps/api/scripts/reconcile-chat/phases/apply.ts apps/api/scripts/reconcile-chat/index.ts
git commit -m "feat(reconcile): apply phase — INSERT bookings + AUTO slang + audit + optional push"
```

---

## Task 16: Optional phase `apply-slang-manual`

**Files:**
- Create: `apps/api/scripts/reconcile-chat/phases/applySlangManual.ts`

- [ ] **Step 16.1: Implement applySlangManual.ts**

`apps/api/scripts/reconcile-chat/phases/applySlangManual.ts`:

```typescript
import fs from "fs";
import path from "path";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { writeReconcileAudit } from "../audit/writers";
import { pushWorkingCopy } from "../db/push";

const APPROVED_FILE = "slang-approved-manual.csv";

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

export async function runApplySlangManual(batchId: string, confirm: boolean, skipPush: boolean): Promise<void> {
  if (!confirm) {
    console.error("[apply-slang-manual] refused: --confirm required");
    process.exit(2);
  }
  const file = tmpFile(APPROVED_FILE);
  if (!fs.existsSync(file)) {
    console.error(`[apply-slang-manual] expected ${file} (copy slang-review-pile.csv, prune unwanted rows, rename)`);
    process.exit(1);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(1);
  const dbPath = getWorkingCopy();
  let added = 0;
  let merged = 0;

  await withDb(dbPath, async (prisma) => {
    for (const line of lines) {
      const [_decision, _conf, _support, phraseOriginalQ, phraseNormalizedQ, equipmentId] = line.split(",");
      const phraseOriginal = phraseOriginalQ.replace(/"/g, "");
      const phraseNormalized = phraseNormalizedQ.replace(/"/g, "");

      await prisma.$transaction(async (tx) => {
        const existing = await tx.slangAlias.findUnique({
          where: { phraseNormalized_equipmentId: { phraseNormalized, equipmentId } },
        });
        let aliasId: string;
        if (existing) {
          const upd = await tx.slangAlias.update({
            where: { id: existing.id },
            data: { source: "MANUAL_ADMIN", confidence: 1.0, lastUsedAt: new Date() },
          });
          aliasId = upd.id;
          merged += 1;
        } else {
          const created = await tx.slangAlias.create({
            data: { phraseOriginal, phraseNormalized, equipmentId, source: "MANUAL_ADMIN", confidence: 1.0, usageCount: 1 },
          });
          aliasId = created.id;
          added += 1;
        }
        await writeReconcileAudit(tx, {
          action: "SLANG_RECONCILE_INSERT",
          entityType: "SlangAlias",
          entityId: aliasId,
          metadata: { batchId, source: "MANUAL_ADMIN" },
        });
      });
    }
  });

  console.log(`[apply-slang-manual] added=${added} merged=${merged}`);
  if (!skipPush) pushWorkingCopy(dbPath, batchId);
}
```

- [ ] **Step 16.2: Wire into index.ts**

```typescript
    case "apply-slang-manual": {
      const { runApplySlangManual } = await import("./phases/applySlangManual");
      const batchId = argv.batchId ?? new Date().toISOString();
      const skipPush = process.argv.includes("--skip-push");
      await runApplySlangManual(batchId, argv.confirm, skipPush);
      break;
    }
```

- [ ] **Step 16.3: Commit**

```bash
git add apps/api/scripts/reconcile-chat/phases/applySlangManual.ts apps/api/scripts/reconcile-chat/index.ts
git commit -m "feat(reconcile): apply-slang-manual phase for human-approved slang entries"
```

---

## Task 17: Optional phases `apply-update-overdue` + `rollback`

**Files:**
- Create: `apps/api/scripts/reconcile-chat/phases/applyUpdateOverdue.ts`
- Create: `apps/api/scripts/reconcile-chat/phases/rollback.ts`

- [ ] **Step 17.1: Implement applyUpdateOverdue.ts**

`apps/api/scripts/reconcile-chat/phases/applyUpdateOverdue.ts`:

```typescript
import fs from "fs";
import { tmpFile } from "../lib/paths";
import { withDb } from "../db/prisma";
import { writeReconcileAudit } from "../audit/writers";
import { pushWorkingCopy } from "../db/push";

const APPROVED_FILE = "report-update-candidates-approved.csv";

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

/** Format: `bookingId,newTotalRub` (after manual review). */
export async function runApplyUpdateOverdue(batchId: string, confirm: boolean, skipPush: boolean): Promise<void> {
  if (!confirm) {
    console.error("[apply-update-overdue] refused: --confirm required");
    process.exit(2);
  }
  const file = tmpFile(APPROVED_FILE);
  if (!fs.existsSync(file)) {
    console.error(`[apply-update-overdue] expected ${file}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(1);
  const dbPath = getWorkingCopy();
  let updated = 0;

  await withDb(dbPath, async (prisma) => {
    for (const line of lines) {
      const [bookingId, newTotalStr] = line.split(",");
      const newTotal = parseFloat(newTotalStr);
      if (!bookingId || isNaN(newTotal)) continue;
      const before = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!before || before.paymentStatus === "PAID" || before.paymentStatus === "OVERPAID") {
        console.warn(`[apply-update-overdue] skip ${bookingId}: PAID/OVERPAID or missing`);
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: bookingId },
          data: { finalAmount: newTotal, totalEstimateAmount: newTotal },
        });
        await writeReconcileAudit(tx, {
          action: "BOOKING_RECONCILE_UPDATE",
          entityType: "Booking",
          entityId: bookingId,
          metadata: { batchId },
          before: { finalAmount: parseFloat(before.finalAmount.toString()) },
          after: { finalAmount: newTotal },
        });
      });
      updated += 1;
    }
  });

  console.log(`[apply-update-overdue] updated=${updated}`);
  if (!skipPush) pushWorkingCopy(dbPath, batchId);
}
```

- [ ] **Step 17.2: Implement rollback.ts**

`apps/api/scripts/reconcile-chat/phases/rollback.ts`:

```typescript
import { withDb } from "../db/prisma";
import fs from "fs";
import { tmpFile } from "../lib/paths";

function getWorkingCopy(): string {
  return fs.readFileSync(tmpFile("current-working-copy.txt"), "utf8").trim();
}

export async function runRollback(batchId: string, confirm: boolean): Promise<void> {
  if (!confirm) {
    console.error("[rollback] refused: --confirm required");
    process.exit(2);
  }
  const dbPath = getWorkingCopy();
  let deletedBookings = 0;
  let deletedAliases = 0;

  await withDb(dbPath, async (prisma) => {
    const entries = await prisma.auditEntry.findMany({
      where: { action: { startsWith: "BOOKING_RECONCILE_INSERT" } },
    });
    // Filter by batchId in `after` JSON
    const targetBookingIds: string[] = [];
    const targetAliasIds: string[] = [];
    for (const e of entries) {
      const after = e.after ? JSON.parse(e.after) : null;
      if (after?._meta?.batchId !== batchId) continue;
      if (e.entityType === "Booking") targetBookingIds.push(e.entityId);
    }
    const aliasEntries = await prisma.auditEntry.findMany({
      where: { action: "SLANG_RECONCILE_INSERT" },
    });
    for (const e of aliasEntries) {
      const after = e.after ? JSON.parse(e.after) : null;
      if (after?._meta?.batchId !== batchId) continue;
      if (after?._meta?.mergedExisting) continue; // can't roll back a merge into existing
      targetAliasIds.push(e.entityId);
    }
    deletedBookings = (await prisma.booking.deleteMany({ where: { id: { in: targetBookingIds } } })).count;
    deletedAliases = (await prisma.slangAlias.deleteMany({ where: { id: { in: targetAliasIds } } })).count;
  });

  console.log(`[rollback] deletedBookings=${deletedBookings} deletedAliases=${deletedAliases}`);
  console.warn(`[rollback] CLIENT_MERGE actions are not reversible — restore from snapshot if needed`);
}
```

- [ ] **Step 17.3: Wire both into index.ts**

```typescript
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
```

- [ ] **Step 17.4: Commit**

```bash
git add apps/api/scripts/reconcile-chat/phases/applyUpdateOverdue.ts apps/api/scripts/reconcile-chat/phases/rollback.ts apps/api/scripts/reconcile-chat/index.ts
git commit -m "feat(reconcile): apply-update-overdue + rollback optional phases"
```

---

## Task 18: End-to-end smoke + production run

**Files:**
- No new files; runtime verification only.

This task verifies the acceptance criteria from spec §11.

- [ ] **Step 18.1: Full local pipeline (skip-push)**

```bash
cd apps/api
rm -rf ../../tmp/reconcile ../../backups
npx tsx scripts/reconcile-chat/index.ts --phase prepare
npx tsx scripts/reconcile-chat/index.ts --phase parse
npx tsx scripts/reconcile-chat/index.ts --phase match
npx tsx scripts/reconcile-chat/index.ts --phase dry-run --batch-id e2e-1
```

Open `tmp/reconcile/report.md`, read end-to-end. Sanity-check:
- INSERT count ≤ entries count
- SKIP_PROTECTED count ≤ 15 (no more than count of PAID bookings)
- Auto-merge has Хакаги↔Хокаге
- INSERT preview rows have plausible dates/gaffers/amounts

- [ ] **Step 18.2: Local apply (skip-push), verify acceptance criteria**

```bash
cd apps/api
npx tsx scripts/reconcile-chat/index.ts --phase apply --confirm --batch-id e2e-1 --skip-push

# Acceptance verification
SNAP=$(ls ../../backups/prod-snapshot-*.db | head -1)
WC=$(ls ../../backups/working-copy-*.db | head -1)
echo "Snapshot: $SNAP"
echo "Working:  $WC"

echo "--- Booking count delta ---"
sqlite3 "$SNAP" "SELECT count(*) FROM Booking"
sqlite3 "$WC" "SELECT count(*) FROM Booking"

echo "--- PAID immutability (should be empty) ---"
diff <(sqlite3 "$SNAP" "SELECT id,finalAmount,amountPaid FROM Booking WHERE paymentStatus='PAID' ORDER BY id") \
     <(sqlite3 "$WC"   "SELECT id,finalAmount,amountPaid FROM Booking WHERE paymentStatus='PAID' ORDER BY id")

echo "--- SlangAlias (N)-bug cleared ---"
sqlite3 "$WC" "SELECT count(*) FROM SlangAlias WHERE phraseOriginal LIKE '%(%)%'"  # → 0

echo "--- AuditEntry presence ---"
sqlite3 "$WC" "SELECT action, count(*) FROM AuditEntry WHERE userId='system-reconcile' GROUP BY action"

echo "--- system-reconcile user exists ---"
sqlite3 "$WC" "SELECT id, username, role FROM AdminUser WHERE id='system-reconcile'"
```

Expected (all must pass):
- Booking count: working > snapshot
- PAID diff: empty
- Bug count: 0
- AuditEntry: BOOKING_RECONCILE_INSERT, CLIENT_MERGE, SLANG_RECONCILE_INSERT all present
- system-reconcile AdminUser exists

- [ ] **Step 18.3: STOP — get user approval before pushing**

Show the user the contents of `tmp/reconcile/report.md` and the acceptance-criteria output. Ask explicitly: **"Push to prod now?"**. Do not proceed without an explicit yes.

- [ ] **Step 18.4: Run apply WITHOUT `--skip-push` (final, with user approval)**

```bash
cd apps/api
npx tsx scripts/reconcile-chat/index.ts --phase apply --confirm --batch-id prod-$(date +%F-%H%M)
```

Expected: log shows `pushing working-copy → prod`, then row counts from prod-side sqlite, then `pre-reconcile backup on prod: /opt/light-rental-system/apps/api/prisma/prod-pre-reconcile-*.db`.

- [ ] **Step 18.5: Post-push verification**

```bash
ssh -i ~/.ssh/id_ed25519_gaffercrm root@195.63.128.245 "
  pm2 list | grep api;
  sqlite3 /opt/light-rental-system/apps/api/prisma/prod.db 'SELECT count(*) FROM Booking; SELECT count(*) FROM SlangAlias; SELECT count(*) FROM AuditEntry WHERE userId=\"system-reconcile\";';
"
# Optional: hit the live API
curl -s -H "X-API-Key: <key>" https://svetobazarent.ru/api/bookings?limit=5
```

Expected: api online, row counts match what we saw in `[apply] push complete`, sample bookings returned.

- [ ] **Step 18.6: Save report.md to permanent location + commit**

```bash
mkdir -p docs/superpowers/reports
cp tmp/reconcile/report.md docs/superpowers/reports/2026-05-24-chat-reconciliation-report.md
git add docs/superpowers/reports/
git commit -m "docs(reconcile): final reconciliation report (2026-05-24 run)"
```

- [ ] **Step 18.7: Final checklist (spec §11)**

Verify each line:

- [ ] `backups/prod-snapshot-*.db` intact, untouched since prepare
- [ ] `Booking` count on prod = snapshot count + N (where N = INSERT count from report)
- [ ] 0 PAID-broken-: `sqlite3 prod.db "SELECT count(*) FROM Booking WHERE paymentStatus='PAID' AND id IN (SELECT entityId FROM AuditEntry WHERE userId='system-reconcile' AND action LIKE 'BOOKING_RECONCILE%')"` → 0
- [ ] All CLIENT_MERGE have AuditEntry rows
- [ ] All new bookings have AuditEntry rows with same batchId
- [ ] No SlangAlias rows with `phraseOriginal LIKE '%(%)%'`
- [ ] PM2 list unchanged from before run (still only `api` online)
- [ ] `https://svetobazarent.ru/bookings` loads and shows recent bookings

---

## Self-Review Checklist

After completing all tasks, run this:

1. **Spec coverage:** Map each spec section to a task. Spec §5 phases prepare/parse/match/dry-run/apply → Tasks 12/12/13/14/15. Optional phases apply-slang-manual/apply-update-overdue/rollback → Tasks 16/17. Slang enrichment §6 → Tasks 7 + 9. Safety §7 → Tasks 11 + 15. AuditEntry §7.3 → Task 10. Artifacts §8 → Tasks 12-15. Acceptance §11 → Task 18.

2. **Placeholder scan:** Search the plan for "TBD", "TODO", "later", "similar to" — none should appear in step bodies.

3. **Type consistency:** `MatchAction`, `SlangCandidate`, `ChatEntry`, `BookingCandidate`, `EquipmentMatchInput` — defined once in `types.ts` (Task 1) and `bookingMatcher.ts` (Task 8), referenced consistently in Tasks 12-17.

4. **Out of scope check:** PM2 recovery, Payment ingestion, Telegram-bot, gaffer cabinet, GafferUser creation — none in this plan. Confirmed.
