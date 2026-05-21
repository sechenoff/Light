/**
 * Добавляет сленговые псевдонимы (SlangAlias) для 19 новых позиций
 * из сметы 05.2026. Источник: MANUAL_ADMIN. Идемпотентно — upsert по
 * (phraseNormalized, equipmentId).
 *
 * Использование:
 *   tsx scripts/add-slang-aliases-smeta-may-2026.ts            # dry-run
 *   tsx scripts/add-slang-aliases-smeta-may-2026.ts --apply    # запись
 *
 * Конвенции:
 *   - Сленг — то, как обычно произносят/пишут гафёры в смете-заявке.
 *   - Избегаем коллизий: если фраза «линза 10» неоднозначна между CF10
 *     и другими — берём более конкретное «линза cf10», «цф10».
 *   - phraseOriginal — то, что я ввожу. phraseNormalized считает norm().
 */
import { prisma } from "../src/prisma";
import { norm } from "../src/services/equipmentMatcher";
import { computeImportKey } from "../src/services/equipmentImport";

type Spec = {
  category: string;
  name: string;
  aliases: string[];
};

const SPECS: Spec[] = [
  {
    category: "COB Light",
    name: "Aputure STORM 700x",
    aliases: ["сторм 700", "шторм 700", "storm 700", "700х", "700х шторм", "апутура сторм 700"],
  },
  {
    category: "Насадки на приборы",
    name: "Софтбокс Aputure Light Dome AM150 для xt52/xt26",
    // NB: «лайт дом 150» сознательно не берём — пересекается с Light Dome 150 Bowens (другая позиция)
    aliases: ["софтбокс ам150", "ам150", "am150", "софт для xt52", "софт для xt26", "софт для 52xt", "софт для 26xt", "софтбокс am150"],
  },
  {
    category: "Насадки на приборы",
    name: "Чайнабол Aputure Lattern 120cm для xt52/xt26",
    aliases: ["чайнабол 120", "латерн 120", "lantern 120", "фонарь 120", "чайник 120", "чайнабол для xt52", "чайнабол для xt26", "lantern 120cm"],
  },
  {
    category: "Насадки на приборы",
    name: "Линза френеля Aputure CF10 (для 700х)",
    // NB: «линза 10» не берём — слишком общо. Только конкретный шифр модели.
    aliases: ["линза cf10", "цф10", "cf10", "френель cf10", "линза для 700х", "френель для 700х", "линза 700х"],
  },
  {
    category: "Штативы / Стойки",
    name: "Штатив 5-ти метровый",
    aliases: ["5 метровый", "пятиметровый", "пятиметровка", "штатив 5 метров", "штатив пять метров", "5м штатив", "5 метровая стойка"],
  },
  {
    category: "Текстиль",
    name: "Текстиль 20' х 20'  MattBounce/Ultrabounce",
    aliases: ["20 на 20 баунс", "20х20 ультрабаунс", "20х20 mb", "20 матт", "20 баунс", "20х20 mattbounce", "20х20 ultrabounce", "20 ультрабаунс"],
  },
  {
    category: "Периферия",
    name: "Фалл 10-15м",
    aliases: ["фалл", "фалы", "фалл 10", "фалл 15", "стропа фалл", "веревка фалл"],
  },
  {
    category: "Трубы",
    name: "Трубы 1,8м D48",
    aliases: ["труба 1 8 d48", "труба 48 1 8", "1 8м 48", "d48 1 8м", "труба 1 8 48", "сорокавосьмая 1 8"],
  },
  {
    category: "Грип",
    name: "ChineVise Grip (цепной)",
    aliases: ["цепной зажим", "chinevise", "chine vise", "chain vise", "цепной грип", "цепной чайнвайс"],
  },
  {
    category: "Грип",
    name: "Coupler - 28палец",
    aliases: ["купплер 28", "coupler 28", "купплер с 28 пальцем", "coupler 28 палец", "куплер 28", "куплер 28 палец"],
  },
  {
    category: "Грип",
    name: "Coupler строительный 360",
    aliases: ["строительный куплер", "куплер 360", "coupler 360", "строй куплер", "купплер 360", "строительный coupler"],
  },
  {
    category: "Грип",
    name: "Стропа 6-10м",
    aliases: ["длинная стропа", "стропа большая", "стропа 6м", "стропа 10м", "длинная стяжка", "стяжка большая", "стропа 6 10м"],
  },
  {
    category: "Грип",
    name: "Лира для фермакран",
    aliases: ["лира фермакран", "фермакран лира", "лира для крана", "лира фарма", "лира для фарма", "лира фермы"],
  },
  {
    category: "Электрика/Коммутация",
    name: "Кабель 125А красный (10м)",
    aliases: ["125 ампер", "125а", "125 красный", "красный кабель 125", "125 кабель", "кабель 125", "125 а 10м"],
  },
  {
    category: "Электрика/Коммутация",
    name: "Кабель 63/380  (10-29м)",
    aliases: ["кабель 63 380", "63 380", "63а 380в", "63 трёхфазный", "63а трехфазный", "63 трехфазный", "шестидесяттри 380"],
  },
  {
    category: "Электрика/Коммутация",
    name: "Кабель 32/380 (12-30м)",
    aliases: ["кабель 32 380", "32 380", "32а 380в", "32 трёхфазный", "32а трехфазный", "32 трехфазный", "тридцатьдва 380"],
  },
  {
    category: "Электрика/Коммутация",
    name: "Сопля 63/380",
    aliases: ["сопля 63", "сопля 63 380", "сопелька 63", "коротыш 63", "сопля шестьдесят три"],
  },
  {
    category: "Электрика/Коммутация",
    name: "Сопля 32/380 ",
    aliases: ["сопля 32", "сопля 32 380", "сопелька 32", "коротыш 32", "сопля тридцать два"],
  },
  {
    category: "Электрика/Коммутация",
    name: "Диммер 220",
    aliases: ["диммер", "диммер 220в", "регулятор 220", "диммер двести двадцать"],
  },
];

