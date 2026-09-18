/**
 * Решение и его ожидание — зеркало сервера для любого статуса инвентаризации:
 * штучная строка решения не ждёт (флаг `isUnitMode`, а не пустой список
 * решений), «Нашлось» без потеряшек в идущей — ждёт; что изменилось в учёте
 * после счёта — словами; починенное за неделю — пояснением.
 */
import { describe, expect, it } from "vitest";

import { booksChangeText, effectiveDecision, expectationNotes, isLineUndecided } from "../format";
import { shortageLine, surplusLine } from "./fixtures";

describe("isLineUndecided — зеркало isUndecided сервера", () => {
  it("пустой список решений у закрытой / отменённой — ещё не «штучная»", () => {
    const closedLine = shortageLine({ diff: -2, decision: null, allowedDecisions: [], isUnitMode: false });
    expect(isLineUndecided(closedLine)).toBe(true);
    expect(isLineUndecided({ ...closedLine, isUnitMode: true })).toBe(false);
    expect(isLineUndecided({ ...closedLine, decision: "LOST" })).toBe(false);
  });

  it("«Нашлось», которому в идущей нечего закрывать, ждёт решения; записанное у закрытой — решено", () => {
    const exhausted = surplusLine({ decision: "FOUND", allowedDecisions: ["ADJUST"] });
    expect(effectiveDecision(exhausted)).toBeNull();
    expect(isLineUndecided(exhausted)).toBe(true);

    const open = surplusLine({ decision: "FOUND", allowedDecisions: ["ADJUST", "FOUND"] });
    expect(effectiveDecision(open)).toBe("FOUND");

    const closed = surplusLine({ decision: "FOUND", allowedDecisions: [] });
    expect(effectiveDecision(closed)).toBe("FOUND");
    expect(isLineUndecided(closed)).toBe(false);
  });
});

describe("booksChangeText", () => {
  it("по слагаемым и с ожиданием", () => {
    const line = surplusLine({
      expected: { total: 10, issued: 4, calendar: 2, repair: 0, lost: 0, expected: 4 },
      live: { total: 12, issued: 0, calendar: 2, repair: 1, lost: 0, expected: 9 },
      booksChangedSinceCount: true,
    });
    expect(booksChangeText(line)).toBe(
      "учёт изменился после счёта: всего по учёту 10 → 12, на съёмках 4 → 0, в мастерской 0 → 1 (ожидание 4 → 9)",
    );
    expect(booksChangeText({ ...line, booksChangedSinceCount: false })).toBeNull();
  });
});

describe("expectationNotes", () => {
  it("починенное за неделю — приглушённым пояснением", () => {
    const notes = expectationNotes(shortageLine({ readyForPickupQty: 2 }));
    expect(notes).toContainEqual({ tone: "muted", text: "2 починено за неделю — может лежать на верстаке" });
    expect(expectationNotes(shortageLine()).map((n) => n.text)).not.toContain(
      expect.stringContaining("починено"),
    );
  });
});
