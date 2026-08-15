"use client";

/**
 * «Смена» — домашний экран рабочего стола кладовщика.
 *
 * Показывает (сцена 1 мокапа 05-workstation-v2):
 *  - rose-алерт при просроченных возвратах;
 *  - KPI: выдачи/возвраты «сделано / план», просрочка;
 *  - две большие кнопки «Выдача» / «Приёмка» (переход на табы);
 *  - ленту «План на сегодня» (время · клиент · проект · статус);
 *  - карточку «Моя смена» (сессии, позиции, средняя, время с начала).
 *
 * Данные приходят сверху (page-level fetch /api/warehouse/shift) — они же
 * питают бейджи таб-бара, чтобы не дублировать запрос.
 */

import type { ShiftSummaryData, ShiftTimelineEntry } from "./api";
import { pluralize } from "../../lib/format";
import {
  IconAlert,
  IconCheck,
  IconIssue,
  IconReturn,
  IconWrench,
} from "./workstationIcons";

function hm(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** «6ч 48м» от firstAt до сейчас. */
function sinceLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

const SHORT_DATE_FMT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
});

/** «9 авг» — когда ремонт закрыли. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return SHORT_DATE_FMT.format(d).replace(".", "");
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

const DAY_FMT = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

export function shiftHeaderTitle(workerName: string): string {
  return `${greeting()}, ${workerName}`;
}

export function shiftHeaderEyebrow(): string {
  return `Склад · ${DAY_FMT.format(new Date())}`;
}

function StatusPill({ entry }: { entry: ShiftTimelineEntry }) {
  if (entry.status === "DONE") {
    return (
      <span className="whitespace-nowrap rounded-full bg-emerald-soft px-2 py-0.5 text-[10.5px] font-semibold text-emerald">
        {entry.kind === "ISSUE" ? "Выдано" : "Принято"} {hm(entry.doneAt)}
      </span>
    );
  }
  if (entry.status === "OVERDUE") {
    return (
      <span className="whitespace-nowrap rounded-full bg-rose-soft px-2 py-0.5 text-[10.5px] font-semibold text-rose">
        Просрочен {entry.overdueDays} {pluralize(entry.overdueDays, "день", "дня", "дней")}
      </span>
    );
  }
  // PENDING: «через N мин» если < 90 мин, иначе «Ожидается».
  const diffMin = Math.round(
    (new Date(entry.plannedAt).getTime() - Date.now()) / 60000,
  );
  if (diffMin > 0 && diffMin <= 90) {
    return (
      <span className="whitespace-nowrap rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
        Через {diffMin} мин
      </span>
    );
  }
  if (diffMin <= 0) {
    return (
      <span className="whitespace-nowrap rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
        Пора
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-semibold text-ink-2">
      Ожидается
    </span>
  );
}

function TimelineRow({
  entry,
  onOpen,
}: {
  entry: ShiftTimelineEntry;
  onOpen?: (entry: ShiftTimelineEntry) => void;
}) {
  const done = entry.status === "DONE";
  const Icon = entry.kind === "ISSUE" ? IconIssue : IconReturn;
  const body = (
    <>
      <span
        className={`mono-num w-[44px] shrink-0 text-[12px] font-semibold ${
          entry.status === "OVERDUE" ? "text-rose" : done ? "text-ink-3" : "text-ink-2"
        }`}
      >
        {entry.status === "OVERDUE"
          ? `−${entry.overdueDays} дн`
          : hm(entry.plannedAt)}
      </span>
      <span
        aria-hidden
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          entry.status === "OVERDUE"
            ? "bg-rose"
            : entry.kind === "ISSUE"
              ? "bg-accent-bright"
              : "bg-teal"
        }`}
      >
        {done ? (
          <IconCheck className="h-3 w-3 text-white" strokeWidth={2.6} />
        ) : (
          <Icon className="h-3 w-3 text-white" strokeWidth={2.4} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] font-medium ${done ? "text-ink-3 line-through decoration-ink-3/40" : "text-ink"}`}
        >
          {entry.clientName || "Клиент"} · {entry.projectName}
        </span>
        <span className="block text-[11px] text-ink-3">
          {entry.itemsCount} {pluralize(entry.itemsCount, "позиция", "позиции", "позиций")}
        </span>
      </span>
      <StatusPill entry={entry} />
    </>
  );

  if (!onOpen || done) {
    return (
      <div className="flex min-h-[52px] items-center gap-2 border-b border-surface-subtle px-3.5 py-2 last:border-b-0">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="flex min-h-[52px] w-full items-center gap-2 border-b border-surface-subtle px-3.5 py-2 text-left transition-colors last:border-b-0 hover:bg-surface-muted"
    >
      {body}
    </button>
  );
}

export function ShiftHome({
  data,
  error,
  onRetry,
  onGoIssue,
  onGoReturn,
  onGoOverdue,
  onOpenEntry,
}: {
  data: ShiftSummaryData | null;
  error: string | null;
  onRetry: () => void;
  onGoIssue: () => void;
  onGoReturn: () => void;
  /** Открыть «В работе» с фокусом на просрочке. */
  onGoOverdue: () => void;
  /** Тап по строке ленты (PENDING) → открыть соответствующий поток. */
  onOpenEntry: (entry: ShiftTimelineEntry) => void;
}) {
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <p className="text-sm text-rose">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-border-strong bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-muted"
        >
          Повторить
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 flex-col gap-3 px-3 py-3 lg:px-5 lg:py-4">
        {[64, 76, 60, 200].map((h, i) => (
          <div
            key={i}
            className="animate-pulse rounded-lg bg-surface-s bg-surface-muted"
            style={{ height: h }}
          />
        ))}
      </div>
    );
  }

  const { counters, myShift, timeline, overdue } = data;
  const shiftDuration = sinceLabel(myShift.firstAt);
  // Поле добавлено позже самого экрана — старый ответ сервера не должен ронять
  // смену пустым массивом по умолчанию.
  const readyForPickup = data.readyForPickup ?? [];

  return (
    <div className="flex flex-1 flex-col gap-3 px-3 py-3 lg:px-5 lg:py-4">
      {/* Просрочка */}
      {overdue.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-rose-border bg-rose-soft px-3.5 py-2.5 text-[12.5px] text-rose">
          <IconAlert className="mt-0.5 h-[17px] w-[17px] shrink-0" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {overdue.length}{" "}
              {pluralize(overdue.length, "просроченный возврат", "просроченных возврата", "просроченных возвратов")}
            </p>
            <p className="truncate">
              {overdue
                .slice(0, 3)
                .map(
                  (o) =>
                    `${o.clientName || o.projectName} — ${o.overdueDays} ${pluralize(o.overdueDays, "день", "дня", "дней")}`,
                )
                .join(" · ")}
            </p>
          </div>
          <button
            type="button"
            onClick={onGoOverdue}
            className="shrink-0 self-center text-[11.5px] font-semibold underline"
          >
            Открыть
          </button>
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border bg-surface px-3 py-2.5 shadow-xs">
          <p className="eyebrow">Выдачи</p>
          <p className="mono-num text-[22px] font-semibold leading-tight">
            {counters.issuesDone}
            <span className="text-[13px] text-ink-3">/{counters.issuesPlanned}</span>
          </p>
          <p className="text-[10.5px] text-ink-3">сделано / план</p>
        </div>
        <div className="rounded-lg border border-border bg-surface px-3 py-2.5 shadow-xs">
          <p className="eyebrow">Возвраты</p>
          <p className="mono-num text-[22px] font-semibold leading-tight">
            {counters.returnsDone}
            <span className="text-[13px] text-ink-3">/{counters.returnsPlanned}</span>
          </p>
          <p className="text-[10.5px] text-ink-3">сделано / план</p>
        </div>
        <div
          className={`rounded-lg border px-3 py-2.5 shadow-xs ${
            counters.overdue > 0
              ? "border-rose-border bg-rose-soft"
              : "border-border bg-surface"
          }`}
        >
          <p className={`eyebrow ${counters.overdue > 0 ? "!text-rose" : ""}`}>
            Просрочка
          </p>
          <p
            className={`mono-num text-[22px] font-semibold leading-tight ${counters.overdue > 0 ? "text-rose" : ""}`}
          >
            {counters.overdue}
          </p>
          <p className={`text-[10.5px] ${counters.overdue > 0 ? "text-rose/80" : "text-ink-3"}`}>
            {counters.overdue > 0 ? "возврата ждём" : "всё в срок"}
          </p>
        </div>
      </div>

      {/* Быстрые действия */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onGoIssue}
          className="flex min-h-[60px] items-center gap-2.5 rounded-lg border border-accent-border bg-accent-soft p-3.5 text-left text-accent-bright transition-colors hover:bg-surface"
        >
          <IconIssue className="h-6 w-6 shrink-0" strokeWidth={2} />
          <span>
            <span className="block font-cond text-[16px] font-bold leading-tight">
              Выдача
            </span>
            <span className="block text-[10.5px] opacity-75">
              {counters.issuesPlanned - counters.issuesDone > 0
                ? `${counters.issuesPlanned - counters.issuesDone} ${pluralize(counters.issuesPlanned - counters.issuesDone, "бронь ждёт", "брони ждут", "броней ждут")}`
                : "плановых нет"}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onGoReturn}
          className="flex min-h-[60px] items-center gap-2.5 rounded-lg border border-teal-border bg-teal-soft p-3.5 text-left text-teal transition-colors hover:bg-surface"
        >
          <IconReturn className="h-6 w-6 shrink-0" strokeWidth={2} />
          <span>
            <span className="block font-cond text-[16px] font-bold leading-tight">
              Приёмка
            </span>
            <span className="block text-[10.5px] opacity-75">
              {counters.returnsPlanned - counters.returnsDone > 0 || counters.overdue > 0
                ? [
                    counters.returnsPlanned - counters.returnsDone > 0
                      ? `${counters.returnsPlanned - counters.returnsDone} план.`
                      : null,
                    counters.overdue > 0 ? `${counters.overdue} просроч.` : null,
                  ]
                    .filter(Boolean)
                    .join(" + ")
                : "плановых нет"}
            </span>
          </span>
        </button>
      </div>

      {/* Вернулось из ремонта.
          Ремонт закрыт — по учёту прибор снова «в наличии», но физически он на
          верстаке у техника. Пока кладовщик не заберёт его и не поставит на
          место, за ним бегут в момент выдачи, при клиенте. Список закрывается
          сам: сервер отдаёт только последние 7 дней. */}
      {readyForPickup.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-emerald-border bg-surface shadow-xs">
          <div className="flex items-center justify-between gap-2 border-b border-emerald-border bg-emerald-soft px-3.5 py-2.5">
            <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-emerald">
              <IconWrench className="h-4 w-4 shrink-0" strokeWidth={2} />
              Вернулось из ремонта
            </h3>
            <span className="mono-num text-[11px] font-semibold text-emerald">
              {readyForPickup.length}
            </span>
          </div>
          <ul>
            {readyForPickup.map((r) => (
              <li
                key={r.repairId}
                className="flex min-h-[40px] items-center gap-2 border-b border-surface-subtle px-3.5 py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{r.title}</span>
                <span className="shrink-0 text-[11px] text-ink-3">
                  починено {shortDate(r.closedAt)}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-surface-subtle px-3.5 py-2 text-[11px] text-ink-3">
            Забрать с верстака и вернуть на место — по учёту это уже свободно.
          </p>
        </section>
      )}

      {/* Лента дня */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3.5 py-2.5">
          <h3 className="text-[12.5px] font-semibold">План на сегодня</h3>
          <span className="text-[11px] text-ink-3">
            {timeline.length} {pluralize(timeline.length, "операция", "операции", "операций")}
            {overdue.length > 0 ? ` + ${overdue.length} просроч.` : ""}
          </span>
        </div>
        {timeline.length === 0 && overdue.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-sm text-ink-3">
            На сегодня выдач и возвратов нет.
          </p>
        ) : (
          <div>
            {timeline.map((e) => (
              <TimelineRow key={`${e.kind}-${e.bookingId}`} entry={e} onOpen={onOpenEntry} />
            ))}
            {overdue.map((e) => (
              <TimelineRow key={`ov-${e.bookingId}`} entry={e} onOpen={onOpenEntry} />
            ))}
          </div>
        )}
      </section>

      {/* Моя смена */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3.5 py-2.5">
          <h3 className="text-[12.5px] font-semibold">Моя смена</h3>
          <span className="text-[11px] text-ink-3">{myShift.workerName}</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3.5 py-3 text-[12px] text-ink-2">
          <span>
            <span className="mono-num font-semibold text-ink">{myShift.sessions}</span>{" "}
            {pluralize(myShift.sessions, "сессия", "сессии", "сессий")}
          </span>
          <span>
            <span className="mono-num font-semibold text-ink">{myShift.items}</span>{" "}
            {pluralize(myShift.items, "позиция", "позиции", "позиций")}
          </span>
          {myShift.avgMinutes != null && (
            <span>
              средняя{" "}
              <span className="mono-num font-semibold text-ink">{myShift.avgMinutes}м</span>
            </span>
          )}
          {shiftDuration && (
            <span className="ml-auto">
              <span className="mono-num font-semibold text-ink">{shiftDuration}</span> на смене
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
