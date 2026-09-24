"use client";

/**
 * ProblemItemsPage — реестр «Потеряшки» (manager-facing investigation surface).
 *
 * Это ОБЫЧНАЯ админ-страница (JWT-сессия + ролевой доступ), а НЕ kiosk:
 * рендерится внутри стандартного AppShell (root layout), как /admin и /tasks.
 * Никакого warehouse-Bearer-токена — только `apiFetch` (cookie).
 *
 * Структура зеркалит /admin/audit:
 *  - status-фильтр пилюлями (рефетч с ?status=),
 *  - keyset-пагинация «Загрузить ещё» по { items, nextCursor },
 *  - cancelled-flag fetch-эффект,
 *  - StatusPill, канон-токены, русский.
 *
 * Правило продукта: НИКАКИХ штрихкодов в UX — бэкенд их и не отдаёт.
 * Resolve-модалка (ResolveProblemModal) зеркалит RejectBookingModal.
 *
 * Инвентаризация (спека 2026-09-18 §7): подменю склада, источник карточки
 * (приёмка / инвентаризация № N / вручную) — меткой и фильтром, причина «Не
 * нашли на складе», ручной вход «Завести потеряшку» (AddProblemItemModal).
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useRequireRole } from "../../hooks/useRequireRole";
import { apiFetch } from "../../lib/api";
import { toMoscowDateString } from "../../lib/moscowDate";
import { toast } from "../ToastProvider";
import { StatusPill, type StatusPillVariant } from "../StatusPill";
import { ResolveProblemModal, type ResolveOutcome } from "./ResolveProblemModal";
import { AddProblemItemModal } from "./AddProblemItemModal";
import { WarehouseSubnav } from "./WarehouseSubnav";
import { PageHead } from "../inventory/InventoryHeader";
import type {
  ProblemItemReason,
  ProblemItemStatus,
  ProblemRegistryItem,
  ProblemSource,
} from "./types";

// ── Типы (зеркалят select в apps/api/src/routes/problemItems.ts) ──────────────

type ProblemStatus = ProblemItemStatus;
// UNIT-mode: equipmentUnit задан; COUNT с приёмки — bookingItem + quantity;
// ручные и из инвентаризации — прямая позиция (`equipment`).
type ProblemItem = ProblemRegistryItem;

interface ProblemItemsResponse {
  items: ProblemItem[];
  nextCursor: string | null;
}

// ── Лейблы (русские человекочитаемые, никогда не сырой ENUM) ──────────────────

const REASON_LABEL: Record<ProblemItemReason, string> = {
  LEFT_ON_SITE: "Остался на площадке",
  LOST: "Потерян",
  DESTROYED: "Уничтожен",
  STOLEN: "Украден",
  NOT_ON_SHELF: "Не нашли на складе",
};

const STATUS_LABEL: Record<ProblemStatus, string> = {
  EXPECTED: "Ожидается",
  SEARCHING: "На поиске",
  FOUND: "Найдено",
  NOT_FOUND: "Не найдено",
  WROTE_OFF: "Списано",
};

const STATUS_VARIANT: Record<ProblemStatus, StatusPillVariant> = {
  EXPECTED: "info",
  SEARCHING: "warn",
  FOUND: "ok",
  NOT_FOUND: "alert",
  WROTE_OFF: "none",
};

type StatusFilter = "" | ProblemStatus;

const FILTER_PILLS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "", label: "Все" },
  { value: "EXPECTED", label: "Ожидается" },
  { value: "SEARCHING", label: "На поиске" },
  { value: "FOUND", label: "Найдено" },
  { value: "NOT_FOUND", label: "Не найдено" },
  { value: "WROTE_OFF", label: "Списано" },
];

type SourceFilter = "" | ProblemSource;

const SOURCE_PILLS: ReadonlyArray<{ value: SourceFilter; label: string }> = [
  { value: "", label: "Все источники" },
  { value: "RETURN", label: "Приёмка" },
  { value: "STOCK_COUNT", label: "Инвентаризация" },
  { value: "MANUAL", label: "Вручную" },
];

const OPEN_STATUSES: ReadonlySet<ProblemStatus> = new Set<ProblemStatus>([
  "EXPECTED",
  "SEARCHING",
]);

// ── Хелперы форматирования ────────────────────────────────────────────────────

/**
 * «DD.MM.YYYY» (ru) — год обязателен: реестр охватывает границу годов,
 * без года дата неоднозначна. Тот же канон-подход, что и /admin/audit
 * (toLocaleString ru-RU с year: "numeric").
 */
function formatDayMonthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** «#»+последние 6 символов id брони в верхнем регистре, либо «—». */
function bookingRef(sourceBookingId: string | null): string {
  if (!sourceBookingId) return "—";
  return `#${sourceBookingId.slice(-6).toUpperCase()}`;
}

/**
 * Просроченная «Ожидается»: expectedBackDate уже в прошлом (МСК date-only).
 * Такие строки тонируются rose — сигнал «пора звонить и разбираться».
 */
function isOverdueExpected(item: ProblemItem): boolean {
  if (item.status !== "EXPECTED" || !item.expectedBackDate) return false;
  const d = new Date(item.expectedBackDate);
  if (Number.isNaN(d.getTime())) return false;
  return toMoscowDateString(d) < toMoscowDateString(new Date());
}

/** Код ошибки API: `code` (4-арг HttpError) или строковый `details` (3-арг). */
function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const { code, details } = e as { code?: unknown; details?: unknown };
  if (typeof code === "string") return code;
  return typeof details === "string" ? details : undefined;
}

/** «приёмка» / «инвентаризация № N» / «вручную». */
function sourceLabel(item: ProblemItem): string {
  if (item.source === "STOCK_COUNT") {
    return item.stockCount ? `инвентаризация № ${item.stockCount.number}` : "инвентаризация";
  }
  return item.source === "MANUAL" ? "вручную" : "приёмка";
}

/** Метка источника — пунктирная «src», как в мокапе реестра. */
function SourceBadge({ item }: { item: ProblemItem }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-[3px] border border-dashed border-border-strong px-1 align-middle font-cond text-[9.5px] font-semibold uppercase leading-[1.7] tracking-[0.05em] text-ink-3">
      {sourceLabel(item)}
    </span>
  );
}

/**
 * Клик по строке/карточке ведёт на /bookings/[id], но клики по вложенным
 * интерактивным элементам (кнопки разбора, ссылки) не должны уводить со
 * страницы — guard через closest.
 */
function isInteractiveTarget(e: React.MouseEvent): boolean {
  return Boolean((e.target as HTMLElement).closest("a, button"));
}

// ── Ячейка «Бронь» (клиент · проект, либо fallback #хвост-id) ─────────────────

function BookingInfo({ item }: { item: ProblemItem }) {
  if (item.booking) {
    return (
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-ink">
          {item.booking.client?.name ?? "—"}
        </span>
        <span className="block truncate text-xs text-ink-3">
          {item.booking.projectName}
        </span>
      </span>
    );
  }
  return (
    <span className="mono-num text-ink-2">{bookingRef(item.sourceBookingId)}</span>
  );
}

// ── Карточка «закрыто» (resolutionNote + кем/когда) ───────────────────────────

function ResolutionInfo({ item }: { item: ProblemItem }) {
  const resolvedDate = formatDayMonthYear(item.resolvedAt);
  return (
    <div className="rounded-md border border-border bg-surface-muted px-3 py-2">
      <p className="eyebrow mb-1">Разбор</p>
      {item.resolutionNote && (
        <p className="text-[13px] text-ink-2 break-words">{item.resolutionNote}</p>
      )}
      <p className="mt-1 text-xs text-ink-3">
        {item.resolvedBy ?? "—"}
        {resolvedDate ? ` · ${resolvedDate}` : ""}
      </p>
    </div>
  );
}

// ── Действия (кнопки разбора либо инфо о закрытии) ────────────────────────────

