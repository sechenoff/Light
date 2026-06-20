"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../src/lib/api";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { StatusPill } from "../../../src/components/StatusPill";
import { formatRub } from "../../../src/lib/format";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { toast } from "../../../src/components/ToastProvider";

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
}

const STATUS_LABEL: Record<ArchivedBooking["status"], string> = {
  DRAFT: "Черновик",
  PENDING_APPROVAL: "На согласовании",
  CONFIRMED: "Подтверждено",
  ISSUED: "Выдано",
  RETURNED: "Возвращено",
  CANCELLED: "Отменено",
};

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

  // BL-8: единая функция загрузки вместо дублирующих load() + inline-fetch.
  async function load() {
    try {
      const data = await apiFetch<{ bookings: ArchivedBooking[]; nextCursor: string | null }>(
        "/api/bookings?archived=true&limit=50",
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
        `/api/bookings?archived=true&limit=50&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setRows((prev) => [...(prev ?? []), ...data.bookings]);
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить архив");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (roleLoading || !user) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<{ bookings: ArchivedBooking[]; nextCursor: string | null }>(
          "/api/bookings?archived=true&limit=50",
        );
        if (cancelled) return;
        setRows(data.bookings);
        setNextCursor(data.nextCursor ?? null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить архив");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleLoading, user]);

  async function restore(id: string) {
    setBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}/restore`, { method: "POST" });
      toast.success("Бронь восстановлена");
      await load();
    } catch (err: any) {
      toast.error(err?.message ?? "Не удалось восстановить");
    } finally {
      setBusyId(null);
    }
  }

  async function purge(id: string, projectName: string) {
    const confirmed = window.confirm(
      `Удалить бронь «${projectName}» НАВСЕГДА? Это действие нельзя отменить.\n\n` +
      "Бронь, позиции и связанные финансовые события будут полностью стерты из БД. " +
      "Аудит-запись о финальном удалении сохранится.",
    );
    if (!confirmed) return;
    setBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}/purge`, { method: "DELETE" });
      toast.success("Бронь удалена навсегда");
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
                    В архиве пока пусто.
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
                  <td className="px-3 py-2 text-ink-3 mono-num text-xs">
                    {formatArchivedAt(r.deletedAt)}
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
                        onClick={() => restore(r.id)}
                        disabled={busyId === r.id}
                        className="text-xs rounded border border-emerald-border bg-emerald-soft text-emerald px-2 py-1 hover:bg-emerald hover:text-white transition-colors disabled:opacity-50"
                        title="Вернуть бронь в основной список"
                      >
                        ↺ Восстановить
                      </button>
                      <button
                        type="button"
                        onClick={() => purge(r.id, r.projectName || "—")}
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
    </div>
  );
}
