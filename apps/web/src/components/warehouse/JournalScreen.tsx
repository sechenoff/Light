"use client";

/**
 * «Журнал» — учёт работы кладовщика + статистика (сцены 2–3 мокапа v2).
 *
 *  - KPI за период: сессии, позиции, средняя длительность;
 *  - бары «Операции по дням» (7 дней, выдачи + возвраты стеком);
 *  - переключатель «Мои / Все» (scope журнала);
 *  - лента: сессии (операция · бронь · позиций · длительность) и
 *    поломки (оборудование · причина · фото), сгруппированные по дням;
 *  - карточка-ссылка на экран «Поломки» со счётчиками месяца.
 */

import { useEffect, useState } from "react";
import { scanApi, type JournalData, type JournalEntryData } from "./api";
import { isScanApiError } from "./types";
import { pluralize } from "../../lib/format";
import { IconIssue, IconReturn, IconWrench } from "./workstationIcons";

type Scope = "me" | "all";

function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const DAY_LABEL_FMT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
});
const WEEKDAY_FMT = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return "Сегодня";
  if (key === yesterday) return "Вчера";
  return DAY_LABEL_FMT.format(new Date(`${key}T12:00:00`));
}

const REPAIR_STATUS_LABEL: Record<string, string> = {
  WAITING_REPAIR: "ждёт ремонта",
  IN_REPAIR: "в ремонте",
  WAITING_PARTS: "ждёт детали",
  CLOSED: "починено",
  WROTE_OFF: "списано",
};

