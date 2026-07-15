"use client";

import { useEffect, useRef } from "react";
import { pluralize } from "../../../lib/format";

// Модалка «Заявка от гафера» (AI-разбор списка). Паттерн — AddCustomItemModal:
// Esc / крестик / клик по фону закрывают. Текст при закрытии НЕ теряется —
// gafferText живёт в BookingForm и автосейвится в черновик, повторное открытие
// показывает его снова. Открывается кнопкой «Заявка от гафера» или автоматически
// при пасте многострочного текста в поиск.

type Props = {
  open: boolean;
  text: string;
  onTextChange: (v: string) => void;
  onParse: () => void;
  onClose: () => void;
  parsing: boolean;
};

export function AiRequestModal({ open, text, onTextChange, onParse, onClose, parsing }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 50);
  }, [open]);

  // Esc-close (во время распознавания не закрываем, чтобы не потерять контекст)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !parsing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, parsing, onClose]);

  if (!open) return null;

  const lines = text.split("\n").filter((s) => s.trim().length > 0).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4"
      onClick={() => { if (!parsing) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-request-title"
    >
      <div
        className="w-full max-w-lg rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow mb-1">Заявка от гафера · AI</div>
            <h2 id="ai-request-title" className="text-lg font-semibold text-ink">
              Вставьте список — AI разберёт по позициям
            </h2>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={parsing}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-deep text-[13px] text-ink-2 hover:bg-surface-muted hover:text-ink disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          rows={8}
          disabled={parsing}
          placeholder={"По строке на позицию:\nшторка на 700\n2 нова\nудочка + грипы"}
          className="min-h-[160px] w-full resize-y rounded-md border border-accent-border bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-bright focus:shadow-[0_0_0_3px_theme(colors.accent.soft)] disabled:bg-surface-muted disabled:text-ink-3"
        />

        <p className="mb-4 mt-2 text-xs text-ink-3">
          AI сопоставит каждую строку с каталогом, спорные совпадения — подтвердите вручную.
          Текст не потеряется при закрытии окна.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={parsing}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-40"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onParse}
            disabled={parsing || lines === 0}
            className="rounded bg-accent-bright px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {parsing
              ? "Распознаю..."
              : lines > 0
                ? `Распознать ${lines} ${pluralize(lines, "строку", "строки", "строк")}`
                : "Распознать"}
          </button>
        </div>
      </div>
    </div>
  );
}
