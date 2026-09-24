"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BOOKING_ISSUE_FILTERS,
  REGISTER_SCOPES,
  REGISTER_STATUSES,
  type BookingRegisterResponse as Response,
  type BookingRegisterRow as Row,
  type RegisterScope,
} from "@light-rental/shared";
import { apiFetch } from "../../../lib/api";
import { formatRub } from "../../../lib/format";
import { toMoscowDateString } from "../../../lib/moscowDate";
import { bookingStatusLabel } from "../../../lib/bookingConstants";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useRequireRole } from "../../../hooks/useRequireRole";
import { toast } from "../../ToastProvider";
import { useAutoLoadMore } from "../useAutoLoadMore";
import { QuickBookingModal } from "../QuickBookingModal";
import { rememberBookingsListQuery } from "../bookingsListNav";
import { BookingIssuesPanel } from "../issues/BookingIssuesPanel";
import { useRegisterActions } from "./useRegisterActions";
import { pluralBookings } from "../bulkActions";
import { RegisterFilters, control, button, primaryButton } from "./RegisterFilters";
import {
  DueDate,
  PaymentState,
  RentalDates,
  RentalState,
  RegisterDetail,
} from "./RegisterCells";
import {
  FILTER_KEYS,
  registerParams,
  requestParams,
  scopeLabels,
  sortLabels,
  dateLabels,
  paymentLabels,
  actionLabels,
  parseSavedViews,
  type SavedRegisterView,
} from "./model";

