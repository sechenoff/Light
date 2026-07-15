"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "../../src/lib/api";
import {
  bookingStatusLabel as statusText,
  bookingStatusVariant as statusVariant,
} from "../../src/lib/bookingConstants";
import { StatusPill } from "../../src/components/StatusPill";
import { SectionHeader } from "../../src/components/SectionHeader";
import { BookingRowMenu, type BookingRowMenuItem } from "../../src/components/bookings/BookingRowMenu";
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
import { rememberBookingsListQuery } from "../../src/components/bookings/bookingsListNav";
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
  // Подтверждение статусных действий модалкой. «Вернуть»/«Отменить» —
  // необратимые (терминальные статусы). «Выдать» тоже через подтверждение:
  // на строке кнопка легко мис-тапается пальцем, а выдача резервирует юниты.
  const [confirmAction, setConfirmAction] = useState<null | {
    row: BookingRow;
    action: "issue" | "return" | "cancel";
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
  // Ошибка загрузки списка — вместо молчаливого console.error показываем баннер
  // с «Повторить» (реген reloadKey перезапускает эффект загрузки).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Подпись активных фильтров (без курсора) — гард от гонки «Загрузить ещё»:
  // если фильтр сменился, пока летит дозагрузка, её ответ отбрасывается.
  const filterSigRef = useRef("");

  // Есть ли активные фильтры — влияет на текст пустого состояния
  // («ничего не найдено по фильтрам» vs «броней ещё нет»).
  const hasActiveFilters = Boolean(
    statusFilter || paymentFilter || dateFrom || dateTo || searchQuery.trim(),
  );

  function resetFilters() {
    setStatusFilter("");
    setPaymentFilter("");
    setDateFrom("");
    setDateTo("");
    setSearchInput("");
    setSearchQuery("");
  }

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
      setLoadError(null);
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
        if (!isAbort && isActive) {
          // Больше не молчим: показываем баннер ошибки вместо ложного «Нет данных».
          setLoadError(e?.message ?? "Не удалось загрузить список броней");
          setRows([]);
          setNextCursor(null);
          setTotalCount(null);
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
  }, [statusFilter, paymentFilter, dateFrom, dateTo, searchQuery, reloadKey]);

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
    // Запоминаем фильтры для «← К списку» на карточке брони — возврат
    // приводит на тот же отфильтрованный список, а не на голый /bookings.
    rememberBookingsListQuery(qs ? `?${qs}` : "");
    // Подпись фильтров для гарда гонки дозагрузки (qs без курсора уникально
    // описывает текущий фильтр-набор).
    filterSigRef.current = qs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, paymentFilter, dateFrom, dateTo, searchQuery]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    // Снимок подписи фильтров: если пользователь сменит фильтр, пока летит
    // дозагрузка, её ответ нельзя дописывать к уже перезагруженному списку.
    const sigAtStart = filterSigRef.current;
    setLoadingMore(true);
    try {
      const data = await apiFetch<{ bookings: BookingRow[]; nextCursor: string | null }>(
        `/api/bookings?${buildListParams(nextCursor)}`
      );
      if (filterSigRef.current !== sigAtStart) return; // фильтр сменился — отбрасываем
      setRows((prev) => [...prev, ...data.bookings]);
      setNextCursor(data.nextCursor ?? null);
    } catch (e: any) {
      if (filterSigRef.current === sigAtStart) {
        toast.error(e?.message ?? "Не удалось загрузить ещё");
      }
    } finally {
      setLoadingMore(false);
    }
  }

  async function removeBooking(id: string) {
    setBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.id !== id));
      // Синхронизируем счётчик «Показано N из M» — иначе «49 из 120» врёт.
      setTotalCount((c) => (c !== null ? Math.max(0, c - 1) : c));
      setArchiveRow(null);
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось отправить бронь в архив");
    } finally {
      setBusyId(null);
    }
  }

  // Точечное обновление одной строки из ответа API — статусное действие не
  // сбрасывает подгруженные страницы и скролл-позицию.
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

  // Второстепенные/деструктивные действия строки — под меню «⋯».
  // Правила гейтинга зеркалят /bookings/[id] и сервер: редактировать можно
  // DRAFT/CONFIRMED (PENDING — только SA); отмена запрещена из ISSUED и
  // терминальных статусов, оплаченную бронь отменяет только SA (депозит-мастер
  // SA-only); архив — SA.
  function rowMenuItems(r: BookingRow): BookingRowMenuItem[] {
    const items: BookingRowMenuItem[] = [];
    const canEdit =
      ["DRAFT", "CONFIRMED"].includes(r.status) ||
      (r.status === "PENDING_APPROVAL" && isSuperAdmin);
    if (canEdit) {
      items.push({
        key: "edit",
        label: "Изменить",
        onSelect: () => router.push(`/bookings/${r.id}/edit`),
      });
    }
    const canCancel =
      !["CANCELLED", "RETURNED", "ISSUED"].includes(r.status) &&
      (isSuperAdmin || Number(r.amountPaid ?? "0") === 0);
    if (canCancel) {
      items.push({ key: "cancel", label: "Отменить бронь", danger: true, onSelect: () => requestCancel(r) });
    }
    if (isSuperAdmin) {
      items.push({ key: "archive", label: "В архив", danger: true, onSelect: () => setArchiveRow(r) });
    }
    return items;
  }

  // Один набор действий для десктопной таблицы и мобильных карточек —
  // никакого дрейфа между двумя представлениями. На виду — только ОДНО
  // главное действие статуса, остальное убрано под «⋯».
  function renderRowActions(r: BookingRow) {
    const menuItems = rowMenuItems(r);
    return (
      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        {/* Главное действие статуса. Согласование ведёт на экран согласования
            (состав + смета + история), а не резервирует юниты одним кликом. */}
        {r.status === "PENDING_APPROVAL" && isSuperAdmin ? (
          <Link
            href={`/bookings/${r.id}`}
            className="text-xs rounded border border-emerald-border text-emerald px-2.5 py-1 font-medium hover:bg-emerald-soft transition-colors"
          >
            Согласовать →
          </Link>
        ) : r.status === "CONFIRMED" ? (
          <button
            type="button"
            className="text-xs rounded border border-accent-border text-accent-bright px-2.5 py-1 font-medium hover:bg-accent-soft disabled:opacity-40 transition-colors"
            disabled={busyId === r.id}
            onClick={() => setConfirmAction({ row: r, action: "issue" })}
          >
            Выдать
          </button>
        ) : r.status === "ISSUED" ? (
          <button
            type="button"
            className="text-xs rounded border border-accent-border text-accent-bright px-2.5 py-1 font-medium hover:bg-accent-soft disabled:opacity-40 transition-colors"
            disabled={busyId === r.id}
            onClick={() => setConfirmAction({ row: r, action: "return" })}
          >
            Вернуть
          </button>
        ) : null}
        {menuItems.length > 0 && <BookingRowMenu items={menuItems} />}
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

  // Состояния контента списка (взаимоисключающие):
  //  - ошибка загрузки → баннер с «Повторить» (вместо ложного «Нет данных»);
  //  - первая загрузка → скелетон (не пустота);
  //  - пусто → «ничего не найдено по фильтрам» / «броней ещё нет».
  const showErrorBanner = loadError !== null && rows.length === 0;
  const showSkeleton = loading && rows.length === 0 && loadError === null;
  const showEmpty = !loading && loadError === null && rows.length === 0;

  // Пустое состояние — контекстно-зависимое: под фильтром зовём их сбросить,
  // на чистой базе — создать первую бронь.
  function renderEmptyState() {
    return hasActiveFilters ? (
      <div className="flex flex-col items-center gap-2">
        <span className="text-ink-3">Ничего не найдено под текущими фильтрами.</span>
        <button
          type="button"
          onClick={resetFilters}
          className="text-accent-bright hover:text-accent font-medium"
        >
          Сбросить фильтры
        </button>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2">
        <span className="text-ink-3">Броней пока нет.</span>
        <Link href="/bookings/new" className="text-accent-bright hover:text-accent font-medium">
          Создать первую бронь
        </Link>
      </div>
    );
  }

  const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6"];

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
            <div className="text-xs text-ink-3">
              {loadError
                ? "—"
                : loading && rows.length === 0
                  ? "Загрузка..."
                  : totalCount !== null
                    ? `Показано: ${filteredRows.length} из ${totalCount}`
                    : `Показано: ${filteredRows.length}`}
            </div>
          </div>
        </div>

        {/* Ошибка загрузки — баннер с «Повторить» вместо молчаливого пустого списка. */}
        {showErrorBanner && (
          <div className="m-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-border bg-rose-soft px-4 py-3">
            <div className="text-sm text-rose">
              <div className="font-semibold">Не удалось загрузить список</div>
              <div className="text-xs text-rose/80">{loadError}</div>
            </div>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="rounded border border-rose-border bg-surface px-3 py-1.5 text-sm text-rose hover:bg-rose-soft"
            >
              Повторить
            </button>
          </div>
        )}

        <div className={`hidden overflow-auto ${showErrorBanner ? "" : "md:block"}`}>
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
              {showSkeleton &&
                SKELETON_KEYS.map((k) => (
                  <tr key={k} className="border-t border-border">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <td key={i} className="px-3 py-3">
                        <div className="h-3 rounded bg-surface-muted animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))}
              {filteredRows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-surface-muted transition-colors cursor-pointer"
                  title={paymentTooltip(r)}
                  onClick={() => router.push(`/bookings/${r.id}`)}
                >
                  <td className="px-3 py-2 text-ink-2 whitespace-nowrap mono-num" title="Смена — возврат">
                    {formatBookingPeriod(r.startDate, r.endDate)}
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    {/* Клик по клиенту фильтрует список его бронями (частый
                        сценарий), а не меняет клиента брони — смена клиента
                        живёт на карточке брони, где ей и место. */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setSearchInput(r.client.name); }}
                      className="text-left text-ink-2 border-b border-dotted border-border hover:border-accent hover:text-accent transition-colors -my-0.5 py-0.5 max-w-[200px] truncate"
                      title={`Показать брони клиента «${r.client.name}»`}
                    >
                      {r.client.name}
                    </button>
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
              {showEmpty ? (
                <tr>
                  <td className="px-3 py-10 text-center text-sm" colSpan={8}>
                    {renderEmptyState()}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Мобильное card-представление (паттерн — как на /finance/payments):
            те же данные и те же действия, без горизонтального скролла таблицы */}
        <div className={`p-3 space-y-2 ${showErrorBanner ? "hidden" : "md:hidden"}`}>
          {showSkeleton &&
            SKELETON_KEYS.map((k) => (
              <div key={k} className="border border-border rounded-lg p-3 bg-surface space-y-2">
                <div className="h-3.5 w-2/3 rounded bg-surface-muted animate-pulse" />
                <div className="h-3 w-1/3 rounded bg-surface-muted animate-pulse" />
                <div className="h-5 w-1/2 rounded bg-surface-muted animate-pulse" />
              </div>
            ))}
          {filteredRows.map((r) => (
            <div
              key={r.id}
              className="border border-border rounded-lg p-3 bg-surface cursor-pointer active:bg-surface-muted transition-colors"
              title={paymentTooltip(r)}
              onClick={() => router.push(`/bookings/${r.id}`)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setSearchInput(r.client.name); }}
                    className="text-ink text-[13px] font-semibold block truncate max-w-full text-left border-b border-dotted border-transparent hover:border-accent hover:text-accent transition-colors"
                    title={`Показать брони клиента «${r.client.name}»`}
                  >
                    {r.client.name}
                  </button>
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
          {showEmpty && (
            <div className="py-10 text-center text-sm">{renderEmptyState()}</div>
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
        title={
          confirmAction?.action === "issue"
            ? "Выдача оборудования"
            : confirmAction?.action === "return"
              ? "Возврат брони"
              : "Отмена брони"
        }
        subtitle={confirmAction ? bookingRowTitle(confirmAction.row) : undefined}
        message={
          confirmAction?.action === "issue"
            ? "Выдать оборудование по этой брони?\n\nЮниты перейдут в статус «Выдано» и будут списаны со склада."
            : confirmAction?.action === "return"
              ? "Перевести бронь в статус «Возвращено»?\n\nСтатус финальный: оборудование вернётся в доступные, изменить статус обратно через интерфейс будет нельзя."
              : "Отменить бронь?\n\nРезервы оборудования будут сняты, бронь перейдёт в финальный статус «Отменено» — вернуть её через интерфейс будет нельзя."
        }
        confirmLabel={
          confirmAction?.action === "issue"
            ? "Выдать"
            : confirmAction?.action === "return"
              ? "Вернуть"
              : "Отменить бронь"
        }
        tone={confirmAction?.action === "cancel" ? "danger" : "primary"}
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

