/**
 * Журнал брони называет того, кто выдал или принял технику в киоске.
 *
 * Кладовщик, вошедший по PIN, не имеет учётки в CRM: аудит пишется от
 * системного автора `_system_`, а имя кладовщика лежит в `after.workerName`.
 * Раньше такая запись выглядела как «Система» — непонятно, кто работал.
 * Служебные идентификаторы сессии киоска в «Что изменилось» не показываются.
 */
import { describe, expect, it } from "vitest";

import {
  SCAN_CANCEL_REASON_LABELS,
  auditActionLabel,
  auditActorLabel,
  auditChanges,
  auditValue,
} from "../auditFormat";
import { ACTION_LABELS } from "../auditLabels";

describe("автор записи киоска", () => {
  it("кладовщик по PIN — «Склад · имя», а не «Система»", () => {
    expect(
      auditActorLabel({
        userId: "_system_",
        user: { id: "_system_", username: "_system_" },
        after: { status: "ISSUED", via: "kiosk", workerName: "Иван Кладовщик" },
      }),
    ).toBe("Склад · Иван Кладовщик");
  });

  it("имя кладовщика читается и из строки JSON", () => {
    expect(
      auditActorLabel({
        userId: "_system_",
        user: null,
        after: JSON.stringify({ workerName: "  Пётр  " }),
      }),
    ).toBe("Склад · Пётр");
  });

  it("автозакрытие без кладовщика остаётся «Система»", () => {
    expect(
      auditActorLabel({ userId: "_system_", user: null, after: { reason: "STALE" } }),
    ).toBe("Система");
    expect(auditActorLabel({ userId: "_system_", user: null, after: { workerName: "   " } })).toBe("Система");
    expect(auditActorLabel({ userId: "_system_", user: null })).toBe("Система");
  });

  it("у сотрудника с учёткой автор — его аккаунт, даже если в записи есть имя кладовщика", () => {
    expect(
      auditActorLabel({
        userId: "u-1",
        user: { id: "u-1", username: "sechenoff" },
        after: { workerName: "sechenoff" },
      }),
    ).toBe("sechenoff");
  });
});

describe("запись «Сессия киоска прервана»", () => {
  it("действие подписано словами", () => {
    expect(ACTION_LABELS.SCAN_SESSION_CANCELLED).toBe("Сессия киоска прервана");
    expect(auditActionLabel("SCAN_SESSION_CANCELLED")).toBe("Сессия киоска прервана");
  });

  it("причина закрытия — словами, для каждой причины из контракта", () => {
    for (const code of [
      "KIOSK_ABORT",
      "CARD_ABORT",
      "EMPTY_LEAVE",
      "BOOKING_ISSUED_MANUALLY",
      "BOOKING_RETURNED_MANUALLY",
      "BOOKING_CANCELLED",
      "BOOKING_ARCHIVED",
      "STALE",
    ]) {
      expect(SCAN_CANCEL_REASON_LABELS[code]).toBeTruthy();
      expect(auditValue("reason", code, "Booking")).toBe(SCAN_CANCEL_REASON_LABELS[code]);
    }
    expect(auditValue("reason", "BOOKING_RETURNED_MANUALLY", "Booking")).toBe(
      "Возврат отмечен кнопкой на карточке",
    );
  });

  it("произвольная причина (текст сотрудника) выводится как есть", () => {
    expect(auditValue("reason", "Клиент передумал", "Booking")).toBe("Клиент передумал");
  });

  it("служебные номера сессии спрятаны, остальное — по-русски", () => {
    const startedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    const changes = auditChanges({
      entityType: "Booking",
      before: null,
      after: {
        sessionId: "cmu6qtg1z001ey1jh8hwy6c12",
        scanSessionId: "cmu6qtg1z001ey1jh8hwy6c12",
        operation: "RETURN",
        reason: "CARD_ABORT",
        startedBy: "jony",
        startedAt,
        cancelledBy: "sechenoff",
      },
    });
    const labels = changes.map((c) => c.label);
    expect(labels).not.toContain("Дополнительные сведения");
    expect(changes.some((c) => c.after.includes("cmu6qtg1z"))).toBe(false);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Операция", after: "Возврат" }),
        expect.objectContaining({ label: "Причина", after: "Прервали на карточке брони" }),
        expect.objectContaining({ label: "Кто начал", after: "jony" }),
        expect.objectContaining({ label: "Кто прервал", after: "sechenoff" }),
        expect.objectContaining({ label: "Начато", after: expect.stringContaining("МСК") }),
      ]),
    );
  });

  it("выдача через киоск показывает кладовщика и того, кто начал", () => {
    const changes = auditChanges({
      entityType: "Booking",
      before: { status: "CONFIRMED" },
      after: {
        status: "ISSUED",
        via: "kiosk",
        sessionId: "s-1",
        workerName: "Пётр",
        startedBy: "Иван",
      },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Статус", before: "Подтверждена", after: "Выдана" }),
        expect.objectContaining({ label: "Кладовщик", after: "Пётр" }),
        expect.objectContaining({ label: "Кто начал", after: "Иван" }),
      ]),
    );
    expect(changes.map((c) => c.label)).not.toContain("Дополнительные сведения");
  });
});
