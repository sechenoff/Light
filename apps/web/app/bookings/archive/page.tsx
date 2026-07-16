"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../src/lib/api";
import { BOOKING_STATUS_LABELS as STATUS_LABEL } from "../../../src/lib/bookingConstants";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { StatusPill } from "../../../src/components/StatusPill";
import { formatRub } from "../../../src/lib/format";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { toast } from "../../../src/components/ToastProvider";
import { ConfirmActionModal } from "../../../src/components/bookings/ConfirmActionModal";

interface ArchivedBooking {
  id: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  projectName: string;
  startDate: string;
  endDate: string;
  client: { id: string; name: string };
  finalAmount?: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  /** Имя (username) того, кто архивировал — резолвится сервером из deletedBy. */
  deletedByName?: string | null;
}

/** Заголовок для модалок: дата · клиент · проект. */
function archivedTitle(r: ArchivedBooking): string {
  const project =
    r.projectName?.trim() && r.projectName.trim() !== "Проект" ? r.projectName.trim() : null;
  return [formatShiftDate(r.startDate), r.client.name, project].filter(Boolean).join(" · ");
}

function formatShiftDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Moscow",
  });
}

function formatArchivedAt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
}

export default function BookingsArchivePage() {
  const { user, loading: roleLoading } = useRequireRole(["SUPER_ADMIN"]);
  const [rows, setRows] = useState<ArchivedBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // BL-5: архив раньше грузился одним запросом limit=200 без пагинации — при >200
  // архивных броней остальные молча обрезались. Теперь курсорная пагинация (как
  // в основном списке): первая страница + «Загрузить ещё».
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Подтверждения: restore — обычное (бронь может вернуться в CONFIRMED/ISSUED
  // и потребовать резервов), purge — typed-confirm (необратимое стирание из БД).
  const [restoreRow, setRestoreRow] = useState<ArchivedBooking | null>(null);
  const [purgeRow, setPurgeRow] = useState<ArchivedBooking | null>(null);
  // Фильтры архива (раньше их не было — искать удалённую бронь среди сотен
  // было нечем). Тот же серверный API, что и у основного списка.
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  function buildArchiveParams(cursor?: string): string {
    const params = new URLSearchParams({ archived: "true", limit: "50" });
    if (cursor) params.set("cursor", cursor);
    if (statusFilter) params.set("status", statusFilter);
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    return params.toString();
  }

  // BL-8: единая функция загрузки вместо дублирующих load() + inline-fetch.
  async function load() {
    try {
      const data = await apiFetch<{ bookings: ArchivedBooking[]; nextCursor: string | null }>(
        `/api/bookings?${buildArchiveParams()}`,
      );
      setRows(data.bookings);
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить архив");
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await apiFetch<{ bookings: ArchivedBooking[]; nextCursor: string | null }>(
        `/api/bookings?${buildArchiveParams(nextCursor)}`,
      );
      setRows((prev) => [...(prev ?? []), ...data.bookings]);
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить архив");
    } finally {
      setLoadingMore(false);
    }
  }

  // Дебаунс поиска (300 мс) → searchQuery → серверный запрос.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (roleLoading || !user) return;
    let cancelled = false;
    setRows(null);
    void (async () => {
      try {
        const data = await apiFetch<{ bookings: ArchivedBooking[]; nextCursor: string | null }>(
          `/api/bookings?${buildArchiveParams()}`,
        );
        if (cancelled) return;
        setRows(data.bookings);
        setNextCursor(data.nextCursor ?? null);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить архив");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleLoading, user, statusFilter, searchQuery]);

  async function doRestore(id: string) {
    setBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}/restore`, { method: "POST" });
      toast.success("Бронь восстановлена");
      setRestoreRow(null);
      await load();
    } catch (err: any) {
      toast.error(err?.message ?? "Не удалось восстановить");
    } finally {
      setBusyId(null);
    }
  }

  async function doPurge(id: string) {
    setBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}/purge`, { method: "DELETE" });
      toast.success("Бронь удалена навсегда");
      setPurgeRow(null);
      await load();
    } catch (err: any) {
      toast.error(err?.message ?? "Не удалось удалить");
    } finally {
      setBusyId(null);
    }
  }

  if (roleLoading || !user) return <div className="p-8 text-ink-3">Загрузка...</div>;

  return (
    <div className="p-4">
      <SectionHeader
        eyebrow="Архив броней"
        title="Удалённые брони"
        actions={
          <Link
            href="/bookings"
            className="rounded border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-muted transition-colors"
          >
            ← К списку броней
          </Link>
        }
      />

      <div className="mt-3 rounded-lg border border-amber-border bg-amber-soft px-4 py-2.5 text-sm text-ink-2">
        Здесь живут брони, которые были удалены из основного списка. Их ещё
        можно <span className="font-semibold">вернуть в работу</span>, или
        <span className="font-semibold"> удалить навсегда</span> — после этого
        восстановление будет невозможно.
      </div>

      <div className="mt-4 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
        <div className="p-3 border-b border-border flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Поиск по клиенту или проекту"
            aria-label="Поиск по клиенту или проекту"
            className="rounded border border-border px-2 py-1 text-xs bg-surface w-56 max-w-full"
          />
          <select
            className="rounded border border-border px-2 py-1 text-xs bg-surface"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">Все статусы</option>
            <option value="DRAFT">Черновик</option>
            <option value="PENDING_APPROVAL">На согласовании</option>
            <option value="CONFIRMED">Подтверждена</option>
            <option value="ISSUED">Выдана</option>
            <option value="RETURNED">Возвращена</option>
            <option value="CANCELLED">Отменена</option>
          </select>
          {(searchInput || statusFilter) && (
            <button
              type="button"
              onClick={() => { setSearchInput(""); setSearchQuery(""); setStatusFilter(""); }}
              className="text-xs text-accent hover:underline"
            >
              Сбросить
            </button>
          )}
        </div>
        <div className="overflow-auto">
          <table className="min-w-[920px] w-full text-sm">
            <thead className="bg-slate--soft text-ink-2 border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Дата смены</th>
                <th className="text-left px-3 py-2 font-medium">Клиент</th>
                <th className="text-left px-3 py-2 font-medium">Проект</th>
                <th className="text-left px-3 py-2 font-medium">Статус</th>
                <th className="text-right px-3 py-2 font-medium">Сумма</th>
                <th className="text-left px-3 py-2 font-medium">Архивировано</th>
                <th className="px-3 py-2 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && !error && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-ink-3">
                    Загрузка...
                  </td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-rose">
                    {error}
                  </td>
                </tr>
              )}
              {rows && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-ink-3">
                    {searchQuery || statusFilter
                      ? "Ничего не найдено под текущими фильтрами."
                      : "В архиве пока пусто."}
                  </td>
                </tr>
              )}
              {rows?.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-surface-muted transition-colors"
                >
                  <td className="px-3 py-2 text-ink-2 whitespace-nowrap mono-num">
                    {formatShiftDate(r.startDate)}
                  </td>
                  <td className="px-3 py-2 text-ink-2">{r.client.name}</td>
                  <td className="px-3 py-2">
                    {r.projectName?.trim() === "Проект" || !r.projectName?.trim() ? (
                      <span className="text-ink-3">Без названия</span>
                    ) : (
                      <span className="text-ink-2">{r.projectName}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill variant="view" label={STATUS_LABEL[r.status]} />
                  </td>
                  <td className="px-3 py-2 text-right mono-num text-ink">
                    {formatRub(r.finalAmount ?? "0")}
                  </td>
                  <td className="px-3 py-2 text-ink-3 mono-num text-xs whitespace-nowrap">
                    <div>{formatArchivedAt(r.deletedAt)}</div>
                    {r.deletedByName && (
                      <div className="text-ink-3">кто: {r.deletedByName}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/bookings/${r.id}`}
                        className="text-xs text-accent-bright hover:text-accent font-medium"
                      >
                        Открыть
                      </Link>
                      <button
                        type="button"
                        onClick={() => setRestoreRow(r)}
                        disabled={busyId === r.id}
                        className="text-xs rounded border border-emerald-border bg-emerald-soft text-emerald px-2 py-1 hover:bg-emerald hover:text-white transition-colors disabled:opacity-50"
                        title="Вернуть бронь в основной список"
                      >
                        ↺ Восстановить
                      </button>
                      <button
                        type="button"
                        onClick={() => setPurgeRow(r)}
                        disabled={busyId === r.id}
                        className="text-xs rounded border border-rose-border bg-rose-soft text-rose px-2 py-1 hover:bg-rose hover:text-white transition-colors disabled:opacity-50"
                        title="Удалить из БД навсегда"
                      >
                        🗑 Удалить навсегда
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextCursor && (
          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-40"
            >
              {loadingMore ? "Загружаю..." : "Загрузить ещё"}
            </button>
          </div>
        )}
      </div>

      <ConfirmActionModal
        open={restoreRow !== null}
        title="Восстановление брони"
        subtitle={restoreRow ? archivedTitle(restoreRow) : undefined}
        message={
          "Вернуть бронь в основной список?\n\nОна восстановится с прежним статусом. Если статус активный (подтверждена/выдана), проверьте, что оборудование на её даты свободно."
        }
        confirmLabel="Восстановить"
        tone="primary"
        loading={restoreRow !== null && busyId === restoreRow.id}
        onClose={() => setRestoreRow(null)}
        onConfirm={() => {
          if (restoreRow) doRestore(restoreRow.id);
        }}
      />

      <ConfirmActionModal
        open={purgeRow !== null}
        title="Удалить навсегда"
        subtitle={purgeRow ? archivedTitle(purgeRow) : undefined}
        message={
          "Бронь, позиции и связанные финансовые события будут полностью стёрты из БД — это действие нельзя отменить. Аудит-запись о финальном удалении сохранится."
        }
        confirmLabel="Удалить навсегда"
        tone="danger"
        requireTyped="УДАЛИТЬ"
        loading={purgeRow !== null && busyId === purgeRow.id}
        onClose={() => setPurgeRow(null)}
        onConfirm={() => {
          if (purgeRow) doPurge(purgeRow.id);
        }}
      />
    </div>
  );
}
