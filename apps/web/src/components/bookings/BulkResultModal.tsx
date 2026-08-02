"use client";

import { useEffect, useRef } from "react";

import { pluralBookings } from "./bulkActions";

export type BulkFailure = {
  id: string;
  code: string;
  message: string;
  /** Человеческая подпись брони (дата · клиент · проект) — id оператору не нужен. */
  title: string;
};

/**
 * Отчёт о групповом действии. Показывается ТОЛЬКО когда часть броней не
 * прошла: полный успех — это тост, а не модалка с «ОК».
 *
 * Сервер обрабатывает каждую бронь изолированно, поэтому частичный успех —
 * штатный исход (бронь успели согласовать в другой вкладке, оборудование
 * заняла соседняя бронь, по брони есть оплата). Оператору нужно понять, что
 * именно не прошло и почему, поэтому перечисляем брони с причинами.
 */
export function BulkResultModal({
  open,
  actionLabel,
  okCount,
  failures,
  onClose,
}: {
  open: boolean;
  actionLabel: string;
  okCount: number;
  failures: BulkFailure[];
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Фокус на «Понятно»: модалка открывается после длинной операции, и
    // клавиатурный пользователь иначе остался бы фокусом на кнопке панели.
    const t = setTimeout(() => closeRef.current?.focus(), 50);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Результат: ${actionLabel}`}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="eyebrow mb-2">{actionLabel}</div>
        {/* Заголовок зависит от того, прошло ли хоть что-то: «частично» при
            нулевом успехе противоречило бы цифре ниже и намекало, что часть
            броней всё-таки изменена. */}
        <h2 className="mb-1 text-lg font-semibold text-ink">
          {okCount === 0 ? "Ничего не выполнено" : "Выполнено частично"}
        </h2>
        <p className="mb-4 text-sm text-ink-2">
          {okCount > 0 && (
            <>
              Успешно: <span className="mono-num text-emerald">{okCount}</span>{" "}
              {pluralBookings(okCount)}.{" "}
            </>
          )}
          Не удалось: <span className="mono-num text-rose">{failures.length}</span>{" "}
          {pluralBookings(failures.length)}.
        </p>

        <ul className="mb-5 max-h-64 space-y-2 overflow-auto">
          {failures.map((f) => (
            <li
              key={f.id}
              className="rounded border border-rose-border bg-rose-soft px-3 py-2 text-sm"
            >
              <div className="font-medium text-ink">{f.title}</div>
              <div className="mt-0.5 text-xs text-rose">{f.message}</div>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded bg-accent-bright px-4 py-2 text-sm font-medium text-surface hover:bg-accent"
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}
