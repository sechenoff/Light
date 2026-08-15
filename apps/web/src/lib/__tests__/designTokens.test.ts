import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Сторож против «фантомных» цветовых классов.
//
// Tailwind не ругается на `bg-surface-deep`, если токена `surface.deep` нет —
// он просто не генерирует правило, и элемент молча остаётся прозрачным. Такую
// опечатку не ловят ни tsc, ни тесты, ни ревью: в вёрстке она выглядит
// правдоподобно. За время жизни проекта так накопилось семь семейств
// (surface-deep, ink-1, inverse-2, border-bright, accent-hover, ok-border,
// surface-s) — часть годами рисовала не тот фон, что задумывали.
//
// Тест проверяет только классы, ПОХОЖИЕ на наши токены: корень совпадает с
// объявленным (surface-*, ink-*, accent-*…), а суффикса в палитре нет.
// Числовые оттенки Tailwind (slate-400, green-200) не трогаем — они валидны.

const WEB_ROOT = path.resolve(__dirname, "../../..");

/** Утилиты Tailwind, которые принимают цвет. */
const COLOR_UTILS = [
  "bg", "text", "border", "ring", "fill", "stroke", "from", "via", "to",
  "divide", "outline", "decoration", "accent", "shadow", "caret", "placeholder",
];

/** Палитры самого Tailwind — у них свои суффиксы-оттенки. */
const TAILWIND_PALETTES = new Set([
  "inherit", "current", "transparent", "black", "white",
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber",
  "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "fuchsia", "pink", "rose",
]);

/**
 * Конфликт-копии iCloud вида «page 2.tsx» / «AliasRow 3.tsx» лежат рядом с
 * оригиналами, но в git их нет и в сборку они не попадают. Сторож на них
 * спотыкался и падал у всех, у кого включена синхронизация, — то есть врал
 * про код, которого в проекте не существует. Пропускаем их явно.
 */
const ICLOUD_CONFLICT_COPY = / \d+\.(tsx|ts)$/;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.next|\.turbo/.test(full)) collectSourceFiles(full, acc);
    } else if (/\.(tsx|ts)$/.test(entry.name) && !ICLOUD_CONFLICT_COPY.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("цветовые токены", () => {
  it("в разметке нет классов с несуществующим токеном", async () => {
    // Конфиг — CommonJS: динамический импорт кладёт module.exports в default.
    const mod = await import(path.join(WEB_ROOT, "tailwind.config.js"));
    const config = (mod.default ?? mod) as {
      theme?: { extend?: { colors?: Record<string, unknown> } };
    };
    const colors: Record<string, unknown> = config.theme?.extend?.colors ?? {};

    const declared = new Set<string>();
    const roots = new Set<string>();
    for (const [name, value] of Object.entries(colors)) {
      roots.add(name);
      if (typeof value !== "object" || value === null) {
        declared.add(name);
        continue;
      }
      for (const suffix of Object.keys(value as Record<string, unknown>)) {
        declared.add(suffix === "DEFAULT" ? name : `${name}-${suffix}`);
      }
    }

    const pattern = new RegExp(
      `\\b(?:${COLOR_UTILS.join("|")})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\\b`,
      "g",
    );

    const offenders: string[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "src")).concat(
      collectSourceFiles(path.join(WEB_ROOT, "app")),
    )) {
      // Этот файл перечисляет исторические опечатки в комментарии — иначе
      // сторож ловил бы сам себя.
      if (file === __filename) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        const token = match[1];
        const root = token.split("-")[0];
        if (TAILWIND_PALETTES.has(root)) continue; // оттенок Tailwind
        if (!roots.has(root)) continue; // вообще не наш токен
        if (declared.has(token)) continue; // объявлен
        offenders.push(`${path.relative(WEB_ROOT, file)}: ${token}`);
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });
});
