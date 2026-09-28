"use client";

/**
 * Составные части чек-листа выдачи: строка со степпером, живой блок финансов
 * и модальные окна. Состояние держит `IssueChecklist`, здесь только отрисовка.
 */

import { useEffect, useRef } from "react";
import type { AddonConflict, ChecklistItem } from "./types";
import type { IssueRowState } from "./issueChecklistDraft";
import { ackAddCap, freeAddCap, hasAckPath, rowMax } from "./issueChecklistDraft";
import type { LiveFinance } from "./issueLiveFinance";
import {
  NEGOTIATED_TOTAL_ADDON_NOTE,
  holderStateText,
  quoted,
  shortDate,
} from "./addonConflictText";
import { formatRub } from "../../lib/format";

// ── Загрузка, ошибка, пусто ─────────────────────────────────────────────────

export function ChecklistSkeleton() {
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="h-[46px] animate-pulse rounded-lg bg-surface-subtle" />
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-[52px] animate-pulse rounded-lg border border-border bg-surface"
        />
      ))}
    </div>
  );
}

/** Сообщение вместо чек-листа и «← К списку броней». */
export function ChecklistMessage({
  text,
  tone = "muted",
  onBack,
}: {
  text: string;
  tone?: "muted" | "error";
  onBack: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
      {tone === "error" ? (
        <div className="w-full max-w-[420px] rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-sm text-rose">
          {text}
        </div>
      ) : (
        <p className="text-sm text-ink-3">{text}</p>
      )}
      <button
        type="button"
        onClick={onBack}
        className="mt-4 rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
      >
        ← К списку броней
      </button>
    </div>
  );
}

// ── Строка со степпером ──────────────────────────────────────────────────────

/** Сервер отверг строку при «Готово»: подсветить её и объяснить. */
export interface IssueRowProblem {
  kind: "over-stock" | "conflict";
  /** Короткое объяснение под строкой. */
  text: string;
  /** Держатель из 409 ADDON_CONFLICT (если был). */
  conflict?: AddonConflict | null;
}

function holderOfferText(item: ChecklistItem, holder: AddonConflict | null | undefined): string {
  // Сколько сверх свободного: из строки чек-листа, а если она устарела (строку
  // отверг сервер при «Готово») — из держателя в ответе.
  const fromRow = ackAddCap(item) - freeAddCap(item);
  const fromHolder =
    typeof holder?.ackCap === "number" ? Math.floor(holder.ackCap) - freeAddCap(item) : 0;
  const more = Math.max(fromRow, fromHolder);
  if (!holder) {
    return more > 0
      ? `Свободных больше нет — ещё ${more} можно добрать под ответственность`
      : "Свободных больше нет — добрать можно только под ответственность";
  }
  const tail = more > 0 ? `ещё ${more} под ответственность` : "можно добрать под ответственность";
  return `Занято: ${holder.bookingNo} ${quoted(holder.projectName)} до ${shortDate(holder.to)} — ${tail}`;
}

/**
 * Одна позиция брони: степпер `[−] N [+]` и отметка «Выдано».
 *
 * Разница с исходным количеством — пилюлей у названия («+X» / «−X»), N = 0 —
 * строка приглушена. Упёрся в свободное, а вещь держит чужая бронь — под
 * серым «+» подсказка, у кого занято, и кнопка «Добрать под ответственность»:
 * потолок поднимается до `quantity + ackCap` (P4).
 */
