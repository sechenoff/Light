"use client";

import { useEffect, useRef } from "react";
import { pluralize } from "../../../lib/format";

// AI-зона заявки от гафера (редизайн блока «Оборудование»). Замена SmartInput:
// поиск и AI-паста разведены на две явные аффордансы — поиск остаётся обычным
// input, а сюда попадают из кнопки «Заявка от гафера» или автоматически при
// пасте многострочного текста в поиск (магия сохранена, стала дискаверабельной).

type Props = {
  open: boolean;
  text: string;
  onTextChange: (v: string) => void;
  onParse: () => void;
  onCancel: () => void;
  parsing: boolean;
};

export function AiRequestZone({ open, text, onTextChange, onParse, onCancel, parsing }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) taRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const lines = text.split("\n").filter((s) => s.trim().length > 0).length;

  return (
    <div className="mt-2">
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={4}
        placeholder={"Вставьте список от гафера — по строке на позицию:\nшторка на 700\n2 нова\nудочка + грипы"}
        className="min-h-[96px] w-full resize-y rounded-md border border-accent-border bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-bright focus:shadow-[0_0_0_3px_theme(colors.accent.soft)]"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11.5px] text-ink-3">
          AI сопоставит каждую строку с каталогом, спорные — подтвердите вручную.
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-surface-muted"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onParse}
            disabled={parsing || lines === 0}
            className="rounded bg-accent-bright px-4 py-1.5 text-[12.5px] font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
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
