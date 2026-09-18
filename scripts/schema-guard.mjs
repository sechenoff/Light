#!/usr/bin/env node
// Сторож схемы: какие изменения schema.prisma по сравнению с main опасны для прода.
//
// Зачем. Миграций нет — деплой приводит боевую базу к schema.prisma через
// `prisma db push` (без --accept-data-loss с PR #217). Опасность двух видов:
//
// 1. Изменение удаляет данные. Типичный случай — ветка начата до чужого слияния,
//    и при конфликте в schema.prisma осталась старая версия. db push такое
//    откажется применять, и деплой main встанет у ОБОИХ агентов.
//    - удалённая модель (таблица) или изменённый @@map;
//    - удалённое скалярное поле (колонка) или изменённый @map;
//    - изменённый тип поля (String → Int и т. п.);
//    - удалённое значение enum или изменённый @map значения. Enum на SQLite —
//      это TEXT: db push этого НЕ заметит, а чтение строк со старым значением
//      сломается. Здесь сторож — единственная защита.
//
// 2. Изменение не применится к заполненной таблице — db push отказывается, деплой
//    main встаёт. CI этого не видит: тесты поднимают пустую базу.
//    - новое обязательное поле без значения по умолчанию В БАЗЕ (без @default,
//      или @default(cuid()/uuid()/nanoid()/ulid()) — это значения Prisma, не базы;
//      или @updatedAt);
//    - необязательное поле стало обязательным (`String?` → `String`);
//    - новый @unique, @@unique или @@id на существующей модели.
//
// Поля-связи (тип — другая модель, список или @relation) колонок не имеют и не
// проверяются; их внешний ключ — отдельное скалярное поле, оно проверяется.
//
// Метка PR `schema-drop-ok` (в CI — SCHEMA_DROP_OK=1) только пропускает PR в main.
// Сама она ничего на проде не делает: владелец ДО слияния готовит боевую базу
// вручную, с бэкапом (удаляет данные, чистит дубликаты, заполняет NULL), иначе
// деплой остановится на пробном db push.
//
// Запуск: node scripts/schema-guard.mjs <base.prisma> <head.prisma>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PRISMA_LEVEL_DEFAULT = /@default\(\s*(cuid|uuid|nanoid|ulid)\s*\(/;

/** Нормализует список полей в @@unique([...]) / @@id([...]) для сравнения. */
function normalizeFieldList(attr) {
  const inside = attr.match(/\[([^\]]*)\]/);
  if (!inside) return attr.replace(/\s+/g, "");
  return inside[1]
    .split(",")
    .map((f) => f.trim().replace(/\(.*$/, ""))
    .filter(Boolean)
    .join(",");
}

/**
 * Разбирает schema.prisma:
 * { models: Map<имя, {map, fields: Map<имя, Field>, uniques: Set<string>}>,
 *   enums: Map<имя, Map<значение, значение в базе>> }
 */
