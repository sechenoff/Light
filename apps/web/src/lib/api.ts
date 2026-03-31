function resolveApiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (raw == null || String(raw).trim() === "") return "";
  return String(raw).trim().replace(/\/$/, "");
}

const API_BASE_URL = resolveApiBaseUrl();

type ApiError = Error & {
  status: number;
  details?: unknown;
};

class ApiFetchError extends Error implements ApiError {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Не устанавливаем Content-Type для FormData — браузер сам выставит multipart/form-data с boundary
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(`${API_BASE_URL}${path}`, {
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
    const jsonObject = isRecord(json) ? json : null;
    const message =
      typeof jsonObject?.message === "string"
        ? jsonObject.message
        : `Request failed: ${res.status}`;
    throw new ApiFetchError(message, res.status, jsonObject?.details ?? json);
  }

  return (await res.json()) as T;
}

export async function apiFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, init);
}

// ── Ops API ───────────────────────────────────────────────────────────────────

export type OpsChat = { telegramChatId: string; title: string; mode: string; timezone: string };
export type OpsTaskRow = {
  id: string;
  title: string;
  status: "NEW" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "OVERDUE";
  dueAt: string | null;
  assigneeTelegramUserId: string | null;
  assigneeUsername: string | null;
  projectName: string | null;
  priority: number;
  blockedBy: Array<{ id: string; title: string }>;
};
export type OpsMemberStat = {
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
  total: number;
  done: number;
  overdue: number;
  blocked: number;
  overdueRate: number;
};

export async function getActiveOpsChats() {
  return apiFetch<{ chats: OpsChat[] }>("/api/ops/active-chats");
}

export async function getOpsTasksWeb(telegramChatId: string, status?: string) {
  const q = status ? `?status=${status}` : "";
  return apiFetch<{ tasks: OpsTaskRow[] }>(`/api/ops/chats/${telegramChatId}/tasks${q}`);
}

export async function getOpsDailySummaryWeb(telegramChatId: string) {
  return apiFetch<{
    exists: boolean;
    created: number;
    done: number;
    overdue: number;
    withoutAssignee: number;
    blocked: number;
  }>(`/api/ops/chats/${telegramChatId}/daily-summary`);
}

export async function getOpsMemberStatsWeb(telegramChatId: string) {
  return apiFetch<{ stats: OpsMemberStat[] }>(`/api/ops/chats/${telegramChatId}/members/stats`);
}

export async function getOpsUnresolvedWeb(telegramChatId: string) {
  return apiFetch<{ discussions: Array<{ id: string; topic: string; status: string; lastActivityAt: string }> }>(
    `/api/ops/chats/${telegramChatId}/unresolved`,
  );
}

export async function updateOpsTaskStatusWeb(taskId: string, status: string, actorTelegramUserId?: string) {
  return apiFetch<{ task: { id: string; status: string } }>(`/api/ops/tasks/${taskId}/status`, {
    method: "POST",
    body: JSON.stringify({ taskId, status, actorTelegramUserId }),
  });
}

export async function createOpsTaskWeb(input: {
  telegramChatId: string;
  title: string;
  assigneeTelegramUserId?: string;
  dueAt?: string;
  projectName?: string;
}) {
  return apiFetch<{ id: string; title: string; status: string }>("/api/ops/tasks/manual", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getOpsDecisionsWeb(telegramChatId: string, limit = 20) {
  return apiFetch<{
    decisions: Array<{
      id: string;
      text: string;
      projectName: string | null;
      madeByUsername: string | null;
      madeByFirstName: string | null;
      createdAt: string;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/decisions?limit=${limit}`);
}

export async function getOpsRiskWeb(telegramChatId: string) {
  return apiFetch<{
    overdueTasks: Array<{ title: string; dueAt: string | null; assigneeUsername: string | null }>;
    blockedTasks: Array<{ title: string; blockers: string[] }>;
    unresolvedDiscussions: Array<{ topic: string; staleSinceHours: number }>;
    membersAtRisk: Array<{ username: string | null; firstName: string | null; overdueCount: number }>;
  }>(`/api/ops/chats/${telegramChatId}/risk`);
}

export async function getOpsWeeklyWeb(telegramChatId: string) {
  return apiFetch<{
    created: number;
    done: number;
    overdue: number;
    blocked: number;
    decisionsLogged: number;
    completionRate: number;
    topMembers: Array<{
      telegramUserId: string;
      username: string | null;
      firstName: string | null;
      total: number;
      done: number;
      overdue: number;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/weekly`);
}

