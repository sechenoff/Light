import { describe, it, expect } from "vitest";
import { parseLegacyFilename } from "../legacyBookingParser";

const YEAR = 2026;

describe("parseLegacyFilename", () => {
  // Pattern 1: DD.MM ClientName Amount.xlsx
  it("04.04 Романов 22137.xlsx → date=04.04, client=Романов, amount=22137", () => {
    const r = parseLegacyFilename("04.04 Романов 22137.xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 3, 4));
    expect(r.clientName).toBe("Романов");
    expect(r.amount).toBe(22137);
    expect(r.isDuplicate).toBe(false);
  });

  it("06.03 Гена 120030.xlsx → date=06.03, client=Гена, amount=120030", () => {
    const r = parseLegacyFilename("06.03 Гена 120030.xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 2, 6));
    expect(r.clientName).toBe("Гена");
    expect(r.amount).toBe(120030);
    expect(r.isDuplicate).toBe(false);
  });

  it("10.04 хокаге 52600 (2).xlsx → amount=52600, isDuplicate=true", () => {
    const r = parseLegacyFilename("10.04 хокаге 52600 (2).xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 3, 10));
    expect(r.clientName).toBe("хокаге");
    expect(r.amount).toBe(52600);
    expect(r.isDuplicate).toBe(true);
  });

  it("17.04 Незрим  106332.xlsx → amount=106332 (double space)", () => {
    const r = parseLegacyFilename("17.04 Незрим  106332.xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 3, 17));
    expect(r.clientName).toBe("Незрим");
    expect(r.amount).toBe(106332);
    expect(r.isDuplicate).toBe(false);
  });

  it("1.04 Тест 5000.xlsx → day=1 parses correctly", () => {
    const r = parseLegacyFilename("1.04 Тест 5000.xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 3, 1));
    expect(r.clientName).toBe("Тест");
    expect(r.amount).toBe(5000);
  });

  // Pattern 2: DD_MM_YY ClientName (N).xls
  it("06_04_26 Бильярд (2).xls → date=06.04.2026, client=Бильярд, amount=null, isDuplicate=true", () => {
    const r = parseLegacyFilename("06_04_26 Бильярд (2).xls", YEAR);
    expect(r.date).toEqual(new Date(2026, 3, 6));
    expect(r.clientName).toBe("Бильярд");
    expect(r.amount).toBeNull();
    expect(r.isDuplicate).toBe(true);
  });

  it("15_03_26 Студия.xlsx → date=15.03.2026, client=Студия, amount=null", () => {
    const r = parseLegacyFilename("15_03_26 Студия.xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 2, 15));
    expect(r.clientName).toBe("Студия");
    expect(r.amount).toBeNull();
    expect(r.isDuplicate).toBe(false);
  });

  it("YY >= 50 → 19xx year", () => {
    const r = parseLegacyFilename("01_01_99 Ретро.xlsx", 1999);
    expect(r.date?.getFullYear()).toBe(1999);
  });

  it("YY < 50 → 20xx year", () => {
    const r = parseLegacyFilename("01_01_26 Новый.xlsx", 2026);
    expect(r.date?.getFullYear()).toBe(2026);
  });

  // Pattern 3: D-DD месяц ClientName.xlsx
  it("8-16 марта Геннадий.xlsx → date=08.03, client=Геннадий, amount=null", () => {
    const r = parseLegacyFilename("8-16 марта Геннадий.xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 2, 8));
    expect(r.clientName).toBe("Геннадий");
    expect(r.amount).toBeNull();
    expect(r.isDuplicate).toBe(false);
  });

  it("1-5 апреля Клиент.xlsx → date=01.04", () => {
    const r = parseLegacyFilename("1-5 апреля Клиент.xlsx", YEAR);
    expect(r.date).toEqual(new Date(2026, 3, 1));
    expect(r.clientName).toBe("Клиент");
  });

  it("month short form: 3-7 янв Клиент.xlsx → month=1", () => {
    const r = parseLegacyFilename("3-7 янв Клиент.xlsx", YEAR);
    expect(r.date?.getMonth()).toBe(0); // January
    expect(r.clientName).toBe("Клиент");
  });

  it("month: дек → month=12", () => {
    const r = parseLegacyFilename("15-20 декабря Тест.xlsx", YEAR);
    expect(r.date?.getMonth()).toBe(11); // December
  });

  // Fallback / garbage
  it("garbage.xlsx → all null", () => {
    const r = parseLegacyFilename("garbage.xlsx", YEAR);
    expect(r.date).toBeNull();
    expect(r.clientName).toBe("");
    expect(r.amount).toBeNull();
    expect(r.isDuplicate).toBe(false);
  });

  it("empty string → all null", () => {
    const r = parseLegacyFilename("", YEAR);
    expect(r.date).toBeNull();
    expect(r.clientName).toBe("");
    expect(r.amount).toBeNull();
  });
});