export function parseSchema(source) {
  const models = new Map();
  const enums = new Map();
  const lines = source.split(/\r?\n/);
  let block = null;

  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    if (!block) {
      const open = line.match(/^(model|enum)\s+(\w+)\s*\{$/);
      if (!open) continue;
      block = { kind: open[1], name: open[2] };
      if (block.kind === "model") {
        models.set(block.name, { map: block.name, fields: new Map(), uniques: new Set() });
      } else {
        enums.set(block.name, new Map());
      }
      continue;
    }

    if (line === "}") {
      block = null;
      continue;
    }

    if (block.kind === "enum") {
      if (line.startsWith("@@")) continue;
      const value = line.match(/^(\w+)/);
      if (!value) continue;
      const valueMap = line.match(/@map\(\s*"([^"]+)"\s*\)/);
      enums.get(block.name).set(value[1], valueMap ? valueMap[1] : value[1]);
      continue;
    }

    const model = models.get(block.name);
    const tableMap = line.match(/^@@map\(\s*"([^"]+)"\s*\)/);
    if (tableMap) {
      model.map = tableMap[1];
      continue;
    }
    const compound = line.match(/^@@(unique|id)\s*\((.*)\)\s*$/);
    if (compound) {
      model.uniques.add(`${compound[1]}:${normalizeFieldList(compound[2])}`);
      continue;
    }
    if (line.startsWith("@@")) continue;

    const field = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
    if (!field) continue;
    const columnMap = line.match(/@map\(\s*"([^"]+)"\s*\)/);
    const hasDefault = /@default\(/.test(line);
    model.fields.set(field[1], {
      type: field[2] + (field[3] ?? ""),
      baseType: field[2],
      optional: Boolean(field[4]),
      map: columnMap ? columnMap[1] : field[1],
      // На SQLite списков-скаляров нет: любое `X[]` — обратная сторона связи.
      relation: Boolean(field[3]) || line.includes("@relation("),
      unique: /@unique\b/.test(line) || /@id\b/.test(line),
      // Значение по умолчанию, которое знает сама база (не Prisma-клиент).
      dbDefault: hasDefault && !PRISMA_LEVEL_DEFAULT.test(line),
    });
  }

  return { models, enums };
}

/**
 * Опасные изменения base → head, по-русски.
 * { drops: string[] — удаляет данные, blocks: string[] — не применится к заполненной таблице }
 */
export function analyzeSchemaChange(baseSource, headSource) {
  const base = parseSchema(baseSource);
  const head = parseSchema(headSource);
  const isRelation = (schema, field) => field.relation || schema.models.has(field.baseType);
  const drops = [];
  const blocks = [];

  for (const [name, baseModel] of base.models) {
    const headModel = head.models.get(name);
    if (!headModel) {
      drops.push(`удалена модель ${name} (таблица «${baseModel.map}» и все её данные)`);
      continue;
    }
    if (headModel.map !== baseModel.map) {
      drops.push(`модель ${name}: таблица «${baseModel.map}» → «${headModel.map}» (на SQLite это пересоздание)`);
    }

    for (const [fieldName, baseField] of baseModel.fields) {
      if (isRelation(base, baseField)) continue;
      const headField = headModel.fields.get(fieldName);
      if (!headField) {
        drops.push(`удалено поле ${name}.${fieldName} (колонка «${baseField.map}»)`);
        continue;
      }
      if (headField.map !== baseField.map) {
        drops.push(`поле ${name}.${fieldName}: колонка «${baseField.map}» → «${headField.map}»`);
      }
      if (headField.type !== baseField.type) {
        drops.push(`поле ${name}.${fieldName}: тип ${baseField.type} → ${headField.type}`);
      }
      if (baseField.optional && !headField.optional) {
        blocks.push(`поле ${name}.${fieldName} стало обязательным — не применится, если в колонке есть пустые значения`);
      }
      if (!baseField.unique && headField.unique) {
        blocks.push(`на поле ${name}.${fieldName} добавлен @unique — Prisma не накатит его на заполненную таблицу без ручного шага`);
      }
    }

    for (const [fieldName, headField] of headModel.fields) {
      if (baseModel.fields.has(fieldName) || isRelation(head, headField)) continue;
      if (headField.unique) {
        blocks.push(`новое поле ${name}.${fieldName} с @unique — на заполненную таблицу не накатится`);
      } else if (!headField.optional && !headField.dbDefault) {
        blocks.push(
          `новое обязательное поле ${name}.${fieldName} без значения по умолчанию в базе — ` +
            `сделайте его необязательным (?) или дайте @default("…")/@default(0)/@default(now())`,
        );
      }
    }

    for (const unique of headModel.uniques) {
      if (!baseModel.uniques.has(unique)) {
        const [kind, fields] = unique.split(":");
        blocks.push(`на модели ${name} добавлен @@${kind}([${fields}]) — на заполненную таблицу не накатится`);
      }
    }
  }

  for (const [name, values] of base.enums) {
    const headValues = head.enums.get(name);
    if (!headValues) {
      drops.push(`удалён enum ${name}`);
      continue;
    }
    for (const [value, stored] of values) {
      if (!headValues.has(value)) {
        drops.push(`из enum ${name} удалено значение ${value} — строки с ним перестанут читаться`);
      } else if (headValues.get(value) !== stored) {
        drops.push(`enum ${name}.${value}: в базе «${stored}» → «${headValues.get(value)}» — старые строки перестанут читаться`);
      }
    }
  }

  return { drops, blocks };
}

/** Все опасные изменения одним списком (для тестов и простых проверок). */
export function findDestructiveChanges(baseSource, headSource) {
  const { drops, blocks } = analyzeSchemaChange(baseSource, headSource);
  return [...drops, ...blocks];
}

function main() {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error("Использование: node scripts/schema-guard.mjs <base.prisma> <head.prisma>");
    process.exit(2);
  }

  const { drops, blocks } = analyzeSchemaChange(readFileSync(basePath, "utf8"), readFileSync(headPath, "utf8"));
  if (drops.length === 0 && blocks.length === 0) {
    console.log("✓ Схема меняется безопасно: ничего не удаляется, и всё применится к заполненной базе.");
    return;
  }

  const allowed = process.env.SCHEMA_DROP_OK === "1";
  const out = allowed ? console.log : console.error;
  if (drops.length) {
    out(`${allowed ? "⚠" : "✗"} PR убирает из схемы то, что есть в main (данные пропадут):`);
    for (const p of drops) out(`  - ${p}`);
  }
  if (blocks.length) {
    out(`${allowed ? "⚠" : "✗"} Изменения, которые не применятся к заполненной боевой базе (деплой встанет):`);
    for (const p of blocks) out(`  - ${p}`);
  }

  if (allowed) {
    console.log(`
Метка schema-drop-ok стоит — PR пропускаю. Метка сама ничего на проде не делает:
боевую базу владелец должен подготовить вручную, с бэкапом, ДО слияния — иначе
деплой main остановится на пробном db push у обоих агентов.`);
    return;
  }

  console.error(`
Что делать:
  - удаление — чаще всего ветка отстала от main и при конфликте вернула старую
    schema.prisma: git fetch origin && git rebase origin/main, в schema.prisma
    оставить ВСЁ из main и добавить своё;
  - новое поле — сделать необязательным (?) или дать значение по умолчанию в базе;
  - если изменение задумано — согласовать с владельцем. Он ДО слияния готовит
    боевую базу вручную (с бэкапом), и только потом на PR ставится метка
    schema-drop-ok. Метка ничего на проде не делает, она лишь пропускает PR.`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
