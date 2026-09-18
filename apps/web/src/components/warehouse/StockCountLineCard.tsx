"use client";

/**
 * Карточка строки инвентаризации в киоске (мокап final-inventory.html,
 * «Киоск · считаем полку»).
 *
 *  - Позиция в одном экземпляре → две большие кнопки «✓ На месте» / «Нет на
 *    полке» (сохраняются сразу).
 *  - Остальные → крупно «на полке должно быть N», степпер (цели 44 px) с
 *    ручным вводом числа и «Всё на месте · N» во всю ширину.
 *  - После счёта — итог строки («✓ сошлось · 6», «−2 · решит руководитель
 *    после счёта») и ссылка «Пересчитать» (цель 44 px). Посчитанная карточка
 *    сворачивается и приглушается, текущая — подсвечена.
 *  - Если по строке уже решил руководитель, «Пересчитать» спрашивает ещё раз:
 *    сброс счёта на сервере снимает и решение с причиной, а непосчитанная
 *    строка «Завершить» не блокирует — промах пальцем иначе молча стёр бы
 *    поправку учёта. Карточка при этом помечена «решено руководителем».
 *    Строки грузятся при входе в участок, поэтому гард видит решения, принятые
 *    до этого момента.
 */

import { useEffect, useRef, useState } from "react";
import type { StockCountLineView } from "../inventory/types";
import type { CountSaveMode } from "./StockCountKiosk";
import {
  MAX_COUNT_QTY,
  isSingleUnitLine,
  lineExplanation,
  lineResult,
} from "./StockCountFormat";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

export interface StockCountLineCardProps {
  line: StockCountLineView;
  /** Текущая строка — подсвечена (первая непосчитанная или та, что правят). */
  current: boolean;
  /** Посчитанная и не в работе — свёрнута до названия и итога. */
  compact: boolean;
  saving: boolean;
  error: string | null;
  onCount: (qty: number, mode: CountSaveMode) => void;
  onReset: () => void;
}

function Explanation({ line }: { line: StockCountLineView }) {
  const parts = lineExplanation(line);
  return (
    <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          <span className={p.tone === "amber" ? "font-semibold text-amber" : undefined}>
            {p.text}
          </span>
        </span>
      ))}
    </p>
  );
}

function SingleUnitButtons({ onCount }: { onCount: StockCountLineCardProps["onCount"] }) {
  return (
    <div className="mt-2.5 grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => onCount(1, "now")}
        className={`flex min-h-[48px] items-center justify-center rounded-lg border border-emerald-border bg-emerald-soft px-2 text-[14.5px] font-bold text-emerald transition-colors hover:bg-surface active:bg-emerald-soft ${FOCUS_RING}`}
      >
        ✓ На месте
      </button>
      <button
        type="button"
        onClick={() => onCount(0, "now")}
        className={`flex min-h-[48px] items-center justify-center rounded-lg border border-rose-border bg-surface px-2 text-[14.5px] font-bold text-rose transition-colors hover:bg-rose-soft active:bg-rose-soft ${FOCUS_RING}`}
      >
        Нет на полке
      </button>
    </div>
  );
}

function Stepper({
  line,
  onCount,
}: {
  line: StockCountLineView;
  onCount: StockCountLineCardProps["onCount"];
}) {
  const counted = line.countedQty;
  const expected = line.expected.expected;
  // Пока поле в фокусе, показываем то, что набирают, а не число из строки.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (counted == null ? "" : String(counted));
  // С пустого степпер шагает от «должно быть»: недостача в одну штуку — одно касание «−».
  const base = counted ?? expected;

  const step = (delta: number) => {
    setDraft(null);
    onCount(Math.min(MAX_COUNT_QTY, Math.max(0, base + delta)), "debounced");
  };

  const buttonClass = `flex h-11 w-11 items-center justify-center bg-surface-subtle text-[19px] leading-none text-ink-2 transition-colors hover:bg-surface-muted active:bg-border disabled:cursor-not-allowed disabled:text-ink-3/50 ${FOCUS_RING}`;

  return (
    <div className="flex shrink-0 items-stretch overflow-hidden rounded-lg border border-border-strong bg-surface">
      <button
        type="button"
        aria-label={`Меньше — ${line.name}`}
        onClick={() => step(-1)}
        disabled={counted === 0}
        className={buttonClass}
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        aria-label={`Посчитано — ${line.name}`}
        placeholder="—"
        value={shown}
        onFocus={() => setDraft(shown)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
          setDraft(digits);
          if (digits !== "") onCount(Number(digits), "debounced");
        }}
        className={`mono-num w-[60px] border-x border-border bg-surface text-center text-[18px] font-semibold text-ink placeholder:font-normal placeholder:text-ink-3 ${FOCUS_RING} focus-visible:ring-offset-0`}
      />
      <button
        type="button"
        aria-label={`Больше — ${line.name}`}
        onClick={() => step(1)}
        disabled={counted != null && counted >= MAX_COUNT_QTY}
        className={buttonClass}
      >
        +
      </button>
    </div>
  );
}

