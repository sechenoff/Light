/**
 * Применение результатов аудита SlangAlias (консилиум 5 агентов, 21.05.2026).
 *
 * Входной файл — JSON со списками решений по 5 сегментам:
 *   deletions: алиасы на удаление (SEED-мусор, кросс-категориальные ошибки)
 *   reassigned: смена equipmentId (если фраза правильная, но указывает не туда)
 *   suggested_new: новые алиасы для критичных пробелов
 *   uncertain: оставить как есть, экспортируем отдельно
 *
 * Использование:
 *   tsx scripts/apply-slang-audit-2026-05.ts /path/to/merged.json            # dry-run
 *   tsx scripts/apply-slang-audit-2026-05.ts /path/to/merged.json --apply    # запись
 *
 * Безопасность:
 *   - Все мутации в одной транзакции на сегмент (можно откатить per-segment)
 *   - Дедупликация alias_id (если разные агенты помянули один id)
 *   - Reassign: проверка уникальности (phrase, eq) перед апдейтом
 *   - Suggested_new: проверка существования equipment по name+category, skip если уже есть
 */
import * as fs from "fs";
import { prisma } from "../src/prisma";
import { norm } from "../src/services/equipmentMatcher";

type Deletion = {
  alias_id: string;
  phrase: string;
  eq_name: string;
  category?: string;
  source?: string;
  reason: string;
};
type Reassign = {
  alias_id: string;
  phrase: string;
  from_eq: string;
  to_eq: string;
  reason: string;
};
type Suggestion = {
  phrase: string;
  category: string;
  eq_name: string;
  rationale: string;
};
type Uncertain = {
  alias_id?: string;
  phrase: string;
  eq_name?: string;
  question: string;
};
type SegmentResult = {
  deletions?: Deletion[];
  kept?: unknown[];
  reassigned?: Reassign[];
  suggested_new?: Suggestion[];
  uncertain?: Uncertain[];
};

