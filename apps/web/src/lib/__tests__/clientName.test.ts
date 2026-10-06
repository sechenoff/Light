/**
 * Зеркало серверного normalizeClientName (apps/api/src/services/clientNames.ts):
 * те же векторы, что в apps/api/src/__tests__/clientNames.test.ts.
 */
import { describe, it, expect } from "vitest";

import { normalizeClientName } from "../clientName";

const NORMALIZE_VECTORS: Array<[string, string]> = [
  ["Петя Куб", "петя куб"],
  ["  ПЕТЯ   КУБ ", "петя куб"],
  ["Пётр Ёлкин", "петр елкин"],
  ["ООО «Сфера»", "ооо сфера"],
  ['ИП "Васильев"', "ип васильев"],
  ["Студия\tСевер", "студия север"],
];

describe("normalizeClientName (веб)", () => {
  it.each(NORMALIZE_VECTORS)("%s → %s", (input, expected) => {
    expect(normalizeClientName(input)).toBe(expected);
  });
});
