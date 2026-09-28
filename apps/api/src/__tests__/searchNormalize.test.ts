/**
 * P11: поиск по каталогу, где кириллица и латиница перемешаны.
 *
 * В названиях на проде модели набраны вперемешку: «Aputure СF16» (кириллическая
 * «С»), «Соты для рамы 8х8» (кириллическая «х»). Человек ищет латиницей — «cf16»,
 * «8x8» — и видит «Ничего не найдено» (06.09). Нормализация приводит обе стороны
 * к одному алфавиту для похожих по начертанию букв и схлопывает размер «8 × 8».
 */

import { describe, it, expect } from "vitest";

import { normalizeSearchText, searchMatches } from "../utils/searchNormalize";

describe("normalizeSearchText", () => {
  it("кириллические буквы, похожие на латинские, становятся латинскими", () => {
    // С, F → c, f; кириллическая «С» и латинская «C» дают одно и то же.
    expect(normalizeSearchText("СF16")).toBe("cf16");
    expect(normalizeSearchText("CF16")).toBe("cf16");
    expect(normalizeSearchText("АВЕКМНОРСТУХ")).toBe("abekmhopctyx");
    expect(normalizeSearchText("авекмнорстух")).toBe("abekmhopctyx");
  });

  it("ё приравнивается к е", () => {
    expect(normalizeSearchText("Ёлка")).toBe(normalizeSearchText("елка"));
  });

  it("размер «N × M» записывается одинаково при любом знаке и пробелах", () => {
    const expected = "8x8";
    expect(normalizeSearchText("8х8")).toBe(expected); // кириллическая х
    expect(normalizeSearchText("8x8")).toBe(expected);
    expect(normalizeSearchText("8×8")).toBe(expected);
    expect(normalizeSearchText("8 x 8")).toBe(expected);
    expect(normalizeSearchText("8 × 8")).toBe(expected);
    expect(normalizeSearchText("12Х12")).toBe("12x12");
  });

  it("цепочка размеров схлопывается целиком", () => {
    expect(normalizeSearchText("4 х 4 х 8")).toBe("4x4x8");
  });

  it("лишние пробелы схлопываются, края обрезаются", () => {
    expect(normalizeSearchText("  Aputure   600d  ")).toBe("aputure 600d");
  });

  it("«x» между буквами не трогается — это не размер", () => {
    expect(normalizeSearchText("Box x Light")).toBe("box x light");
  });
});

describe("searchMatches", () => {
  const lens = "Линза френеля Aputure СF16 Fresnel Motorised"; // С — кириллица
  const grid = "Соты для рамы 8х8"; // х — кириллица

  it("латинский запрос находит название с кириллической буквой и наоборот", () => {
    expect(searchMatches(lens, "cf16")).toBe(true);
    expect(searchMatches(lens, "сf16")).toBe(true);
    expect(searchMatches("Aputure CF16", "сf16")).toBe(true);
  });

  it("размер находится при любом написании", () => {
    expect(searchMatches(grid, "8x8")).toBe(true);
    expect(searchMatches(grid, "8х8")).toBe(true);
    expect(searchMatches(grid, "8 x 8")).toBe(true);
    expect(searchMatches(grid, "8×8")).toBe(true);
  });

  it("регистр не важен, в том числе для кириллицы", () => {
    expect(searchMatches("Штатив Manfrotto", "штатив")).toBe(true);
    expect(searchMatches("штатив manfrotto", "ШТАТИВ MANFROTTO")).toBe(true);
  });

  it("то, что находилось раньше, находится и теперь", () => {
    // Схлопывание пробелов в размере не должно ломать прямое вхождение.
    expect(searchMatches("Кабель 8 x", "8 x")).toBe(true);
  });

  it("постороннее не находится", () => {
    expect(searchMatches("Штатив Manfrotto", "стойка")).toBe(false);
    expect(searchMatches(grid, "6x6")).toBe(false);
  });

  it("пустой запрос подходит всему", () => {
    expect(searchMatches(grid, "")).toBe(true);
    expect(searchMatches(grid, "   ")).toBe(true);
  });
});
