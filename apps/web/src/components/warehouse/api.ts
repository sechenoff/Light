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
 *  - Рядом с токеном: "warehouse_worker_name" и "warehouse_token_expires_at"
 *    (ISO) — чтобы перезагрузка PIN-киоска не выкидывала на вход (P18).
 *    `getWarehouseAuth()` — единственный способ узнать, есть ли живой вход.
 *
 * Error model: every call throws `ScanApiError` on non-2xx, parsed from the
 * backend `{ message, code?, details? }` envelope (the central Express error
 * handler surfaces `code` and `details`). Коды — `SCAN_ERROR` в `types.ts`.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { CHECKLIST_DRAFT_LIMITS, SCAN_ERROR } from "./types";
import type { KioskStaysPreview } from "./kioskStays";
import type {
  AddItemResult,
  AddonEstimateView,
  BookingSummary,
  CancelSessionResult,
  CheckResult,
  ChecklistDraftV1,
  CompletePayload,
  CompleteResult,
  StayInput,
  ChecklistState,
  AddonResult,
  InWorkBooking,
  InWorkDetails,
  KioskCancelReason,
  ScanApiError,
  ScanOperation,
  ScanSessionInfo,
  SummaryResult,
  UncheckResult,
  WorkerAuthResult,
} from "./types";
import type {
  StockCountDetail,
  StockCountLineView,
} from "../inventory/types";

// ── Token + transport ────────────────────────────────────────────────────────

const TOKEN_STORAGE_KEY = "warehouse_token";
const WORKER_NAME_STORAGE_KEY = "warehouse_worker_name";
const TOKEN_EXPIRES_STORAGE_KEY = "warehouse_token_expires_at";

/**
 * Потолок тела keepalive-запроса. Браузеры ограничивают ВСЕ одновременные
 * keepalive-запросы страницы 64 КиБ; больше — fetch падает сразу. Берём с
 * запасом под заголовки и параллельную отмену сессии.
 */
const KEEPALIVE_MAX_BODY_BYTES = 60 * 1024;

const NETWORK_ERROR_MESSAGE = "Нет связи с сервером — проверьте подключение";

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

// sessionStorage может бросить (заблокированные данные сайта, приватный режим
// старого Safari) — киоск тогда просто работает без запоминания входа.

function storageGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно — вход не запомнится, работа не ломается */
  }
}

export function getWarehouseToken(): string | null {
  return storageGet(TOKEN_STORAGE_KEY);
}

/**
 * Сохранить PIN-токен. `meta` — имя кладовщика и срок токена из ответа
 * `/auth`; без `meta` прежние имя и срок стираются, чтобы не приписать новый
 * токен предыдущему кладовщику.
 */
export function setWarehouseToken(
  token: string,
  meta?: { name?: string | null; expiresAt?: string | null },
): void {
  storageSet(TOKEN_STORAGE_KEY, token);
  storageSet(WORKER_NAME_STORAGE_KEY, meta?.name ?? null);
  storageSet(TOKEN_EXPIRES_STORAGE_KEY, meta?.expiresAt ?? null);
}

export function clearWarehouseToken(): void {
  storageSet(TOKEN_STORAGE_KEY, null);
  storageSet(WORKER_NAME_STORAGE_KEY, null);
  storageSet(TOKEN_EXPIRES_STORAGE_KEY, null);
}

/** Живой PIN-вход киоска. */
export interface WarehouseAuthInfo {
  token: string;
  /** Имя кладовщика; `null`, если узнать его на клиенте нельзя. */
  workerName: string | null;
  /** ISO; `null`, если срок неизвестен — тогда его проверит сервер (401). */
  expiresAt: string | null;
}

/**
 * Разбор полезной нагрузки токена `base64(JSON{name, exp}):hmac` (формат
 * `generateToken` в `apps/api/src/services/warehouseAuth.ts`). Подпись здесь
 * не проверяется и не может быть проверена — это только подсказка для экрана
 * (имя и срок) у токенов, сохранённых до появления отдельных полей.
 */
