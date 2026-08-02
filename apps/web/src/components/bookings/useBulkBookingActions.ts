"use client";

import { useState } from "react";

import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import type { BulkFailure } from "./BulkResultModal";
import {
  BULK_ACTION_ORDER,
  bulkActionMeta,
  eligibleIds,
  pluralBookings,
  type BulkAction,
  type BulkActionContext,
  type BulkBookingRow,
} from "./bulkActions";

type BulkApiResult = {
  results: Array<{ id: string; ok: boolean; status?: string; code?: string; message?: string }>;
  counts: { total: number; ok: number; failed: number };
};

/**
 * Оркестрация групповых действий на /bookings: от клика по кнопке панели до
 * применения результата к уже отрисованному списку.
 *
 * Живёт отдельно от страницы, потому что список броней и без того велик, а
 * логика здесь самостоятельная: применимость (bulkActions.ts), запрос,
 * разбор побронного ответа и синхронизация видимых строк.
 */
export function useBulkBookingActions<T extends BulkBookingRow>(args: {
  rows: T[];
  selected: ReadonlySet<string>;
  ctx: BulkActionContext;
  /** Активный серверный фильтр по статусу ("" — фильтра нет). */
  statusFilter: string;
  /** Человеческая подпись брони для отчёта об ошибках. */
  rowTitle: (row: T) => string;
  /** Убрать строки, выпавшие из текущей выдачи. */
  removeRows: (ids: Set<string>) => void;
  /** Обновить статус оставшейся строки без перезагрузки списка. */
  applyStatus: (id: string, status: string) => void;
  /** Снять с выбора успешно обработанные. */
  deselect: (ids: string[]) => void;
  /** Перечитать счётчики пресет-чипов. */
  refreshCounts: () => void;
  /** Вызывается, если действие убрало из выдачи ВСЕ загруженные строки. */
  onRowsEmptied: () => void;
}) {
  const { rows, selected, ctx, statusFilter, rowTitle, removeRows, applyStatus, deselect, refreshCounts, onRowsEmptied } =
    args;

  // Держим сам список id, а не только действие: между подтверждением и
  // запуском набор строк может измениться (дозагрузка, фоновое обновление),
  // а подтверждали конкретную выборку.
  const [confirm, setConfirm] = useState<null | { action: BulkAction; ids: string[] }>(null);
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [report, setReport] = useState<null | {
    actionLabel: string;
    okCount: number;
    failures: BulkFailure[];
  }>(null);

  const eligibleCounts = BULK_ACTION_ORDER.reduce(
    (acc, action) => {
      acc[action] = eligibleIds(rows, selected, action, ctx).length;
      return acc;
    },
    {} as Record<BulkAction, number>,
  );

  function request(action: BulkAction) {
    const ids = eligibleIds(rows, selected, action, ctx);
    if (ids.length === 0) {
      toast.error(
        `«${bulkActionMeta(action, ctx).label}»: среди выбранных нет подходящих броней`,
      );
      return;
    }
    setConfirm({ action, ids });
  }

  async function run() {
    if (!confirm) return;
    const { action, ids } = confirm;
    const meta = bulkActionMeta(action, ctx);
    setBusy(action);
    try {
      const data = await apiFetch<BulkApiResult>("/api/bookings/bulk", {
        method: "POST",
        body: JSON.stringify({ action, ids }),
      });

      const succeeded = data.results.filter((r) => r.ok);
      const failed = data.results.filter((r) => !r.ok);

      // Строки, выпавшие из текущей выдачи, убираем: архивные — всегда,
      // остальные — если активен фильтр по статусу и новый статус ему больше
      // не соответствует. Иначе бронь висела бы в списке, которому уже не
      // принадлежит.
      const removedIds = new Set(
        succeeded
          .filter((r) => action === "archive" || (statusFilter !== "" && r.status !== statusFilter))
          .map((r) => r.id),
      );
      if (removedIds.size > 0) {
        removeRows(removedIds);
        // Вычистили всю загруженную страницу — просим страницу догрузить
        // следующую, иначе список выглядит пустым при живом курсоре.
        if (removedIds.size >= rows.length) onRowsEmptied();
      }
      for (const r of succeeded) {
        if (!removedIds.has(r.id) && r.status) applyStatus(r.id, r.status);
      }

      // Успешные снимаем с выбора, неуспешные оставляем — оператор видит, с
      // чем остался разбираться, и может повторить действие по ним.
      deselect(succeeded.map((r) => r.id));
      refreshCounts();

      if (failed.length === 0) {
        toast.success(`${meta.label}: готово — ${succeeded.length} ${pluralBookings(succeeded.length)}`);
      } else {
        const titleById = new Map(rows.map((row) => [row.id, rowTitle(row)]));
        setReport({
          actionLabel: meta.label,
          okCount: succeeded.length,
          failures: failed.map((f) => ({
            id: f.id,
            code: f.code ?? "BULK_ITEM_FAILED",
            message: f.message ?? "Не удалось выполнить",
            title: titleById.get(f.id) ?? "Бронь",
          })),
        });
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось выполнить групповое действие");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  return {
    eligibleCounts,
    confirm,
    busy,
    report,
    request,
    run,
    closeConfirm: () => setConfirm(null),
    closeReport: () => setReport(null),
  };
}
