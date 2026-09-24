"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../src/lib/api";
import { BOOKING_STATUS_LABELS as STATUS_LABEL } from "../../../src/lib/bookingConstants";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { StatusPill } from "../../../src/components/StatusPill";
import { formatRub } from "../../../src/lib/format";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { toast } from "../../../src/components/ToastProvider";
import { ConfirmActionModal } from "../../../src/components/bookings/ConfirmActionModal";
import { useBookingSelection } from "../../../src/components/bookings/useBookingSelection";
import {
  ArchiveBulkActionBar,
  type ArchiveBulkAction,
} from "../../../src/components/bookings/ArchiveBulkActionBar";
import { BulkResultModal, type BulkFailure } from "../../../src/components/bookings/BulkResultModal";
import { pluralBookings } from "../../../src/components/bookings/bulkActions";
import { BULK_MAX_IDS } from "../../../src/components/bookings/bulkLimits";
import { control } from "../../../src/components/bookings/register/RegisterFilters";

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

type BulkApiResult = {
  results: Array<{ id: string; ok: boolean; status?: string; code?: string; message?: string }>;
  counts: { total: number; ok: number; failed: number };
};

/** Название проекта или null, если его нет (пусто или заглушка «Проект»). */
function projectTitle(r: ArchivedBooking): string | null {
  const name = r.projectName?.trim();
  return name && name !== "Проект" ? name : null;
}

