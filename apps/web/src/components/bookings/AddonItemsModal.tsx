"use client";

/**
 * Модалка «Добор» на странице выданной брони.
 *
 * Сценарий: оборудование уже у клиента, гафер звонит и просит довезти ещё.
 * Менеджер ищет позиции по каталогу (с доступностью на даты брони и потолком
 * добора), собирает корзину с количеством и выбирает, как это считать:
 *
 *   «Отдельной доп-сметой» — основная смета не меняется, клиент получает
 *   документ «Смета-добор» с номером «…/д»; сумма к оплате растёт на добор.
 *   «В основную смету»    — позиции добавляются в согласованную смету, отдельного
 *                           документа не будет.
 *
 * Конфликт по датам (позиция числится за другой бронью) — предупреждение, а не
 * блокировка: кнопка меняется на «Добавить под ответственность», сервер пишет
 * это в аудит. Физический склад обойти нельзя — 409 ADDON_OVER_STOCK показывается
 * прямо у позиции.
 *
 * Канон модалок (EquipmentPickerModal): Esc / клик по фону закрывают, фокус на
 * поле поиска, Tab не утекает наружу, debounce поиска 250 мс.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatMoneyRub, pluralize } from "../../lib/format";
import { toMoscowDateString } from "../../lib/moscowDate";
import { toast } from "../ToastProvider";

export type AddonMode = "ADDON" | "MERGE";

export interface AddonConflictInfo {
  bookingId: string;
  bookingNo: string;
  projectName: string;
  from: string;
  to: string;
  freeFrom: string;
}

export interface AddonSearchRow {
  equipmentId: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  rentalRatePerShift: string;
  availableQuantity: number;
  /** Сколько ещё можно добрать в эту бронь. */
  addCap: number;
  alreadyInBooking: number;
  availability: "AVAILABLE" | "UNAVAILABLE";
  conflict: AddonConflictInfo | null;
}

export interface AddonAddedResult {
  mode: AddonMode;
  added: Array<{ equipmentId: string; name: string; quantity: number; unitsIssued: number; hadConflict: boolean }>;
}

type CartRow = {
  equipmentId: string;
  name: string;
  category: string;
  qty: number;
  /** Потолок степпера. У конфликтной позиции — хотя бы 1: её берут «под ответственность». */
  max: number;
  alreadyInBooking: number;
  rentalRatePerShift: string;
  conflict: AddonConflictInfo | null;
};

type ServerConflict = AddonConflictInfo & { equipmentId: string; name: string; quantity: number };

interface Props {
  open: boolean;
  bookingId: string;
  /** Смен в основной смете — добор считается на тот же период. */
  shifts: number;
  /** Процент скидки брони (строка Decimal) — для подписи под итогом. */
  discountPercent: string | null;
  /** У брони зафиксирован договорной итог — добор не изменит сумму к оплате. */
  hasManualFinalAmount: boolean;
  onClose: () => void;
  onAdded: (result: AddonAddedResult) => void | Promise<void>;
}

const DEBOUNCE_MS = 250;
const ADDON_CONFLICT_CODE = "ADDON_CONFLICT";
const ADDON_OVER_STOCK_CODE = "ADDON_OVER_STOCK";
const NOT_ENOUGH_UNITS_CODE = "NOT_ENOUGH_UNITS";

/** «21.05» — день.месяц по московскому времени. */
function shortDate(iso: string): string {
  const [, m, d] = toMoscowDateString(new Date(iso)).split("-");
  return `${d}.${m}`;
}

function isApiError(e: unknown): e is { status?: number; code?: string; details?: unknown; message?: string } {
  return typeof e === "object" && e !== null;
}

function conflictsFromDetails(details: unknown): ServerConflict[] {
  if (typeof details !== "object" || details === null) return [];
  const d = details as { conflicts?: unknown };
  if (!Array.isArray(d.conflicts)) return [];
  return d.conflicts.filter(
    (c): c is ServerConflict =>
      typeof c === "object" && c !== null && typeof (c as ServerConflict).equipmentId === "string",
  );
}

