// Единый канон подписей и вариантов статусов брони (фаза 4.1).
// Раньше был скопирован в 4 файлах и успел разъехаться: список/edit — женский
// род («Подтверждена»), карточка/архив — средний («Подтверждено»); CONFIRMED
// в списке — variant "info", в карточке — "full". Канон: женский род («бронь»)
// + семантика вариантов из списка броней.

export type BookingStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "CONFIRMED"
  | "ISSUED"
  | "RETURNED"
  | "CANCELLED";

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  DRAFT: "Черновик",
  PENDING_APPROVAL: "На согласовании",
  CONFIRMED: "Подтверждена",
  ISSUED: "Выдана",
  RETURNED: "Возвращена",
  CANCELLED: "Отменена",
};

// Семантика жизненного цикла: каждая стадия — свой variant (не два одинаковых
// зелёных). CONFIRMED/ISSUED — нейтрально-активные (accent/teal), RETURNED —
// «хорошо, закрыто» (emerald), CANCELLED — нейтрально гашёный.
export type BookingStatusVariant = "view" | "warn" | "info" | "edit" | "ok" | "none";

export const BOOKING_STATUS_VARIANTS: Record<BookingStatus, BookingStatusVariant> = {
  DRAFT: "view",             // slate — черновик
  PENDING_APPROVAL: "warn",  // amber — ждёт согласования
  CONFIRMED: "info",         // accent — подтверждена, активна
  ISSUED: "edit",            // teal — выдана, в работе
  RETURNED: "ok",            // emerald — возвращена, закрыта
  CANCELLED: "none",         // gray — отменена
};

export const bookingStatusLabel = (s: BookingStatus): string => BOOKING_STATUS_LABELS[s];
export const bookingStatusVariant = (s: BookingStatus): BookingStatusVariant =>
  BOOKING_STATUS_VARIANTS[s];
