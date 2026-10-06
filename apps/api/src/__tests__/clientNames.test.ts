/**
 * Правило «это то же имя» и сходство имён — чистые функции. Векторы
 * совпадают с web/src/lib/__tests__/clientName.test.ts: веб держит зеркало
 * normalizeClientName, и расхождение сразу видно в обоих наборах.
 */
import { describe, it, expect } from "vitest";

import { clientNameSimilarity, normalizeClientName, SIMILAR_NAME_THRESHOLD } from "../services/clientNames";

const NORMALIZE_VECTORS: Array<[string, string]> = [
  ["Петя Куб", "петя куб"],
  ["  ПЕТЯ   КУБ ", "петя куб"],
  ["Пётр Ёлкин", "петр елкин"],
  ["ООО «Сфера»", "ооо сфера"],
  ['ИП "Васильев"', "ип васильев"],
  ["Студия\tСевер", "студия север"],
];

describe("normalizeClientName", () => {
  it.each(NORMALIZE_VECTORS)("%s → %s", (input, expected) => {
    expect(normalizeClientName(input)).toBe(expected);
  });
});

describe("clientNameSimilarity", () => {
  it("одно имя в другом написании — 1, порядок слов не важен", () => {
    expect(clientNameSimilarity("Петя Куб", "петя  куб")).toBe(1);
    expect(clientNameSimilarity("Петя Куб", "Куб Петя")).toBeGreaterThanOrEqual(0.9);
  });

  it("уменьшительное имя с той же фамилией — похоже, посторонний — нет", () => {
    expect(clientNameSimilarity("Петя Кубов", "Петр Кубов")).toBeGreaterThanOrEqual(SIMILAR_NAME_THRESHOLD);
    expect(clientNameSimilarity("Петя Кубов", "Анна Смирнова")).toBeLessThan(SIMILAR_NAME_THRESHOLD);
  });

  it("то же имя с уточнением — похоже", () => {
    expect(clientNameSimilarity("Петя Куб", "Петя Куб гаффер")).toBeGreaterThanOrEqual(0.9);
  });
});
