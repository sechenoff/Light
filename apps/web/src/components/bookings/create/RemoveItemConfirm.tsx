"use client";

import { useEffect, useRef } from "react";

/**
 * Подтверждение удаления позиции из состава.
 *
 * Нужно ровно для одного жеста: «−» на количестве 1. Раньше он молча убирал
 * строку, и промах пальцем стоил дорого — в смете на сорок позиций потом не
 * вспомнить, что именно пропало. Крестик справа остаётся быстрым путём и
 * подтверждения не спрашивает: его нажимают намеренно.
 */
type Props = {
  /** Название позиции; null — окно закрыто. */
  itemName: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function RemoveItemConfirm({ itemName, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!itemName) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    // Фокус на подтверждении: жест начали с клавиатуры — им же и заканчивают.
    const t = setTimeout(() => confirmRef.current?.focus(), 30);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [itemName, onCancel]);

  if (!itemName) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-item-title"
    >
      <div
        className="w-full max-w-[380px] rounded-lg border border-border bg-surface p-5 shadow-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="remove-item-title" className="text-[15px] font-semibold text-ink">
          Убрать позицию из сметы?
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          Количество уже минимальное, поэтому «−» уберёт позицию целиком:
          <br />
          <span className="font-medium text-ink">{itemName}</span>
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border bg-surface px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-muted hover:text-ink"
          >
            Отмена
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded border border-rose-border bg-rose-soft px-3 py-1.5 text-[13px] font-medium text-rose hover:bg-rose hover:text-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose"
          >
            Убрать позицию
          </button>
        </div>
      </div>
    </div>
  );
}
