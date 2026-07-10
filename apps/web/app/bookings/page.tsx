"use client";

import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "../../src/lib/api";
import {
  bookingStatusLabel as statusText,
  bookingStatusVariant as statusVariant,
} from "../../src/lib/bookingConstants";
import { StatusPill } from "../../src/components/StatusPill";
import { SectionHeader } from "../../src/components/SectionHeader";
import { ClientPickerPopover } from "../../src/components/bookings/ClientPickerPopover";
import { ConfirmActionModal } from "../../src/components/bookings/ConfirmActionModal";
import { CancelWithDepositModal } from "../../src/components/finance/CancelWithDepositModal";
import {
  filtersToQueryString,
  formatBookingPeriod,
  formatShiftDate,
  paymentPill,
  paymentTooltip,
  readListFiltersFromParams,
} from "../../src/components/bookings/bookingListHelpers";
import { formatRub, formatWaitingTime, pluralize } from "../../src/lib/format";
import { toast } from "../../src/components/ToastProvider";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";

type BookingItemMini = {
  id: string;
  equipmentId: string;
  quantity: number;
  equipment: { id: string; name: string; category: string };
};

type BookingRow = {
  id: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  paymentStatus: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";
  projectName: string;
  startDate: string;
  endDate: string;
  displayName: string;
  client: { id: string; name: string };
  items: BookingItemMini[];
  amountPaid: string;
  amountOutstanding: string;
  finalAmount: string;
  expectedPaymentDate: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasScanSessions?: boolean;
  lastScanOperation?: "ISSUE" | "RETURN" | null;
  lastScanStatus?: string | null;
};

// Чистый заголовок строки для модалок: дата · клиент · проект (без суммы).
function bookingRowTitle(r: BookingRow): string {
  const project =
    r.projectName?.trim() && r.projectName.trim() !== "Проект" ? r.projectName.trim() : null;
  return [formatShiftDate(r.startDate), r.client.name, project].filter(Boolean).join(" · ");
}

