import "dotenv/config";

import { prisma } from "../src/prisma";

/**
 * Проставляет номера документов броням, заведённым до появления нумерации.
 *
 * Порядок — по дате создания: номер обязан отражать очерёдность, иначе
 * «СМ-2026-0007» окажется старше «СМ-2026-0003» и бухгалтерия будет права,
 * что документам нельзя верить. Год берётся из даты создания самой брони,
 * а не сегодняшний: бронь мая 2026 должна получить номер 2026 года.
 *
 * Идемпотентен: брони с уже проставленным номером пропускаются.
 *
 *   npx tsx scripts/backfill-doc-numbers.ts            # сухой прогон
 *   npx tsx scripts/backfill-doc-numbers.ts --execute  # запись
 */
async function main() {
  const execute = process.argv.includes("--execute");

  const bookings = await prisma.booking.findMany({
    where: { docNumber: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, projectName: true },
  });

  if (bookings.length === 0) {
    console.log("Все брони уже пронумерованы.");
    return;
  }

  // Стартовые счётчики по годам — с учётом уже занятых номеров.
  const taken = await prisma.booking.findMany({
    where: { docNumber: { not: null } },
    select: { docNumber: true },
  });
  const seqByYear = new Map<number, number>();
  for (const { docNumber } of taken) {
    const m = /^СМ-(\d{4})-(\d+)$/.exec(docNumber ?? "");
    if (!m) continue;
    const year = Number(m[1]);
    const seq = Number(m[2]);
    seqByYear.set(year, Math.max(seqByYear.get(year) ?? 0, seq));
  }

  const plan: Array<{ id: string; number: string; project: string }> = [];
  for (const b of bookings) {
    const year = b.createdAt.getFullYear();
    const next = (seqByYear.get(year) ?? 0) + 1;
    seqByYear.set(year, next);
    plan.push({
      id: b.id,
      number: `СМ-${year}-${String(next).padStart(4, "0")}`,
      project: b.projectName,
    });
  }

  console.log(`Броней без номера: ${plan.length}`);
  for (const p of plan.slice(0, 5)) console.log(`  ${p.number}  ${p.project}`);
  if (plan.length > 5) console.log(`  … и ещё ${plan.length - 5}`);

  if (!execute) {
    console.log("\nСухой прогон. Для записи: npx tsx scripts/backfill-doc-numbers.ts --execute");
    return;
  }

  let done = 0;
  for (const p of plan) {
    await prisma.booking.update({ where: { id: p.id }, data: { docNumber: p.number } });
    done += 1;
  }
  console.log(`Проставлено номеров: ${done}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
