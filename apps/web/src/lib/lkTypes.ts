export type LkBookingStatus = "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";

// lk-dashboard-raw-status: единый источник русских подписей статусов для портала.
// Раньше дашборд показывал ENUM (ISSUED/CONFIRMED), а списки — русские подписи,
// объявленные дважды локально. Теперь — один словарь.
export const LK_STATUS_LABEL: Record<LkBookingStatus, string> = {
  CONFIRMED: "Подтверждена",
  ISSUED: "В работе",
  RETURNED: "Возвращена",
  CANCELLED: "Отменена",
};

export type LkBookingListItem = {
  id: string;
  bookingNo: string;
  projectName: string | null;
  startDate: string;
  endDate: string;
  status: LkBookingStatus;
  finalAmount: string;
  amountOutstanding: string;
  itemCount: number;
};

export type LkBookingDetail = {
  id: string;
  bookingNo: string;
  projectName: string | null;
  startDate: string;
  endDate: string;
  status: LkBookingStatus;
  shifts: number;
  items: { categorySnapshot: string; nameSnapshot: string; quantity: number; unitPrice: string; lineSum: string }[];
  subtotal: string;
  discountAmount: string;
  totalAfterDiscount: string;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  comment: string | null;
  optionalNote: string | null;
  hasConfirmedEstimate: boolean;
  hasAct: boolean;
};

export type LkEstimateListItem = {
  bookingId: string;
  bookingNo: string;
  projectName: string | null;
  issuedAt: string;
  totalAfterDiscount: string;
  pdfUrl: string;
};

// lk-debt-by-bookings: долг в ЛК считается по броням (Booking.amountOutstanding),
// как в админском /finance/debts — единый источник истины. Счёт, если выставлен,
// приходит как детализация строки.
export type LkDebtRow = {
  bookingId: string;
  bookingNo: string;
  projectName: string | null;
  startDate: string;
  endDate: string;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  isOverdue: boolean;
  invoice: { number: string; dueDate: string | null } | null;
};

export type LkDebtResponse = {
  totalOutstanding: string;
  overdueCount: number;
  bookings: LkDebtRow[];
};

export type LkStatsResponse = {
  period: "180d" | "365d" | "all";
  rangeFrom: string | null;
  rangeTo: string;
  topEquipment: { equipmentId: string; name: string; category: string; bookingsCount: number; totalQuantityRented: number; totalSpentRub: string }[];
  typicalKit: { equipmentId: string; name: string; category: string; frequency: number }[];
  typicalKitSampleSize: number;
};

export type LkMe = {
  account: { email: string; lastLoginAt: string | null };
  client: { id: string; name: string; phone: string | null; email: string | null };
};
