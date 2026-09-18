/**
 * Подписи журнала аудита (/admin/audit): типы объектов, действия и ссылки на
 * карточки. Данные, а не страница — чтобы их можно было проверить тестом и
 * чтобы коды (STOCK_ADJUST, Equipment…) не утекали в интерфейс сырыми.
 */

// Русские подписи типов объектов — полный AuditEntityType union из services/audit.ts.
export const ENTITY_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "Booking", label: "Бронь" },
  { value: "Payment", label: "Платёж" },
  { value: "Invoice", label: "Счёт" },
  { value: "Refund", label: "Возврат средств" },
  { value: "CreditNote", label: "Кредит-нота" },
  { value: "Expense", label: "Расход" },
  { value: "Client", label: "Клиент" },
  { value: "Repair", label: "Ремонт" },
  { value: "Unit", label: "Единица (legacy)" },
  { value: "EquipmentUnit", label: "Единица оборудования" },
  { value: "ProblemItem", label: "Потеряшка" },
  { value: "Task", label: "Задача" },
  { value: "Vehicle", label: "Транспорт" },
  { value: "AdminUser", label: "Пользователь" },
  { value: "OrgSettings", label: "Настройки организации" },
  { value: "Feedback", label: "Отзыв" },
  { value: "ClientPortalAccount", label: "Портал клиента" },
  { value: "Bill", label: "Счёт на оплату" },
  { value: "StockCount", label: "Инвентаризация" },
  { value: "Equipment", label: "Позиция каталога" },
];

