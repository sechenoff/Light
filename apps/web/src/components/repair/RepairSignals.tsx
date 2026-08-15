"use client";

/**
 * Верхние сигналы раздела «Мастерская»: сирена срыва, светофор, деньги,
 * «взять следующее» и строка готового к выдаче.
 *
 * Порядок не случаен. Владелец открывает раздел утром и должен за три секунды
 * понять, надо ли кому-то звонить, — поэтому первым идёт не список, а счётчик
 * срыва с конкретными бронями и именами гафферов. Светофор виден всем трём
 * ролям, деньги — только руководителю (сервер отдаёт им null).
 */

import Link from "next/link";
import { useState } from "react";

import { MONTHS_LOCATIVE, formatRub, pluralize } from "../../lib/format";
import { RepairIcon, QuantityTag } from "./RepairRiskBadge";
import {
  daysAgo,
  formatDayMonth,
  lastActivityAt,
  type RepairListItem,
  type RepairStats,
} from "./types";

// ── 1 · Сирена ───────────────────────────────────────────────────────────────

export function RepairSiren({ blocking }: { blocking: RepairListItem[] }) {
  if (blocking.length === 0) {
    // Когда риска нет — экран молчит. Пустая красная полоса приучает не смотреть.
    return (
      <section
        aria-label="Ремонты, срывающие брони"
        className="mt-3.5 flex items-center gap-2 rounded-lg border border-emerald-border bg-emerald-soft px-3.5 py-2 text-xs text-emerald"
      >
        <RepairIcon name="check" />
        <span className="font-semibold">Ни один ремонт не мешает броням</span>
      </section>
    );
  }

  const firstBookingId = blocking.find((r) => r.risk.booking)?.risk.booking?.id;

  return (
    <section
      aria-label="Ремонты, срывающие брони"
      className="mt-3.5 grid overflow-hidden rounded-lg border border-l-[3px] border-rose-border border-l-rose bg-rose-soft md:grid-cols-[auto_minmax(0,1fr)] lg:grid-cols-[auto_minmax(0,1fr)_auto]"
    >
      <div className="flex items-center gap-3 border-b border-rose-border px-4 py-3 md:border-b-0 md:border-r">
        <span className="mono-num text-[38px] font-semibold leading-none tracking-[-0.03em] text-rose">
          {blocking.length}
        </span>
        <span className="font-cond text-[14.5px] font-bold leading-[1.18] text-rose md:max-w-[132px]">
          {pluralize(blocking.length, "ремонт", "ремонта", "ремонтов")} срывают брони
        </span>
      </div>

      <div className="flex min-w-0 flex-col justify-center gap-1.5 px-4 py-2.5">
        {blocking.slice(0, 4).map((r) => {
          const b = r.risk.booking;
          const late =
            r.risk.slackDays !== null && r.risk.slackDays < 0
              ? Math.abs(r.risk.slackDays)
              : null;
          return (
            <p
              key={r.id}
              className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink"
            >
              <span className="mono-num whitespace-nowrap font-semibold text-rose">
                {b ? formatDayMonth(b.startDate) : "срок неизвестен"}
              </span>
              <span className="font-semibold">{b?.projectName ?? r.title}</span>
              {b && <span className="text-ink-2">· {b.clientName} ·</span>}
              <span className="font-semibold text-rose">
                не хватает {r.risk.shortfall} × {r.title}
              </span>
              <span className="text-ink-2">
                {late !== null && r.expectedReadyAt
                  ? `— чинят до ${formatDayMonth(r.expectedReadyAt)}, не успеваем`
                  : "— подмены в парке нет"}
              </span>
            </p>
          );
        })}
      </div>

      {/* На узком экране обе ссылки в одну строку не помещаются и обрезаются
          у правого края — переносим их, а `whitespace-nowrap` ниже не даёт
          рвать саму ссылку посередине. */}
      <div className="flex flex-row flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-rose-border bg-surface/45 px-4 py-2.5 md:col-span-2 lg:col-span-1 lg:flex-col lg:items-start lg:justify-center lg:gap-1.5 lg:border-l lg:border-t-0">
        {firstBookingId && (
          <Link
            href={`/bookings/${firstBookingId}`}
            className="whitespace-nowrap text-[11.5px] font-semibold text-rose underline"
          >
            Позвонить гафферам →
          </Link>
        )}
        <Link
          href="/equipment"
          className="whitespace-nowrap text-[11.5px] font-semibold text-rose underline"
        >
          Подобрать замену в каталоге →
        </Link>
      </div>
    </section>
  );
}

