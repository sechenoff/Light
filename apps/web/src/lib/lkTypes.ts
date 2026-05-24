export type LkBookingStatus = "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";

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

export type LkDebtRow = {
  bookingId: string;
  bookingNo: string;
  invoiceNumber: string | null;
  issuedAt: string;
  dueDate: string | null;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  ageDays: number;
  isOverdue: boolean;
};

export type LkDebtResponse = {
  totalOutstanding: string;
  overdueCount: number;
  invoices: LkDebtRow[];
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
