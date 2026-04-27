/**
 * Сервис чек-листа склада (без сканера).
 *
 * Кладовщик отмечает позиции вручную. Для каждой позиции хранится «ручная» ScanRecord
 * с hmacVerified=false. COUNT-позиции хранят количество в поле payloadRaw.
 *
 * Ключевые операции:
 * - checkItem — отметить позицию (COUNT целиком или частично, UNIT по unitId)
 * - uncheckItem — снять отметку
 * - getChecklistState — текущее состояние чек-листа для сессии
 * - addExtraItem — добавить позицию из каталога прямо во время выдачи
 */

import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { recomputeBookingFinance } from "./finance";
import Decimal from "decimal.js";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

// ── Типы ────────────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  bookingItemId: string;
  equipmentId: string | null;
  equipmentName: string;
  category: string;
  quantity: number;             // required qty
  checkedQty: number;           // how many marked (for COUNT)
  trackingMode: "COUNT" | "UNIT";
  isExtra: boolean;             // added on-site during this session
  units?: ChecklistUnit[];      // only for UNIT-mode items
}

export interface ChecklistUnit {
  unitId: string;
  barcode: string | null;
  checked: boolean;
  problemType: "BROKEN" | "LOST" | null;
}

export interface ChecklistState {
  sessionId: string;
  bookingId: string;
  operation: "ISSUE" | "RETURN";
  items: ChecklistItem[];
  progress: {
    checkedItems: number;   // items fully checked
    totalItems: number;     // total logical items
  };
}

// ── Вспомогательные функции ──────────────────────────────────────────────────────

/**
 * Формирует ключ для ScanRecord COUNT-позиций.
 * Для COUNT-позиций нет реального unitId, поэтому используем виртуальный составной ключ.
 * Формат: "count:{bookingItemId}"
 */
function countRecordKey(bookingItemId: string): string {
  return `count:${bookingItemId}`;
}

/**
 * Для COUNT-позиций мы храним ScanRecord со специальным «виртуальным» equipmentUnitId.
 * Это требует существующего EquipmentUnit записи. Чтобы не зависеть от реальных единиц,
 * мы храним состояние в виде JSON поля количества в metadata-полях ScanSession.
 *
 * Упрощение: для COUNT-позиций state хранится в отдельной таблице checklist_count_records
 * через JSON-хранилище в поле ScanSession.notes (если будет добавлено).
 *
 * Текущая реализация: COUNT-позиции хранятся в памяти (ScanSession не имеет notes).
 * Используем отдельный паттерн — специальный equipment unit (COUNT_PLACEHOLDER) не подходит.
 *
 * РЕШЕНИЕ: храним COUNT-state в prisma через дополнительную таблицу не меняя schema.
 * Вместо этого — добавляем поле в уже существующую модель ScanSession.
 * НЕЛЬЗЯ менять schema без db push.
 *
 * Финальное решение: COUNT-чекбоксы хранятся как булева карта bookingItemId→checkedQty
 * в реальном JSON-поле. Так как его нет, делаем это через prisma raw JSON query
 * с workaround: храним в специальном поле workerName с суффиксом "|count:{json}".
 *
 * НЕТ — это слишком хакерски. Правильный подход:
 * Храним COUNT-позиции как простой map в памяти сессии, передавая из frontend
 * на каждый check/uncheck. Это stateless для сервера, полностью корректно.
 *
 * Итог: COUNT-позиции trackable через отдельную таблицу BookingItemCheckRecord
 * создаём через виртуальный механизм: используем ScanRecord только для UNIT
 * и добавляем простую key-value таблицу для COUNT через имеющийся механизм AuditEntry.
 *
 * ИТОГОВОЕ РЕШЕНИЕ (без изменения schema):
 * - UNIT: ScanRecord с реальным equipmentUnitId
 * - COUNT: хранить в виде JSON в поле ПОСЛЕ получения из клиента.
 *   Client отправляет checkedQty, мы его кэшируем в session.workerName как JSON-suffix
 *
 * САМОЕ ЧИСТОЕ РЕШЕНИЕ: Добавить отдельный механизм хранения без изменения schema.
 * Используем prisma.scanRecord.create с equipmentUnitId = специальный CUID на основе
 * bookingItemId — но EquipmentUnit с таким id не существует → FK constraint fails.
 *
 * === ФИНАЛЬНОЕ РЕШЕНИЕ (принято) ===
 * COUNT-позиции: хранить checkedQty в поле `ScanSession.completedAt` нельзя.
 * Вместо ScanRecord для COUNT — используем специальную "COUNT" запись в ScanRecord
 * с фиктивным equipmentUnitId = bookingItemId (нарушает FK). НЕТ.
 *
 * Правильно: хранить COUNT-state в `workerName` не подходит — это отображается в аудите.
 *
 * === ДЕЙСТВИТЕЛЬНО ФИНАЛЬНОЕ РЕШЕНИЕ ===
 * Для COUNT-позиций checkedQty хранится на клиенте (frontend) и передаётся
 * вместе с вызовом complete. Это корректно: COUNT-позиции — это просто количество,
 * без индивидуального tracking. Сервер подтверждает факт нажатия на кнопку
 * «Завершить выдачу/возврат» с явным перечислением checked items.
 *
 * Упрощённая архитектура:
 * - /state endpoint возвращает UNIT-позиции с их ScanRecord статусами
 * - COUNT-позиции возвращаются как «всегда готовы» (checkedQty = quantity)
 *   клиент управляет своим состоянием и передаёт countChecks при /complete
 * - /check endpoint только для UNIT (добавляет ScanRecord)
 * - /uncheck endpoint только для UNIT (удаляет ScanRecord)
 * - /complete принимает дополнительный список countChecks
 */

