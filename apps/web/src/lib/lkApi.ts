async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (res.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/lk/login")) {
      window.location.href = "/lk/login";
    }
    throw new Error("UNAUTHENTICATED");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.code || `HTTP ${res.status}`);
  }
  return res.json();
}

export const lkApi = {
  me: () => fetchJson<import("./lkTypes").LkMe>("/api/lk/me"),
  bookings: (cursor?: string, status?: string) => {
    const sp = new URLSearchParams();
    if (cursor) sp.set("cursor", cursor);
    if (status) sp.set("status", status);
    const qs = sp.toString();
    return fetchJson<{ items: import("./lkTypes").LkBookingListItem[]; nextCursor: string | null }>(
      `/api/lk/bookings${qs ? `?${qs}` : ""}`,
    );
  },
  booking: (id: string) => fetchJson<import("./lkTypes").LkBookingDetail>(`/api/lk/bookings/${id}`),
  estimates: (cursor?: string) =>
    fetchJson<{ items: import("./lkTypes").LkEstimateListItem[]; nextCursor: string | null }>(
      `/api/lk/estimates${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  debt: () => fetchJson<import("./lkTypes").LkDebtResponse>("/api/lk/debt"),
  stats: (period: "180d" | "365d" | "all" = "365d") =>
    fetchJson<import("./lkTypes").LkStatsResponse>(`/api/lk/stats?period=${period}`),
  requestLogin: (email: string) =>
    fetchJson<{ ok: true }>("/api/lk/auth/request-login", { method: "POST", body: JSON.stringify({ email }) }),
  verify: (token: string) =>
    fetchJson<{ ok: true }>("/api/lk/auth/verify", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => fetchJson<{ ok: true }>("/api/lk/auth/logout", { method: "POST" }),
};