// ── 2 · Светофор + деньги ────────────────────────────────────────────────────

function Tile({
  label,
  mobileLabel,
  value,
  tone,
  sub,
}: {
  label: string;
  mobileLabel?: string;
  value: number;
  tone?: "rose" | "amber";
  sub: string;
}) {
  const toneClass = tone === "rose" ? "text-rose" : tone === "amber" ? "text-amber" : "text-ink";
  return (
    <div className="min-w-0 border-r border-border px-3 py-2.5 last:border-r-0 md:px-4">
      <p className="eyebrow">
        <span className="md:hidden">{mobileLabel ?? label}</span>
        <span className="hidden md:inline">{label}</span>
      </p>
      <p className={`mono-num mt-0.5 text-[17px] font-semibold leading-tight md:text-xl ${toneClass}`}>
        {value}
      </p>
      <p className="mt-px hidden text-[11.5px] leading-[1.45] text-ink-3 md:block">{sub}</p>
    </div>
  );
}

function moneyDelta(current: string | null, previous: string | null) {
  const now = Number(current ?? "0");
  const prev = Number(previous ?? "0");
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev <= 0) return null;
  const percent = Math.round(((now - prev) / prev) * 100);
  return {
    percent,
    label: `${percent > 0 ? "+" : ""}${percent} %`,
    className: percent > 0 ? "text-rose" : "text-emerald",
  };
}

