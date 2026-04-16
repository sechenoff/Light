"use client";

import type { ParseResultCounts } from "./types";

type PasteZoneProps = {
  text: string;
  onTextChange: (v: string) => void;
  onParse: () => void;
  onClear: () => void;
  isParsing: boolean;
  error: string | null;
  resultCounts: ParseResultCounts | null;
};

export function PasteZone({
  text,
  onTextChange,
  onParse,
  onClear,
  isParsing,
  error,
  resultCounts,
}: PasteZoneProps) {
  return (
    <div className="mx-5 my-4">
      <div className="border border-dashed border-border-strong rounded bg-surface-muted p-3.5 transition-colors focus-within:border-accent-bright focus-within:bg-accent-soft/30">
        <div className="flex justify-between items-center text-[11.5px] text-ink-2 mb-1.5">
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-4 rounded-sm bg-ink text-white text-[10px] font-bold font-mono flex items-center justify-center">
              AI
            </span>
            Вставьте текст от гаффера или напечатайте список
          </span>
          <kbd className="font-mono text-[10.5px] px-1.5 py-px bg-surface border border-border rounded-sm text-ink-2">
            ⌘ V
          </kbd>
        </div>

        <textarea
          className="w-full border-none bg-transparent outline-none resize-none font-mono text-xs leading-relaxed text-ink min-h-[66px] p-0"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          maxLength={10000}
          placeholder="Например: 2 штуки 52xt, 3 nova p300, 4 c-stand, 1 чайнабол, 2 рамы 6x6, hazer hz350"
        />

        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs font-medium bg-ink text-white hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!text.trim() || isParsing}
            onClick={onParse}
          >
            {isParsing ? "Распознаю..." : "Распознать позиции"}
          </button>
          {text.trim() && (
            <button
              type="button"
              className="rounded px-2.5 py-1.5 text-xs text-ink-2 border border-border-strong bg-surface hover:bg-surface-muted transition-colors"
              onClick={onClear}
            >
              Очистить
            </button>
          )}
          {resultCounts && (
            <span className="ml-auto text-[11.5px] text-ink-2 flex items-center gap-2.5">
              Распознано:
              <b className="text-emerald font-medium">{resultCounts.resolved} точно</b>
              {resultCounts.needsReview > 0 && (
                <>
                  <span>·</span>
                  <b className="text-amber font-medium">{resultCounts.needsReview} уточнить</b>
                </>
              )}
              {resultCounts.unmatched > 0 && (
                <>
                  <span>·</span>
                  <b className="text-rose font-medium">{resultCounts.unmatched} не найдено</b>
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-2 rounded border border-rose-border bg-rose-soft px-3 py-2 text-sm text-rose">
          {error}
        </div>
      )}
    </div>
  );
}
