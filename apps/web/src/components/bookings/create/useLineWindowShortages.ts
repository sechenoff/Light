"use client";

/**
 * «На ср свободно 1 из 2» — склад на срок длинной позиции (мокап M1).
 *
 * Каталог формы считает доступность на период брони. Позиция, взятая дольше,
 * держит склад до своего срока, поэтому её доступность нужно смотреть на
 * окне «выдача → срок строки»: там же её проверит сервер при подтверждении.
 * Это предупреждение, а не запрет — как у договорной цены, решает человек.
 *
 * Окон обычно одно-два (смены меняют у пары позиций), поэтому окно — обычный
 * GET /api/availability на свой период; ответы кэшируются по окну, а запрос
 * ждёт паузы в наборе, чтобы степпер в шторке не слал запрос на каждый тап.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../../lib/api";
import type { LineShortage } from "./LineShiftsControls";
import { formatDueDay, isLongLine, lineDueAt } from "./lineShifts";
import type { AvailabilityRow, CatalogSelectedItem } from "./types";

const FETCH_DEBOUNCE_MS = 400;

type Args = {
  selected: Map<string, CatalogSelectedItem>;
  bookingShifts: number;
  pickupISO: string | null | undefined;
  returnISO: string | null | undefined;
  /** Даты некорректны — ничего не спрашиваем. */
  invalid: boolean;
  /** Правка брони: её собственные позиции доступность не занимают. */
  excludeBookingId?: string;
};

export function useLineWindowShortages({
  selected,
  bookingShifts,
  pickupISO,
  returnISO,
  invalid,
  excludeBookingId,
}: Args): Map<string, LineShortage> {
  const endMs = returnISO ? Date.parse(returnISO) : NaN;
  const active = Boolean(pickupISO) && Number.isFinite(endMs) && !invalid;

  // Срок каждой длинной строки и набор окон, которые нужно спросить.
  const dueById = useMemo(() => {
    const map = new Map<string, number>();
    if (!active) return map;
    for (const it of selected.values()) {
      if (isLongLine(bookingShifts, it.shifts)) map.set(it.equipmentId, lineDueAt(endMs, bookingShifts, it.shifts));
    }
    return map;
  }, [active, selected, bookingShifts, endMs]);
  const windows = Array.from(new Set(dueById.values())).sort((a, b) => a - b);
  const windowsKey = windows.join(",");

  const keyOf = (due: number) => `${pickupISO}|${due}|${excludeBookingId ?? ""}`;
  const [cache, setCache] = useState<Map<string, Map<string, number>>>(new Map());
  // Окна, которые уже спросили (или спрашивают): ответ кладётся в кэш по ключу
  // окна, поэтому запоздавший ответ ничего не портит.
  const requestedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!active || !pickupISO || windows.length === 0) return;
    const timer = setTimeout(() => {
      for (const due of windows) {
        const key = keyOf(due);
        if (requestedRef.current.has(key)) continue;
        requestedRef.current.add(key);
        const params = new URLSearchParams({ start: pickupISO, end: new Date(due).toISOString() });
        if (excludeBookingId) params.set("excludeBookingId", excludeBookingId);
        apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`)
          .then((res) => {
            const byId = new Map(res.rows.map((r) => [r.equipmentId, Math.max(0, r.availableQuantity)]));
            setCache((prev) => new Map(prev).set(key, byId));
          })
          // Подсказка не обязательна: без ответа строка просто не предупреждает,
          // а нехватку всё равно остановит подтверждение брони на сервере.
          // Окно забываем, чтобы следующая правка спросила его снова.
          .catch(() => {
            requestedRef.current.delete(key);
          });
      }
    }, FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // windowsKey — содержимое `windows`; сам массив новый на каждом рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pickupISO, windowsKey, excludeBookingId]);

  return useMemo(() => {
    const out = new Map<string, LineShortage>();
    for (const [id, due] of dueById) {
      const available = cache.get(keyOf(due))?.get(id);
      const item = selected.get(id);
      if (available == null || !item || available >= item.quantity) continue;
      out.set(id, { available, dueDay: formatDueDay(due) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueById, cache, selected, pickupISO, excludeBookingId]);
}
