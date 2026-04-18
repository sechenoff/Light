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
  type: "CLIENT" | "TEAM_MEMBER";
  name: string;
  phone?: string | null;
  telegram?: string | null;
  note?: string | null;
  isArchived: boolean;
  gafferUserId: string;
  createdAt: string;
  updatedAt: string;
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
): Promise<{ user: GafferUser; token: string }> {
  return gafferFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
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
  type?: "CLIENT" | "TEAM_MEMBER";
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
  type: "CLIENT" | "TEAM_MEMBER";
  name: string;
  phone?: string;
  telegram?: string;
  note?: string;
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
