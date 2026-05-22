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
 */

import { useState, useEffect, useCallback } from "react";
import { useRequireRole } from "../../hooks/useRequireRole";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { StatusPill, type StatusPillVariant } from "../StatusPill";
import { ResolveProblemModal, type ResolveOutcome } from "./ResolveProblemModal";
import type { ProblemReason } from "./types";

// ── Типы (зеркалят select в apps/api/src/routes/problemItems.ts) ──────────────

type ProblemStatus = "EXPECTED" | "SEARCHING" | "FOUND" | "NOT_FOUND" | "WROTE_OFF";

interface ProblemItem {
  id: string;
  // UNIT-mode: equipmentUnitId + equipmentUnit are set; COUNT-mode (per-bookingItem)
  // → both are null, and `bookingItem` + `quantity` carry the equipment info.
  equipmentUnitId: string | null;
  sourceBookingId: string | null;
  reason: ProblemReason;
  comment: string;
  expectedBackDate: string | null;
  status: ProblemStatus;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  equipmentUnit: {
    id: string;
    equipment: { name: string; category: string };
  } | null;
  bookingItem: {
    id: string;
    quantity: number;
    equipment: { name: string; category: string };
  } | null;
  quantity: number;
}

interface ProblemItemsResponse {
  items: ProblemItem[];
  nextCursor: string | null;
}

// ── Лейблы (русские человекочитаемые, никогда не сырой ENUM) ──────────────────

const REASON_LABEL: Record<ProblemReason, string> = {
  LEFT_ON_SITE: "Остался на площадке",
  LOST: "Потерян",
  DESTROYED: "Уничтожен",
  STOLEN: "Украден",
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
 * Pick equipment info from either the UNIT-mode (`equipmentUnit`) or
 * COUNT-mode (`bookingItem`) relation. UNIT-mode rows always have
 * `equipmentUnit` populated; COUNT-mode rows have only `bookingItem`.
 */
function itemEquipment(item: ProblemItem): {
  name: string;
  category: string;
  qty: number;
} {
  if (item.equipmentUnit) {
    return {
      name: item.equipmentUnit.equipment.name,
      category: item.equipmentUnit.equipment.category,
      qty: 1,
    };
  }
  if (item.bookingItem) {
    return {
      name: item.bookingItem.equipment.name,
      category: item.bookingItem.equipment.category,
      qty: item.quantity,
    };
  }
  return { name: "Без позиции", category: "—", qty: 1 };
}

// ── Строка-карточка (mobile) ──────────────────────────────────────────────────

function ProblemCard({
  item,
  onResolve,
}: {
  item: ProblemItem;
  onResolve: (item: ProblemItem, outcome: ResolveOutcome) => void;
}) {
  const expected = formatDayMonthYear(item.expectedBackDate);
  const created = formatDayMonthYear(item.createdAt);
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-xs space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{itemEquipment(item).category}</p>
          <p className="text-sm font-semibold text-ink mt-0.5 break-words">
            {itemEquipment(item).name}
            {itemEquipment(item).qty > 1 ? ` ×${itemEquipment(item).qty}` : ""}
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
          Бронь: <span className="mono-num text-ink-2">{bookingRef(item.sourceBookingId)}</span>
        </span>
        <span>
          Причина: <span className="text-ink-2">{REASON_LABEL[item.reason]}</span>
        </span>
        {expected && (
          <span>
            Ожидается к: <span className="text-ink-2">{expected}</span>
          </span>
        )}
        <span>
          Заведено: <span className="text-ink-2">{created ?? "—"}</span> · {item.createdBy}
        </span>
      </div>

      {item.comment && (
        <p className="text-[13px] text-ink-2 break-words">{item.comment}</p>
      )}

      <ItemActions item={item} onResolve={onResolve} />
    </div>
  );
}

// ── Строка таблицы (desktop) ──────────────────────────────────────────────────

