import type { EquipmentItem, MatchedItem, PhotoAnalysisResult } from "../types";

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

const BASE = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY ?? "", ...(init?.headers ?? {}) },
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
    const res = await fetch(`${BASE}/api/pricelist/file`, { headers: { "X-API-Key": process.env.API_KEY ?? "" } });
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
    headers: { "X-API-Key": process.env.API_KEY ?? "" },
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
 * AI анализ освещений по референсу: POST /api/photo-analysis — разбор сцены,
 * подбор из каталога и ориентировочная смета (оценка бюджета на свет), опционально диаграмма.
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
    headers: { "X-API-Key": process.env.API_KEY ?? "" },
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

// ── Gaffer request parser (shared with web) ──────────────────────────────────

export type GafferMatchCandidate = {
  equipmentId: string;
  catalogName: string;
  category: string;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

export type GafferMatchResolved = GafferMatchCandidate & { kind: "resolved" };

export type GafferReviewItem = {
  id: string;
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  match:
    | GafferMatchResolved
    | { kind: "needsReview"; candidates: GafferMatchCandidate[] }
    | { kind: "unmatched" };
};

export type ParseGafferReviewResponse = {
  items: GafferReviewItem[];
  message?: string;
  error?: string;
  code?: string;
};

/** Парсинг текста гаффера через Gemini AI + обучаемый словарь SlangAlias */
export async function parseGafferReview(
  requestText: string,
): Promise<ParseGafferReviewResponse> {
  return apiFetch<ParseGafferReviewResponse>("/api/bookings/parse-gaffer-review", {
    method: "POST",
    body: JSON.stringify({ requestText }),
    signal: AbortSignal.timeout(60_000),
  });
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