function ItemActions({
  item,
  onResolve,
}: {
  item: ProblemItem;
  onResolve: (item: ProblemItem, outcome: ResolveOutcome) => void;
}) {
  if (OPEN_STATUSES.has(item.status)) {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onResolve(item, "FOUND")}
          aria-label="Отметить «Найдено»"
          className="inline-flex h-10 items-center rounded-md border border-emerald-border bg-emerald-soft px-3 text-[13px] font-medium text-emerald hover:bg-emerald-soft/70 transition-colors"
        >
          Найдено
        </button>
        <button
          type="button"
          onClick={() => onResolve(item, "NOT_FOUND")}
          aria-label="Отметить «Не найдено»"
          className="inline-flex h-10 items-center rounded-md border border-rose-border bg-rose-soft px-3 text-[13px] font-medium text-rose hover:bg-rose-soft/70 transition-colors"
        >
          Не найдено
        </button>
      </div>
    );
  }
  return <ResolutionInfo item={item} />;
}

/**
 * Позиция карточки по правилу системы: единица (штучный учёт) → позиция брони
 * (COUNT с приёмки) → прямая ссылка (вручную / инвентаризация). Бэкенд уже
 * кладёт результат в `equipment`; цепочка здесь — страховка для старых ответов.
 */
function itemEquipment(item: ProblemItem): {
  name: string;
  category: string;
  qty: number;
} {
  const eq =
    item.equipmentUnit?.equipment ?? item.bookingItem?.equipment ?? item.equipment ?? null;
  const qty = item.equipmentUnit ? 1 : item.quantity;
  if (!eq) return { name: "Позиция удалена из каталога", category: "—", qty };
  return { name: eq.name, category: eq.category, qty };
}

