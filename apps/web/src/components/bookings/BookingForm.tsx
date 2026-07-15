"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { pluralize } from "../../lib/format";
import { toMoscowDateString, addDays } from "../../lib/moscowDate";
import { toast } from "../ToastProvider";
import {
  addHoursToDatetimeLocal,
  datetimeLocalToISO,
  defaultPickupDatetimeLocal,
  formatRentalDurationDetails,
  pickupFromSearchParam,
  returnFromSearchParam,
} from "../../lib/rentalTime";

import { ClientProjectCard } from "./create/ClientProjectCard";
import { StepsNav, type StepDef } from "./create/StepsNav";
import { DatesCard } from "./create/DatesCard";
import { EquipmentCard } from "./create/EquipmentCard";
import { TransportCard } from "./create/TransportCard";
import { CommentCard } from "./create/CommentCard";
import { DiscountCard } from "./create/DiscountCard";
import { SummaryPanel } from "./create/SummaryPanel";
import { computeTransportListClient } from "./create/transportClientCalc";
import { AddCustomItemModal } from "./create/AddCustomItemModal";
import type {
  AvailabilityRow,
  CatalogRowAdjustment,
  CatalogSelectedItem,
  CustomItem,
  GafferReviewApiResponse,
  QuoteResponse,
  ValidationCheck,
  PendingReviewItem,
  VehicleRow,
  SelectedVehicle,
  TransportBreakdown,
} from "./create/types";

// ─── BookingDetail type (shape returned by GET /api/bookings/:id) ────────────

export type BookingDetail = {
  id: string;
  displayName?: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  rejectionReason?: string | null;
  projectName: string;
  startDate: string;
  endDate: string;
  comment: string | null;
  discountPercent: string | null;
  skipPartialDay?: boolean;
  expectedPaymentDate?: string | null;
  // Transport — multi-vehicle. New bookings use `vehicles[]`; legacy single
  // columns kept for back-compat with old bookings created pre-multi-vehicle.
  vehicles?: Array<{
    vehicleId: string;
    vehicle?: { id: string; name: string; slug: string } | null;
    withGenerator: boolean;
    shiftHours: string | null;
    skipOvertime: boolean;
    kmOutsideMkad: number | null;
    ttkEntry: boolean;
    subtotalRub: string | null;
  }>;
  vehicleId?: string | null;
  vehicleWithGenerator?: boolean;
  vehicleShiftHours?: string | null;
  vehicleSkipOvertime?: boolean;
  vehicleKmOutsideMkad?: number | null;
  vehicleTtkEntry?: boolean;
  client: { id: string; name: string; phone: string | null; email?: string | null };
  items: Array<{
    id: string;
    equipmentId: string | null;
    quantity: number;
    customName: string | null;
    customUnitPrice: string | null;
    customCategory: string | null;
    equipment: {
      id: string;
      name: string;
      category: string;
      brand: string | null;
      model: string | null;
      rentalRatePerShift: string;
    } | null;
  }>;
};

// ─── Props ───────────────────────────────────────────────────────────────────

export type BookingFormProps = {
  mode: "create" | "edit";
  initialBooking?: BookingDetail;
  bookingId?: string;
};

// ─── Helper: ISO → datetime-local string ─────────────────────────────────────

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Черновик формы в localStorage (только create-режим) ─────────────────────
// Менеджер 10 минут собирает смету по телефону — случайный клик по меню/Back
// не должен терять работу. Автосейв с debounce + восстановление при повторном
// открытии /bookings/new. В edit-режиме источник истины — сервер, localStorage
// не применяется (там работает только beforeunload-гард).

const DRAFT_STORAGE_KEY = "lr:bookings:new:draft";
const DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000;

type FormDraftSnapshot = {
  savedAt: number;
  clientName: string;
  clientPhone: string;
  projectName: string;
  bookingComment: string;
  discountPercent: number;
  pickupLocal: string;
  returnLocal: string;
  skipPartialDay: boolean;
  gafferText: string;
  selected: CatalogSelectedItem[];
  customItems: CustomItem[];
  selectedVehicles: SelectedVehicle[];
  expectedPaymentDateLocal: string;
};

function readDraftSnapshot(): FormDraftSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<FormDraftSnapshot> | null;
    if (!p || typeof p !== "object" || typeof p.savedAt !== "number") return null;
    return {
      savedAt: p.savedAt,
      clientName: typeof p.clientName === "string" ? p.clientName : "",
      clientPhone: typeof p.clientPhone === "string" ? p.clientPhone : "",
      projectName: typeof p.projectName === "string" ? p.projectName : "",
      bookingComment: typeof p.bookingComment === "string" ? p.bookingComment : "",
      discountPercent: typeof p.discountPercent === "number" ? p.discountPercent : 50,
      pickupLocal: typeof p.pickupLocal === "string" ? p.pickupLocal : "",
      returnLocal: typeof p.returnLocal === "string" ? p.returnLocal : "",
      skipPartialDay: Boolean(p.skipPartialDay),
      gafferText: typeof p.gafferText === "string" ? p.gafferText : "",
      selected: Array.isArray(p.selected) ? p.selected : [],
      customItems: Array.isArray(p.customItems) ? p.customItems : [],
      selectedVehicles: Array.isArray(p.selectedVehicles) ? p.selectedVehicles : [],
      expectedPaymentDateLocal:
        typeof p.expectedPaymentDateLocal === "string" ? p.expectedPaymentDateLocal : "",
    };
  } catch {
    return null;
  }
}

function clearDraftSnapshot(): void {
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    /* localStorage недоступен — ничего не чистим */
  }
}

function formatDraftTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Источник, из которого открыта модалка произвольной позиции (для cleanup). */
type CustomPrefillSource =
  | { kind: "unmatched"; phrase: string }
  | { kind: "review"; reviewId: string }
  | null;

type CustomModalPrefill = {
  name: string;
  quantity: number;
  source: CustomPrefillSource;
};

type BookingFormInnerProps = BookingFormProps & {
  /** «Начать заново» из плашки восстановления — ремаунт формы с дефолтами. */
  onResetForm?: () => void;
};

// ─── Inner component (uses useSearchParams, must be wrapped in Suspense) ─────

