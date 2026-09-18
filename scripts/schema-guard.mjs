#!/usr/bin/env node
// Сторож схемы: что PR УБИРАЕТ из schema.prisma по сравнению с main.
//
// Зачем. Деплой делает `prisma db push --accept-data-loss`. Если ветка начата до
// чужого слияния и при конфликте в schema.prisma осталась «своя» версия, деплой
// молча удалит таблицы и колонки, которые добавил другой агент, — вместе с
// данными. Переименование на SQLite — это тоже удаление + добавление.
//
// Что считается разрушающим:
//   - удалённая модель (таблица) или изменённый @@map;
//   - удалённое скалярное поле (колонка) или изменённый @map;
//   - изменённый тип поля (String → Int и т. п.);
//   - удалённое значение enum (строки с ним в базе станут невалидными).
// Поля-связи (тип — другая модель, список или @relation) колонок не имеют и не
// проверяются; их внешний ключ — отдельное скалярное поле, оно проверяется.
//
// Намеренное удаление — метка PR `schema-drop-ok` (в CI приходит как
// SCHEMA_DROP_OK=1): сторож перечислит изменения, но не упадёт.
//
// Запуск: node scripts/schema-guard.mjs <base.prisma> <head.prisma>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Разбирает schema.prisma в { models: Map<имя, {map, fields: Map<имя, {type, map}>}>, enums: Map<имя, Set<значение>> } */
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
      if (block.kind === "model") models.set(block.name, { map: block.name, fields: new Map() });
      else enums.set(block.name, new Set());
      continue;
    }

    if (line === "}") {
      block = null;
      continue;
    }

    if (block.kind === "enum") {
      const value = line.match(/^(\w+)/);
      if (value) enums.get(block.name).add(value[1]);
      continue;
    }

    const model = models.get(block.name);
    const tableMap = line.match(/^@@map\(\s*"([^"]+)"\s*\)/);
    if (tableMap) {
      model.map = tableMap[1];
      continue;
    }
    if (line.startsWith("@@")) continue;

    const field = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
    if (!field) continue;
    const columnMap = line.match(/@map\(\s*"([^"]+)"\s*\)/);
    model.fields.set(field[1], {
      type: field[2] + (field[3] ?? ""),
      baseType: field[2],
      map: columnMap ? columnMap[1] : field[1],
      // На SQLite списков-скаляров нет: любое `X[]` — обратная сторона связи.
      relation: Boolean(field[3]) || line.includes("@relation("),
    });
  }

  return { models, enums };
}

/** Список разрушающих изменений base → head, по-русски, по одному на строку. */
export function findDestructiveChanges(baseSource, headSource) {
  const base = parseSchema(baseSource);
  const head = parseSchema(headSource);
  const isRelation = (schema, field) => field.relation || schema.models.has(field.baseType);
  const problems = [];

  for (const [name, baseModel] of base.models) {
    const headModel = head.models.get(name);
    if (!headModel) {
      problems.push(`удалена модель ${name} (таблица «${baseModel.map}» и все её данные)`);
      continue;
    }
    if (headModel.map !== baseModel.map) {
      problems.push(`модель ${name}: таблица «${baseModel.map}» → «${headModel.map}» (на SQLite это пересоздание)`);
    }
    for (const [fieldName, baseField] of baseModel.fields) {
      if (isRelation(base, baseField)) continue;
      const headField = headModel.fields.get(fieldName);
      if (!headField) {
        problems.push(`удалено поле ${name}.${fieldName} (колонка «${baseField.map}»)`);
        continue;
      }
      if (headField.map !== baseField.map) {
        problems.push(`поле ${name}.${fieldName}: колонка «${baseField.map}» → «${headField.map}»`);
      }
      if (headField.type !== baseField.type) {
        problems.push(`поле ${name}.${fieldName}: тип ${baseField.type} → ${headField.type}`);
      }
    }
  }

  for (const [name, values] of base.enums) {
    const headValues = head.enums.get(name);
    if (!headValues) {
      problems.push(`удалён enum ${name}`);
      continue;
    }
    for (const value of values) {
      if (!headValues.has(value)) problems.push(`из enum ${name} удалено значение ${value}`);
    }
  }

  return problems;
}

function main() {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error("Использование: node scripts/schema-guard.mjs <base.prisma> <head.prisma>");
    process.exit(2);
  }

  const problems = findDestructiveChanges(readFileSync(basePath, "utf8"), readFileSync(headPath, "utf8"));
  if (problems.length === 0) {
    console.log("✓ Схема только расширяется — ничего не удаляется и не переименовывается.");
    return;
  }

  const allowed = process.env.SCHEMA_DROP_OK === "1";
  const out = allowed ? console.log : console.error;
  out(`${allowed ? "⚠" : "✗"} PR убирает из схемы то, что есть в main:`);
  for (const p of problems) out(`  - ${p}`);

  if (allowed) {
    console.log("\nМетка schema-drop-ok стоит — пропускаю. Данные этих колонок и таблиц на проде будут удалены.");
    return;
  }

  console.error(`
Скорее всего ветка отстала от main: при конфликте в schema.prisma осталась старая
версия, и деплой удалил бы чужие таблицы вместе с данными. Что делать:
  1. git fetch origin && git rebase origin/main
  2. в schema.prisma оставить ВСЁ из main и добавить своё сверху;
  3. если удаление задумано — согласовать с владельцем и поставить на PR метку
     schema-drop-ok (данные этих колонок и таблиц на проде пропадут).`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
