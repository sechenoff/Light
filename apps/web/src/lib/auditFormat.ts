import { ACTION_LABELS, ENTITY_LABELS } from "./auditLabels";
import { BOOKING_STATUS_LABELS } from "./bookingConstants";

export type AuditRecord = {
  id: string;
  userId: string;
  user?: { id?: string; username: string; role?: string } | null;
  referenceLabels?: Record<string, string>;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  before: string | Record<string, unknown> | null;
  after: string | Record<string, unknown> | null;
  createdAt: string;
};
export type AuditChange = {
  key: string;
  label: string;
  before: string;
  after: string;
};

const FIELD_LABELS: Record<string, string> = {
  status: "Статус",
  paymentStatus: "Статус оплаты",
  statusFrom: "Статус до изменения",
  statusTo: "Статус после изменения",
  projectName: "Название проекта",
  clientName: "Клиент",
  name: "Название",
  title: "Название",
  username: "Аккаунт",
  role: "Роль",
  isActive: "Доступ к аккаунту",
  passwordChanged: "Пароль",
  startDate: "Начало аренды",
  endDate: "Конец аренды",
  expectedPaymentDate: "Срок оплаты",
  actualPaymentDate: "Дата оплаты",
  receivedAt: "Получен",
  paymentDate: "Дата платежа",
  amount: "Сумма",
  finalAmount: "Итоговая сумма",
  manualFinalAmount: "Договорная сумма",
  amountPaid: "Оплачено",
  amountOutstanding: "Остаток к оплате",
  amountDelta: "Сумма операции",
  total: "Итого",
  paidAmount: "Оплачено",
  totalEstimateAmount: "Сумма сметы",
  discountAmount: "Скидка",
  discountPercent: "Скидка, %",
  surchargeAmount: "Надбавка",
  cashlessSurchargePercent: "Надбавка за безнал, %",
  transportSubtotalRub: "Стоимость транспорта",
  addonAmount: "Сумма добора",
  method: "Способ оплаты",
  paymentMethod: "Способ оплаты",
  paymentForm: "Форма оплаты",
  direction: "Направление платежа",
  comment: "Комментарий",
  note: "Примечание",
  reason: "Причина",
  rejectionReason: "Причина отклонения",
  description: "Описание",
  voidReason: "Причина аннулирования",
  cancelReason: "Причина отмены",
  writeOffReason: "Причина списания",
  writeOffAmount: "Списано",
  quantity: "Количество",
  quantityBefore: "Количество до",
  quantityAfter: "Количество после",
  quantityDelta: "Изменение количества",
  oldQuantity: "Количество до",
  newQuantity: "Количество после",
  totalQuantity: "Всего единиц",
  countedQuantity: "Найдено при пересчёте",
  customName: "Название позиции",
  customUnitPrice: "Цена позиции",
  negotiatedRatePerShift: "Договорная цена за смену",
  unitPrice: "Цена за смену",
  pricePerShift: "Цена за смену",
  subtotalRub: "Стоимость транспорта",
  negotiatedTotalRub: "Договорная цена транспорта",
  driverName: "Водитель",
  driverPhone: "Телефон водителя",
  shiftHours: "Длительность смены, ч",
  kmOutsideMkad: "Пробег за МКАД, км",
  withGenerator: "Генератор",
  skipOvertime: "Без переработок",
  ttkEntry: "Въезд в ТТК",
  skipPartialDay: "Без неполной смены",
  clientId: "Клиент",
  bookingId: "Бронь",
  equipmentId: "Позиция оборудования",
  unitId: "Единица оборудования",
  equipmentUnitId: "Единица оборудования",
  assignedTo: "Ответственный",
  createdBy: "Автор",
  deletedBy: "Кто архивировал",
  userId: "Аккаунт",
  vehicleId: "Транспорт",
  invoiceId: "Счёт",
  paymentId: "Платёж",
  repairId: "Ремонт",
  category: "Категория",
  urgency: "Срочность",
  dueDate: "Срок выполнения",
  dueAt: "Срок выполнения",
  closedAt: "Закрыто",
  deletedAt: "Архивировано",
  issuedAt: "Выдано",
  returnedAt: "Возвращено",
  confirmedAt: "Подтверждено",
  voidedAt: "Аннулировано",
  estimateOptionalNote: "Дополнение к смете",
  estimateIncludeOptionalInExport: "Дополнение включено в документы",
  isFullyPaid: "Полностью оплачено",
  approved: "Одобрено",
  isLocked: "Заблокировано",
  completed: "Выполнено",
  text: "Описание изменения",
  itemsDetails: "Состав брони",
  transportDetails: "Транспорт",
  items: "Позиции",
  number: "Номер",
  docNumber: "Номер документа",
  kind: "Вид",
  phone: "Телефон",
  email: "Электронная почта",
  address: "Адрес",
  count: "Количество",
  reservations: "Резервы",
  unitsUpdated: "Обновлено единиц",
  forcedEarlyIssue: "Досрочная выдача",
  partsCost: "Стоимость запчастей",
  totalTimeHours: "Затрачено часов",
  timeSpentHours: "Затрачено часов",
  partCost: "Стоимость детали",
  source: "Источник",
  resolution: "Результат",
  resolutionNote: "Комментарий к результату",
  resolvedAt: "Завершено",
  missingQuantity: "Недостача",
  damagedQuantity: "Повреждено",
  currentMileage: "Показание счётчика",
  mileage: "Показание счётчика",
  message: "Сообщение",
  operation: "Операция",
  equipmentName: "Оборудование",
  unitName: "Единица оборудования",
  before: "До изменения",
  after: "После изменения",
  from: "Было",
  to: "Стало",
  value: "Значение",
  action: "Действие",
};
const VALUE_LABELS: Record<string, string> = {
  ...BOOKING_STATUS_LABELS,
  NOT_PAID: "Не оплачено",
  PARTIALLY_PAID: "Частично оплачено",
  PARTIAL_PAID: "Частично оплачено",
  PAID: "Оплачено",
  OVERDUE: "Просрочено",
  OVERPAID: "Переплата",
  SUPER_ADMIN: "Руководитель",
  WAREHOUSE: "Кладовщик",
  TECHNICIAN: "Техник",
  COLLECTOR: "Взыскание",
  CASH: "Наличные",
  CASHLESS: "По счёту (ИП)",
  BANK_TRANSFER: "Банковский перевод",
  CARD: "Карта",
  OTHER: "Прочее",
  CREDIT_NOTE: "Зачёт средств",
  PLANNED: "Запланирован",
  RECEIVED: "Получен",
  VOID: "Аннулирован",
  INCOME: "Приход",
  EXPENSE: "Расход",
  WAITING_REPAIR: "Ожидает ремонта",
  IN_REPAIR: "В ремонте",
  WAITING_PARTS: "Ожидает запчастей",
  CLOSED: "Закрыто",
  WROTE_OFF: "Списано",
  NOT_URGENT: "Несрочно",
  NORMAL: "Обычная",
  URGENT: "Срочно",
  OPEN: "Открыто",
  DONE: "Выполнено",
  FULL: "Полный расчёт",
  DEPOSIT: "Залог",
  BALANCE: "Остаток",
  CORRECTION: "Корректировка",
  PERIOD: "Расчётный период",
  NEW: "Новое",
  IN_PROGRESS: "В работе",
  CONVERTED: "Преобразовано",
  PENDING: "Ожидает",
  PROCESSING: "Обрабатывается",
  FAILED: "Ошибка",
  AVAILABLE: "На складе",
  MAINTENANCE: "Обслуживание",
  RETIRED: "Списано",
  MISSING: "Не найдено",
  ISSUE: "Выдача",
  RETURN: "Возврат",
  ACTIVE: "Активно",
  COMPLETED: "Завершено",
  DISABLED: "Отключено",
  MAIN: "Основная смета",
  ADDON: "Дополнительная смета",
  LEFT_ON_SITE: "Оставлено на площадке",
  LOST: "Потеряно",
  STOLEN: "Украдено",
  DESTROYED: "Уничтожено",
  NOT_ON_SHELF: "Не найдено на складе",
  SEARCHING: "Ищем",
  EXPECTED: "Ожидаем возврата",
  FOUND: "Найдено",
  NOT_FOUND: "Не найдено",
  RESOLVED: "Решено",
  MANUAL: "Вручную",
  STOCK_COUNT: "Инвентаризация",
  TRANSPORT: "Транспорт",
  EQUIPMENT: "Оборудование",
  CONTRACTORS: "Подрядчики",
  STAFF: "Персонал",
  RENT: "Аренда",
  REPAIR: "Ремонт",
  PAYROLL: "Зарплата",
  PURCHASE: "Закупка",
  DRAFT_PREVIEW: "Предпросмотр черновика",
  CASH_FLOW: "Движение денег",
  APPROVED: "Одобрено",
  PARSING: "Разбор документа",
  MATCHING: "Сопоставление",
  REVIEW: "На проверке",
  APPLYING: "Применение изменений",
  EXPIRED: "Срок истёк",
  ADJUST: "Исправление учёта",
  ARCHIVED: "В архиве",
  ACCEPTED: "Принято",
  REJECTED: "Отклонено",
  LOW: "Низкий",
  HIGH: "Высокий",
  BUG: "Ошибка",
  IDEA: "Предложение",
  QUESTION: "Вопрос",
  FIXED: "Исправлено",
  KEEP_SEARCHING: "Продолжить поиск",
  ACCOUNTING_ERROR: "Ошибка учёта",
};
const STATUS_BY_ENTITY: Record<string, Record<string, string>> = {
  Booking: BOOKING_STATUS_LABELS,
  Invoice: {
    DRAFT: "Черновик",
    ISSUED: "Выставлен",
    PAID: "Оплачен",
    PARTIAL_PAID: "Частично оплачен",
    VOID: "Аннулирован",
    OVERDUE: "Просрочен",
  },
  Bill: { ISSUED: "Выставлен", PAID: "Оплачен", CANCELLED: "Отменён" },
  EquipmentUnit: { ISSUED: "В аренде" },
  Unit: { ISSUED: "В аренде" },
};
const HIDDEN =
  /^(id|createdAt|updatedAt|revision|version|auditActor|auditSource|via)$|password(?!Changed)|hash|token|secret|api.?key|authorization|cookie/i;