/** Ряд пилюль-фильтров (статус / источник) — один визуальный контракт. */
function FilterPills<T extends string>({
  label,
  pills,
  value,
  onChange,
}: {
  label: string;
  pills: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {pills.map((pill) => {
        const active = value === pill.value;
        return (
          <button
            key={pill.value || "all"}
            type="button"
            onClick={() => onChange(pill.value)}
            aria-pressed={active}
            className={`inline-flex h-9 items-center rounded-md border px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright ${
              active
                ? "bg-accent-soft text-accent border-accent-border font-medium"
                : "bg-surface text-ink-2 border-border hover:border-border-strong"
            }`}
          >
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Строка-карточка (mobile) ──────────────────────────────────────────────────

function ProblemCard({
  item,
  onResolve,
  onOpenBooking,
}: {
  item: ProblemItem;
  onResolve: (item: ProblemItem, outcome: ResolveOutcome) => void;
  onOpenBooking: (bookingId: string) => void;
}) {
  const expected = formatDayMonthYear(item.expectedBackDate);
  const created = formatDayMonthYear(item.createdAt);
  const overdue = isOverdueExpected(item);
  const clickable = Boolean(item.sourceBookingId);
  return (
    <div
      onClick={(e) => {
        if (!clickable || isInteractiveTarget(e)) return;
        onOpenBooking(item.sourceBookingId!);
      }}
      className={`rounded-lg border p-4 shadow-xs space-y-3 ${
        overdue
          ? "border-rose-border bg-rose-soft/50"
          : "border-border bg-surface"
      } ${clickable ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{itemEquipment(item).category}</p>
          <p className="text-sm font-semibold text-ink mt-0.5 break-words">
            {itemEquipment(item).name}
            {itemEquipment(item).qty > 1 ? ` ×${itemEquipment(item).qty}` : ""}
          </p>
          <p className="mt-1">
            <SourceBadge item={item} />
          </p>
        </div>
        <StatusPill
          variant={STATUS_VARIANT[item.status]}
          label={STATUS_LABEL[item.status]}
          className="shrink-0"
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
        <span>
          Бронь:{" "}
          {item.booking ? (
            <span className="text-ink-2">
              {item.booking.client?.name ?? "—"} · {item.booking.projectName}
            </span>
          ) : (
            <span className="mono-num text-ink-2">{bookingRef(item.sourceBookingId)}</span>
          )}
        </span>
        <span>
          Причина: <span className="text-ink-2">{REASON_LABEL[item.reason]}</span>
        </span>
        {expected && (
          <span>
            Ожидается к:{" "}
            <span className={overdue ? "font-medium text-rose" : "text-ink-2"}>
              {expected}
            </span>
          </span>
        )}
        <span>
          Заведено: <span className="text-ink-2">{created ?? "—"}</span> · {item.createdBy}
        </span>
      </div>

      {item.comment && (
        <p className="text-[13px] text-ink-2 break-words">
          <span className="text-xs text-ink-3">Комментарий: </span>
          {item.comment}
        </p>
      )}

      <ItemActions item={item} onResolve={onResolve} />
    </div>
  );
}

// ── Строка таблицы (desktop) ──────────────────────────────────────────────────

function ProblemRow({
  item,
  onResolve,
  onOpenBooking,
}: {
  item: ProblemItem;
  onResolve: (item: ProblemItem, outcome: ResolveOutcome) => void;
  onOpenBooking: (bookingId: string) => void;
}) {
  const expected = formatDayMonthYear(item.expectedBackDate);
  const created = formatDayMonthYear(item.createdAt);
  const overdue = isOverdueExpected(item);
  const clickable = Boolean(item.sourceBookingId);
  return (
    <tr
      onClick={(e) => {
        if (!clickable || isInteractiveTarget(e)) return;
        onOpenBooking(item.sourceBookingId!);
      }}
      className={`border-b border-border align-top ${
        overdue
          ? "bg-rose-soft/50 hover:bg-rose-soft"
          : "hover:bg-surface-muted"
      } ${clickable ? "cursor-pointer" : ""}`}
    >
      <td className="py-3 px-3">
        <p className="eyebrow">{itemEquipment(item).category}</p>
        <p className="text-sm font-medium text-ink mt-0.5">
          {itemEquipment(item).name}
          {itemEquipment(item).qty > 1 ? ` ×${itemEquipment(item).qty}` : ""}{" "}
          <SourceBadge item={item} />
        </p>
      </td>
      <td className="py-3 px-3 text-xs whitespace-nowrap max-w-[200px]">
        <BookingInfo item={item} />
      </td>
      <td className="py-3 px-3 text-[13px] text-ink-2 whitespace-nowrap">
        {REASON_LABEL[item.reason]}
      </td>
      <td className="py-3 px-3 text-[13px] text-ink-2 max-w-[280px]">
        <span className="block break-words">{item.comment || "—"}</span>
      </td>
      <td
        className={`py-3 px-3 text-xs whitespace-nowrap ${
          overdue ? "font-medium text-rose" : "text-ink-2"
        }`}
      >
        {expected ?? "—"}
      </td>
      <td className="py-3 px-3 whitespace-nowrap">
        <StatusPill
          variant={STATUS_VARIANT[item.status]}
          label={STATUS_LABEL[item.status]}
        />
      </td>
      <td className="py-3 px-3 text-xs text-ink-3 whitespace-nowrap">
        {created ?? "—"}
        <span className="block text-ink-3">{item.createdBy}</span>
      </td>
      <td className="py-3 px-3 min-w-[180px]">
        <ItemActions item={item} onResolve={onResolve} />
      </td>
    </tr>
  );
}

// ── Страница ──────────────────────────────────────────────────────────────────

export function ProblemItemsPage() {
  const router = useRouter();
  const bookingId = useSearchParams().get("bookingId");
  const { authorized, loading: authLoading } = useRequireRole([
    "SUPER_ADMIN",
    "WAREHOUSE",
  ]);

  const openBooking = useCallback(
    (bookingId: string) => {
      router.push(`/bookings/${bookingId}`);
    },
    [router],
  );

  const [items, setItems] = useState<ProblemItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("");
  const [addOpen, setAddOpen] = useState(false);

  // Resolve-модалка
  const [resolveTarget, setResolveTarget] = useState<ProblemItem | null>(null);
  const [resolveOutcome, setResolveOutcome] = useState<ResolveOutcome>("FOUND");
  const [resolving, setResolving] = useState(false);

  const listUrl = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (sourceFilter) params.set("source", sourceFilter);
      if (bookingId) params.set("bookingId", bookingId);
      params.set("limit", "50");
      if (cursor) params.set("cursor", cursor);
      return `/api/problem-items?${params.toString()}`;
    },
    [statusFilter, sourceFilter, bookingId],
  );

  const load = useCallback(
    async (cursor?: string) => {
      setFetching(true);
      setError(null);
      try {
        const data = await apiFetch<ProblemItemsResponse>(listUrl(cursor));
        setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Ошибка загрузки");
      } finally {
        setFetching(false);
      }
    },
    [listUrl],
  );

  // Первичная загрузка + рефетч при смене фильтра. cancelled-flag — защита
  // от set-state после размонтирования / обгоняющего ответа.
  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    setFetching(true);
    setError(null);
    apiFetch<ProblemItemsResponse>(listUrl())
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setNextCursor(data.nextCursor);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Ошибка загрузки");
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authorized, listUrl]);

  const openResolve = useCallback((item: ProblemItem, outcome: ResolveOutcome) => {
    setResolveTarget(item);
    setResolveOutcome(outcome);
  }, []);

  const closeResolve = useCallback(() => {
    if (resolving) return;
    setResolveTarget(null);
  }, [resolving]);

  const submitResolve = useCallback(
    async (note: string) => {
      if (!resolveTarget) return;
      const targetId = resolveTarget.id;
      setResolving(true);
      try {
        const { item: updated } = await apiFetch<{ item: ProblemItem }>(
          `/api/problem-items/${targetId}/resolve`,
          {
            method: "POST",
            body: JSON.stringify({ outcome: resolveOutcome, note }),
          },
        );
        setResolveTarget(null);
        toast.success(
          resolveOutcome === "FOUND"
            ? "Единица найдена и возвращена в оборот"
            : "Карточка закрыта как «Не найдено»",
        );
        if (statusFilter) {
          // Активен фильтр по статусу: разобранная строка может больше не
          // соответствовать фильтру (напр. «На поиске» → FOUND). Полный
          // ресинк (тот же путь, что и 409) — список консистентен фильтру,
          // nextCursor пересчитан, никакого рассинхрона курсора.
          await load();
        } else {
          // Фильтр «Все»: строка остаётся видимой, оптимистично
          // отражаем новый статус (пилюля статуса меняется). Без
          // лишнего рефетча.
          setItems((prev) =>
            prev.map((it) => (it.id === targetId ? { ...it, ...updated } : it)),
          );
        }
      } catch (e: unknown) {
        // ApiFetchError: { status, details }. Бэкенд HttpError(409, …,
        // "PROBLEM_ITEM_CLOSED") → app.ts кладёт строку в `details` (и
        // дублирует в `code`); api.ts прокидывает `details` строкой.
        const status =
          typeof e === "object" && e !== null && "status" in e
            ? (e as { status?: number }).status
            : undefined;
        const details =
          typeof e === "object" && e !== null && "details" in e
            ? (e as { details?: unknown }).details
            : undefined;
        if (errorCode(e) === "STOCK_COUNT_LINE_COUNTED") {
          // Позицию уже посчитали в идущей инвентаризации: «Найдено» решается
          // там («Нашлось»), иначе излишек закрыл бы карточку второй раз.
          // Сообщение сервера уже по-русски и с номером инвентаризации.
          toast.error(
            e instanceof Error && e.message
              ? e.message
              : "Позиция уже посчитана в идущей инвентаризации — решите там («Нашлось»)",
          );
          setResolveTarget(null);
          return;
        }
        const isClosed =
          status === 409 || details === "PROBLEM_ITEM_CLOSED";
        if (isClosed) {
          // Кто-то уже разобрал карточку — рефетч и сообщение.
          toast.error("Карточка уже разобрана другим пользователем");
          setResolveTarget(null);
          load();
          return;
        }
        // Прочие ошибки показывает сама модалка (re-throw).
        throw e;
      } finally {
        setResolving(false);
      }
    },
    [resolveTarget, resolveOutcome, statusFilter, load],
  );

  if (authLoading) {
    return <div className="p-6 text-sm text-ink-3">Проверка доступа…</div>;
  }
  if (!authorized) return null;

  const isEmpty = !fetching && items.length === 0;
  const isFiltered = Boolean(statusFilter || sourceFilter);

  return (
    <>
      {/* Каркас как у вкладок инвентаризации (общий PageHead, ширина 1240, запас
          снизу под плавающую кнопку «Сообщить») — при переходе по подменю склада
          шапка и контейнер не прыгают. */}
      <div className="mx-auto w-full max-w-[1240px] p-4 pb-24 lg:p-6 lg:pb-24 space-y-4">
        {/* Заголовок + подменю склада */}
        <div>
          <PageHead
            title="Потеряшки"
            sub="Реестр пропавших позиций — заявки на поиск и разбор"
            actions={
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="inline-flex h-9 items-center rounded-md border border-accent-bright bg-accent-bright px-3.5 text-[13px] font-semibold text-surface transition-colors hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright focus-visible:ring-offset-2"
              >
                Завести потеряшку
              </button>
            }
          />
          <div className="mt-3">
            <WarehouseSubnav active="problems" />
          </div>
        </div>

        {bookingId && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent-border bg-accent-soft p-3 text-sm">
            <span>Показаны потеряшки выбранного проекта</span>
            <Link href={`/bookings/${encodeURIComponent(bookingId)}`} className="text-accent underline">Открыть бронь</Link>
            <Link href="/warehouse/problems" className="text-accent underline">Все потеряшки</Link>
          </div>
        )}
        {/* Фильтр-пилюли: статус и источник */}
        <div className="bg-surface border border-border rounded-lg px-4 py-3 space-y-2.5">
          <FilterPills
            label="Фильтр по статусу"
            pills={FILTER_PILLS}
            value={statusFilter}
            onChange={setStatusFilter}
          />
          {/* Разделитель: на узком экране две группы пилюль иначе сливаются в одну */}
          <div className="border-t border-border pt-2.5">
            <FilterPills
              label="Фильтр по источнику"
              pills={SOURCE_PILLS}
              value={sourceFilter}
              onChange={setSourceFilter}
            />
          </div>
        </div>

        {/* Ошибка */}
        {error && (
          <div className="bg-rose-soft border border-rose-border text-rose text-sm rounded-lg p-3">
            {error}
          </div>
        )}

        {/* Скелетон */}
        {fetching && items.length === 0 && (
          <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-4 border-b border-border last:border-0"
              >
                <div className="flex-1 h-4 bg-surface-muted rounded animate-pulse" />
                <div className="h-6 w-20 bg-surface-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        )}

        {/* Пустое состояние */}
        {isEmpty && !error && (
          <div className="bg-surface border border-border rounded-lg p-10 text-center shadow-xs">
            <p className="text-sm text-ink-2 font-medium">Потеряшек нет</p>
            <p className="text-[13px] text-ink-3 mt-1">
              {isFiltered
                ? "По выбранным фильтрам карточек нет — сбросьте фильтр, чтобы увидеть весь реестр"
                : "Карточки появляются с приёмки, из инвентаризации или вручную — кнопкой «Завести потеряшку»"}
            </p>
          </div>
        )}

        {/* Список — таблица (от xl: восемь колонок уже вмещаются без прокрутки) */}
        {!isEmpty && items.length > 0 && (
          <>
            <div className="hidden xl:block bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-surface-muted border-b border-border">
                    <tr>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Оборудование
                      </th>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Бронь
                      </th>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Причина
                      </th>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Комментарий
                      </th>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Ожидается
                      </th>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Статус
                      </th>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Заведено
                      </th>
                      <th className="py-2 px-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                        Действия
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <ProblemRow
                        key={item.id}
                        item={item}
                        onResolve={openResolve}
                        onOpenBooking={openBooking}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Список — карточки (телефон — столбцом, планшет — в две колонки) */}
            <div className="grid gap-3 md:grid-cols-2 xl:hidden">
              {items.map((item) => (
                <ProblemCard
                  key={item.id}
                  item={item}
                  onResolve={openResolve}
                  onOpenBooking={openBooking}
                />
              ))}
            </div>
          </>
        )}

        {/* Пагинация */}
        {nextCursor && (
          <button
            type="button"
            onClick={() => load(nextCursor)}
            disabled={fetching}
            className="w-full py-2 text-sm text-accent-bright hover:underline disabled:opacity-60"
          >
            {fetching ? "Загрузка…" : "Загрузить ещё"}
          </button>
        )}
      </div>

      {/* Модалки — вне space-y-контейнера: иначе fixed-корень получает margin-top 16 px */}
      <AddProblemItemModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          void load();
        }}
      />

      {resolveTarget && (
        <ResolveProblemModal
          open
          outcome={resolveOutcome}
          equipmentName={itemEquipment(resolveTarget).name}
          loading={resolving}
          onClose={closeResolve}
          onSubmit={submitResolve}
        />
      )}
    </>
  );
}
