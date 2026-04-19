// Gaffer CRM API client
// Wraps /api/gaffer/* endpoints, forwards cookies automatically.

// ── Types ──────────────────────────────────────────────────────────────────

export interface GafferUser {
  id: string;
  email: string;
  name?: string | null;
  onboardingCompletedAt?: string | null;
}

export interface GafferContact {
  id: string;
  type: "CLIENT" | "TEAM_MEMBER" | "VENDOR";
  name: string;
  phone?: string | null;
  telegram?: string | null;
  note?: string | null;
  isArchived: boolean;
  gafferUserId: string;
  createdAt: string;
  updatedAt: string;
  shiftRate: string;          // Decimal as string
  overtimeTier1Rate: string;  // Decimal as string
  overtimeTier2Rate: string;  // Decimal as string
  overtimeTier3Rate: string;  // Decimal as string
  roleLabel?: string | null;
}

export interface GafferPaymentMethod {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  gafferUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ── Error class ────────────────────────────────────────────────────────────

export class GafferApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GafferApiError";
    this.status = status;
    this.code = code;
  }
}

// ── Base fetch ─────────────────────────────────────────────────────────────

export async function gafferFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(`/api/gaffer${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const obj =
      typeof json === "object" && json !== null
        ? (json as Record<string, unknown>)
        : null;
    const message =
      typeof obj?.message === "string" ? obj.message : `Ошибка ${res.status}`;
    const code =
      typeof obj?.code === "string"
        ? obj.code
        : typeof obj?.details === "string"
          ? obj.details
          : undefined;
    throw new GafferApiError(message, res.status, code);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// ── Auth ───────────────────────────────────────────────────────────────────

export async function gafferLogin(
  email: string,
  password?: string,
): Promise<{ user: GafferUser; token: string; legacy?: boolean }> {
  return gafferFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify(password ? { email, password } : { email }),
  });
}

export async function gafferRegister(data: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ user: GafferUser; token: string }> {
  return gafferFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function gafferForgotPassword(
  email: string,
): Promise<{ ok: boolean; message: string }> {
  return gafferFetch("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function gafferOAuthGoogle(): Promise<{ ok: true }> {
  return gafferFetch("/auth/oauth/google", { method: "POST" });
}

export async function gafferOAuthTelegram(): Promise<{ ok: true }> {
  return gafferFetch("/auth/oauth/telegram", { method: "POST" });
}

export async function gafferLogout(): Promise<void> {
  return gafferFetch("/auth/logout", { method: "POST" });
}

export async function gafferMe(): Promise<{ user: GafferUser }> {
  return gafferFetch("/auth/me");
}

export async function completeOnboarding(): Promise<{ user: GafferUser }> {
  return gafferFetch("/auth/complete-onboarding", { method: "POST" });
}

// ── Contacts ───────────────────────────────────────────────────────────────

export async function listContacts(params?: {
  type?: "CLIENT" | "TEAM_MEMBER" | "VENDOR";
  isArchived?: boolean | "all";
  search?: string;
}): Promise<{ items: GafferContact[] }> {
  const q = new URLSearchParams();
  if (params?.type) q.set("type", params.type);
  if (params?.isArchived !== undefined)
    q.set("isArchived", String(params.isArchived));
  if (params?.search) q.set("search", params.search);
  const qs = q.toString() ? `?${q.toString()}` : "";
  return gafferFetch(`/contacts${qs}`);
}

export async function getContact(id: string): Promise<{ contact: GafferContact }> {
  return gafferFetch(`/contacts/${id}`);
}

export async function createContact(data: {
  type: "CLIENT" | "TEAM_MEMBER" | "VENDOR";
  name: string;
  phone?: string;
  telegram?: string;
  note?: string;
  shiftRate?: string | number;
  overtimeTier1Rate?: string | number;
  overtimeTier2Rate?: string | number;
  overtimeTier3Rate?: string | number;
  roleLabel?: string | null;
}): Promise<{ contact: GafferContact }> {
  return gafferFetch("/contacts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateContact(
  id: string,
  data: {
    name?: string;
    phone?: string;
    telegram?: string;
    note?: string;
    shiftRate?: string | number;
    overtimeTier1Rate?: string | number;
    overtimeTier2Rate?: string | number;
    overtimeTier3Rate?: string | number;
    roleLabel?: string | null;
  },
): Promise<{ contact: GafferContact }> {
  return gafferFetch(`/contacts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function archiveContact(
  id: string,
): Promise<{ contact: GafferContact }> {
  return gafferFetch(`/contacts/${id}/archive`, { method: "POST" });
}

export async function unarchiveContact(
  id: string,
): Promise<{ contact: GafferContact }> {
  return gafferFetch(`/contacts/${id}/unarchive`, { method: "POST" });
}

export async function deleteContact(id: string): Promise<void> {
  return gafferFetch(`/contacts/${id}`, { method: "DELETE" });
}

// ── Payment methods ────────────────────────────────────────────────────────

export async function listPaymentMethods(): Promise<{
  items: GafferPaymentMethod[];
}> {
  return gafferFetch("/payment-methods");
}

export async function createPaymentMethod(data: {
  name: string;
  isDefault?: boolean;
}): Promise<{ paymentMethod: GafferPaymentMethod }> {
  return gafferFetch("/payment-methods", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updatePaymentMethod(
  id: string,
  data: { name?: string; isDefault?: boolean; sortOrder?: number },
): Promise<{ paymentMethod: GafferPaymentMethod }> {
  return gafferFetch(`/payment-methods/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deletePaymentMethod(id: string): Promise<void> {
  return gafferFetch(`/payment-methods/${id}`, { method: "DELETE" });
}

export async function reorderPaymentMethods(
  ids: string[],
): Promise<{ items: GafferPaymentMethod[] }> {
  return gafferFetch("/payment-methods/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

// ── Projects ───────────────────────────────────────────────────────────────

export interface GafferProject {
  id: string;
  title: string;
  status: "OPEN" | "ARCHIVED";
  shootDate: string; // ISO date string
  clientPlanAmount: string; // Decimal as string — бюджет на осветителей
  lightBudgetAmount: string; // Decimal as string — бюджет на свет
  note?: string | null;
  gafferUserId: string;
  clientId: string;
  createdAt: string;
  updatedAt: string;
  // Aggregates (returned on list + detail)
  clientReceived?: string;
  clientTotal?: string;
  clientRemaining?: string;
  teamPlanTotal?: string;
  teamPaidTotal?: string;
  teamRemaining?: string;
  vendorPlanTotal?: string;
  vendorPaidTotal?: string;
  vendorRemaining?: string;
  // Relations (on detail)
  client?: GafferContact;
  members?: GafferProjectMember[];
  payments?: GafferPayment[];
}

export interface GafferProjectMember {
  id: string;
  projectId: string;
  contactId: string;
  plannedAmount: string; // Decimal as string
  roleLabel?: string | null;
  paidToMe?: string; // Decimal as string, computed aggregate
  remaining?: string; // Decimal as string
  contact?: GafferContact;
  createdAt: string;
  updatedAt: string;
}

export interface GafferPayment {
  id: string;
  projectId: string;
  direction: "IN" | "OUT";
  amount: string; // Decimal as string
  paidAt: string; // ISO date string
  paymentMethodId?: string | null;
  memberId?: string | null;
  comment?: string | null;
  createdAt: string;
  updatedAt: string;
  paymentMethod?: GafferPaymentMethod;
  member?: GafferProjectMember;
}

export interface ContactRecentPayment {
  id: string;
  direction: "IN" | "OUT";
  amount: string;
  paidAt: string;
  projectId: string;
  projectTitle: string;
  comment: string | null;
}

// Debt summary — discriminated union
export type ContactDebtSummary =
  | {
      type: "CLIENT";
      projects: Array<{
        id: string;
        title: string;
        shootDate: string;
        status: "OPEN" | "ARCHIVED";
        clientPlanAmount: string;
        lightBudgetAmount: string;
        clientTotal: string;
        clientReceived: string;
        clientRemaining: string;
      }>;
      totalClientRemaining: string;
      recentPayments: ContactRecentPayment[];
    }
  | {
      type: "TEAM_MEMBER" | "VENDOR";
      memberships: Array<{
        projectId: string;
        projectTitle: string;
        shootDate: string;
        status: "OPEN" | "ARCHIVED";
        roleLabel?: string | null;
        plannedAmount: string;
        paidToMe: string;
        remaining: string;
      }>;
      totalRemaining: string;
      recentPayments: ContactRecentPayment[];
    };

export async function listProjects(params?: {
  status?: "OPEN" | "ARCHIVED";
  search?: string;
  clientId?: string;
  memberContactId?: string;
}): Promise<{ items: GafferProject[] }> {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.search) q.set("search", params.search);
  if (params?.clientId) q.set("clientId", params.clientId);
  if (params?.memberContactId) q.set("memberContactId", params.memberContactId);
  const qs = q.toString() ? `?${q.toString()}` : "";
  return gafferFetch(`/projects${qs}`);
}

export async function getProject(id: string): Promise<{ project: GafferProject }> {
  return gafferFetch(`/projects/${id}`);
}

export async function createProject(data: {
  title: string;
  clientId: string;
  shootDate: string;
  clientPlanAmount?: string | number;
  lightBudgetAmount?: string | number;
  note?: string;
  members?: Array<{ contactId: string; plannedAmount: string | number; roleLabel?: string }>;
}): Promise<{ project: GafferProject }> {
  return gafferFetch("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateProject(
  id: string,
  data: {
    title?: string;
    clientId?: string;
    shootDate?: string;
    clientPlanAmount?: string | number;
    lightBudgetAmount?: string | number;
    note?: string;
  },
): Promise<{ project: GafferProject }> {
  return gafferFetch(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function archiveProject(id: string): Promise<{ project: GafferProject }> {
  return gafferFetch(`/projects/${id}/archive`, { method: "POST" });
}

export async function unarchiveProject(id: string): Promise<{ project: GafferProject }> {
  return gafferFetch(`/projects/${id}/unarchive`, { method: "POST" });
}

export async function deleteProject(id: string): Promise<void> {
  return gafferFetch(`/projects/${id}`, { method: "DELETE" });
}

// ── Project members ────────────────────────────────────────────────────────

export async function addProjectMember(
  projectId: string,
  data: { contactId: string; plannedAmount: string | number; roleLabel?: string },
): Promise<{ member: GafferProjectMember }> {
  return gafferFetch(`/projects/${projectId}/members`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateProjectMember(
  memberId: string,
  data: { plannedAmount?: string | number; roleLabel?: string },
): Promise<{ member: GafferProjectMember }> {
  return gafferFetch(`/projects/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function removeProjectMember(memberId: string): Promise<void> {
  return gafferFetch(`/projects/members/${memberId}`, { method: "DELETE" });
}

// ── Payments ───────────────────────────────────────────────────────────────

export async function listPayments(params?: {
  projectId?: string;
  memberContactId?: string;
  from?: string;
  to?: string;
}): Promise<{ items: GafferPayment[] }> {
  const q = new URLSearchParams();
  if (params?.projectId) q.set("projectId", params.projectId);
  if (params?.memberContactId) q.set("memberContactId", params.memberContactId);
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  const qs = q.toString() ? `?${q.toString()}` : "";
  return gafferFetch(`/payments${qs}`);
}

export async function createPayment(data: {
  projectId: string;
  direction: "IN" | "OUT";
  amount: string | number;
  paidAt: string;
  paymentMethodId?: string;
  memberId?: string;
  comment?: string;
}): Promise<{ payment: GafferPayment }> {
  return gafferFetch("/payments", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updatePayment(
  id: string,
  data: {
    amount?: string | number;
    paidAt?: string;
    paymentMethodId?: string | null;
    comment?: string;
  },
): Promise<{ payment: GafferPayment }> {
  return gafferFetch(`/payments/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deletePayment(id: string): Promise<void> {
  return gafferFetch(`/payments/${id}`, { method: "DELETE" });
}

// ── Contact debt summary ───────────────────────────────────────────────────

export async function getContactDebtSummary(
  contactId: string,
): Promise<ContactDebtSummary> {
  return gafferFetch(`/contacts/${contactId}/debt-summary`);
}

// ── Contact with aggregates ────────────────────────────────────────────────

export interface GafferContactWithAggregates extends GafferContact {
  asClientCount: number;
  asMemberCount: number;
  projectCount: number;
  remainingToMe: string;
  remainingFromMe: string;
}

export async function listContactsWithAggregates(params?: {
  type?: "CLIENT" | "TEAM_MEMBER";
  isArchived?: boolean | "all";
  search?: string;
}): Promise<{ items: GafferContactWithAggregates[] }> {
  const q = new URLSearchParams();
  if (params?.type) q.set("type", params.type);
  if (params?.isArchived !== undefined)
    q.set("isArchived", String(params.isArchived));
  if (params?.search) q.set("search", params.search);
  q.set("withAggregates", "true");
  return gafferFetch(`/contacts?${q.toString()}`);
}

// ── Contacts summary ───────────────────────────────────────────────────────

export interface GafferContactsSummary {
  totals: {
    owedToMe: string;
    iOwe: string;
  };
  counts: {
    all: number;
    clients: number;
    team: number;
    vendors: number;
    withDebt: number;
    archive: number;
  };
}

export async function getContactsSummary(): Promise<GafferContactsSummary> {
  return gafferFetch("/contacts/summary");
}

// ── Dashboard ──────────────────────────────────────────────────────────────

export interface GafferDashboardClientDebt {
  id: string;
  name: string;
  remaining: string;
  projectCount: number;
  lastPaymentAt: string | null;
}

export interface GafferDashboardTeamDebt {
  id: string;
  name: string;
  roleLabel: string | null;
  remaining: string;
  projectCount: number;
}

export interface GafferDashboardVendorDebt {
  id: string;
  name: string;
  roleLabel: string | null;
  remaining: string;
  projectCount: number;
  lastPaymentAt: string | null;
}

export interface GafferDashboard {
  kpi: {
    owedToMe: string;
    iOwe: string;
    owedToMeProjectCount: number;
    owedToMeClientCount: number;
    iOweProjectCount: number;
    iOweMemberCount: number;
    iOweVendorCount: number;
  };
  clientsWithDebt: GafferDashboardClientDebt[];
  teamWithDebt: GafferDashboardTeamDebt[];
  vendorsWithDebt: GafferDashboardVendorDebt[];
  meta: {
    activeProjects: number;
    archivedProjects: number;
    lastActivityAt: string | null;
  };
}

export async function getDashboard(): Promise<GafferDashboard> {
  return gafferFetch("/dashboard");
}
