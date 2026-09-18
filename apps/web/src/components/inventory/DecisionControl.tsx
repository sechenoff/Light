"use client";

/**
 * Решение по расхождению — сегмент из трёх кнопок (мокап `.seg`):
 *   недостача: «Пропало → потеряшки» · «Ошибка учёта» · «Пересчитать»
 *   излишек:   «Нашлось» · «Ошибка учёта» · «Пересчитать»
 *
 * Что доступно, решает сервер (`allowedDecisions`). Недоступное решение не
 * прячется: кнопка остаётся на месте, но заблокирована, а причина написана
 * и во всплывающей подсказке, и видимым текстом под сегментом — на планшете
 * подсказок нет. `aria-disabled` вместо `disabled`, чтобы подсказка
 * показывалась при наведении.
 *
 * Выбранное решение залито цветом (rose / slate / emerald, текст
 * `text-surface`); повторное нажатие на него снимает решение.
 */

import { useId } from "react";

import { DECISION_LABEL, RESET_LABEL, effectiveDecision } from "./format";
import type { Decision, StockCountLineView } from "./types";
import { FOCUS } from "./ui";

export type DecisionOption = Decision | "RESET";

const FILLED: Record<Decision, string> = {
  LOST: "bg-rose text-surface hover:bg-rose",
  ADJUST: "bg-slate text-surface hover:bg-slate",
  FOUND: "bg-emerald text-surface hover:bg-emerald",
};

/** Почему решение недоступно — человеческим языком. */
export function unavailableReason(
  option: Decision,
  line: Pick<StockCountLineView, "allowedDecisions" | "diff" | "equipmentId">,
): string | null {
  if (line.allowedDecisions.includes(option)) return null;
  if (line.allowedDecisions.length === 0) {
    return line.equipmentId
      ? "позиция на штучном учёте — её сверяют по единицам в карточке оборудования"
      : "позицию удалили из каталога";
  }
  if (option === "FOUND") return "нет открытых потеряшек по позиции — закрывать нечего";
  if (option === "LOST") return "«Пропало» — только для недостачи";
  return "решение недоступно для этой строки";
}

export function DecisionControl({
  line,
  readOnly,
  busy,
  onSelect,
}: {
  line: StockCountLineView;
  /** Завершённая / отменённая: только показать записанное решение. */
  readOnly: boolean;
  busy: boolean;
  onSelect: (option: DecisionOption) => void;
}) {
  const hintId = useId();
  const diff = line.diff ?? 0;
  const current = effectiveDecision(line);
  const options: DecisionOption[] = diff < 0 ? ["LOST", "ADJUST", "RESET"] : ["FOUND", "ADJUST", "RESET"];

  const reasons = readOnly
    ? []
    : options
        .filter((o): o is Decision => o !== "RESET")
        .map((o) => ({ option: o, reason: unavailableReason(o, line) }))
        .filter((r): r is { option: Decision; reason: string } => r.reason != null);
  // Если недоступно всё — одна общая причина, а не две одинаковые.
  const uniqueReasons = reasons.filter((r, i) => reasons.findIndex((x) => x.reason === r.reason) === i);

  return (
    <div>
      <div
        role="group"
        aria-label={`Решение: ${line.name}`}
        aria-busy={busy || undefined}
        className="grid w-full grid-cols-2 overflow-hidden rounded border border-border bg-surface sm:inline-flex sm:w-auto"
      >
        {options.map((option, index) => {
          const isReset = option === "RESET";
          const reason = isReset ? null : unavailableReason(option, line);
          const blocked = readOnly || busy || (!isReset && reason != null);
          const pressed = !isReset && current === option;
          const label = isReset ? RESET_LABEL : DECISION_LABEL[option];
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isReset ? undefined : pressed}
              aria-disabled={blocked || undefined}
              aria-describedby={!readOnly && reason ? hintId : undefined}
              title={!readOnly && reason ? reason : pressed && !readOnly ? "Нажмите ещё раз, чтобы снять решение" : undefined}
              onClick={() => {
                if (blocked) return;
                onSelect(option);
              }}
              className={`whitespace-normal border-border px-2 py-[7px] text-center text-[11px] font-semibold leading-[1.5] transition-colors sm:whitespace-nowrap sm:border-r sm:px-[9px] sm:py-1 sm:last:border-r-0 ${
                index < 2 ? "border-b sm:border-b-0" : "col-span-2 sm:col-span-1"
              } ${index === 0 ? "border-r" : ""} ${
                pressed
                  ? FILLED[option as Decision]
                  : blocked
                    ? `cursor-not-allowed text-ink-3 ${readOnly ? "" : "bg-surface-subtle"}`
                    : "text-ink-2 hover:bg-surface-muted hover:text-ink"
              } ${FOCUS} focus-visible:outline-offset-[-2px]`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {uniqueReasons.length > 0 && (
        <p id={hintId} className="mt-1 text-[11px] leading-snug text-ink-3">
          {uniqueReasons
            .map((r) =>
              line.allowedDecisions.length === 0 ? `Решения недоступны: ${r.reason}` : `«${DECISION_LABEL[r.option]}» недоступно: ${r.reason}`,
            )
            .join(". ")}
        </p>
      )}
    </div>
  );
}
