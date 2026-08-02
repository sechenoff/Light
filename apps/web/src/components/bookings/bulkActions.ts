/**
 * Групповые действия над бронями (мультивыбор на /bookings) — чистая логика:
 * какие действия существуют, к каким броням они применимы и что показать в
 * подтверждении. Ни React, ни сеть — чтобы правила применимости можно было
 * покрыть тестами без рендера страницы.
 *
 * Правила зеркалят серверный `services/bookingBulk.ts`. Клиент не «решает»
 * права — он лишь не предлагает заведомо невыполнимое; финальную проверку
 * всегда делает сервер, и его отказ по конкретной брони приходит в отчёт.
 */

export type BulkAction = "approve" | "submit" | "cancel" | "archive";

/** Минимум полей строки, нужный для решения о применимости. */
export type BulkBookingRow = {
  id: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  amountPaid: string;
};

export type BulkActionContext = {
  isSuperAdmin: boolean;
  /** APPROVAL_MODE=auto — согласование выключено, «отправить» сразу подтверждает. */
  approvalMode: "auto" | "manual";
};

function isPaid(row: BulkBookingRow): boolean {
  return Number(row.amountPaid ?? "0") > 0;
}

/**
 * Применимо ли действие к конкретной брони.
 *
 * Отмена намеренно требует нулевой оплаты ДАЖЕ для руководителя: депозит
 * оплаченной брони нужно распределить (возврат / кредит-нота / удержание),
 * и это решение принимается по каждой брони отдельно на её карточке, а не
 * галочкой в списке.
 */
export function isActionApplicable(
  action: BulkAction,
  row: BulkBookingRow,
  ctx: BulkActionContext,
): boolean {
  switch (action) {
    case "approve":
      return ctx.isSuperAdmin && row.status === "PENDING_APPROVAL";
    case "submit":
      // Только черновики. Возврат уже подтверждённой брони на согласование —
      // осмысленное одиночное действие, но пачкой это слишком лёгкий способ
      // случайно снять подтверждение с десятка активных броней.
      return row.status === "DRAFT";
    case "cancel":
      return !["CANCELLED", "RETURNED", "ISSUED"].includes(row.status) && !isPaid(row);
    case "archive":
      return ctx.isSuperAdmin;
    default:
      return false;
  }
}

/** Доступно ли действие роли в принципе (показывать ли кнопку). */
export function isActionVisible(action: BulkAction, ctx: BulkActionContext): boolean {
  if (action === "approve" || action === "archive") return ctx.isSuperAdmin;
  return true;
}

export type BulkActionMeta = {
  action: BulkAction;
  label: string;
  /** Кнопка деструктивная — красная подсветка и danger-тон в подтверждении. */
  danger: boolean;
  /** Заголовок модалки подтверждения. */
  confirmTitle: string;
  confirmLabel: string;
  /** Текст подтверждения; n — сколько броней реально попадёт под действие. */
  confirmMessage: (n: number) => string;
};

export function bulkActionMeta(action: BulkAction, ctx: BulkActionContext): BulkActionMeta {
  switch (action) {
    case "approve":
      return {
        action,
        label: "Согласовать",
        danger: false,
        confirmTitle: "Согласование броней",
        confirmLabel: "Согласовать",
        confirmMessage: (n) =>
          `Согласовать ${n} ${pluralBookings(n)}?\n\nКаждая пройдёт проверку доступности и зарезервирует оборудование. Если по какой-то из них оборудование уже занято — она останется на согласовании, остальные будут подтверждены.`,
      };
    case "submit":
      return ctx.approvalMode === "auto"
        ? {
            action,
            label: "Подтвердить",
            danger: false,
            confirmTitle: "Подтверждение броней",
            confirmLabel: "Подтвердить",
            confirmMessage: (n) =>
              `Подтвердить ${n} ${pluralBookings(n)}?\n\nСогласование отключено — брони подтверждаются сразу и резервируют оборудование.`,
          }
        : {
            action,
            label: "На согласование",
            danger: false,
            confirmTitle: "Отправка на согласование",
            confirmLabel: "Отправить",
            confirmMessage: (n) =>
              `Отправить ${n} ${pluralBookings(n)} руководителю на согласование?`,
          };
    case "cancel":
      return {
        action,
        label: "Отменить",
        danger: true,
        confirmTitle: "Отмена броней",
        confirmLabel: "Отменить брони",
        confirmMessage: (n) =>
          `Отменить ${n} ${pluralBookings(n)}?\n\nРезервы оборудования будут сняты, статус станет финальным «Отменено» — вернуть брони через интерфейс будет нельзя.`,
      };
    case "archive":
    default:
      return {
        action: "archive",
        label: "В архив",
        danger: true,
        confirmTitle: "Отправка в архив",
        confirmLabel: "В архив",
        // Про резервы предупреждаем явно: архивация не-терминальной брони
        // снимает бронирование юнитов, и оборудование возвращается в
        // доступные. Для выданной брони это значит, что склад увидит
        // свободным то, что физически на руках у клиента.
        confirmMessage: (n) =>
          `Отправить ${n} ${pluralBookings(n)} в архив?\n\nРезервы оборудования будут сняты — по незакрытым броням оно вернётся в доступные. Брони пропадут из списка, но останутся в БД: вернуть можно из архива (/bookings/archive).`,
      };
  }
}

/** «бронь / брони / броней» — винительный падеж для «Согласовать N …». */
export function pluralBookings(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "броней";
  if (mod10 === 1) return "бронь";
  if (mod10 >= 2 && mod10 <= 4) return "брони";
  return "броней";
}

/** Порядок кнопок в панели: сначала созидательные, деструктивные — справа. */
export const BULK_ACTION_ORDER: BulkAction[] = ["approve", "submit", "cancel", "archive"];

/**
 * Из выбранных id — те, к которым действие реально применимо.
 * Порядок сохраняется по порядку строк списка (важно для предсказуемого
 * отчёта: он читается сверху вниз, как сам список).
 */
export function eligibleIds(
  rows: BulkBookingRow[],
  selected: ReadonlySet<string>,
  action: BulkAction,
  ctx: BulkActionContext,
): string[] {
  return rows
    .filter((r) => selected.has(r.id) && isActionApplicable(action, r, ctx))
    .map((r) => r.id);
}
