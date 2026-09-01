"use client";

/**
 * Мастерская · очередь ремонтов.
 *
 * Экран отвечает на один вопрос — что горит. Очередь отсортирована не по дате
 * заведения, а по тому, сорвёт ли ремонт бронь: сверху сирена с конкретными
 * бронями и именами гафферов, ниже светофор, потом три группы (срывают брони →
 * требуют внимания → свёрнутый спокойный хвост).
 *
 * Закрытые карточки в очередь не попадают вообще: разделение серверное
 * (`?active=true|false`), архив листается отдельным курсором.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { useRequireRole } from "../../src/hooks/useRequireRole";
import { formatRub, pluralize } from "../../src/lib/format";
import { toast } from "../../src/components/ToastProvider";
import { apiFetch } from "../../src/lib/api";
import { AddRepairModal } from "../../src/components/repair/AddRepairModal";
import { RepairIcon, RepairStatusPill } from "../../src/components/repair/RepairRiskBadge";
import { RepairQueueRow, RepairTailRow } from "../../src/components/repair/RepairQueueRow";
import {
  RepairNextUp,
  RepairPickupLine,
  RepairSiren,
  RepairSummaryStrip,
} from "../../src/components/repair/RepairSignals";
import { useRepairQueue } from "../../src/components/repair/useRepairQueue";
import {
  compareByRisk,
  daysAgo,
  formatDayMonth,
  isQuiet,
  lastActivityAt,
  moscowDaysBetween,
  type QueueFilter,
  type RepairListItem,
  type RepairSort,
} from "../../src/components/repair/types";

const ALL_ROLES = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;

const SORTS: { key: RepairSort; label: string }[] = [
  { key: "risk", label: "По риску" },
  { key: "date", label: "По дате" },
  { key: "eta", label: "По сроку возврата" },
];

const GROUP_BTN =
  "border-r border-border px-2.5 py-1 text-[11px] font-semibold leading-[1.6] text-ink-2 transition-colors last:border-r-0 hover:bg-surface-muted";
const GROUP_BTN_ON = "bg-accent text-surface hover:bg-accent";

function GroupHeader({
  tone,
  title,
  count,
  note,
}: {
  tone: "hot" | "warm";
  title: string;
  count: number;
  note: string;
}) {
  return (
    <div className="mt-4 mb-1.5 flex items-center gap-2.5">
      <RepairIcon
        name={tone === "hot" ? "alert" : "clock"}
        large
        className={tone === "hot" ? "text-rose" : "text-amber"}
      />
      <h2 className={`font-cond text-sm font-bold leading-tight ${tone === "hot" ? "text-rose" : "text-amber"}`}>
        {title}
      </h2>
      <span className="mono-num text-[11.5px] font-semibold text-ink-3">{count}</span>
      <span className="h-px flex-1 bg-border" />
      <span className="hidden text-[11.5px] text-ink-3 md:inline">{note}</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="mt-4 flex flex-col gap-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-surface px-3.5 py-3 shadow-xs">
          <div className="h-4 w-48 animate-pulse rounded bg-surface-muted" />
          <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-surface-muted" />
          <div className="mt-2 h-6 w-full animate-pulse rounded bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}

export default function RepairQueuePage() {
  const { user, loading: authLoading } = useRequireRole(
    ALL_ROLES as unknown as ("SUPER_ADMIN" | "WAREHOUSE" | "TECHNICIAN")[],
  );

  const queue = useRepairQueue({ enabled: Boolean(user), currentUserId: user?.userId });
  const [addOpen, setAddOpen] = useState(false);
  const [tailOpen, setTailOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  // Брать ремонт в работу и назначать срок могут те, кто чинит: SA и техник.
  const canTake = user?.role === "SUPER_ADMIN" || user?.role === "TECHNICIAN";
  const canSetEta = canTake;

  const blocking = useMemo(
    () =>
      queue.active
        .filter((r) => r.risk.level === "BLOCKS")
        .sort((a, b) =>
          (a.risk.booking?.startDate ?? "").localeCompare(b.risk.booking?.startDate ?? ""),
        ),
    [queue.active],
  );

  // Молчащие — дольше молчащая первой: её имя уходит в подпись плитки.
  const quiet = useMemo(
    () =>
      queue.active
        .filter(isQuiet)
        .sort((a, b) => daysAgo(lastActivityAt(b)) - daysAgo(lastActivityAt(a))),
    [queue.active],
  );

  const noEtaCount = useMemo(
    () => queue.active.filter((r) => r.expectedReadyAt === null).length,
    [queue.active],
  );

  const unassigned = useMemo(
    () => queue.active.filter((r) => r.assignedTo === null).sort(compareByRisk),
    [queue.active],
  );

  const counts = useMemo(
    () => ({
      all: queue.active.length,
      mine: user?.userId ? queue.active.filter((r) => r.assignedTo === user.userId).length : 0,
      urgent: queue.active.filter((r) => r.urgency === "URGENT").length,
      quiet: quiet.length,
      unassigned: unassigned.length,
    }),
    [queue.active, user?.userId, unassigned.length, quiet.length],
  );

  const filters: { key: QueueFilter; label: string; count: number; always: boolean }[] = [
    { key: "all", label: "Все", count: counts.all, always: true },
    { key: "mine", label: "Моя очередь", count: counts.mine, always: true },
    { key: "urgent", label: "Срочные", count: counts.urgent, always: true },
    { key: "quiet", label: "Молчат", count: counts.quiet, always: true },
    // «Ничейные» — состояние, в которое уводит врезка «Взять следующее»;
    // отдельной постоянной пилюли у него в макете нет.
    { key: "unassigned", label: "Ничейные", count: counts.unassigned, always: false },
  ];

  async function handleWriteOff(id: string) {
    if (!window.confirm("Списать единицу? Она уйдёт из парка навсегда.")) return;
    try {
      await apiFetch(`/api/repairs/${id}/write-off`, { method: "POST" });
      toast.success("Единица списана");
      queue.reload();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Не удалось списать единицу");
    }
  }

  async function handleTake(id: string) {
    try {
      await queue.takeRepair(id);
      toast.success("Ремонт взят в работу");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Не удалось взять ремонт");
    }
  }

  const rowActions = {
    canTake,
    canSetEta,
    canWriteOff: Boolean(isSuperAdmin),
    onTake: handleTake,
    onSetEta: queue.setEta,
    onWriteOff: handleWriteOff,
  };

  if (authLoading || !user) {
    return (
      <div className="flex min-h-[200px] items-center justify-center p-6">
        <span className="text-sm text-ink-3">Загрузка…</span>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6">
      {/* ── Шапка ── */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-3">
        <div>
          <p className="eyebrow">Мастерская</p>
          <h1 className="mt-0.5 font-cond text-2xl font-bold leading-tight tracking-[-0.01em]">
            Ремонты
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              const next = !archiveOpen;
              setArchiveOpen(next);
              // Первую страницу тянем только при первом раскрытии: повторное
              // открытие не должно молча дозагружать следующую.
              if (next && queue.archive.items.length === 0) queue.archive.loadMore();
            }}
            className="whitespace-nowrap text-[11.5px] font-semibold text-accent-bright hover:text-accent hover:underline"
          >
            Починенные и списанные →
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded border border-accent-bright bg-accent-bright px-3 py-1 text-xs font-semibold text-surface transition-colors hover:border-accent hover:bg-accent"
          >
            <RepairIcon name="plus" />
            Завести поломку
          </button>
        </div>
      </header>

      {queue.error && (
        <div className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-sm text-rose">
          {queue.error}
        </div>
      )}

      {/* ── 1 · Сирена ── */}
      {!queue.loading && <RepairSiren blocking={blocking} />}

      {/* ── 2 · Светофор и деньги ── */}
      {queue.stats && (
        <RepairSummaryStrip
          stats={queue.stats}
          blocking={blocking}
          quiet={quiet}
          noEtaCount={noEtaCount}
          onApproveExpense={queue.approveExpense}
        />
      )}

      {/* ── 3 · Очередь ── */}
      {/* Сортировка и счётчик — работа за столом: с телефона остаются только
          фильтры, и они листаются вбок, чтобы страница не ехала горизонтально. */}
      <div className="mt-4 flex items-center gap-2 overflow-x-auto border-b border-border pb-2 md:flex-wrap md:overflow-x-visible">
        <span className="eyebrow hidden shrink-0 md:inline">Сортировка</span>
        <div
          className="hidden shrink-0 overflow-hidden rounded border border-border bg-surface md:inline-flex"
          role="group"
          aria-label="Сортировка очереди"
        >
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={queue.sort === s.key}
              onClick={() => queue.setSort(s.key)}
              className={`${GROUP_BTN} ${queue.sort === s.key ? GROUP_BTN_ON : ""}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div
          className="inline-flex shrink-0 overflow-hidden rounded border border-border bg-surface"
          role="group"
          aria-label="Фильтр очереди"
        >
          {filters
            .filter((f) => f.always || queue.filter === f.key)
            .map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={queue.filter === f.key}
                onClick={() => queue.setFilter(f.key)}
                className={`${GROUP_BTN} whitespace-nowrap ${queue.filter === f.key ? GROUP_BTN_ON : ""}`}
              >
                {f.label} <span className="mono-num">{f.count}</span>
              </button>
            ))}
        </div>
        <span className="eyebrow ml-auto hidden shrink-0 whitespace-nowrap md:inline">
          {counts.all}{" "}
          {pluralize(counts.all, "открытый ремонт", "открытых ремонта", "открытых ремонтов")}
        </span>
      </div>

      {/* Точка входа техника: самое рискованное из ничейного. */}
      {!queue.loading && canTake && unassigned.length > 0 && (
        <RepairNextUp
          repair={unassigned[0]}
          unassignedCount={unassigned.length}
          onTake={handleTake}
          onShowUnassigned={() => queue.setFilter("unassigned")}
        />
      )}

      {queue.loading ? (
        <SkeletonRows />
      ) : queue.visible.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-ink-3">
          {queue.filter === "all"
            ? "Нет активных ремонтов"
            : "Нет ремонтов по выбранному фильтру"}
        </div>
      ) : (
        <>
          {queue.groups.hot.length > 0 && (
            <>
              <GroupHeader
                tone="hot"
                title="Срывают брони"
                count={queue.groups.hot.length}
                note="подмены нет и к сроку брони не успеваем"
              />
              <div className="flex flex-col gap-2">
                {queue.groups.hot.map((r) => (
                  <RepairQueueRow key={r.id} repair={r} tone="hot" actions={rowActions} />
                ))}
              </div>
            </>
          )}

          {queue.groups.warm.length > 0 && (
            <>
              <GroupHeader
                tone="warm"
                title="Требуют внимания"
                count={queue.groups.warm.length}
                note="молчат, просрочены или без срока — но бронь пока не под ударом"
              />
              <div className="flex flex-col gap-2">
                {queue.groups.warm.map((r) => (
                  <RepairQueueRow key={r.id} repair={r} tone="warm" actions={rowActions} />
                ))}
              </div>
            </>
          )}

          {queue.groups.calm.length > 0 && (
            <section className="mt-3.5 overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
              <button
                type="button"
                onClick={() => setTailOpen((v) => !v)}
                aria-expanded={tailOpen}
                className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] text-ink-2 ${
                  tailOpen ? "border-b border-border bg-surface-muted" : ""
                }`}
              >
                <RepairIcon name="chev" className={tailOpen ? "rotate-90" : ""} />
                <b className="font-semibold text-ink">
                  Ещё {queue.groups.calm.length}{" "}
                  {pluralize(queue.groups.calm.length, "ремонт", "ремонта", "ремонтов")} без риска
                </b>
                <span className="hidden text-ink-3 md:inline">
                  — подмена есть, срок назначен, работы идут
                </span>
                <span className="ml-auto text-[11.5px] font-semibold text-accent-bright">
                  {tailOpen ? "Свернуть" : "Показать"}
                </span>
              </button>
              {tailOpen && (
                <div>
                  {queue.groups.calm.map((r) => (
                    <RepairTailRow key={r.id} repair={r} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* Починенное лежит на верстаке, а в системе уже «в наличии» — за ним
          бегут в последний момент на выдаче. */}
      {queue.stats && <RepairPickupLine items={queue.stats.readyForPickup} />}

      {/* ── 4 · Архив ── */}
      {archiveOpen && (
        <ArchiveSection
          items={queue.archive.items}
          loading={queue.archive.loading}
          hasMore={queue.archive.hasMore}
          onLoadMore={queue.archive.loadMore}
          showCost={Boolean(isSuperAdmin)}
        />
      )}

      <AddRepairModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={queue.reload}
      />
    </div>
  );
}

// ── Архив: починенные и списанные ────────────────────────────────────────────

function ArchiveSection({
  items,
  loading,
  hasMore,
  onLoadMore,
  showCost,
}: {
  items: RepairListItem[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Суммы запчастей — только руководителю: у техника денег на экране нет. */
  showCost: boolean;
}) {
  const cols = showCost
    ? "grid-cols-[minmax(0,1fr)_90px] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px_100px_80px]"
    : "grid-cols-[minmax(0,1fr)_90px] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px_100px]";

  return (
    <section className="mt-5">
      <p className="eyebrow mb-1.5">Починенные и списанные</p>
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className={`grid ${cols} gap-2.5 border-b border-border bg-surface-muted px-3.5 py-1.5`}>
          <p className="eyebrow">Позиция</p>
          <p className="eyebrow hidden md:block">Поломка</p>
          <p className="eyebrow hidden md:block">В работе</p>
          <p className="eyebrow">Результат</p>
          {showCost && <p className="eyebrow hidden md:block">Запчасти</p>}
        </div>

        {items.length === 0 && !loading && (
          <p className="px-3.5 py-6 text-center text-sm text-ink-3">Архив пуст</p>
        )}

        {items.map((r) => {
          const daysWorked = moscowDaysBetween(r.createdAt, r.closedAt ?? new Date().toISOString());
          const cost = Number(r.partsCost);
          return (
            <Link
              key={r.id}
              href={`/repair/${r.id}`}
              className={`grid ${cols} items-center gap-2.5 border-b border-border px-3.5 py-2 last:border-b-0 hover:bg-surface-muted`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">{r.title}</span>
                <span className="block text-[11px] text-ink-3">
                  {r.closedAt ? formatDayMonth(r.closedAt) : "—"}
                </span>
              </span>
              <span className="hidden min-w-0 truncate text-xs text-ink-2 md:block">{r.reason}</span>
              <span className="mono-num hidden text-xs text-ink-2 md:block">
                {daysWorked} {pluralize(daysWorked, "день", "дня", "дней")}
              </span>
              <span>
                <RepairStatusPill status={r.status} />
              </span>
              {showCost && (
                <span className="mono-num hidden text-xs text-ink-2 md:block">
                  {cost > 0 ? formatRub(cost) : "—"}
                </span>
              )}
            </Link>
          );
        })}

        {hasMore && (
          <div className="px-3.5 py-2 text-center">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface px-3 py-1 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright disabled:opacity-50"
            >
              {loading ? "Загружаем…" : "Показать ещё"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
