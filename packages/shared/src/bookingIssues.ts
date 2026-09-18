export const BOOKING_ISSUE_FILTERS = {
  open: "Есть открытые проблемы",
  missing: "Есть недостача",
  damage: "Есть повреждения",
  waiting: "Ждём возврат с площадки",
  overdue: "Просрочен срок решения",
  history: "Есть история проблем",
} as const;

export interface BookingIssueSummary {
  openCases: number;
  missingCases: number;
  missingQuantity: number;
  damageCases: number;
  damageQuantity: number;
  waitingCases: number;
  overdueCases: number;
  closedCases: number;
}

export interface BookingIssue {
  id: string;
  kind: "missing" | "damage";
  equipmentName: string;
  quantity: number;
  title: string;
  description: string;
  statusLabel: string;
  open: boolean;
  overdue: boolean;
  expectedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  assignedTo: string | null;
  closedAt: string | null;
  closedBy: string | null;
  resolution: string | null;
  nextStep: string;
  photos: Array<{ id: string; url: string }>;
  href: string;
}

export interface BookingIssuesResponse {
  booking: { id: string; projectName: string; clientName: string; archived: boolean };
  summary: BookingIssueSummary;
  items: BookingIssue[];
}