/** Заголовок для модалок и отчёта: дата · клиент · проект. */
function archivedTitle(r: ArchivedBooking): string {
  return [formatShiftDate(r.startDate), r.client.name, projectTitle(r)].filter(Boolean).join(" · ");
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

  // Мультивыбор чекбоксами + групповые «Восстановить» / «Удалить навсегда».
  // Тот же селекшн-хук, что и на /bookings: смена фильтра подрезает выбор,
  // «Загрузить ещё» сохраняет.
  const selection = useBookingSelection(rows ?? []);
  // Между подтверждением и запуском держим сам список id И подписи строк:
  // набор строк мог измениться (дозагрузка, фоновая перезагрузка), а
  // подтверждали конкретную выборку — отчёт должен подписывать именно её.
  const [bulkConfirm, setBulkConfirm] = useState<null | {
    action: ArchiveBulkAction;
    ids: string[];
    titles: Record<string, string>;
  }>(null);
  const [bulkBusy, setBulkBusy] = useState<ArchiveBulkAction | null>(null);
  const [bulkReport, setBulkReport] = useState<null | {
    actionLabel: string;
    okCount: number;
    failures: BulkFailure[];
  }>(null);

  // Зеркала актуального состояния для чтения ПОСЛЕ await в runBulk: замыкание
  // на rows/nextCursor фиксируется в момент клика и не видит конкурентных
  // изменений (дозагрузка страницы, дебаунс-поиск) — рефы видят.
  const rowsRef = useRef<ArchivedBooking[] | null>(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const nextCursorRef = useRef<string | null>(nextCursor);
  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);

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

  /** Клик по кнопке панели → подтверждение по конкретной выборке. */
  function requestBulk(action: ArchiveBulkAction) {
    // Пока идёт одиночное или групповое действие — не даём собрать пачку по
    // устаревшей выборке (бар и так задизейблен, это страховка).
    if (bulkBusy !== null || busyId !== null) return;
    // Порядок id — по порядку строк списка: отчёт читается сверху вниз.
    const chosen = (rows ?? []).filter((r) => selection.selected.has(r.id));
    if (chosen.length === 0) return;
    setBulkConfirm({
      action,
      ids: chosen.map((r) => r.id),
      titles: Object.fromEntries(chosen.map((r) => [r.id, archivedTitle(r)])),
    });
  }

  async function runBulk() {
    if (!bulkConfirm) return;
    const { action, titles } = bulkConfirm;
    const actionLabel = action === "restore" ? "Восстановление" : "Удаление навсегда";
    // Подтверждали выборку из прошлого рендера — пересекаем с актуальными
    // строками: бронь могли успеть восстановить/удалить одиночной кнопкой.
    const liveIds = new Set((rowsRef.current ?? []).map((r) => r.id));
    const ids = bulkConfirm.ids.filter((id) => liveIds.has(id));
    if (ids.length === 0) {
      toast.error("Выбранные брони уже обработаны — список обновился");
      setBulkConfirm(null);
      return;
    }
    setBulkBusy(action);
    try {
      const data = await apiFetch<BulkApiResult>("/api/bookings/bulk", {
        method: "POST",
        body: JSON.stringify({ action, ids }),
      });

      const succeeded = data.results.filter((r) => r.ok);
      const failed = data.results.filter((r) => !r.ok);

      // Успешные строки покидают архив в обоих случаях: восстановленная бронь
      // больше не архивная, удалённой не существует. Обновление функциональное
      // + рефы: конкурентная дозагрузка страницы не должна быть затёрта
      // снапшотом из замыкания.
      const removedIds = new Set(succeeded.map((r) => r.id));
      const remainingCount = (rowsRef.current ?? []).filter((r) => !removedIds.has(r.id)).length;
      setRows((prev) => (prev ? prev.filter((r) => !removedIds.has(r.id)) : prev));
      selection.deselect(succeeded.map((r) => r.id));

      if (failed.length === 0) {
        // Числонезависимая форма («…: готово — 1 бронь») — как на /bookings:
        // «Восстановлено 1 бронь» ломало согласование рода.
        toast.success(`${actionLabel}: готово — ${succeeded.length} ${pluralBookings(succeeded.length)}`);
      } else {
        setBulkReport({
          actionLabel,
          okCount: succeeded.length,
          failures: failed.map((f) => ({
            id: f.id,
            code: f.code ?? "BULK_ITEM_FAILED",
            message: f.message ?? "Не удалось выполнить",
            title: titles[f.id] ?? "Бронь",
          })),
        });
      }

      // Перечитываем список, если: (а) действие вычистило всю загруженную
      // страницу при живом курсоре — иначе список врал бы «в архиве пусто»;
      // (б) purge удалил строку-курсор — сервер резолвит курсор по id, и
      // «Загрузить ещё» с курсором на стёртую бронь молча оборвал бы
      // пагинацию пустой страницей.
      const cursor = nextCursorRef.current;
      const cursorPurged = action === "purge" && cursor !== null && removedIds.has(cursor);
      if ((remainingCount === 0 && cursor) || cursorPurged) {
        await load();
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось выполнить групповое действие");
    } finally {
      setBulkBusy(null);
      setBulkConfirm(null);
    }
  }

  if (roleLoading || !user) return <div className="p-8 text-ink-3">Загрузка...</div>;

  const anyBusy = bulkBusy !== null || busyId !== null;

  return (
    <div className={`p-4 lg:p-6 ${selection.selected.size > 0 ? "pb-32" : ""}`}>
      <SectionHeader
        eyebrow="Архив броней"
        title="Удалённые брони"
        actions={
          <Link
            href="/bookings"
            className="inline-flex min-h-10 items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-muted transition-colors"
          >
            ← К списку броней
          </Link>
        }
      />

      <div className="mt-3 rounded-lg border border-amber-border bg-amber-soft px-4 py-2.5 text-sm text-ink-2">
        Здесь живут брони, которые были удалены из основного списка. Их ещё
        можно <span className="font-semibold">вернуть в работу</span>, или
        <span className="font-semibold"> удалить навсегда</span> — после этого
        восстановление будет невозможно. Отметьте несколько строк чекбоксами,
        чтобы обработать их разом.
      </div>

      <div className="mt-4 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
        <div className="p-3 border-b border-border flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Поиск по клиенту или проекту"
            aria-label="Поиск по клиенту или проекту"
            className={`${control} sm:w-64`}
          />
          <select
            aria-label="Статус брони"
            className={`${control} sm:w-auto`}
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
              className="inline-flex min-h-10 items-center text-xs text-accent hover:underline"
            >
              Сбросить
            </button>
          )}
        </div>
        {/* Загрузка, ошибка и пустое состояние — вне таблицы: ячейка с colSpan
            центрировалась бы по ширине таблицы (960 px), а не по видимой
            карточке, и на узком экране текст уезжал за край. */}
        {rows === null && !error && (
          <p className="px-3 py-6 text-center text-sm text-ink-3">Загрузка...</p>
        )}
        {error && <p className="px-3 py-6 text-center text-sm text-rose">{error}</p>}
        {rows && rows.length === 0 && (
          <p className="px-3 py-10 text-center text-sm text-ink-3">
            {searchQuery || statusFilter
              ? "Ничего не найдено под текущими фильтрами."
              : "В архиве пока пусто."}
          </p>
        )}
        {rows && rows.length > 0 && (
          <>
            {/* До 1280 — карточки; таблица 960 px — с xl, как в реестре броней:
                на 768–1279 с сайдбаром она не помещалась, и «Действия» уезжали
                за край. «Выбрать все» продублирован здесь: в таблице он живёт
                в скрытой шапке. */}
            <label className="flex min-h-10 items-center gap-3 border-b border-border px-3 text-xs text-ink-2 xl:hidden">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer accent-accent-bright"
                checked={selection.allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = selection.someSelected;
                }}
                onChange={selection.toggleAll}
              />
              Выбрать все на странице
            </label>
            <ul className="divide-y divide-border xl:hidden">
              {rows.map((r) => {
                const project = projectTitle(r);
                return (
                  <li
                    key={r.id}
                    className={`flex gap-3 p-3 transition-colors ${
                      selection.selected.has(r.id) ? "bg-accent-soft/40" : ""
                    }`}
                  >
                    <label className="-ml-2 -mt-2.5 flex h-10 w-10 shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-accent-bright"
                        checked={selection.selected.has(r.id)}
                        onChange={() => selection.toggle(r.id)}
                        aria-label={`Выбрать бронь: ${archivedTitle(r)}`}
                      />
                    </label>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-sm font-semibold text-ink">{r.client.name}</div>
                      <div className={`text-xs ${project ? "text-ink-2" : "text-ink-3"}`}>
                        {project ?? "Без названия"}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="mono-num text-ink-2">{formatShiftDate(r.startDate)}</span>
                        <StatusPill variant="view" label={STATUS_LABEL[r.status]} />
                        <span className="mono-num text-ink">{formatRub(r.finalAmount ?? "0")}</span>
                      </div>
                      <div className="text-xs text-ink-3">
                        Архивировано <span className="mono-num">{formatArchivedAt(r.deletedAt)}</span>
                        {r.deletedByName && <>, кто: {r.deletedByName}</>}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Link
                          href={`/bookings/${r.id}`}
                          className="inline-flex min-h-10 items-center text-xs text-accent-bright hover:text-accent font-medium"
                        >
                          Открыть
                        </Link>
                        <button
                          type="button"
                          onClick={() => setRestoreRow(r)}
                          disabled={anyBusy}
                          className="inline-flex min-h-10 items-center text-xs rounded border border-emerald-border bg-emerald-soft text-emerald px-3 hover:bg-emerald hover:text-surface transition-colors disabled:opacity-50"
                        >
                          ↺ Восстановить
                        </button>
                        <button
                          type="button"
                          onClick={() => setPurgeRow(r)}
                          disabled={anyBusy}
                          className="inline-flex min-h-10 items-center text-xs rounded border border-rose-border bg-rose-soft text-rose px-3 hover:bg-rose hover:text-surface transition-colors disabled:opacity-50"
                        >
                          🗑 Удалить навсегда
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="hidden overflow-auto xl:block">
              <table className="min-w-[960px] w-full text-sm">
                <thead className="bg-surface-subtle text-ink-2 border-b border-border">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-accent-bright align-middle"
                        checked={selection.allSelected}
                        ref={(el) => {
                          // indeterminate ставится только из JS, атрибута нет.
                          if (el) el.indeterminate = selection.someSelected;
                        }}
                        onChange={selection.toggleAll}
                        aria-label="Выбрать все архивные брони на странице"
                      />
                    </th>
                    <th className="text-left px-3 py-2 font-medium">Дата смены</th>
                    <th className="text-left px-3 py-2 font-medium">Клиент</th>
                    <th className="text-left px-3 py-2 font-medium">Проект</th>
                    <th className="text-left px-3 py-2 font-medium">Статус</th>
                    <th className="text-right px-3 py-2 font-medium">Сумма</th>
                    <th className="text-left px-3 py-2 font-medium">Архивировано</th>
                    {/* Ширина — под три кнопки в ряд. На 1280 таблице её не
                        хватает, и кнопки переносятся (flex-wrap ниже), а не
                        уезжают за край под горизонтальную прокрутку. */}
                    <th className="w-[22rem] px-3 py-2 font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className={`border-t border-border transition-colors ${
                        selection.selected.has(r.id) ? "bg-accent-soft/40" : "hover:bg-surface-muted"
                      }`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-accent-bright align-middle"
                          checked={selection.selected.has(r.id)}
                          onChange={() => selection.toggle(r.id)}
                          aria-label={`Выбрать бронь: ${archivedTitle(r)}`}
                        />
                      </td>
                      <td className="px-3 py-2 text-ink-2 whitespace-nowrap mono-num">
                        {formatShiftDate(r.startDate)}
                      </td>
                      <td className="px-3 py-2 text-ink-2">{r.client.name}</td>
                      <td className="px-3 py-2">
                        {projectTitle(r) === null ? (
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
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/bookings/${r.id}`}
                            className="whitespace-nowrap text-xs text-accent-bright hover:text-accent font-medium"
                          >
                            Открыть
                          </Link>
                          <button
                            type="button"
                            onClick={() => setRestoreRow(r)}
                            disabled={anyBusy}
                            className="whitespace-nowrap text-xs rounded border border-emerald-border bg-emerald-soft text-emerald px-2 py-1 hover:bg-emerald hover:text-surface transition-colors disabled:opacity-50"
                            title="Вернуть бронь в основной список"
                          >
                            ↺ Восстановить
                          </button>
                          <button
                            type="button"
                            onClick={() => setPurgeRow(r)}
                            disabled={anyBusy}
                            className="whitespace-nowrap text-xs rounded border border-rose-border bg-rose-soft text-rose px-2 py-1 hover:bg-rose hover:text-surface transition-colors disabled:opacity-50"
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
          </>
        )}
        {nextCursor && (
          <div className="py-4 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore || anyBusy}
              className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-40"
            >
              {loadingMore ? "Загружаю..." : "Загрузить ещё"}
            </button>
          </div>
        )}
      </div>

      <ArchiveBulkActionBar
        selectedCount={selection.selected.size}
        busyAction={bulkBusy}
        maxBatch={BULK_MAX_IDS}
        disabled={busyId !== null}
        onRun={requestBulk}
        onClear={selection.clear}
      />

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

      {/* Групповое восстановление — обычное подтверждение. */}
      <ConfirmActionModal
        open={bulkConfirm?.action === "restore"}
        title="Восстановление броней"
        message={
          bulkConfirm
            ? `Вернуть ${bulkConfirm.ids.length} ${pluralBookings(bulkConfirm.ids.length)} в основной список?\n\nКаждая восстановится с прежним статусом. По активным (подтверждена/выдана) проверьте доступность оборудования на их даты.`
            : ""
        }
        confirmLabel="Восстановить"
        tone="primary"
        loading={bulkBusy === "restore"}
        onClose={() => setBulkConfirm(null)}
        onConfirm={runBulk}
      />

      {/* Групповое окончательное удаление — typed-confirm, как одиночное. */}
      <ConfirmActionModal
        open={bulkConfirm?.action === "purge"}
        title="Удалить навсегда"
        message={
          bulkConfirm
            ? `Полностью стереть из БД ${bulkConfirm.ids.length} ${pluralBookings(bulkConfirm.ids.length)} со всеми позициями? Это действие нельзя отменить.\n\nБрони со счетами или платежами сервер не тронет — они попадут в отчёт с причиной.`
            : ""
        }
        confirmLabel="Удалить навсегда"
        tone="danger"
        requireTyped="УДАЛИТЬ"
        loading={bulkBusy === "purge"}
        onClose={() => setBulkConfirm(null)}
        onConfirm={runBulk}
      />

      <BulkResultModal
        open={bulkReport !== null}
        actionLabel={bulkReport?.actionLabel ?? ""}
        okCount={bulkReport?.okCount ?? 0}
        failures={bulkReport?.failures ?? []}
        onClose={() => setBulkReport(null)}
      />
    </div>
  );
}
