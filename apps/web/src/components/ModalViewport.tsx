"use client";

import type { HTMLAttributes } from "react";
import { useDialog } from "../hooks/useDialog";

/** Общая поверхность модалок: доступная прокрутка на коротком экране,
 * блокировка фона в Safari, фокус внутри окна и возврат к кнопке открытия. */
export function ModalViewport({ className = "", children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useDialog(true);
  return (
    <div {...props} ref={ref} tabIndex={-1} className={`modal-viewport overflow-y-auto overscroll-contain ${className}`}>
      {children}
    </div>
  );
}
