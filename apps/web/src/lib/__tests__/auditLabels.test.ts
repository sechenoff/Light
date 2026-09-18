/**
 * Журнал аудита говорит словами: всё, что пишет инвентаризация (начало,
 * решение «Ошибка учёта», завершение, отмена, поправка количества), — по-русски,
 * а фильтр «Тип объекта» даёт выбрать инвентаризации и позиции каталога.
 */
import { describe, expect, it } from "vitest";

import { ACTION_LABELS, ENTITY_LABELS, ENTITY_TYPE_OPTIONS, entityHref } from "../auditLabels";

describe("подписи аудита инвентаризации", () => {
  it("действия — словами, а не кодами", () => {
    expect(ACTION_LABELS.STOCK_ADJUST).toBe("Ошибка учёта: количество поправлено");
    expect(ACTION_LABELS.STOCK_COUNT_START).toBe("Инвентаризация начата");
    expect(ACTION_LABELS.STOCK_COUNT_CLOSE).toBe("Инвентаризация завершена");
    expect(ACTION_LABELS.STOCK_COUNT_CANCEL).toBe("Инвентаризация отменена");
    expect(ACTION_LABELS.STOCK_COUNT_DECISION).toBeDefined();
  });

  it("фильтр предлагает инвентаризацию и позицию каталога", () => {
    expect(ENTITY_TYPE_OPTIONS).toContainEqual({ value: "StockCount", label: "Инвентаризация" });
    expect(ENTITY_TYPE_OPTIONS).toContainEqual({ value: "Equipment", label: "Позиция каталога" });
    expect(ENTITY_LABELS.Equipment).toBe("Позиция каталога");
  });

  it("инвентаризация открывается своей страницей; у позиции каталога карточки нет", () => {
    expect(entityHref("StockCount", "sc-1")).toBe("/warehouse/inventory/sc-1");
    expect(entityHref("Equipment", "eq-1")).toBeNull();
  });
});