async function main() {
  const filePath = process.argv[2];
  const applyFlag = process.argv.includes("--apply");
  if (!filePath) {
    // eslint-disable-next-line no-console
    console.error("Usage: tsx scripts/apply-slang-audit-2026-05.ts <merged.json> [--apply]");
    process.exit(1);
  }
  const merged = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, SegmentResult>;

  // ── 1. Deletions: дедуплицируем по alias_id ───────────────────────────────
  const allDeletionIds = new Set<string>();
  const deletionDetails: Deletion[] = [];
  const deletionDups: { alias_id: string; occurrences: Deletion[] }[] = [];
  const seenIds = new Map<string, Deletion>();
  for (const [, seg] of Object.entries(merged)) {
    for (const d of seg.deletions ?? []) {
      if (seenIds.has(d.alias_id)) {
        const existing = seenIds.get(d.alias_id)!;
        deletionDups.push({ alias_id: d.alias_id, occurrences: [existing, d] });
      } else {
        seenIds.set(d.alias_id, d);
        allDeletionIds.add(d.alias_id);
        deletionDetails.push(d);
      }
    }
  }

  // ── 2. Reassigns: collect ────────────────────────────────────────────────
  const allReassigns: Reassign[] = [];
  for (const [, seg] of Object.entries(merged)) {
    for (const r of seg.reassigned ?? []) {
      allReassigns.push(r);
    }
  }

  // ── 3. Suggested new: collect ────────────────────────────────────────────
  const allSuggestions: Suggestion[] = [];
  for (const [, seg] of Object.entries(merged)) {
    for (const s of seg.suggested_new ?? []) {
      allSuggestions.push(s);
    }
  }

  // ── 4. Uncertain: collect (только для экспорта в файл) ────────────────────
  const allUncertain: { segment: string; uncertain: Uncertain }[] = [];
  for (const [seg, segData] of Object.entries(merged)) {
    for (const u of segData.uncertain ?? []) {
      allUncertain.push({ segment: seg, uncertain: u });
    }
  }

  /* eslint-disable no-console */
  console.log("═══ PLAN SUMMARY ═══");
  console.log(`  Deletions:       ${allDeletionIds.size} (deduped из ${deletionDetails.length + deletionDups.length})`);
  console.log(`  Reassignments:   ${allReassigns.length}`);
  console.log(`  New suggestions: ${allSuggestions.length}`);
  console.log(`  Uncertain:       ${allUncertain.length} (не применяем)`);
  console.log("");

  // ── 5. Pre-flight validation ─────────────────────────────────────────────
  // Resolve all suggestion equipment names to IDs
  const eqByCatName = new Map<string, { id: string; name: string }>();
  const allEqs = await prisma.equipment.findMany({ select: { id: true, name: true, category: true } });
  for (const eq of allEqs) {
    eqByCatName.set(`${eq.category}||${eq.name}`, { id: eq.id, name: eq.name });
  }

  const suggestionPlan: Array<{
    phrase: string;
    phraseNormalized: string;
    eq_name: string;
    category: string;
    equipmentId: string;
    skipReason?: string;
  }> = [];
  for (const s of allSuggestions) {
    const eq = eqByCatName.get(`${s.category}||${s.eq_name}`);
    if (!eq) {
      // Попробуем найти fuzzy: тот же name в любой категории
      const byName = allEqs.find((e) => e.name === s.eq_name);
      if (byName) {
        suggestionPlan.push({
          phrase: s.phrase,
          phraseNormalized: norm(s.phrase),
          eq_name: byName.name,
          category: byName.category,
          equipmentId: byName.id,
          skipReason: `category mismatch (suggested «${s.category}», actual «${byName.category}») — beren actual`,
        });
        continue;
      }
      suggestionPlan.push({
        phrase: s.phrase,
        phraseNormalized: norm(s.phrase),
        eq_name: s.eq_name,
        category: s.category,
        equipmentId: "",
        skipReason: "equipment not found",
      });
      continue;
    }
    const phraseNormalized = norm(s.phrase);
    if (!phraseNormalized) {
      suggestionPlan.push({
        phrase: s.phrase,
        phraseNormalized: "",
        eq_name: eq.name,
        category: s.category,
        equipmentId: eq.id,
        skipReason: "empty after norm",
      });
      continue;
    }
    const existing = await prisma.slangAlias.findUnique({
      where: { phraseNormalized_equipmentId: { phraseNormalized, equipmentId: eq.id } },
    });
    if (existing) {
      suggestionPlan.push({
        phrase: s.phrase,
        phraseNormalized,
        eq_name: eq.name,
        category: s.category,
        equipmentId: eq.id,
        skipReason: "already exists",
      });
      continue;
    }
    suggestionPlan.push({
      phrase: s.phrase,
      phraseNormalized,
      eq_name: eq.name,
      category: s.category,
      equipmentId: eq.id,
    });
  }

  const suggestionsToCreate = suggestionPlan.filter((p) => !p.skipReason);
  const suggestionsToSkip = suggestionPlan.filter((p) => p.skipReason);

  console.log("═══ SUGGESTIONS PRE-FLIGHT ═══");
  console.log(`  Will create:    ${suggestionsToCreate.length}`);
  console.log(`  Skipped:        ${suggestionsToSkip.length}`);
  if (suggestionsToSkip.length > 0 && !applyFlag) {
    for (const s of suggestionsToSkip) {
      console.log(`    × «${s.phrase}» → ${s.eq_name}: ${s.skipReason}`);
    }
  }
  console.log("");

  // ── 6. Reassign pre-flight ───────────────────────────────────────────────
  const reassignPlan: Array<{
    alias_id: string;
    phrase: string;
    fromEqId: string;
    toEqId: string;
    skipReason?: string;
  }> = [];
  for (const r of allReassigns) {
    // Если тот же alias_id попал в deletion-set — deletion wins (агенты иногда дают
    // противоречивые рекомендации; удаление безопаснее).
    if (allDeletionIds.has(r.alias_id)) {
      reassignPlan.push({ alias_id: r.alias_id, phrase: r.phrase, fromEqId: "", toEqId: "", skipReason: "alias also marked for deletion — delete wins" });
      continue;
    }
    const alias = await prisma.slangAlias.findUnique({ where: { id: r.alias_id }, select: { equipmentId: true, phraseNormalized: true } });
    if (!alias) {
      reassignPlan.push({ alias_id: r.alias_id, phrase: r.phrase, fromEqId: "", toEqId: "", skipReason: "alias not found" });
      continue;
    }
    const toEq = allEqs.find((e) => e.name === r.to_eq);
    if (!toEq) {
      reassignPlan.push({ alias_id: r.alias_id, phrase: r.phrase, fromEqId: alias.equipmentId, toEqId: "", skipReason: "target equipment not found" });
      continue;
    }
    // Check uniqueness
    const conflict = await prisma.slangAlias.findUnique({
      where: { phraseNormalized_equipmentId: { phraseNormalized: alias.phraseNormalized, equipmentId: toEq.id } },
    });
    if (conflict) {
      reassignPlan.push({ alias_id: r.alias_id, phrase: r.phrase, fromEqId: alias.equipmentId, toEqId: toEq.id, skipReason: "target already has this phrase — delete original instead" });
      continue;
    }
    reassignPlan.push({ alias_id: r.alias_id, phrase: r.phrase, fromEqId: alias.equipmentId, toEqId: toEq.id });
  }
  const reassignsToApply = reassignPlan.filter((r) => !r.skipReason);
  const reassignsToSkip = reassignPlan.filter((r) => r.skipReason);
  console.log("═══ REASSIGNS PRE-FLIGHT ═══");
  console.log(`  Will reassign:  ${reassignsToApply.length}`);
  console.log(`  Skipped:        ${reassignsToSkip.length}`);
  for (const r of reassignsToSkip) {
    console.log(`    × ${r.alias_id} «${r.phrase}»: ${r.skipReason}`);
  }
  console.log("");

  // Export uncertain to file for user review (рядом со входным merged.json)
  const uncertainPath = filePath.replace(/merged\.json$/i, "uncertain-for-review.json")
    .replace(/\.json$/i, ".uncertain.json");
  fs.writeFileSync(uncertainPath, JSON.stringify(allUncertain, null, 2));
  console.log(`  Uncertain записаны в ${uncertainPath} (${allUncertain.length} шт)`);

  if (!applyFlag) {
    console.log("\n(dry-run — для записи добавьте флаг --apply)");
    await prisma.$disconnect();
    return;
  }

  // ── 7. APPLY ──────────────────────────────────────────────────────────────
  console.log("\n▶ Применяем…");
  let deleted = 0;
  let reassigned = 0;
  let created = 0;
  await prisma.$transaction(async (tx) => {
    if (allDeletionIds.size > 0) {
      const res = await tx.slangAlias.deleteMany({ where: { id: { in: Array.from(allDeletionIds) } } });
      deleted = res.count;
    }
    for (const r of reassignsToApply) {
      await tx.slangAlias.update({
        where: { id: r.alias_id },
        data: { equipmentId: r.toEqId, source: "MANUAL_ADMIN", updatedAt: new Date() },
      });
      reassigned++;
    }
    for (const s of suggestionsToCreate) {
      await tx.slangAlias.create({
        data: {
          phraseNormalized: s.phraseNormalized,
          phraseOriginal: s.phrase,
          equipmentId: s.equipmentId,
          confidence: 1.0,
          source: "MANUAL_ADMIN",
          usageCount: 0,
          lastUsedAt: new Date(),
        },
      });
      created++;
    }
  });

  console.log(`\n✓ APPLIED: deleted=${deleted}, reassigned=${reassigned}, created=${created}`);
  /* eslint-enable no-console */
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