export function StockCountLineCard({
  line,
  current,
  compact,
  saving,
  error,
  onCount,
  onReset,
}: StockCountLineCardProps) {
  const single = isSingleUnitLine(line);
  const uncounted = line.countedQty == null;
  const result = lineResult(line);
  const expected = line.expected.expected;
  const decided = line.decision != null;

  const [confirmReset, setConfirmReset] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Строка поменялась (пересчитали, решение сняли) — вопрос устарел.
  useEffect(() => setConfirmReset(false), [line.decision, line.countedQty]);
  useEffect(() => {
    if (confirmReset) cancelRef.current?.focus();
  }, [confirmReset]);

  const frame = current
    ? "border-accent-border bg-surface ring-2 ring-accent-soft"
    : compact
      ? "border-border bg-surface-muted"
      : "border-border bg-surface";

  return (
    <article
      aria-label={line.name}
      aria-current={current ? "step" : undefined}
      className={`rounded-lg border px-3 py-2.5 ${frame}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`min-w-0 text-[14px] font-semibold leading-snug ${compact ? "text-ink-2" : "text-ink"}`}
        >
          {line.name}
        </h3>
        {saving ? (
          <span className="shrink-0 pt-0.5 text-[11px] text-ink-3" aria-live="polite">
            сохраняем…
          </span>
        ) : compact && line.countedQty != null ? (
          <span className="flex shrink-0 items-baseline gap-1.5 pt-0.5 text-[11.5px] text-ink-3">
            {decided && <span>решено руководителем</span>}
            <span className="mono-num">
              {line.countedQty} из {expected}
            </span>
          </span>
        ) : null}
      </div>

      {!compact && <Explanation line={line} />}

      {!compact && single && uncounted && <SingleUnitButtons onCount={onCount} />}

      {!compact && !single && (
        <>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[12.5px] leading-tight text-ink-2">
              на полке
              <br />
              должно быть{" "}
              <b className="mono-num text-[17px] text-ink">{expected}</b>
            </p>
            <Stepper line={line} onCount={onCount} />
          </div>
          {uncounted && (
            <button
              type="button"
              onClick={() => onCount(expected, "now")}
              className={`mt-2 flex min-h-[44px] w-full items-center justify-center rounded border border-emerald-border bg-emerald-soft px-3 text-[13.5px] font-semibold text-emerald transition-colors hover:bg-surface ${FOCUS_RING}`}
            >
              Всё на месте · {expected}
            </button>
          )}
        </>
      )}

      {result && (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p
            className={`text-[12px] font-semibold ${result.tone === "rose" ? "text-rose" : "text-emerald"}`}
          >
            {result.text}
          </p>
          {!confirmReset && (
            <button
              type="button"
              onClick={() => (decided ? setConfirmReset(true) : onReset())}
              className={`-mr-1 min-h-[44px] min-w-[44px] shrink-0 rounded px-2 text-[12px] font-medium text-accent-bright hover:underline ${FOCUS_RING}`}
            >
              Пересчитать
            </button>
          )}
        </div>
      )}

      {result && confirmReset && (
        <div role="alert" className="mt-2 rounded border border-amber-border bg-amber-soft px-2.5 py-2">
          <p className="text-[12px] leading-snug text-ink">
            Руководитель уже решил по этой строке — пересчёт снимет решение
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={() => setConfirmReset(false)}
              className={`min-h-[44px] rounded border border-border-strong bg-surface px-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-muted ${FOCUS_RING}`}
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmReset(false);
                onReset();
              }}
              className={`min-h-[44px] rounded border border-rose-border bg-surface px-2 text-[13px] font-semibold text-rose transition-colors hover:bg-rose-soft ${FOCUS_RING}`}
            >
              Пересчитать всё равно
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-1.5 text-[12px] leading-snug text-rose">
          {error}
        </p>
      )}
    </article>
  );
}
