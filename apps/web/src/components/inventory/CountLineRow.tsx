"use client";

/**
 * Строка счёта (мокап, экран 1 `.ln`): позиция · «на полке должно быть N» с
 * пояснениями · ввод · результат.
 *
 * Ввод:
 *  - позиция в одном экземпляре (всего по учёту 1) — две кнопки «на месте» /
 *    «нет»: так считают 114 позиций из 295;
 *  - остальные — степпер −/значение/+ (значение можно набрать с клавиатуры,
 *    Enter — сохранить сразу, ↑/↓ — ±1) и быстрая «= N» для непосчитанной
 *    строки: большинство строк сходится одним нажатием.
 * Пустой степпер начинает от «должно быть»: пересчитывают полку, а не с нуля.
 */

import { useEffect, useRef, useState } from "react";

import { expectationNotes, ratePerShiftOf, rubWhole, signed } from "./format";
import type { StockCountLineView } from "./types";
import { FOCUS } from "./ui";

const MAX_QTY = 100_000;

export interface CountLineRowProps {
  line: StockCountLineView;
  /** Что показать: несохранённое значение или сохранённый счёт. */
  value: number | null;
  saving: boolean;
  active: boolean;
  readOnly: boolean;
  /** Поставить фокус в строку при появлении (переход «Пересчитать» из итога). */
  autoFocus?: boolean;
  onSet: (qty: number, opts?: { immediate?: boolean }) => void;
  onCommit: () => void;
  onReset: () => void;
  onActivate: () => void;
}

/** Расхождение строки с учётом ещё не сохранённого значения. */
export function displayDiff(line: StockCountLineView, value: number | null): number | null {
  if (value == null) return null;
  if (value === line.countedQty && line.diff != null) return line.diff;
  return value - line.expected.expected;
}

function clamp(n: number): number {
  return Math.min(MAX_QTY, Math.max(0, n));
}

export function CountLineRow({
  line,
  value,
  saving,
  active,
  readOnly,
  autoFocus = false,
  onSet,
  onCommit,
  onReset,
  onActivate,
}: CountLineRowProps) {
  const expected = line.expected.expected;
  const total = line.expected.total;
  const diff = displayDiff(line, value);
  const single = total === 1;
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!autoFocus || !rowRef.current) return;
    rowRef.current.scrollIntoView?.({ block: "center" });
    rowRef.current.querySelector<HTMLElement>("input, button")?.focus();
  }, [autoFocus]);

  const tint =
    diff != null && diff < 0 ? "bg-rose-soft" : diff != null && diff > 0 ? "bg-emerald-soft" : active ? "bg-accent-soft" : "";
  const notes = expectationNotes(line, diff != null && diff < 0);

  return (
    <li
      ref={rowRef}
      onFocusCapture={onActivate}
      data-testid={`count-line-${line.id}`}
      className={`relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-border px-3.5 py-2 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_196px_150px_112px] lg:gap-3 ${tint} ${
        active ? "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent-bright" : ""
      }`}
    >
      <div className="order-1 min-w-0 lg:order-none">
        <p className={`text-[13px] font-semibold leading-snug ${value == null && !active ? "text-ink-2" : "text-ink"}`}>
          {line.name}
        </p>
        <p className="text-[11px] text-ink-3">всего по учёту {total}</p>
      </div>

      <div className="order-2 col-span-2 text-[11.5px] leading-snug text-ink-2 lg:order-none lg:col-span-1">
        на полке должно быть <b className="mono-num text-sm font-semibold text-ink">{expected}</b>
        {notes.map((n) => (
          <span key={n.text} className={`block text-[11px] ${n.tone === "amber" ? "text-amber" : "text-ink-3"}`}>
            {n.text}
          </span>
        ))}
      </div>

      <div className="order-3 flex flex-wrap items-center gap-1.5 lg:order-none">
        {readOnly ? (
          <span className="mono-num text-[13.5px] font-semibold text-ink">{value ?? "—"}</span>
        ) : single ? (
          <SingleUnitButtons name={line.name} value={value} disabled={saving} onSet={onSet} />
        ) : (
          <Stepper
            name={line.name}
            value={value}
            expected={expected}
            onSet={onSet}
            onCommit={onCommit}
          />
        )}
        {!readOnly && !single && value == null && (
          <button
            type="button"
            onClick={() => onSet(expected, { immediate: true })}
            aria-label={`Всё на месте: ${expected}`}
            className={`whitespace-nowrap rounded border border-emerald-border bg-emerald-soft px-2 py-[3px] text-[11px] font-semibold text-emerald transition-colors hover:bg-emerald hover:text-surface ${FOCUS}`}
          >
            = {expected}
          </button>
        )}
      </div>

      <div className="order-4 text-right lg:order-none">
        <ResultCell line={line} diff={diff} active={active} saving={saving} />
        {!readOnly && line.countedQty != null && !saving && (
          <button
            type="button"
            onClick={onReset}
            className={`mt-0.5 rounded-sm text-[11px] font-semibold text-accent-bright hover:text-accent hover:underline ${FOCUS}`}
          >
            Пересчитать
          </button>
        )}
      </div>
    </li>
  );
}

