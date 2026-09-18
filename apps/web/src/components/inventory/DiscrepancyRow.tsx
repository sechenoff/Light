"use client";

/**
 * Строка расхождения в «Итоге» (мокап, экран 2 `.dr`): позиция, контекст,
 * «ожидали → посчитали», решение и раскрывающееся «Как пропало».
 *
 * Привязка «Пропало» к брони — только к той, которую руководитель видел.
 * Подсказка (единственная бронь, принятая без пересчёта) приходит для всех
 * недостач разом (`suggestion`, GET …/trail-suggestions) и сразу пишется в
 * контекст строки: «вероятно — «…» (N шт, даты)…». Полный след грузится
 * только по «Как пропало ▾». «Пропало → потеряшки» берёт бронь, выбранную в
 * следе, а если там не трогали — показанную подсказку; подсказки нет —
 * уходит с уже записанной бронью строки или без брони («бронь не определена»),
 * а не с невидимой догадкой: по привязке потом выставляют компенсацию.
 *
 * Решение привязано к тому, что видно на экране: с ним уходят счёт и «должно
 * быть» строки (строку пересчитали — 409 LINE_CHANGED). Если учёт позиции
 * изменился после счёта, строка говорит, что именно, и предлагает выбрать:
 * «Обновить ожидание» (учёт лишь догнал полку) или «Оставить как посчитано»
 * (движение было после счёта) — тогда «Пропало» / «Ошибка учёта» уходят с
 * подтверждением.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { toast } from "../ToastProvider";
import { errorCode, explainInventoryError, inventoryApi, type DecisionBody } from "./api";
import { AdjustReasonDialog } from "./AdjustReasonDialog";
import { DecisionControl, type DecisionOption } from "./DecisionControl";
import {
  adjustPreview,
  booksChangeText,
  effectiveDecision,
  fmtRange,
  fmtTime,
  quoteName,
  ratePerShiftOf,
  readyForPickupText,
  rubWhole,
  signed,
} from "./format";
import { NO_BOOKING, TrailPanel } from "./TrailPanel";
import type {
  Decision,
  EquipmentTrail,
  StockCountLineView,
  StockCountStatus,
  TrailBooking,
  TrailSuggestion,
} from "./types";
import { FOCUS } from "./ui";

export interface DiscrepancyRowProps {
  stockCountId: string;
  line: StockCountLineView;
  /** Статус инвентаризации: у завершённой и отменённой строка только на чтение. */
  status: StockCountStatus;
  /** Сервер вернул строку после решения. */
  onLineChange: (line: StockCountLineView) => void;
  /** «Пересчитать»: строка снова не посчитана — вернуться к счёту. */
  onRecount: (line: StockCountLineView) => void;
  /** Решение изменило итоги — перечитать карточку инвентаризации. */
  onChanged: () => void;
  /** Данные устарели (закрыта, строка сошлась) — перечитать всё. */
  onStale: () => void;
  /** Подсказка следа из общего запроса «Итога»; раскрытый след её заменяет. */
  suggestion?: TrailSuggestion | null;
}

const STALE_CODES = new Set([
  "STOCK_COUNT_NOT_OPEN",
  "LINE_NOT_DISCREPANT",
  "LINE_NOT_COUNT_MODE",
  "LINE_NOT_FOUND",
  "LINE_CHANGED",
  "LINE_BOOKS_CHANGED",
  "LINE_NOT_COUNTED",
]);

type ContextTone = "amber" | "hint" | "muted";

interface ContextLine {
  tone: ContextTone;
  text: string;
  /** Янтарная приставка перед текстом («уже N в потеряшках…»). */
  lead?: string;
}

/**
 * Подсказка следа, которую можно показать: бронь есть среди загруженных.
 * Подсказку за пределами загруженного окна показать нечем — значит, и
 * привязывать её нельзя.
 */
export function visibleSuggestion(trail: EquipmentTrail | null): TrailBooking | null {
  if (!trail?.suggestedBookingId) return null;
  return trail.bookings.find((b) => b.bookingId === trail.suggestedBookingId) ?? null;
}

