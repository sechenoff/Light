"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../../../src/lib/api";
import { formatMoneyRub } from "../../../../src/lib/format";
import {
  addHoursToDatetimeLocal,
  datetimeLocalToISO,
  formatRentalDurationDetails,
} from "../../../../src/lib/rentalTime";

// ─── Types ───────────────────────────────────────────────────────────────────

type AvailabilityRow = {
  equipmentId: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  totalQuantity: number;
  rentalRatePerShift: string;
  occupiedQuantity: number;
  availableQuantity: number;
  availability: "UNAVAILABLE" | "PARTIAL" | "AVAILABLE";
  comment: string | null;
};

type BookingDetail = {
  id: string;
  status: "DRAFT" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  projectName: string;
  startDate: string;
  endDate: string;
  comment: string | null;
  discountPercent: string | null;
  expectedPaymentDate: string | null;
  client: { id: string; name: string; phone: string | null };
  items: Array<{ id: string; equipmentId: string; quantity: number; equipment: { id: string; name: string; category: string; brand: string | null; model: string | null; rentalRatePerShift: string } }>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CATEGORY_PASTEL_CLASSES = [
  "bg-rose-soft text-rose border-rose-border",
  "bg-amber-soft text-amber border-amber-border",
  "bg-amber-soft text-amber border-amber-border",
  "bg-emerald-soft text-emerald border-emerald-border",
  "bg-emerald-soft text-emerald border-emerald-border",
  "bg-emerald-soft text-emerald border-emerald-border",
  "bg-teal-soft text-teal border-teal-border",
  "bg-teal-soft text-teal border-teal-border",
  "bg-accent-soft text-accent border-accent-border",
  "bg-accent-soft text-accent border-accent-border",
  "bg-indigo-soft text-indigo border-indigo-border",
  "bg-indigo-soft text-indigo border-indigo-border",
  "bg-indigo-soft text-indigo border-indigo-border",
  "bg-rose-soft text-rose border-rose-border",
  "bg-rose-soft text-rose border-rose-border",
] as const;

function getCategoryColorClass(category: string) {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_PASTEL_CLASSES[hash % CATEGORY_PASTEL_CLASSES.length];
}

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoToDateInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function splitLocalDateTime(local: string): { date: string; time: string } {
  if (local.includes("T")) {
    const [d, rest] = local.split("T");
    const t = (rest ?? "10:00").slice(0, 5);
    return { date: d, time: /^\d{2}:\d{2}$/.test(t) ? t : "10:00" };
  }
  return { date: local.slice(0, 10), time: "10:00" };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function BookingEditPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [booking, setBooking] = useState<BookingDetail | null>(null);

  // Form state
  const [projectName, setProjectName] = useState("");
  const [bookingComment, setBookingComment] = useState("");
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [expectedPaymentDate, setExpectedPaymentDate] = useState("");
  const [pickupLocal, setPickupLocal] = useState("");
  const [returnLocal, setReturnLocal] = useState("");

  // Equipment
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [categories, setCategories] = useState<string[]>([]);
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowCache, setRowCache] = useState<Map<string, AvailabilityRow>>(() => new Map());
  const [selected, setSelected] = useState<Record<string, number>>({});

  const [saving, setSaving] = useState(false);

  const pickupISO = useMemo(() => datetimeLocalToISO(pickupLocal), [pickupLocal]);
  const returnISO = useMemo(() => datetimeLocalToISO(returnLocal), [returnLocal]);

  const rentalDurationPreview = useMemo(() => {
    if (!pickupISO || !returnISO) return null;
    const s = new Date(pickupISO);
    const e = new Date(returnISO);
    if (e.getTime() <= s.getTime()) return null;
    return formatRentalDurationDetails(s, e);
  }, [pickupISO, returnISO]);

  const previewShifts = rentalDurationPreview?.shifts ?? 1;

  // ── Load booking ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    apiFetch<{ booking: BookingDetail }>(`/api/bookings/${id}`)
      .then(({ booking: b }) => {
        setBooking(b);
        setProjectName(b.projectName);
        setBookingComment(b.comment ?? "");
        setDiscountPercent(b.discountPercent ? Number(b.discountPercent) : 0);
        setExpectedPaymentDate(b.expectedPaymentDate ? isoToDateInput(b.expectedPaymentDate) : "");
        setPickupLocal(isoToDatetimeLocal(b.startDate));
        setReturnLocal(isoToDatetimeLocal(b.endDate));
        setSelected(Object.fromEntries(b.items.map((it) => [it.equipmentId, it.quantity])));
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  // ── Load categories ───────────────────────────────────────────────────────
  useEffect(() => {
    apiFetch<{ categories: string[] }>("/api/equipment/categories")
      .then((r) => setCategories(r.categories))
      .catch(() => {});
  }, []);

  // ── Load availability ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!pickupISO || !returnISO) return;
    const controller = new AbortController();
    let isActive = true;
    async function load() {
      setLoadingRows(true);
      try {
        const params = new URLSearchParams({ start: pickupISO!, end: returnISO! });
        if (search.trim()) params.set("search", search.trim());
        if (category) params.set("category", category);
        if (id) params.set("excludeBookingId", id);
        const data = await apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!isActive) return;
        setRows(data.rows);
        setLoadingRows(false);
      } catch (e: unknown) {
        const isAbort = e instanceof Error && (e.name === "AbortError" || e.message === "signal is aborted without reason");
        if (!isAbort && isActive) setLoadingRows(false);
      }
    }
    load();
    return () => { isActive = false; controller.abort(); };
  }, [pickupISO, returnISO, search, category]);

  // ── Cache rows ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (rows.length === 0) return;
    setRowCache((prev) => {
      const next = new Map(prev);
      for (const r of rows) next.set(r.equipmentId, r);
      return next;
    });
  }, [rows]);

  // Also seed cache from booking items when booking first loads
  useEffect(() => {
    if (!booking) return;
    setRowCache((prev) => {
      const next = new Map(prev);
      for (const it of booking.items) {
        if (!next.has(it.equipmentId)) {
          next.set(it.equipmentId, {
            equipmentId: it.equipmentId,
            category: it.equipment.category,
            name: it.equipment.name,
            brand: it.equipment.brand ?? null,
            model: it.equipment.model ?? null,
            stockTrackingMode: "COUNT",
            totalQuantity: 0,
            rentalRatePerShift: it.equipment.rentalRatePerShift ?? "0",
            occupiedQuantity: 0,
            availableQuantity: 999,
            availability: "AVAILABLE",
            comment: null,
          } satisfies AvailabilityRow);
        }
      }
      return next;
    });
  }, [booking]);


  // ── Selected items for display ────────────────────────────────────────────
  const selectedItems = useMemo(() => {
    const liveById = new Map(rows.map((r) => [r.equipmentId, r]));
    return Object.entries(selected)
      .filter(([, qty]) => qty > 0)
      .map(([equipmentId, quantity]) => {
        const r = liveById.get(equipmentId) ?? rowCache.get(equipmentId);
        return { equipmentId, quantity, row: r };
      });
  }, [selected, rows, rowCache]);

  const localSubtotal = useMemo(() => {
    return previewShifts * selectedItems.reduce((acc, it) => {
      const rate = it.row ? Number(it.row.rentalRatePerShift) : 0;
      return acc + (Number.isFinite(rate) ? rate : 0) * it.quantity;
    }, 0);
  }, [selectedItems, previewShifts]);

  const clampedDiscount = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const discountAmount = (localSubtotal * clampedDiscount) / 100;
  const totalAfterDiscount = localSubtotal - discountAmount;

  // ── Actions ───────────────────────────────────────────────────────────────
  function increaseQuantity(r: AvailabilityRow) {
    if (r.availableQuantity <= 0) return;
    setSelected((prev) => {
      const current = prev[r.equipmentId] ?? 0;
      return { ...prev, [r.equipmentId]: Math.min(current + 1, r.availableQuantity) };
    });
  }

  function decreaseQuantity(equipmentId: string) {
    setSelected((prev) => {
      const next = prev[equipmentId] ?? 0;
      if (next - 1 <= 0) {
        const copy = { ...prev };
        delete copy[equipmentId];
        return copy;
      }
      return { ...prev, [equipmentId]: next - 1 };
    });
  }

  async function saveChanges() {
    if (!pickupISO || !returnISO) return;
    const itemsToSave = Object.entries(selected)
      .filter(([, qty]) => qty > 0)
      .map(([equipmentId, quantity]) => ({ equipmentId, quantity }));
    if (itemsToSave.length === 0) { alert("Добавьте хотя бы одну позицию оборудования."); return; }
    setSaving(true);
    try {
      await apiFetch(`/api/bookings/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          projectName: projectName.trim() || "Проект",
          startDate: pickupISO,
          endDate: returnISO,
          comment: bookingComment || null,
          discountPercent: clampedDiscount,
          expectedPaymentDate: expectedPaymentDate || null,
          items: itemsToSave,
        }),
      });
      router.push(`/bookings/${id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Не удалось сохранить изменения";
      alert(msg);
    } finally {
      setSaving(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="p-8 text-center text-ink-2">Загрузка…</div>;
  }
  if (notFound || !booking) {
    return (
      <div className="p-8 text-center text-ink-2">
        Бронь не найдена.{" "}
        <Link href="/bookings" className="underline">
          К списку
        </Link>
      </div>
    );
  }
  if (!["DRAFT", "CONFIRMED"].includes(booking.status)) {
    return (
      <div className="p-8 text-center text-ink-2">
        Редактирование недоступно для статуса «{booking.status}».{" "}
        <Link href={`/bookings/${id}`} className="underline">
          Открыть бронь
        </Link>
      </div>
    );
  }

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/bookings/${id}`} className="text-ink-2 hover:text-ink text-sm">
            ← Назад
          </Link>
          <h1 className="text-xl font-semibold">
            Редактирование брони
          </h1>
          <span className="text-sm text-ink-2">{booking.client.name} · {booking.projectName}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        {/* ── Left column ── */}
        <div className="col-span-12 lg:col-span-8 space-y-4">

          {/* Dates + discount */}
          <div className="rounded border border-border bg-white">
            <div className="p-3 border-b border-border flex items-center gap-3 flex-wrap">
              <div className="flex flex-col min-w-[148px]">
                <label className="text-xs text-ink-2 mb-0.5">Дата выдачи</label>
                <input
                  className="h-9 rounded-md border border-border px-2 bg-white text-sm"
                  type="date"
                  value={splitLocalDateTime(pickupLocal).date}
                  onChange={(e) => {
                    const d = e.target.value;
                    if (!d) return;
                    const t = splitLocalDateTime(pickupLocal).time;
                    const v = `${d}T${t}`;
                    setPickupLocal(v);
                    setReturnLocal((prev) => {
                      const pu = new Date(v);
                      const re = new Date(prev);
                      if (Number.isNaN(pu.getTime())) return prev;
                      if (re.getTime() <= pu.getTime()) return addHoursToDatetimeLocal(v, 24);
                      return prev;
                    });
                  }}
                />
              </div>
              <div className="flex flex-col min-w-[148px]">
                <label className="text-xs text-ink-2 mb-0.5">Время выдачи</label>
                <input
                  className="h-9 rounded-md border border-border px-2 bg-white text-sm"
                  type="time"
                  value={splitLocalDateTime(pickupLocal).time}
                  onChange={(e) => {
                    const d = splitLocalDateTime(pickupLocal).date;
                    setPickupLocal(`${d}T${e.target.value}`);
                  }}
                />
              </div>
              <div className="flex flex-col min-w-[148px]">
                <label className="text-xs text-ink-2 mb-0.5">Дата возврата</label>
                <input
                  className="h-9 rounded-md border border-border px-2 bg-white text-sm"
                  type="date"
                  value={splitLocalDateTime(returnLocal).date}
                  onChange={(e) => {
                    const d = e.target.value;
                    if (!d) return;
                    const t = splitLocalDateTime(returnLocal).time;
                    setReturnLocal(`${d}T${t}`);
                  }}
                />
              </div>
              <div className="flex flex-col min-w-[148px]">
                <label className="text-xs text-ink-2 mb-0.5">Время возврата</label>
                <input
                  className="h-9 rounded-md border border-border px-2 bg-white text-sm"
                  type="time"
                  value={splitLocalDateTime(returnLocal).time}
                  onChange={(e) => {
                    const d = splitLocalDateTime(returnLocal).date;
                    setReturnLocal(`${d}T${e.target.value}`);
                  }}
                />
              </div>
              {rentalDurationPreview && (
                <div className="text-xs text-ink-2 self-end pb-2">
                  {rentalDurationPreview.labelShort}
                </div>
              )}
              <div className="flex flex-col ml-auto">
                <label className="text-xs text-ink-2 mb-0.5">Скидка, %</label>
                <input
                  className="h-9 w-28 rounded-md border border-border px-2 bg-white text-sm"
                  type="number"
                  min={0}
                  max={100}
                  value={discountPercent}
                  onChange={(e) => setDiscountPercent(Number(e.target.value))}
                />
              </div>
            </div>

            {/* Project, client, comment, payment date */}
            <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="flex flex-col">
                <label className="text-xs text-ink-2">Клиент</label>
                <input
                  className="rounded border border-border px-2 py-1 bg-surface text-ink-2 cursor-not-allowed"
                  value={booking.client.name}
                  readOnly
                  title="Клиент задаётся при создании брони"
                />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-ink-2">Проект</label>
                <input
                  className="rounded border border-border px-2 py-1 bg-white"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-ink-2">Плановая дата платежа</label>
                <input
                  className="rounded border border-border px-2 py-1 bg-white"
                  type="date"
                  value={expectedPaymentDate}
                  onChange={(e) => setExpectedPaymentDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col md:col-span-3">
                <label className="text-xs text-ink-2">Комментарий</label>
                <textarea
                  className="rounded border border-border px-2 py-1.5 bg-white min-h-[44px] resize-y"
                  value={bookingComment}
                  onChange={(e) => setBookingComment(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
          </div>

          {/* Equipment list */}
          <div className="rounded border border-border bg-white overflow-hidden">
            <div className="p-3 border-b border-border flex items-center gap-3 flex-wrap">
              <input
                className="rounded border border-border px-2 py-1 bg-white text-sm flex-1 max-w-sm"
                placeholder="Поиск оборудования…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="rounded border border-border px-2 py-1 bg-white text-sm"
                value={category ?? ""}
                onChange={(e) => setCategory(e.target.value || undefined)}
              >
                <option value="">Все категории</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <span className="text-xs text-ink-2">
                {loadingRows ? "Загрузка…" : `Позиций: ${rows.length}`}
              </span>
            </div>
            <div className="overflow-auto">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="bg-surface text-ink-2">
                  <tr>
                    <th className="text-left px-3 py-2">Оборудование</th>
                    <th className="px-3 py-2 w-[100px] text-center">Кол-во</th>
                    <th className="px-3 py-2 w-[130px]">Стоимость/смена</th>
                    <th className="text-left px-3 py-2">Категория</th>
                    <th className="px-3 py-2 w-[100px] text-center">Доступно</th>
                    <th className="px-3 py-2 w-[200px] text-center">В бронь</th>
                    <th className="px-3 py-2 w-[120px] text-center">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const qty = selected[r.equipmentId] ?? 0;
                    const isUnavailable = r.availableQuantity <= 0;
                    const statusColor =
                      r.availability === "AVAILABLE"
                        ? "bg-emerald-soft text-emerald border-emerald-border"
                        : r.availability === "PARTIAL"
                          ? "bg-amber-soft text-amber border-amber-border"
                          : "bg-rose-soft text-rose border-rose-border";
                    return (
                      <tr key={r.equipmentId} className="border-t border-border">
                        <td className="px-3 py-2">
                          <div className="font-medium text-ink">{r.name}</div>
                          <div className="text-xs text-ink-2">
                            {r.brand ?? ""} {r.model ? `· ${r.model}` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 font-medium text-center">{r.totalQuantity}</td>
                        <td className="px-3 py-2 font-medium">{formatMoneyRub(r.rentalRatePerShift)}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center rounded border px-2 py-1 text-xs ${getCategoryColorClass(r.category)}`}>
                            {r.category}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-medium text-center">{r.availableQuantity}</td>
                        <td className="px-3 py-2">
                          <div className="inline-flex items-center rounded border border-border overflow-hidden">
                            <button
                              type="button"
                              className="h-9 w-9 text-lg leading-none bg-white hover:bg-surface disabled:opacity-50"
                              onClick={() => decreaseQuantity(r.equipmentId)}
                              disabled={qty <= 0}
                            >
                              -
                            </button>
                            <input
                              type="text"
                              inputMode="numeric"
                              className="h-9 w-16 border-x border-border text-center bg-white"
                              value={qty}
                              onChange={(e) => {
                                const raw = Number(e.target.value.replace(/[^\d]/g, ""));
                                const nextQty = Number.isFinite(raw) ? Math.max(0, Math.min(raw, r.availableQuantity)) : 0;
                                setSelected((prev) => {
                                  if (nextQty <= 0) { const next = { ...prev }; delete next[r.equipmentId]; return next; }
                                  return { ...prev, [r.equipmentId]: nextQty };
                                });
                              }}
                            />
                            <button
                              type="button"
                              className="h-9 w-9 text-lg leading-none bg-white hover:bg-surface disabled:opacity-50"
                              onClick={() => increaseQuantity(r)}
                              disabled={isUnavailable || qty >= r.availableQuantity}
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-flex items-center rounded border px-2 py-1 text-xs ${statusColor}`}>
                            {r.availableQuantity <= 0 ? "Недоступно" : r.availableQuantity < r.totalQuantity ? "Частично" : "Доступно"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && !loadingRows ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-ink-2" colSpan={7}>
                        Ничего не найдено
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── Right column — selected kit ── */}
        <div className="col-span-12 lg:col-span-4">
          <div className="rounded border border-border bg-white overflow-hidden sticky top-4 flex flex-col max-h-[min(calc(100vh-5rem),720px)]">
            <div className="bg-surface-muted px-3 py-2 border-b border-border shrink-0">
              <div className="text-sm font-semibold text-ink">Выбранный комплект</div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {selectedItems.length === 0 ? (
                <div className="p-3 text-sm text-ink-2">Выберите оборудование слева.</div>
              ) : (
                <div className="divide-y divide-slate-200">
                  {selectedItems.map((it) => {
                    const r = it.row;
                    if (!r) return null;
                    const lineTotal = Number.isFinite(Number(r.rentalRatePerShift))
                      ? Number(r.rentalRatePerShift) * it.quantity * previewShifts
                      : 0;
                    return (
                      <div key={it.equipmentId} className="px-3 py-2.5 text-sm flex justify-between gap-3 items-start">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-ink truncate">{r.name}</div>
                          <div className="text-xs text-ink-2 truncate">
                            {[r.brand, r.model].filter(Boolean).join(" · ")}
                          </div>
                          <div className="text-xs text-ink-2 mt-0.5">
                            Кол-во: {it.quantity}
                            <span className="text-ink-3"> · </span>
                            {r.category}
                          </div>
                        </div>
                        <div className="flex items-start gap-1 shrink-0">
                          <div className="text-right">
                            <div className="font-medium tabular-nums">{formatMoneyRub(lineTotal)}</div>
                            <div className="text-[10px] text-ink-2">{formatMoneyRub(Number(r.rentalRatePerShift))}/ед.</div>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 rounded p-1.5 text-ink-2 hover:bg-rose-soft hover:text-rose transition-colors"
                            aria-label="Убрать из комплекта"
                            onClick={() => setSelected((prev) => { const next = { ...prev }; delete next[it.equipmentId]; return next; })}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Summary + save */}
            <div className="border-t border-border shrink-0">
              <div className="bg-surface-muted px-3 py-2 text-xs font-semibold text-ink-2 border-b border-border">
                Предварительная смета
              </div>
              <div className="p-3 bg-surface space-y-2">
                {selectedItems.length > 0 ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-2">Итого (без скидки)</span>
                      <span className="font-medium tabular-nums">{formatMoneyRub(localSubtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-2">Скидка ({clampedDiscount}%)</span>
                      <span className="font-medium tabular-nums">-{formatMoneyRub(discountAmount)}</span>
                    </div>
                    <div className="flex justify-between text-base pt-1 border-t border-border">
                      <span className="text-ink">Итого после скидки</span>
                      <span className="font-semibold tabular-nums">{formatMoneyRub(totalAfterDiscount)}</span>
                    </div>
                    <p className="text-xs text-ink-3 pt-1">
                      Предварительно · Окончательная сумма пересчитывается при подтверждении.
                    </p>
                  </>
                ) : (
                  <div className="text-sm text-ink-2">Выберите комплект слева.</div>
                )}
              </div>

              <div className="px-3 py-3 border-t border-border bg-white flex justify-end gap-2">
                <Link
                  href={`/bookings/${id}`}
                  className="rounded border border-border px-4 py-2 text-sm hover:bg-surface"
                >
                  Отмена
                </Link>
                <button
                  type="button"
                  className="rounded bg-accent text-white px-4 py-2 text-sm hover:bg-accent-bright disabled:opacity-50"
                  disabled={saving || selectedItems.length === 0}
                  onClick={saveChanges}
                >
                  {saving ? "Сохранение…" : "Сохранить изменения"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
