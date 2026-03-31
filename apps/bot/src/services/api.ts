import type { EquipmentItem, MatchedItem, OpsMessageExtraction, PhotoAnalysisResult } from "../types";

export type UpsertUserInput = {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
};

export type UpsertUserResult = {
  id: string;
  telegramId: string;
};

export type CreatePendingAnalysisInput = {
  userId: string;
  telegramFileId: string;
  telegramMimeType: string;
};

export type PendingAnalysisResult = {
  id: string;
  status: string;
};

export type OpsReminderDto = {
  id: string;
  kind:
    | "PRE_DEADLINE"
    | "AT_DEADLINE"
    | "POST_DEADLINE"
    | "DAILY_SUMMARY"
    | "ESCALATION"
    | "WEEKLY_REPORT"
    | "DISCUSSION_FOLLOW_UP";
  scheduledFor: string;
  chatTelegramId: string;
  chatTitle: string | null;
  task: null | {
    id: string;
    title: string;
    dueAt: string | null;
    status: "NEW" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "OVERDUE";
    assigneeTelegramUserId: string | null;
    assigneeUsername: string | null;
  };
};

const BASE = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `API error ${res.status}`;
    try { msg = JSON.parse(text).message ?? msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** Получить список оборудования с доступностью на период */
export async function getAvailability(
  startDate: string,
  endDate: string,
): Promise<EquipmentItem[]> {
  const params = new URLSearchParams({ start: startDate, end: endDate });
  const data = await apiFetch<{ rows: EquipmentItem[] }>(`/api/availability?${params}`);
  return data.rows;
}

/** Получить всё оборудование (без фильтра по датам) */
export async function getAllEquipment(): Promise<EquipmentItem[]> {
  const data = await apiFetch<{ equipments: EquipmentItem[] }>("/api/equipment");
  return data.equipments.map((e) => ({ ...e, availableQuantity: e.totalQuantity, occupiedQuantity: 0, availability: "AVAILABLE" as const }));
}

/** Проверить наличие прайслиста */
export async function getPricelistMeta(): Promise<{ exists: boolean; filename?: string } | null> {
  try {
    return await apiFetch<{ exists: boolean; filename?: string }>("/api/pricelist");
  } catch {
    return null;
  }
}

/** Скачать прайслист как Buffer */
export async function fetchPricelistBuffer(): Promise<{ buffer: Buffer; filename: string } | null> {
  try {
    const res = await fetch(`${BASE}/api/pricelist/file`);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?([^;\r\n]+)/i);
    const filename = nameMatch
      ? decodeURIComponent(nameMatch[1].replace(/"/g, ""))
      : "pricelist.pdf";
    return { buffer: Buffer.from(arrayBuffer), filename };
  } catch {
    return null;
  }
}

/**
 * Создаёт или обновляет Telegram-пользователя в БД.
 * telegramId передаётся как строка (JSON не поддерживает BigInt).
 */
export async function upsertUser(input: UpsertUserInput): Promise<UpsertUserResult> {
  const data = await apiFetch<{ user: UpsertUserResult }>("/api/users/upsert", {
    method: "POST",
    body: JSON.stringify({
      telegramId: String(input.telegramId),
      username: input.username ?? null,
      firstName: input.firstName ?? null,
    }),
  });
  return data.user;
}

/**
 * Создаёт запись Analysis со status=PENDING и сохраняет Telegram file_id.
 */
export async function createPendingAnalysis(
  input: CreatePendingAnalysisInput,
): Promise<PendingAnalysisResult> {
  const data = await apiFetch<{ analysis: PendingAnalysisResult }>("/api/analyses/pending", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.analysis;
}

/**
 * Загружает файл изображения в Analysis через storage service API.
 * Возвращает storagePath — путь сохранённого файла.
 */
export async function uploadAnalysisFile(
  analysisId: string,
  imageBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append("photo", blob, `photo.${mimeType.split("/")[1] ?? "jpg"}`);

  const res = await fetch(`${BASE}/api/analyses/${analysisId}/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `Upload error ${res.status}`;
    try { msg = JSON.parse(text).message ?? msg; } catch { /* noop */ }
    throw new Error(msg);
  }

  const data = await res.json() as { storagePath: string };
  return data.storagePath;
}

/**
 * Анализировать фото: отправляет изображение на /api/photo-analysis,
 * возвращает вероятную схему освещения, список оборудования и диаграмму.
 * Если передан analysisId — сервер сохраняет результат в БД.
 */
export async function analyzePhoto(
  imageBuffer: Buffer,
  mimeType: string,
  analysisId?: string,
): Promise<PhotoAnalysisResult> {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append("photo", blob, "photo");
  if (analysisId) formData.append("analysisId", analysisId);

  const res = await fetch(`${BASE}/api/photo-analysis`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(150_000), // 2.5 min — Gemini 2.5 Flash может занять 40s+
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `API error ${res.status}`;
    if (res.status === 429 || text.includes("429") || text.includes("quota") || text.includes("Too Many")) {
      msg = "AI_QUOTA_EXCEEDED";
    } else {
      try { msg = JSON.parse(text).message ?? msg; } catch { /* noop */ }
    }
    throw new Error(msg);
  }

  return res.json() as Promise<PhotoAnalysisResult>;
}

/** Создать новую бронь (draft → confirm) */
export async function createBooking(args: {
  clientName: string;
  projectName: string;
  startDate: string;
  endDate: string;
  items: MatchedItem[];
  comment?: string;
}): Promise<{ id: string; displayName: string }> {
  const body = {
    client: { name: args.clientName },
    projectName: args.projectName,
    startDate: new Date(`${args.startDate}T09:00:00`).toISOString(),
    endDate: new Date(`${args.endDate}T23:00:00`).toISOString(),
    comment: args.comment ?? "",
    items: args.items.map((i) => ({
      equipmentId: i.equipmentId,
      quantity: i.quantity,
    })),
  };

  const draft = await apiFetch<{ booking: { id: string } }>("/api/bookings/draft", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const confirmed = await apiFetch<{ booking: { id: string; displayName?: string } }>(
    `/api/bookings/${draft.booking.id}/confirm`,
    { method: "POST" },
  );

  return {
    id: confirmed.booking.id,
    displayName: confirmed.booking.displayName ?? `#${confirmed.booking.id.slice(0, 8)}`,
  };
}

export async function ingestOpsMessage(args: {
  chat: { telegramChatId: string; title?: string | null; type: string };
  sender?: {
    telegramUserId: string;
    username?: string | null;
    firstName?: string | null;
    isAdmin?: boolean;
    isBot?: boolean;
  };
  message: {
    telegramMessageId: number;
    text: string;
    messageDate: string;
    rawJson?: string;
  };
  extraction: OpsMessageExtraction;
}) {
  const data = await apiFetch<{
    mode: "OBSERVER" | "COORDINATOR" | "DISPATCHER" | "MANAGER";
    createdTask: null | {
      id: string;
      title: string;
      dueAt: string | null;
      assigneeTelegramUserId: string | null;
    };
  }>("/api/ops/events/message", {
    method: "POST",
    body: JSON.stringify({
      chat: args.chat,
      sender: args.sender,
      message: {
        ...args.message,
        messageType: args.extraction.messageType,
        messageTypeConfidence: args.extraction.messageTypeConfidence,
        entitiesJson: JSON.stringify(args.extraction.entities),
      },
      task: args.extraction.task,
      roleCandidates: args.extraction.roleCandidates,
    }),
  });
  return data;
}

export async function setOpsMode(telegramChatId: string, mode: "OBSERVER" | "COORDINATOR" | "DISPATCHER" | "MANAGER") {
  return apiFetch<{ chat: { mode: string } }>("/api/ops/chats/mode", {
    method: "POST",
    body: JSON.stringify({ telegramChatId, mode }),
  });
}

export async function getOpsTasks(telegramChatId: string) {
  return apiFetch<{
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      dueAt: string | null;
      projectName: string | null;
      assigneeTelegramUserId: string | null;
      sourceTelegramMessageId: number | null;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/tasks?openOnly=true`);
}

export async function getOpsDailySummary(telegramChatId: string) {
  return apiFetch<{
    exists: boolean;
    created: number;
    done: number;
    overdue: number;
    withoutAssignee: number;
    blocked: number;
    openByMember: Array<{ telegramUserId: string; count: number }>;
  }>(`/api/ops/chats/${telegramChatId}/daily-summary`);
}

export async function getOpsOwners(telegramChatId: string) {
  return apiFetch<{
    owners: Array<{
      roleName: string;
      telegramUserId: string;
      confidence: string;
      status: "PENDING" | "CONFIRMED" | "REJECTED";
    }>;
  }>(`/api/ops/chats/${telegramChatId}/owners`);
}

export async function getDueOpsReminders() {
  return apiFetch<{ reminders: OpsReminderDto[] }>("/api/ops/reminders/due");
}

export async function markOpsReminderSent(reminderId: string) {
  return apiFetch<{ reminder: { id: string } }>(`/api/ops/reminders/${reminderId}/sent`, {
    method: "POST",
  });
}

export async function updateOpsTaskStatus(args: {
  taskId: string;
  status: "NEW" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "OVERDUE";
  actorTelegramUserId?: string;
  note?: string;
}) {
  return apiFetch<{ task: { id: string; status: string } }>(`/api/ops/tasks/${args.taskId}/status`, {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function confirmOpsRole(args: {
  telegramChatId: string;
  telegramUserId: string;
  roleName: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
}) {
  return apiFetch<{ updatedCount: number }>("/api/ops/roles/confirm", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function getOpsChatMembers(telegramChatId: string) {
  return apiFetch<{
    members: Array<{
      telegramUserId: string;
      username: string | null;
      firstName: string | null;
      isAdmin: boolean;
      messageCount: number;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/members`);
}

export async function assignOpsTask(args: { taskId: string; assigneeTelegramUserId: string; actorTelegramUserId?: string }) {
  return apiFetch<{
    result: { taskId: string; title: string; assigneeTelegramUserId: string; assigneeUsername: string | null };
  }>(`/api/ops/tasks/${args.taskId}/assign`, {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function getOpsBlockers(telegramChatId: string) {
  return apiFetch<{
    blockers: Array<{
      id: string;
      title: string;
      dueAt: string | null;
      assigneeTelegramUserId: string | null;
      blockedBy: Array<{
        taskId: string;
        title: string;
        assigneeTelegramUserId: string | null;
        note: string | null;
      }>;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/blockers`);
}

export async function getOpsProjectStatus(telegramChatId: string, project?: string) {
  const url = `/api/ops/chats/${telegramChatId}/project-status${project ? `?project=${encodeURIComponent(project)}` : ""}`;
  return apiFetch<{
    projectName: string | null;
    chatTitle: string | null;
    openTasks: Array<{
      id: string;
      title: string;
      status: string;
      dueAt: string | null;
      assigneeTelegramUserId: string | null;
      assigneeUsername: string | null;
    }>;
    doneTasks: number;
    blockedTasks: Array<{
      id: string;
      title: string;
      dueAt: string | null;
      assigneeTelegramUserId: string | null;
    }>;
    overdueTasks: Array<{
      id: string;
      title: string;
      dueAt: string | null;
      assigneeTelegramUserId: string | null;
    }>;
    nearDeadlineTasks: Array<{
      id: string;
      title: string;
      dueAt: string | null;
      assigneeUsername: string | null;
    }>;
  }>(url);
}

export async function getOpsUnresolved(telegramChatId: string) {
  return apiFetch<{
    discussions: Array<{
      id: string;
      topic: string;
      lastActivityAt: string;
      participantIds: string[];
      reopenCount: number;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/unresolved`);
}

export async function ingestOpsDiscussion(args: {
  telegramChatId: string;
  topic: string;
  firstMessageId?: string;
  lastMessageId?: string;
  participantTelegramUserIds: string[];
}) {
  return apiFetch<{ id: string }>("/api/ops/discussions/upsert", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function escalateOpsChat(telegramChatId: string) {
  return apiFetch<{
    escalated: Array<{
      id: string;
      title: string;
      dueAt: string | null;
      assigneeTelegramUserId: string | null;
      assigneeUsername: string | null;
      escalationCount: number;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/escalate`, { method: "POST" });
}

export async function getOpsDecisions(telegramChatId: string, limit = 10) {
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

export async function postOpsDecision(input: {
  telegramChatId: string;
  text: string;
  projectName?: string;
}) {
  return apiFetch<{ decision: { id: string } }>(`/api/ops/chats/${input.telegramChatId}/decisions`, {
    method: "POST",
    body: JSON.stringify({ text: input.text, projectName: input.projectName }),
  });
}

export async function getOpsMemberStats(telegramChatId: string) {
  return apiFetch<{
    stats: Array<{
      telegramUserId: string;
      username: string | null;
      firstName: string | null;
      total: number;
      done: number;
      overdue: number;
      blocked: number;
      overdueRate: number;
    }>;
  }>(`/api/ops/chats/${telegramChatId}/members/stats`);
}

export async function getOpsRiskData(telegramChatId: string) {
  return apiFetch<{
    overdueTasks: Array<{ title: string; dueAt: string | null; assigneeUsername: string | null }>;
    blockedTasks: Array<{ title: string; blockers: string[] }>;
    unresolvedDiscussions: Array<{ topic: string; staleSinceHours: number }>;
    membersAtRisk: Array<{ username: string | null; firstName: string | null; overdueCount: number }>;
  }>(`/api/ops/chats/${telegramChatId}/risk`);
}

export async function getOpsWeeklyStats(telegramChatId: string) {
  return apiFetch<{
    chatTitle: string | null;
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

export async function updateOpsChatSettings(input: {
  telegramChatId: string;
  quietHoursFrom?: number;
  quietHoursTo?: number;
  strictness?: number;
}) {
  return apiFetch<{
    settings: {
      mode: string;
      quietHoursFrom: number;
      quietHoursTo: number;
      strictness: number;
      timezone: string;
    };
  }>(`/api/ops/chats/${input.telegramChatId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({
      quietHoursFrom: input.quietHoursFrom,
      quietHoursTo: input.quietHoursTo,
      strictness: input.strictness,
    }),
  });
}

export async function getOpsDiscussionFollowUps() {
  return apiFetch<{
    discussions: Array<{
      id: string;
      topic: string;
      chatTelegramId: string;
      chatTitle: string | null;
      lastActivityAt: string;
      staleSinceHours: number;
    }>;
  }>("/api/ops/discussions/follow-up");
}

export async function markDiscussionFollowUpSent(discussionId: string) {
  return apiFetch<{ ok: boolean }>(`/api/ops/discussions/${discussionId}/follow-up-sent`, {
    method: "POST",
  });
}

export async function getActiveOpsChats() {
  return apiFetch<{
    chats: Array<{ telegramChatId: string; title: string; mode: string; timezone: string }>;
  }>("/api/ops/active-chats");
}

export async function createOpsTaskManual(input: {
  telegramChatId: string;
  title: string;
  assigneeTelegramUserId?: string;
  dueAt?: string;
  projectName?: string;
  createdByTelegramUserId?: string;
}) {
  return apiFetch<{
    id: string;
    title: string;
    status: string;
    dueAt: string | null;
    assigneeUsername: string | null;
  }>("/api/ops/tasks/manual", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
