"use client";

/**
 * Каркас модалок раздела: подтверждение отмены / завершения и причина
 * «Ошибки учёта». Оверлей-канон проекта (как ResolveProblemModal):
 *  - Esc и клик по подложке закрывают (кроме момента отправки);
 *  - фокус-ловушка Tab / Shift+Tab внутри диалога;
 *  - фокус возвращается на кнопку-триггер, прокрутка страницы заблокирована.
 */

import { useEffect, useRef, type ReactNode } from "react";

export function InventoryDialog({
  open,
  eyebrow,
  title,
  busy = false,
  onClose,
  children,
  footer,
  initialFocusRef,
}: {
  open: boolean;
  eyebrow: string;
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  /** Куда поставить фокус при открытии; по умолчанию — первый фокусируемый. */
  initialFocusRef?: React.RefObject<HTMLElement>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = setTimeout(() => {
      const target =
        initialFocusRef?.current ??
        dialogRef.current?.querySelector<HTMLElement>("textarea, input, select, button");
      target?.focus();
    }, 30);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = prevOverflow;
      prevFocused?.focus?.();
    };
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={() => !busy && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-sm"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="mt-1 font-cond text-lg font-bold leading-tight text-ink">{title}</h2>
        <div className="mt-2 text-[13px] leading-relaxed text-ink-2">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}