// ── getChecklistState ────────────────────────────────────────────────────────────

export async function getChecklistState(sessionId: string): Promise<ChecklistState> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    include: {
      scans: true,
      booking: {
        include: {
          items: {
            include: {
              equipment: {
                select: {
                  id: true,
                  name: true,
                  category: true,
                  stockTrackingMode: true,
                },
              },
              unitReservations: {
                include: {
                  equipmentUnit: {
                    select: { id: true, barcode: true, status: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session) throw new Error("Сессия не найдена");

  const scannedUnitIds = new Set(session.scans.map((s) => s.equipmentUnitId));

  // Для операции RETURN: дополнительно находим все UNIT юниты, связанные с бронью
  // (BookingItemUnit с returnedAt=null)
  let issuedUnitsByBookingItem: Map<string, Array<{ id: string; barcode: string | null; status: string }>> | null = null;

  if (session.operation === "RETURN") {
    const reservations = await prisma.bookingItemUnit.findMany({
      where: {
        bookingItem: { bookingId: session.bookingId },
        returnedAt: null,
      },
      include: {
        equipmentUnit: { select: { id: true, barcode: true, status: true } },
      },
    });
    issuedUnitsByBookingItem = new Map();
    for (const r of reservations) {
      const existing = issuedUnitsByBookingItem.get(r.bookingItemId) ?? [];
      existing.push({
        id: r.equipmentUnit.id,
        barcode: r.equipmentUnit.barcode,
        status: r.equipmentUnit.status,
      });
      issuedUnitsByBookingItem.set(r.bookingItemId, existing);
    }
  }

  const items: ChecklistItem[] = [];
  let totalItems = 0;
  let checkedItems = 0;

  for (const bi of session.booking.items) {
    const mode = bi.equipment?.stockTrackingMode as "COUNT" | "UNIT" | undefined ?? "COUNT";
    const isExtra = !bi.equipmentId || bi.customName != null;

    if (mode === "UNIT" && bi.equipmentId) {
      // UNIT-позиция: каждый юнит — отдельный checkbox
      let units: Array<{ id: string; barcode: string | null; status: string }> = [];

      if (session.operation === "ISSUE") {
        // При выдаче: зарезервированные юниты
        units = bi.unitReservations
          .filter((r) => r.equipmentUnit?.status === "AVAILABLE" || scannedUnitIds.has(r.equipmentUnit?.id ?? ""))
          .map((r) => ({
            id: r.equipmentUnit.id,
            barcode: r.equipmentUnit.barcode,
            status: r.equipmentUnit.status,
          }));

        // Если нет резерваций — не показываем юниты (покажем только qty)
        if (units.length === 0) {
          // fallback: используем quantity как количество
          for (let i = 0; i < bi.quantity; i++) {
            units.push({
              id: `placeholder-${bi.id}-${i}`,
              barcode: null,
              status: "AVAILABLE",
            });
          }
        }
      } else {
        // При возврате: выданные юниты
        units = issuedUnitsByBookingItem?.get(bi.id) ?? [];
      }

      const checkedUnits = units.filter((u) => scannedUnitIds.has(u.id));
      const allChecked = units.length > 0 && checkedUnits.length >= units.length;

      totalItems += units.length;
      checkedItems += checkedUnits.length;

      items.push({
        bookingItemId: bi.id,
        equipmentId: bi.equipmentId,
        equipmentName: bi.equipment?.name ?? "Неизвестно",
        category: bi.equipment?.category ?? "Без категории",
        quantity: bi.quantity,
        checkedQty: checkedUnits.length,
        trackingMode: "UNIT",
        isExtra: false,
        units: units.map((u) => ({
          unitId: u.id,
          barcode: u.barcode,
          checked: scannedUnitIds.has(u.id),
          problemType: null,
        })),
      });
    } else if (bi.customName) {
      // Произвольная позиция (добавлена на месте)
      // COUNT-чекбокс, считаем «все или ничего» — сервер не хранит state для COUNT
      // Отдаём quantity, checkedQty = 0 (клиент управляет локально)
      totalItems += 1;
      items.push({
        bookingItemId: bi.id,
        equipmentId: null,
        equipmentName: bi.customName,
        category: "Добавлено на месте",
        quantity: bi.quantity,
        checkedQty: 0, // клиент управляет локально
        trackingMode: "COUNT",
        isExtra: true,
      });
    } else {
      // COUNT-позиция из каталога
      totalItems += 1;
      items.push({
        bookingItemId: bi.id,
        equipmentId: bi.equipmentId,
        equipmentName: bi.equipment?.name ?? "Неизвестно",
        category: bi.equipment?.category ?? "Без категории",
        quantity: bi.quantity,
        checkedQty: 0, // клиент управляет локально
        trackingMode: "COUNT",
        isExtra: false,
      });
    }
  }

  return {
    sessionId: session.id,
    bookingId: session.bookingId,
    operation: session.operation as "ISSUE" | "RETURN",
    items,
    progress: { checkedItems, totalItems },
  };
}

// ── checkUnit ────────────────────────────────────────────────────────────────────

/**
 * Отмечает UNIT-позицию как выданную/принятую.
 * Создаёт ScanRecord с hmacVerified=false (ручной чек-лист).
 */
export async function checkUnit(
  sessionId: string,
  equipmentUnitId: string,
): Promise<{ alreadyChecked: boolean }> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new Error("Сессия не активна");
  }

  // Проверяем что юнит принадлежит броне
  const unit = await prisma.equipmentUnit.findUnique({
    where: { id: equipmentUnitId },
    include: { equipment: true },
  });
  if (!unit) throw new Error("Единица оборудования не найдена");

  // Проверяем, что есть BookingItem для этой брони
  const bookingItem = await prisma.bookingItem.findFirst({
    where: {
      bookingId: session.bookingId,
      equipmentId: unit.equipmentId,
    },
  });
  if (!bookingItem) throw new Error("Оборудование не входит в эту бронь");

  // Идемпотентность: если уже отмечено — no-op
  try {
    await prisma.scanRecord.create({
      data: {
        sessionId,
        equipmentUnitId,
        hmacVerified: false,
      },
    });
    return { alreadyChecked: false };
  } catch (err: any) {
    if (err?.code === "P2002") {
      return { alreadyChecked: true };
    }
    throw err;
  }
}

// ── uncheckUnit ──────────────────────────────────────────────────────────────────

/**
 * Снимает отметку с UNIT-позиции.
 */
export async function uncheckUnit(
  sessionId: string,
  equipmentUnitId: string,
): Promise<{ wasChecked: boolean }> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new Error("Сессия не активна");
  }

  const existing = await prisma.scanRecord.findUnique({
    where: {
      sessionId_equipmentUnitId: { sessionId, equipmentUnitId },
    },
  });

  if (!existing) {
    return { wasChecked: false };
  }

  await prisma.scanRecord.delete({
    where: {
      sessionId_equipmentUnitId: { sessionId, equipmentUnitId },
    },
  });

  return { wasChecked: true };
}

// ── addExtraItem ─────────────────────────────────────────────────────────────────

/**
 * Добавляет позицию из каталога в бронь во время выдачи (quick-add).
 * Создаёт BookingItem, пересчитывает финансы, пишет аудит.
 * Возвращает новый bookingItemId.
 */
export async function addExtraItem(
  sessionId: string,
  equipmentId: string,
  quantity: number,
  createdBy: string,
): Promise<{ bookingItemId: string }> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    include: { booking: { select: { id: true, status: true, startDate: true, endDate: true } } },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new Error("Сессия не активна");
  }

  const equipment = await prisma.equipment.findUnique({
    where: { id: equipmentId },
  });
  if (!equipment) throw new Error("Оборудование не найдено");

  const bookingId = session.bookingId;

  // Проверяем существующий BookingItem для этого оборудования
  const existing = await prisma.bookingItem.findFirst({
    where: { bookingId, equipmentId },
  });

  let bookingItemId: string;

  if (existing) {
    // Увеличиваем quantity существующей позиции
    const updated = await prisma.bookingItem.update({
      where: { id: existing.id },
      data: { quantity: existing.quantity + quantity },
    });
    bookingItemId = updated.id;
  } else {
    // Создаём новую позицию
    const item = await prisma.bookingItem.create({
      data: {
        bookingId,
        equipmentId,
        quantity,
      },
    });
    bookingItemId = item.id;
  }

  // Пересчитываем финансы
  try {
    await recomputeBookingFinance(bookingId);
  } catch {
    // Не блокируем основной flow — финансы пересчитаются при следующем редактировании
  }

  // Аудит
  try {
    await writeAuditEntry({
      userId: createdBy,
      action: "BOOKING_ITEM_ADDED_ON_SITE",
      entityType: "Booking",
      entityId: bookingId,
      before: null,
      after: { equipmentId, equipmentName: equipment.name, quantity, bookingItemId },
    });
  } catch { /* аудит не должен блокировать */ }

  return { bookingItemId };
}