function EntryRow({ e }: { e: JournalEntryData }) {
  if (e.kind === "REPAIR") {
    return (
      <div className="flex min-h-[48px] items-center gap-2.5 border-b border-surface-subtle px-3.5 py-2 last:border-b-0">
        <span aria-hidden className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-amber">
          <IconWrench className="h-[13px] w-[13px] text-white" strokeWidth={2.2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">
            Поломка · {e.equipmentName}
          </span>
          <span className="block truncate text-[11px] text-ink-3">
            {e.reason}
            {e.photosCount ? ` · фото ×${e.photosCount}` : ""}
            {e.workerName ? ` · ${e.workerName}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="mono-num block text-[11.5px] font-semibold text-ink-2">{hm(e.at)}</span>
          <span className="block text-[10.5px] text-ink-3">
            {REPAIR_STATUS_LABEL[e.repairStatus ?? ""] ?? e.repairStatus}
          </span>
        </span>
      </div>
    );
  }
  const isIssue = e.operation === "ISSUE";
  const Icon = isIssue ? IconIssue : IconReturn;
  return (
    <div className="flex min-h-[48px] items-center gap-2.5 border-b border-surface-subtle px-3.5 py-2 last:border-b-0">
      <span
        aria-hidden
        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md ${isIssue ? "bg-accent-bright" : "bg-teal"}`}
      >
        <Icon className="h-[13px] w-[13px] text-white" strokeWidth={2.2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">
          {isIssue ? "Выдача" : "Приёмка"} · {e.clientName || e.projectName}
        </span>
        <span className="block truncate text-[11px] text-ink-3">
          {e.projectName}
          {e.itemsCount != null
            ? ` · ${e.itemsCount} ${pluralize(e.itemsCount, "позиция", "позиции", "позиций")}`
            : ""}
          {e.workerName ? ` · ${e.workerName}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="mono-num block text-[11.5px] font-semibold text-ink-2">
          {hm(e.at)}
          {e.completedAt ? `–${hm(e.completedAt)}` : ""}
        </span>
        {e.durationMinutes != null && (
          <span className="block text-[10.5px] text-ink-3">{e.durationMinutes} мин</span>
        )}
      </span>
    </div>
  );
}

export function JournalScreen({ onOpenProblems }: { onOpenProblems: () => void }) {
  const [scope, setScope] = useState<Scope>("me");
  const [data, setData] = useState<JournalData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    scanApi
      .getJournal(7, scope)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(isScanApiError(err) ? err.message : "Не удалось загрузить журнал");
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const scopeToggle = (
    <span className="flex gap-1" role="tablist" aria-label="Чей журнал">
      {(["me", "all"] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={scope === s}
          onClick={() => setScope(s)}
          className={`min-h-[28px] rounded-full border px-3 py-0.5 text-[10.5px] font-semibold transition-colors ${
            scope === s
              ? "border-ink bg-ink text-white"
              : "border-border bg-surface text-ink-2 hover:bg-surface-muted"
          }`}
        >
          {s === "me" ? "Мои" : "Все"}
        </button>
      ))}
    </span>
  );

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12 text-sm text-rose">
        {error}
      </div>
    );
  }

  // Группировка ленты по дням.
  const groups: Array<{ key: string; entries: JournalEntryData[] }> = [];
  if (data) {
    const map = new Map<string, JournalEntryData[]>();
    for (const e of data.entries) {
      const k = dayKey(e.at);
      if (!map.has(k)) {
        map.set(k, []);
        groups.push({ key: k, entries: map.get(k)! });
      }
      map.get(k)!.push(e);
    }
  }

  const maxDayOps = data
    ? Math.max(1, ...data.stats.perDay.map((d) => d.issues + d.returns))
    : 1;

  return (
    <div className="flex flex-1 flex-col gap-3 px-3 py-3 lg:px-5 lg:py-4">
      {/* KPI недели */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { l: "Неделя", v: data?.stats.sessions, s: "сессий" },
          { l: "Позиций", v: data?.stats.items, s: "обработано" },
          {
            l: "Средняя",
            v: data?.stats.avgMinutes != null ? `${data.stats.avgMinutes}м` : "—",
            s: "длительность",
          },
        ].map((k) => (
          <div key={k.l} className="rounded-lg border border-border bg-surface px-3 py-2.5 shadow-xs">
            <p className="eyebrow">{k.l}</p>
            <p className="mono-num text-[22px] font-semibold leading-tight">
              {data ? k.v : "…"}
            </p>
            <p className="text-[10.5px] text-ink-3">{k.s}</p>
          </div>
        ))}
      </div>

      {/* Бары по дням */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3.5 py-2.5">
          <h3 className="text-[12.5px] font-semibold">Операции по дням</h3>
          {scopeToggle}
        </div>
        <div className="flex h-[96px] items-end gap-1.5 px-3.5 pb-1.5 pt-3" aria-hidden>
          {(data?.stats.perDay ?? Array.from({ length: 7 }, () => null)).map(
            (d, i) => {
              const issuesH = d ? (d.issues / maxDayOps) * 100 : 0;
              const returnsH = d ? (d.returns / maxDayOps) * 100 : 0;
              const isToday = i === 6;
              return (
                <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                  <div className="flex w-full max-w-[34px] flex-1 flex-col justify-end gap-0.5">
                    {issuesH > 0 && (
                      <div className="rounded-t-[3px] bg-accent-bright" style={{ height: `${issuesH * 0.72}%` }} />
                    )}
                    {returnsH > 0 && (
                      <div className="rounded-b-[2px] bg-teal" style={{ height: `${returnsH * 0.72}%` }} />
                    )}
                  </div>
                  <span
                    className={`mono-num text-[9.5px] ${isToday ? "font-bold text-accent-bright" : "text-ink-3"}`}
                  >
                    {d ? WEEKDAY_FMT.format(new Date(`${d.date}T12:00:00`)) : ""}
                  </span>
                </div>
              );
            },
          )}
        </div>
        <div className="flex gap-3.5 px-3.5 pb-3 text-[11px] text-ink-2">
          <span className="flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px] bg-accent-bright" />
            Выдачи
          </span>
          <span className="flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px] bg-teal" />
            Возвраты
          </span>
        </div>
      </section>

      {/* Ссылка на «Поломки» со счётчиками месяца — виден на мобильном
          (на десктопе Поломки — отдельный пункт rail). */}
      <button
        type="button"
        onClick={onOpenProblems}
        className="flex items-center gap-2.5 rounded-lg border border-amber-border bg-amber-soft px-3.5 py-3 text-left transition-colors hover:bg-surface lg:hidden"
      >
        <IconWrench className="h-5 w-5 shrink-0 text-amber" strokeWidth={2} />
        <span className="flex-1 text-[13px] font-semibold text-amber">
          Поломки и потеряшки
        </span>
        <span className="text-[11px] text-amber/80">
          {data
            ? `${data.stats.repairsMonth} рем. · ${data.stats.problemsMonth} потер. · ${data.stats.closedMonth} почин.`
            : "…"}
        </span>
      </button>

      {/* Лента */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3.5 py-2.5">
          <h3 className="text-[12.5px] font-semibold">Лента операций</h3>
          <span className="text-[11px] text-ink-3">за 7 дней</span>
        </div>
        {!data ? (
          <div className="space-y-2 p-3.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[44px] animate-pulse rounded bg-surface-muted" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-sm text-ink-3">
            {scope === "me"
              ? "У вас пока нет завершённых операций за неделю."
              : "За неделю операций не было."}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              <p className="border-b border-surface-subtle bg-surface-muted px-3.5 pb-1 pt-2 font-cond text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">
                {dayLabel(g.key)}
              </p>
              {g.entries.map((e) => (
                <EntryRow key={`${e.kind}-${e.id}`} e={e} />
              ))}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