/** Русские подписи типов объектов для ячеек таблицы (сырой код — в title). */
export const ENTITY_LABELS: Record<string, string> = Object.fromEntries(
  ENTITY_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

/**
 * Русские подписи действий аудита. Собрано по всем writeAuditEntry в apps/api/src.
 * Для неизвестных кодов — fallback на сырой код в mono (см. AuditRow).
 */
export const ACTION_LABELS: Record<string, string> = {
  // Брони
  BOOKING_SUBMITTED: "Бронь отправлена на согласование",
  BOOKING_APPROVED: "Бронь одобрена",
  BOOKING_REJECTED: "Бронь отклонена",
  BOOKING_ISSUED: "Выдача по брони",
  BOOKING_RETURNED: "Возврат по брони",
  BOOKING_STATUS_CHANGED: "Статус брони изменён",
  BOOKING_ARCHIVED: "Бронь архивирована",
  BOOKING_RESTORED: "Бронь восстановлена",
  BOOKING_PURGED: "Бронь удалена навсегда",
  BOOKING_BACKDATE_EDIT: "Бронь изменена задним числом",
  BOOKING_RETROACTIVE_EDIT: "Ретроактивная правка брони",
  BOOKING_EDITED_IN_REVIEW: "Бронь изменена на согласовании",
  BOOKING_EXTENDED: "Бронь продлена",
  BOOKING_CORRECTED: "Бронь скорректирована",
  BOOKING_CLIENT_CHANGED: "Клиент брони изменён",
  BOOKING_CANCEL_WITH_DEPOSIT: "Отмена брони с залогом",
  BOOKING_DEPOSIT_FORFEITED: "Залог удержан",
  BOOKING_UNITS_RELEASED: "Юниты брони освобождены",
  BOOKING_ITEM_UNIT_RELEASED: "Юнит позиции освобождён",
  BOOKING_ITEM_ADDED_ON_SITE: "Позиция добавлена на выдаче",
  BOOKING_ITEM_ADDED_WITH_CONFLICT: "Позиция добавлена с конфликтом",
  BOOKING_ITEM_QUANTITY_INCREASED: "Количество позиции увеличено",
  BOOKING_ITEM_QUANTITY_REDUCED: "Количество позиции уменьшено",
  BOOKING_VEHICLE_DRIVER_SET: "Водитель назначен на бронь",
  BOOKING_CONFIRMED_VIA_BOT: "Бронь подтверждена через бота",
  LEGACY_IMPORTED: "Импорт из старой базы",
  // Платежи и финансы
  PAYMENT_CREATE: "Платёж создан",
  PAYMENT_CREATE_BY_WH: "Платёж создан кладовщиком",
  PAYMENT_CREATE_FROM_CREDIT: "Платёж из кредит-ноты",
  PAYMENT_UPDATE: "Платёж изменён",
  PAYMENT_VOID: "Платёж аннулирован",
  INVOICE_CREATE: "Счёт создан",
  INVOICE_UPDATE: "Счёт изменён",
  INVOICE_ISSUE: "Счёт выставлен",
  INVOICE_VOID: "Счёт аннулирован",
  REFUND_CREATE: "Возврат средств создан",
  CREDIT_NOTE_CREATE: "Кредит-нота создана",
  CREDIT_NOTE_APPLY: "Кредит-нота применена",
  EXPENSE_CREATE: "Расход создан",
  EXPENSE_UPDATE: "Расход изменён",
  EXPENSE_DELETE: "Расход удалён",
  EXPENSE_APPROVE: "Расход одобрен",
  // Клиенты и портал
  CLIENT_CREATE: "Клиент создан",
  CLIENT_UPDATE: "Клиент изменён",
  CLIENT_DELETE: "Клиент удалён",
  CLIENT_REMINDED: "Напоминание клиенту",
  CLIENT_PORTAL_INVITE_SENT: "Приглашение в портал отправлено",
  CLIENT_PORTAL_INVITE_RESENT: "Приглашение в портал отправлено повторно",
  CLIENT_PORTAL_DISABLED: "Портал клиента отключён",
  CLIENT_PORTAL_REENABLED: "Портал клиента включён",
  // Мастерская
  REPAIR_CREATE: "Ремонт создан",
  REPAIR_CREATE_FAILED: "Ошибка создания ремонта",
  REPAIR_TAKE: "Ремонт взят в работу",
  REPAIR_ASSIGN: "Ремонт назначен",
  REPAIR_STATUS_CHANGE: "Статус ремонта изменён",
  REPAIR_WORK_LOG: "Запись работ по ремонту",
  REPAIR_CLOSE: "Ремонт закрыт",
  REPAIR_WRITE_OFF: "Единица списана",
  // Потеряшки и юниты
  PROBLEM_ITEM_CREATE: "Потеряшка создана",
  PROBLEM_ITEM_RESOLVE: "Потеряшка разобрана",
  UNIT_STATUS_MANUAL_CHANGE: "Статус юнита изменён",
  // Задачи
  TASK_CREATE: "Задача создана",
  TASK_UPDATE: "Задача изменена",
  TASK_ASSIGN: "Задача назначена",
  TASK_COMPLETE: "Задача выполнена",
  TASK_REOPEN: "Задача возвращена в работу",
  TASK_DELETE: "Задача удалена",
  TASK_COMMENT_ADD: "Комментарий к задаче",
  TASK_COMMENT_DELETE: "Комментарий к задаче удалён",
  TASK_CHECKLIST_ADD: "Пункт чеклиста добавлен",
  TASK_CHECKLIST_DELETE: "Пункт чеклиста удалён",
  // Фидбек
  FEEDBACK_CREATE: "Отзыв создан",
  FEEDBACK_UPDATE: "Отзыв изменён",
  FEEDBACK_DELETE: "Отзыв удалён",
  FEEDBACK_STATUS_CHANGE: "Статус отзыва изменён",
  FEEDBACK_COMMENT_ADD: "Комментарий к отзыву",
  FEEDBACK_COMMENT_DELETE: "Комментарий к отзыву удалён",
  // Транспорт
  VEHICLE_UPDATE: "Автомобиль изменён",
  VEHICLE_UPDATED: "Автомобиль изменён (legacy)",
  VEHICLE_SERVICE_ADD: "ТО автомобиля добавлено",
  VEHICLE_MILEAGE_LOG: "Пробег записан",
  VEHICLE_MILEAGE_CORRECTION: "Пробег скорректирован",
  // Инвентаризация
  STOCK_COUNT_START: "Инвентаризация начата",
  STOCK_COUNT_DECISION: "Инвентаризация: решено «Ошибка учёта»",
  STOCK_COUNT_CLOSE: "Инвентаризация завершена",
  STOCK_COUNT_CANCEL: "Инвентаризация отменена",
  STOCK_ADJUST: "Ошибка учёта: количество поправлено",
  // Пользователи и настройки
  ADMIN_USER_CREATE: "Пользователь создан",
  ADMIN_USER_UPDATE: "Пользователь изменён",
  ADMIN_USER_DELETE: "Пользователь удалён",
  ORG_SETTINGS_UPDATE: "Настройки организации изменены",
};

/** Ссылка на карточку сущности, если у неё есть своя страница. */
export function entityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "Booking": return `/bookings/${entityId}`;
    case "Task":    return `/tasks?task=${entityId}`;
    // У позиции каталога своей карточки нет (/equipment/[id]/units — другое), поэтому без ссылки.
    case "StockCount": return `/warehouse/inventory/${entityId}`;
    default:        return null;
  }
}
