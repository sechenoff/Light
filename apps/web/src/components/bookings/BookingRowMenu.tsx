"use client";

/**
 * BookingRowMenu — overflow-меню «⋯» второстепенных/деструктивных действий
 * строки списка броней (Изменить / Отменить / В архив). Раньше эти кнопки
 * висели прямо в строке — деструктивная «Отменить» и корзина-архив были
 * постоянно на виду и на мобильном становились удобной целью для мис-тапа.
 * Теперь они убраны под явный жест, а на виду остаётся только главное
 * действие строки.
 *
 * Anchored через @floating-ui/react (портал — не клипается overflow-таблицей),
 * click-outside + Esc закрывают. Клик по триггеру и пунктам не всплывает —
 * чтобы не активировать переход по клику на строку.
 */

import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingFocusManager,
  FloatingPortal,
} from "@floating-ui/react";
import { useState } from "react";

export type BookingRowMenuItem = {
  key: string;
  label: string;
  onSelect: () => void;
  /** Деструктивный пункт — красится в rose и отделяется разделителем сверху. */
  danger?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
};

export function BookingRowMenu({ items, ariaLabel = "Ещё действия" }: { items: BookingRowMenuItem[]; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "bottom-end",
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "menu" });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps({
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
        })}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-surface-muted hover:text-ink transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              onClick={(e) => e.stopPropagation()}
              className="z-50 min-w-[180px] overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    item.danger
                      ? "border-t border-dashed border-border text-rose hover:bg-rose-soft"
                      : "text-ink hover:bg-surface-muted"
                  }`}
                >
                  {item.icon && <span className="shrink-0">{item.icon}</span>}
                  {item.label}
                </button>
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
