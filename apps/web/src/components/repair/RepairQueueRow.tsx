"use client";

/**
 * Строка очереди ремонтов и её мобильная карточка.
 *
 * Строка отвечает на четыре вопроса сразу: что сломано, сорвёт ли это бронь,
 * не забыли ли про карточку (возраст + дата последней записи) и когда прибор
 * вернётся. Пятый вопрос — «что я могу сделать прямо отсюда» — решают две
 * кнопки, набор которых зависит от роли и статуса.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { pluralize } from "../../lib/format";
import { toMoscowDateString } from "../../lib/moscowDate";
import { BTN_MINI, BTN_PRIMARY, CHIP, CHIP_OFF, CHIP_ON, META_ITEM } from "./cardChrome";
import {
  RepairIcon,
  RepairRiskBadge,
  RepairStatusPill,
  QuantityTag,
  TitleSourceTag,
  UrgencyPill,
} from "./RepairRiskBadge";
import {
  QUIET_DAYS,
  daysAgo,
  daysUntil,
  formatDayMonth,
  isEtaOverdue,
  lastActivityAt,
  type RepairGroup,
  type RepairListItem,
} from "./types";

const BTN_BASE =
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded border px-2 py-2 text-xs font-semibold leading-[1.55] transition-colors disabled:opacity-50 xl:px-1.5 xl:py-0.5 xl:text-[11px]";
const BTN_QUIET =
  "border-border bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright";
const BTN_QUIET_ROSE =
  "border-border bg-surface text-ink-2 hover:border-rose-border hover:bg-rose-soft hover:text-rose";
/** Первое действие строки на телефоне — заливкой: кнопки там во всю ширину, целиться некогда. */
const BTN_PRIMARY_MOBILE =
  "border-accent-bright bg-accent-bright text-surface hover:border-accent hover:bg-accent xl:border-border xl:bg-surface xl:text-ink-2 xl:hover:border-accent-border xl:hover:bg-accent-soft xl:hover:text-accent-bright";

/** Цветная полоса слева. Hover перекрашивает рамку целиком — левый край держим явно. */
const TONE_BORDER: Record<RepairGroup, string> = {
  hot: "border-l-rose hover:border-l-rose",
  warm: "border-l-amber hover:border-l-amber",
  calm: "border-l-border-strong hover:border-l-border-strong",
};

// ── Подписи возраста и молчания ──────────────────────────────────────────────

function ageText(repair: RepairListItem): string {
  const d = daysAgo(repair.createdAt);
  if (d <= 0) return "взят сегодня";
  if (d === 1) return "взят вчера";
  return `взят ${d} ${pluralize(d, "день", "дня", "дней")} назад`;
}

/** `short` — для узкой колонки хвоста очереди, где «последняя» не помещается. */
function activityText(repair: RepairListItem): { text: string; short: string; quiet: boolean } {
  if (repair.workLogCount === 0) {
    // Молчание с самого начала — такое же молчание, поэтому всегда янтарное.
    return { text: "записей ещё нет", short: "записей ещё нет", quiet: true };
  }
  const d = daysAgo(lastActivityAt(repair));
  const quiet = d >= QUIET_DAYS;
  const when =
    d <= 0 ? "сегодня" : d === 1 ? "вчера" : `${d} ${pluralize(d, "день", "дня", "дней")} назад`;
  return { text: `последняя запись ${when}`, short: `запись ${when}`, quiet };
}