function BookingFormInner({ mode, initialBooking, bookingId, onResetForm }: BookingFormInnerProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const { user } = useCurrentUser();

  const isEdit = mode === "edit";
  // SUPER_ADMIN сам себе одобряющий: даём прямой путь «создать и подтвердить»
  // (черновик → на согласование → одобрить одной цепочкой), чтобы не гонять
  // руководителя на страницу брони ради лишнего клика «Одобрить».
  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  // ── Search params (only used in create mode) ──
  const startParam = isEdit ? null : sp.get("start");
  const endParam = isEdit ? null : sp.get("end");
  // Контракт с календарём: ?start=&end=&equipmentId= — префилл дат + позиция.
  const equipmentIdParam = isEdit ? null : sp.get("equipmentId");

  // ── Восстановление черновика (create; URL-префилл из календаря приоритетнее) ──
  // Если пришли по ссылке из календаря, а в localStorage лежит чужой черновик —
  // НЕ восстанавливаем его, но и не даём автосейву затереть/удалить: иначе
  // просто открытие ссылки уничтожало сохранённую работу без действий юзера.
  const preservedForeignDraftRef = useRef(false);
  const [draft] = useState<FormDraftSnapshot | null>(() => {
    if (isEdit) return null;
    if (startParam || endParam || equipmentIdParam) {
      if (readDraftSnapshot()) preservedForeignDraftRef.current = true;
      return null;
    }
    return readDraftSnapshot();
  });
  const [draftBannerVisible, setDraftBannerVisible] = useState(Boolean(draft));
  // После успешного сохранения / «Начать заново» автосейв выключается,
  // чтобы отложенный debounce-таймер не записал черновик обратно.
  const draftPersistDisabledRef = useRef(false);

  // ── Client / project ──
  const [clientName, setClientName] = useState(
    isEdit ? (initialBooking?.client.name ?? "") : (draft?.clientName ?? ""),
  );
  // Телефон нового клиента (create): показывается, когда автокомплит понимает,
  // что клиент будет создан на лету. Backend: новому клиенту записывается,
  // существующему без телефона — дозаполняется, существующий не перетирается.
  const [clientPhone, setClientPhone] = useState(draft?.clientPhone ?? "");
  const [isNewClient, setIsNewClient] = useState(false);
  const [projectName, setProjectName] = useState(
    isEdit ? (initialBooking?.projectName ?? "") : (draft?.projectName ?? ""),
  );
  const [bookingComment, setBookingComment] = useState(
    isEdit ? (initialBooking?.comment ?? "") : (draft?.bookingComment ?? ""),
  );
  const [discountPercent, setDiscountPercent] = useState(
    isEdit ? Number(initialBooking?.discountPercent ?? "0") : (draft?.discountPercent ?? 50),
  );

  // ── Dates ──
  const [pickupLocal, setPickupLocal] = useState(() => {
    if (isEdit && initialBooking) return isoToDatetimeLocal(initialBooking.startDate);
    if (draft?.pickupLocal) return draft.pickupLocal;
    return pickupFromSearchParam(startParam, defaultPickupDatetimeLocal());
  });
  const [returnLocal, setReturnLocal] = useState(() => {
    if (isEdit && initialBooking) return isoToDatetimeLocal(initialBooking.endDate);
    if (draft?.returnLocal) return draft.returnLocal;
    return returnFromSearchParam(endParam, pickupFromSearchParam(startParam, defaultPickupDatetimeLocal()));
  });
  // «Не считать вторые сутки» — прощать хвост ≤ 4 ч сверх целых суток.
  const [skipPartialDay, setSkipPartialDay] = useState<boolean>(
    isEdit && initialBooking ? Boolean(initialBooking.skipPartialDay) : (draft?.skipPartialDay ?? false),
  );
  // Отслеживаем смену именно этого флага, чтобы пересчитать смету мгновенно
  // (без debounce) при клике по чекбоксу.
  const prevSkipPartialRef = useRef(skipPartialDay);
  // Возврат тронут вручную → не перетираем авто-+24ч на смене выдачи.
  // create: старт false (первый выбор выдачи ставит +24ч; если возврат уже
  // введён вручную и валиден — сохраняется, иначе чинится +24ч). edit: старт
  // true (сохранённый возврат брони не трогаем при правке выдачи). Черновик
  // из localStorage — тоже «трогали руками», не перетираем.
  const returnTouchedRef = useRef(isEdit || Boolean(draft));

  const pickupISO = useMemo(() => datetimeLocalToISO(pickupLocal), [pickupLocal]);
  const returnISO = useMemo(() => datetimeLocalToISO(returnLocal), [returnLocal]);

  // Возврат раньше (или в момент) выдачи — inline-ошибка у полей дат.
  // При невалидном диапазоне запросы каталога/сметы не отправляются: раньше
  // сервер отвечал 400, catch чистил каталог и показывал ложный toast
  // «Не удалось загрузить каталог. Обновите страницу».
  const dateOrderInvalid = Boolean(
    pickupISO && returnISO && new Date(returnISO).getTime() <= new Date(pickupISO).getTime(),
  );

  const rentalDuration = useMemo(() => {
    if (!pickupISO || !returnISO) return null;
    const s = new Date(pickupISO);
    const e = new Date(returnISO);
    if (e.getTime() <= s.getTime()) return null;
    return formatRentalDurationDetails(s, e, skipPartialDay);
  }, [pickupISO, returnISO, skipPartialDay]);

  const shifts = rentalDuration?.shifts ?? 1;
  const durationTag = rentalDuration ? `${shifts} ${pluralize(shifts, "день", "дня", "дней")}` : null;
  const durationDetail = rentalDuration?.labelShort ?? null;

  // ── Catalog-first state ──
  const [catalog, setCatalog] = useState<AvailabilityRow[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Build initial selected map from booking items when editing (catalog items
  // only), or from the restored localStorage draft in create mode.
  const [selected, setSelected] = useState<Map<string, CatalogSelectedItem>>(() => {
    if (!isEdit && draft) {
      // availableQuantity/dailyPrice обновятся при первой загрузке каталога.
      return new Map(draft.selected.map((s) => [s.equipmentId, s]));
    }
    if (!isEdit || !initialBooking) return new Map();
    const m = new Map<string, CatalogSelectedItem>();
    for (const it of initialBooking.items) {
      if (it.equipmentId == null) continue; // skip custom items
      if (!it.equipment) continue;
      m.set(it.equipmentId, {
        equipmentId: it.equipmentId,
        name: it.equipment.name,
        category: it.equipment.category,
        quantity: it.quantity,
        dailyPrice: it.equipment.rentalRatePerShift,
        availableQuantity: 9999, // Will be updated when catalog loads
      });
    }
    return m;
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const [adjustments, setAdjustments] = useState<Map<string, CatalogRowAdjustment>>(new Map());

  // Custom (non-catalog) items — initialized from booking items without equipmentId
  const [customItems, setCustomItems] = useState<CustomItem[]>(() => {
    if (!isEdit) return draft?.customItems ?? [];
    if (!initialBooking) return [];
    return initialBooking.items
      .filter((it) => it.equipmentId == null)
      .map((it) => ({
        tempId: `custom-${it.id}`,
        name: it.customName ?? "",
        unitPrice: Number(it.customUnitPrice ?? 0),
        quantity: it.quantity,
      }));
  });
  const [customModalOpen, setCustomModalOpen] = useState(false);
  // Префилл модалки произвольной позиции — когда она открыта из AI-«не
  // распознано» или review-панели («Вне каталога»). Такие позиции теперь
  // становятся НАСТОЯЩИМИ custom-позициями сметы (customName + customUnitPrice),
  // а не текстом в комментарии брони.
  const [customModalPrefill, setCustomModalPrefill] = useState<CustomModalPrefill | null>(null);

  // Search + tabs
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");

  // AI flow (always starts at defaults — no AI state carries over in edit mode)
  const [gafferText, setGafferText] = useState(isEdit ? "" : (draft?.gafferText ?? ""));
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(false);
  const [parseResolved, setParseResolved] = useState(0);
  const [parseTotal, setParseTotal] = useState(0);
  const [unmatchedFromAi, setUnmatchedFromAi] = useState<string[]>([]);
  const [successBannerDismissed, setSuccessBannerDismissed] = useState(false);

  // Review panel
  const [pendingReview, setPendingReview] = useState<PendingReviewItem[]>([]);

  // Quote
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  // true, когда серверный пересчёт /quote упал — панель показывает
  // предварительный локальный расчёт, а не выдаёт его за авторитетный.
  const [quoteError, setQuoteError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Была попытка сохранить с невыполненными требованиями → todo-подсказки
  // становятся rose-ошибками, невалидный шаг подсвечивается в рейке.
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Transport — multi-vehicle. Init from initialBooking.vehicles[] if present,
  // else from legacy single vehicle* columns (back-compat with old bookings).
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [selectedVehicles, setSelectedVehicles] = useState<SelectedVehicle[]>(() => {
    if (!isEdit) return draft?.selectedVehicles ?? [];
    if (!initialBooking) return [];
    if (initialBooking.vehicles && initialBooking.vehicles.length > 0) {
      return initialBooking.vehicles.map((v) => ({
        vehicleId: v.vehicleId,
        withGenerator: v.withGenerator,
        shiftHours: v.shiftHours ? Math.ceil(Number(v.shiftHours)) : 12,
        skipOvertime: v.skipOvertime,
        kmOutsideMkad: v.kmOutsideMkad ?? 0,
        ttkEntry: v.ttkEntry,
      }));
    }
    if (initialBooking.vehicleId) {
      return [
        {
          vehicleId: initialBooking.vehicleId,
          withGenerator: initialBooking.vehicleWithGenerator ?? false,
          shiftHours: initialBooking.vehicleShiftHours
            ? Math.ceil(Number(initialBooking.vehicleShiftHours))
            : 12,
          skipOvertime: initialBooking.vehicleSkipOvertime ?? false,
          kmOutsideMkad: initialBooking.vehicleKmOutsideMkad ?? 0,
          ttkEntry: initialBooking.vehicleTtkEntry ?? false,
        },
      ];
    }
    return [];
  });

  // ── expectedPaymentDate — пользовательское значение (опционально) ──
  // Пустая строка = использовать default из настроек организации
  const [expectedPaymentDateLocal, setExpectedPaymentDateLocal] = useState<string>(() => {
    if (isEdit && initialBooking?.expectedPaymentDate) {
      // F1: use toMoscowDateString to avoid 1-day backward drift on edit-save cycles
      return toMoscowDateString(new Date(initialBooking.expectedPaymentDate));
    }
    if (!isEdit && draft?.expectedPaymentDateLocal) return draft.expectedPaymentDateLocal;
    return "";
  });

  // F3: fetch org settings for dynamic placeholder
  const [defaultPaymentTermsDays, setDefaultPaymentTermsDays] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ defaultPaymentTermsDays?: number }>("/api/settings/organization")
      .then((res) => { if (!cancelled) setDefaultPaymentTermsDays(res.defaultPaymentTermsDays ?? 0); })
      .catch(() => { if (!cancelled) setDefaultPaymentTermsDays(0); });
    return () => { cancelled = true; };
  }, []);

  // ── Vehicles fetch (once on mount) ──
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ vehicles: VehicleRow[] }>("/api/vehicles")
      .then((res) => { if (!cancelled) setVehicles(res.vehicles); })
      .catch(() => { if (!cancelled) setVehicles([]); });
    return () => { cancelled = true; };
  }, []);

  // ── Автосейв черновика в localStorage (create, debounce 2 с) ──
  useEffect(() => {
    if (isEdit) return;
    // Префилл из календаря при существующем чужом черновике: автосейв выключен
    // на весь этот заход, чтобы не перезаписать сохранённую работу.
    if (preservedForeignDraftRef.current) return;
    const timer = setTimeout(() => {
      if (draftPersistDisabledRef.current) return;
      const meaningful =
        clientName.trim().length > 0 ||
        selected.size > 0 ||
        customItems.length > 0 ||
        bookingComment.trim().length > 0 ||
        gafferText.trim().length > 0 ||
        selectedVehicles.length > 0;
      try {
        if (!meaningful) {
          window.localStorage.removeItem(DRAFT_STORAGE_KEY);
          return;
        }
        const snapshot: FormDraftSnapshot = {
          savedAt: Date.now(),
          clientName,
          clientPhone,
          projectName,
          bookingComment,
          discountPercent,
          pickupLocal,
          returnLocal,
          skipPartialDay,
          gafferText,
          selected: Array.from(selected.values()),
          customItems,
          selectedVehicles,
          expectedPaymentDateLocal,
        };
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        /* localStorage может быть недоступен (private mode / quota) — форму не роняем */
      }
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    isEdit,
    clientName,
    clientPhone,
    projectName,
    bookingComment,
    discountPercent,
    pickupLocal,
    returnLocal,
    skipPartialDay,
    gafferText,
    selected,
    customItems,
    selectedVehicles,
    expectedPaymentDateLocal,
  ]);

  // ── beforeunload-гард: не терять несохранённый ввод при закрытии вкладки ──
  // create: гард при непустой форме. edit: гард только когда есть реальные
  // отличия от загруженной брони (подпись пользовательского ввода).
  const formSignature = useMemo(
    () =>
      JSON.stringify({
        clientName,
        projectName,
        bookingComment,
        discountPercent,
        pickupLocal,
        returnLocal,
        skipPartialDay,
        expectedPaymentDateLocal,
        // Только id+кол-во: цены/доступность обновляет загрузка каталога,
        // это не пользовательский ввод.
        items: Array.from(selected.values()).map((s) => [s.equipmentId, s.quantity]),
        customItems: customItems.map((c) => [c.name, c.unitPrice, c.quantity]),
        vehicles: selectedVehicles,
      }),
    [
      clientName,
      projectName,
      bookingComment,
      discountPercent,
      pickupLocal,
      returnLocal,
      skipPartialDay,
      expectedPaymentDateLocal,
      selected,
      customItems,
      selectedVehicles,
    ],
  );
  const initialSignatureRef = useRef<string | null>(null);
  if (initialSignatureRef.current === null) initialSignatureRef.current = formSignature;

  const hasMeaningfulInput =
    clientName.trim().length > 0 ||
    selected.size > 0 ||
    customItems.length > 0 ||
    bookingComment.trim().length > 0 ||
    gafferText.trim().length > 0 ||
    selectedVehicles.length > 0;
  const shouldGuardUnload = isEdit
    ? formSignature !== initialSignatureRef.current
    : hasMeaningfulInput;

  useEffect(() => {
    if (!shouldGuardUnload) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [shouldGuardUnload]);

  // ?equipmentId= из календаря применяется один раз после первой загрузки каталога.
  const urlEquipmentAppliedRef = useRef(false);

  // ── Catalog fetch (on dates change) ──
  useEffect(() => {
    if (!pickupISO || !returnISO || dateOrderInvalid) return;
    let cancelled = false;
    setCatalogLoading(true);
    const params = new URLSearchParams({ start: pickupISO, end: returnISO });
    // In edit mode, exclude current booking from availability calculation
    if (isEdit && bookingId) params.set("excludeBookingId", bookingId);
    apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.rows);
        const newAdj = new Map<string, CatalogRowAdjustment>();
        const newSelectedEntries: Array<[string, CatalogSelectedItem]> = [];
        const toDelete: string[] = [];
        for (const [id, sel] of selectedRef.current) {
          const latest = res.rows.find((r) => r.equipmentId === id);
          if (!latest) {
            toDelete.push(id);
            continue;
          }
          const newAvail = Math.max(0, latest.availableQuantity);
          if (newAvail === 0) {
            newSelectedEntries.push([id, { ...sel, availableQuantity: 0, dailyPrice: latest.rentalRatePerShift }]);
            newAdj.set(id, { kind: "unavailable" });
          } else if (newAvail < sel.quantity) {
            newSelectedEntries.push([id, { ...sel, quantity: newAvail, availableQuantity: newAvail, dailyPrice: latest.rentalRatePerShift }]);
            newAdj.set(id, { kind: "clampedDown", previousQty: sel.quantity, newQty: newAvail });
          } else {
            newSelectedEntries.push([id, { ...sel, availableQuantity: newAvail, dailyPrice: latest.rentalRatePerShift }]);
          }
        }
        setSelected((prev) => {
          const next = new Map(prev);
          for (const id of toDelete) next.delete(id);
          for (const [id, v] of newSelectedEntries) next.set(id, v);
          return next;
        });
        setAdjustments(newAdj);
        // Контракт с календарём: ?equipmentId= — добавляем позицию (qty 1)
        // после первой загрузки каталога. Одноразово.
        if (equipmentIdParam && !urlEquipmentAppliedRef.current) {
          urlEquipmentAppliedRef.current = true;
          const row = res.rows.find((r) => r.equipmentId === equipmentIdParam);
          if (!row) {
            toast.error("Оборудование из ссылки не найдено в каталоге");
          } else if (row.availableQuantity <= 0) {
            toast.error(`«${row.name}» недоступно на выбранные даты`);
          } else {
            setSelected((prev) => {
              if (prev.has(row.equipmentId)) return prev;
              const next = new Map(prev);
              next.set(row.equipmentId, {
                equipmentId: row.equipmentId,
                name: row.name,
                category: row.category,
                quantity: 1,
                dailyPrice: row.rentalRatePerShift,
                availableQuantity: row.availableQuantity,
              });
              return next;
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog([]);
          // Раньше пустой каталог при сбое выглядел как «нет оборудования».
          toast.error("Не удалось загрузить каталог оборудования. Обновите страницу.");
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [pickupISO, returnISO, dateOrderInvalid, isEdit, bookingId, equipmentIdParam]);

  // ── Derived ──
  const apiItems = useMemo(
    () => Array.from(selected.values()).map((s) => ({ equipmentId: s.equipmentId, quantity: s.quantity })),
    [selected],
  );

  const localSubtotal = useMemo(() => {
    let sum = 0;
    for (const s of selected.values()) sum += Number(s.dailyPrice) * s.quantity * shifts;
    for (const c of customItems) sum += c.unitPrice * c.quantity;
    return sum;
  }, [selected, shifts, customItems]);

  const clampedDiscount = Math.max(0, Math.min(100, discountPercent || 0));
  const localDiscount = (localSubtotal * clampedDiscount) / 100;
  const localTotal = localSubtotal - localDiscount;

  // ── Требования к сохранению (для чеклиста, шагов и валидации по клику) ──
  const clientOk = clientName.trim().length > 0;
  const datesOk = Boolean(pickupISO && returnISO) && !dateOrderInvalid;
  const hasItems = selected.size > 0 || customItems.length > 0;
  const formValid = clientOk && datesOk && hasItems;

  const checks = useMemo<ValidationCheck[]>(() => {
    const list: ValidationCheck[] = [];
    // Невыполненные требования — постоянный чеклист рядом с кнопками (вместо
    // молча задизейбленной кнопки). После попытки сохранить — rose-ошибки.
    const reqType = submitAttempted ? ("error" as const) : ("todo" as const);
    if (!clientOk) {
      list.push({ type: reqType, label: "Укажите клиента", detail: "шаг 1 — имя обязательно" });
    }
    if (dateOrderInvalid) {
      // Текст намеренно НЕ дублирует inline-ошибку DatesCard («Возврат раньше
      // выдачи…») — тест ищет её через findByText и должен найти ровно одну.
      list.push({ type: "error", label: "Исправьте даты", detail: "шаг 2 — возврат раньше выдачи" });
    } else if (!datesOk) {
      list.push({ type: reqType, label: "Укажите даты", detail: "шаг 2 — выдача и возврат" });
    }
    if (!hasItems) {
      list.push({ type: reqType, label: "Добавьте оборудование", detail: "шаг 3 — каталог, AI-заявка или произвольная позиция" });
    }
    if (selected.size > 0 && customItems.length === 0 && unmatchedFromAi.length === 0) {
      list.push({ type: "ok", label: "Все позиции распознаны", detail: "" });
    }
    if (unmatchedFromAi.length > 0) {
      list.push({ type: "warn", label: `${unmatchedFromAi.length} не распознано`, detail: "добавьте с ценой или проигнорируйте" });
    }
    if (customItems.length > 0) {
      list.push({ type: "tip", label: `${customItems.length} ${pluralize(customItems.length, "произвольная позиция", "произвольные позиции", "произвольных позиций")}`, detail: "услуги, расходники, субаренда" });
    }
    return list;
  }, [selected, customItems, unmatchedFromAi, clientOk, datesOk, dateOrderInvalid, hasItems, submitAttempted]);

  // Кнопки больше не гасятся молча при незаполненной форме: клик по ним
  // запускает inline-валидацию (validateForSubmit) со скроллом к проблемному
  // шагу. Блокируется только сам процесс сохранения.
  const canSubmit = !submitting;

  // ── Шаги: рейка-навигация + статусы (см. StepsNav) ──
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  function scrollToStep(id: string) {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const detailsFilled = bookingComment.trim().length > 0 || expectedPaymentDateLocal.length > 0;
  const steps: StepDef[] = [
    {
      id: "step-client",
      label: "Клиент и проект",
      state: clientOk ? "complete" : submitAttempted ? "error" : "idle",
    },
    {
      id: "step-dates",
      label: "Даты",
      state: dateOrderInvalid ? "error" : datesOk ? "complete" : submitAttempted ? "error" : "idle",
    },
    {
      id: "step-equipment",
      label: "Оборудование",
      state: hasItems ? "complete" : submitAttempted ? "error" : "idle",
    },
    {
      id: "step-details",
      label: "Детали",
      state: detailsFilled ? "complete" : "idle",
      optional: true,
    },
  ];

  // Валидация по клику на кнопку сохранения: вместо toast — подсветка шага,
  // inline-ошибка у поля и автоскролл к первому невалидному шагу.
  function validateForSubmit(): boolean {
    if (formValid) return true;
    setSubmitAttempted(true);
    if (!clientOk) scrollToStep("step-client");
    else if (!datesOk) scrollToStep("step-dates");
    else scrollToStep("step-equipment");
    return false;
  }

  function handleToggleVehicle(vehicleId: string, checked: boolean) {
    setSelectedVehicles((prev) => {
      if (checked) {
        if (prev.some((s) => s.vehicleId === vehicleId)) return prev;
        // Дефолт «Часы смены» = стандартная смена машины (без переработки).
        // Раньше подставлялась вся длительность аренды (72 ч для 3 суток) —
        // транспорт молча дорожал в разы за счёт «переработки».
        const standardShiftHours =
          vehicles.find((v) => v.id === vehicleId)?.shiftHours ?? 12;
        return [
          ...prev,
          {
            vehicleId,
            withGenerator: false,
            shiftHours: Math.max(1, standardShiftHours),
            skipOvertime: false,
            kmOutsideMkad: 0,
            ttkEntry: false,
          },
        ];
      }
      return prev.filter((s) => s.vehicleId !== vehicleId);
    });
  }

  function handlePatchVehicle(vehicleId: string, patch: Partial<SelectedVehicle>) {
    setSelectedVehicles((prev) =>
      prev.map((s) => (s.vehicleId === vehicleId ? { ...s, ...patch } : s)),
    );
  }

  // Stable key so the quote effect only refires when transport actually changes.
  const transportKey = useMemo(
    () => JSON.stringify(selectedVehicles),
    [selectedVehicles],
  );

  // Payload for quote/draft/export: array of per-vehicle configs, or null.
  const transportPayload = useMemo<SelectedVehicle[] | null>(
    () => (selectedVehicles.length > 0 ? selectedVehicles : null),
    // transportKey captures deep changes; selectedVehicles ref is enough here
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transportKey],
  );

  // Local per-vehicle breakdowns + subtotal (instant feedback before quote).
  const localTransport = useMemo(() => {
    if (selectedVehicles.length === 0) return null;
    return computeTransportListClient(selectedVehicles, vehicles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportKey, vehicles]);

  // breakdownByVehicleId: prefer server quote, fall back to local calc.
  const breakdownByVehicleId = useMemo<Record<string, TransportBreakdown>>(() => {
    const map: Record<string, TransportBreakdown> = {};
    const source = quote?.transport ?? localTransport?.breakdowns ?? [];
    for (const b of source) map[b.vehicleId] = b;
    return map;
  }, [quote, localTransport]);

  // ── Debounced quote ──
  useEffect(() => {
    const hasSomething = apiItems.length > 0 || customItems.length > 0 || transportPayload !== null;
    if (!clientName.trim() || !hasSomething || !pickupISO || !returnISO || dateOrderInvalid) {
      setQuote(null);
      setQuoteError(false);
      return;
    }
    let cancelled = false;
    // Тоггл чекбокса «не считать вторые сутки» — дискретное действие:
    // пересчитываем смету мгновенно (без debounce). Печать (скидка, qty
    // и т.п.) по-прежнему debounce 500 мс, чтобы не спамить /quote.
    const skipChanged = prevSkipPartialRef.current !== skipPartialDay;
    prevSkipPartialRef.current = skipPartialDay;
    const debounceMs = skipChanged ? 0 : 500;
    const timer = setTimeout(async () => {
      setLoadingQuote(true);
      try {
        const items = [
          ...apiItems,
          ...customItems.map((c) => ({
            customName: c.name,
            customUnitPrice: c.unitPrice,
            quantity: c.quantity,
          })),
        ];
        const body = {
          client: { name: clientName.trim() },
          projectName: projectName.trim() || "Проект",
          startDate: pickupISO,
          endDate: returnISO,
          discountPercent: Math.min(100, Math.max(0, discountPercent || 0)),
          skipPartialDay,
          items,
          transport: transportPayload,
        };
        const data = await apiFetch<QuoteResponse>("/api/bookings/quote", { method: "POST", body: JSON.stringify(body) });
        if (!cancelled) {
          setQuote(data);
          setQuoteError(false);
        }
      } catch {
        if (!cancelled) {
          setQuote(null);
          setQuoteError(true);
        }
      } finally {
        if (!cancelled) setLoadingQuote(false);
      }
    }, debounceMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clientName, projectName, pickupISO, returnISO, dateOrderInvalid, discountPercent, skipPartialDay, apiItems, customItems, transportPayload]);

  // ── Date handlers ──
  function handlePickupChange(v: string) {
    setPickupLocal(v);
    setReturnLocal((prev) => {
      const pu = new Date(v);
      if (Number.isNaN(pu.getTime())) return prev;
      // По умолчанию бронь 24-часовая: возврат = выдача + 24 ч.
      // Если пользователь уже правил возврат вручную — не перетираем,
      // но всё равно не даём возврату оказаться раньше выдачи.
      if (!returnTouchedRef.current) return addHoursToDatetimeLocal(v, 24);
      const re = new Date(prev);
      if (Number.isNaN(re.getTime()) || re.getTime() <= pu.getTime()) {
        return addHoursToDatetimeLocal(v, 24);
      }
      return prev;
    });
  }

  function handleReturnChange(v: string) {
    returnTouchedRef.current = true;
    setReturnLocal(v);
  }

  // ── Catalog selection handlers ──
  function handleAdd(row: AvailabilityRow) {
    if (row.availableQuantity <= 0) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const existing = next.get(row.equipmentId);
      if (existing) {
        if (existing.quantity >= existing.availableQuantity) return prev;
        next.set(row.equipmentId, { ...existing, quantity: existing.quantity + 1 });
      } else {
        next.set(row.equipmentId, {
          equipmentId: row.equipmentId,
          name: row.name,
          category: row.category,
          quantity: 1,
          dailyPrice: row.rentalRatePerShift,
          availableQuantity: row.availableQuantity,
        });
      }
      return next;
    });
  }

  function clearAdjustment(equipmentId: string) {
    setAdjustments((prev) => {
      if (!prev.has(equipmentId)) return prev;
      const next = new Map(prev);
      next.delete(equipmentId);
      return next;
    });
  }

  function handleChangeQty(equipmentId: string, newQty: number) {
    clearAdjustment(equipmentId);
    setSelected((prev) => {
      const next = new Map(prev);
      const existing = next.get(equipmentId);
      if (!existing) return prev;
      const clamped = Math.max(0, Math.min(newQty, existing.availableQuantity));
      if (clamped === 0) {
        next.delete(equipmentId);
      } else {
        next.set(equipmentId, { ...existing, quantity: clamped });
      }
      return next;
    });
  }

  function handleRemove(equipmentId: string) {
    clearAdjustment(equipmentId);
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(equipmentId);
      return next;
    });
  }

  // ── Custom item handlers ──
  function handleAddCustom(payload: { name: string; unitPrice: number; quantity: number }) {
    const tempId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCustomItems((prev) => [...prev, { tempId, ...payload }]);
    // Модалка была открыта из AI-потока — убираем исходную строку из очереди.
    const source = customModalPrefill?.source;
    if (source?.kind === "unmatched") {
      setUnmatchedFromAi((prev) => prev.filter((p) => p !== source.phrase));
    } else if (source?.kind === "review") {
      setPendingReview((prev) => prev.filter((p) => p.reviewId !== source.reviewId));
    }
    setCustomModalPrefill(null);
  }

  function handleChangeCustomQty(tempId: string, qty: number) {
    setCustomItems((prev) =>
      prev.map((it) => (it.tempId === tempId ? { ...it, quantity: Math.max(1, qty) } : it)),
    );
  }

  function handleRemoveCustom(tempId: string) {
    setCustomItems((prev) => prev.filter((it) => it.tempId !== tempId));
  }

  // ── AI handlers ──
  async function handleParse() {
    // Без дат AI-парсинг не запускаем — startDate/endDate нужны для расчёта
    // числа смен и матчинга по доступности. Раньше тут был silent return,
    // и пользователь жал «Распознать» без эффекта, думая что AI сломан.
    // Теперь показываем понятный toast + скроллим к полю дат.
    if (!pickupISO || !returnISO) {
      toast.error("Сначала укажите даты съёмки — выдача и возврат");
      if (typeof document !== "undefined") {
        // Поля дат — раздельные input[type=date] + input[type=time]; целимся
        // в первый date-инпут (раньше селектор искал #booking-pickup-datetime /
        // datetime-local, которых на странице нет — скролл не срабатывал).
        const el = document.querySelector('input[type="date"]');
        if (el) {
          (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
          (el as HTMLInputElement).focus?.();
        }
      }
      return;
    }
    if (dateOrderInvalid) {
      toast.error("Возврат раньше выдачи — исправьте даты и повторите распознавание");
      return;
    }
    if (!gafferText.trim()) {
      toast.error("Поле заявки пустое — вставьте текст от гафера");
      return;
    }
    setParsing(true);
    try {
      const res = await apiFetch<GafferReviewApiResponse>("/api/bookings/parse-gaffer-review", {
        method: "POST",
        body: JSON.stringify({ requestText: gafferText.trim(), startDate: pickupISO, endDate: returnISO }),
      });
      const reviewItems: PendingReviewItem[] = res.items.map((it) => ({
        reviewId: it.id,
        gafferPhrase: it.gafferPhrase,
        interpretedName: it.interpretedName,
        quantity: it.quantity,
        match: it.match,
      }));
      setPendingReview(reviewItems);
      setGafferText("");
      setSearchQuery("");
      setParsed(false);
      setParseResolved(0);
      setParseTotal(0);
      setUnmatchedFromAi([]);
      setSuccessBannerDismissed(true);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Ошибка AI");
    } finally {
      setParsing(false);
    }
  }

  function handleClear() {
    setGafferText("");
    setSearchQuery("");
    setParsed(false);
    setUnmatchedFromAi([]);
    setParseResolved(0);
    setParseTotal(0);
    setSuccessBannerDismissed(false);
  }

  function handleDismissSuccess() { setSuccessBannerDismissed(true); }
  function handleIgnoreUnmatched() { setUnmatchedFromAi([]); }

  function handleAddOffCatalog(phrase: string) {
    // «Вне каталога» = настоящая произвольная позиция с ценой: открываем
    // модалку с префиллом. Строка уходит из «не распознано» только после
    // подтверждения (отмена модалки ничего не теряет).
    setCustomModalPrefill({
      name: phrase,
      quantity: 1,
      source: { kind: "unmatched", phrase },
    });
    setCustomModalOpen(true);
  }

  // ── Review panel handlers ──
  function handleReviewConfirm(
    reviewId: string,
    equipment: {
      equipmentId: string;
      name: string;
      category: string;
      rentalRatePerShift: string;
      availableQuantity: number;
    },
    quantity: number,
  ) {
    const item = pendingReview.find((p) => p.reviewId === reviewId);
    if (!item) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const clamped = Math.max(1, Math.min(quantity, equipment.availableQuantity));
      next.set(equipment.equipmentId, {
        equipmentId: equipment.equipmentId,
        name: equipment.name,
        category: equipment.category,
        quantity: clamped,
        dailyPrice: equipment.rentalRatePerShift,
        availableQuantity: equipment.availableQuantity,
      });
      return next;
    });
    apiFetch("/api/admin/slang-learning/propose", {
      method: "POST",
      body: JSON.stringify({
        rawPhrase: item.gafferPhrase || item.interpretedName,
        proposedEquipmentId: equipment.equipmentId,
        proposedEquipmentName: equipment.name,
        confidence: 0.95,
        contextJson: JSON.stringify({ source: "booking_review", reviewId }),
      }),
    }).catch(() => { /* non-blocking */ });
    setPendingReview((prev) => prev.filter((p) => p.reviewId !== reviewId));
  }

  function handleReviewOffCatalog(reviewId: string) {
    const item = pendingReview.find((p) => p.reviewId === reviewId);
    if (!item) return;
    // «Вне каталога» из review-панели → произвольная позиция с ценой.
    // Карточка уходит из панели только после подтверждения в модалке.
    setCustomModalPrefill({
      name: item.interpretedName || item.gafferPhrase,
      quantity: item.quantity,
      source: { kind: "review", reviewId },
    });
    setCustomModalOpen(true);
  }

  function handleReviewSkip(reviewId: string) {
    setPendingReview((prev) => prev.filter((p) => p.reviewId !== reviewId));
  }

  function handleReviewSkipAll() { setPendingReview([]); }

  // ── Save / submit (mode-aware) ──

  // Create mode: save as draft (returns new booking id)
  async function saveDraft(): Promise<string | null> {
    setSubmitting(true);
    try {
      const finalComment = bookingComment.trim() || undefined;
      const items = [
        ...apiItems,
        ...customItems.map((c) => ({
          customName: c.name,
          customUnitPrice: c.unitPrice,
          quantity: c.quantity,
        })),
      ];
      const body = {
        client: { name: clientName.trim() },
        // Телефон нового клиента (существующему сервер телефон не перетирает)
        ...(clientPhone.trim() ? { clientPhone: clientPhone.trim() } : {}),
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        discountPercent: Math.min(100, Math.max(0, discountPercent || 0)),
        skipPartialDay,
        comment: finalComment,
        items,
        transport: transportPayload,
        // Если пользователь оставил поле пустым — не передаём (backend вычислит default)
        ...(expectedPaymentDateLocal
          ? { expectedPaymentDate: new Date(`${expectedPaymentDateLocal}T00:00:00+03:00`).toISOString() }
          : {}),
      };
      const res = await apiFetch<{ booking: { id: string } }>("/api/bookings/draft", { method: "POST", body: JSON.stringify(body) });
      // Бронь на сервере — локальный черновик больше не нужен.
      draftPersistDisabledRef.current = true;
      clearDraftSnapshot();
      toast.success("Черновик сохранён");
      return res.booking.id;
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Ошибка сохранения");
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveDraftClick() {
    if (!validateForSubmit()) return;
    const id = await saveDraft();
    if (id) router.push(`/bookings/${id}`);
  }

  async function handleSubmitForApproval() {
    if (!validateForSubmit()) return;
    const id = await saveDraft();
    if (!id) return;
    try {
      await apiFetch(`/api/bookings/${id}/submit-for-approval`, { method: "POST" });
      toast.success("Отправлено на согласование");
      router.push(`/bookings/${id}`);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Ошибка отправки");
      router.push(`/bookings/${id}`);
    }
  }

  // SUPER_ADMIN: создать и сразу подтвердить (черновик → на согласование →
  // одобрить). Прямой confirm из веба закрыт (USE_APPROVAL_FLOW), поэтому
  // проводим бронь по штатной цепочке, но без ухода со страницы на «Одобрить».
  async function handleCreateAndConfirm() {
    if (!validateForSubmit()) return;
    const id = await saveDraft();
    if (!id) return;
    try {
      await apiFetch(`/api/bookings/${id}/submit-for-approval`, { method: "POST" });
      await apiFetch(`/api/bookings/${id}/approve`, { method: "POST" });
      toast.success("Бронь создана и подтверждена");
    } catch (err: unknown) {
      // Черновик уже создан — не теряем его, ведём на страницу брони, где
      // руководитель увидит текущий статус и сможет завершить согласование.
      toast.error((err as { message?: string })?.message ?? "Не удалось подтвердить бронь");
    } finally {
      router.push(`/bookings/${id}`);
    }
  }

  // Edit mode: PATCH existing booking
  async function handleSaveEdit() {
    if (!validateForSubmit()) return;
    if (!bookingId || !pickupISO || !returnISO) return;
    setSubmitting(true);
    try {
      const finalComment = bookingComment.trim() || null;
      const items = [
        ...apiItems,
        ...customItems.map((c) => ({
          customName: c.name,
          customUnitPrice: c.unitPrice,
          quantity: c.quantity,
        })),
      ];
      const body = {
        client: { name: clientName.trim() },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        discountPercent: clampedDiscount,
        skipPartialDay,
        comment: finalComment,
        items,
        transport: transportPayload,
        // null = сбросить до auto-default; строка = пользовательский выбор
        expectedPaymentDate: expectedPaymentDateLocal
          ? new Date(`${expectedPaymentDateLocal}T00:00:00+03:00`).toISOString()
          : null,
      };
      await apiFetch(`/api/bookings/${bookingId}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success("Изменения сохранены");
      router.push(`/bookings/${bookingId}`);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Не удалось сохранить изменения");
    } finally {
      setSubmitting(false);
    }
  }

  // «Начать заново» из плашки восстановления: чистим localStorage и
  // ремаунтим форму с дефолтами (key-эпоха в обёртке BookingForm).
  function handleDiscardDraft() {
    draftPersistDisabledRef.current = true;
    clearDraftSnapshot();
    onResetForm?.();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const breadcrumb = isEdit ? (
    <>
      <Link href={`/bookings/${bookingId}`} className="text-accent-bright hover:underline">
        ← Бронь #{bookingId?.slice(-6)}
      </Link>
      <span className="text-ink-3">/ Редактирование</span>
    </>
  ) : (
    <>
      <Link href="/bookings" className="text-accent-bright hover:underline">← Брони</Link>
      <span className="text-ink-3">/ Новая бронь</span>
      <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] text-ink-3">Черновик</span>
    </>
  );

  const headerTitle = isEdit
    ? `Редактирование брони${initialBooking?.client.name ? ` — ${initialBooking.client.name}` : ""}`
    : "Новая бронь";

  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between px-4 md:px-8 py-3">
          <div className="flex items-center gap-3 text-[13px]">
            {breadcrumb}
          </div>
          {isEdit && (
            <div className="text-sm font-medium text-ink">{headerTitle}</div>
          )}
        </div>
        {/* Рейка шагов (4.8): статус секций + клик-переход. Не wizard —
            секции остаются на странице, менеджер свободно прыгает между ними. */}
        <div className="border-t border-border">
          <StepsNav steps={steps} onStepClick={scrollToStep} />
        </div>
      </header>

      <div className="mx-auto grid max-w-[1280px] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] items-start gap-5 px-4 py-5 md:px-8 md:py-7">
        {/* Left column: Client, Dates, Equipment, Comment */}
        <div className="flex flex-col gap-3.5">
          {draftBannerVisible && draft && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-border bg-amber-soft px-4 py-2.5 text-[13px] text-ink"
            >
              <span>Восстановлен черновик от {formatDraftTime(draft.savedAt)}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDraftBannerVisible(false)}
                  className="rounded bg-accent-bright px-3 py-1 text-[12px] font-medium text-white hover:opacity-90"
                >
                  Продолжить
                </button>
                <button
                  type="button"
                  onClick={handleDiscardDraft}
                  className="rounded border border-border bg-surface px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-muted"
                >
                  Начать заново
                </button>
              </div>
            </div>
          )}
          <div ref={(el) => { sectionRefs.current["step-client"] = el; }} className="scroll-mt-28">
            <ClientProjectCard
              clientName={clientName}
              projectName={projectName}
              onClientNameChange={setClientName}
              onProjectNameChange={setProjectName}
              clientReadOnly={isEdit}
              clientPhone={clientPhone}
              onClientPhoneChange={setClientPhone}
              showPhoneField={!isEdit && isNewClient}
              onNewClientChange={setIsNewClient}
              errorText={
                submitAttempted && !clientOk
                  ? "Укажите клиента — без него бронь не сохранить"
                  : null
              }
            />
          </div>
          <div ref={(el) => { sectionRefs.current["step-dates"] = el; }} className="scroll-mt-28">
            <DatesCard
              pickupLocal={pickupLocal}
              returnLocal={returnLocal}
              onPickupChange={handlePickupChange}
              onReturnChange={handleReturnChange}
              durationTag={durationTag}
              durationDetail={durationDetail}
              skipPartialDay={skipPartialDay}
              onSkipPartialDayChange={setSkipPartialDay}
              rangeError={dateOrderInvalid ? "Возврат раньше выдачи — проверьте дату и время" : null}
            />
          </div>

          <div
            ref={(el) => { sectionRefs.current["step-equipment"] = el; }}
            className="flex scroll-mt-28 flex-col gap-2"
          >
          {submitAttempted && !hasItems && (
            <div role="alert" className="rounded-md border border-rose-border bg-rose-soft px-4 py-2.5 text-[13px] text-rose">
              Добавьте хотя бы одну позицию — из каталога, через AI-заявку или произвольной позицией.
            </div>
          )}
          <EquipmentCard
            catalog={catalog}
            catalogLoading={catalogLoading}
            selected={selected}
            customItems={customItems}
            adjustments={adjustments}
            gafferText={gafferText}
            onGafferTextChange={setGafferText}
            parsing={parsing}
            parsed={parsed}
            parseResolved={parseResolved}
            parseTotal={parseTotal}
            unmatchedFromAi={unmatchedFromAi}
            successBannerDismissed={successBannerDismissed}
            onParse={handleParse}
            onClear={handleClear}
            onDismissSuccess={handleDismissSuccess}
            onIgnoreUnmatched={handleIgnoreUnmatched}
            onAddOffCatalog={handleAddOffCatalog}
            onAdd={handleAdd}
            onChangeQty={handleChangeQty}
            onRemove={handleRemove}
            onChangeCustomQty={handleChangeCustomQty}
            onRemoveCustom={handleRemoveCustom}
            onOpenCustomModal={() => {
              setCustomModalPrefill(null);
              setCustomModalOpen(true);
            }}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            shifts={shifts}
            pendingReview={pendingReview}
            pickupISO={pickupISO ?? ""}
            returnISO={returnISO ?? ""}
            onReviewConfirm={handleReviewConfirm}
            onReviewOffCatalog={handleReviewOffCatalog}
            onReviewSkip={handleReviewSkip}
            onReviewSkipAll={handleReviewSkipAll}
          />
          </div>

          <div
            ref={(el) => { sectionRefs.current["step-details"] = el; }}
            className="flex scroll-mt-28 flex-col gap-3.5"
          >
          <CommentCard value={bookingComment} onChange={setBookingComment} />

          {/* Срок оплаты */}
          <div className="bg-surface border border-border rounded-lg p-4">
            <label className="eyebrow block mb-1">Срок оплаты</label>
            <input
              type="date"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={expectedPaymentDateLocal}
              onChange={(e) => setExpectedPaymentDateLocal(e.target.value)}
            />
            {/* F3: dynamic placeholder showing computed default date */}
            {!expectedPaymentDateLocal && returnISO && defaultPaymentTermsDays !== null && (() => {
              const endDate = new Date(returnISO);
              const defaultDate = addDays(endDate, defaultPaymentTermsDays);
              const defaultStr = toMoscowDateString(defaultDate);
              const [y, m, d] = defaultStr.split("-");
              const ddMm = `${d}.${m}.${y}`;
              return (
                <p className="text-xs text-ink-3 mt-1">
                  {defaultPaymentTermsDays === 0
                    ? `по умолчанию: совпадает с днём сдачи (${ddMm})`
                    : `по умолчанию: через ${defaultPaymentTermsDays} дн. после сдачи (${ddMm})`}
                </p>
              );
            })()}
            {(!returnISO || expectedPaymentDateLocal) && (
              <p className="text-xs text-ink-3 mt-1">
                Оставь пустым для default-значения из настроек организации
              </p>
            )}
          </div>
          </div>
        </div>

        {/* Right column: Discount, Summary, Transport */}
        <div className="sticky top-20 flex max-h-[calc(100vh-6rem)] flex-col gap-3.5 self-start overflow-y-auto pr-1">
          <DiscountCard value={discountPercent} onChange={setDiscountPercent} />
          <SummaryPanel
            quote={quote}
            localSubtotal={localSubtotal}
            localDiscount={localDiscount}
            localTotal={localTotal}
            discountPercent={discountPercent}
            itemCount={selected.size + customItems.length}
            shifts={shifts}
            isLoadingQuote={loadingQuote}
            quoteError={quoteError}
            checks={checks}
            onSubmitForApproval={isEdit ? undefined : handleSubmitForApproval}
            onCreateAndConfirm={isEdit || !isSuperAdmin ? undefined : handleCreateAndConfirm}
            onSaveDraft={isEdit ? undefined : handleSaveDraftClick}
            onSaveEdit={isEdit ? handleSaveEdit : undefined}
            canSubmit={canSubmit}
            selectedItems={selected}
            customItems={customItems}
            transportBreakdowns={localTransport?.breakdowns ?? []}
            onRemoveItem={handleRemove}
            onRemoveCustom={handleRemoveCustom}
            mode={mode}
            submitting={submitting}
            cancelHref={isEdit ? `/bookings/${bookingId}` : undefined}
          />
          <TransportCard
            vehicles={vehicles}
            selected={selectedVehicles}
            onToggleVehicle={handleToggleVehicle}
            onPatchVehicle={handlePatchVehicle}
            breakdownByVehicleId={breakdownByVehicleId}
          />
        </div>
      </div>

      {/* Custom item modal */}
      <AddCustomItemModal
        isOpen={customModalOpen}
        onClose={() => {
          setCustomModalOpen(false);
          setCustomModalPrefill(null);
        }}
        onAdd={handleAddCustom}
        initialName={customModalPrefill?.name}
        initialQuantity={customModalPrefill?.quantity}
      />
    </div>
  );
}

// ─── Public export (wraps inner in Suspense for useSearchParams) ──────────────

export function BookingForm(props: BookingFormProps): JSX.Element {
  // Эпоха-ключ: «Начать заново» ремаунтит форму с дефолтными initializers.
  const [formEpoch, setFormEpoch] = useState(0);
  // Форма инициализирует state из localStorage-черновика, которого нет при
  // SSR — любая зависящая от него условная ветка (плашка восстановления,
  // статусы шагов, подсказки автокомплита) давала бы hydration-mismatch.
  // Рендерим форму только после маунта: сервер и первый клиентский рендер
  // одинаково отдают fallback. SSR-ценности у формы за авторизацией нет.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="p-8 text-center text-ink-3">Загрузка…</div>;
  }
  return (
    <Suspense fallback={<div className="p-8 text-center text-ink-3">Загрузка…</div>}>
      <BookingFormInner
        key={formEpoch}
        {...props}
        onResetForm={() => setFormEpoch((e) => e + 1)}
      />
    </Suspense>
  );
}
