"use client";

/**
 * Что остаётся у клиента на приёмке в киоске (этап 15, мокап M3).
 *
 * Два источника: строки «по плану у клиента» (их срок можно продлить чипами в
 * блоке «по плану») и «Остаётся у клиента…» у любой обычной строки. Отсюда:
 *  - строки чек-листа за вычетом оставленного (`adjustedById`, `items`);
 *  - список `stays` для «Завершить»;
 *  - превью доплаты и держателей с сервера — только когда что-то остаётся
 *    сверх оплаченного (`POST /sessions/:id/stays-preview`, дебаунс).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scanApi } from "./api";
import { beyondPaid, type KioskStay, type KioskStaysPreview } from "./kioskStays";
import type { ChecklistItem, ChecklistState, PlannedStay, ReturnDraftStay, StayInput } from "./types";

const STAYS_PREVIEW_DEBOUNCE_MS = 400;

type Args = {
  sessionId: string;
  state: ChecklistState | null;
  /** Строки чек-листа до «остаётся у клиента». */
  baseItems: ChecklistItem[];
  planned: PlannedStay[];
  /** Строки «по плану», которые привезли сейчас. */
  returnNow: ReadonlySet<string>;
};

export function useKioskStays({ sessionId, state, baseItems, planned, returnNow }: Args) {
  // Срок «по плану» продлили сверх оплаченного (чипы в блоке «по плану»).
  const [plannedTerms, setPlannedTerms] = useState<ReadonlyMap<string, KioskStay>>(new Map());
  // «Остаётся у клиента…» у обычных строк: что и до когда.
  const [extraStays, setExtraStays] = useState<ReadonlyMap<string, KioskStay>>(new Map());
  const [preview, setPreview] = useState<KioskStaysPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Пересчитать с теми же отметками: «Завершить» получил 409 — позицию
  // заняли, пока шла приёмка, и карточка держателя должна появиться.
  const [nonce, setNonce] = useState(0);
  const previewSeq = useRef(0);

  // Что остаётся у клиента, из строки уходит: у COUNT — меньше штук, у UNIT —
  // без оставленных единиц; оставили всё — строки в чек-листе нет (null).
  const adjustedById = useMemo(() => {
    const m = new Map<string, ChecklistItem | null>();
    for (const it of baseItems) {
      const st = extraStays.get(it.bookingItemId);
      if (!st || st.quantity <= 0) {
        m.set(it.bookingItemId, it);
      } else if (it.trackingMode === "UNIT" && it.units) {
        const units = it.units.filter((u) => !st.unitIds.includes(u.unitId));
        m.set(it.bookingItemId, units.length > 0 ? { ...it, units, quantity: Math.max(0, it.quantity - st.quantity) } : null);
      } else {
        const q = it.quantity - st.quantity;
        m.set(it.bookingItemId, q > 0 ? { ...it, quantity: q } : null);
      }
    }
    return m;
  }, [baseItems, extraStays]);

  const items = useMemo(
    () => baseItems.map((i) => adjustedById.get(i.bookingItemId)).filter((i): i is ChecklistItem => i != null),
    [baseItems, adjustedById],
  );

  // Всё, что уходит в продолжение: «по плану» (кроме «вернули сейчас») и
  // «Остаётся у клиента…» у обычных строк.
  const allStays = useMemo((): StayInput[] => {
    const out: StayInput[] = [];
    for (const p of planned) {
      if (returnNow.has(p.bookingItemId)) continue;
      const t = plannedTerms.get(p.bookingItemId);
      out.push({
        bookingItemId: p.bookingItemId,
        quantity: p.quantity,
        until: t?.until ?? p.until,
        ...(p.unitIds.length > 0 ? { equipmentUnitIds: [...p.unitIds] } : {}),
        ...(t?.acknowledged ? { acknowledgedConflict: true } : {}),
      });
    }
    for (const [id, st] of extraStays) {
      if (st.quantity <= 0) continue;
      const it = baseItems.find((i) => i.bookingItemId === id);
      if (!it) continue;
      out.push({
        bookingItemId: id,
        quantity: st.quantity,
        until: st.until,
        ...(it.trackingMode === "UNIT" ? { equipmentUnitIds: [...st.unitIds] } : {}),
        ...(st.acknowledged ? { acknowledgedConflict: true } : {}),
      });
    }
    return out;
  }, [planned, returnNow, plannedTerms, extraStays, baseItems]);

  // Оплачено — по расчёту сервера: у строки «по плану» он бывает позже срока
  // по плану (бронь не кратна суткам), и дни между ними бесплатны.
  const paidThroughOf = (bookingItemId: string): string | undefined =>
    state?.linePaidThrough?.[bookingItemId] ?? planned.find((p) => p.bookingItemId === bookingItemId)?.until;
  const anyBeyond = allStays.some((st) => beyondPaid(st.until, paidThroughOf(st.bookingItemId)));
  const staysKey = JSON.stringify(allStays);

  useEffect(() => {
    if (!anyBeyond || allStays.length === 0) {
      previewSeq.current += 1;
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    const mine = ++previewSeq.current;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      scanApi
        .staysPreview(sessionId, allStays)
        .then((p) => {
          if (mine === previewSeq.current) setPreview(p);
        })
        .catch(() => {
          // Без превью доплата не видна, но завершить можно: сервер посчитает
          // и проверит держателей сам (409 CONTINUATION_CONFLICT).
          if (mine === previewSeq.current) setPreview(null);
        })
        .finally(() => {
          if (mine === previewSeq.current) setPreviewLoading(false);
        });
    }, STAYS_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // staysKey — содержимое allStays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, staysKey, anyBeyond, nonce]);

  const previewLineFor = (id: string) =>
    preview?.continuations.flatMap((c) => c.lines).find((l) => l.bookingItemId === id) ?? null;
  const conflictFor = (id: string) => preview?.conflicts.find((c) => c.bookingItemId === id) ?? null;
  const previewDiscount = Number(preview?.continuations[0]?.discountPercent ?? 0);
  // Конфликт держит «Завершить», только пока по строке что-то остаётся сверх
  // оплаченного без «под ответственность»: старое превью после снятия
  // «остаётся» не должно блокировать.
  const unacknowledgedConflicts = (preview?.conflicts ?? []).filter((c) =>
    allStays.some(
      (st) =>
        st.bookingItemId === c.bookingItemId &&
        beyondPaid(st.until, paidThroughOf(st.bookingItemId)) &&
        !st.acknowledgedConflict,
    ),
  );
  const anyExtraStaying = Array.from(extraStays.values()).some((st) => st.quantity > 0);

  function setExtraStay(bookingItemId: string, next: KioskStay | null) {
    setExtraStays((m) => {
      const n = new Map(m);
      if (next) n.set(bookingItemId, next);
      else n.delete(bookingItemId);
      return n;
    });
  }

  function setPlannedTerm(bookingItemId: string, next: KioskStay) {
    setPlannedTerms((m) => new Map(m).set(bookingItemId, next));
  }

  /** «Завершить» получил 409 CONTINUATION_CONFLICT: карточки держателей — сразу из ответа. */
  function applyServerConflicts(conflicts: KioskStaysPreview["conflicts"]) {
    previewSeq.current += 1;
    setPreview((p) => ({
      continuations: p?.continuations ?? [],
      conflicts,
      parentNegotiatedTotal: p?.parentNegotiatedTotal ?? null,
    }));
    setNonce((n) => n + 1);
  }

  // Черновик: что и до когда остаётся — переживает перезагрузку планшета.
  const draftStays = useMemo(() => {
    const out: Record<string, ReturnDraftStay> = {};
    for (const [id, st] of extraStays) out[id] = { ...st };
    for (const [id, st] of plannedTerms) out[id] = { ...st, planned: true };
    return out;
  }, [extraStays, plannedTerms]);

  // Стабильная ссылка: восстановление черновика зависит от неё.
  const restoreStays = useCallback((saved: Record<string, ReturnDraftStay>) => {
    const extra = new Map<string, KioskStay>();
    const terms = new Map<string, KioskStay>();
    for (const [id, { planned: isPlanned, ...st }] of Object.entries(saved)) {
      if (isPlanned) terms.set(id, st);
      else extra.set(id, st);
    }
    setExtraStays(extra);
    setPlannedTerms(terms);
  }, []);

  return {
    plannedTerms,
    extraStays,
    adjustedById,
    items,
    allStays,
    paidThroughOf,
    previewLoading,
    previewLineFor,
    conflictFor,
    previewDiscount,
    unacknowledgedConflicts,
    anyExtraStaying,
    setExtraStay,
    setPlannedTerm,
    refreshPreview: () => setNonce((n) => n + 1),
    applyServerConflicts,
    preview,
    draftStays,
    restoreStays,
  };
}