function BookingHistoryPageInner() {
  const { user } = useCurrentUser();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [rows, setRows] = useState<BookingRow[]>([]);
  // Все фильтры инициализируются из URL — ссылкой «все неоплаченные за июнь»
  // можно поделиться, F5 и «назад» не сбрасывают контекст фильтрации.
  const [initialFilters] = useState(() => readListFiltersFromParams(searchParams));
  const [statusFilter, setStatusFilter] = useState<string>(initialFilters.status);
  // Бинарный фильтр оплаты: "" — все, "PAID" — оплачено, "UNPAID" — всё остальное.
  const [paymentFilter, setPaymentFilter] = useState<"" | "PAID" | "UNPAID">(initialFilters.paid);
  const [dateFrom, setDateFrom] = useState<string>(initialFilters.from);
  const [dateTo, setDateTo] = useState<string>(initialFilters.to);
  // BL-2: поиск по клиенту/проекту. searchInput — то что печатает оператор;
  // searchQuery — дебаунс-значение, уходящее на сервер (через buildListParams).
  const [searchInput, setSearchInput] = useState<string>(initialFilters.q);
  const [searchQuery, setSearchQuery] = useState<string>(initialFilters.q);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Подтверждение необратимых действий (RETURNED/CANCELLED — терминальные
  // статусы, пути назад через UI нет): «Вернуть» и «Отменить» идут через
  // модалку. «Выдать» остаётся в один клик — переход обратим возвратом.
  const [confirmAction, setConfirmAction] = useState<null | {
    row: BookingRow;
    action: "return" | "cancel";
  }>(null);
  // Отмена ОПЛАЧЕННОЙ брони — как на странице брони: обязательная модалка
  // распоряжения депозитом (возврат / кредит / штраф), не простой cancel.
  const [cancelDepositRow, setCancelDepositRow] = useState<BookingRow | null>(null);
  // Подтверждение отправки в архив — модалкой канона (не браузерный confirm()).
  const [archiveRow, setArchiveRow] = useState<BookingRow | null>(null);
  // Мягкий гард ранней выдачи (409 ISSUE_TOO_EARLY): подтверждение модалкой,
  // при согласии повторяем действие с force: true. Храним строку и текст сервера.
  const [earlyIssue, setEarlyIssue] = useState<null | { row: BookingRow; message: string }>(null);

  const PAGE_SIZE = 50;
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // BL-4: общее число броней под текущим фильтром (с сервера) — для «Показано N из M».
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Все фильтры (статус/оплата/даты) теперь серверные — это даёт полный
  // результат по всей базе, а не по уже подгруженной странице, и согласует
  // поведение фильтров. Курсор-пагинация сохраняется внутри отфильтрованного
  // набора.
  function buildListParams(cursor?: string): string {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    if (statusFilter) params.set("status", statusFilter);
    if (paymentFilter) params.set("paid", paymentFilter);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    return params.toString();
  }

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch<{ bookings: BookingRow[]; nextCursor: string | null; totalCount?: number }>(
          `/api/bookings?${buildListParams()}`,
          { signal: controller.signal }
        );
        if (!isActive) return;
        setRows(data.bookings);
        setNextCursor(data.nextCursor ?? null);
        setTotalCount(data.totalCount ?? null);
      } catch (e: any) {
        const isAbort = e?.name === "AbortError" || e?.message === "signal is aborted without reason";
        if (!isAbort) {
          // eslint-disable-next-line no-console
          console.error("Failed to load bookings", e);
        }
      } finally {
        if (isActive) setLoading(false);
      }
    }
    load();
    return () => {
      isActive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, paymentFilter, dateFrom, dateTo, searchQuery]);

  // BL-2: дебаунс поискового ввода (300 мс) → searchQuery → серверный запрос.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Зеркалим фильтры в URL (router.replace — без засорения истории браузера).
  // Курсор пагинации в URL не живёт: он опак и не имеет смысла в чужой сессии.
  useEffect(() => {
    const qs = filtersToQueryString({
      status: statusFilter,
      paid: paymentFilter,
      from: dateFrom,
      to: dateTo,
      q: searchQuery,
    });
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, paymentFilter, dateFrom, dateTo, searchQuery]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await apiFetch<{ bookings: BookingRow[]; nextCursor: string | null }>(
        `/api/bookings?${buildListParams(nextCursor)}`
      );
      setRows((prev) => [...prev, ...data.bookings]);
      setNextCursor(data.nextCursor ?? null);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("Failed to load more bookings", e);
    } finally {
      setLoadingMore(false);
    }
  }

  async function removeBooking(id: string) {
    setBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.id !== id));
      setArchiveRow(null);
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось отправить бронь в архив");
    } finally {
      setBusyId(null);
    }
  }

  // Точечное обновление одной строки из ответа API — статусное действие не
  // сбрасывает подгруженные страницы и скролл-позицию (паттерн — как
  // оптимистичное обновление клиента в ClientPickerPopover ниже).
  function mergeRowFromApi(id: string, booking: Partial<BookingRow>) {
    setRows((prev) =>
      prev.map((row) =>
        row.id === id
          ? {
              ...row,
              status: booking.status ?? row.status,
              paymentStatus: booking.paymentStatus ?? row.paymentStatus,
              amountPaid: booking.amountPaid ?? row.amountPaid,
              amountOutstanding: booking.amountOutstanding ?? row.amountOutstanding,
              finalAmount: booking.finalAmount ?? row.finalAmount,
              expectedPaymentDate:
                booking.expectedPaymentDate !== undefined
                  ? booking.expectedPaymentDate
                  : row.expectedPaymentDate,
              confirmedAt: booking.confirmedAt !== undefined ? booking.confirmedAt : row.confirmedAt,
              updatedAt: booking.updatedAt ?? row.updatedAt,
            }
          : row,
      ),
    );
  }

  async function runStatusAction(
    id: string,
    action: "confirm" | "issue" | "return" | "cancel",
    opts?: { force?: boolean },
  ) {
    const isForcedRetry = opts?.force === true;
    setBusyId(id);
    try {
      const data = await apiFetch<{ booking: Partial<BookingRow> }>(`/api/bookings/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ action, ...(isForcedRetry ? { force: true } : {}) }),
      });
      mergeRowFromApi(id, data.booking ?? {});
    } catch (e: any) {
      // Мягкий гард ранней выдачи: 409 ISSUE_TOO_EARLY (до начала аренды больше
      // суток). Предупреждаем и при согласии повторяем с force: true — ранняя
      // выдача фиксируется сервером в аудите (forcedEarlyIssue).
      if (action === "issue" && !isForcedRetry && e?.code === "ISSUE_TOO_EARLY") {
        const serverMsg = typeof e?.message === "string" ? e.message : "До начала аренды больше суток.";
        const row = rows.find((r) => r.id === id);
        if (row) setEarlyIssue({ row, message: serverMsg });
        return;
      }
      toast.error(e?.message ?? "Не удалось обновить статус");
    } finally {
      setBusyId(null);
    }
  }

  // Одобрение из списка: PENDING_APPROVAL → CONFIRMED в один клик (SUPER_ADMIN).
  // Отклонение справедливо требует причину (на /bookings/[id]), но одобрение —
  // одно действие, поэтому без модалки. Строка обновляется точечно.
  async function approveBooking(id: string) {
    setBusyId(id);
    try {
      const data = await apiFetch<{ booking: Partial<BookingRow> }>(`/api/bookings/${id}/approve`, {
        method: "POST",
      });
      mergeRowFromApi(id, data.booking ?? {});
      toast.success("Бронь подтверждена, оборудование зарезервировано");
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось одобрить бронь");
    } finally {
      setBusyId(null);
    }
  }

  // После отмены с распоряжением депозитом суммы меняются на сервере —
  // перечитываем ОДНУ бронь и обновляем её строку, не сбрасывая пагинацию.
  async function refreshRow(id: string) {
    try {
      const data = await apiFetch<{ booking: Partial<BookingRow> }>(`/api/bookings/${id}`);
      mergeRowFromApi(id, data.booking ?? {});
    } catch {
      // Не критично: строка обновится при следующей загрузке списка.
    }
  }

  // «Отменить» из списка: оплаченная бронь обязана пройти через модалку
  // распоряжения депозитом (как на /bookings/[id]), иначе — обычное
  // подтверждение отмены.
  function requestCancel(row: BookingRow) {
    if (Number(row.amountPaid ?? "0") > 0) {
      setCancelDepositRow(row);
      return;
    }
    setConfirmAction({ row, action: "cancel" });
  }

  async function handleConfirmAction() {
    if (!confirmAction) return;
    const { row, action } = confirmAction;
    await runStatusAction(row.id, action);
    setConfirmAction(null);
  }

  // Все фильтры теперь серверные — рендерим строки как есть, без клиентского
  // фильтра по подгруженной странице (раньше это давало неполный результат).
  const filteredRows = rows;

  // Один набор действий для десктопной таблицы и мобильных карточек —
  // никакого дрейфа между двумя представлениями.
  function renderRowActions(r: BookingRow) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <Link className="text-xs text-accent-bright hover:text-accent font-medium" href={`/bookings/${r.id}`}>
          Открыть
        </Link>
        {/* Одобрение в один клик для руководителя — снимает ежедневную рутину
            «алерт → список → открыть → одобрить». Отклонение с причиной
            по-прежнему на /bookings/[id]. */}
        {r.status === "PENDING_APPROVAL" && isSuperAdmin ? (
          <button
            type="button"
            className="text-xs rounded border border-emerald-border text-emerald px-2 py-1 hover:bg-emerald-soft disabled:opacity-40"
            disabled={busyId === r.id}
            onClick={() => approveBooking(r.id)}
          >
            Одобрить
          </button>
        ) : null}
        {(["DRAFT", "CONFIRMED"].includes(r.status) || (r.status === "PENDING_APPROVAL" && isSuperAdmin)) ? (
          <Link
            href={`/bookings/${r.id}/edit`}
            title="Редактировать"
            className="text-ink-3 hover:text-ink"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </Link>
        ) : (
          <span className="text-border cursor-not-allowed">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </span>
        )}
        {isSuperAdmin && (
          <button
            type="button"
            title="В архив (можно восстановить из /bookings/archive)"
            className="text-rose hover:text-rose/80 disabled:opacity-40"
            disabled={busyId === r.id}
            onClick={() => setArchiveRow(r)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            </svg>
          </button>
        )}
        {r.status === "CONFIRMED" ? (
          <button
            type="button"
            className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface-muted disabled:opacity-40"
            disabled={busyId === r.id}
            onClick={() => runStatusAction(r.id, "issue")}
          >
            Выдать
          </button>
        ) : null}
        {r.status === "ISSUED" ? (
          <button
            type="button"
            className="text-xs rounded border border-border px-2 py-1 text-ink-2 hover:bg-surface-muted disabled:opacity-40"
            disabled={busyId === r.id}
            onClick={() => setConfirmAction({ row: r, action: "return" })}
          >
            Вернуть
          </button>
        ) : null}
        {/* Гейт зеркалит /bookings/[id] и серверные правила:
            из ISSUED отмена запрещена (allowedActions), оплаченную
            бронь отменяет только SUPER_ADMIN (депозит-мастер и
            /cancel-with-deposit — SA-only). Иначе кладовщик
            проходил бы 3 шага мастера и получал 403/409. */}
        {!["CANCELLED", "RETURNED", "ISSUED"].includes(r.status) &&
        (isSuperAdmin || Number(r.amountPaid ?? "0") === 0) ? (
          <button
            type="button"
            className="text-xs rounded border border-rose-border text-rose px-2 py-1 hover:bg-rose-soft disabled:opacity-40"
            disabled={busyId === r.id}
            onClick={() => requestCancel(r)}
          >
            Отменить
          </button>
        ) : null}
      </div>
    );
  }

  // Пилюля статуса брони + сопутствующие индикаторы (aging, сканирования) —
  // тоже общие для таблицы и карточек.
  function renderStatusCell(r: BookingRow) {
    return (
      <>
        <StatusPill
          variant={statusVariant(r.status)}
          label={statusText(r.status)}
        />
        {r.status === "PENDING_APPROVAL" && (() => {
          // Возраст ожидания считаем от createdAt — единственного стабильного
          // момента: updatedAt сбрасывается любой мутацией брони (правка SA в
          // PENDING_APPROVAL, пересчёт финансов), и «ждёт N дней» никогда не
          // эскалировал бы для реально зависшей брони. Момента submit на Booking
          // нет (schema), createdAt — корректная нижняя граница ожидания.
          const aging = formatWaitingTime(null, r.createdAt);
          return aging ? (
            <div className={`mt-0.5 text-xs ${aging.className}`}>ждёт {aging.text}</div>
          ) : null;
        })()}
        {r.hasScanSessions && (
          <span className="ml-1 inline-block" title={
            r.lastScanOperation === "ISSUE" && r.lastScanStatus === "COMPLETED" ? "Выдача отсканирована" :
            r.lastScanOperation === "RETURN" && r.lastScanStatus === "COMPLETED" ? "Возврат завершён" :
            "Есть сканирования"
          }>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline text-accent-bright">
              <path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><line x1="7" y1="12" x2="17" y2="12" />
            </svg>
          </span>
        )}
      </>
    );
  }

  // Пилюля оплаты: «Оплачено» / «Частично N из M» / «Не оплачено» — термины
  // согласованы с /finance (financeTerms.ts, StatusCell, /finance/debts).
  function renderPaymentCell(r: BookingRow) {
    const pill = paymentPill(r);
    return (
      <>
        <StatusPill variant={pill.variant} label={pill.label} />
        {pill.sub && (
          <div className="mt-0.5 text-xs text-ink-3 mono-num whitespace-nowrap">{pill.sub}</div>
        )}
      </>
    );
  }

  return (
    <div className="p-4">
      <SectionHeader
        eyebrow="Аренда"
        title="Список броней"
        actions={
          <Link href="/bookings/new" className="rounded bg-accent-bright text-white px-4 py-2 text-sm hover:bg-accent transition-colors">
            Создать бронь
          </Link>
        }
      />

      <div className="mt-4 rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <p className="eyebrow">Фильтры</p>
          <div className="flex flex-wrap items-center gap-2">
            {/* BL-2: поиск по клиенту/проекту */}
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Поиск по клиенту или проекту"
              aria-label="Поиск по клиенту или проекту"
              className="rounded border border-border px-2 py-1 text-xs bg-surface w-56 max-w-full"
            />
            <div className="flex items-center gap-2">
              <label className="text-xs text-ink-3">С</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="text-sm border border-border rounded px-2 py-1 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <label className="text-xs text-ink-3">По</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="text-sm border border-border rounded px-2 py-1 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => { setDateFrom(""); setDateTo(""); }}
                  className="text-xs text-accent hover:underline"
                >
                  Сбросить
                </button>
              )}
            </div>
            <select className="rounded border border-border px-2 py-1 text-xs bg-surface" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Все статусы брони</option>
              <option value="DRAFT">Черновик</option>
              <option value="PENDING_APPROVAL">На согласовании</option>
              <option value="CONFIRMED">Подтверждена</option>
              <option value="ISSUED">Выдана</option>
              <option value="RETURNED">Возвращена</option>
              <option value="CANCELLED">Отменена</option>
            </select>
            <select
              className="rounded border border-border px-2 py-1 text-xs bg-surface"
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value as "" | "PAID" | "UNPAID")}
            >
              <option value="">Все статусы оплаты</option>
              <option value="PAID">Оплачен</option>
              <option value="UNPAID">Не оплачен</option>
            </select>
            <div className="text-xs text-ink-3">{loading ? "Загрузка..." : totalCount !== null ? `Показано: ${filteredRows.length} из ${totalCount}` : `Показано: ${filteredRows.length}`}</div>
          </div>
        </div>
        <div className="hidden md:block overflow-auto">
          <table className="min-w-[1040px] w-full text-sm">
            <thead className="bg-slate--soft text-ink-2 border-b border-border">
              <tr>
                {/* Период «смена — возврат»: из списка видно, у кого сегодня возврат */}
                <th className="text-left px-3 py-2 font-medium">Даты</th>
                <th className="text-left px-3 py-2 font-medium">Клиент</th>
                <th className="text-left px-3 py-2 font-medium">Проект</th>
                <th className="text-left px-3 py-2 font-medium">Статус</th>
                <th className="text-left px-3 py-2 font-medium">Оплата</th>
                <th className="text-right px-3 py-2 font-medium">Сумма</th>
                <th className="text-right px-3 py-2 font-medium">Остаток</th>
                <th className="px-3 py-2 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-surface-muted transition-colors"
                  title={paymentTooltip(r)}
                >
                  <td className="px-3 py-2 text-ink-2 whitespace-nowrap mono-num" title="Смена — возврат">
                    {formatBookingPeriod(r.startDate, r.endDate)}
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    {isSuperAdmin ? (
                      <ClientPickerPopover
                        bookingId={r.id}
                        currentClientId={r.client.id}
                        currentClientName={r.client.name}
                        onAssigned={(newClient) => {
                          // Оптимистичное локальное обновление — без перезапроса всего списка.
                          setRows((prev) =>
                            prev.map((row) =>
                              row.id === r.id
                                ? { ...row, client: { id: newClient.id, name: newClient.name } }
                                : row,
                            ),
                          );
                        }}
                      >
                        {(triggerProps) => {
                          const { ref, ...rest } = triggerProps;
                          return (
                            <button
                              type="button"
                              ref={ref as React.Ref<HTMLButtonElement>}
                              {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
                              className="text-left text-ink-2 border-b border-dotted border-border hover:border-accent hover:text-accent transition-colors -my-0.5 py-0.5 max-w-[200px] truncate"
                              title="Сменить клиента"
                            >
                              {r.client.name}
                            </button>
                          );
                        }}
                      </ClientPickerPopover>
                    ) : (
                      r.client.name
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.projectName?.trim() === "Проект" ? (
                      <span className="text-ink-3">Без названия</span>
                    ) : (
                      <span className="text-ink-2">{r.projectName}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{renderStatusCell(r)}</td>
                  <td className="px-3 py-2">{renderPaymentCell(r)}</td>
                  <td className="px-3 py-2 text-right mono-num text-ink-2">{formatRub(r.finalAmount)}</td>
                  <td className="px-3 py-2 text-right mono-num text-ink">{formatRub(r.amountOutstanding)}</td>
                  <td className="px-3 py-2">{renderRowActions(r)}</td>
                </tr>
              ))}
              {filteredRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-ink-3" colSpan={8}>
                    Нет данных
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Мобильное card-представление (паттерн — как на /finance/payments):
            те же данные и те же действия, без горизонтального скролла таблицы */}
        <div className="md:hidden p-3 space-y-2">
          {filteredRows.map((r) => (
            <div
              key={r.id}
              className="border border-border rounded-lg p-3 bg-surface"
              title={paymentTooltip(r)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <strong className="text-ink text-[13px] block truncate">{r.client.name}</strong>
                  <div className="text-xs text-ink-3 truncate">
                    {r.projectName?.trim() === "Проект" ? "Без названия" : r.projectName}
                  </div>
                </div>
                <span className="mono-num font-semibold text-[14px] text-ink whitespace-nowrap">
                  {formatRub(r.finalAmount)}
                </span>
              </div>
              <div className="mt-1 text-xs text-ink-2 mono-num" title="Смена — возврат">
                {formatBookingPeriod(r.startDate, r.endDate)}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{renderStatusCell(r)}</span>
                <span>{renderPaymentCell(r)}</span>
                {Number(r.amountOutstanding ?? "0") > 0 && (
                  <span className="text-xs text-ink-2">
                    Остаток: <span className="mono-num text-ink">{formatRub(r.amountOutstanding)}</span>
                  </span>
                )}
              </div>
              <div className="mt-2 pt-2 border-t border-border border-dashed">
                {renderRowActions(r)}
              </div>
            </div>
          ))}
          {filteredRows.length === 0 && (
            <div className="py-6 text-center text-ink-3 text-sm">Нет данных</div>
          )}
        </div>

        {nextCursor && (
          <div className="mt-4 flex items-center justify-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded-md border border-border bg-surface px-4 py-2 text-sm text-ink-1 hover:bg-accent-soft disabled:opacity-50"
            >
              {loadingMore ? "Загружаю..." : "Загрузить ещё"}
            </button>
          </div>
        )}
        {!nextCursor && rows.length > 0 && (
          <div className="mt-4 text-center text-xs text-ink-3">
            Показаны все брони ({rows.length} {pluralize(rows.length, "запись", "записи", "записей")})
          </div>
        )}
      </div>

      <ConfirmActionModal
        open={confirmAction !== null}
        title={confirmAction?.action === "return" ? "Возврат брони" : "Отмена брони"}
        subtitle={confirmAction ? bookingRowTitle(confirmAction.row) : undefined}
        message={
          confirmAction?.action === "return"
            ? "Перевести бронь в статус «Возвращено»?\n\nСтатус финальный: оборудование вернётся в доступные, изменить статус обратно через интерфейс будет нельзя."
            : "Отменить бронь?\n\nРезервы оборудования будут сняты, бронь перейдёт в финальный статус «Отменено» — вернуть её через интерфейс будет нельзя."
        }
        confirmLabel={confirmAction?.action === "return" ? "Вернуть" : "Отменить бронь"}
        tone={confirmAction?.action === "return" ? "primary" : "danger"}
        loading={confirmAction !== null && busyId === confirmAction.row.id}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleConfirmAction}
      />

      <ConfirmActionModal
        open={archiveRow !== null}
        title="В архив"
        subtitle={archiveRow ? bookingRowTitle(archiveRow) : undefined}
        message={
          "Отправить бронь в архив?\n\nБронь пропадёт из списка, но останется в БД — её можно вернуть из архива (/bookings/archive). Окончательное удаление — только оттуда."
        }
        confirmLabel="В архив"
        tone="danger"
        loading={archiveRow !== null && busyId === archiveRow.id}
        onClose={() => setArchiveRow(null)}
        onConfirm={() => {
          if (archiveRow) removeBooking(archiveRow.id);
        }}
      />

      <ConfirmActionModal
        open={earlyIssue !== null}
        title="Ранняя выдача"
        subtitle={earlyIssue ? bookingRowTitle(earlyIssue.row) : undefined}
        message={
          earlyIssue
            ? `${earlyIssue.message}\n\nВыдать оборудование заранее? Ранняя выдача будет зафиксирована в аудите.`
            : ""
        }
        confirmLabel="Выдать заранее"
        tone="primary"
        loading={earlyIssue !== null && busyId === earlyIssue.row.id}
        onClose={() => setEarlyIssue(null)}
        onConfirm={() => {
          if (earlyIssue) {
            const id = earlyIssue.row.id;
            setEarlyIssue(null);
            runStatusAction(id, "issue", { force: true });
          }
        }}
      />

      {cancelDepositRow && (
        <CancelWithDepositModal
          open={cancelDepositRow !== null}
          onClose={() => setCancelDepositRow(null)}
          bookingId={cancelDepositRow.id}
          bookingDisplayName={bookingRowTitle(cancelDepositRow)}
          clientId={cancelDepositRow.client.id}
          clientName={cancelDepositRow.client.name}
          depositTotal={Number(cancelDepositRow.amountPaid ?? "0")}
          onCancelled={() => {
            const id = cancelDepositRow.id;
            setCancelDepositRow(null);
            refreshRow(id);
          }}
        />
      )}
    </div>
  );
}

export default function BookingHistoryPage() {
  return (
    <Suspense fallback={<div className="p-8 text-ink-3">Загрузка...</div>}>
      <BookingHistoryPageInner />
    </Suspense>
  );
}

