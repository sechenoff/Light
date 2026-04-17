"use client";

type Props = {
  value: string;
  onValueChange: (v: string) => void;
  onParse: () => void;
  onClear?: () => void;
  parsing: boolean;
  parsed?: boolean;
};

const AI_TRIGGER_THRESHOLD = 40;

function shouldShowParseButton(v: string): boolean {
  return v.includes("\n") || v.length > AI_TRIGGER_THRESHOLD;
}

export function SmartInput({ value, onValueChange, onParse, onClear, parsing, parsed = false }: Props) {
  const showParse = shouldShowParseButton(value) && !parsed;
  const isMulti = value.includes("\n") && !parsed;

  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder="Поиск оборудования или вставьте список от гафера..."
        rows={isMulti ? 3 : 1}
        disabled={parsed}
        className={`w-full resize-y rounded border px-3 py-2 pr-32 text-[13px] outline-none transition-colors ${
          parsed
            ? "border-border bg-surface-muted text-ink-3"
            : "border-border bg-surface focus:border-accent-bright focus:shadow-[0_0_0_3px_theme(colors.accent.soft)]"
        } min-h-[40px]`}
      />

      <div className="absolute right-2 top-2 flex items-center gap-1.5">
        {parsed ? (
          <button
            type="button"
            onClick={() => onClear && onClear()}
            className="rounded border border-border bg-surface px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-muted"
          >
            Очистить
          </button>
        ) : showParse ? (
          <button
            type="button"
            onClick={onParse}
            disabled={parsing}
            className="rounded bg-accent-bright px-3 py-1 text-[12px] font-semibold text-white hover:bg-accent disabled:opacity-60"
          >
            {parsing ? "Распознаю..." : "Распознать"}
          </button>
        ) : (
          <div className="pointer-events-none flex items-center gap-1 rounded bg-surface-subtle px-2 py-1 text-[11px] text-ink-3">
            <span>AI</span>
          </div>
        )}
      </div>
    </div>
  );
}
