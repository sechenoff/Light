import { describe, it, expect } from "vitest";
import { menuByRole, type MenuSection, type MenuItem } from "../roleMatrix";

describe("menuByRole — grouped sections", () => {
  it("returns MenuSection[] (not MenuItem[]) for each role", () => {
    const roles = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;
    for (const role of roles) {
      const sections = menuByRole[role];
      expect(Array.isArray(sections)).toBe(true);
      // each element must have a `title` and `items` array
      for (const section of sections) {
        expect(typeof section.title).toBe("string");
        expect(Array.isArray(section.items)).toBe(true);
      }
    }
  });

  it("SUPER_ADMIN has sections: Главное, Задачи, Склад, Бронирование, Каталог, Мастерская, Финансы, Настройки, Система", () => {
    const titles = menuByRole.SUPER_ADMIN.map((s) => s.title);
    expect(titles).toEqual([
      "Главное",
      "Задачи",
      "Склад",
      "Бронирование",
      "Каталог",
      "Мастерская",
      "Финансы",
      "Настройки",
      "Система",
    ]);
  });

  it("SUPER_ADMIN Финансы section has 5 items including /finance/invoices", () => {
    const finance = menuByRole.SUPER_ADMIN.find((s) => s.title === "Финансы");
    expect(finance).toBeDefined();
    expect(finance!.items).toHaveLength(5);
    const hrefs = finance!.items.map((i) => i.href);
    expect(hrefs).toEqual([
      "/finance",
      "/finance/invoices",
      "/finance/payments",
      "/finance/debts",
      "/finance/expenses",
    ]);
  });

  it("WAREHOUSE has sections: Главное, Задачи, Склад, Бронирование, Каталог, Мастерская, Финансы (no Система)", () => {
    // L1: WAREHOUSE теперь видит Финансы→Счета в режиме read-only (без CTAs создания/выпуска/аннулирования)
    const titles = menuByRole.WAREHOUSE.map((s) => s.title);
    expect(titles).toEqual([
      "Главное",
      "Задачи",
      "Склад",
      "Бронирование",
      "Каталог",
      "Мастерская",
      "Финансы",
    ]);
  });

  it("WAREHOUSE Финансы section has only /finance/invoices (read-only, no full finance)", () => {
    // L1: WAREHOUSE видит только Счета, без Обзора/Платежей/Дебиторки/Расходов
    const finance = menuByRole.WAREHOUSE.find((s) => s.title === "Финансы");
    expect(finance).toBeDefined();
    expect(finance!.items).toHaveLength(1);
    expect(finance!.items[0].href).toBe("/finance/invoices");
  });

  it("TECHNICIAN has sections: Главное, Задачи, Мастерская, Каталог", () => {
    const titles = menuByRole.TECHNICIAN.map((s) => s.title);
    expect(titles).toEqual(["Главное", "Задачи", "Мастерская", "Каталог"]);
  });

  it("every item has href, label, and icon", () => {
    for (const role of ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const) {
      for (const section of menuByRole[role]) {
        for (const item of section.items) {
          expect(typeof item.href).toBe("string");
          expect(typeof item.label).toBe("string");
          expect(typeof item.icon).toBe("string");
        }
      }
    }
  });
});
