import { describe, it, expect } from "vitest";
import {
  auditChanges,
  auditValue,
  auditTimestamp,
  auditActionLabel,
  auditActorLabel,
} from "../auditFormat";

describe("понятные изменения", () => {
  it("показывает только изменённые поля и различает контекст статуса", () => {
    const changes = auditChanges({
      entityType: "Booking",
      before: JSON.stringify({
        status: "CONFIRMED",
        projectName: "Съёмка",
        updatedAt: "old",
      }),
      after: JSON.stringify({
        status: "ISSUED",
        projectName: "Съёмка",
        updatedAt: "new",
      }),
    });
    expect(changes).toEqual([
      {
        key: "status",
        label: "Статус",
        before: "Подтверждена",
        after: "Выдана",
      },
    ]);
    expect(auditValue("status", "ISSUED", "Invoice")).toBe("Выставлен");
    expect(auditValue("status", "ISSUED", "EquipmentUnit")).toBe("В аренде");
  });
  it("различает ноль, отсутствие, удаление и ложь", () => {
    expect(auditValue("amount", "0")).toContain("0");
    expect(auditValue("isActive", false)).toBe("Отключён");
    expect(auditValue("comment", null)).toBe("Не указано");
    expect(auditValue("comment", undefined)).toBe("Не сохранено");
    expect(
      auditChanges({
        entityType: "Client",
        before: { name: "Заказчик" },
        after: null,
      })[0].after,
    ).toBe("Удалено");
  });
  it("показывает конкретную изменённую позицию и скрывает секреты", () => {
    const before = {
      itemsDetails: { "Свет A": { quantity: 1 }, "Свет B": { quantity: 2 } },
      passwordHash: "old-secret",
    };
    const after = {
      itemsDetails: { "Свет A": { quantity: 3 }, "Свет B": { quantity: 2 } },
      passwordHash: "new-secret",
    };
    const changes = auditChanges({ entityType: "Booking", before, after });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      label: "Состав брони · Свет A · Количество",
      before: "1",
      after: "3",
    });
  });
  it("время всегда московское, дата некорректной записи не ломает журнал", () => {
    const now = new Date();
    expect(auditTimestamp(now.toISOString())).toContain(
      new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(now),
    );
    expect(auditTimestamp(now.toISOString())).toContain("МСК");
    expect(auditTimestamp("broken")).toBe("Дата не сохранена");
  });
  it("не выдумывает автора и сохраняет понятный fallback", () => {
    expect(auditActorLabel({ userId: "old-id", user: null })).toBe(
      "Автор не сохранён",
    );
    expect(auditActorLabel({ userId: "_system_", user: null })).toBe("Система");
    expect(auditActionLabel("UNKNOWN_ACTION")).toBe("Изменение записи");
    expect(auditValue("passwordChanged", true)).toBe("Изменён");
    expect(auditValue("name", "CASH")).toBe("CASH");
    expect(
      auditValue("clientId", "client-1", "Booking", { "client-1": "Заказчик" }),
    ).toBe("Заказчик");
    expect(
      auditChanges({
        entityType: "Booking",
        before: "broken json",
        after: null,
      }),
    ).toEqual([]);
  });
});

describe("смена клиента в журнале", () => {
  it("ссылка рядом с именем не дублирует строку: «Клиент: петя куб → Петя Куб» один раз", () => {
    const changes = auditChanges({
      entityType: "Booking",
      before: JSON.stringify({ clientId: "c-dup", clientName: "петя куб" }),
      after: JSON.stringify({ clientId: "c-main", clientName: "Петя Куб", reason: "Объединение карточек клиента" }),
      // Удалённой при объединении карточки среди ссылок нет.
      referenceLabels: { "c-main": "Петя Куб" },
    });
    expect(changes.map((c) => [c.label, c.before, c.after])).toEqual([
      ["Клиент", "петя куб", "Петя Куб"],
      ["Причина", "Не сохранено", "Объединение карточек клиента"],
    ]);
  });

  it("объединение карточек — что перенесено, словами", () => {
    const changes = auditChanges({
      entityType: "Client",
      before: JSON.stringify({ name: "Петя Куб", phone: null }),
      after: JSON.stringify({
        name: "Петя Куб",
        phone: "+7 900 111-22-33",
        mergedClientId: "c-dup",
        mergedClientName: "петя куб",
        movedBookings: 2,
      }),
    });
    expect(changes.map((c) => [c.label, c.after])).toEqual([
      ["Телефон", "+7 900 111-22-33"],
      ["Присоединённая карточка", "петя куб"],
      ["Перенесено броней", "2"],
    ]);
  });
});