export function BookingRegister() {
  const { authorized, loading: roleLoading } = useRequireRole([
    "SUPER_ADMIN",
    "WAREHOUSE",
  ]);
  const { user } = useCurrentUser(),
    router = useRouter(),
    search = useSearchParams();
  const query = registerParams(search).toString(),
    p = useMemo(() => new URLSearchParams(query), [query]);
  const requestQuery = requestParams(p).toString(),
    view = p.get("view") ?? "registry",
    scope = p.get("scope") as RegisterScope;
  const [data, setData] = useState<Response | null>(null),
    [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [moreLoading, setMoreLoading] = useState(false),
    [moreError, setMoreError] = useState("");
  const moreLock = useRef(false),
    version = useRef(0);
  const [revision, setRevision] = useState(0),
    [filtersOpen, setFiltersOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false),
    [detail, setDetail] = useState<Row | null>(null);
  const [issueBooking, setIssueBooking] = useState<Row | null>(null);
  const openIssues = useCallback((row: Row) => { setDetail(null); setIssueBooking(row); }, []);
  const [searchInput, setSearchInput] = useState(p.get("q") ?? "");
  const [saved, setSaved] = useState<SavedRegisterView[]>([]),
    [saveOpen, setSaveOpen] = useState(false),
    [viewName, setViewName] = useState("");
  const storageKey = user?.userId
    ? `lr:register:views:v1:${user.userId}`
    : null;
  const update = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(query);
      for (const [k, v] of Object.entries(patch))
        v ? next.set(k, v) : next.delete(k);
      router.replace(`/bookings?${registerParams(next)}`, { scroll: false });
    },
    [query, router],
  );
  useEffect(() => {
    rememberBookingsListQuery(`?${query}`);
  }, [query]);
  const urlSearch = p.get("q") ?? "";
  useEffect(() => setSearchInput(urlSearch), [urlSearch]);
  useEffect(() => {
    if (searchInput === urlSearch) return;
    const timer = setTimeout(() => update({ q: searchInput.trim() }), 350);
    return () => clearTimeout(timer);
  }, [searchInput, urlSearch, update]);
  useEffect(() => {
    if (storageKey) {
      try {
        setSaved(parseSavedViews(localStorage.getItem(storageKey)));
      } catch {
        setSaved([]);
      }
    }
  }, [storageKey]);
  function saveViews(next: SavedRegisterView[]) {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaved(next);
    } catch {
      toast.error(
        "Браузер не разрешает сохранять виды. Фильтры остаются в адресе страницы.",
      );
    }
  }
  const refresh = useCallback(() => {
    setDetail(null);
    setRevision((n) => n + 1);
  }, []);
  const actions = useRegisterActions(rows, user, refresh, openIssues);
  const clearSelection = actions.selection.clear;
  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController(),
      current = ++version.current;
    clearSelection();
    setLoading(true);
    setError("");
    setMoreError("");
    setMoreLoading(false);
    moreLock.current = false;
    apiFetch<Response>(`/api/bookings/register?${requestQuery}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (current !== version.current) return;
        setData(result);
        setRows(result.bookings);
      })
      .catch((e) => {
        if (!controller.signal.aborted && current === version.current) {
          setError(e.message ?? "Не удалось загрузить бронирования");
          setRows([]);
          setData(null);
        }
      })
      .finally(() => {
        if (current === version.current) setLoading(false);
      });
    return () => {
      controller.abort();
      version.current = current + 1;
    };
    // Selection resets only when the server query or its revision changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, requestQuery, revision]);
  // Refresh after returning from a booking/warehouse tab; never mutate data on read.
  useEffect(() => {
    let last = Date.now();
    const focus = () => {
      if (
        Date.now() - last > 30000 &&
        !document.querySelector('dialog[open], [role="dialog"]')
      ) {
        last = Date.now();
        setRevision((n) => n + 1);
      }
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  async function more() {
    if (!data?.nextCursor || moreLock.current || loading) return;
    moreLock.current = true;
    setMoreLoading(true);
    setMoreError("");
    const current = version.current;
    try {
      const q = new URLSearchParams(requestQuery);
      q.set("cursor", data.nextCursor);
      const result = await apiFetch<Response>(`/api/bookings/register?${q}`);
      if (version.current !== current) return;
      setRows((previous) => [
        ...previous,
        ...result.bookings.filter((r) => !previous.some((b) => b.id === r.id)),
      ]);
      setData(result);
    } catch (e) {
      if (version.current === current)
        setMoreError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      if (version.current === current) {
        moreLock.current = false;
        setMoreLoading(false);
      }
    }
  }
  const autoLoad = useAutoLoadMore({
    hasMore: !!data?.nextCursor,
    loading: loading || moreLoading,
    disabled: !!moreError || view === "day",
    onLoadMore: () => void more(),
  });
  // Активная вкладка состояния должна быть видна в ленте. Без scrollIntoView:
  // на телефоне он при загрузке прокрутил бы к ленте всю страницу.
  const tabsRef = useRef<HTMLElement>(null);
  const hasData = !!data;
  useEffect(() => {
    const nav = tabsRef.current,
      el = nav?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!nav || !el) return;
    if (
      el.offsetLeft < nav.scrollLeft ||
      el.offsetLeft + el.offsetWidth > nav.scrollLeft + nav.clientWidth
    )
      nav.scrollLeft = el.offsetLeft - 16;
  }, [authorized, scope, view, hasData]);
  const today = toMoscowDateString(new Date());
  const filterEntries = FILTER_KEYS.filter(
    (k) => p.get(k) && !["dateField", "amountField"].includes(k),
  );
  const expanded = p.get("columns") === "expanded";
  const reset = () => {
    setSearchInput("");
    router.replace(`/bookings?view=${view}&scope=${scope}`, { scroll: false });
  };
  const money = (r: Row) => (
    <PaymentState
      row={r}
      centered
      pay={actions.canPay(r) ? () => actions.pay(r) : undefined}
    />
  );
  const rowActions = (r: Row) => (
    <div className="flex items-center justify-center gap-1">
      <button
        className={`${button} whitespace-nowrap !text-xs`}
        disabled={actions.busy || loading}
        onClick={() => actions.primary(r)}
      >
        {actions.primaryLabel(r)}
      </button>
      {actions.menu(r)}
    </div>
  );
  const identity = (r: Row, centered = true) => (
    <div className={`min-w-0 ${centered ? "text-center" : "text-left"}`}>
      <button
        className={`max-w-full break-words text-sm font-semibold text-ink hover:text-accent ${centered ? "text-center" : "text-left"}`}
        onClick={() => setDetail(r)}
      >
        {r.projectName || "Без названия"}
      </button>
      <button
        className={`mt-1 block max-w-full truncate text-xs text-ink-2 hover:text-accent ${centered ? "mx-auto text-center" : "text-left"}`}
        onClick={() => update({ clientId: r.client.id })}
        title={`Все брони клиента ${r.client.name}`}
      >
        {r.client.name}
      </button>
      <div className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3 ${centered ? "justify-center" : "justify-start"}`}>
        <span>{r.docNumber ?? r.id.slice(-6)}</span>
        {r.mode === "PROJECT" && (
          <span className="rounded bg-indigo-soft px-1.5 py-0.5 text-indigo">
            Длинный проект
          </span>
        )}
        {r.hasScanSessions && <span>Сканирование</span>}
      </div>
    </div>
  );
  function card(r: Row, selectable = true) {
    return (
      <article
        key={r.id}
        className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-4 text-center shadow-xs"
        data-booking-card={r.id}
      >
        <div className="relative px-6">
          {selectable && r.mode !== "PROJECT" && (
            // Зона нажатия 40×40 вокруг чекбокса 16 px; центр — там же, где был сам чекбокс.
            <label className="absolute -left-3 -top-2 flex h-10 w-10 cursor-pointer items-center justify-center">
              <input
                className="h-4 w-4 accent-accent"
                type="checkbox"
                aria-label={`Выбрать ${r.projectName}`}
                checked={actions.selection.selected.has(r.id)}
                onChange={() => actions.selection.toggle(r.id)}
                disabled={actions.busy}
              />
            </label>
          )}
          {identity(r)}
        </div>
        <div className="mt-3 grid justify-items-center gap-3">
          <RentalDates row={r} />
          <RentalState row={r} onIssues={() => openIssues(r)} />
        </div>
        <div className="my-3 grid justify-items-center gap-2 border-y border-border py-3">
          {money(r)}
          <DueDate row={r} label />
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          {rowActions(r)}
          <Link className="inline-flex min-h-10 items-center text-xs text-accent" href={`/bookings/${r.id}`}>
            Карточка →
          </Link>
        </div>
      </article>
    );
  }
  if (roleLoading || !authorized)
    return (
      <div className="p-6 text-sm text-ink-3">
        {roleLoading ? "Проверка доступа…" : "Доступ к бронированиям ограничен"}
      </div>
    );
  return (
    <>
    {/* Оверлеи (шторки, модалки) живут ВНЕ этого контейнера: space-y-4 задаёт
        margin-top всем соседям со специфичностью 0,3,0 и сдвигал fixed-оверлеи
        и <dialog> на 16 px вниз. */}
    <div
      className="min-w-0 space-y-4 p-4 pb-32 lg:p-6 lg:pb-32"
      data-booking-register
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow text-ink-3">Светобаза / Управление ренталом</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            Бронирования
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            Аренда, оборудование и расчёты в одном месте
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={button} onClick={() => setQuickOpen(true)}>
            Быстрая бронь
          </button>
          <Link
            className={primaryButton}
            href="/bookings/new"
          >
            + Создать бронь
          </Link>
        </div>
      </header>
      <section aria-label="Сводка по всем бронированиям">
        <p className="mb-2 text-[11px] text-ink-3">
          По всем неархивным бронированиям · независимо от фильтров
        </p>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-6">
          {[
            {
              scope: "all",
              label: "Сумма проектов",
              value: data ? formatRub(data.summary.total) : undefined,
              hint: "длинные проекты — по закрытым периодам",
            },
            {
              scope: "all",
              label: "Получено",
              value: data ? formatRub(data.summary.paid) : undefined,
              hint: "поступившие деньги по всем броням",
            },
            {
              scope: "active",
              label: "В работе",
              value: data?.summary.active,
              hint: "есть задачи или обязательства",
            },
            {
              scope: "issued",
              label: "На руках",
              value: data?.summary.issued,
              hint: "оборудование у клиентов",
            },
            {
              scope: "unpaid",
              label: "К оплате",
              value: data ? formatRub(data.summary.outstanding) : undefined,
              hint: `${data?.summary.unpaid ?? "—"} бронирований с остатком`,
            },
            {
              scope: "overdue",
              label: "Просрочено",
              value: data ? formatRub(data.summary.overdue) : undefined,
              hint: `${data?.summary.overdueCount ?? "—"} бронирований · срок оплаты истёк`,
            },
          ].map((s) => (
            <button
              key={s.label}
              onClick={() => {
                setSearchInput("");
                router.replace(`/bookings?scope=${s.scope}&view=${view}`, {
                  scroll: false,
                });
              }}
              // flex-col + justify-start: кнопка растянута рядом сетки, и без этого
              // браузер центрировал бы содержимое по вертикали — подписи соседних
              // плашек вставали на разную высоту.
              className={`flex min-w-0 flex-col justify-start rounded-lg border bg-surface p-3 text-center transition hover:border-accent xl:p-4 ${s.scope === "overdue" && Number(data?.summary.overdue) > 0 ? "border-rose-border" : "border-border"}`}
            >
              <span className="text-xs text-ink-2">{s.label}</span>
              {/* Mono — с 640 px; на телефоне Sans, иначе десятки миллионов с копейками переносятся. */}
              <strong
                className={`mt-1 block break-words text-lg font-semibold tabular-nums sm:mono-num sm:text-xl ${s.scope === "overdue" && Number(data?.summary.overdue) > 0 ? "text-rose" : s.label === "Получено" ? "text-emerald" : "text-ink"}`}
              >
                {s.value ?? "—"}
              </strong>
              <span className="mt-1 block text-[11px] text-ink-3 sm:text-xs">
                {s.hint}
              </span>
            </button>
          ))}
        </div>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-border bg-surface-subtle p-1"
          aria-label="Представление"
        >
          {[
            ["registry", "Реестр"],
            ["day", "Пульт дня"],
            ["board", "Доска"],
          ].map(([v, label]) => (
            <button
              key={v}
              aria-pressed={view === v}
              onClick={() => update({ view: v })}
              className={`min-h-9 rounded px-3 py-1.5 text-sm ${view === v ? "bg-surface font-semibold text-accent shadow-sm" : "text-ink-2 hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          <Link className="py-2 text-ink-2 hover:text-accent" href="/calendar">
            Календарь ↗
          </Link>
          <Link
            className="py-2 text-ink-2 hover:text-accent"
            href="/warehouse/scan"
          >
            Склад ↗
          </Link>
          {user?.role === "SUPER_ADMIN" && (
            <>
              <Link
                className="py-2 text-ink-2 hover:text-accent"
                href="/finance/payments"
              >
                Платежи ↗
              </Link>
              <Link
                className="py-2 text-ink-2 hover:text-accent"
                href="/bookings/archive"
              >
                Архив ↗
              </Link>
            </>
          )}
        </div>
      </div>
      <section
        className="space-y-3 rounded-lg border border-border bg-surface p-3 sm:p-4"
        aria-label="Поиск и фильтры"
      >
        <div className="flex flex-wrap gap-2">
          <label className="min-w-0 flex-1 basis-64">
            <span className="sr-only">Поиск бронирований</span>
            <input
              type="search"
              className={control}
              placeholder="Клиент, проект или номер брони…"
              value={searchInput}
              maxLength={200}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </label>
          <button
            className={button}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            Фильтры{" "}
            {filterEntries.length > 0 ? `· ${filterEntries.length}` : ""}
          </button>
          <button className={button} onClick={() => setSaveOpen((v) => !v)}>
            Сохранить вид
          </button>
          <button
            className={button}
            disabled={loading}
            onClick={refresh}
            aria-label="Обновить список"
          >
            ↻
          </button>
        </div>
        {saved.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-3">Мои виды:</span>
            {saved.map((s) => (
              <span
                key={s.id}
                className="inline-flex max-w-full rounded border border-border text-xs"
              >
                <button
                  className="min-h-9 truncate px-2 text-accent"
                  onClick={() =>
                    router.replace(
                      `/bookings?${registerParams(new URLSearchParams(s.query))}`,
                      { scroll: false },
                    )
                  }
                >
                  {s.name}
                </button>
                <button
                  className="px-2 text-ink-3 hover:text-rose"
                  aria-label={`Удалить вид ${s.name}`}
                  onClick={() => saveViews(saved.filter((v) => v.id !== s.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {saveOpen && (
          <form
            className="flex flex-wrap items-center gap-2 rounded bg-surface-subtle p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const name = viewName.trim();
              if (!name) return;
              if (saved.length >= 12) {
                toast.error(
                  "Можно сохранить до 12 видов. Удалите неиспользуемый.",
                );
                return;
              }
              saveViews([...saved, { id: crypto.randomUUID(), name, query }]);
              setSaveOpen(false);
              setViewName("");
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="sr-only">Название вида</span>
              <input
                autoFocus
                required
                className={control}
                placeholder="Например: долги за сентябрь"
                maxLength={60}
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
              />
            </label>
            <button className={button} type="submit">
              Сохранить
            </button>
            <p className="w-full text-xs text-ink-3">
              Личный вид в этом браузере: фильтры, сортировка, колонки и
              представление. Адресом страницы можно поделиться с сотрудником.
            </p>
          </form>
        )}
        {filtersOpen && (
          <RegisterFilters
            key={query}
            params={p}
            options={data?.options}
            apply={update}
          />
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink-3">Аренда:</span>
          {[
            ["Сегодня", today, today],
            [
              "7 дней",
              today,
              toMoscowDateString(new Date(Date.now() + 6 * 86400000)),
            ],
            [
              "Этот месяц",
              today.slice(0, 8) + "01",
              new Date(
                Date.UTC(
                  Number(today.slice(0, 4)),
                  Number(today.slice(5, 7)),
                  0,
                ),
              )
                .toISOString()
                .slice(0, 10),
            ],
          ].map(([label, from, to]) => (
            <button
              key={label}
              className={`min-h-10 rounded border px-2 sm:min-h-8 ${p.get("from") === from && p.get("to") === to && p.get("dateField") === "rental" ? "border-accent-border bg-accent-soft text-accent" : "border-border text-ink-2"}`}
              onClick={() => update({ from, to, dateField: "rental" })}
            >
              {label}
            </button>
          ))}
          {filterEntries.length > 0 && (
            <button
              className="min-h-10 px-2 text-accent underline underline-offset-2 sm:min-h-8"
              onClick={reset}
            >
              Сбросить фильтры
            </button>
          )}
        </div>
        {filterEntries.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Активные фильтры">
            {filterEntries.map((k) => {
              const names: Record<string, string> = {
                q: "Поиск",
                clientId: "Клиент",
                projectId: "Проект",
                status: "Этап",
                mode: "Тип",
                payment: "Оплата",
                from: "С",
                to: "По",
                min: "Сумма от",
                max: "Сумма до",
                action: "Действие",
                age: "Просрочка",
                issue: "Проблемы",
              };
              const value =
                k === "issue" ? BOOKING_ISSUE_FILTERS[p.get(k) as keyof typeof BOOKING_ISSUE_FILTERS] : k === "clientId"
                  ? (data?.options.clients.find((c) => c.id === p.get(k))
                      ?.name ?? p.get(k))
                  : k === "projectId"
                    ? (data?.options.projects.find((c) => c.id === p.get(k))
                        ?.name ?? p.get(k))
                    : k === "status"
                      ? p
                          .get(k)!
                          .split(",")
                          .map((s) => bookingStatusLabel(s as Row["status"]))
                          .join(", ")
                      : k === "mode"
                        ? p.get(k) === "PROJECT"
                          ? "Длинный проект"
                          : "Обычная аренда"
                        : k === "payment"
                          ? paymentLabels[p.get(k)!]
                          : k === "action"
                            ? actionLabels[
                                p.get(k) as keyof typeof actionLabels
                              ]
                            : p.get(k);
              return (
                <button
                  key={k}
                  className="max-w-full rounded bg-accent-soft px-2 py-1 text-left text-xs text-accent"
                  onClick={() => {
                    if (k === "q") setSearchInput("");
                    update({ [k]: "" });
                  }}
                >
                  <span className="break-words">
                    {names[k]}: {value}
                  </span>
                  <span className="ml-2" aria-label="Убрать фильтр">
                    ×
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
      {view !== "day" ? (
        <>
          {/* Лента прокручивается по горизонтали до xl: правый край гаснет маской —
              намёк, что вкладки продолжаются; pr-6 даёт последней вкладке выйти из-под маски. */}
          <nav
            ref={tabsRef}
            aria-label="Состояние бронирований"
            className="relative flex gap-1 overflow-x-auto border-b border-border pr-6 [mask-image:linear-gradient(to_right,black_calc(100%_-_24px),transparent)] [scrollbar-width:none] xl:pr-0 xl:[mask-image:none] [&::-webkit-scrollbar]:hidden"
          >
            {(["all", ...REGISTER_SCOPES.filter((s) => s !== "all")] as const).map((s) => (
              <button
                key={s}
                aria-pressed={scope === s}
                onClick={() => update({ scope: s })}
                className={`min-h-10 shrink-0 rounded-t border-b-2 px-3 text-sm ${scope === s ? "border-accent bg-accent-soft font-semibold text-accent" : "border-transparent text-ink-2 hover:bg-surface-subtle"}`}
              >
                {scopeLabels[s]}{" "}
                <span className="ml-1 text-xs opacity-70">
                  {data?.scopeCounts[s] ?? "—"}
                </span>
              </button>
            ))}
          </nav>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-ink-3">
              {loading
                ? "Обновляем…"
                : `Показано ${rows.length} из ${data?.totalCount ?? 0}`}{" "}
              · {dateLabels[p.get("dateField") as keyof typeof dateLabels]} ·
              МСК
            </div>
            <div className="flex max-w-full flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-ink-3">
                Порядок
                <select
                  aria-label="Сортировка"
                  className={`${control} !w-auto !py-1`}
                  value={p.get("sort") ?? "startDate"}
                  onChange={(e) => update({ sort: e.target.value })}
                >
                  {Object.entries(sortLabels).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={button}
                onClick={() =>
                  update({
                    direction: p.get("direction") === "asc" ? "desc" : "asc",
                  })
                }
                aria-label="Изменить направление сортировки"
              >
                {p.get("direction") === "asc"
                  ? "↑ По возрастанию"
                  : "↓ По убыванию"}
              </button>
              {/* Флаг меняет только колонки xl-таблицы — на карточках ему нечего делать. */}
              <label className="hidden min-h-10 items-center gap-2 text-xs text-ink-2 xl:flex">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={expanded}
                  onChange={(e) =>
                    update({ columns: e.target.checked ? "expanded" : "" })
                  }
                />
                Начислено и получено
              </label>
            </div>
          </div>
          {scope === "active" && (
            <p className="text-xs text-ink-3">
              Здесь остаются брони с оборудованием на руках, долгом или
              незакрытыми задачами. Полностью закрытые доступны в «Завершённых»
              и «Все».
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-3 text-sm font-semibold text-ink">
            День операций
            <input
              type="date"
              className={`${control} !w-auto`}
              value={p.get("day") ?? today}
              onChange={(e) => update({ day: e.target.value })}
            />
          </label>
          <p className="text-xs text-ink-3">
            Все этапы по выбранным фильтрам · время МСК
          </p>
        </div>
      )}
      {error ? (
        <div
          role="alert"
          className="rounded border border-rose-border bg-rose-soft p-4 text-sm text-rose"
        >
          {error}
          <button className={`${button} ml-3`} onClick={refresh}>
            Повторить
          </button>
        </div>
      ) : (
        <div
          aria-busy={loading}
          className={loading ? "pointer-events-none opacity-50" : ""}
        >
          {view === "registry" && rows.length > 0 && (
            <>
              <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface xl:block">
                <table className="w-full min-w-[980px] text-center">
                  <thead className="border-b border-border bg-surface-subtle text-[11px] uppercase tracking-wide text-ink-3">
                    <tr>
                      <th className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          aria-label="Выбрать все загруженные брони"
                          className="mx-auto block h-4 w-4 accent-accent"
                          checked={actions.selection.allSelected}
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                actions.selection.someSelected &&
                                !actions.selection.allSelected;
                          }}
                          onChange={actions.selection.toggleAll}
                          disabled={
                            actions.busy || !actions.selection.selectableCount
                          }
                        />
                      </th>
                      <th className="px-3 py-3 text-left">Проект / клиент</th>
                      <th className="px-3 py-3">Аренда · МСК</th>
                      <th className="px-3 py-3">Оборудование</th>
                      {expanded && (
                        <>
                          <th className="px-3 py-3">Начислено</th>
                          <th className="px-3 py-3">Получено</th>
                        </>
                      )}
                      <th className={`${expanded ? "min-w-[200px]" : "min-w-[280px]"} px-3 py-3`}>Сумма / оплата</th>
                      <th className="px-3 py-3">Срок оплаты</th>
                      <th className={`px-3 py-3 ${expanded ? "sticky right-0 bg-surface-subtle shadow-[inset_1px_0_0] shadow-border" : ""}`}>Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        data-booking-row={r.id}
                        className={`group ${
                          actions.selection.selected.has(r.id)
                            ? "bg-accent-soft/40"
                            : "hover:bg-surface-subtle/50"
                        }`}
                      >
                        <td className="px-3 py-4 align-middle">
                          <input
                            className="mx-auto block h-4 w-4 accent-accent"
                            type="checkbox"
                            aria-label={`Выбрать ${r.projectName}`}
                            checked={actions.selection.selected.has(r.id)}
                            onChange={() => actions.selection.toggle(r.id)}
                            disabled={actions.busy || r.mode === "PROJECT"}
                          />
                        </td>
                        <td className="min-w-[170px] max-w-[270px] px-3 py-4 text-left align-middle">
                          {identity(r, false)}
                        </td>
                        <td className="px-3 py-4 align-middle">
                          <RentalDates row={r} />
                        </td>
                        <td className="px-3 py-4 align-middle">
                          <RentalState row={r} onIssues={() => openIssues(r)} />
                        </td>
                        {expanded && (
                          <>
                            <td className="whitespace-nowrap px-3 py-4 align-middle font-mono text-xs">
                              {formatRub(r.finalAmount)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-4 align-middle font-mono text-xs">
                              {formatRub(r.amountPaid)}
                            </td>
                          </>
                        )}
                        <td className={`${expanded ? "min-w-[200px]" : "min-w-[280px]"} px-3 py-4 align-middle`}>{money(r)}</td>
                        <td className="min-w-[130px] px-3 py-4 align-middle">
                          <DueDate row={r} />
                        </td>
                        {/* С «Начислено и получено» таблица шире экрана: «Действия» закреплены
                            справа. Фон непрозрачный (surface + тон строки градиентом), чтобы
                            под ячейкой не просвечивал прокручиваемый контент. Разделитель —
                            inset-тенью: схлопнутую границу таблицы фон sticky-ячейки перекрывает. */}
                        <td
                          className={`px-3 py-4 align-middle ${
                            expanded
                              ? `sticky right-0 bg-surface bg-gradient-to-r shadow-[inset_1px_0_0] shadow-border ${
                                  actions.selection.selected.has(r.id)
                                    ? "from-accent-soft/40 to-accent-soft/40"
                                    : "group-hover:from-surface-subtle/50 group-hover:to-surface-subtle/50"
                                }`
                              : ""
                          }`}
                        >
                          {rowActions(r)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Дубль «Выбрать все» для карточек: в таблице он живёт в шапке, скрытой до xl. */}
              <label className="mb-2 flex min-h-10 w-fit cursor-pointer items-center gap-2 text-sm text-ink-2 xl:hidden">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={actions.selection.allSelected}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        actions.selection.someSelected &&
                        !actions.selection.allSelected;
                  }}
                  onChange={actions.selection.toggleAll}
                  disabled={actions.busy || !actions.selection.selectableCount}
                />
                Выбрать все загруженные
              </label>
              <div className="grid gap-3 md:grid-cols-2 xl:hidden">
                {rows.map((r) => card(r))}
              </div>
            </>
          )}
          {view === "board" && (
            <>
              <p className="mb-3 text-xs text-ink-3">
                Доска по загруженным бронированиям ({rows.length} из{" "}
                {data?.totalCount ?? 0}). Этап меняется через проверенные
                действия в карточке.
              </p>
              <div className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {REGISTER_STATUSES.map((s) => {
                  const lane = rows.filter((r) => r.status === s);
                  return (
                    <section
                      key={s}
                      className="min-w-0 rounded-lg bg-surface-subtle p-3"
                    >
                      <h2 className="mb-3 flex items-center justify-center gap-2 text-center text-sm font-semibold text-ink">
                        {bookingStatusLabel(s)}{" "}
                        <span className="text-ink-3">{lane.length}</span>
                      </h2>
                      <div className="space-y-3">
                        {lane.map((r) => card(r))}
                        {lane.length === 0 && (
                          <p className="py-6 text-center text-xs text-ink-3">
                            Нет загруженных броней
                          </p>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </>
          )}
          {view === "day" && data && (
            <div className="grid items-start gap-4 xl:grid-cols-[1.3fr_1fr]">
              <section className="min-w-0">
                <h2 className="mb-3 text-sm font-semibold text-ink">
                  Выдачи, возвраты и периоды · {data.day.events.length}
                </h2>
                <div className="space-y-3">
                  {data.day.events.map((event) => {
                    const r = data.day.bookings.find(
                      (b) => b.id === event.bookingId,
                    );
                    return (
                      r && (
                        <article
                          key={event.id}
                          className="rounded-lg border border-border bg-surface p-4 text-center"
                        >
                          <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
                            <span className="text-sm font-semibold text-accent">
                              {event.time ?? "В течение дня"} · {event.label}
                            </span>
                            <span className="text-xs text-ink-3">
                              {event.quantity != null
                                ? `${event.quantity} ед.`
                                : "Начисления за период"}
                            </span>
                          </div>
                          {identity(r)}
                          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                            {money(r)}
                            {rowActions(r)}
                          </div>
                        </article>
                      )
                    );
                  })}
                  {data.day.events.length === 0 && (
                    <p className="rounded-lg border border-border p-8 text-center text-sm text-ink-3">
                      На этот день операций нет
                    </p>
                  )}
                </div>
              </section>
              <section className="min-w-0 space-y-4">
                <div>
                  <h2 className="mb-3 text-sm font-semibold text-ink">
                    Проблемы, просрочки и возвраты
                  </h2>
                  <div className="space-y-3">
                    {data.day.bookings
                      .filter(
                        (r) => r.returnOverdue || Number(r.overdueAmount) > 0 || (r.issues?.openCases ?? 0) > 0,
                      )
                      .map((r) => card(r, false))}
                    {!data.day.bookings.some(
                      (r) => r.returnOverdue || Number(r.overdueAmount) > 0 || (r.issues?.openCases ?? 0) > 0,
                    ) && (
                      <p className="rounded border border-border p-4 text-sm text-ink-3">
                        Просрочек нет
                      </p>
                    )}
                  </div>
                </div>
                <div>
                  <h2 className="mb-3 text-sm font-semibold text-ink">
                    Подготовка и согласование
                  </h2>
                  <div className="space-y-3">
                    {data.day.bookings
                      .filter((r) =>
                        ["DRAFT", "PENDING_APPROVAL"].includes(r.status),
                      )
                      .map((r) => card(r, false))}
                  </div>
                </div>
              </section>
            </div>
          )}
          {view !== "day" && rows.length === 0 && !loading && (
            <div className="rounded-lg border border-dashed border-border p-10 text-center">
              <h2 className="font-semibold text-ink">
                Бронирования не найдены
              </h2>
              <p className="mt-2 text-sm text-ink-3">
                Попробуйте другой период, представление или сбросьте фильтры.
              </p>
              <button className={`${button} mt-4`} onClick={reset}>
                Сбросить фильтры
              </button>
            </div>
          )}
        </div>
      )}
      {view !== "day" && data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-subtle p-4 text-sm">
            <span className="text-ink-2">
              Итого по выборке · {data.totals.count}{" "}
              {pluralBookings(data.totals.count)}
            </span>
            {/* На телефоне — столбик «подпись … сумма» с суммами на общей оси, с sm — в строку. */}
            <div className="grid w-full gap-1 sm:flex sm:w-auto sm:flex-wrap sm:gap-x-5 sm:gap-y-2">
              <span className="flex items-baseline justify-between gap-3 text-ink-2 sm:block">
                Сумма проектов{" "}
                <strong className="font-mono text-ink">{formatRub(data.totals.total)}</strong>
              </span>
              <span className="flex items-baseline justify-between gap-3 text-ink-2 sm:block">
                Получено{" "}
                <strong className="font-mono text-emerald">{formatRub(data.totals.paid)}</strong>
              </span>
              <span className="flex items-baseline justify-between gap-3 text-ink-2 sm:block">
                Осталось получить{" "}
                <strong className="font-mono text-ink">
                  {formatRub(data.totals.outstanding)}
                </strong>
              </span>
              <span className="flex items-baseline justify-between gap-3 text-ink-2 sm:block">
                Просрочено{" "}
                <strong className={`font-mono ${Number(data.totals.overdue) > 0 ? "text-rose" : "text-ink"}`}>
                  {formatRub(data.totals.overdue)}
                </strong>
              </span>
            </div>
          </div>
          <div className="text-center">
            <div ref={autoLoad.sentinelRef} aria-hidden="true" />
            {!data.nextCursor && rows.length > 0 && (
              <p className="text-xs text-ink-3">Показаны все брони</p>
            )}
            {moreError && (
              <p role="alert" className="mb-2 text-sm text-rose">
                {moreError}
              </p>
            )}
            {data.nextCursor && (
              <button
                className={button}
                disabled={moreLoading || loading}
                onClick={more}
              >
                {moreLoading
                  ? "Загрузка…"
                  : moreError
                    ? "Повторить"
                    : `Показать ещё · осталось ${Math.max(0, data.totalCount - rows.length)}`}
              </button>
            )}
          </div>
        </>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
        <p>
          Нажмите на сумму или наведите курсор, чтобы увидеть подробности оплаты.
        </p>
        {data && (
          <p>
            Обновлено{" "}
            {new Date(data.asOf).toLocaleTimeString("ru-RU", {
              timeZone: "Europe/Moscow",
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            МСК
          </p>
        )}
      </footer>
    </div>
      {detail && (
        <RegisterDetail
          row={detail}
          close={() => setDetail(null)}
          pay={
            actions.canPay(detail)
              ? () => {
                  actions.pay(detail);
                  setDetail(null);
                }
              : undefined
          }
          primary={() => {
            actions.primary(detail);
            setDetail(null);
          }}
          onIssues={() => openIssues(detail)}
          primaryLabel={actions.primaryLabel(detail)}
        />
      )}
      {issueBooking && <BookingIssuesPanel key={issueBooking.id} bookingId={issueBooking.id} close={() => setIssueBooking(null)} onChanged={refresh} />}
      <QuickBookingModal
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onCreated={() => {
          setQuickOpen(false);
          refresh();
        }}
      />
      {actions.modals}
    </>
  );
}