/** Колонка срока: три состояния — ждём запчасть, вернётся, срока нет. */
function etaParts(repair: RepairListItem): {
  tone: "late" | "ok" | "none";
  icon: "clock" | "pause";
  lead: string;
  date: string | null;
  sub: string;
} {
  if (!repair.expectedReadyAt) {
    const booking = repair.risk.booking;
    const untilBooking = booking ? daysUntil(booking.startDate) : null;
    return {
      tone: "none",
      icon: "clock",
      lead: "Срок не назначен",
      date: null,
      sub:
        untilBooking !== null && untilBooking >= 0
          ? `никто не сказал, когда вернётся — до брони ${untilBooking} ${pluralize(untilBooking, "день", "дня", "дней")}`
          : "не выдумываем дату — техник её не ставил",
    };
  }

  const overdue = isEtaOverdue(repair);
  // «Позже брони» имеет смысл только там, где подмены не хватает: если бронь
  // закрывается другими единицами, опоздание этого ремонта её не трогает —
  // красная подпись под зелёной плашкой противоречила бы сама себе.
  const blocksBooking = repair.risk.level === "BLOCKS" || repair.risk.level === "TIGHT";
  const late = blocksBooking && repair.risk.slackDays !== null && repair.risk.slackDays < 0;
  const passed = Math.abs(daysUntil(repair.expectedReadyAt));

  let sub: string;
  if (overdue) {
    sub = `срок прошёл ${passed} ${pluralize(passed, "день", "дня", "дней")} назад`;
  } else if (late && repair.risk.slackDays !== null) {
    const gap = Math.abs(repair.risk.slackDays);
    sub = `позже брони на ${gap} ${pluralize(gap, "день", "дня", "дней")}`;
  } else if (blocksBooking && repair.risk.slackDays !== null) {
    sub = `до брони остаётся ${repair.risk.slackDays} ${pluralize(repair.risk.slackDays, "день", "дня", "дней")} запаса`;
  } else {
    sub = "срок назначен техником";
  }

  return {
    tone: overdue || late ? "late" : "ok",
    icon: repair.partsNote ? "pause" : "clock",
    lead: repair.partsNote ? `Ждём ${repair.partsNote}` : "Вернётся",
    date: formatDayMonth(repair.expectedReadyAt),
    sub,
  };
}

// ── Диалог срока ─────────────────────────────────────────────────────────────

/**
 * Назначить или сдвинуть срок возврата.
 *
 * «Не знаю» — полноценный ответ, а не пустая форма: выдуманная дата хуже
 * честного пробела, по ней начнут планировать съёмку.
 */
