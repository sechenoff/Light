"use client";

/**
 * Модалка закрытия ремонта с расходом.
 *
 * Здесь чинится баг с деньгами: галочка «Оценка работы» меняла показанную
 * сумму, но наружу всё равно уходила оценка целиком — человек подтверждал одно
 * число, а в финансы попадало другое. Теперь наружу отдаётся ровно та часть,
 * которая учтена в «Итого»; показанное и записанное — одно и то же число.
 */

import { useState } from "react";

import { BTN_MINI, BTN_PRIMARY } from "./cardChrome";
import { formatRub } from "../../lib/format";
import type { RepairListItem } from "./types";

/**
 * Ставка оценки работ по ремонту, ₽/ч. Внутренняя цифра прокатной, а не
 * рыночный прайс: по ней предлагается сумма расхода, и оператор правит её
 * руками. Держим именованной константой, чтобы правка ставки не искала
 * magic-number в JSX.
 * FUTURE: перенести в настройки организации (/settings/organization).
 */
export const REPAIR_HOURLY_RATE = 2000;

/** «4.5» → «4,5»: точка в дробях читается как обрыв предложения. */
function ru(n: number): string {
  return String(n).replace(".", ",");
}

export function RepairCloseModal({
  repair,
  onConfirm,
  onSkip,
  onCancel,
}: {
  repair: RepairListItem;
  /** Отдаём ТОЛЬКО ту часть оценки работ, которая посчитана в «Итого». */
  onConfirm: (workValuation: number) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const hours = parseFloat(repair.totalTimeHours) || 0;
  const parts = parseFloat(repair.partsCost) || 0;
  const defaultValuation = Math.round(hours * REPAIR_HOURLY_RATE);
  const [workVal, setWorkVal] = useState(String(defaultValuation));
  const [includeWork, setIncludeWork] = useState(defaultValuation > 0);

  const workPart = includeWork ? parseFloat(workVal) || 0 : 0;
  const totalExpense = parts + workPart;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Закрыть ремонт"
        className="w-full max-w-md space-y-4 rounded-lg border border-border-strong bg-surface p-5 shadow-lg"
      >
        <h3 className="font-cond text-[17px] font-bold text-ink">Закрыть ремонт</h3>
        <p className="text-sm text-ink-2">
          Единица вернётся в парк. Создать расход «Ремонт» на{" "}
          <span className="mono-num font-semibold text-ink">{formatRub(totalExpense)}</span>?
        </p>

        <div className="space-y-1.5 rounded border border-border bg-surface-muted px-3 py-2 text-xs text-ink-2">
          <div className="flex justify-between">
            <span>Запчасти по журналу</span>
            <span className="mono-num text-ink">{formatRub(parts)}</span>
          </div>
          {hours > 0 && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="include-work"
                checked={includeWork}
                onChange={(e) => setIncludeWork(e.target.checked)}
                className="rounded border-border"
              />
              <label htmlFor="include-work" className="flex-1">
                Оценка работы
                <span className="ml-1 text-ink-3">
                  ({ru(hours)} ч × {REPAIR_HOURLY_RATE} ₽/ч)
                </span>
              </label>
              <input
                type="number"
                min="0"
                value={workVal}
                onChange={(e) => setWorkVal(e.target.value)}
                disabled={!includeWork}
                aria-label="Оценка работы, ₽"
                className="w-24 rounded border border-border bg-surface px-2 py-1 text-right text-xs text-ink disabled:opacity-50"
              />
            </div>
          )}
          <div className="flex justify-between border-t border-border pt-1.5 font-semibold text-ink">
            <span>Итого в расход</span>
            <span className="mono-num">{formatRub(totalExpense)}</span>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} className={BTN_MINI}>
            Отмена
          </button>
          <button type="button" onClick={onSkip} className={BTN_MINI}>
            Закрыть без расхода
          </button>
          <button
            type="button"
            disabled={totalExpense <= 0}
            onClick={() => onConfirm(workPart)}
            className={BTN_PRIMARY}
          >
            Создать расход и закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
