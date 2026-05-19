/**
 * Typed warehouse-scan API client.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AUTH / TOKEN CONTRACT (extracted from `apps/web/app/warehouse/scan/page.tsx`,
 * verbatim — Task 5.2 rewires the page on top of this client and relies on it):
 *
 *  - Token storage:  window.sessionStorage  (NOT localStorage)
 *  - Storage key:     "warehouse_token"
 *  - Set by:          POST /api/warehouse/auth → sessionStorage.setItem(...)
 *  - Header:          Authorization: Bearer <token>   (omitted when no token)
 *  - Transport base:  same-origin fetch to `/api/...`; in dev the Next route
 *                     handler proxies to the Express backend on :4000.
 *                     Mirrors `apiFetch` in `apps/web/src/lib/api.ts`:
 *                       · Content-Type: application/json  (skipped for FormData)
 *                       · credentials: "include"
 *  - Public (NO Bearer): POST /api/warehouse/auth, GET /api/warehouse/workers/names
 *
 * Error model: every call throws `ScanApiError` on non-2xx, parsed from the
 * backend `{ message, code?, details? }` envelope (the central Express error
 * handler surfaces `code` and `details`).
 * ────────────────────────────────────────────────────────────────────────────
 */

import type {
  AddItemResult,
  BookingSummary,
  CheckResult,
  CompletePayload,
  CompleteResult,
  ChecklistState,
  AddonResult,
  ScanApiError,
  ScanOperation,
  ScanSessionInfo,
  SummaryResult,
  UncheckResult,
  WorkerAuthResult,
} from "./types";

// ── Token + transport ────────────────────────────────────────────────────────

const TOKEN_STORAGE_KEY = "warehouse_token";

/**
 * Resolve API base identically to `src/lib/api.ts`.
 * keep in sync with src/lib/api.ts resolveApiBaseUrl
 */
function resolveApiBaseUrl(): string {
  if (process.env.NODE_ENV === "development") return "";
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (raw != null && String(raw).trim() !== "") {
    return String(raw).trim().replace(/\/$/, "");
  }
  return "";
}

const API_BASE_URL = resolveApiBaseUrl();

export function getWarehouseToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setWarehouseToken(token: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearWarehouseToken(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function makeError(
  status: number,
  message: string,
  code: string | null,
  details: unknown,
): ScanApiError {
  return { status, message, code, details };
}

interface RequestOptions {
  method?: string;
  /** JSON-serialisable body. Mutually exclusive with `formData`. */
  body?: unknown;
  /** Raw FormData body (multipart). Mutually exclusive with `body`. */
  formData?: FormData;
  /** When true, the Authorization: Bearer header is NOT attached (public route). */
  noAuth?: boolean;
}

/**
 * Core request wrapper. Replicates `apiFetch` transport semantics and adds the
 * warehouse Bearer header + a richer error envelope (`code` included).
 */
async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, formData, noAuth = false } = opts;
  const isFormData = formData !== undefined;
  const token = noAuth ? null : getWarehouseToken();

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      credentials: "include",
      body: isFormData
        ? formData
        : body !== undefined
          ? JSON.stringify(body)
          : undefined,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : "Сеть недоступна — проверьте подключение";
    throw makeError(0, message, "NETWORK_ERROR", null);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const obj = isRecord(parsed) ? parsed : null;
    const message =
      typeof obj?.message === "string"
        ? obj.message
        : typeof obj?.error === "string"
          ? obj.error
          : text.trimStart().startsWith("<")
            ? `Сервер вернул страницу ошибки (HTTP ${res.status}) вместо JSON — вероятно не запущен API или сбой прокси Next.`
            : `Запрос не выполнен: ${res.status}`;
    const code = typeof obj?.code === "string" ? obj.code : null;
    const details = obj?.details ?? parsed;
    throw makeError(res.status, message, code, details);
  }

  // 204 No Content (e.g. delete worker) — nothing to parse.
  if (res.status === 204) return undefined as T;

  const raw = await res.text();
  if (!raw) return undefined as T;
  return JSON.parse(raw) as T;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/** POST /api/warehouse/auth — public (no Bearer). Persists the token. */
export async function authWorker(
  name: string,
  pin: string,
): Promise<WorkerAuthResult> {
  const result = await request<WorkerAuthResult>("/api/warehouse/auth", {
    method: "POST",
    body: { name, pin },
    noAuth: true,
  });
  setWarehouseToken(result.token);
  return result;
}

/** GET /api/warehouse/workers/names — public (no Bearer). */
export async function listWorkerNames(): Promise<string[]> {
  const data = await request<{ names: string[] }>(
    "/api/warehouse/workers/names",
    { noAuth: true },
  );
  return data.names;
}

// ── Bookings + session lifecycle ─────────────────────────────────────────────

/** GET /api/warehouse/bookings?operation=ISSUE|RETURN */
export async function listBookings(
  operation: ScanOperation,
): Promise<BookingSummary[]> {
  const data = await request<{ bookings: BookingSummary[] }>(
    `/api/warehouse/bookings?operation=${operation}`,
  );
  return data.bookings;
}