/** «при счёте на съёмках 4 · по календарю 2» — откуда могло взяться «лишнее». */
function surplusExplanation(line: StockCountLineView): string | null {
  const b = line.expected;
  const parts = [
    b.issued > 0 ? `на съёмках ${b.issued}` : null,
    b.calendar > 0 ? `по календарю ${b.calendar}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `при счёте ${parts.join(" · ")}` : null;
}

/**
 * Контекст под названием: почему расхождение и что с ним будет. У завершённой
 * инвентаризации — в прошедшем времени, у отменённой — «не применено»: живые
 * потеряшки к этому моменту могли закрыться, и обещать «Нашлось» было бы
 * неправдой. У недостачи идущей инвентаризации с подсказкой следа — сама
 * подсказка (мокап, экран 2): её видно до решения и после «Пропало».
 */
function contextLine(
  line: StockCountLineView,
  decision: Decision | null,
  status: StockCountStatus,
  suggestion: TrailSuggestion | null,
): ContextLine {
  const b = line.expected;
  const diff = line.diff ?? 0;
  const nextTotal = Math.max(0, b.total + diff);
  if (decision === "ADJUST") {
    const preview = adjustPreview(line);
    const text =
      status === "CLOSED"
        ? `учёт поправлен с ${b.total} до ${nextTotal}`
        : status === "CANCELLED"
          ? "поправка не применена — инвентаризация отменена"
          : `учёт поправится с ${preview.from} до ${preview.to}`;
    return { tone: "muted", text };
  }
  if (diff < 0) {
    const alreadyLost = b.lost > 0 ? `уже ${b.lost} в потеряшках — эти ${-diff} пропали сверху` : null;
    if (suggestion && status === "OPEN") {
      return {
        tone: "hint",
        lead: alreadyLost ?? undefined,
        text: `вероятно — ${quoteName(suggestion.projectName)} (${suggestion.quantity} шт, ${fmtRange(
          suggestion.startDate,
          suggestion.endDate,
        )}): единственная бронь, принятая без пересчёта`,
      };
    }
    if (alreadyLost) return { tone: "amber", text: alreadyLost };
    const parts = [`по учёту ${b.total}`];
    if (b.issued > 0) parts.push(`на съёмках ${b.issued}`);
    if (b.calendar > 0) parts.push(`по календарю ${b.calendar}`);
    if (b.repair > 0) parts.push(`в мастерской ${b.repair}`);
    return { tone: "muted", text: parts.join(" · ") };
  }
  if (status !== "OPEN") return { tone: "muted", text: `по учёту ${b.total}` };
  if (line.openProblemQty > 0) {
    return {
      tone: "hint",
      text: `открыто потеряшек — ${line.openProblemQty} шт: «Нашлось» закроет их как найденные`,
    };
  }
  const preview = adjustPreview(line);
  const explain = surplusExplanation(line);
  return {
    tone: "muted",
    text: `${explain ? `${explain} · ` : ""}открытых потеряшек по позиции нет — учёт поправится с ${preview.from} до ${preview.to}`,
  };
}

function decidedNote(line: StockCountLineView, decision: Decision, status: StockCountStatus): string {
  const who = line.decidedBy ? `решил ${line.decidedBy}${line.decidedAt ? ` · ${fmtTime(line.decidedAt)}` : ""}` : "решено";
  const cancelled = status === "CANCELLED" ? " · не применено" : "";
  if (decision === "LOST") {
    return `${who} · ${line.sourceBooking ? `привязано к ${quoteName(line.sourceBooking.projectName)}` : "бронь не определена"}${cancelled}`;
  }
  if (decision === "ADJUST") return `${who}${line.decisionNote ? ` · «${line.decisionNote}»` : ""}`;
  if (status === "CANCELLED") return `${who}${cancelled}`;
  return `${who} · потеряшка ${status === "CLOSED" ? "закрыта" : "закроется"} как «найдено»`;
}

export function DiscrepancyRow({
  stockCountId,
  line,
  status,
  onLineChange,
  onRecount,
  onChanged,
  onStale,
  suggestion: givenSuggestion = null,
}: DiscrepancyRowProps) {
  const readOnly = status !== "OPEN";
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<EquipmentTrail | null>(null);
  const [trailLoading, setTrailLoading] = useState(false);
  const [trailError, setTrailError] = useState<string | null>(null);
  const [bindValue, setBindValue] = useState<string>(line.sourceBookingId ?? NO_BOOKING);
  const [bindTouched, setBindTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  // «Оставить как посчитано» нажато в этом заходе — следующее «Пропало» /
  // «Ошибка учёта» уходит с подтверждением.
  const [keepAsCounted, setKeepAsCounted] = useState(false);

  const diff = line.diff ?? 0;
  const shortage = diff < 0;
  const decision = effectiveDecision(line);
  const canTrail = shortage && line.equipmentId != null;
  // Раскрытый след авторитетнее общей подсказки: он свежее и его видно целиком.
  const suggestion: TrailSuggestion | null = trail ? visibleSuggestion(trail) : givenSuggestion;
  const suggestedId = suggestion?.bookingId ?? null;
  const booksText = readOnly ? null : booksChangeText(line);
  const acknowledged = keepAsCounted || line.booksAcknowledged;

  // Выбор в следе повторяет записанное: у «Пропало» без брони — «не
  // определено», а не подсказка, иначе селект показывал бы не то, что решено.
  useEffect(() => {
    if (bindTouched) return;
    setBindValue(line.sourceBookingId ?? (decision === "LOST" ? null : suggestedId) ?? NO_BOOKING);
  }, [line.sourceBookingId, decision, suggestedId, bindTouched]);

  // Учёт больше не расходится со снапшотом — прежнее «оставить» не в силе.
  useEffect(() => {
    if (!line.booksChangedSinceCount) setKeepAsCounted(false);
  }, [line.booksChangedSinceCount]);

  const loadTrail = useCallback(async (): Promise<EquipmentTrail | null> => {
    setTrailLoading(true);
    setTrailError(null);
    try {
      const { trail: data } = await inventoryApi.trail(stockCountId, line.id);
      setTrail(data);
      return data;
    } catch (e) {
      setTrailError(explainInventoryError(e, "Не удалось собрать брони с этой позицией"));
      return null;
    } finally {
      setTrailLoading(false);
    }
  }, [stockCountId, line.id]);

  const toggleTrail = () => {
    const next = !open;
    setOpen(next);
    if (next && !trail && !trailLoading) void loadTrail();
  };

  const decide = async (
    next: Decision | null,
    extra: { note?: string | null; sourceBookingId?: string | null; acknowledge?: boolean } = {},
  ) => {
    setBusy(true);
    try {
      const { acknowledge, ...rest } = extra;
      const body: DecisionBody = { decision: next, ...rest };
      if (next !== null) {
        // Решение — ровно по тому, что на экране (строку пересчитали — 409 LINE_CHANGED).
        body.seenCountedQty = line.countedQty ?? undefined;
        body.seenExpectedQty = line.expected.expected;
        const books = next === "LOST" || next === "ADJUST";
        if (books && line.booksChangedSinceCount && (acknowledge || acknowledged)) body.acknowledgeBooksChanged = true;
      }
      const { line: fresh } = await inventoryApi.decide(stockCountId, line.id, body);
      onLineChange(fresh);
      onChanged();
      return true;
    } catch (e) {
      toast.error(explainInventoryError(e, "Не удалось сохранить решение"));
      const code = errorCode(e);
      if (code === "LINE_BOOKS_CHANGED") setKeepAsCounted(false);
      if (code && STALE_CODES.has(code)) onStale();
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Бронь для «Пропало»: выбранная в следе, иначе подсказка — она уже видна в
   * строке (из раскрытого следа, если он загружен, иначе из общего запроса).
   * Подсказки нет — только то, что строке уже записано; догадку, которую не
   * показали, не отправляем. Выводится из того же, что на экране, а не из
   * `bindValue`: эффект, который его синхронизирует, отстаёт на кадр.
   */
  const resolveLostBooking = (): string | null => {
    if (bindTouched) return bindValue || null;
    return line.sourceBookingId ?? suggestedId ?? null;
  };

  const handleSelect = async (option: DecisionOption) => {
    if (option === "RESET") {
      setBusy(true);
      try {
        const { line: fresh } = await inventoryApi.reset(stockCountId, line.id);
        onChanged();
        onRecount(fresh);
      } catch (e) {
        toast.error(explainInventoryError(e, "Не удалось сбросить счёт строки"));
        if (errorCode(e) === "STOCK_COUNT_NOT_OPEN") onStale();
      } finally {
        setBusy(false);
      }
      return;
    }
    if (decision === option) {
      await decide(null);
      return;
    }
    if (option === "ADJUST") {
      setAdjusting(true);
      return;
    }
    if (option === "LOST") {
      await decide("LOST", { sourceBookingId: resolveLostBooking() });
      return;
    }
    await decide("FOUND");
  };

  const handleBindChange = (value: string) => {
    setBindValue(value);
    setBindTouched(true);
    if (decision === "LOST") void decide("LOST", { note: line.decisionNote, sourceBookingId: value || null });
  };

  /** «Обновить ожидание»: учёт лишь догнал то, что уже лежало на полке при счёте. */
  const handleRefreshExpected = async () => {
    setBusy(true);
    try {
      const { line: fresh } = await inventoryApi.refreshExpected(stockCountId, line.id);
      setKeepAsCounted(false);
      onLineChange(fresh);
      onChanged();
    } catch (e) {
      toast.error(explainInventoryError(e, "Не удалось обновить ожидание"));
      const code = errorCode(e);
      if (code && STALE_CODES.has(code)) onStale();
    } finally {
      setBusy(false);
    }
  };

  /**
   * «Оставить как посчитано»: движение было после счёта. Решение уже есть —
   * подтверждается сразу; нет — следующее «Пропало» / «Ошибка учёта» уйдёт
   * с подтверждением.
   */
  const handleKeepAsCounted = async () => {
    if (decision === "LOST") {
      await decide("LOST", { note: line.decisionNote, sourceBookingId: line.sourceBookingId, acknowledge: true });
      return;
    }
    if (decision === "ADJUST") {
      await decide("ADJUST", { note: line.decisionNote, acknowledge: true });
      return;
    }
    setKeepAsCounted(true);
  };

  const ctx = contextLine(line, decision, status, suggestion);
  const numsCaption =
    decision === "ADJUST"
      ? "ошибка учёта"
      : decision === "FOUND"
        ? "нашлось"
        : shortage
          ? `${rubWhole(ratePerShiftOf(line.ratePerShift, diff))} ₽/смена`
          : "излишек";

  return (
    <li
      className={`relative border-b border-border last:border-b-0 ${
        open ? "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-rose" : ""
      }`}
      data-testid={`discrepancy-${line.id}`}
    >
      <div
        className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3.5 py-2.5 xl:grid-cols-[minmax(0,1fr)_128px_auto] ${
          decision ? "bg-surface-muted" : ""
        }`}
      >
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-snug text-ink">
            {line.name}
            <small className="ml-1 text-[11px] font-normal text-ink-3">{line.category}</small>
          </p>
          <p
            className={`mt-0.5 text-[11.5px] leading-snug ${
              ctx.tone === "amber" ? "font-semibold text-amber" : ctx.tone === "hint" ? "font-semibold text-accent-bright" : "text-ink-2"
            }`}
          >
            {ctx.lead && (
              <>
                <span className="font-semibold text-amber">{ctx.lead}</span>
                {" · "}
              </>
            )}
            {ctx.text}
          </p>
          {shortage && !readOnly && readyForPickupText(line.readyForPickupQty) && (
            <p className="mt-0.5 text-[11px] text-ink-3">{readyForPickupText(line.readyForPickupQty)}</p>
          )}
          {decision && <p className="mt-0.5 text-[11px] text-ink-3">{decidedNote(line, decision, status)}</p>}
          {booksText && (
            <BooksChangedNote
              text={booksText}
              acknowledged={acknowledged && decision !== "FOUND"}
              canKeep={decision !== "FOUND"}
              busy={busy}
              onRefresh={() => void handleRefreshExpected()}
              onKeep={() => void handleKeepAsCounted()}
            />
          )}
          {canTrail && (
            <button
              type="button"
              onClick={toggleTrail}
              aria-expanded={open}
              aria-controls={panelId}
              className={`mt-0.5 inline-flex items-center gap-1 rounded-sm text-[11px] font-semibold text-accent-bright hover:text-accent ${FOCUS}`}
            >
              Как пропало {open ? "▴" : "▾"}
            </button>
          )}
        </div>

        <p className="mono-num whitespace-nowrap text-right text-[12.5px] leading-snug text-ink-2">
          {line.expected.expected} → {line.countedQty}
          <span className={`block text-[14.5px] font-bold ${shortage ? "text-rose" : "text-emerald"}`}>{signed(diff)}</span>
          <small className="block font-sans text-[10.5px] text-ink-3">{numsCaption}</small>
        </p>

        <div className="col-span-2 xl:col-span-1">
          <DecisionControl line={line} readOnly={readOnly} busy={busy} onSelect={(o) => void handleSelect(o)} />
        </div>
      </div>

      {open && canTrail && (
        <div id={panelId}>
          <TrailPanel
            trail={trail}
            loading={trailLoading}
            error={trailError}
            onRetry={() => void loadTrail()}
            qty={-diff}
            name={line.name}
            extraBooking={line.sourceBooking}
            bind={
              readOnly
                ? null
                : {
                    editable: line.allowedDecisions.includes("LOST"),
                    value: bindValue,
                    busy,
                    onChange: handleBindChange,
                  }
            }
          />
        </div>
      )}

      <AdjustReasonDialog
        line={adjusting ? line : null}
        busy={busy}
        onClose={() => setAdjusting(false)}
        onSubmit={async (note) => {
          // Отказ (строку пересчитали, учёт изменился) диалог не закрывает:
          // набранная причина остаётся, а расхождение в нём уже новое.
          const ok = await decide("ADJUST", { note });
          if (ok) setAdjusting(false);
        }}
      />
    </li>
  );
}

