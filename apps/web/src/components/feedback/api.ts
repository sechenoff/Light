import type {
  FeedbackCategory,
  FeedbackDetail,
  FeedbackListItem,
  FeedbackStats,
  FeedbackStatus,
} from "./types";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let payload: unknown = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    const err = new Error(
      (payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string")
        ? (payload as { error: string }).error
        : `Ошибка ${res.status}`,
    );
    (err as Error & { status?: number; payload?: unknown }).status = res.status;
    (err as Error & { status?: number; payload?: unknown }).payload = payload;
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface ListFeedbackParams {
  status?: FeedbackStatus | "ALL";
  category?: FeedbackCategory | "ALL";
  cursor?: string;
  limit?: number;
}

export async function listFeedback(params: ListFeedbackParams = {}) {
  const sp = new URLSearchParams();
  if (params.status) sp.set("status", params.status);
  if (params.category) sp.set("category", params.category);
  if (params.cursor) sp.set("cursor", params.cursor);
  if (params.limit) sp.set("limit", String(params.limit));
  const q = sp.toString();
  return jsonFetch<{ items: FeedbackListItem[]; nextCursor: string | null }>(`/api/feedback${q ? `?${q}` : ""}`);
}

export async function fetchFeedbackStats() {
  return jsonFetch<FeedbackStats>("/api/feedback/stats");
}

export async function fetchFeedbackDetail(id: string) {
  return jsonFetch<FeedbackDetail>(`/api/feedback/${id}`);
}

export interface CreateFeedbackBody {
  category: FeedbackCategory;
  title: string;
  description: string;
  pageUrl?: string | null;
  viewport?: string | null;
  userAgent?: string | null;
}

export async function createFeedback(body: CreateFeedbackBody) {
  return jsonFetch<{ id: string }>(`/api/feedback`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadFeedbackPhotos(id: string, files: File[]) {
  const fd = new FormData();
  for (const f of files) fd.append("photos", f);
  const res = await fetch(`/api/feedback/${id}/photos`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error(`Не удалось загрузить фото (${res.status})`);
  return res.json() as Promise<{ photos: Array<{ id: string; url: string }> }>;
}

export async function changeStatus(id: string, status: FeedbackStatus) {
  return jsonFetch<FeedbackListItem>(`/api/feedback/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export async function addFeedbackComment(id: string, body: string) {
  return jsonFetch<{ id: string }>(`/api/feedback/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function deleteFeedback(id: string) {
  return jsonFetch<{ ok: true }>(`/api/feedback/${id}`, { method: "DELETE" });
}

export async function deleteFeedbackComment(id: string, commentId: string) {
  return jsonFetch<{ ok: true }>(`/api/feedback/${id}/comments/${commentId}`, { method: "DELETE" });
}
