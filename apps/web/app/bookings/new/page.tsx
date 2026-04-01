"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch, apiFetchRaw } from "../../../src/lib/api";
import { getFileNameFromContentDisposition } from "../../../src/lib/download";
import { formatMoneyRub } from "../../../src/lib/format";
import {
  addHoursToDatetimeLocal,
  datetimeLocalToISO,
  defaultPickupDatetimeLocal,
  formatRentalDurationDetails,
  pickupFromSearchParam,
  returnFromSearchParam,
} from "../../../src/lib/rentalTime";

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

type GafferCandidate = {
  equipmentId: string;
  catalogName: string;
  category: string;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

type GafferResolved = {
  equipmentId: string;
  catalogName: string;
  suggestedName: string;
  category: string;
  quantity: number;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

type GafferNeedsReview = {
  rawPhrase: string;
  quantity: number;
  candidates: GafferCandidate[];
};

type GafferUnmatched = {
  rawPhrase: string;
  quantity: number;
};

type GafferParseResult = {
  resolved: GafferResolved[];
  needsReview: GafferNeedsReview[];
  unmatched: GafferUnmatched[];
  message?: string;
};

type QuoteResponse = {
  shifts: number;
  totalHours?: number;
  durationLabel?: string;
  subtotal: string;
  discountPercent: string;
  discountAmount: string;
  totalAfterDiscount: string;
  lines: Array<{
    equipmentId: string;
    categorySnapshot: string;
    nameSnapshot: string;
    brandSnapshot: string | null;
    modelSnapshot: string | null;
    quantity: number;
    pricingMode: "SHIFT" | "TWO_SHIFTS" | "PROJECT";
    unitPrice: string;
    lineSum: string;
  }>;
};

const CATEGORY_PASTEL_CLASSES = [
  "bg-rose-50 text-rose-700 border-rose-200",
  "bg-orange-50 text-orange-700 border-orange-200",
  "bg-amber-50 text-amber-700 border-amber-200",
  "bg-lime-50 text-lime-700 border-lime-200",
  "bg-green-50 text-green-700 border-green-200",
  "bg-emerald-50 text-emerald-700 border-emerald-200",
  "bg-teal-50 text-teal-700 border-teal-200",
  "bg-cyan-50 text-cyan-700 border-cyan-200",
  "bg-sky-50 text-sky-700 border-sky-200",
  "bg-blue-50 text-blue-700 border-blue-200",
  "bg-indigo-50 text-indigo-700 border-indigo-200",
  "bg-violet-50 text-violet-700 border-violet-200",
  "bg-purple-50 text-purple-700 border-purple-200",
  "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  "bg-pink-50 text-pink-700 border-pink-200",
] as const;

function getCategoryColorClass(category: string) {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_PASTEL_CLASSES[hash % CATEGORY_PASTEL_CLASSES.length];
}

/** Значение datetime-local: дата YYYY-MM-DD и время HH:mm */
function splitLocalDateTime(local: string): { date: string; time: string } {
  if (local.includes("T")) {
    const [d, rest] = local.split("T");
    const t = (rest ?? "10:00").slice(0, 5);
    return { date: d, time: /^\d{2}:\d{2}$/.test(t) ? t : "10:00" };
  }
  const d = local.slice(0, 10);
  return { date: d.length === 10 ? d : "", time: "10:00" };
}

function BookingNewPage() {
  const router = useRouter();
  const sp = useSearchParams();

  const startParam = sp.get("start");
  const endParam = sp.get("end");

  const [pickupLocal, setPickupLocal] = useState(() =>
    pickupFromSearchParam(startParam, defaultPickupDatetimeLocal()),
  );
  const [returnLocal, setReturnLocal] = useState(() =>
    returnFromSearchParam(endParam, pickupFromSearchParam(startParam, defaultPickupDatetimeLocal())),
  );

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
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [categories, setCategories] = useState<string[]>([]);
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  // Накопительный кеш данных позиций — не очищается при смене фильтра/поиска,
  // чтобы "Выбранный комплект" оставался видимым когда позиция скрыта фильтром.
  const [rowCache, setRowCache] = useState<Map<string, AvailabilityRow>>(() => new Map());

  const [clientName, setClientName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [bookingComment, setBookingComment] = useState("");
  const [discountPercent, setDiscountPercent] = useState<number>(50);
  const [expectedPaymentDate, setExpectedPaymentDate] = useState("");

  // equipmentId -> quantity
  const [selected, setSelected] = useState<Record<string, number>>({});
  const selectedItems = useMemo(() => {
    // Приоритет: живые данные из текущего rows, затем кеш (сохраняет панель при фильтрации).
    const liveById = new Map(rows.map((r) => [r.equipmentId, r]));
    return Object.entries(selected)
      .filter(([, qty]) => qty > 0)
      .map(([equipmentId, quantity]) => {
        const r = liveById.get(equipmentId) ?? rowCache.get(equipmentId);
        return { equipmentId, quantity, row: r };
      });
  }, [selected, rows, rowCache]);
  const localPriceSummary = useMemo(() => {
    const subtotal =
      previewShifts *
      selectedItems.reduce((acc, item) => {
        const rate = item.row ? Number(item.row.rentalRatePerShift) : 0;
        return acc + (Number.isFinite(rate) ? rate : 0) * item.quantity;
      }, 0);
    const clampedDiscount = Math.max(0, Math.min(100, Number(discountPercent) || 0));
    const discountAmount = (subtotal * clampedDiscount) / 100;
    const totalAfterDiscount = subtotal - discountAmount;
    return {
      subtotal,
      discountPercent: clampedDiscount,
      discountAmount,
      totalAfterDiscount,
    };
  }, [selectedItems, discountPercent, previewShifts]);

  const [quote, setQuote] = useState<QuoteResponse | null>(null);

  /** Одна смета: с сервера при наличии quote, иначе локальный черновик (только ставка×кол-во). */
  const priceSummary = useMemo(() => {
    if (quote) {
      return {
        subtotal: quote.subtotal,
        discountPercentLabel: String(quote.discountPercent).trim(),
        discountAmount: quote.discountAmount,
        totalAfterDiscount: quote.totalAfterDiscount,
        fromServer: true as const,
      };
    }
    return {
      subtotal: localPriceSummary.subtotal,
      discountPercentLabel: String(localPriceSummary.discountPercent),
      discountAmount: localPriceSummary.discountAmount,
      totalAfterDiscount: localPriceSummary.totalAfterDiscount,
      fromServer: false as const,
    };
  }, [quote, localPriceSummary]);

  const quoteLineByEquipmentId = useMemo(() => {
    if (!quote) return null;
    return new Map(quote.lines.map((l) => [l.equipmentId, l]));
  }, [quote]);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<any>(null);
  const [exportingFormat, setExportingFormat] = useState<null | "pdf" | "xlsx" | "xml">(null);

  const [timeModalOpen, setTimeModalOpen] = useState(false);
  const [draftPickupTime, setDraftPickupTime] = useState("10:00");
  const [draftReturnTime, setDraftReturnTime] = useState("10:00");

  // ── Gaffer AI request ────────────────────────────────────────────────────────
  const [gafferText, setGafferText] = useState("");
  const [gafferParsing, setGafferParsing] = useState(false);
  const [gafferError, setGafferError] = useState<string | null>(null);
  const [gafferResult, setGafferResult] = useState<GafferParseResult | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewChoices, setReviewChoices] = useState<Record<string, string>>({}); // rawPhrase -> equipmentId

  // ── Manual learning modal (for unmatched items) ───────────────────────────
  const [manualLearnOpen, setManualLearnOpen] = useState(false);
  const [manualLearnChoices, setManualLearnChoices] = useState<Record<string, string>>({}); // rawPhrase -> equipmentId
  const [manualLearnSearches, setManualLearnSearches] = useState<Record<string, string>>({}); // rawPhrase -> search text
  const [manualLearnSubmitting, setManualLearnSubmitting] = useState(false);
  const [manualLearnSaved, setManualLearnSaved] = useState(false);

  async function parseGafferRequest() {
    const text = gafferText.trim();
    if (!text) return;
    setGafferParsing(true);
    setGafferError(null);
    setGafferResult(null);
    try {
      const result = await apiFetch<GafferParseResult>("/api/bookings/parse-request", {
        method: "POST",
        body: JSON.stringify({ requestText: text, startDate: pickupISO, endDate: returnISO }),
      });
      setGafferResult(result);
      if (result.resolved.length > 0) {
        setSelected((prev) => {
          const next = { ...prev };
          for (const item of result.resolved) {
            const clamped = Math.min(item.quantity, item.availableQuantity);
            if (clamped > 0) {
              next[item.equipmentId] = (next[item.equipmentId] ?? 0) + clamped;
            }
          }
          return next;
        });
      }
      if (result.needsReview.length > 0) {
        const initial: Record<string, string> = {};
        for (const nr of result.needsReview) {
          if (nr.candidates.length > 0) initial[nr.rawPhrase] = nr.candidates[0].equipmentId;
        }
        setReviewChoices(initial);
        setReviewOpen(true);
      }
    } catch (err: any) {
      setGafferError(err?.message ?? "Ошибка при обращении к AI");
    } finally {
      setGafferParsing(false);
    }
  }

  function applyReviewChoices() {
    if (!gafferResult) return;
    setSelected((prev) => {
      const next = { ...prev };
      for (const item of gafferResult.needsReview) {
        const chosenId = reviewChoices[item.rawPhrase];
        if (!chosenId || chosenId === "__skip__") continue;
        const candidate = item.candidates.find((c) => c.equipmentId === chosenId);
        if (!candidate) continue;
        const clamped = Math.min(item.quantity, candidate.availableQuantity);
        if (clamped > 0) next[chosenId] = (next[chosenId] ?? 0) + clamped;
        apiFetch("/api/admin/slang-learning/propose", {
          method: "POST",
          body: JSON.stringify({
            rawPhrase: item.rawPhrase,
            proposedEquipmentId: chosenId,
            proposedEquipmentName: candidate.catalogName,
            confidence: candidate.confidence,
            contextJson: JSON.stringify({ source: "booking_review", text: gafferText.slice(0, 300) }),
          }),
        }).catch(() => {});
      }
      return next;
    });
    setReviewOpen(false);
  }

  async function submitManualLearning() {
    if (!gafferResult) return;
    setManualLearnSubmitting(true);
    setSelected((prev) => {
      const next = { ...prev };
      for (const item of gafferResult.unmatched) {
        const chosenId = manualLearnChoices[item.rawPhrase];
        if (!chosenId) continue;
        const row = rowCache.get(chosenId);
        if (!row) continue;
        const clamped = Math.min(item.quantity, row.available);
        if (clamped > 0) next[chosenId] = (next[chosenId] ?? 0) + clamped;
      }
      return next;
    });
    const promises = gafferResult.unmatched.map(async (item) => {
      const chosenId = manualLearnChoices[item.rawPhrase];
      if (!chosenId) return;
      const row = rowCache.get(chosenId);
      const chosenName = row ? [row.name, row.brand, row.model].filter(Boolean).join(" ") : chosenId;
      await apiFetch("/api/admin/slang-learning/propose", {
        method: "POST",
        body: JSON.stringify({
          rawPhrase: item.rawPhrase,
          proposedEquipmentId: chosenId,
          proposedEquipmentName: chosenName,
          confidence: 1.0,
          contextJson: JSON.stringify({
            source: "manual_unmatched_learning",
            text: gafferText.slice(0, 300),
            submittedAt: new Date().toISOString(),
          }),
        }),
      }).catch(() => {});
    });
    await Promise.all(promises);
    setManualLearnSubmitting(false);
    setManualLearnSaved(true);
  }

  function openTimeModal() {
    setDraftPickupTime(splitLocalDateTime(pickupLocal).time);
    setDraftReturnTime(splitLocalDateTime(returnLocal).time);
    setTimeModalOpen(true);
  }

  function applyTimeModal() {
    const pDate = splitLocalDateTime(pickupLocal).date;
    const rDate = splitLocalDateTime(returnLocal).date;
    const pt = draftPickupTime || "10:00";
    const rt = draftReturnTime || "10:00";
    let p = `${pDate}T${pt}`;
    let r = `${rDate}T${rt}`;
    const pu = new Date(p);
    const re = new Date(r);
    if (Number.isNaN(pu.getTime()) || Number.isNaN(re.getTime())) {
      setTimeModalOpen(false);
      return;
    }
    if (re.getTime() <= pu.getTime()) {
      r = addHoursToDatetimeLocal(p, 24);
    }
    setPickupLocal(p);
    setReturnLocal(r);
    setTimeModalOpen(false);
  }

  useEffect(() => {
    apiFetch<{ categories: string[] }>("/api/equipment/categories")
      .then((r) => setCategories(r.categories))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!timeModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTimeModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [timeModalOpen]);

  useEffect(() => {
    const pickup = pickupISO;
    const ret = returnISO;
    if (!pickup || !ret) return;
    const controller = new AbortController();
    let isActive = true;
    const startQ = pickup;
    const endQ = ret;
    async function load() {
      setLoadingRows(true);
      try {
        const params = new URLSearchParams({ start: startQ, end: endQ });
        if (search.trim()) params.set("search", search.trim());
        if (category) params.set("category", category);
        const data = await apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!isActive) return;
        setRows(data.rows);
      } catch (e: any) {
        const isAbort = e?.name === "AbortError" || e?.message === "signal is aborted without reason";
        if (!isAbort) {
          // eslint-disable-next-line no-console
          console.error("Failed to load availability", e);
        }
      } finally {
        if (isActive) setLoadingRows(false);
      }
    }
    load();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [pickupISO, returnISO, search, category]);

  // Обновляем кеш свежими данными когда приходит новая выборка.
  useEffect(() => {
    if (rows.length === 0) return;
    setRowCache((prev) => {
      const next = new Map(prev);
      for (const r of rows) next.set(r.equipmentId, r);
      return next;
    });
  }, [rows]);

  // When availability changes, clamp selected quantities to available.
  // Items not present in current rows (filtered out by search) are preserved unchanged.
  useEffect(() => {
    setSelected((prev) => {
      const byId = new Map(rows.map((r) => [r.equipmentId, r]));
      const next: Record<string, number> = {};
      for (const [equipmentId, qty] of Object.entries(prev)) {
        const r = byId.get(equipmentId);
        if (!r) {
          next[equipmentId] = qty;
          continue;
        }
        const clamped = Math.min(qty, r.availableQuantity);
        if (clamped > 0) next[equipmentId] = clamped;
      }
      return next;
    });
  }, [rows]);

  const selectionForQuote = useMemo(() => {
    return Object.entries(selected)
      .filter(([, qty]) => qty > 0)
      .map(([equipmentId, quantity]) => ({ equipmentId, quantity }));
  }, [selected]);

  useEffect(() => {
    // Debounced server-side quote to keep estimate consistent with backend pricing and discounts.
    if (!clientName.trim() || selectionForQuote.length === 0 || !pickupISO || !returnISO) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const timer = setTimeout(async () => {
      setLoadingQuote(true);
      try {
        const body = {
          client: {
            name: clientName.trim(),
            phone: clientPhone.trim() || null,
            email: null,
            comment: null,
          },
          projectName: projectName.trim() || "Проект",
          startDate: pickupISO,
          endDate: returnISO,
          comment: bookingComment || null,
          discountPercent: discountPercent || 0,
          items: selectionForQuote,
        };
        const data = await apiFetch<QuoteResponse>("/api/bookings/quote", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setQuote(data);
        setQuoteError(null);
      } catch (e: any) {
        setQuoteError(e?.message ?? "Ошибка расчета сметы");
        setQuote(null);
      } finally {
        setLoadingQuote(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [
    clientName,
    clientPhone,
    projectName,
    pickupISO,
    returnISO,
    bookingComment,
    discountPercent,
    selectionForQuote,
  ]);

  const statusColor = (availability: AvailabilityRow["availability"]) => {
    if (availability === "AVAILABLE") return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (availability === "PARTIAL") return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-rose-50 text-rose-700 border-rose-200";
  };

  function increaseQuantity(e: AvailabilityRow) {
    if (e.availableQuantity <= 0) return;
    setSelected((prev) => {
      const current = prev[e.equipmentId] ?? 0;
      const nextQty = Math.min(current + 1, e.availableQuantity);
      return { ...prev, [e.equipmentId]: nextQty };
    });
  }

  function decreaseQuantity(equipmentId: string) {
    setSelected((prev) => {
      const current = prev[equipmentId] ?? 0;
      const nextQty = current - 1;
      if (nextQty <= 0) {
        const next = { ...prev };
        delete next[equipmentId];
        return next;
      }
      return { ...prev, [equipmentId]: nextQty };
    });
  }

  function buildQuoteRequestBody() {
    return {
      client: {
        name: clientName.trim(),
        phone: clientPhone.trim() || null,
        email: null,
        comment: null,
      },
      projectName: projectName.trim() || "Проект",
      startDate: pickupISO as string,
      endDate: returnISO as string,
      comment: bookingComment || null,
      discountPercent: discountPercent || 0,
      expectedPaymentDate: expectedPaymentDate || null,
      items: selectionForQuote,
    };
  }

  async function exportQuote(format: "pdf" | "xlsx" | "xml") {
    if (!pickupISO || !returnISO || !clientName.trim() || selectionForQuote.length === 0) return;
    setExportingFormat(format);
    try {
      const res = await apiFetchRaw("/api/bookings/quote/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...buildQuoteRequestBody(), format }),
      });
      if (!res.ok) {
        let msg = "Не удалось сформировать файл";
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
        } catch {
          /* ignore */
        }
        alert(msg);
        return;
      }
      const blob = await res.blob();
      const ext = format === "pdf" ? "pdf" : format === "xlsx" ? "xlsx" : "xml";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("content-disposition") ?? "";
      a.download = getFileNameFromContentDisposition(disposition, `smeta.${ext}`);
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingFormat(null);
    }
  }

  async function confirmBooking() {
    if (!pickupISO || !returnISO) {
      setConfirmError("Укажите корректные дату и время погрузки (выдачи и возврата).");
      return;
    }
    try {
      setConfirmError(null);
      // 1) Draft
      const draftBody = {
        client: {
          name: clientName.trim(),
          phone: clientPhone.trim() || null,
          email: null,
          comment: null,
        },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        comment: bookingComment || null,
        discountPercent: discountPercent || 0,
        expectedPaymentDate: expectedPaymentDate || null,
        items: selectionForQuote,
      };
      const draft = await apiFetch<{ booking: any }>("/api/bookings/draft", {
        method: "POST",
        body: JSON.stringify(draftBody),
      });

      // 2) Confirm (server enforces conflicts & builds estimate snapshot).
      const confirmed = await apiFetch<{ booking: any }>(`/api/bookings/${draft.booking.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      setConfirmOpen(false);
      router.push(`/bookings/${confirmed.booking.id}`);
    } catch (e: any) {
      if (e?.status === 409) {
        setConfirmError(e.details ?? e.message);
      } else {
        setConfirmError(e?.message ?? "Ошибка подтверждения брони");
      }
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold">Создание брони</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/equipment/manage" className="text-slate-600 hover:text-slate-900">
            Редактор списка
          </Link>
          <Link href="/finance" className="text-slate-600 hover:text-slate-900">
            Финансы
          </Link>
          <Link href="/bookings" className="text-slate-600 hover:text-slate-900">
            История броней
          </Link>
          <Link href="/crew-calculator" className="text-slate-600 hover:text-slate-900">
            Калькулятор осветителей
          </Link>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8">
          <div className="rounded border border-slate-200 bg-white overflow-hidden">
            <div className="p-3 border-b border-slate-200 flex items-center justify-between flex-wrap gap-3">
              <div className="flex flex-col gap-2 min-w-0">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
                  <div className="flex flex-col min-w-0 sm:min-w-[148px] w-full sm:w-auto">
                    <label className="text-xs text-slate-600 mb-0.5">Дата выдачи</label>
                    <input
                      className="h-9 w-full sm:w-auto rounded-md border border-slate-300 px-2 bg-white text-sm"
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
                  <div className="flex flex-col min-w-0 sm:min-w-[148px] w-full sm:w-auto">
                    <label className="text-xs text-slate-600 mb-0.5">Дата возврата</label>
                    <input
                      className="h-9 w-full sm:w-auto rounded-md border border-slate-300 px-2 bg-white text-sm"
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
                  <div className="flex flex-col min-w-0 w-full sm:flex-1 sm:min-w-[220px] sm:max-w-md">
                    <label className="text-xs text-slate-600 mb-0.5">Время погрузки (выдача — возврат)</label>
                    <button
                      type="button"
                      title="Нажмите, чтобы задать время погрузки в отдельном окне"
                      className="group flex h-9 w-full items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-sm text-slate-800 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
                      onClick={openTimeModal}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-slate-100 text-slate-600 group-hover:bg-slate-200/80" aria-hidden>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 6v6l4 2" />
                        </svg>
                      </span>
                      <span className="min-w-0 flex-1 truncate tabular-nums">
                        {pickupISO && returnISO ? (
                          <span className="font-medium">
                            {new Date(pickupISO).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                            <span className="mx-1.5 font-normal text-slate-400">—</span>
                            {new Date(returnISO).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        ) : (
                          <span className="text-slate-500">Выбрать время погрузки…</span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-slate-500 group-hover:text-slate-700" aria-hidden>
                        Изменить
                      </span>
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex flex-col">
                  <label className="text-xs text-slate-600">Скидка, %</label>
                  <input
                    className="rounded border border-slate-300 px-2 py-1 bg-white w-28"
                    type="number"
                    value={discountPercent}
                    min={0}
                    max={100}
                    onChange={(e) => setDiscountPercent(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>

            <div className="p-3 border-b border-slate-200 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="flex flex-col">
                <label className="text-xs text-slate-600">Клиент</label>
                <input className="rounded border border-slate-300 px-2 py-1 bg-white" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Название компании/заказчика" />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-slate-600">Проект</label>
                <input className="rounded border border-slate-300 px-2 py-1 bg-white" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Название проекта" />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-slate-600">Телефон</label>
                <input className="rounded border border-slate-300 px-2 py-1 bg-white" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} placeholder="Телефон" />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-slate-600">Плановая дата платежа</label>
                <input
                  className="rounded border border-slate-300 px-2 py-1 bg-white"
                  type="date"
                  value={expectedPaymentDate}
                  onChange={(e) => setExpectedPaymentDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col md:col-span-3">
                <label className="text-xs text-slate-600">Комментарий</label>
                <textarea
                  className="rounded border border-slate-300 px-2 py-1.5 bg-white min-h-[44px] resize-y"
                  value={bookingComment}
                  onChange={(e) => setBookingComment(e.target.value)}
                  placeholder="Опционально"
                  rows={2}
                />
              </div>
            </div>

            {/* ── Gaffer AI request ──────────────────────────────────────────── */}
            <div className="p-3 border-b border-slate-200 bg-violet-50/40">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold text-violet-700 uppercase tracking-wide">✨ Заявка гаффера (AI)</span>
                <span className="text-xs text-slate-500">Вставьте текст заявки — AI распознает оборудование</span>
              </div>
              <textarea
                className="w-full rounded border border-violet-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-300 resize-y"
                rows={3}
                maxLength={5000}
                value={gafferText}
                onChange={(e) => setGafferText(e.target.value)}
                placeholder={"Например: 2 штуки 52xt, 3 nova p300, 4 c-stand, 1 чайнабол, 2 рамы 6x6, hazer hz350"}
              />
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <button
                  type="button"
                  className="rounded bg-violet-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  disabled={!gafferText.trim() || gafferParsing}
                  onClick={parseGafferRequest}
                >
                  {gafferParsing ? "Распознаю…" : "Распознать через AI"}
                </button>
                {gafferText && (
                  <button
                    type="button"
                    className="text-xs text-slate-500 hover:text-slate-700"
                    onClick={() => { setGafferText(""); setGafferResult(null); setGafferError(null); }}
                  >
                    Очистить
                  </button>
                )}
              </div>
              {gafferError && (
                <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {gafferError}
                </div>
              )}
              {gafferResult && !gafferParsing && (
                <div className="mt-2 space-y-1 text-xs">
                  {gafferResult.resolved.length > 0 && (
                    <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-emerald-800">
                      ✅ Добавлено автоматически: {gafferResult.resolved.map((r) => `${r.catalogName} ×${Math.min(r.quantity, r.availableQuantity)}`).join(", ")}
                    </div>
                  )}
                  {gafferResult.needsReview.length > 0 && (
                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-800 flex items-center gap-2">
                      ⚠️ {gafferResult.needsReview.length} позиц. требуют уточнения —{" "}
                      <button type="button" className="underline font-medium" onClick={() => setReviewOpen(true)}>
                        Проверить
                      </button>
                    </div>
                  )}
                  {gafferResult.unmatched.length > 0 && (
                    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600">
                      <div className="flex items-center justify-between gap-3">
                        <span>❌ Не распознано: {gafferResult.unmatched.map((u) => u.rawPhrase).join(", ")}</span>
                        <button
                          type="button"
                          className="shrink-0 rounded bg-slate-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-900 transition-colors"
                          onClick={() => { setManualLearnOpen(true); setManualLearnSaved(false); setManualLearnChoices({}); setManualLearnSearches({}); }}
                        >
                          Дообучить вручную
                        </button>
                      </div>
                      {manualLearnSaved && (
                        <div className="mt-1 text-xs text-emerald-700">✅ Сохранено в очередь обучения — ждёт подтверждения в админке</div>
                      )}
                    </div>
                  )}
                  {gafferResult.message && (
                    <div className="text-slate-500 px-1">{gafferResult.message}</div>
                  )}
                </div>
              )}
            </div>

            <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3 items-end border-b border-slate-200">
              <div className="flex flex-col">
                <label className="text-xs text-slate-600">Поиск</label>
                <input
                  className="rounded border border-slate-300 px-2 py-1 bg-white"
                  value={search}
                  placeholder="Наименование/бренд/модель..."
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="flex flex-col">
                <label className="text-xs text-slate-600">Категория</label>
                <select className="rounded border border-slate-300 px-2 py-1 bg-white" value={category ?? ""} onChange={(e) => setCategory(e.target.value || undefined)}>
                  <option value="">Все</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="overflow-auto">
              <table className="min-w-[980px] w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">Перечень оборудования</th>
                    <th className="px-3 py-2 w-[90px]">Кол-во</th>
                    <th className="px-3 py-2 w-[130px]">
                      <div>Стоимость</div>
                      <div className="text-[10px] font-normal text-slate-500 normal-case">за смену (24 ч)</div>
                    </th>
                    <th className="text-left px-3 py-2">Категория</th>
                    <th className="px-3 py-2 w-[100px]">Доступно</th>
                    <th className="px-3 py-2 w-[210px]">В бронь</th>
                    <th className="px-3 py-2 w-[170px]">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const qty = selected[r.equipmentId] ?? 0;
                    const isUnavailable = r.availableQuantity <= 0;
                    return (
                      <tr key={r.equipmentId} className="border-t border-slate-100">
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-900">{r.name}</div>
                          <div className="text-xs text-slate-500">
                            {r.brand ? r.brand : ""} {r.model ? `· ${r.model}` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 font-medium text-center">{r.totalQuantity}</td>
                        <td className="px-3 py-2 font-medium">{formatMoneyRub(r.rentalRatePerShift)}</td>
                        <td className="px-3 py-2 text-slate-700">
                          <span className={`inline-flex items-center rounded border px-2 py-1 text-xs ${getCategoryColorClass(r.category)}`}>
                            {r.category}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-medium">{r.availableQuantity}</td>
                        <td className="px-3 py-2">
                          <div className="inline-flex items-center rounded border border-slate-300 overflow-hidden">
                            <button
                              type="button"
                              className="h-9 w-9 text-lg leading-none bg-white hover:bg-slate-50 disabled:opacity-50"
                              onClick={() => decreaseQuantity(r.equipmentId)}
                              disabled={qty <= 0}
                            >
                              -
                            </button>
                            <input
                              type="text"
                              inputMode="numeric"
                              className="h-9 w-16 border-x border-slate-300 text-center bg-white"
                              value={qty}
                              onChange={(e) => {
                                const rawText = e.target.value.replace(/[^\d]/g, "");
                                const raw = Number(rawText);
                                const nextQty = Number.isFinite(raw) ? Math.max(0, Math.min(raw, r.availableQuantity)) : 0;
                                setSelected((prev) => {
                                  if (nextQty <= 0) {
                                    const next = { ...prev };
                                    delete next[r.equipmentId];
                                    return next;
                                  }
                                  return { ...prev, [r.equipmentId]: nextQty };
                                });
                              }}
                            />
                            <button
                              type="button"
                              className="h-9 w-9 text-lg leading-none bg-white hover:bg-slate-50 disabled:opacity-50"
                              onClick={() => increaseQuantity(r)}
                              disabled={isUnavailable || qty >= r.availableQuantity}
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center rounded border px-2 py-1 text-xs ${statusColor(r.availability)}`}>
                            {r.availableQuantity <= 0 ? "Недоступно" : r.availableQuantity < r.totalQuantity ? "Частично" : "Доступно"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-500" colSpan={7}>
                        Ничего не найдено
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4">
          <div className="rounded border border-slate-200 bg-white overflow-hidden sticky top-4 flex flex-col max-h-[min(calc(100vh-5rem),720px)]">
            <div className="bg-slate-100 px-3 py-2 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div className="text-sm font-semibold text-slate-800">Выбранный комплект</div>
              <div className="text-xs text-slate-500">{loadingQuote ? "Считаю…" : quote ? "Готово" : " "}</div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {selectedItems.length === 0 ? (
                <div className="p-3 text-sm text-slate-500">Выберите оборудование слева. Недоступное будет заблокировано.</div>
              ) : (
                <div className="divide-y divide-slate-200">
                  {selectedItems.map((it) => {
                    const r = it.row;
                    if (!r) return null;
                    const qLine = quoteLineByEquipmentId?.get(it.equipmentId);
                    const unit = qLine ? Number(qLine.unitPrice) : Number(r.rentalRatePerShift);
                    const lineTotal = qLine
                      ? Number(qLine.lineSum)
                      : Number.isFinite(Number(r.rentalRatePerShift))
                        ? Number(r.rentalRatePerShift) * it.quantity * previewShifts
                        : 0;
                    const modeRu =
                      qLine?.pricingMode === "TWO_SHIFTS"
                        ? "2 смены"
                        : qLine?.pricingMode === "PROJECT"
                          ? "проект"
                          : null;
                    const unitLabel = qLine
                      ? modeRu
                        ? `${formatMoneyRub(unit)} · ${modeRu}`
                        : `${formatMoneyRub(unit)}/ед.`
                      : `${formatMoneyRub(unit)}/ед.`;
                    return (
                      <div key={it.equipmentId} className="px-3 py-2.5 text-sm flex justify-between gap-3 items-start">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-slate-900 truncate">{r.name}</div>
                          <div className="text-xs text-slate-500 truncate">
                            {[r.brand, r.model].filter(Boolean).join(" · ")}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            Кол-во: {it.quantity}
                            <span className="text-slate-400"> · </span>
                            {r.category}
                            {qLine ? (
                              <>
                                <span className="text-slate-400"> · </span>
                                {qLine.pricingMode}
                              </>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex items-start gap-1 shrink-0">
                          <div className="text-right">
                            <div className="font-medium tabular-nums">{formatMoneyRub(lineTotal)}</div>
                            <div className="text-[10px] text-slate-500 tabular-nums max-w-[7rem] leading-tight">{unitLabel}</div>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 rounded p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                            aria-label="Убрать из комплекта"
                            title="Убрать из комплекта"
                            onClick={() => setSelected((prev) => {
                              const next = { ...prev };
                              delete next[it.equipmentId];
                              return next;
                            })}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M3 6h18" />
                              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                              <line x1="10" y1="11" x2="10" y2="17" />
                              <line x1="14" y1="11" x2="14" y2="17" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 shrink-0">
              <div className="bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 border-b border-slate-200">Смета</div>
              <div className="p-3 bg-slate-50 space-y-2">
                {selectedItems.length === 0 ? (
                  <div className="text-sm text-slate-600">Выберите комплект слева.</div>
                ) : (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Итого (без скидки)</span>
                      <span className="font-medium tabular-nums">{formatMoneyRub(priceSummary.subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-600">Скидка ({priceSummary.discountPercentLabel}%)</span>
                      <span className="font-medium text-slate-900 tabular-nums">-{formatMoneyRub(priceSummary.discountAmount)}</span>
                    </div>
                    <div className="flex justify-between text-base pt-1 border-t border-slate-200">
                      <span className="text-slate-900">Итого после скидки</span>
                      <span className="font-semibold tabular-nums">{formatMoneyRub(priceSummary.totalAfterDiscount)}</span>
                    </div>
                    {!clientName.trim() ? (
                      <div className="text-xs text-slate-500 pt-1">
                        Укажите имя клиента — смета пересчитается на сервере (как при подтверждении брони).
                      </div>
                    ) : priceSummary.fromServer ? (
                      <div className="text-xs text-slate-500 pt-1">Расчёт с сервера по интервалу выдачи–возврата и комплекту.</div>
                    ) : loadingQuote ? (
                      <div className="text-xs text-slate-500 pt-1">Запрос сметы…</div>
                    ) : null}
                  </>
                )}
                {quoteError ? <div className="text-xs text-rose-700 pt-1">{quoteError}</div> : null}
              </div>

              <div className="px-3 py-2.5 border-t border-slate-200 bg-white">
                <div className="text-xs font-semibold text-slate-700 mb-2">Экспорт сметы</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none"
                    disabled={
                      !pickupISO ||
                      !returnISO ||
                      !clientName.trim() ||
                      selectionForQuote.length === 0 ||
                      exportingFormat !== null
                    }
                    onClick={() => exportQuote("pdf")}
                  >
                    {exportingFormat === "pdf" ? "PDF…" : "Export PDF"}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none"
                    disabled={
                      !pickupISO ||
                      !returnISO ||
                      !clientName.trim() ||
                      selectionForQuote.length === 0 ||
                      exportingFormat !== null
                    }
                    onClick={() => exportQuote("xlsx")}
                  >
                    {exportingFormat === "xlsx" ? "Excel…" : "Export XLSX"}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 disabled:pointer-events-none"
                    disabled={
                      !pickupISO ||
                      !returnISO ||
                      !clientName.trim() ||
                      selectionForQuote.length === 0 ||
                      exportingFormat !== null
                    }
                    onClick={() => exportQuote("xml")}
                  >
                    {exportingFormat === "xml" ? "XML…" : "XML"}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 mt-2 leading-snug">
                  PDF и Excel формируются на сервере. Кириллица в PDF идёт через встроенный шрифт DejaVu в API (папка{" "}
                  <code className="text-slate-600">assets/fonts</code>).
                </p>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
                    disabled={!clientName.trim() || selectionForQuote.length === 0}
                    onClick={() => setConfirmOpen(true)}
                  >
                    Подтвердить бронь
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {timeModalOpen ? (
        <div
          className="fixed inset-0 z-[60] bg-slate-900/50 flex items-center justify-center p-4"
          role="presentation"
          onClick={() => setTimeModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="time-modal-title"
            tabIndex={-1}
            className="w-full max-w-md rounded-lg bg-white border border-slate-200 shadow-xl overflow-hidden outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <div id="time-modal-title" className="font-semibold text-slate-900">
                Время погрузки: выдача и возврат
              </div>
              <button
                type="button"
                className="text-slate-500 hover:text-slate-900 text-sm"
                onClick={() => setTimeModalOpen(false)}
              >
                Закрыть
              </button>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-xs text-slate-600">
                1 смена = 24 ч. Даты задаются в основной форме; здесь — часы и минуты времени погрузки.
              </p>
              <div className="space-y-3">
                <div>
                  <div className="text-xs text-slate-500 mb-1">
                    Выдача,{" "}
                    {splitLocalDateTime(pickupLocal).date
                      ? new Date(`${splitLocalDateTime(pickupLocal).date}T12:00:00`).toLocaleDateString("ru-RU", {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })
                      : "—"}
                  </div>
                  <input
                    type="time"
                    className="w-full rounded border border-slate-300 px-3 py-2 text-base bg-white"
                    value={draftPickupTime}
                    onChange={(e) => setDraftPickupTime(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">
                    Возврат,{" "}
                    {splitLocalDateTime(returnLocal).date
                      ? new Date(`${splitLocalDateTime(returnLocal).date}T12:00:00`).toLocaleDateString("ru-RU", {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })
                      : "—"}
                  </div>
                  <input
                    type="time"
                    className="w-full rounded border border-slate-300 px-3 py-2 text-base bg-white"
                    value={draftReturnTime}
                    onChange={(e) => setDraftReturnTime(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
                  onClick={() => setTimeModalOpen(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="rounded bg-slate-900 text-white px-4 py-2 text-sm hover:bg-slate-800"
                  onClick={applyTimeModal}
                >
                  Сохранить
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Gaffer review modal ─────────────────────────────────────────────── */}
      {reviewOpen && gafferResult && gafferResult.needsReview.length > 0 ? (
        <div className="fixed inset-0 z-[70] bg-slate-900/60 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-lg bg-white border border-slate-200 shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div className="font-semibold text-slate-900">Уточнение позиций</div>
              <button type="button" className="text-slate-500 hover:text-slate-900 text-sm" onClick={() => setReviewOpen(false)}>
                Закрыть
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-100">
              {gafferResult.needsReview.map((item) => (
                <div key={item.rawPhrase} className="p-4">
                  <div className="text-sm font-medium text-slate-800 mb-1">
                    «{item.rawPhrase}»{" "}
                    <span className="text-slate-400 font-normal">×{item.quantity}</span>
                  </div>
                  <div className="text-xs text-slate-500 mb-2">AI нашёл несколько кандидатов. Выберите нужный:</div>
                  <div className="space-y-1.5">
                    {item.candidates.map((c) => (
                      <label
                        key={c.equipmentId}
                        className={`flex items-start gap-2.5 rounded border p-2.5 cursor-pointer transition-colors ${
                          reviewChoices[item.rawPhrase] === c.equipmentId
                            ? "border-emerald-400 bg-emerald-50"
                            : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`review_${item.rawPhrase}`}
                          value={c.equipmentId}
                          checked={reviewChoices[item.rawPhrase] === c.equipmentId}
                          onChange={() => setReviewChoices((prev) => ({ ...prev, [item.rawPhrase]: c.equipmentId }))}
                          className="mt-0.5 accent-emerald-600"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-sm text-slate-900">{c.catalogName}</div>
                          <div className="text-xs text-slate-500">{c.category} · Доступно: {c.availableQuantity}</div>
                        </div>
                        <div className="text-xs text-slate-500 shrink-0">
                          {Math.round(c.confidence * 100)}%
                        </div>
                      </label>
                    ))}
                    <label
                      className={`flex items-start gap-2.5 rounded border p-2.5 cursor-pointer transition-colors ${
                        reviewChoices[item.rawPhrase] === "__skip__"
                          ? "border-slate-400 bg-slate-100"
                          : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`review_${item.rawPhrase}`}
                        value="__skip__"
                        checked={reviewChoices[item.rawPhrase] === "__skip__"}
                        onChange={() => setReviewChoices((prev) => ({ ...prev, [item.rawPhrase]: "__skip__" }))}
                        className="mt-0.5 accent-slate-500"
                      />
                      <div className="text-sm text-slate-500">Пропустить эту позицию</div>
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-slate-200 flex justify-end gap-2 shrink-0 bg-white">
              <button
                type="button"
                className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
                onClick={() => setReviewOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="rounded bg-violet-600 text-white px-4 py-2 text-sm font-medium hover:bg-violet-700"
                onClick={applyReviewChoices}
              >
                Применить выбранное
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {manualLearnOpen && gafferResult && gafferResult.unmatched.length > 0 ? (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white border border-slate-200 shadow-xl flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div>
                <div className="font-semibold text-slate-900">Дообучение вручную</div>
                <div className="text-xs text-slate-500 mt-0.5">Сопоставьте нераспознанные фразы с позициями каталога — они попадут в очередь на подтверждение</div>
              </div>
              <button type="button" className="text-slate-400 hover:text-slate-700 text-xl leading-none" onClick={() => setManualLearnOpen(false)}>✕</button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 space-y-5">
              {gafferResult.unmatched.map((item) => {
                const search = manualLearnSearches[item.rawPhrase] ?? "";
                const chosen = manualLearnChoices[item.rawPhrase];
                const allRows = Array.from(rowCache.values());
                const filtered = allRows.filter((r) => {
                  const q = search.toLowerCase();
                  return !q || r.name.toLowerCase().includes(q) || (r.brand ?? "").toLowerCase().includes(q) || (r.model ?? "").toLowerCase().includes(q) || r.category.toLowerCase().includes(q);
                }).slice(0, 30);
                return (
                  <div key={item.rawPhrase} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs bg-rose-100 text-rose-700 rounded px-2 py-0.5 font-mono">не распознано</span>
                      <span className="text-sm font-medium text-slate-900">"{item.rawPhrase}"</span>
                      {item.quantity && <span className="text-xs text-slate-500">×{item.quantity}</span>}
                    </div>
                    {chosen ? (
                      <div className="flex items-center gap-2 mb-2">
                        <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 flex-1">
                          ✓ {rowCache.get(chosen) ? [rowCache.get(chosen)!.name, rowCache.get(chosen)!.brand, rowCache.get(chosen)!.model].filter(Boolean).join(" ") : chosen}
                        </div>
                        <button type="button" className="text-xs text-slate-500 hover:text-rose-600 underline" onClick={() => setManualLearnChoices((p) => { const n = {...p}; delete n[item.rawPhrase]; return n; })}>
                          Изменить
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          placeholder="Поиск по каталогу..."
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm mb-2 bg-white"
                          value={search}
                          onChange={(e) => setManualLearnSearches((p) => ({ ...p, [item.rawPhrase]: e.target.value }))}
                        />
                        {filtered.length === 0 && search && (
                          <div className="text-xs text-slate-500 py-1">Ничего не найдено. Попробуйте другой запрос.</div>
                        )}
                        {filtered.length === 0 && !search && (
                          <div className="text-xs text-slate-400 py-1">Начните вводить название для поиска по каталогу</div>
                        )}
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {filtered.map((r) => (
                            <button
                              key={r.equipmentId}
                              type="button"
                              className="w-full text-left rounded border border-slate-200 px-2.5 py-1.5 text-xs hover:border-violet-400 hover:bg-violet-50 transition-colors"
                              onClick={() => { setManualLearnChoices((p) => ({ ...p, [item.rawPhrase]: r.equipmentId })); setManualLearnSearches((p) => ({ ...p, [item.rawPhrase]: "" })); }}
                            >
                              <div className="font-medium text-slate-900">{r.name}</div>
                              <div className="text-slate-500">{[r.brand, r.model, r.category].filter(Boolean).join(" · ")}</div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="p-4 border-t border-slate-200 flex items-center justify-between shrink-0 bg-white">
              <div className="text-xs text-slate-500">
                {Object.keys(manualLearnChoices).length} из {gafferResult.unmatched.length} сопоставлено
              </div>
              <div className="flex gap-2">
                <button type="button" className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50" onClick={() => setManualLearnOpen(false)}>
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={manualLearnSubmitting || Object.keys(manualLearnChoices).length === 0}
                  className="rounded bg-slate-800 text-white px-4 py-2 text-sm font-medium hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  onClick={async () => { await submitManualLearning(); setManualLearnOpen(false); }}
                >
                  {manualLearnSubmitting ? "Сохранение..." : "Сохранить в обучение"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl rounded bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <div className="font-semibold">Подтверждение брони</div>
              <button className="text-slate-500 hover:text-slate-900" onClick={() => setConfirmOpen(false)}>
                Закрыть
              </button>
            </div>
            <div className="p-4">
              <div className="text-sm text-slate-700">
                Клиент: <span className="font-medium">{clientName || "-"}</span> · Проект: <span className="font-medium">{projectName || "Проект"}</span>
                <br />
                Период:{" "}
                <span className="font-medium">
                  {pickupISO ? new Date(pickupISO).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}
                </span>
                {" — "}
                <span className="font-medium">
                  {returnISO ? new Date(returnISO).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}
                </span>
                {quote?.durationLabel || rentalDurationPreview?.labelShort ? (
                  <>
                    <br />
                    <span className="text-slate-600">
                      {quote?.durationLabel ?? rentalDurationPreview?.labelShort}
                    </span>
                  </>
                ) : null}
              </div>
              <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Итого (без скидки)</span>
                  <span className="font-medium">{quote ? formatMoneyRub(quote.subtotal) : "-"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Скидка ({quote ? quote.discountPercent : "0"}%)</span>
                  <span className="font-medium text-slate-900">
                    {quote ? `-${formatMoneyRub(quote.discountAmount)}` : "-"}
                  </span>
                </div>
                <div className="flex justify-between text-sm pt-1 border-t border-slate-200 mt-1">
                  <span className="text-slate-900 font-medium">Итого после скидки</span>
                  <span className="font-semibold">{quote ? formatMoneyRub(quote.totalAfterDiscount) : "-"}</span>
                </div>
              </div>

              {confirmError ? (
                <div className="mt-3 rounded border border-rose-200 bg-rose-50 text-rose-700 p-3 text-sm">
                  <div className="font-semibold">Конфликт бронирования</div>
                  <div className="mt-1">
                    {typeof confirmError === "string" ? confirmError : JSON.stringify(confirmError)}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 overflow-auto max-h-[320px]">
                <table className="min-w-full text-sm">
                  <thead className="text-slate-600 bg-slate-100">
                    <tr>
                      <th className="text-left px-3 py-2">Оборудование</th>
                      <th className="text-left px-3 py-2">Кол-во</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedItems.map((it) => (
                      <tr key={it.equipmentId} className="border-t border-slate-200">
                        <td className="px-3 py-2">
                          <div className="font-medium">{it.row?.name ?? it.equipmentId}</div>
                          <div className="text-xs text-slate-500">{it.row?.category}</div>
                        </td>
                        <td className="px-3 py-2 font-medium">{it.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="p-4 border-t border-slate-200 flex items-center justify-end gap-2">
              <button className="rounded border border-slate-300 px-4 py-2 hover:bg-slate-50" onClick={() => setConfirmOpen(false)}>
                Отмена
              </button>
              <button className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800" onClick={confirmBooking}>
                Подтвердить
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function BookingNewPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-400">Загрузка...</div>}>
      <BookingNewPage />
    </Suspense>
  );
}

