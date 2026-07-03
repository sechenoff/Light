"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { toast } from "../ToastProvider";
import { toMoscowDateString } from "../../lib/moscowDate";

const KIND_LABELS: Record<string, string> = {
  FULL: "Полный",
  DEPOSIT: "Предоплата",
  BALANCE: "Остаток",
  CORRECTION: "Корректировка",
};

/** Дебаунс поиска брони, мс */
const SEARCH_DEBOUNCE_MS = 300;
/** Минимальная длина запроса для поиска */
const SEARCH_MIN_CHARS = 2;

interface BookingHit {
  id: string;
  projectName: string;
  startDate: string | null;
  endDate: string | null;
  finalAmount?: string;
  amountPaid?: string;
  amountOutstanding?: string;
  client: { id?: string; name: string };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Если задан — бронь зафиксирована */
  defaultBookingId?: string;
  /** Сумма брони (авто-заполнение для FULL/BALANCE) */
  defaultTotal?: string;
  onCreated: () => void;
}

function formatBookingDates(start: string | null, end: string | null): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  if (start && end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return fmt(start);
  return "—";
}

/** Строка-сводка найденной брони: клиент · проект · даты · сумма */
function bookingSummary(b: BookingHit): string {
  const parts = [b.client.name, b.projectName, formatBookingDates(b.startDate, b.endDate)];
  if (b.finalAmount != null) parts.push(formatRub(b.finalAmount));
  return parts.join(" · ");
}

/**
 * Модалка «Создать счёт» — создаёт Invoice в статусе DRAFT.
 * POST /api/invoices.
 *
 * Бронь выбирается через поиск (GET /api/bookings?q=) по клиенту/проекту —
 * менеджеру не нужно вставлять сырой CUID. Для FULL/BALANCE сумма
 * автозаполняется из брони и может быть опущена (сервер посчитает сам
 * через computeTotalFromBooking); для DEPOSIT/CORRECTION сумма обязательна.
 */
export function CreateInvoiceModal({
  open,
  onClose,
  defaultBookingId,
  defaultTotal,
  onCreated,
}: Props) {
  const [selectedBooking, setSelectedBooking] = useState<BookingHit | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<BookingHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [kind, setKind] = useState("FULL");
  const [total, setTotal] = useState(defaultTotal ?? "");
  const [dueDate, setDueDate] = useState(() => {
    // default today + 14 days
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return toMoscowDateString(d);
  });
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const bookingId = defaultBookingId ?? selectedBooking?.id ?? "";

  useEffect(() => {
    if (open) {
      setSelectedBooking(null);
      setQuery("");
      setHits([]);
      setKind("FULL");
      setTotal(defaultTotal ?? "");
      setNotes("");
      if (!defaultBookingId) {
        setTimeout(() => searchRef.current?.focus(), 50);
      }
    }
  }, [open, defaultBookingId, defaultTotal]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Дебаунс-поиск броней по клиенту/проекту
  useEffect(() => {
    if (!open || defaultBookingId) return;
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      apiFetch<{ bookings: BookingHit[] }>(
        `/api/bookings?q=${encodeURIComponent(q)}&limit=20`
      )
        .then((d) => {
          if (!cancelled) setHits(d.bookings ?? []);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, defaultBookingId, query]);

  /** Автозаполнение суммы из брони: FULL → итог, BALANCE → остаток. */
  function autofillTotal(nextKind: string, booking: BookingHit | null) {
    if (!booking) return;
    if (nextKind === "FULL" && booking.finalAmount != null) {
      setTotal(booking.finalAmount);
    } else if (nextKind === "BALANCE" && booking.amountOutstanding != null) {
      setTotal(booking.amountOutstanding);
    }
  }

  function selectBooking(b: BookingHit) {
    setSelectedBooking(b);
    setQuery("");
    setHits([]);
    autofillTotal(kind, b);
  }

  function changeKind(nextKind: string) {
    setKind(nextKind);
    autofillTotal(nextKind, selectedBooking);
  }

  // Для FULL/BALANCE сумму можно не указывать — сервер вычислит из брони.
  const totalRequired = kind === "DEPOSIT" || kind === "CORRECTION";
  const totalValid = totalRequired
    ? Number(total) > 0
    : total.trim() === "" || Number(total) > 0;
  const isValid = bookingId.trim().length > 0 && totalValid && dueDate.length > 0;

  const handleSubmit = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      await apiFetch("/api/invoices", {
        method: "POST",
        body: JSON.stringify({
          bookingId: bookingId.trim(),
          kind,
          total: total.trim() !== "" ? Number(total) : undefined,
          dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
          notes: notes.trim() || undefined,
        }),
      });
      toast.success("Счёт создан");
      onCreated();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка создания счёта");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-sm">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-ink">Создать счёт</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {/* Booking selector — поиск вместо сырого CUID */}
          {!defaultBookingId && (
            <div>
              <label className="eyebrow block mb-1">Бронь *</label>
              {selectedBooking ? (
                <div className="flex items-start justify-between gap-2 border border-accent-border bg-accent-soft rounded px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{selectedBooking.client.name}</p>
                    <p className="text-[11.5px] text-ink-2 truncate">
                      {selectedBooking.projectName}
                      {" · "}
                      {formatBookingDates(selectedBooking.startDate, selectedBooking.endDate)}
                      {selectedBooking.finalAmount != null && (
                        <> · <span className="mono-num">{formatRub(selectedBooking.finalAmount)}</span></>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => { setSelectedBooking(null); setTimeout(() => searchRef.current?.focus(), 50); }}
                    aria-label="Сбросить бронь"
                    title="Выбрать другую бронь"
                    className="text-ink-3 hover:text-ink text-base leading-none flex-shrink-0"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <input
                    ref={searchRef}
                    type="text"
                    className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
                    placeholder="🔍 Клиент или проект…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query.trim().length >= SEARCH_MIN_CHARS && (
                    <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-surface border border-border rounded-lg shadow-lg max-h-[220px] overflow-y-auto">
                      {searching ? (
                        <p className="px-3 py-2.5 text-xs text-ink-3">Поиск…</p>
                      ) : hits.length === 0 ? (
                        <p className="px-3 py-2.5 text-xs text-ink-3">Брони не найдены</p>
                      ) : (
                        hits.map((b) => (
                          <button
                            key={b.id}
                            onClick={() => selectBooking(b)}
                            className="w-full text-left px-3 py-2 text-[12.5px] text-ink hover:bg-surface-subtle border-b border-slate-soft last:border-0"
                          >
                            {bookingSummary(b)}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Kind */}
          <div>
            <label className="eyebrow block mb-1">Тип счёта *</label>
            <select
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={kind}
              onChange={(e) => changeKind(e.target.value)}
            >
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>

          {/* Total */}
          <div>
            <label className="eyebrow block mb-1">
              Сумма {totalRequired ? "*" : ""} (₽)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              placeholder="0.00"
            />
            {!totalRequired && (
              <p className="text-[11px] text-ink-3 mt-1">
                Можно оставить пустым — сумма посчитается из брони
              </p>
            )}
          </div>

          {/* Due date */}
          <div>
            <label className="eyebrow block mb-1">Срок оплаты *</label>
            <input
              type="date"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="eyebrow block mb-1">Примечание</label>
            <textarea
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Необязательно"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end px-5 pb-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle"
          >
            Отмена
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !isValid}
            className="px-4 py-2 text-sm bg-accent-bright text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Создание…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}
