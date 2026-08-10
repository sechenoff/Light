"use client";

import { pluralBookings } from "./bulkActions";

export type ArchiveBulkAction = "restore" | "purge";

/**
 * Липкая панель групповых действий для АРХИВА броней (/bookings/archive).
 *
 * Отдельный компонент, а не расширение BulkActionBar: у архива свой набор
 * действий (восстановить / удалить навсегда), без правил применимости —
 * каждая строка архива подходит под оба, а точечные отказы (например,
 * PURGE_HAS_FINANCE у брони со счетами) сервер возвращает побронно и они
 * попадают в отчёт. Вкручивать это в BulkActionBar значило бы тащить в
 * основной список чужие действия и наоборот.
 *
 * Позиционирование и слои — как у BulkActionBar: fixed внизу, z-30 (ниже
 * скрима мобильного меню на z-40), отступ под сайдбар lg:left-56 и правый
 * отступ под плавающую кнопку «Сообщить».
 */
export function ArchiveBulkActionBar({
  selectedCount,
  busyAction,
  maxBatch,
  disabled: externallyDisabled = false,
  onRun,
  onClear,
}: {
  selectedCount: number;
  busyAction: ArchiveBulkAction | null;
  /** Серверный потолок пачки — предупреждаем ДО нажатия, а не ловим 400 после. */
  maxBatch: number;
  /**
   * Внешняя блокировка: страница выполняет ОДИНОЧНОЕ действие (busyId) —
   * запуск пачки в этот момент увёз бы устаревшую выборку.
   */
  disabled?: boolean;
  onRun: (action: ArchiveBulkAction) => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) return null;

  const overLimit = selectedCount > maxBatch;
  const disabled = overLimit || busyAction !== null || externallyDisabled;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 lg:left-56 z-30 border-t border-border bg-surface shadow-lg"
      role="region"
      aria-label="Действия над выбранными архивными бронями"
    >
      <div className="flex flex-col gap-2 py-3 pl-4 pr-4 lg:flex-row lg:flex-wrap lg:items-center lg:pl-6 lg:pr-40">
        <span className="flex items-center gap-3 pr-32 lg:pr-0">
          <span className="text-sm font-semibold text-ink whitespace-nowrap">
            Выбрано: <span className="mono-num">{selectedCount}</span>{" "}
            <span className="font-normal text-ink-2">{pluralBookings(selectedCount)}</span>
          </span>

          <button
            type="button"
            onClick={onClear}
            disabled={busyAction !== null || externallyDisabled}
            className="whitespace-nowrap text-xs text-ink-2 underline decoration-dotted underline-offset-2 hover:text-accent disabled:opacity-40"
          >
            Снять выделение
          </button>

          {overLimit && (
            <span className="rounded border border-amber-border bg-amber-soft px-2 py-0.5 text-xs text-amber">
              не больше {maxBatch}
            </span>
          )}
        </span>

        <span className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 pr-32 lg:mx-0 lg:ml-auto lg:flex-wrap lg:overflow-visible lg:px-0 lg:pr-0">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRun("restore")}
            className="shrink-0 whitespace-nowrap rounded border border-emerald-border px-3 py-1.5 text-xs font-medium text-emerald transition-colors hover:bg-emerald-soft disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busyAction === "restore" ? "Восстанавливаю…" : "↺ Восстановить"}
            <span className="ml-1.5 mono-num opacity-70">{selectedCount}</span>
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRun("purge")}
            className="shrink-0 whitespace-nowrap rounded border border-rose-border px-3 py-1.5 text-xs font-medium text-rose transition-colors hover:bg-rose-soft disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busyAction === "purge" ? "Удаляю…" : "Удалить навсегда"}
            <span className="ml-1.5 mono-num opacity-70">{selectedCount}</span>
          </button>
        </span>
      </div>
    </div>
  );
}