type Plan =
  | { kind: "create"; equipmentId: string; equipmentName: string; phraseOriginal: string; phraseNormalized: string }
  | { kind: "exists"; equipmentId: string; equipmentName: string; phraseOriginal: string; phraseNormalized: string }
  | { kind: "conflict"; phraseNormalized: string; phraseOriginal: string; intendedEquipmentName: string; existingEquipmentNames: string[] }
  | { kind: "missing-equipment"; category: string; name: string };

async function buildPlan(): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (const spec of SPECS) {
    const importKey = computeImportKey({ category: spec.category, name: spec.name, brand: "", model: "" });
    const eq = await prisma.equipment.findUnique({ where: { importKey }, select: { id: true, name: true } });
    if (!eq) {
      plans.push({ kind: "missing-equipment", category: spec.category, name: spec.name });
      continue;
    }
    for (const phraseOriginal of spec.aliases) {
      const phraseNormalized = norm(phraseOriginal);
      if (!phraseNormalized) continue;

      const sameEqRow = await prisma.slangAlias.findUnique({
        where: { phraseNormalized_equipmentId: { phraseNormalized, equipmentId: eq.id } },
      });
      if (sameEqRow) {
        plans.push({ kind: "exists", equipmentId: eq.id, equipmentName: eq.name, phraseOriginal, phraseNormalized });
        continue;
      }

      // Конфликт: эта же фраза уже привязана к ДРУГОМУ оборудованию
      const otherRows = await prisma.slangAlias.findMany({
        where: { phraseNormalized, NOT: { equipmentId: eq.id } },
        select: { equipment: { select: { name: true } } },
      });
      if (otherRows.length > 0) {
        plans.push({
          kind: "conflict",
          phraseNormalized,
          phraseOriginal,
          intendedEquipmentName: eq.name,
          existingEquipmentNames: otherRows.map((r) => r.equipment.name),
        });
        continue;
      }

      plans.push({ kind: "create", equipmentId: eq.id, equipmentName: eq.name, phraseOriginal, phraseNormalized });
    }
  }
  return plans;
}

function printPlan(plans: Plan[]) {
  const create = plans.filter((p) => p.kind === "create").length;
  const exists = plans.filter((p) => p.kind === "exists").length;
  const conflict = plans.filter((p) => p.kind === "conflict").length;
  const missing = plans.filter((p) => p.kind === "missing-equipment").length;

  /* eslint-disable no-console */
  console.log("");
  console.log("═══ PLAN SUMMARY ═══");
  console.log(`  Будет создано:    ${create}`);
  console.log(`  Уже существует:   ${exists}`);
  console.log(`  Конфликт:         ${conflict}`);
  console.log(`  Нет оборудования: ${missing}`);
  console.log("");

  if (missing > 0) {
    console.log("═══ НЕ НАЙДЕНО ОБОРУДОВАНИЕ ═══");
    for (const p of plans) {
      if (p.kind === "missing-equipment") {
        console.log(`  × [${p.category}] ${p.name}`);
      }
    }
    console.log("");
  }
  if (conflict > 0) {
    console.log("═══ КОНФЛИКТЫ (фраза уже на другом оборудовании) ═══");
    for (const p of plans) {
      if (p.kind === "conflict") {
        console.log(`  ⚠ «${p.phraseOriginal}» → планируется на «${p.intendedEquipmentName}»`);
        console.log(`     но уже привязана к: ${p.existingEquipmentNames.join(", ")}`);
      }
    }
    console.log("");
  }
  console.log("═══ СОЗДАНИЕ ═══");
  for (const p of plans) {
    if (p.kind === "create") {
      console.log(`  + «${p.phraseOriginal}» → ${p.equipmentName}`);
    }
  }
  /* eslint-enable no-console */
}

async function apply(plans: Plan[]) {
  let created = 0;
  for (const p of plans) {
    if (p.kind !== "create") continue;
    await prisma.slangAlias.create({
      data: {
        phraseNormalized: p.phraseNormalized,
        phraseOriginal: p.phraseOriginal,
        equipmentId: p.equipmentId,
        confidence: 1.0,
        source: "MANUAL_ADMIN",
        usageCount: 0,
        lastUsedAt: new Date(),
      },
    });
    created++;
  }
  // eslint-disable-next-line no-console
  console.log(`\n✓ APPLIED: created=${created}`);
}

async function main() {
  const applyFlag = process.argv.includes("--apply");
  const plans = await buildPlan();
  printPlan(plans);
  if (applyFlag) {
    // eslint-disable-next-line no-console
    console.log("\n▶ Применяем…");
    await apply(plans);
  } else {
    // eslint-disable-next-line no-console
    console.log("\n(dry-run — для записи добавьте флаг --apply)");
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
