"use client";

/**
 * Превью частичной приёмки для окна «Принять возврат»: цена дополнительной
 * сметы и брони, которым оставленное нужно. Сервер считает той же записью в
 * откатываемой транзакции, поэтому цифры совпадут с теми, что запишутся.
 * Запрос ждёт паузы в правках, ответ старее последней правки отбрасывается.
 */
import { useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";
import type { ReturnPreview } from "./returnDialogState";

const PREVIEW_DEBOUNCE_MS = 350;

type Stay = { bookingItemId: string; quantity: number; until: string; equipmentUnitIds?: string[]; acknowledgedConflict?: boolean };

export function useReturnPreview(bookingId: string, stays: Stay[] | null) {
  const [preview, setPreview] = useState<ReturnPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const key = stays ? JSON.stringify(stays) : "";

  useEffect(() => {
    if (!stays || stays.length === 0) {
      seq.current += 1;
      setPreview(null);
      setError(null);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      apiFetch<ReturnPreview>(`/api/bookings/${bookingId}/return-partial/preview`, {
        method: "POST",
        body: JSON.stringify({ stays }),
      })
        .then((p) => {
          if (mine !== seq.current) return;
          setPreview({
            continuations: Array.isArray(p?.continuations) ? p.continuations : [],
            conflicts: Array.isArray(p?.conflicts) ? p.conflicts : [],
            parentNegotiatedTotal: p?.parentNegotiatedTotal ?? null,
          });
          setError(null);
        })
        .catch((e: { message?: string }) => {
          if (mine !== seq.current) return;
          setPreview(null);
          setError(e?.message ?? "Не удалось посчитать дополнительную смету");
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // key — содержимое stays; сам массив новый на каждом рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, key]);

  return { preview, loading, error };
}
