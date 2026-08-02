import { describe, it, expect } from "vitest";

import {
  bulkActionMeta,
  eligibleIds,
  isActionApplicable,
  isActionVisible,
  pluralBookings,
  type BulkActionContext,
  type BulkBookingRow,
} from "../bulkActions";

const SA: BulkActionContext = { isSuperAdmin: true, approvalMode: "manual" };
const WH: BulkActionContext = { isSuperAdmin: false, approvalMode: "manual" };

function row(
  id: string,
  status: BulkBookingRow["status"],
  amountPaid = "0",
): BulkBookingRow {
  return { id, status, amountPaid };
}

describe("применимость групповых действий", () => {
  it("согласовать можно только бронь на согласовании и только руководителю", () => {
    expect(isActionApplicable("approve", row("1", "PENDING_APPROVAL"), SA)).toBe(true);
    expect(isActionApplicable("approve", row("1", "DRAFT"), SA)).toBe(false);
    expect(isActionApplicable("approve", row("1", "PENDING_APPROVAL"), WH)).toBe(false);
  });

  it("на согласование отправляются только черновики — подтверждённые пачкой не откатываются", () => {
    expect(isActionApplicable("submit", row("1", "DRAFT"), WH)).toBe(true);
    expect(isActionApplicable("submit", row("1", "CONFIRMED"), WH)).toBe(false);
    expect(isActionApplicable("submit", row("1", "PENDING_APPROVAL"), SA)).toBe(false);
  });

  it("отменить нельзя выданную и терминальные брони", () => {
    expect(isActionApplicable("cancel", row("1", "DRAFT"), SA)).toBe(true);
    expect(isActionApplicable("cancel", row("1", "CONFIRMED"), SA)).toBe(true);
    expect(isActionApplicable("cancel", row("1", "ISSUED"), SA)).toBe(false);
    expect(isActionApplicable("cancel", row("1", "RETURNED"), SA)).toBe(false);
    expect(isActionApplicable("cancel", row("1", "CANCELLED"), SA)).toBe(false);
  });

  it("оплаченную бронь пачкой не отменяет даже руководитель — депозит требует решения", () => {
    expect(isActionApplicable("cancel", row("1", "CONFIRMED", "5000"), SA)).toBe(false);
    expect(isActionApplicable("cancel", row("1", "CONFIRMED", "0"), SA)).toBe(true);
  });

  it("архивировать может только руководитель, зато из любого статуса", () => {
    expect(isActionApplicable("archive", row("1", "ISSUED"), SA)).toBe(true);
    expect(isActionApplicable("archive", row("1", "DRAFT"), WH)).toBe(false);
  });
});

describe("видимость кнопок по роли", () => {
  it("кладовщику не показываем согласование и архив", () => {
    expect(isActionVisible("approve", WH)).toBe(false);
    expect(isActionVisible("archive", WH)).toBe(false);
    expect(isActionVisible("submit", WH)).toBe(true);
    expect(isActionVisible("cancel", WH)).toBe(true);
  });

  it("руководителю показываем всё", () => {
    expect(isActionVisible("approve", SA)).toBe(true);
    expect(isActionVisible("archive", SA)).toBe(true);
  });
});

describe("отбор подходящих броней из выборки", () => {
  const rows = [
    row("a", "PENDING_APPROVAL"),
    row("b", "DRAFT"),
    row("c", "PENDING_APPROVAL"),
    row("d", "ISSUED"),
  ];

  it("берёт только выбранные и только подходящие", () => {
    const selected = new Set(["a", "b", "d"]);
    expect(eligibleIds(rows, selected, "approve", SA)).toEqual(["a"]);
  });

  it("сохраняет порядок строк списка", () => {
    const selected = new Set(["c", "a"]);
    expect(eligibleIds(rows, selected, "approve", SA)).toEqual(["a", "c"]);
  });

  it("пустая выборка даёт пустой результат", () => {
    expect(eligibleIds(rows, new Set(), "archive", SA)).toEqual([]);
  });

  it("невыбранные строки не попадают, даже если подходят", () => {
    expect(eligibleIds(rows, new Set(["b"]), "approve", SA)).toEqual([]);
  });
});

describe("подписи действий", () => {
  it("в режиме auto «отправить на согласование» становится «Подтвердить»", () => {
    const manual = bulkActionMeta("submit", { isSuperAdmin: true, approvalMode: "manual" });
    const auto = bulkActionMeta("submit", { isSuperAdmin: true, approvalMode: "auto" });
    expect(manual.label).toBe("На согласование");
    expect(auto.label).toBe("Подтвердить");
  });

  it("деструктивные действия помечены danger", () => {
    expect(bulkActionMeta("cancel", SA).danger).toBe(true);
    expect(bulkActionMeta("archive", SA).danger).toBe(true);
    expect(bulkActionMeta("approve", SA).danger).toBe(false);
  });

  it("текст подтверждения называет реальное количество броней", () => {
    expect(bulkActionMeta("archive", SA).confirmMessage(3)).toContain("3 брони");
    expect(bulkActionMeta("approve", SA).confirmMessage(1)).toContain("1 бронь");
  });
});

describe("склонение «бронь»", () => {
  it.each([
    [1, "бронь"],
    [2, "брони"],
    [4, "брони"],
    [5, "броней"],
    [11, "броней"],
    [14, "броней"],
    [21, "бронь"],
    [22, "брони"],
    [25, "броней"],
    [100, "броней"],
    [101, "бронь"],
  ])("%i → %s", (n, expected) => {
    expect(pluralBookings(n)).toBe(expected);
  });
});
