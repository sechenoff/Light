"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookingJournalSection } from "../BookingJournalSection";
import { auditTimestamp } from "../../../lib/auditFormat";
import { apiFetch } from "../../../lib/api";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { bookingStatusLabel } from "../../../lib/bookingConstants";
import { ProjectActionDialog, type ProjectAction } from "./ProjectActionDialog";
import { BookingIssuesButton } from "../issues/BookingIssuesPanel";
import { readBookingsListHref } from "../bookingsListNav";
import {
  projectButton as btn,
  projectPrimary as primary,
  projectInput as input,
  projectMoney as money,
  shortProjectDate as date,
  todayMoscow,
  type ProjectData,
  type ProjectLot,
} from "./types";

export function ProjectBookingDetail({ bookingId }: { bookingId: string }) {
  const [listHref, setListHref] = useState("/bookings?mode=PROJECT");
  useEffect(() => { setListHref(readBookingsListHref()); }, []);
  const { user } = useCurrentUser();
  const isAdmin = user?.role === "SUPER_ADMIN";
  const [p, setProject] = useState<ProjectData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("equipment");
  const [viewDate, setViewDate] = useState(todayMoscow());
  const [month, setMonth] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [dialog, setDialog] = useState<{
    action: ProjectAction;
    lot?: ProjectLot;
    periodId?: string;
  } | null>(null);
  const reload = useCallback(async () => {
    try {
      const data = await apiFetch<ProjectData>(
        `/api/booking-projects/${bookingId}`,
      );
      setProject(data);
      setError("");
      setMonth((old) => old || data.fromDate.slice(0, 7));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить проект");
    }
  }, [bookingId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (!p)
    return (
      <div className="p-6">
        {error ? (
          <>
            <p role="alert" className="text-rose">
              {error}
            </p>
            <button className={btn} onClick={() => void reload()}>
              Повторить
            </button>
          </>
        ) : (
          <p>Загружаем проект…</p>
        )}
      </div>
    );
  const active = !["RETURNED", "CANCELLED"].includes(p.booking.status);
  const atClient = p.lots
    .filter((l) => l.status === "ISSUED")
    .reduce(
      (s, l) => s + l.quantity - l.returns.reduce((n, r) => n + r.quantity, 0),
      0,
    );
  const planned = p.lots.filter((l) => l.status === "PLANNED");
  const overdue = p.lots.filter(
    (l) => l.status === "ISSUED" && l.throughDate < todayMoscow(),
  );
  const months = [...new Set(p.days.map((d) => d.date.slice(0, 7)))];
  const currentDays = p.days.filter((d) => d.date.startsWith(month));
  const locked =
    p.periods
      .filter((x) => x.kind === "PERIOD")
      .map((x) => x.throughDate)
      .sort()
      .at(-1) ?? "";
  const action = (a: ProjectAction, lot?: ProjectLot, periodId?: string) =>
    setDialog({ action: a, lot, periodId });
  const documentLink = (id: string, format: string) =>
    `/api/booking-projects/${bookingId}/documents/${id}/${format}`;
  const moscowDay = (value: string) =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
      new Date(value),
    );
  const atDate = (lot: ProjectLot) => {
    if (lot.status === "CANCELLED") return 0;
    if (lot.status === "PLANNED")
      return lot.fromDate <= viewDate && lot.throughDate >= viewDate
        ? lot.quantity
        : 0;
    if (!lot.issuedAt || moscowDay(lot.issuedAt) > viewDate) return 0;
    return (
      lot.quantity -
      lot.returns.reduce(
        (sum, r) =>
          sum + (moscowDay(r.returnedAt) <= viewDate ? r.quantity : 0),
        0,
      )
    );
  };
  const visibleLots = p.lots.filter((l) => showHistory || atDate(l) > 0);
  const nextOperation = [
    ...planned.map((l) => ({
      date: l.fromDate,
      label: `Выдача: ${l.nameSnapshot} × ${l.quantity}`,
    })),
    ...p.lots
      .filter((l) => l.status === "ISSUED")
      .map((l) => ({
        date: l.throughDate,
        label: `Возврат: ${l.nameSnapshot}`,
      })),
  ].sort((a, b) => a.date.localeCompare(b.date))[0];
  return (
    <div className="p-4 lg:p-6">
      <Link href={listHref} className="text-sm text-ink-3">
        ← К списку бронирований
      </Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow text-ink-3">Длинный проект</p>
          <h1 className="mt-1 font-cond text-3xl text-ink lg:text-4xl">
            {p.booking.projectName}
          </h1>
          <p className="mt-2 text-sm text-ink-3">
            {p.booking.client.name} · {date(p.fromDate)} — {date(p.throughDate)}{" "}
            ·{" "}
            {bookingStatusLabel(
              p.booking.status as Parameters<typeof bookingStatusLabel>[0],
            )}
          </p>
          <p className="mt-1 text-sm text-ink-3">
            Съёмочных: {p.days.filter((d) => d.kind === "SHOOT").length} ·
            Выходных: {p.days.filter((d) => d.kind === "REST").length} по{" "}
            {Number(p.restFactor) * 100}% · Расчёт{" "}
            {p.billingCycle === "WEEKLY" ? "по неделям" : "по месяцам"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className={btn}
            href={documentLink("forecast", "pdf")}
            target="_blank"
            rel="noreferrer"
          >
            Смета PDF
          </a>
          <a className={btn} href={documentLink("forecast", "xlsx")}>
            XLSX
          </a>
        </div>
      </div>
      <BookingIssuesButton bookingId={bookingId} />
      {error && (
        <p role="alert" className="mt-4 rounded bg-rose-soft p-3 text-rose">
          {error}
        </p>
      )}
      <div className="my-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          ["Прогноз проекта", p.forecast.total],
          ["Начислено по периодам", p.booking.finalAmount],
          ["Получено", p.booking.amountPaid],
          ["К оплате", p.booking.amountOutstanding],
        ].map(([label, value]) => (
          <div
            className="rounded-lg border border-border bg-surface p-3 sm:p-4"
            key={label}
          >
            <p className="text-xs text-ink-3">{label}</p>
            <p className="mt-2 font-cond text-2xl text-ink break-words">
              {money(value)}
            </p>
          </div>
        ))}
      </div>
      {Number(p.advance) > 0 && (
        <p className="mb-4 text-sm text-emerald">
          Аванс на следующие периоды: {money(p.advance)}
        </p>
      )}
      <div className="sticky top-0 z-10 mb-4 flex flex-wrap gap-2 rounded-lg border border-border bg-surface p-3 shadow-sm">
        {active && (
          <button className={primary} onClick={() => action("ADD")}>
            + Добор
          </button>
        )}
        {isAdmin && p.booking.status === "DRAFT" && (
          <button className={primary} onClick={() => action("CONFIRM")}>
            Забронировать проект
          </button>
        )}
        {isAdmin &&
          p.nextPeriod &&
          ["CONFIRMED", "ISSUED", "RETURNED"].includes(p.booking.status) && (
            <button className={btn} onClick={() => action("CLOSE")}>
              Закрыть период
            </button>
          )}
        {isAdmin && p.booking.status !== "CANCELLED" && (
          <button className={btn} onClick={() => action("PAYMENT")}>
            Принять оплату
          </button>
        )}
        {active && p.lots.some((l) => l.issuedAt) && (
          <button className={btn} onClick={() => action("FINISH")}>
            Завершить проект
          </button>
        )}
        {isAdmin && active && !p.lots.some((l) => l.issuedAt) && (
          <button className={btn} onClick={() => action("CANCEL_PROJECT")}>
            Отменить проект
          </button>
        )}
      </div>
      {p.booking.status === "DRAFT" && (
        <p className="mb-4 rounded border border-amber-border bg-amber-soft p-3 text-sm text-ink">
          Черновик: добавьте основной комплект и проверьте календарь. Резерв
          появится после подтверждения руководителем.
        </p>
      )}
      {overdue.length > 0 && (
        <p
          role="status"
          className="mb-4 rounded border border-rose-border bg-rose-soft p-3 text-sm text-rose"
        >
          Просрочен плановый возврат {overdue.length} поставок. Техника остаётся
          занятой до приёмки. Продлите срок или оформите возврат.
        </p>
      )}
      {nextOperation && (
        <p className="mb-4 text-sm text-ink-3">
          Ближайшее действие: {date(nextOperation.date)} · {nextOperation.label}
        </p>
      )}
      <nav
        aria-label="Разделы проекта"
        className="mb-5 flex flex-wrap gap-2 border-b border-border pb-3"
      >
        {[
          ["equipment", "Оборудование"],
          ["calendar", "Календарь"],
          ["finance", "Расчёты"],
          ["history", "История"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={tab === key ? primary : btn}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "equipment" && (
        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              У клиента сейчас: <strong>{atClient}</strong> шт. · Ожидают
              выдачи: {planned.length} поставок
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                На дату
                <input
                  className={input + " !w-auto"}
                  type="date"
                  value={viewDate}
                  onChange={(e) => setViewDate(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showHistory}
                  onChange={(e) => setShowHistory(e.target.checked)}
                />
                Все поставки
              </label>
            </div>
          </div>
          {visibleLots.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-ink-3">
              <p>На выбранную дату поставок нет.</p>
              <button
                className={btn + " mt-3"}
                onClick={() => setShowHistory(true)}
              >
                Показать все поставки
              </button>
            </div>
          )}
          <div className="space-y-3">
            {visibleLots.map((l) => {
              const remaining =
                l.quantity - l.returns.reduce((s, r) => s + r.quantity, 0);
              return (
                <article
                  key={l.id}
                  className="rounded-lg border border-border bg-surface p-4"
                >
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h2 className="font-medium text-ink">
                        {l.nameSnapshot} × {l.quantity}
                      </h2>
                      <p className="mt-1 text-xs text-ink-3">
                        {date(l.fromDate)} — {date(l.throughDate)} включительно
                        · {money(l.ratePerShift)} / смена
                      </p>
                      <p className="mt-2 text-sm text-ink">
                        {l.status === "PLANNED"
                          ? "Ожидает выдачи"
                          : l.status === "ISSUED"
                            ? `У клиента сейчас: ${remaining} шт.`
                            : l.status === "RETURNED"
                              ? "Возвращено / урегулировано"
                              : "Отменено"}
                      </p>
                      {!showHistory && (
                        <p className="mt-1 text-xs text-ink-3">
                          На конец {date(viewDate)}: {atDate(l)} шт.
                          {l.status === "PLANNED" ? " по плану" : ""}
                        </p>
                      )}
                      {l.returns.length > 0 && (
                        <p className="mt-1 text-xs text-ink-3">
                          Принято / снято с клиента: {l.quantity - remaining}{" "}
                          шт. История сохранена.
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap content-start gap-2">
                      {active && l.status === "PLANNED" && (
                        <>
                          {p.booking.status !== "DRAFT" && (
                            <button
                              className={primary}
                              onClick={() => action("ISSUE", l)}
                            >
                              Выдать
                            </button>
                          )}
                          <button
                            className={btn}
                            onClick={() => action("CANCEL", l)}
                          >
                            Отменить
                          </button>
                        </>
                      )}
                      {active && l.status === "ISSUED" && (
                        <button
                          className={primary}
                          onClick={() => action("RETURN", l)}
                        >
                          Принять часть / всё
                        </button>
                      )}
                      {active && ["PLANNED", "ISSUED"].includes(l.status) && (
                        <button
                          className={btn}
                          onClick={() => action("EXTEND", l)}
                        >
                          Продлить
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-ink-3">
                    Поставка {l.id.slice(-6).toUpperCase()}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}
      {tab === "calendar" && (
        <section className="max-w-4xl">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="text-sm">
              Месяц
              <select
                className={input}
                value={month}
                onChange={(e) => setMonth(e.target.value)}
              >
                {months.map((m) => (
                  <option key={m} value={m}>
                    {new Date(m + "-01T12:00:00Z").toLocaleDateString("ru-RU", {
                      month: "long",
                      year: "numeric",
                    })}
                  </option>
                ))}
              </select>
            </label>
            {active && (
              <button className={btn} onClick={() => action("CALENDAR")}>
                Заполнить диапазон
              </button>
            )}
          </div>
          <p className="mb-4 text-sm text-ink-3">
            Съёмочный день — 100%, выходной — {Number(p.restFactor) * 100}%.
            Техника занята в оба типа дня. Закрытые дни защищены от изменения.
          </p>
          <div className="grid grid-cols-7 gap-1 sm:gap-2">
            {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
              <div key={d} className="pb-1 text-center text-xs text-ink-3">
                {d}
              </div>
            ))}
            {Array.from(
              {
                length: currentDays.length
                  ? (new Date(currentDays[0].date + "T12:00:00Z").getUTCDay() +
                      6) %
                    7
                  : 0,
              },
              (_, i) => (
                <div key={`gap-${i}`} />
              ),
            )}
            {currentDays.map((d) => (
              <div
                key={d.date}
                className={`rounded border p-1 sm:p-3 ${d.kind === "REST" ? "border-amber-border bg-amber-soft" : "border-border bg-surface"}`}
              >
                <p className="text-center text-sm text-ink">
                  {Number(d.date.slice(-2))}
                </p>
                <p className="mt-1 text-center text-[10px] text-ink-3 sm:text-xs">
                  {d.kind === "REST"
                    ? `${Number(p.restFactor) * 100}%`
                    : "100%"}
                </p>
                {d.date <= locked && (
                  <p className="text-center text-[10px] text-ink-3">закр.</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {tab === "finance" && (
        <section className="space-y-5">
          {p.nextPeriod && (
            <div className="rounded-lg border border-accent-border bg-accent-soft p-4">
              <p className="text-sm text-ink">
                Открытый период: {date(p.nextPeriod.fromDate)} —{" "}
                {date(p.nextPeriod.throughDate)}
              </p>
              <p className="mt-2 font-cond text-2xl">
                {money(p.nextPeriod.total)}
              </p>
              <p className="mt-1 text-xs text-ink-3">
                Предварительно по выданному оборудованию. При закрытии можно
                выбрать другую конечную дату.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {isAdmin && active && (
              <button className={btn} onClick={() => action("CHARGE")}>
                + Доставка / услуга
              </button>
            )}
            <Link href="/finance/payments" className={btn}>
              Общий журнал платежей
            </Link>
          </div>
          <div>
            <h2 className="mb-3 text-lg font-medium">Закрытые периоды</h2>
            {p.periods.length === 0 && (
              <p className="text-sm text-ink-3">
                Периодов пока нет. Аванс можно принять до первого закрытия.
              </p>
            )}
            <div className="space-y-3">
              {p.periods.map((period) => {
                const a = p.allocations.find((x) => x.periodId === period.id);
                return (
                  <article
                    key={period.id}
                    className="rounded-lg border border-border bg-surface p-4"
                  >
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-medium">
                          {period.kind === "CORRECTION"
                            ? "Корректировка"
                            : period.invoice?.number}{" "}
                          · {date(period.fromDate)} — {date(period.throughDate)}
                        </h3>
                        <p className="mt-1 text-lg">{money(period.amount)}</p>
                        {a && (
                          <p className="mt-1 text-xs text-ink-3">
                            С учётом корректировок: {money(a.charged)} ·
                            Зачтено: {money(a.paid)} · Осталось:{" "}
                            {money(a.outstanding)} · Срок оплаты:{" "}
                            {date(period.dueDate)}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap content-start gap-2">
                        <a
                          className={btn}
                          href={documentLink(period.id, "pdf")}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PDF
                        </a>
                        <a
                          className={btn}
                          href={documentLink(period.id, "xlsx")}
                        >
                          XLSX
                        </a>
                        {isAdmin && period.kind === "PERIOD" && (
                          <button
                            className={btn}
                            onClick={() =>
                              action("CORRECTION", undefined, period.id)
                            }
                          >
                            Корректировка
                          </button>
                        )}
                      </div>
                    </div>
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer text-ink-3">
                        Детализация
                      </summary>
                      <div className="mt-2 space-y-2">
                        {(
                          JSON.parse(period.linesJson) as Array<{
                            name: string;
                            amount: string;
                            quantity: number;
                          }>
                        ).map((l, i) => (
                          <p key={i} className="flex justify-between gap-3">
                            <span>
                              {l.name} × {l.quantity}
                            </span>
                            <span className="shrink-0">{money(l.amount)}</span>
                          </p>
                        ))}
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          </div>
          {p.charges.length > 0 && (
            <div>
              <h2 className="mb-2 font-medium">Доставка и услуги</h2>
              {p.charges.map((c) => (
                <p className="py-1 text-sm" key={c.id}>
                  {date(c.date)} · {c.description} · {money(c.amount)}
                </p>
              ))}
            </div>
          )}
          <div>
            <h2 className="mb-2 font-medium">Платежи</h2>
            {p.payments.length === 0 ? (
              <p className="text-sm text-ink-3">Платежей пока нет.</p>
            ) : (
              p.payments.map((payment) => (
                <p
                  className={`py-1 text-sm ${payment.voidedAt ? "text-ink-3 line-through" : ""}`}
                  key={payment.id}
                >
                  {payment.receivedAt ? date(payment.receivedAt) : "Ожидается"}{" "}
                  · {money(payment.amount)}{" "}
                  {payment.comment ? `· ${payment.comment}` : ""}
                </p>
              ))
            )}
          </div>
        </section>
      )}
      {tab === "history" && (
        <section className="max-w-4xl space-y-3">
          {isAdmin ? <BookingJournalSection key={p.revision} bookingId={bookingId} canViewAudit financeEvents={null} /> : p.events.map((e) => (
            <article key={e.id} className="border-b border-border pb-3">
              <p className="text-sm text-ink">{e.text}</p>
              <p className="mt-1 text-xs text-ink-3">
                {e.createdByName ?? "Автор не сохранён"} · {auditTimestamp(e.createdAt)}
              </p>
            </article>
          ))}
        </section>
      )}
      {dialog && (
        <ProjectActionDialog
          key={`${dialog.action}-${dialog.lot?.id ?? ""}-${dialog.periodId ?? ""}`}
          project={p}
          {...dialog}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