function readTokenPayload(token: string): { name: string | null; exp: number | null } | null {
  const colon = token.lastIndexOf(":");
  if (colon <= 0 || typeof atob !== "function") return null;
  try {
    const binary = atob(token.slice(0, colon));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const json =
      typeof TextDecoder === "function" ? new TextDecoder().decode(bytes) : binary;
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) return null;
    const { name, exp } = payload as { name?: unknown; exp?: unknown };
    return {
      name: typeof name === "string" ? name : null,
      exp: typeof exp === "number" && Number.isFinite(exp) ? exp : null,
    };
  } catch {
    return null;
  }
}

/**
 * Есть ли живой PIN-вход: токен в sessionStorage и срок не вышел. Истёкший
 * токен вычищается сразу, чтобы экран не пытался работать с ним. Токен без
 * известного срока считается живым — окончательно решает сервер (401 → вход).
 */
export function getWarehouseAuth(now: number = Date.now()): WarehouseAuthInfo | null {
  const token = getWarehouseToken();
  if (!token) return null;

  const payload = readTokenPayload(token);
  const storedExpires = storageGet(TOKEN_EXPIRES_STORAGE_KEY);
  const expiresAt =
    storedExpires ?? (payload?.exp != null ? new Date(payload.exp).toISOString() : null);

  if (expiresAt !== null) {
    const expMs = Date.parse(expiresAt);
    if (Number.isFinite(expMs) && expMs <= now) {
      clearWarehouseToken();
      return null;
    }
  }

  return {
    token,
    workerName: storageGet(WORKER_NAME_STORAGE_KEY) ?? payload?.name ?? null,
    expiresAt,
  };
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
  /**
   * Запрос переживает уход со страницы (`fetch keepalive`): досылка черновика
   * и отмена пустой сессии при закрытии вкладки. Тело больше
   * {@link KEEPALIVE_MAX_BODY_BYTES} уходит обычным запросом — лучше попытка,
   * которую может оборвать выгрузка страницы, чем гарантированный отказ fetch.
   */
  keepalive?: boolean;
}