// ── Ввод ─────────────────────────────────────────────────────────────────────

function SingleUnitButtons({
  name,
  value,
  disabled,
  onSet,
}: {
  name: string;
  value: number | null;
  disabled: boolean;
  onSet: CountLineRowProps["onSet"];
}) {
  const base = `inline-flex min-h-[28px] items-center rounded border px-2.5 text-[11.5px] font-semibold transition-colors disabled:opacity-60 ${FOCUS}`;
  return (
    <div role="group" aria-label={`${name}: на полке?`} className="inline-flex gap-1">
      <button
        type="button"
        aria-pressed={value === 1}
        disabled={disabled}
        onClick={() => onSet(1, { immediate: true })}
        className={`${base} ${
          value === 1
            ? "border-emerald bg-emerald text-surface"
            : "border-emerald-border bg-emerald-soft text-emerald hover:border-emerald"
        }`}
      >
        на месте
      </button>
      <button
        type="button"
        aria-pressed={value === 0}
        disabled={disabled}
        onClick={() => onSet(0, { immediate: true })}
        className={`${base} ${
          value === 0 ? "border-rose bg-rose text-surface" : "border-rose-border bg-surface text-rose hover:border-rose"
        }`}
      >
        нет
      </button>
    </div>
  );
}

function Stepper({
  name,
  value,
  expected,
  onSet,
  onCommit,
}: {
  name: string;
  value: number | null;
  expected: number;
  onSet: CountLineRowProps["onSet"];
  onCommit: () => void;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value == null ? "" : String(value));
  }, [value]);

  const base = value ?? expected;
  const step = (delta: number) => onSet(clamp(base + delta));

  const btn = `h-7 w-[26px] bg-surface-subtle text-sm leading-none text-ink-2 transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-40 ${FOCUS}`;
  return (
    <span className="inline-flex items-center overflow-hidden rounded border border-border-strong bg-surface">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={value === 0}
        aria-label={`Меньше: ${name}`}
        className={btn}
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={`Посчитано: ${name}`}
        placeholder="—"
        value={draft}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          setDraft(value == null ? "" : String(value));
        }}
        onChange={(e) => {
          const text = e.target.value.replace(/\s/g, "");
          setDraft(text);
          if (/^\d{1,6}$/.test(text)) {
            const n = Number(text);
            if (n <= MAX_QTY) onSet(n);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const next = clamp(base + (e.key === "ArrowUp" ? 1 : -1));
            setDraft(String(next));
            onSet(next);
          }
        }}
        className={`mono-num h-7 w-11 border-x border-border bg-surface text-center text-[13.5px] font-semibold text-ink placeholder:font-normal placeholder:text-ink-3 ${FOCUS} focus-visible:outline-offset-[-2px]`}
      />
      <button type="button" onClick={() => step(1)} aria-label={`Больше: ${name}`} className={btn}>
        +
      </button>
    </span>
  );
}

// ── Результат ────────────────────────────────────────────────────────────────

function ResultCell({
  line,
  diff,
  active,
  saving,
}: {
  line: StockCountLineView;
  diff: number | null;
  active: boolean;
  saving: boolean;
}) {
  const caption = saving ? "сохраняю…" : null;
  if (diff == null) {
    return (
      <p className="text-xs text-ink-3" aria-live="polite">
        {saving ? "сохраняю…" : active ? "считаем" : "не посчитано"}
      </p>
    );
  }
  if (diff === 0) {
    return (
      <p className="text-xs font-semibold text-emerald" aria-live="polite">
        сошлось
        {caption && <span className="block text-[10.5px] font-normal text-ink-3">{caption}</span>}
      </p>
    );
  }
  const minus = diff < 0;
  return (
    <p
      className={`mono-num text-sm font-bold ${minus ? "text-rose" : "text-emerald"}`}
      aria-live="polite"
      title={line.countedBy ? `посчитал ${line.countedBy}` : undefined}
    >
      {signed(diff)}
      <span className="block font-sans text-[10.5px] font-normal text-ink-3">
        {caption ?? (minus ? `${rubWhole(ratePerShiftOf(line.ratePerShift, diff))} ₽/смена` : "излишек")}
      </span>
    </p>
  );
}
