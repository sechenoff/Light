"use client";

import {
  BULK_ACTION_ORDER,
  bulkActionMeta,
  isActionVisible,
  pluralBookings,
  type BulkAction,
  type BulkActionContext,
} from "./bulkActions";

/**
 * Липкая панель групповых действий: появляется, когда в списке броней
 * выбрана хотя бы одна строка.
 *
 * Кнопка каждого действия показывает, к скольким из выбранных броней оно
 * реально применимо («Согласовать · 3 из 7»). Это честнее, чем прятать
 * кнопку или молча пропускать неподходящие: оператор видит, что часть
 * выбора под действие не попадёт, ДО подтверждения.
 *
 * Позиционирование: fixed внизу с отступом на десктопный сайдбар (w-56 =
 * lg:left-56, как lg:pl-56 у основного контейнера AppShell).
 */
export function BulkActionBar({
  selectedCount,
  eligibleCounts,
  ctx,
  busyAction,
  maxBatch,
  onRun,
  onClear,
}: {
  selectedCount: number;
  /** Сколько выбранных броней подходит под каждое действие. */
  eligibleCounts: Record<BulkAction, number>;
  ctx: BulkActionContext;
  /** Действие, которое сейчас выполняется (кнопки блокируются). */
  busyAction: BulkAction | null;
  /** Серверный потолок пачки — предупреждаем ДО нажатия, а не ловим 400 после. */
  maxBatch: number;
  onRun: (action: BulkAction) => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) return null;

  const actions = BULK_ACTION_ORDER.filter((a) => isActionVisible(a, ctx));
  const overLimit = selectedCount > maxBatch;

  return (
    // z-30, НЕ z-40: на z-40 живёт затемнение мобильного меню (AppShell), и
    // панель — как более поздний элемент в DOM — торчала бы поверх скрима,
    // оставляя деструктивные кнопки кликабельными при открытом меню. От
    // плавающей кнопки «Сообщить» панель разведена отступом, а не слоем.
    <div
      className="fixed bottom-0 left-0 right-0 lg:left-56 z-30 border-t border-border bg-surface shadow-lg"
      role="region"
      aria-label="Действия над выбранными бронями"
    >
      {/* Правый отступ резервирует место под плавающую кнопку «Сообщить»
          (~148 px вместе с её полем): она живёт в том же нижнем углу, и без
          отступа последняя кнопка панели уезжает под неё.
          На мобильном — две компактные строки (счётчик, затем лента кнопок
          с горизонтальным скроллом): перенос кнопок в столбик съедал пол-
          экрана и прятал сам список. */}
      <div className="flex flex-col gap-2 py-3 pl-4 pr-4 lg:flex-row lg:flex-wrap lg:items-center lg:pl-6 lg:pr-40">
        <span className="flex items-center gap-3 pr-32 lg:pr-0">
          <span className="text-sm font-semibold text-ink whitespace-nowrap">
            Выбрано: <span className="mono-num">{selectedCount}</span>{" "}
            <span className="font-normal text-ink-2">{pluralBookings(selectedCount)}</span>
          </span>

          <button
            type="button"
            onClick={onClear}
            disabled={busyAction !== null}
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
          {actions.map((action) => {
            const meta = bulkActionMeta(action, ctx);
            const n = eligibleCounts[action] ?? 0;
            const tooMany = n > maxBatch;
            // Кнопка без подходящих броней остаётся АКТИВНОЙ: title на
            // disabled-элементе браузеры не показывают, а на тач-устройствах
            // его нет вовсе. Клик отвечает тостом с причиной — это доходит.
            const disabled = tooMany || busyAction !== null;
            const partial = n > 0 && n < selectedCount;
            return (
              <button
                key={action}
                type="button"
                disabled={disabled}
                onClick={() => onRun(action)}
                title={
                  n === 0
                    ? "Ни одна из выбранных броней не подходит под это действие"
                    : tooMany
                      ? `Подходит ${n} броней — это больше лимита ${maxBatch} за раз`
                      : partial
                        ? `Подходит ${n} из ${selectedCount} выбранных`
                        : undefined
                }
                className={`shrink-0 whitespace-nowrap rounded border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  n === 0
                    ? // Подходящих броней нет — кнопка приглушена, но кликабельна:
                      // в ответ приходит тост с объяснением, а не тишина.
                      "border-border text-ink-3 hover:bg-surface-subtle"
                    : meta.danger
                      ? "border-rose-border text-rose hover:bg-rose-soft"
                      : "border-accent-border text-accent-bright hover:bg-accent-soft"
                }`}
              >
                {busyAction === action ? "Выполняю…" : meta.label}
                {n > 0 && (
                  <span className="ml-1.5 mono-num opacity-70">
                    {partial ? `${n} из ${selectedCount}` : n}
                  </span>
                )}
              </button>
            );
          })}
        </span>
      </div>
    </div>
  );
}
