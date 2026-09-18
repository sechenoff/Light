// Тесты сторожа схемы: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeSchemaChange, findDestructiveChanges } from "./schema-guard.mjs";

const BASE = `
model Booking {
  id        String   @id @default(cuid())
  status    BookingStatus @default(DRAFT)
  total     Decimal
  note      String?  @map("booking_note")
  client    Client   @relation(fields: [clientId], references: [id])
  clientId  String
  items     BookingItem[]
  @@index([status])
}

model StockCount {
  id     String @id
  number Int    @unique // номер по порядку
  @@map("stock_counts")
}

enum BookingStatus {
  DRAFT
  CONFIRMED // подтверждена
  CANCELLED
}
`;

test("схема без изменений — чисто", () => {
  assert.deepEqual(findDestructiveChanges(BASE, BASE), []);
});

test("добавление модели, поля и значения enum — не разрушает", () => {
  const head = BASE
    .replace("  clientId  String\n", "  clientId  String\n  paidAt    DateTime?\n")
    .replace("  CANCELLED\n", "  CANCELLED\n  ARCHIVED\n")
    .concat("\nmodel Bill {\n  id String @id\n}\n");
  assert.deepEqual(findDestructiveChanges(BASE, head), []);
});

test("удалённая модель — ловится (устаревшая ветка без чужой таблицы)", () => {
  const head = BASE.replace(/model StockCount \{[\s\S]*?\n\}\n/, "");
  assert.deepEqual(findDestructiveChanges(BASE, head), [
    "удалена модель StockCount (таблица «stock_counts» и все её данные)",
  ]);
});

test("удалённое скалярное поле, смена типа и @map — ловятся", () => {
  const head = BASE
    .replace("  total     Decimal\n", "  total     Int\n")
    .replace('@map("booking_note")', '@map("note")')
    .replace("  clientId  String\n", "");
  assert.deepEqual(findDestructiveChanges(BASE, head), [
    "поле Booking.total: тип Decimal → Int",
    "поле Booking.note: колонка «booking_note» → «note»",
    "удалено поле Booking.clientId (колонка «clientId»)",
  ]);
});

test("удалённое поле-связь колонки не имеет — не ловится", () => {
  const head = BASE.replace("  items     BookingItem[]\n", "");
  assert.deepEqual(findDestructiveChanges(BASE, head), []);
});

test("удалённое значение enum и переименованная таблица — ловятся", () => {
  const head = BASE.replace("  CONFIRMED // подтверждена\n", "").replace('@@map("stock_counts")', '@@map("counts")');
  assert.deepEqual(findDestructiveChanges(BASE, head), [
    "модель StockCount: таблица «stock_counts» → «counts» (на SQLite это пересоздание)",
    "из enum BookingStatus удалено значение CONFIRMED — строки с ним перестанут читаться",
  ]);
});

test("смена @map у значения enum — ловится (db push на SQLite её не видит)", () => {
  const base = BASE.replace("  DRAFT\n", '  DRAFT @map("draft")\n');
  const head = BASE.replace("  DRAFT\n", '  DRAFT @map("DRAFT_NEW")\n');
  assert.deepEqual(findDestructiveChanges(base, head), [
    "enum BookingStatus.DRAFT: в базе «draft» → «DRAFT_NEW» — старые строки перестанут читаться",
  ]);
});

test("добавления, которые не накатятся на заполненную таблицу, — ловятся как blocks", () => {
  const head = BASE
    .replace("  clientId  String\n", [
      "  clientId  String",
      "  code      String   @default(cuid())",
      "  updatedAt DateTime @updatedAt",
      "  slug      String?  @unique",
      "  number    Int",
      "",
    ].join("\n"))
    .replace('@map("booking_note")', '@map("booking_note") @unique')
    .replace("  note      String?", "  note      String ")
    .replace("  @@index([status])\n", "  @@index([status])\n  @@unique([clientId, status])\n");
  const { drops, blocks } = analyzeSchemaChange(BASE, head);
  assert.deepEqual(drops, []);
  assert.equal(blocks.length, 7);
  assert.ok(blocks.some((b) => b.includes("добавлен @@unique([clientId,status])")));
  assert.ok(blocks.some((b) => b.includes("Booking.note стало обязательным")));
  assert.ok(blocks.some((b) => b.includes("на поле Booking.note добавлен @unique")));
  assert.ok(blocks.some((b) => b.includes("новое обязательное поле Booking.code")));
  assert.ok(blocks.some((b) => b.includes("новое обязательное поле Booking.updatedAt")));
  assert.ok(blocks.some((b) => b.includes("новое поле Booking.slug с @unique")));
  assert.ok(blocks.some((b) => b.includes("новое обязательное поле Booking.number")));
});

test("безопасные добавления в существующую модель — не ловятся", () => {
  const head = BASE
    .replace("  clientId  String\n", [
      "  clientId  String",
      "  paidAt    DateTime?",
      '  mode      String   @default("STANDARD")',
      "  count     Int      @default(0)",
      "  createdAt DateTime @default(now())",
      "  touchedAt DateTime @default(now()) @updatedAt",
      "  owner     Client?  @relation(\"owner\", fields: [ownerId], references: [id])",
      "  ownerId   String?",
      "",
    ].join("\n"))
    .replace("  @@index([status])\n", "  @@index([status])\n  @@index([clientId])\n");
  assert.deepEqual(findDestructiveChanges(BASE, head), []);
});

test("новая модель с @unique и обязательными полями — не ловится (таблица пустая)", () => {
  const head = BASE + "\nmodel Bill {\n  id     String @id @default(cuid())\n  number Int    @unique\n  total  Int\n  @@unique([number, total])\n}\n";
  assert.deepEqual(findDestructiveChanges(BASE, head), []);
});

test("настоящая схема проекта разбирается и сама с собой сходится", () => {
  const real = readFileSync(new URL("../apps/api/prisma/schema.prisma", import.meta.url), "utf8");
  assert.deepEqual(findDestructiveChanges(real, real), []);
  const withoutStockCount = real.replace(/model StockCountLine \{[\s\S]*?\n\}\n/, "");
  assert.ok(findDestructiveChanges(real, withoutStockCount).some((p) => p.includes("StockCountLine")));
});
