"use client";

import { useEffect, useRef, useState } from "react";
import { pluralize } from "../../../lib/format";

// Модалка «Заявка от гафера» (AI-разбор списка). Паттерн — AddCustomItemModal:
// Esc / крестик / клик по фону закрывают. Текст при закрытии НЕ теряется —
// gafferText живёт в BookingForm и автосейвится в черновик, повторное открытие
// показывает его снова. Открывается кнопкой «Заявка от гафера» или автоматически
// при пасте многострочного текста в поиск.
//
// Вторая зона — заявка файлом: гаффер часто присылает PDF из своей программы
// или фото листка. Файл уходит в BookingForm (onImportFile), тот грузит его
// на /api/bookings/parse-gaffer-document и подставляет проект, клиента, даты.

/** Что принимаем: зеркало GAFFER_DOCUMENT_MIME_TYPES на сервере. */
export const AI_REQUEST_FILE_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

type Props = {
  open: boolean;
  text: string;
  onTextChange: (v: string) => void;
  onParse: () => void;
  onClose: () => void;
  parsing: boolean;
  /** Импорт заявки файлом (PDF/фото). */
  onImportFile: (file: File) => void;
  importing: boolean;
};

export function AiRequestModal({ open, text, onTextChange, onParse, onClose, parsing, onImportFile, importing }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const busy = parsing || importing;

  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 50);
  }, [open]);

  // Esc-close (во время распознавания не закрываем, чтобы не потерять контекст)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const lines = text.split("\n").filter((s) => s.trim().length > 0).length;

  const pickFile = (file: File | undefined) => {
    if (!file || busy) return;
    onImportFile(file);
    // Сбрасываем input, чтобы тот же файл можно было выбрать повторно после ошибки.
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={() => { if (!busy) onClose(); }}
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
            disabled={busy}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-subtle text-[13px] text-ink-2 hover:bg-surface-muted hover:text-ink disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          rows={8}
          disabled={busy}
          placeholder={"По строке на позицию:\nшторка на 700\n2 нова\nудочка + грипы"}
          className="min-h-[160px] w-full resize-y rounded-md border border-accent-border bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-bright focus:shadow-[0_0_0_3px_theme(colors.accent.soft)] disabled:bg-surface-muted disabled:text-ink-3"
        />

        <p className="mb-3 mt-2 text-xs text-ink-3">
          AI сопоставит каждую строку с каталогом, спорные совпадения — подтвердите вручную.
          Текст не потеряется при закрытии окна.
        </p>

        <div className="my-3 flex items-center gap-3 text-[11px] uppercase tracking-wide text-ink-3">
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
          или
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
        </div>

        <label
          onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
          className={[
            "mb-4 flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-4 py-4 text-center transition-colors",
            importing
              ? "border-accent-border bg-accent-soft text-accent-bright"
              : dragOver
                ? "border-accent-bright bg-accent-soft"
                : "border-border bg-surface-subtle hover:border-accent-border hover:bg-accent-soft",
            busy && !importing ? "cursor-not-allowed opacity-50" : "",
          ].join(" ")}
        >
          <input
            ref={fileRef}
            type="file"
            accept={AI_REQUEST_FILE_ACCEPT}
            className="sr-only"
            disabled={busy}
            aria-label="Загрузить заявку файлом"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          {importing ? (
            <span className="text-[13px] font-medium">Читаю документ… обычно 10–20 секунд</span>
          ) : (
            <>
              <span className="text-[13px] font-medium text-ink">📄 Загрузить заявку файлом — PDF или фото</span>
              <span className="text-xs text-ink-3">
                Прочитаем список приборов, проект и контакты гаффера; даты подставятся, если они есть в документе
              </span>
            </>
          )}
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-muted disabled:opacity-40"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onParse}
            disabled={busy || lines === 0}
            className="rounded bg-accent-bright px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