export function IssueRow({
  item,
  row,
  problem,
  onBump,
  onSet,
  onToggleCheck,
  onAck,
}: {
  item: ChecklistItem;
  row: IssueRowState;
  problem?: IssueRowProblem | null;
  onBump: (delta: number) => void;
  onSet: (value: number) => void;
  onToggleCheck: () => void;
  onAck: (on: boolean) => void;
}) {
  // origQty=0 ⇒ строка сама — добор прошлой сессии: сравниваем с текущим
  // количеством, чтобы не пугать «+10» на каждой свежей строке.
  const refQty = item.originalQuantity > 0 ? item.originalQuantity : item.quantity;
  const N = row.qty;
  const checked = row.checked;
  const maxN = rowMax(item, row.ack);
  const freeMax = item.quantity + freeAddCap(item);
  const delta = N - refQty;
  const dimmed = N === 0;
  const holder = problem?.conflict ?? item.capHolder ?? null;
  const offerAck =
    !row.ack && N >= freeMax && (hasAckPath(item) || problem?.kind === "conflict");
  const overFree = row.ack && N > freeMax;

  let diffPill: React.ReactNode = null;
  if (delta > 0) {
    diffPill = (
      <span
        aria-label={`Добавлено сверх ${refQty}: ${delta}`}
        className="ml-1 inline-flex items-center rounded-full border border-emerald-border bg-emerald-soft px-1.5 py-0.5 text-[10px] font-semibold text-emerald"
      >
        +{delta}
      </span>
    );
  } else if (delta < 0) {
    diffPill = (
      <span
        aria-label={`Снято от ${refQty}: ${Math.abs(delta)}`}
        className="ml-1 inline-flex items-center rounded-full border border-amber-border bg-amber-soft px-1.5 py-0.5 text-[10px] font-semibold text-amber"
      >
        −{Math.abs(delta)}
      </span>
    );
  }

  // Отмечено «Выдано» — зелёная кромка; сервер отверг строку — розовая.
  const rowClass = problem
    ? "border-rose-border bg-rose-soft/40 shadow-[inset_3px_0_0_rgb(var(--c-rose))]"
    : checked
      ? "border-emerald-border bg-emerald-soft/30 shadow-[inset_3px_0_0_rgb(var(--c-emerald))]"
      : "border-border bg-surface";

  const holderState = holder ? holderStateText(holder) : "";

  return (
    <div
      data-issue-row={item.bookingItemId}
      data-problem={problem ? problem.kind : undefined}
      className={`space-y-1.5 rounded-lg border px-2.5 py-2 lg:px-3 lg:py-2.5 ${rowClass}`}
    >
      <div
        // В одну строку — только с 1280: на 1024 правая панель ~460 px, и
        // название рядом со степпером и кнопкой обрезалось до 15 символов.
        className={`flex flex-wrap items-center gap-2 xl:flex-nowrap ${dimmed ? "opacity-60" : ""}`}
      >
        <div className="min-w-0 flex-1 basis-full xl:basis-auto">
          <div
            className={`flex flex-wrap items-center gap-x-1 text-[13px] leading-tight ${
              dimmed ? "line-through text-ink-3" : "text-ink"
            }`}
          >
            <span className="truncate">{item.equipmentName}</span>
            {diffPill}
            {row.ack && (
              <span className="ml-1 inline-flex items-center rounded-full border border-rose-border bg-rose-soft px-1.5 py-0.5 text-[10px] font-semibold text-rose no-underline">
                под ответственность
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-3">было ×{refQty}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onBump(-1)}
            disabled={N <= 0}
            aria-label={`Уменьшить количество — ${item.equipmentName}`}
            className="flex h-10 w-10 items-center justify-center rounded border border-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            −
          </button>
          <input
            type="number"
            inputMode="numeric"
            value={N}
            onChange={(e) => {
              const raw = e.target.value;
              onSet(raw === "" ? 0 : Number(raw));
            }}
            min={0}
            max={maxN}
            aria-label={`Количество к выдаче — ${item.equipmentName}`}
            aria-invalid={problem ? true : undefined}
            className="mono-num h-10 w-12 rounded border border-border bg-surface text-center text-[13px] font-semibold text-ink outline-none [appearance:textfield] focus:border-accent-bright [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={() => onBump(+1)}
            disabled={N >= maxN}
            aria-label={`Увеличить количество — ${item.equipmentName}`}
            className="flex h-10 w-10 items-center justify-center rounded border border-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            +
          </button>
        </div>

        {/*
          «Выдать» / «✓ Выдано» — маркер сборки: грузчик унёс прибор со
          стеллажа. На количество не влияет — выдаётся значение степпера.
        */}
        <button
          type="button"
          onClick={onToggleCheck}
          aria-pressed={checked}
          disabled={N === 0}
          aria-label={
            N === 0
              ? `Позиция снята с выдачи — ${item.equipmentName}`
              : checked
                ? `Снять отметку «Выдано» — ${item.equipmentName}`
                : `Отметить «Выдано» — ${item.equipmentName}`
          }
          className={`flex h-10 min-w-[96px] shrink-0 items-center justify-center gap-1 rounded border px-3 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            checked
              ? "border-emerald-border bg-emerald text-surface hover:opacity-90"
              : "border-border bg-surface text-ink-2 hover:bg-surface-muted"
          }`}
        >
          {checked ? (
            <>
              <span aria-hidden="true">✓</span>
              Выдано
            </>
          ) : (
            "Выдать"
          )}
        </button>
      </div>

      {problem && (
        <p className="text-[11px] font-medium leading-snug text-rose">
          {problem.text}
        </p>
      )}

      {offerAck && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-rose-border bg-rose-soft/60 px-2 py-1.5">
          <p className="min-w-[200px] flex-1 text-[11px] leading-snug text-rose">
            {holderOfferText(item, holder)}
            {holderState ? <span className="block text-rose/80">{holderState}.</span> : null}
          </p>
          <button
            type="button"
            onClick={() => onAck(true)}
            aria-label={`Добрать под ответственность — ${item.equipmentName}`}
            className="h-9 shrink-0 rounded border border-rose-border bg-surface px-2.5 text-[11px] font-semibold text-rose transition-colors hover:bg-rose-soft"
          >
            Добрать под ответственность
          </button>
        </div>
      )}

      {row.ack && (
        <div className="flex flex-wrap items-center gap-x-2 text-[11px] leading-snug text-rose">
          <span className="min-w-0 flex-1">
            {overFree
              ? `Сверх свободного (${freeMax}) — под ответственность, зафиксируется в аудите`
              : `Можно добрать до ${maxN} — сверх ${freeMax} под ответственность`}
          </span>
          <button
            type="button"
            onClick={() => onAck(false)}
            aria-label={`Отменить «под ответственность» — ${item.equipmentName}`}
            className="h-8 shrink-0 rounded px-2 text-[11px] font-semibold text-ink-2 underline transition-colors hover:bg-surface-muted"
          >
            Отменить
          </button>
        </div>
      )}
    </div>
  );
}

// ── Шапка списка ─────────────────────────────────────────────────────────────

/**
 * Прогресс сборки, массовые отметки, статус черновика («Сохранено 14:05» /
 * «Нет связи — не сохранено»), «＋ Добор» и «Прервать выдачу». На десктопе —
 * одна строка над списком, на мобильном — строка прогресса и широкая кнопка
 * добора (кнопка «Прервать» на мобильном — внизу списка).
 */
export function IssueChecklistHeading({
  checked,
  total,
  statusLabel,
  statusWarn,
  onCheckAll,
  onUncheckAll,
  onAddon,
  abortSlot,
}: {
  checked: number;
  total: number;
  statusLabel: string | null;
  /** Черновик не сохранился (нет связи или отказ) — подпись розовым. */
  statusWarn: boolean;
  onCheckAll: () => void;
  onUncheckAll: () => void;
  onAddon: () => void;
  abortSlot: React.ReactNode;
}) {
  const tone = statusWarn ? "text-rose" : "text-ink-3";
  return (
    <>
      {/* Шапка списка (десктоп): прогресс, массовые отметки, добор, прервать. */}
      <div className="mb-2 hidden flex-wrap items-center gap-x-3 gap-y-1.5 px-1 lg:flex">
        <h2 className="whitespace-nowrap text-[15px] font-semibold text-ink">
          Чек-лист выдачи
        </h2>
        <span
          aria-label={`Выдано ${checked} из ${total} позиций`}
          className="whitespace-nowrap rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-2"
        >
          <span className={checked === total && total > 0 ? "text-emerald" : ""}>
            {checked}
          </span>
          <span className="text-ink-3"> / {total}</span>
          <span className="ml-1 text-ink-3">выдано</span>
        </span>
        {checked < total ? (
          <button
            type="button"
            onClick={onCheckAll}
            aria-label="Отметить все позиции как «Выдано»"
            className="whitespace-nowrap rounded border border-emerald-border px-2.5 py-1 text-xs font-semibold text-emerald transition-colors hover:bg-emerald-soft"
          >
            ✓ Все выдано
          </button>
        ) : total > 0 ? (
          <button
            type="button"
            onClick={onUncheckAll}
            aria-label="Снять все отметки «Выдано»"
            className="whitespace-nowrap rounded border border-border px-2.5 py-1 text-xs font-semibold text-ink-2 transition-colors hover:bg-surface-muted"
          >
            Снять все отметки
          </button>
        ) : null}
        {statusLabel && (
          <span role="status" className={`whitespace-nowrap text-[11px] ${tone}`}>
            {statusLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {abortSlot}
          <button
            type="button"
            onClick={onAddon}
            aria-label="Добор — добавить артикул не из заявки"
            className="whitespace-nowrap rounded border border-dashed border-accent-bright px-2.5 py-1 text-xs font-semibold text-accent-bright transition-colors hover:bg-accent-soft"
          >
            ＋ Добор
          </button>
        </div>
      </div>

      {/* Шапка списка (мобильный). */}
      <div className="mb-2 flex flex-wrap items-center gap-2 px-0.5 lg:hidden">
        <span
          aria-label={`Выдано ${checked} из ${total} позиций`}
          className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold"
        >
          <span className={checked === total && total > 0 ? "text-emerald" : "text-ink-2"}>
            {checked}
          </span>
          <span className="text-ink-3"> / {total} выдано</span>
        </span>
        {statusLabel && (
          <span className={`text-[11px] ${tone}`}>{statusLabel}</span>
        )}
        {checked < total ? (
          <button
            type="button"
            onClick={onCheckAll}
            aria-label="Отметить все позиции как «Выдано»"
            className="ml-auto rounded border border-emerald-border px-2 py-1 text-[11px] font-semibold text-emerald transition-colors hover:bg-emerald-soft"
          >
            ✓ Все выдано
          </button>
        ) : total > 0 ? (
          <button
            type="button"
            onClick={onUncheckAll}
            aria-label="Снять все отметки «Выдано»"
            className="ml-auto rounded border border-border px-2 py-1 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-surface-muted"
          >
            Снять все отметки
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onAddon}
        aria-label="Добор — добавить артикул не из заявки"
        className="mb-3 block w-full rounded-lg border-[1.5px] border-dashed border-accent-bright bg-surface px-4 py-2.5 text-center text-sm font-semibold text-accent-bright transition-colors hover:bg-accent-soft lg:hidden"
      >
        ＋ Добор (артикул не из заявки)
      </button>
    </>
  );
}

// ── Живой блок финансов ──────────────────────────────────────────────────────

export function LiveFinanceBlock({
  finance,
  onSubmit,
  submitting,
  checkedCount,
  totalCount,
}: {
  finance: LiveFinance;
  onSubmit: () => void;
  submitting: boolean;
  /** Сколько строк отмечено «Выдано». */
  checkedCount: number;
  /** Строк с количеством больше нуля. */
  totalCount: number;
}) {
  const nothingToIssue = totalCount === 0;
  const allChecked = totalCount > 0 && checkedCount >= totalCount;
  const unmarked = Math.max(0, totalCount - checkedCount);
  const manual = finance.manualTotal;
  const changed = finance.hasAddons || finance.hasRemovals;

  return (
    <div className="space-y-1 text-[13px] text-ink">
      <div className="flex items-baseline justify-between">
        <span className="text-ink-2">Согласовано</span>
        <span className="mono-num">{formatRub(finance.mainOriginal)}</span>
      </div>
      {finance.hasRemovals && finance.removalAmount > 0 && (
        <div className="flex items-baseline justify-between">
          <span className="text-amber">Снято на выдаче</span>
          <span className="mono-num text-amber">−{formatRub(finance.removalAmount)}</span>
        </div>
      )}
      {finance.hasAddons && finance.addonActual > 0 && (
        <div className="flex items-baseline justify-between">
          <span className="text-emerald">Дополнительно</span>
          <span className="mono-num text-emerald">+{formatRub(finance.addonActual)}</span>
        </div>
      )}
      <div className="!mt-2 border-t border-border pt-2" />
      {manual === null ? (
        <div className="flex items-baseline justify-between">
          <span className="font-semibold">Итого</span>
          <span className="mono-num text-[18px] font-semibold">
            {formatRub(finance.finalAmount)}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between text-ink-2">
            <span>Итого по смете</span>
            <span className="mono-num">{formatRub(finance.finalAmount)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">К оплате — договорная сумма</span>
            <span className="mono-num text-[18px] font-semibold">{formatRub(manual)}</span>
          </div>
          {changed && (
            <p className="rounded border border-amber-border bg-amber-soft px-2.5 py-1.5 text-[11px] leading-snug text-ink">
              {NEGOTIATED_TOTAL_ADDON_NOTE}
            </p>
          )}
        </>
      )}
      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting || nothingToIssue}
        aria-label={
          nothingToIssue
            ? "Нечего выдавать — все строки обнулены"
            : allChecked
              ? "Готово, выдать — оформить выдачу с текущими количествами"
              : `Завершить выдачу — собрано ${checkedCount} из ${totalCount} позиций (выдаётся указанное количество)`
        }
        className={`!mt-3 block w-full rounded-lg px-4 py-3 text-center text-[14px] font-semibold text-surface transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60 ${
          nothingToIssue ? "bg-ink-3" : allChecked ? "bg-emerald" : "bg-amber"
        }`}
      >
        {submitting
          ? "Оформляем…"
          : nothingToIssue
            ? "Нечего выдавать"
            : allChecked
              ? "✓ Готово, выдать →"
              : `Завершить (отмечено ${checkedCount} из ${totalCount}) →`}
      </button>
      {nothingToIssue && !submitting && (
        <p className="mt-1 text-center text-[11px] leading-snug text-ink-3">
          Все строки обнулены. Если бронь не состоялась — отмените её на карточке
          брони.
        </p>
      )}
      {!nothingToIssue && !allChecked && unmarked > 0 && !submitting && (
        <p className="mt-1 text-center text-[11px] text-ink-3">
          {unmarked === 1
            ? "1 позиция ещё не собрана — выдаётся указанное количество"
            : `${unmarked} позиций ещё не собрано — выдаётся указанное количество`}
        </p>
      )}
    </div>
  );
}

// ── Модальные окна ───────────────────────────────────────────────────────────

function Dialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // `onClose` приходит новой стрелкой на каждый рендер чек-листа (статус
  // черновика перерисовывает его) — фокус ставим один раз, при открытии, иначе
  // он прыгал бы обратно на первую кнопку.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/40 lg:items-center lg:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="w-full max-w-[440px] rounded-t-2xl border border-border bg-surface px-4 pb-5 pt-4 shadow-lg lg:rounded-xl lg:pb-4"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** «Не все позиции отмечены» — страховка от случайного «Завершить». */
export function ConfirmPartialDialog({
  checked,
  total,
  onCancel,
  onConfirm,
}: {
  checked: number;
  total: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog label="Подтверждение выдачи — не все позиции отмечены" onClose={onCancel}>
      <h3 className="text-[15px] font-semibold text-ink">Не все позиции отмечены</h3>
      <p className="mt-1.5 text-[13px] leading-snug text-ink-2">
        Отмечено {checked} из {total} позиций. Выдача оформится на указанные
        количества — убедитесь, что всё действительно погружено.
      </p>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg border border-border bg-surface px-4 py-3 text-center text-[14px] font-semibold text-ink transition-colors hover:bg-surface-muted"
        >
          Вернуться к списку
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded-lg bg-amber px-4 py-3 text-center text-[14px] font-semibold text-surface transition-colors hover:opacity-95"
        >
          Всё равно выдать
        </button>
      </div>
    </Dialog>
  );
}

/**
 * 409 `ISSUE_TOO_EARLY`: до начала аренды больше суток — то же подтверждение,
 * что у кнопки «Выдать» на карточке брони (P12). Текст — с сервера.
 */
export function EarlyIssueDialog({
  message,
  onCheck,
  onForce,
}: {
  message: string;
  onCheck: () => void;
  onForce: () => void;
}) {
  return (
    <Dialog label="Выдача раньше срока" onClose={onCheck}>
      <h3 className="text-[15px] font-semibold text-ink">Выдать раньше срока?</h3>
      <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{message}</p>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onCheck}
          className="flex-1 rounded-lg border border-border bg-surface px-4 py-3 text-center text-[14px] font-semibold text-ink transition-colors hover:bg-surface-muted"
        >
          Проверить бронь
        </button>
        <button
          type="button"
          onClick={onForce}
          className="flex-1 rounded-lg bg-amber px-4 py-3 text-center text-[14px] font-semibold text-surface transition-colors hover:opacity-95"
        >
          Выдать заранее
        </button>
      </div>
    </Dialog>
  );
}