function ProblemRow({
  item,
  onResolve,
}: {
  item: ProblemItem;
  onResolve: (item: ProblemItem, outcome: ResolveOutcome) => void;
}) {
  const expected = formatDayMonthYear(item.expectedBackDate);
  const created = formatDayMonthYear(item.createdAt);
  return (
    <tr className="border-b border-border align-top hover:bg-surface-muted">
      <td className="py-3 px-3">
        <p className="eyebrow">{itemEquipment(item).category}</p>
        <p className="text-sm font-medium text-ink mt-0.5">
          {itemEquipment(item).name}
          {itemEquipment(item).qty > 1 ? ` ×${itemEquipment(item).qty}` : ""}
        </p>
      </td>
      <td className="py-3 px-3 text-xs mono-num text-ink-2 whitespace-nowrap">
        {bookingRef(item.sourceBookingId)}
      </td>
      <td className="py-3 px-3 text-[13px] text-ink-2 whitespace-nowrap">
        {REASON_LABEL[item.reason]}
      </td>
      <td className="py-3 px-3 text-[13px] text-ink-2 max-w-[280px]">
        <span className="block break-words">{item.comment || "—"}</span>
      </td>
      <td className="py-3 px-3 text-xs text-ink-2 whitespace-nowrap">
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
  const { authorized, loading: authLoading } = useRequireRole([
    "SUPER_ADMIN",
    "WAREHOUSE",
  ]);

  const [items, setItems] = useState<ProblemItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");

  // Resolve-модалка
  const [resolveTarget, setResolveTarget] = useState<ProblemItem | null>(null);
  const [resolveOutcome, setResolveOutcome] = useState<ResolveOutcome>("FOUND");
  const [resolving, setResolving] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      setFetching(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (statusFilter) params.set("status", statusFilter);
        params.set("limit", "50");
        if (cursor) params.set("cursor", cursor);
        const data = await apiFetch<ProblemItemsResponse>(
          `/api/problem-items?${params.toString()}`,
        );
        setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Ошибка загрузки");
      } finally {
        setFetching(false);
      }
    },
    [statusFilter],
  );

  // Первичная загрузка + рефетч при смене фильтра. cancelled-flag — защита
  // от set-state после размонтирования / обгоняющего ответа.
  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    setFetching(true);
    setError(null);
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    apiFetch<ProblemItemsResponse>(`/api/problem-items?${params.toString()}`)
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
  }, [authorized, statusFilter]);

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

  return (
    <div className="p-4 md:p-6 space-y-4 w-full">
      {/* Заголовок */}
      <div>
        <p className="eyebrow">Склад</p>
        <h1 className="text-[22px] font-semibold text-ink mt-0.5 tracking-tight">
          Потеряшки
        </h1>
        <p className="text-[13px] text-ink-3 mt-0.5">
          Реестр проблемных единиц — заявки на поиск и разбор
        </p>
      </div>

      {/* Фильтр-пилюли */}
      <div className="bg-surface border border-border rounded-[10px] px-4 py-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Фильтр по статусу">
          {FILTER_PILLS.map((pill) => {
            const active = statusFilter === pill.value;
            return (
              <button
                key={pill.value || "all"}
                type="button"
                onClick={() => setStatusFilter(pill.value)}
                aria-pressed={active}
                className={`inline-flex h-9 items-center rounded-md border px-3 text-[13px] transition-colors ${
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
      {isEmpty && (
        <div className="bg-surface border border-border rounded-lg p-10 text-center shadow-xs">
          <p className="text-sm text-ink-2 font-medium">Потеряшек нет</p>
          <p className="text-[13px] text-ink-3 mt-1">
            Проблемные единицы с приёмки появятся здесь автоматически
          </p>
        </div>
      )}

      {/* Список — таблица (desktop) */}
      {!isEmpty && items.length > 0 && (
        <>
          <div className="hidden md:block bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
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
                    <ProblemRow key={item.id} item={item} onResolve={openResolve} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Список — карточки (mobile) */}
          <div className="md:hidden space-y-3">
            {items.map((item) => (
              <ProblemCard key={item.id} item={item} onResolve={openResolve} />
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

      {/* Resolve-модалка */}
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
    </div>
  );
}