function utf8ByteLength(text: string): number {
  return typeof TextEncoder === "function"
    ? new TextEncoder().encode(text).length
    : text.length * 3; // верхняя оценка без TextEncoder
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

  const jsonBody = !isFormData && body !== undefined ? JSON.stringify(body) : undefined;
  const keepalive =
    opts.keepalive === true &&
    !isFormData &&
    (jsonBody === undefined || utf8ByteLength(jsonBody) <= KEEPALIVE_MAX_BODY_BYTES);

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      credentials: "include",
      body: isFormData ? formData : jsonBody,
      ...(keepalive ? { keepalive: true } : {}),
    });
  } catch {
    // fetch отклоняется только сетевыми сбоями, и текст у них английский
    // («Failed to fetch», «Load failed») — кладовщику нужен понятный.
    throw makeError(0, NETWORK_ERROR_MESSAGE, SCAN_ERROR.NETWORK_ERROR, null);
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
  setWarehouseToken(result.token, { name: result.name, expiresAt: result.expiresAt });
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

/**
 * POST /api/warehouse/sessions { bookingId, operation }
 *
 * Живая ACTIVE-сессия брони продолжается (`resumed: true`, с именем того, кто
 * её открыл, и временем последнего черновика); устаревшие сервер закрывает
 * (`closedStaleSessionIds`). 409 `BOOKING_WRONG_STATUS` — бронь уже не та.
 */
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

/**
 * GET /api/warehouse/sessions/:id/state — чек-лист, черновик и
 * `itemsVersion`. Для закрытой или устаревшей сессии — 409 `SESSION_*`
 * (устаревшую сервер при этом закрывает: вызов идемпотентный).
 */
export function getState(sessionId: string): Promise<ChecklistState> {
  return request<ChecklistState>(
    `/api/warehouse/sessions/${sessionId}/state`,
  );
}

/** Ответ `PUT /sessions/:id/draft`. */
export interface SaveDraftResult {
  /** Новая ревизия — от неё считать следующее сохранение. */
  revision: number;
  /** ISO. */
  savedAt: string;
}

/**
 * PUT /api/warehouse/sessions/:id/draft { revision, draft }
 *
 * `revision` — ревизия, от которой построен черновик (`state.draftRevision`
 * или ответ прошлого сохранения). Сервер пишет только поверх неё; другое
 * устройство успело раньше — 409 `DRAFT_OUTDATED` со свежим черновиком в
 * `details` (`DraftOutdatedDetails`).
 *
 * `keepalive: true` — досылка при `pagehide`/`visibilitychange`/размонтировании.
 * Черновик больше лимита сервера не отправляется: сразу 413 `DRAFT_TOO_LARGE`.
 */
export async function saveDraft(
  sessionId: string,
  revision: number,
  draft: ChecklistDraftV1,
  opts: { keepalive?: boolean } = {},
): Promise<SaveDraftResult> {
  const draftBytes = utf8ByteLength(JSON.stringify(draft));
  if (draftBytes > CHECKLIST_DRAFT_LIMITS.maxBytes) {
    throw makeError(413, "Черновик слишком большой", SCAN_ERROR.DRAFT_TOO_LARGE, null);
  }
  return request<SaveDraftResult>(
    `/api/warehouse/sessions/${sessionId}/draft`,
    { method: "PUT", body: { revision, draft }, keepalive: opts.keepalive },
  );
}

// ── Рабочий стол v2: Смена / Журнал / Поломки ────────────────────────────────

export interface ShiftTimelineEntry {
  kind: "ISSUE" | "RETURN";
  bookingId: string;
  displayNo: string;
  projectName: string;
  clientName: string;
  clientPhone: string | null;
  plannedAt: string;
  itemsCount: number;
  status: "DONE" | "PENDING" | "OVERDUE";
  doneAt: string | null;
  overdueDays: number;
}

/** Строка «Вернулось из ремонта»: починено, но физически ещё на верстаке. */
export interface ReadyForPickupData {
  repairId: string;
  title: string;
  /** Когда ремонт закрыли, ISO. */
  closedAt: string;
}

export interface ShiftSummaryData {
  date: string;
  timeline: ShiftTimelineEntry[];
  overdue: ShiftTimelineEntry[];
  /**
   * Закрытые за неделю ремонты. По учёту прибор уже «в наличии», а на полке его
   * нет, пока кладовщик не заберёт его с верстака, — из-за этого за ним бежали
   * в момент выдачи.
   */
  readyForPickup: ReadyForPickupData[];
  counters: {
    issuesDone: number;
    issuesPlanned: number;
    returnsDone: number;
    returnsPlanned: number;
    overdue: number;
    inWork: number;
  };
  myShift: {
    workerName: string;
    sessions: number;
    items: number;
    firstAt: string | null;
    avgMinutes: number | null;
  };
}

export interface JournalEntryData {
  kind: "SESSION" | "REPAIR";
  id: string;
  at: string;
  operation?: "ISSUE" | "RETURN";
  workerName?: string;
  bookingId?: string;
  displayNo?: string;
  projectName?: string;
  clientName?: string;
  itemsCount?: number;
  completedAt?: string | null;
  durationMinutes?: number | null;
  equipmentName?: string;
  reason?: string;
  repairStatus?: string;
  photosCount?: number;
}

export interface JournalData {
  entries: JournalEntryData[];
  stats: {
    sessions: number;
    items: number;
    avgMinutes: number | null;
    perDay: Array<{ date: string; issues: number; returns: number }>;
    repairsMonth: number;
    problemsMonth: number;
    closedMonth: number;
  };
}

export interface ProblemsData {
  repairs: Array<{
    id: string;
    equipmentName: string;
    quantity: number;
    reason: string;
    urgency: string;
    status: string;
    createdAt: string;
    photosCount: number;
    sourceProject: string | null;
  }>;
  problems: Array<{
    id: string;
    equipmentName: string;
    quantity: number;
    reason: string;
    comment: string;
    status: string;
    expectedBackDate: string | null;
    createdAt: string;
    sourceProject: string | null;
  }>;
}

/** GET /api/warehouse/shift */
export function getShift(): Promise<ShiftSummaryData> {
  return request<ShiftSummaryData>("/api/warehouse/shift");
}

/** GET /api/warehouse/journal?days=&scope= */
export function getJournal(
  days: number,
  scope: "me" | "all",
): Promise<JournalData> {
  return request<JournalData>(
    `/api/warehouse/journal?days=${days}&scope=${scope}`,
  );
}

/** GET /api/warehouse/problems */
export function getProblems(): Promise<ProblemsData> {
  return request<ProblemsData>("/api/warehouse/problems");
}

// ── Регистрация поломки из киоска ────────────────────────────────────────────

export interface RepairTargetUnit {
  id: string;
  /** Серийник → инвентарник → «Единица N». Никогда не barcode. */
  label: string;
  status: string;
  inActiveRepair: boolean;
}

export interface RepairTarget {
  equipmentId: string;
  name: string;
  category: string;
  trackingMode: "COUNT" | "UNIT";
  totalQuantity: number;
  units: RepairTargetUnit[];
}

/** GET /api/warehouse/repair-targets?q= — поиск оборудования для поломки. */
export async function searchRepairTargets(q: string): Promise<RepairTarget[]> {
  const data = await request<{ results: RepairTarget[] }>(
    `/api/warehouse/repair-targets?q=${encodeURIComponent(q)}`,
  );
  return data.results;
}

/**
 * POST /api/warehouse/repairs — прямая регистрация поломки.
 * UNIT: `{ equipmentUnitId }`; COUNT: `{ equipmentId, quantity }`.
 */
export function createKioskRepair(body: {
  equipmentUnitId?: string;
  equipmentId?: string;
  quantity?: number;
  reason: string;
  urgency?: "NOT_URGENT" | "NORMAL" | "URGENT";
}): Promise<{ repair: { id: string; status: string } }> {
  return request<{ repair: { id: string; status: string } }>(
    "/api/warehouse/repairs",
    { method: "POST", body },
  );
}

/** POST /api/warehouse/repairs/:id/photos — multipart поле `photo`. */
export function uploadKioskRepairPhoto(
  repairId: string,
  file: File,
): Promise<{ photosCount: number }> {
  const fd = new FormData();
  fd.append("photo", file);
  return request<{ photosCount: number }>(
    `/api/warehouse/repairs/${repairId}/photos`,
    { method: "POST", formData: fd },
  );
}

// ── Vehicles + driver (заполняется на погрузке/разгрузке) ─────────────────────

export interface SessionVehicle {
  id: string;
  vehicleId: string;
  driverName: string | null;
  driverPhone: string | null;
  withGenerator: boolean;
  shiftHours: string | null;
  kmOutsideMkad: number | null;
  ttkEntry: boolean;
  /**
   * Базовые поля машины. `currentMileage` — текущий пробег для отображения
   * «было / стало» в форме ввода одометра на возврате.
   */
  vehicle: { id: string; name: string; slug: string; currentMileage: number } | null;
}

/** GET /api/warehouse/sessions/:id/vehicles — машины брони с водителями. */
export async function listSessionVehicles(
  sessionId: string,
): Promise<SessionVehicle[]> {
  const data = await request<{ vehicles: SessionVehicle[] }>(
    `/api/warehouse/sessions/${sessionId}/vehicles`,
  );
  return data.vehicles;
}

/**
 * PATCH /api/warehouse/sessions/:id/vehicles/:bookingVehicleId/driver
 * Сохранить ФИО + телефон водителя для конкретной машины. `null` очищает,
 * `undefined` (не передано) не трогает другое поле.
 */
export function setSessionDriver(
  sessionId: string,
  bookingVehicleId: string,
  driver: { driverName?: string | null; driverPhone?: string | null },
): Promise<{ vehicle: { id: string; driverName: string | null; driverPhone: string | null } }> {
  return request<{
    vehicle: { id: string; driverName: string | null; driverPhone: string | null };
  }>(
    `/api/warehouse/sessions/${sessionId}/vehicles/${bookingVehicleId}/driver`,
    { method: "PATCH", body: driver },
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
 * conflict has not been acknowledged. С подтверждением потолок — `ackCap`,
 * сверх него 409 `ADDON_OVER_STOCK`; в RETURN-сессии 409 `ADDON_ONLY_ON_ISSUE`.
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

/**
 * POST /api/warehouse/sessions/:id/complete
 *
 * Тело — {@link CompletePayload} как есть: исходы приёмки, корректировки
 * выдачи (`acknowledgedConflict` на строке), пробеги, а также `force` (выдача
 * раньше срока), `itemsVersion` и `draftRevision` (защита от устаревшего
 * экрана). Возможные 409 — таблица `SCAN_ERROR` в `types.ts`.
 */
export function complete(
  sessionId: string,
  payload: CompletePayload,
): Promise<CompleteResult> {
  return request<CompleteResult>(
    `/api/warehouse/sessions/${sessionId}/complete`,
    { method: "POST", body: payload },
  );
}

/**
 * POST /api/warehouse/sessions/:id/stays-preview — цена дополнительной сметы
 * за оставленное сверх оплаченного и брони, которым оставленное нужно.
 * Ничего не записывает.
 */
export function staysPreview(sessionId: string, stays: StayInput[]): Promise<KioskStaysPreview> {
  return request<KioskStaysPreview>(`/api/warehouse/sessions/${sessionId}/stays-preview`, {
    method: "POST",
    body: { stays },
  });
}

export interface CancelSessionOptions {
  /** Зачем прерываем; без причины сервер пишет «прервана в киоске». */
  reason?: KioskCancelReason;
  /**
   * Отменить, только если в сессии не было работы (черновик, отметки, добор) —
   * для «ушёл, ничего не сделав». Иначе сессия остаётся, `cancelled: false`.
   */
  onlyIfEmpty?: boolean;
  /** Запрос должен пережить закрытие вкладки. */
  keepalive?: boolean;
}

/**
 * POST /api/warehouse/sessions/:id/cancel { reason?, onlyIfEmpty? }
 *
 * Без опций тело не отправляется — как до появления причин.
 */
export function cancel(
  sessionId: string,
  opts: CancelSessionOptions = {},
): Promise<CancelSessionResult> {
  const body: { reason?: KioskCancelReason; onlyIfEmpty?: boolean } = {
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.onlyIfEmpty !== undefined ? { onlyIfEmpty: opts.onlyIfEmpty } : {}),
  };
  return request<CancelSessionResult>(
    `/api/warehouse/sessions/${sessionId}/cancel`,
    {
      method: "POST",
      body: Object.keys(body).length > 0 ? body : undefined,
      keepalive: opts.keepalive,
    },
  );
}

// ── Add-on estimate (доб-смета) ──────────────────────────────────────────────

/**
 * GET /api/addon-estimates/:bookingId — read-model доб-сметы.
 * `addon` is `null` when the booking has no addon estimate yet.
 */
export function getAddonEstimate(
  bookingId: string,
): Promise<{ addon: AddonEstimateView | null }> {
  return request<{ addon: AddonEstimateView | null }>(
    `/api/addon-estimates/${bookingId}`,
  );
}

/** URL для скачивания PDF доб-сметы (для прямых `<a href>` ссылок). */
export function addonEstimatePdfUrl(bookingId: string): string {
  return `/api/addon-estimates/${bookingId}/export/pdf`;
}

/** URL для скачивания общей PDF (main + addon). */
export function fullEstimatePdfUrl(bookingId: string): string {
  return `/api/bookings/${bookingId}/full-estimate/export/pdf`;
}

// ── «В работе» tab (active ISSUED bookings) ──────────────────────────────────

/**
 * GET /api/warehouse/in-work — list of active ISSUED bookings.
 *
 * Sorted server-side by `endDate ASC` (overdue/urgent at the top). The
 * `bookings: [...]` envelope is preserved on purpose — it matches the
 * backend response 1:1 and lets the caller `await scanApi.listInWork()`
 * without an extra destructuring step.
 */
export function listInWork(): Promise<{ bookings: InWorkBooking[] }> {
  return request<{ bookings: InWorkBooking[] }>("/api/warehouse/in-work");
}

/**
 * GET /api/warehouse/in-work/:bookingId/details — read-only details for one
 * active booking. 404 when the booking is missing or its status is not
 * `ISSUED`.
 */
export function getInWorkDetails(bookingId: string): Promise<InWorkDetails> {
  return request<InWorkDetails>(
    `/api/warehouse/in-work/${bookingId}/details`,
  );
}

// ── Инвентаризация: счёт полки с киоска ──────────────────────────────────────
// Киоск только СЧИТАЕТ: решения, завершение и отмена — десктоп
// (/api/stock-counts). Кто считал, сервер берёт из PIN-токена.

/** GET /api/warehouse/stock-count — идущая инвентаризация или null. */
export async function getActiveStockCount(): Promise<StockCountDetail | null> {
  const data = await request<{ stockCount: StockCountDetail | null }>(
    "/api/warehouse/stock-count",
  );
  return data?.stockCount ?? null;
}

/** GET /api/warehouse/stock-count/:id/lines?category= — строки участка. */
export async function listStockCountLines(
  stockCountId: string,
  category?: string,
): Promise<StockCountLineView[]> {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  const data = await request<{ lines: StockCountLineView[] }>(
    `/api/warehouse/stock-count/${encodeURIComponent(stockCountId)}/lines${qs}`,
  );
  return data.lines;
}

/**
 * POST /api/warehouse/stock-count/:id/lines/:lineId/count { qty }.
 * 409 `STOCK_COUNT_NOT_OPEN` — инвентаризацию завершили или отменили.
 */
export async function countStockCountLine(
  stockCountId: string,
  lineId: string,
  qty: number,
): Promise<StockCountLineView> {
  const data = await request<{ line: StockCountLineView }>(
    `/api/warehouse/stock-count/${encodeURIComponent(stockCountId)}/lines/${encodeURIComponent(lineId)}/count`,
    { method: "POST", body: { qty } },
  );
  return data.line;
}

/** POST /api/warehouse/stock-count/:id/lines/:lineId/reset — «Пересчитать». */
export async function resetStockCountLine(
  stockCountId: string,
  lineId: string,
): Promise<StockCountLineView> {
  const data = await request<{ line: StockCountLineView }>(
    `/api/warehouse/stock-count/${encodeURIComponent(stockCountId)}/lines/${encodeURIComponent(lineId)}/reset`,
    { method: "POST" },
  );
  return data.line;
}

// ── Aggregate export (ergonomic single import) ───────────────────────────────

export const scanApi = {
  authWorker,
  listWorkerNames,
  listBookings,
  createSession,
  getState,
  saveDraft,
  getShift,
  getJournal,
  getProblems,
  searchRepairTargets,
  createKioskRepair,
  uploadKioskRepairPhoto,
  listSessionVehicles,
  setSessionDriver,
  check,
  uncheck,
  addonSearch,
  addItem,
  uploadPhoto,
  listPhotos,
  deletePhoto,
  getSummary,
  complete,
  staysPreview,
  cancel,
  getAddonEstimate,
  addonEstimatePdfUrl,
  fullEstimatePdfUrl,
  listInWork,
  getInWorkDetails,
  getActiveStockCount,
  listStockCountLines,
  countStockCountLine,
  resetStockCountLine,
  getWarehouseToken,
  setWarehouseToken,
  clearWarehouseToken,
  getWarehouseAuth,
} as const;