export function parseAuditSnapshot(
  raw: AuditRecord["before"],
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const result: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
export function auditTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Дата не сохранена"
    : new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date) + " МСК";
}
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? "Изменение записи";
}
export function auditEntityLabel(type: string): string {
  return ENTITY_LABELS[type] ?? "Запись";
}
export function auditActorLabel(
  record: Pick<AuditRecord, "userId" | "user">,
): string {
  if (record.userId === "_system_" || record.user?.username === "_system_")
    return "Система";
  return record.user?.username ?? "Автор не сохранён";
}
export function auditValue(
  key: string,
  value: unknown,
  entityType = "",
  references: Record<string, string> = {},
): string {
  if (value === undefined) return "Не сохранено";
  if (value === null || value === "") return "Не указано";
  if (key === "passwordChanged") return value ? "Изменён" : "Без изменений";
  if (typeof value === "boolean")
    return key === "isActive"
      ? value
        ? "Включён"
        : "Отключён"
      : value
        ? "Да"
        : "Нет";
  if (Array.isArray(value))
    return (
      value.map((v) => auditValue(key, v, entityType, references)).join("; ") ||
      "Нет"
    );
  if (typeof value === "object")
    return (
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !HIDDEN.test(k))
        .map(
          ([k, v]) =>
            `${FIELD_LABELS[k] ?? "Значение"}: ${auditValue(k, v, entityType, references)}`,
        )
        .join("; ") || "Нет"
    );
  const raw = String(value);
  if (/(Date|At)$/.test(key) && /^\d{4}-\d{2}-\d{2}/.test(raw))
    return auditTimestamp(raw);
  if (key === "status" && STATUS_BY_ENTITY[entityType]?.[raw])
    return STATUS_BY_ENTITY[entityType][raw];
  const enumField =
    /status|role|method|paymentForm|direction|category|urgency|kind|source|resolution|operation|action|decision|^from$|^to$/i.test(
      key,
    );
  if (enumField && VALUE_LABELS[raw]) return VALUE_LABELS[raw];
  if (
    /(amount|total|cost|price|subtotal|ratePerShift|Rub)$/i.test(key) &&
    /^-?\d+(\.\d+)?$/.test(raw)
  )
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      maximumFractionDigits: 2,
    }).format(Number(raw));
  if (/Id$/.test(key) || ["assignedTo", "createdBy", "deletedBy"].includes(key))
    return references[raw] ?? `Запись № ${raw}`;
  if (enumField && /^[A-Z][A-Z_]{2,}$/.test(raw)) return "Другое значение";
  return raw;
}
function flatten(
  obj: Record<string, unknown>,
  prefix = "",
  labels: string[] = [],
): Map<string, { label: string; value: unknown; field: string }> {
  const result = new Map<
    string,
    { label: string; value: unknown; field: string }
  >();
  for (const [key, value] of Object.entries(obj)) {
    if (HIDDEN.test(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const label =
      FIELD_LABELS[key] ??
      (prefix.startsWith("itemsDetails") ||
      prefix.startsWith("transportDetails")
        ? key
        : "Дополнительные сведения");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of flatten(value as Record<string, unknown>, path, [
        ...labels,
        label,
      ]))
        result.set(k, v);
    } else
      result.set(path, {
        label: [...labels, label].join(" · "),
        value,
        field: key,
      });
  }
  return result;
}
export function auditChanges(
  record: Pick<
    AuditRecord,
    "before" | "after" | "entityType" | "referenceLabels"
  >,
): AuditChange[] {
  const before = flatten(parseAuditSnapshot(record.before)),
    after = flatten(parseAuditSnapshot(record.after));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    const b = before.get(key),
      a = after.get(key),
      descriptor = a ?? b!;
    if (b && a && JSON.stringify(b.value) === JSON.stringify(a.value))
      return [];
    return [
      {
        key,
        label: descriptor.label,
        before:
          descriptor.field === "passwordChanged"
            ? "—"
            : b
              ? auditValue(
                  descriptor.field,
                  b.value,
                  record.entityType,
                  record.referenceLabels,
                )
              : record.before === null
                ? "—"
                : /^(itemsDetails|transportDetails)\./.test(key)
                  ? "Не было"
                  : "Не сохранено",
        after: a
          ? auditValue(
              descriptor.field,
              a.value,
              record.entityType,
              record.referenceLabels,
            )
          : record.after === null ||
              /^(itemsDetails|transportDetails)\./.test(key)
            ? "Удалено"
            : "Не сохранено",
      },
    ];
  });
}
