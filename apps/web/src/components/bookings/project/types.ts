export type ProjectLine = {
  name: string;
  quantity: number;
  fromDate: string;
  throughDate: string;
  shootDays: number;
  restDays: number;
  restFactor: string;
  rate: string;
  amount: string;
};
export type ProjectLot = {
  trackingMode: string;
  id: string;
  equipmentId: string;
  nameSnapshot: string;
  quantity: number;
  ratePerShift: string;
  fromDate: string;
  throughDate: string;
  status: string;
  issuedAt: string | null;
  returns: Array<{
    quantity: number;
    lastBillableDate: string;
    returnedAt: string;
  }>;
  units: Array<{ equipmentUnitId: string; returnedAt: string | null }>;
};
export type ProjectData = {
  bookingId: string;
  revision: number;
  restFactor: string;
  billingCycle: string;
  paymentTermsDays: number;
  fromDate: string;
  throughDate: string;
  booking: {
    id: string;
    projectName: string;
    client: { name: string };
    status: string;
    finalAmount: string;
    amountPaid: string;
    amountOutstanding: string;
    paymentStatus: string;
    paymentForm: string;
    cashlessSurchargePercent: string | null;
  };
  lots: ProjectLot[];
  days: Array<{ date: string; kind: string }>;
  periods: Array<{
    id: string;
    kind: string;
    fromDate: string;
    throughDate: string;
    amount: string;
    dueDate: string;
    createdAt: string;
    linesJson: string;
    correctsId: string | null;
    invoice: { number: string } | null;
  }>;
  allocations: Array<{
    periodId: string;
    charged: string;
    paid: string;
    outstanding: string;
  }>;
  units: Array<{
    id: string;
    equipmentId: string;
    status: string;
    internalInventoryNumber: string | null;
  }>;
  events: Array<{
    id: string;
    text: string;
    createdAt: string;
    createdBy: string;
    createdByName?: string | null;
  }>;
  payments: Array<{
    id: string;
    amount: string;
    receivedAt: string | null;
    voidedAt: string | null;
    method: string;
    comment: string | null;
  }>;
  charges: Array<{
    id: string;
    description: string;
    date: string;
    amount: string;
  }>;
  advance: string;
  forecast: { total: string; lines: ProjectLine[] };
  nextPeriod: {
    fromDate: string;
    throughDate: string;
    total: string;
    lines: ProjectLine[];
  } | null;
};
// 16 px на телефоне — против автозума iOS; с md кегль как у формы обычной брони.
export const projectInput =
  "w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-base text-ink md:text-[13.5px]";
export const projectButton =
  "rounded border border-border bg-surface px-3 py-2 text-sm text-ink hover:bg-surface-muted disabled:opacity-50 disabled:cursor-not-allowed";
export const projectPrimary =
  "rounded bg-accent-bright px-4 py-2 text-sm font-medium text-surface hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed";
export const projectMoney = (value: string | number) =>
  Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₽";
export const shortProjectDate = (value: string) =>
  new Date(
    value.length === 10 ? value + "T12:00:00Z" : value,
  ).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
export const todayMoscow = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
    new Date(),
  );