export function AddonItemsModal({
  open,
  bookingId,
  shifts,
  discountPercent,
  hasManualFinalAmount,
  onClose,
  onAdded,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddonSearchRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartRow[]>([]);
  const [mode, setMode] = useState<AddonMode>("ADDON");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Конфликты, о которых сообщил сервер уже на отправке (гонка с другой бронью).
  const [serverConflicts, setServerConflicts] = useState<ServerConflict[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Сброс при закрытии: следующий раз модалка открывается чистой.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    setQuery("");
    setResults(null);
    setSearchError(null);
    setCart([]);
    setMode("ADDON");
    setSubmitError(null);
    setServerConflicts([]);
    return undefined;
  }, [open]);

  // Поиск с debounce; устаревшие ответы отбрасываются через AbortController.
  useEffect(() => {
    if (!open) return undefined;
    const trimmed = query.trim();
    if (trimmed.length < 1) {
      setResults(null);
      setSearchError(null);
      setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const data = await apiFetch<{ results: AddonSearchRow[] }>(
          `/api/bookings/${bookingId}/addon-search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        setResults(data.results);
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (err?.name === "AbortError") return;
        setResults([]);
        setSearchError(err?.message ?? "Не удалось выполнить поиск по каталогу");
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, open, bookingId]);

  // Esc → закрыть; Tab/Shift+Tab — фокус остаётся внутри диалога.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const inCart = useMemo(() => new Set(cart.map((r) => r.equipmentId)), [cart]);

  const addToCart = useCallback((r: AddonSearchRow) => {
    setSubmitError(null);
    setCart((prev) => {
      if (prev.some((c) => c.equipmentId === r.equipmentId)) return prev;
      // Конфликтную позицию можно взять «под ответственность»: потолок тогда
      // знает только сервер (физический склад), поэтому степпер не ограничиваем —
      // отказ ADDON_OVER_STOCK подрежет количество до реального.
      const max = r.conflict ? 99 : Math.max(1, r.addCap);
      return [
        ...prev,
        {
          equipmentId: r.equipmentId,
          name: r.name,
          category: r.category,
          qty: 1,
          max,
          alreadyInBooking: r.alreadyInBooking,
          rentalRatePerShift: r.rentalRatePerShift,
          conflict: r.conflict,
        },
      ];
    });
  }, []);

  const removeFromCart = useCallback((equipmentId: string) => {
    setCart((prev) => prev.filter((c) => c.equipmentId !== equipmentId));
    setServerConflicts((prev) => prev.filter((c) => c.equipmentId !== equipmentId));
  }, []);

  const setQty = useCallback((equipmentId: string, raw: number) => {
    setCart((prev) =>
      prev.map((c) => {
        if (c.equipmentId !== equipmentId) return c;
        const n = Math.floor(Number.isFinite(raw) ? raw : 1);
        const qty = Math.min(c.max, Math.max(1, n));
        return qty === c.qty ? c : { ...c, qty };
      }),
    );
  }, []);

  const cartConflicts = useMemo(
    () =>
      cart
        .filter((c): c is CartRow & { conflict: AddonConflictInfo } => c.conflict != null)
        .map((c) => ({ ...c.conflict, equipmentId: c.equipmentId, name: c.name, quantity: c.qty })),
    [cart],
  );
  const allConflicts = useMemo(() => {
    const byId = new Map<string, ServerConflict>();
    for (const c of [...cartConflicts, ...serverConflicts]) byId.set(c.equipmentId, c);
    return Array.from(byId.values());
  }, [cartConflicts, serverConflicts]);
  const needsAck = allConflicts.length > 0;

  const shiftsSafe = Math.max(1, Math.floor(shifts) || 1);
  const estimatedBeforeDiscount = useMemo(
    () => cart.reduce((sum, c) => sum + Number(c.rentalRatePerShift) * shiftsSafe * c.qty, 0),
    [cart, shiftsSafe],
  );
  const discountNum = discountPercent != null ? Number(discountPercent) : 0;

  async function submit() {
    if (busy || cart.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const result = await apiFetch<AddonAddedResult>(`/api/bookings/${bookingId}/addon-items`, {
        method: "POST",
        body: JSON.stringify({
          items: cart.map((c) => ({ equipmentId: c.equipmentId, quantity: c.qty })),
          mode,
          acknowledgedConflict: needsAck,
        }),
      });
      const total = result.added.reduce((s, a) => s + a.quantity, 0);
      toast.success(
        `Добор добавлен: ${total} ${pluralize(total, "позиция", "позиции", "позиций")} · ${
          mode === "ADDON" ? "отдельной доп-сметой" : "в основную смету"
        }`,
      );
      await onAdded(result);
    } catch (e: unknown) {
      if (isApiError(e) && e.status === 409 && e.code === ADDON_CONFLICT_CODE) {
        // Сервер увидел конфликт, которого не было в выдаче поиска (гонка):
        // показываем ту же карточку, кнопка становится «под ответственность».
        const conflicts = conflictsFromDetails(e.details);
        setServerConflicts(conflicts);
        setSubmitError(
          conflicts.length > 0
            ? "Позиции числятся за другой бронью — проверьте предупреждение ниже"
            : e.message ?? "Позиция занята на даты брони",
        );
        return;
      }
      if (isApiError(e) && e.status === 409 && (e.code === ADDON_OVER_STOCK_CODE || e.code === NOT_ENOUGH_UNITS_CODE)) {
        const d = (e.details ?? {}) as { equipmentId?: string; addCap?: number; available?: number };
        const cap = typeof d.addCap === "number" ? d.addCap : typeof d.available === "number" ? d.available : null;
        if (d.equipmentId && cap != null) {
          setCart((prev) =>
            prev.map((c) =>
              c.equipmentId === d.equipmentId ? { ...c, max: Math.max(1, cap), qty: Math.min(c.qty, Math.max(1, cap)) } : c,
            ),
          );
        }
        setSubmitError(e.message ?? "Не хватает на складе");
        return;
      }
      toast.error(isApiError(e) && e.message ? e.message : "Не удалось добавить добор");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const visibleResults = results ?? [];
  const submitLabel = busy
    ? "Добавляю…"
    : needsAck
      ? "Добавить под ответственность"
      : mode === "ADDON"
        ? "Добавить доп-сметой"
        : "Добавить в смету";

  return (
    <div
      className="fixed inset-0 z-50 bg-scrim/40 flex items-end sm:items-start justify-center sm:pt-[6vh] px-0 sm:px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Добор в бронь"
        className="w-full sm:max-w-3xl bg-surface rounded-t-2xl sm:rounded-lg border border-border shadow-xl overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[84vh]"
      >
        <header className="p-4 border-b border-border flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Добор</p>
            <p className="text-sm font-semibold text-ink mt-0.5">Что довезти клиенту</p>
            <p className="text-xs text-ink-3 mt-0.5">
              Доступность считается на даты брони; добор идёт на те же {shiftsSafe}{" "}
              {pluralize(shiftsSafe, "смену", "смены", "смен")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Закрыть"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-lg leading-none text-ink-3 hover:bg-surface-muted hover:text-ink disabled:opacity-40"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Поиск */}
          <div className="p-4 pb-2">
            <label htmlFor="addon-items-search" className="sr-only">
              Поиск по каталогу
            </label>
            <input
              ref={inputRef}
              id="addon-items-search"
              type="text"
              inputMode="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название, бренд или модель…"
              className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="px-4 pb-3">
            {searching && <p className="text-xs text-ink-3 py-2">Ищу…</p>}
            {searchError && <p className="text-xs text-rose py-2">{searchError}</p>}
            {!searching && results && visibleResults.length === 0 && !searchError && (
              <p className="text-xs text-ink-3 py-2">Ничего не найдено</p>
            )}
            {visibleResults.length > 0 && (
              <ul className="divide-y divide-border rounded border border-border max-h-64 overflow-y-auto" aria-label="Результаты поиска">
                {visibleResults.map((r) => {
                  const added = inCart.has(r.equipmentId);
                  const free = r.addCap > 0;
                  const canTake = free || r.conflict != null;
                  const pill = free
                    ? { text: `свободно ×${r.addCap}`, cls: "bg-emerald-soft text-emerald border-emerald-border" }
                    : r.conflict
                      ? { text: "занято", cls: "bg-rose-soft text-rose border-rose-border" }
                      : { text: "нет на складе", cls: "bg-surface text-ink-3 border-border" };
                  return (
                    <li key={r.equipmentId} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-ink truncate">{r.name}</div>
                        <div className="text-xs text-ink-3 truncate">
                          {r.category}
                          {r.brand ? ` · ${r.brand}` : ""}
                          {r.model ? ` ${r.model}` : ""}
                          {r.alreadyInBooking > 0 ? ` · уже в брони ×${r.alreadyInBooking}` : ""}
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${pill.cls}`}>{pill.text}</span>
                      <button
                        type="button"
                        disabled={added || !canTake}
                        onClick={() => addToCart(r)}
                        aria-label={added ? `${r.name} уже в списке` : `Добавить ${r.name}`}
                        className="shrink-0 rounded border border-border px-2.5 py-1 text-xs text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                      >
                        {added ? "В списке" : "+ Добавить"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Корзина */}
          <div className="px-4 pb-3">
            <p className="eyebrow mb-1.5">Довезти</p>
            {cart.length === 0 ? (
              <p className="text-xs text-ink-3 rounded border border-dashed border-border px-3 py-3">
                Найдите позицию выше и нажмите «+ Добавить»
              </p>
            ) : (
              <ul className="divide-y divide-border rounded border border-border" aria-label="Позиции добора">
                {cart.map((c) => (
                  <li key={c.equipmentId} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink truncate">{c.name}</div>
                      <div className="text-xs text-ink-3">
                        {formatMoneyRub(c.rentalRatePerShift)}/смена
                        {c.alreadyInBooking > 0 ? ` · в брони уже ×${c.alreadyInBooking}` : ""}
                        {c.conflict ? <span className="text-rose"> · занято другой бронью</span> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1" role="group" aria-label={`Количество: ${c.name}`}>
                      <button
                        type="button"
                        onClick={() => setQty(c.equipmentId, c.qty - 1)}
                        disabled={busy || c.qty <= 1}
                        aria-label={`Меньше: ${c.name}`}
                        className="h-8 w-8 rounded border border-border text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={c.max}
                        value={c.qty}
                        onChange={(e) => setQty(c.equipmentId, Number(e.target.value))}
                        disabled={busy}
                        aria-label={`Количество ${c.name}`}
                        className="h-8 w-14 rounded border border-border bg-surface text-center text-sm mono-num text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      <button
                        type="button"
                        onClick={() => setQty(c.equipmentId, c.qty + 1)}
                        disabled={busy || c.qty >= c.max}
                        aria-label={`Больше: ${c.name}`}
                        className="h-8 w-8 rounded border border-border text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                    <div className="w-24 text-right text-sm mono-num text-ink">
                      {formatMoneyRub(Number(c.rentalRatePerShift) * shiftsSafe * c.qty)}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFromCart(c.equipmentId)}
                      disabled={busy}
                      aria-label={`Убрать ${c.name}`}
                      className="h-8 w-8 rounded text-rose hover:bg-rose-soft disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {cart.length > 0 && (
              <p className="mt-1.5 text-xs text-ink-3 text-right">
                ≈ {formatMoneyRub(estimatedBeforeDiscount)} до скидки
                {discountNum > 0 ? ` · скидка ${discountNum}% применится как в основной смете` : ""}
              </p>
            )}
          </div>

          {/* Как считать */}
          <div className="px-4 pb-3">
            <p className="eyebrow mb-1.5">Как считать</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Как считать добор">
              {(
                [
                  {
                    value: "ADDON",
                    title: "Отдельной доп-сметой",
                    hint: "Основная смета не меняется. Клиент получит документ «Смета-добор» с номером «…/д».",
                  },
                  {
                    value: "MERGE",
                    title: "В основную смету",
                    hint: "Позиции добавятся в согласованную смету по тем же ценам. Отдельного документа не будет.",
                  },
                ] as const
              ).map((opt) => {
                const active = mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setMode(opt.value)}
                    disabled={busy}
                    className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                      active
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:bg-surface-muted"
                    }`}
                  >
                    <div className={`text-sm font-medium ${active ? "text-accent" : "text-ink"}`}>{opt.title}</div>
                    <div className="text-xs text-ink-3 mt-0.5">{opt.hint}</div>
                  </button>
                );
              })}
            </div>
            {hasManualFinalAmount && (
              <p className="mt-2 rounded border border-amber-border bg-amber-soft px-3 py-2 text-xs text-ink">
                У брони зафиксирован договорной итог — сумма к оплате не изменится автоматически.
                Смета и документы обновятся; итог пересмотрите вручную.
              </p>
            )}
          </div>

          {/* Конфликты — soft-warn */}
          {allConflicts.length > 0 && (
            <div role="alert" className="mx-4 mb-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2.5">
              <p className="text-sm font-semibold text-rose">
                <span aria-hidden="true">⚠ </span>
                {allConflicts.length === 1 ? "Позиция занята другой бронью" : "Позиции заняты другими бронями"}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-rose">
                {allConflicts.map((c) => (
                  <li key={c.equipmentId}>
                    {c.name} — бронь {c.bookingNo} «{c.projectName}» · {shortDate(c.from)}–{shortDate(c.to)}. Свободно с{" "}
                    {shortDate(c.freeFrom)}.
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-rose/80">
                Можно довезти под ответственность — конфликт зафиксируется в аудите.
              </p>
            </div>
          )}

          {submitError && (
            <p className="mx-4 mb-3 text-sm text-rose" role="status">
              {submitError}
            </p>
          )}
        </div>

        <footer className="p-4 border-t border-border flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-subtle disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || cart.length === 0}
            className={`rounded px-4 py-2 text-sm text-surface disabled:opacity-50 ${
              needsAck ? "bg-rose hover:bg-rose/90" : "bg-accent-bright hover:bg-accent"
            }`}
          >
            {submitLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