/** POST /api/warehouse/sessions { bookingId, operation } */
export async function createSession(
  bookingId: string,
  operation: ScanOperation,
): Promise<ScanSessionInfo> {
  const data = await request<{ session: ScanSessionInfo }>(
    "/api/warehouse/sessions",
    { method: "POST", body: { bookingId, operation } },
  );
  return data.session;
}

/** GET /api/warehouse/sessions/:id/state */
export function getState(sessionId: string): Promise<ChecklistState> {
  return request<ChecklistState>(
    `/api/warehouse/sessions/${sessionId}/state`,
  );
}

// ── Checklist mutations ──────────────────────────────────────────────────────

/** POST /api/warehouse/sessions/:id/check { equipmentUnitId } */
export function check(
  sessionId: string,
  equipmentUnitId: string,
): Promise<CheckResult> {
  return request<CheckResult>(
    `/api/warehouse/sessions/${sessionId}/check`,
    { method: "POST", body: { equipmentUnitId } },
  );
}

/** POST /api/warehouse/sessions/:id/uncheck { equipmentUnitId } */
export function uncheck(
  sessionId: string,
  equipmentUnitId: string,
): Promise<UncheckResult> {
  return request<UncheckResult>(
    `/api/warehouse/sessions/${sessionId}/uncheck`,
    { method: "POST", body: { equipmentUnitId } },
  );
}

// ── Add-on (quick-add) ───────────────────────────────────────────────────────

/** GET /api/warehouse/sessions/:id/addon-search?q= */
export async function addonSearch(
  sessionId: string,
  q: string,
): Promise<AddonResult[]> {
  const data = await request<{ results: AddonResult[] }>(
    `/api/warehouse/sessions/${sessionId}/addon-search?q=${encodeURIComponent(q)}`,
  );
  return data.results;
}

/**
 * POST /api/warehouse/sessions/:id/items { equipmentId, quantity, acknowledgedConflict? }
 *
 * Throws `ScanApiError` with `code === "ADDON_CONFLICT"` (status 409) and
 * `details` matching `AddonConflict` when the article is busy and the
 * conflict has not been acknowledged.
 */
export function addItem(
  sessionId: string,
  equipmentId: string,
  quantity: number,
  acknowledgedConflict?: boolean,
): Promise<AddItemResult> {
  return request<AddItemResult>(
    `/api/warehouse/sessions/${sessionId}/items`,
    {
      method: "POST",
      body: {
        equipmentId,
        quantity,
        ...(acknowledgedConflict !== undefined ? { acknowledgedConflict } : {}),
      },
    },
  );
}

// ── Repair photos (staging during a RETURN session) ──────────────────────────

/** POST /api/warehouse/sessions/:id/units/:unitId/photos — multipart field `photo`. */
export function uploadPhoto(
  sessionId: string,
  unitId: string,
  file: File,
): Promise<{ photos: string[] }> {
  const fd = new FormData();
  fd.append("photo", file);
  return request<{ photos: string[] }>(
    `/api/warehouse/sessions/${sessionId}/units/${unitId}/photos`,
    { method: "POST", formData: fd },
  );
}

/** GET /api/warehouse/sessions/:id/units/:unitId/photos */
export function listPhotos(
  sessionId: string,
  unitId: string,
): Promise<{ photos: string[] }> {
  return request<{ photos: string[] }>(
    `/api/warehouse/sessions/${sessionId}/units/${unitId}/photos`,
  );
}

/** DELETE /api/warehouse/sessions/:id/units/:unitId/photos/:name */
export function deletePhoto(
  sessionId: string,
  unitId: string,
  name: string,
): Promise<{ photos: string[] }> {
  return request<{ photos: string[] }>(
    `/api/warehouse/sessions/${sessionId}/units/${unitId}/photos/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

// ── Summary / complete / cancel ──────────────────────────────────────────────

/** GET /api/warehouse/sessions/:id/summary */
export function getSummary(sessionId: string): Promise<SummaryResult> {
  return request<SummaryResult>(
    `/api/warehouse/sessions/${sessionId}/summary`,
  );
}

/** POST /api/warehouse/sessions/:id/complete { repairUnits?, problemUnits? } */
export function complete(
  sessionId: string,
  payload: CompletePayload,
): Promise<CompleteResult> {
  return request<CompleteResult>(
    `/api/warehouse/sessions/${sessionId}/complete`,
    { method: "POST", body: payload },
  );
}

/** POST /api/warehouse/sessions/:id/cancel */
export function cancel(sessionId: string): Promise<ScanSessionInfo> {
  return request<ScanSessionInfo>(
    `/api/warehouse/sessions/${sessionId}/cancel`,
    { method: "POST" },
  );
}

// ── Aggregate export (ergonomic single import) ───────────────────────────────

export const scanApi = {
  authWorker,
  listWorkerNames,
  listBookings,
  createSession,
  getState,
  check,
  uncheck,
  addonSearch,
  addItem,
  uploadPhoto,
  listPhotos,
  deletePhoto,
  getSummary,
  complete,
  cancel,
  getWarehouseToken,
  setWarehouseToken,
  clearWarehouseToken,
} as const;
