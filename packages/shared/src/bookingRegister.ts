/** Read-only contract shared by bookings, finance links and the operations view. */
export const REGISTER_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "ISSUED",
  "RETURNED",
  "CANCELLED",
] as const;
export const REGISTER_SCOPES = [
  "active",
  "unpaid",
  "overdue",
  "paid",
  "issued",
  "pending",
  "completed",
  "all",
] as const;
export const REGISTER_SORTS = [
  "startDate",
  "endDate",
  "createdAt",
  "dueDate",
  "outstanding",
  "total",
  "client",
] as const;
export const REGISTER_DATE_FIELDS = [
  "rental",
  "start",
  "end",
  "due",
  "created",
] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];
export type RegisterScope = (typeof REGISTER_SCOPES)[number];
export type RegisterFinanceState =
  | "UNPRICED"
  | "NO_CHARGES"
  | "ZERO"
  | "UNPAID"
  | "PARTIAL"
  | "PAID"
  | "SETTLED"
  | "CREDIT";
export type RegisterAction =
  | "prepare"
  | "approve"
  | "issue"
  | "return"
  | "payment"
  | "period"
  | "review";
export const REGISTER_FINANCE_LABELS: Record<RegisterFinanceState, string> = {
  UNPRICED: "Не рассчитано",
  NO_CHARGES: "Нет начислений",
  ZERO: "К оплате 0 ₽",
  UNPAID: "Не оплачено",
  PARTIAL: "Частично оплачено",
  PAID: "Оплачено",
  SETTLED: "Расчёт со списанием",
  CREDIT: "Аванс / переплата",
};
export interface BookingRegisterRow {
  id: string;
  docNumber: string | null;
  mode: "STANDARD" | "PROJECT";
  status: RegisterStatus;
  projectName: string;
  client: { id: string; name: string };
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
  expectedPaymentDate: string | null;
  confirmedAt: string | null;
  issuedAt: string | null;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  writeOffAmount: string;
  paymentStatus: string;
  paymentForm: string;
  legacyFinance: boolean;
  hasScanSessions: boolean;
  lastScanOperation: string | null;
  lastScanStatus: string | null;
  financeState: RegisterFinanceState;
  overdueAmount: string;
  overdueDays: number;
  creditAmount: string;
  completed: boolean;
  returnOverdue: boolean;
  openProblems: number;
  issues?: import("./bookingIssues").BookingIssueSummary;
  needsReview: boolean;
  actions: RegisterAction[];
  onHand: number;
  projectSummary: null | {
    periodCount: number;
    closedThrough: string | null;
    nextCloseDate: string | null;
    unclosedBilling: boolean;
    plannedQuantity: number;
    totalQuantity: number;
  };
}
export interface BookingRegisterEvent {
  id: string;
  bookingId: string;
  kind: "ISSUE" | "RETURN" | "ADDON" | "PERIOD";
  date: string;
  time: string | null;
  quantity: number | null;
  label: string;
}
export interface RegisterTotals {
  count: number;
  outstanding: string;
  overdue: string;
  total: string;
  paid: string;
}
export interface BookingRegisterResponse {
  bookings: BookingRegisterRow[];
  nextCursor: string | null;
  totalCount: number;
  totals: RegisterTotals;
  scopeCounts: Record<RegisterScope, number>;
  summary: RegisterTotals & {
    active: number;
    issued: number;
    unpaid: number;
    overdueCount: number;
    pending: number;
  };
  options: {
    clients: Array<{ id: string; name: string }>;
    projects: Array<{ id: string; name: string }>;
  };
  day: {
    date: string;
    events: BookingRegisterEvent[];
    bookings: BookingRegisterRow[];
  };
  asOf: string;
}
