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
  // На телефоне четыре шага не помещаются в строку: сетка 4 колонки, подпись
  // под кружком (в две строки при нужде). С md — прежняя строка с разделителями.
  return (
    <nav
      aria-label="Шаги оформления брони"
      className="grid grid-cols-4 items-start gap-0.5 px-2.5 py-2 md:flex md:items-center md:gap-1 md:overflow-x-auto lg:px-[18px]"
    >
      {steps.map((step, i) => {
        const state: StepState = step.state;
        return (
          <div key={step.id} className="flex min-w-0 shrink-0 items-center gap-1">
            {i > 0 && <span aria-hidden="true" className="hidden h-px w-4 bg-border md:block md:w-6" />}
            <button
              type="button"
              onClick={() => onStepClick(step.id)}
              aria-label={`Шаг ${i + 1}: ${step.label}${
                state === "complete" ? " — готово" : state === "error" ? " — есть ошибка" : ""
              }`}
              className="group flex min-h-[40px] w-full flex-col items-center gap-0.5 rounded px-0.5 py-1 text-center transition-colors hover:bg-surface-muted md:min-h-0 md:w-auto md:flex-row md:gap-1.5 md:px-1.5 md:text-left"
            >
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold transition-colors ${CIRCLE_BY_STATE[state]}`}
              >
                {state === "complete" ? "✓" : state === "error" ? "!" : i + 1}
              </span>
              <span className={`text-[11px] font-medium leading-tight transition-colors group-hover:text-ink md:whitespace-nowrap md:text-xs ${LABEL_BY_STATE[state]}`}>
                {step.label}
                {step.optional && <span className="ml-1 hidden font-normal text-ink-3 md:inline">· необязательно</span>}
              </span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
