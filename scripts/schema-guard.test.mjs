// Тесты сторожа схемы: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findDestructiveChanges } from "./schema-guard.mjs";

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
    "из enum BookingStatus удалено значение CONFIRMED",
  ]);
});

test("настоящая схема проекта разбирается и сама с собой сходится", () => {
  const real = readFileSync(new URL("../apps/api/prisma/schema.prisma", import.meta.url), "utf8");
  assert.deepEqual(findDestructiveChanges(real, real), []);
  const withoutStockCount = real.replace(/model StockCountLine \{[\s\S]*?\n\}\n/, "");
  assert.ok(findDestructiveChanges(real, withoutStockCount).some((p) => p.includes("StockCountLine")));
});