function SetEtaDialog({
  repair,
  onClose,
  onSubmit,
}: {
  repair: RepairListItem;
  onClose: () => void;
  onSubmit: (patch: { expectedReadyAt?: string | null; partsNote?: string | null }) => Promise<void>;
}) {
  const [date, setDate] = useState(
    repair.expectedReadyAt ? toMoscowDateString(new Date(repair.expectedReadyAt)) : "",
  );
  const [partsNote, setPartsNote] = useState(repair.partsNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  function shiftDays(n: number) {
    const base = new Date();
    base.setDate(base.getDate() + n);
    setDate(toMoscowDateString(base));
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        expectedReadyAt: date === "" ? null : date,
        partsNote: partsNote.trim() === "" ? null : partsNote.trim(),
      });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить срок");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={() => !saving && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Срок возврата"
        className="w-full max-w-sm rounded-lg border border-border-strong bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <RepairIcon name="clock" large className="text-accent-bright" />
          <h3 className="font-cond text-[15px] font-bold">Когда вернётся</h3>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="ml-auto text-ink-3 hover:text-ink"
          >
            <RepairIcon name="x" large />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-[12.5px] font-semibold text-ink">{repair.title}</p>

          <div>
            <label htmlFor="eta-date" className="mb-1 block text-[11.5px] font-semibold text-ink-2">
              Срок возврата
            </label>
            <input
              id="eta-date"
              ref={inputRef}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                { label: "завтра", days: 1 },
                { label: "3 дня", days: 3 },
                { label: "неделя", days: 7 },
              ].map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => shiftDays(c.days)}
                  className={`${CHIP} ${CHIP_OFF}`}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setDate("")}
                className={`${CHIP} ${date === "" ? CHIP_ON : CHIP_OFF}`}
              >
                не знаю
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="eta-note" className="mb-1 block text-[11.5px] font-semibold text-ink-2">
              Чего ждём <span className="font-normal text-ink-3">· если ждём запчасть</span>
            </label>
            <input
              id="eta-note"
              type="text"
              value={partsNote}
              maxLength={500}
              placeholder="разъём Neutrik NL4"
              onChange={(e) => setPartsNote(e.target.value)}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink"
            />
          </div>

          {date === "" && (
            <p className="rounded border border-dashed border-border-strong bg-surface-muted px-2.5 py-1.5 text-[11.5px] leading-[1.45] text-ink-2">
              В очереди так и напишем: <b className="font-semibold text-ink">срок не назначен</b>.
              Выдуманный прогноз хуже честного пробела.
            </p>
          )}

          {error && (
            <p className="rounded border border-rose-border bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-surface-muted px-4 py-2.5">
          <span className="ml-auto" />
          <button type="button" onClick={onClose} disabled={saving} className={BTN_MINI}>
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            className={BTN_PRIMARY}
          >
            {saving ? "Сохраняем…" : "Сохранить срок"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Строка очереди ───────────────────────────────────────────────────────────

export interface RepairRowActions {
  canTake: boolean;
  canSetEta: boolean;
  canWriteOff: boolean;
  onTake: (id: string) => Promise<void>;
  onSetEta: (
    id: string,
    patch: { expectedReadyAt?: string | null; partsNote?: string | null },
  ) => Promise<void>;
  onWriteOff: (id: string) => Promise<void>;
}

export function RepairQueueRow({
  repair,
  tone,
  actions,
}: {
  repair: RepairListItem;
  tone: RepairGroup;
  actions: RepairRowActions;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [etaOpen, setEtaOpen] = useState(false);

  const activity = activityText(repair);
  const eta = etaParts(repair);
  const isWaiting = repair.status === "WAITING_REPAIR";

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const etaLabel = repair.expectedReadyAt ? "Сдвинуть срок" : "Назначить срок";

  type RowAction =
    | { key: string; label: string; rose?: boolean; onClick: () => void }
    | { key: string; label: string; rose?: boolean; href: string };

  const rowActions: RowAction[] = [];

  if (actions.canTake && isWaiting) {
    rowActions.push({
      key: "take",
      label: busy ? "…" : "Взять в работу",
      onClick: () => void run(() => actions.onTake(repair.id)),
    });
  }
  if (actions.canTake && !isWaiting) {
    rowActions.push({
      key: "worklog",
      label: "Записать работы",
      onClick: () => router.push(`/repair/${repair.id}`),
    });
  }
  if (actions.canSetEta) {
    rowActions.push({ key: "eta", label: etaLabel, onClick: () => setEtaOpen(true) });
  }
  if (!actions.canTake && repair.risk.booking) {
    // Кладовщик не берёт ремонты в работу, но именно он ищет подмену —
    // уводим в календарь на даты конфликтующей брони, а не в тупик.
    rowActions.push({
      key: "swap",
      label: "Подобрать подмену",
      href: `/calendar?date=${toMoscowDateString(new Date(repair.risk.booking.startDate))}`,
    });
  }
  if (actions.canWriteOff && isWaiting && repair.assignedTo === null) {
    rowActions.push({
      key: "write-off",
      label: "Списать",
      rose: true,
      onClick: () => void run(() => actions.onWriteOff(repair.id)),
    });
  }

  const buttons = rowActions.map((a, i) => {
    const tint = a.rose ? BTN_QUIET_ROSE : i === 0 ? BTN_PRIMARY_MOBILE : BTN_QUIET;
    const cls = `${BTN_BASE} ${tint}`;
    return "href" in a ? (
      <Link key={a.key} href={a.href} className={cls}>
        {a.label}
      </Link>
    ) : (
      <button key={a.key} type="button" disabled={busy} className={cls} onClick={a.onClick}>
        {a.label}
      </button>
    );
  });

  const meta = (
    <>
      <span className={META_ITEM}>{ageText(repair)}</span>
      <span className={META_ITEM}>
        <span className={activity.quiet ? "font-semibold text-amber" : ""}>{activity.text}</span>
      </span>
      {repair.workLogCount > 0 && (
        <span className={META_ITEM}>
          {repair.workLogCount} {pluralize(repair.workLogCount, "запись", "записи", "записей")}
        </span>
      )}
      <span className={META_ITEM}>
        {repair.assignedToName ? (
          <span className="inline-flex items-center gap-1 font-semibold text-ink">
            <RepairIcon name="user" />
            {repair.assignedToName}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-ink-3">
            <RepairIcon name="user" />
            исполнитель не назначен
          </span>
        )}
      </span>
      {repair.photoCount > 0 && (
        <span className={META_ITEM}>
          <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 font-semibold leading-[1.6] text-ink-2">
            <RepairIcon name="cam" />
            {repair.photoCount}
          </span>
        </span>
      )}
    </>
  );

  const titleRow = (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-cond text-base font-bold leading-tight tracking-[-0.005em]">
        {repair.title}
      </h3>
      <QuantityTag quantity={repair.quantity} />
      <TitleSourceTag source={repair.titleSource} />
      <UrgencyPill urgency={repair.urgency} />
      <RepairStatusPill status={repair.status} />
    </div>
  );

  return (
    <>
      <article
        className={`grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg border border-l-[3px] border-border bg-surface shadow-xs transition-colors hover:border-border-strong xl:grid-cols-[minmax(0,1fr)_214px_128px] ${TONE_BORDER[tone]}`}
      >
        <div className="min-w-0 px-3.5 py-2.5">
          {titleRow}
          <p className="mt-0.5 text-[12.5px] leading-[1.45] text-ink-2">{repair.reason}</p>
          <div className="mt-1.5">
            <RepairRiskBadge repair={repair} />
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-0.5 overflow-hidden text-[11.5px] text-ink-2">
            {meta}
          </p>
        </div>

        <div
          className={`flex min-w-0 flex-col justify-center gap-0.5 border-t border-dashed border-border px-3.5 py-2.5 xl:border-l xl:border-solid xl:border-t-0 ${
            eta.tone === "late" ? "text-rose" : eta.tone === "none" ? "text-ink-3" : "text-ink"
          }`}
        >
          <p className="flex items-start gap-1.5 text-[12.5px] leading-[1.4]">
            <RepairIcon name={eta.icon} className="mt-0.5" />
            <span>
              {eta.lead}
              {eta.date && (
                <>
                  {" "}
                  <span className="mono-num whitespace-nowrap font-semibold">до {eta.date}</span>
                </>
              )}
            </span>
          </p>
          <p className={`text-[11px] leading-[1.4] ${eta.tone === "late" ? "text-rose" : "text-ink-3"}`}>
            {eta.sub}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-border px-3 py-2.5 xl:flex-col xl:items-stretch xl:justify-center xl:gap-1.5 xl:border-l xl:border-solid xl:border-t-0">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5 [&>*]:flex-1 xl:w-full xl:flex-none xl:flex-col xl:[&>*]:flex-none">
            {buttons}
          </div>
          <Link
            href={`/repair/${repair.id}`}
            className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-accent-bright hover:text-accent hover:underline xl:text-right"
          >
            Открыть →
          </Link>
        </div>
      </article>

      {etaOpen && (
        <SetEtaDialog
          repair={repair}
          onClose={() => setEtaOpen(false)}
          onSubmit={(patch) => actions.onSetEta(repair.id, patch)}
        />
      )}
    </>
  );
}

// ── Строка спокойного хвоста ─────────────────────────────────────────────────

export function RepairTailRow({ repair }: { repair: RepairListItem }) {
  const activity = activityText(repair);
  return (
    <Link
      href={`/repair/${repair.id}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 border-b border-border px-3.5 py-1.5 text-[12.5px] last:border-b-0 hover:bg-surface-muted md:grid-cols-[minmax(0,1fr)_128px_168px_118px_74px] xl:grid-cols-[minmax(0,1fr)_128px_220px_118px_74px]"
    >
      <span className="min-w-0 truncate font-semibold">
        {repair.title}
        {repair.quantity > 1 && <small className="font-normal text-ink-3"> · {repair.quantity} шт</small>}
        {repair.titleSource === "estimate" && (
          <small className="font-normal text-ink-3"> · название из сметы</small>
        )}
        {repair.titleSource === "catalog" && (
          <small className="font-normal text-ink-3"> · название из каталога</small>
        )}
      </span>
      <span className="hidden md:inline">
        <RepairStatusPill status={repair.status} />
      </span>
      {/* Многоточие съедает имя, а не срок: «когда писали» и есть смысл колонки. */}
      <span
        className="hidden min-w-0 items-baseline gap-1 text-[11.5px] text-ink-2 md:flex"
        title={`${repair.assignedToName ?? "исполнитель не назначен"} · ${activity.text}`}
      >
        <span className="min-w-0 truncate">{repair.assignedToName ?? "исполнитель не назначен"}</span>
        <span className="shrink-0 whitespace-nowrap">· {activity.short}</span>
      </span>
      <span
        className={`mono-num whitespace-nowrap text-[11.5px] ${
          repair.expectedReadyAt ? "text-ink-2" : "text-ink-3"
        }`}
      >
        {repair.expectedReadyAt ? `до ${formatDayMonth(repair.expectedReadyAt)}` : "срок не назначен"}
      </span>
      <span className="hidden whitespace-nowrap text-[11.5px] text-emerald md:inline">
        ещё {repair.risk.sparesLeft}
      </span>
    </Link>
  );
}
