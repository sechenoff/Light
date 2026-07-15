"use client";

// Шаговая навигация формы брони (фаза 4.8). Это НЕ жёсткий wizard:
// менеджер собирает смету по телефону и прыгает между секциями, поэтому все
// секции остаются на странице, а рейка даёт структуру «по шагам» — статус
// каждого шага (✓ готов / номер / ! ошибка) и клик-переход к секции.

export type StepState = "complete" | "error" | "idle";

export type StepDef = {
  id: string;
  label: string;
  state: StepState;
  /** Необязательный шаг — не участвует в валидации, помечается подписью. */
  optional?: boolean;
};

const CIRCLE_BY_STATE: Record<StepState, string> = {
  complete: "border-emerald bg-emerald-soft text-emerald",
  error: "border-rose bg-rose-soft text-rose",
  idle: "border-border bg-surface text-ink-3",
};

const LABEL_BY_STATE: Record<StepState, string> = {
  complete: "text-ink",
  error: "text-rose",
  idle: "text-ink-3",
};

export function StepsNav({
  steps,
  onStepClick,
}: {
  steps: StepDef[];
  onStepClick: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Шаги оформления брони"
      className="flex items-center gap-1 overflow-x-auto px-4 py-2 md:px-8"
    >
      {steps.map((step, i) => {
        const state: StepState = step.state;
        return (
          <div key={step.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span aria-hidden="true" className="h-px w-4 bg-border md:w-6" />}
            <button
              type="button"
              onClick={() => onStepClick(step.id)}
              aria-label={`Шаг ${i + 1}: ${step.label}${
                state === "complete" ? " — готово" : state === "error" ? " — есть ошибка" : ""
              }`}
              className="group flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors hover:bg-surface-muted"
            >
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold transition-colors ${CIRCLE_BY_STATE[state]}`}
              >
                {state === "complete" ? "✓" : state === "error" ? "!" : i + 1}
              </span>
              <span className={`whitespace-nowrap text-xs font-medium transition-colors group-hover:text-ink ${LABEL_BY_STATE[state]}`}>
                {step.label}
                {step.optional && <span className="ml-1 font-normal text-ink-3">· необязательно</span>}
              </span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