/**
 * Учёт позиции изменился после счёта: что именно и два честных выхода.
 * Кнопки подписаны видимым текстом, а не только подсказкой — на планшете
 * наведения нет.
 */
function BooksChangedNote({
  text,
  acknowledged,
  canKeep,
  busy,
  onRefresh,
  onKeep,
}: {
  text: string;
  acknowledged: boolean;
  canKeep: boolean;
  busy: boolean;
  onRefresh: () => void;
  onKeep: () => void;
}) {
  const btn = `rounded-sm text-[11px] font-semibold text-accent-bright hover:text-accent hover:underline disabled:opacity-50 ${FOCUS}`;
  return (
    <div className="mt-1 rounded border border-amber-border bg-amber-soft px-2 py-1.5 text-[11px] leading-snug text-ink-2">
      <p>
        <b className="font-semibold text-amber">{text}</b>
        {acknowledged && <span className="text-ink-3"> · оставлено как посчитано</span>}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={onRefresh} disabled={busy} className={btn}>
          Обновить ожидание
        </button>
        {canKeep && !acknowledged && (
          <button type="button" onClick={onKeep} disabled={busy} className={btn}>
            Оставить как посчитано
          </button>
        )}
      </div>
      <p className="mt-0.5 text-[10.5px] text-ink-3">
        обновить — если оборудование уже лежало на полке при счёте; оставить — если движение было после счёта
      </p>
    </div>
  );
}
