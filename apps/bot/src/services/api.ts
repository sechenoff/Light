import type { EquipmentItem, MatchedItem } from "../types";

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

/** Создать новую бронь */
export async function createBooking(args: {
  clientName: string;
  projectName: string;
  startDate: string;
  endDate: string;
  items: MatchedItem[];
  comment?: string;
}): Promise<{ id: string; humanId: number }> {
  const body = {
    clientName: args.clientName,
    projectName: args.projectName,
    startDate: new Date(`${args.startDate}T09:00:00`).toISOString(),
    endDate: new Date(`${args.endDate}T23:00:00`).toISOString(),
    comment: args.comment ?? "",
    source: "telegram",
    items: args.items.map((i) => ({
      equipmentId: i.equipmentId,
      quantity: i.quantity,
    })),
  };

  return apiFetch<{ id: string; humanId: number }>("/api/bookings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