export function RepairSummaryStrip({
  stats,
  blocking,
  quiet,
  noEtaCount,
  onApproveExpense,
}: {
  stats: RepairStats;
  /**
   * Светофор считается по той же очереди, которую человек видит ниже, а не по
   * KPI дашборда: числа плиток, счётчики фильтров и янтарные подписи в строках
   * обязаны сходиться на одном экране. Из `stats` берутся только деньги,
   * месячные итоги и «готово — забрать на полку».
   */
  blocking: RepairListItem[];
  /** Молчащие карточки, дольше молчащая — первой. */
  quiet: RepairListItem[];
  noEtaCount: number;
  onApproveExpense: (id: string) => Promise<void>;
}) {
  const [approving, setApproving] = useState<string | null>(null);

  const blockingSub =
    blocking.length > 0
      ? blocking
          .slice(0, 2)
          .map((r) =>
            r.risk.booking
              ? `${r.risk.booking.projectName} ${formatDayMonth(r.risk.booking.startDate)}`
              : r.title,
          )
          .join(" · ")
      : "ни одна бронь не под ударом";

  const quietTop = quiet[0] ?? null;
  const quietDays = quietTop ? daysAgo(lastActivityAt(quietTop)) : 0;
  const quietSub = quietTop
    ? `дольше всех — ${quietTop.title}, ${quietDays} ${pluralize(quietDays, "день", "дня", "дней")}`
    : "все карточки живые";

  const money = stats.pendingExpenses !== null || stats.spentThisMonth !== null;
  const pending = stats.pendingExpenses;
  const now = new Date();
  const thisMonth = MONTHS_LOCATIVE[now.getMonth()];
  const prevMonth = MONTHS_LOCATIVE[(now.getMonth() + 11) % 12];
  const delta = moneyDelta(stats.spentThisMonth, stats.spentPrevMonth);

  async function handleApprove(id: string) {
    setApproving(id);
    try {
      await onApproveExpense(id);
    } finally {
      setApproving(null);
    }
  }

  return (
    <section
      aria-label="Сводка мастерской"
      className="mt-3 overflow-hidden rounded-lg border border-border bg-surface shadow-xs"
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,auto)]">
        <div className="grid grid-cols-3">
          <Tile
            label="Срывают брони"
            mobileLabel="срывают брони"
            value={blocking.length}
            tone={blocking.length > 0 ? "rose" : undefined}
            sub={blockingSub}
          />
          <Tile
            label="Молчат 5 дней и дольше"
            mobileLabel="молчат 5+ дней"
            value={quiet.length}
            tone={quiet.length > 0 ? "amber" : undefined}
            sub={quietSub}
          />
          <Tile
            label="Без срока возврата"
            mobileLabel="без срока"
            value={noEtaCount}
            sub={noEtaCount > 0 ? "никто не сказал, когда вернутся" : "у всех назначен срок"}
          />
        </div>

        {money && (
          <div className="hidden min-w-[280px] flex-col gap-1.5 border-t border-border bg-surface-muted px-4 py-2.5 md:flex lg:border-l lg:border-t-0">
            <div className="flex items-center gap-2">
              <span className="eyebrow inline-flex items-center gap-1">
                <RepairIcon name="rub" />
                Деньги мастерской
              </span>
              <span className="rounded-[3px] border border-indigo-border bg-indigo-soft px-1 font-cond text-[9.5px] font-semibold uppercase leading-[1.6] tracking-[0.06em] text-indigo">
                только руководитель
              </span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-5">
              <div>
                <p className="eyebrow">Ждут подтверждения</p>
                <p className="mono-num mt-px whitespace-nowrap text-base font-semibold leading-[1.3] text-amber">
                  {formatRub(pending?.total ?? "0")}
                </p>
              </div>
              <div>
                <p className="eyebrow">Потрачено в {thisMonth}</p>
                <p className="mono-num mt-px whitespace-nowrap text-base font-semibold leading-[1.3] text-ink">
                  {formatRub(stats.spentThisMonth ?? "0")}
                </p>
                <p className="text-[11px] leading-[1.4] text-ink-3">
                  в {prevMonth}{" "}
                  <span className="mono-num">{formatRub(stats.spentPrevMonth ?? "0")}</span>
                  {delta && (
                    <>
                      {" · "}
                      <span className={`font-semibold ${delta.className}`}>{delta.label}</span>
                    </>
                  )}
                </p>
              </div>
              <div>
                <p className="eyebrow">Починено / списано</p>
                <p className="mono-num mt-px whitespace-nowrap text-base font-semibold leading-[1.3] text-ink">
                  {stats.closedThisMonth} <span className="text-ink-3">/</span>{" "}
                  {stats.writtenOffThisMonth}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {pending && pending.count > 0 && (
        <details className="border-t border-border bg-amber-soft">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-1.5 text-[12.5px] font-semibold text-amber [&::-webkit-details-marker]:hidden">
            <RepairIcon name="rub" />
            <span>
              {pending.count} {pluralize(pending.count, "расход", "расхода", "расходов")} на{" "}
              <span className="mono-num whitespace-nowrap">{formatRub(pending.total)}</span>{" "}
              {pluralize(pending.count, "ждёт", "ждут", "ждут")} подтверждения
            </span>
            <span className="ml-auto hidden text-[11.5px] underline md:inline">
              Раскрыть и утвердить
            </span>
          </summary>
          <div className="border-t border-amber-border bg-surface">
            {pending.items.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-1.5 text-[12.5px] last:border-b-0 md:grid-cols-[minmax(0,1fr)_92px_150px_auto]"
              >
                <div className="min-w-0 font-semibold">
                  {e.repairId ? (
                    <Link href={`/repair/${e.repairId}`} className="hover:underline">
                      {e.title}
                    </Link>
                  ) : (
                    e.title
                  )}
                </div>
                <div className="mono-num whitespace-nowrap text-right font-semibold">
                  {formatRub(e.amount)}
                </div>
                <div className="col-span-2 min-w-0 text-[11.5px] text-ink-2 md:col-span-1">
                  {e.createdByName ?? "—"} · {formatDayMonth(e.createdAt)}
                </div>
                <button
                  type="button"
                  onClick={() => void handleApprove(e.id)}
                  disabled={approving === e.id}
                  className="col-span-2 inline-flex items-center justify-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold leading-[1.55] text-ink-2 transition-colors hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright disabled:opacity-50 md:col-span-1"
                >
                  {approving === e.id ? "…" : "Утвердить"}
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2.5 px-4 py-1.5 text-[11.5px] text-ink-3">
              <span>
                Техник отмечает, что нужна запчасть; сумму ставит руководитель здесь.
                Утверждённое уходит в расходы месяца и в стоимость ремонта.
              </span>
              <span className="ml-auto font-semibold text-ink">
                Итого <span className="mono-num">{formatRub(pending.total)}</span>
              </span>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

// ── 3 · Точка входа техника ──────────────────────────────────────────────────

export function RepairNextUp({
  repair,
  unassignedCount,
  onTake,
  onShowUnassigned,
}: {
  repair: RepairListItem;
  unassignedCount: number;
  onTake: (id: string) => Promise<void>;
  onShowUnassigned: () => void;
}) {
  const [taking, setTaking] = useState(false);
  const booking = repair.risk.booking;

  async function handleTake() {
    setTaking(true);
    try {
      await onTake(repair.id);
    } finally {
      setTaking(false);
    }
  }

  return (
    <section
      aria-label="Что взять следующим"
      className="mt-3.5 rounded-lg border border-l-[3px] border-accent-border border-l-accent-bright bg-accent-soft px-3.5 py-2.5 lg:grid lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-3.5"
    >
      <div className="inline-flex items-center gap-1.5 font-cond text-[10px] font-bold uppercase tracking-[0.1em] text-accent-bright">
        <RepairIcon name="arrow" />
        Взять следующее
      </div>
      <div className="mt-1 min-w-0 lg:mt-0">
        <p className="flex flex-wrap items-center gap-2 font-cond text-base font-bold leading-tight">
          {repair.title}
          <QuantityTag quantity={repair.quantity} />
        </p>
        <p className="mt-px text-xs text-ink-2">
          {booking ? (
            <>
              срывает ближайшую бронь{" "}
              <b className="font-semibold text-rose">{formatDayMonth(booking.startDate)}</b> и
              никем не занято
            </>
          ) : (
            "самое давнее из ничейного — никем не занято"
          )}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-3 lg:mt-0">
        <button
          type="button"
          onClick={() => void handleTake()}
          disabled={taking}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-accent-bright bg-accent-bright px-3 py-1.5 text-xs font-semibold text-surface transition-colors hover:border-accent hover:bg-accent disabled:opacity-60 lg:w-auto"
        >
          {taking ? "…" : "Взять в работу"}
        </button>
        {unassignedCount > 1 && (
          <button
            type="button"
            onClick={onShowUnassigned}
            className="whitespace-nowrap text-[11.5px] font-semibold text-accent-bright hover:text-accent hover:underline"
          >
            Показать всю ничейную работу — {unassignedCount} →
          </button>
        )}
      </div>
    </section>
  );
}

// ── 4 · Готово — забрать на полку ────────────────────────────────────────────

export function RepairPickupLine({ items }: { items: RepairStats["readyForPickup"] }) {
  // Поле молодое: старый сервер его не отдаёт, и строка не должна ронять экран.
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-border bg-emerald-soft px-3.5 py-1.5 text-[12.5px] text-emerald">
      <RepairIcon name="check" />
      <span className="font-bold">Готово — забрать на полку: {items.length}</span>
      <span className="min-w-0 text-ink-2">
        {items.slice(0, 3).map((i) => i.title).join(" · ")} — починены, физически лежат в
        мастерской
      </span>
      <Link
        href="/warehouse/scan?tab=shift"
        className="ml-auto whitespace-nowrap text-[11.5px] font-semibold text-emerald hover:underline"
      >
        Открыть на «Смене» →
      </Link>
    </div>
  );
}
