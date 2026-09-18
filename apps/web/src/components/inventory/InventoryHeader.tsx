"use client";

/**
 * Шапка страницы инвентаризации (мокап `.page-head`): надстрочник «Склад»,
 * «Инвентаризация № N», строка «когда · охват · кто», справа — акт PDF / XLSX,
 * «Отменить» (с подтверждением) и статус.
 */

import { useState, type ReactNode } from "react";

import { StatusPill } from "../StatusPill";
import { toast } from "../ToastProvider";
import { actPdfUrl, actXlsxUrl, errorCode, explainInventoryError, inventoryApi } from "./api";
import { STATUS_LABEL, STATUS_VARIANT, stockCountSubline } from "./format";
import { InventoryDialog } from "./InventoryDialog";
import type { StockCountDetail } from "./types";
import { BTN_GHOST, FOCUS, LINK } from "./ui";

/** Каркас шапки — общий для страницы инвентаризации, старта и истории. */
export function PageHead({ title, sub, actions }: { title: string; sub: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-3">
      <div className="min-w-0">
        <p className="eyebrow">Склад</p>
        <h1 className="mt-0.5 font-cond text-xl font-bold leading-tight tracking-[-0.01em] text-ink sm:text-2xl">{title}</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-2">{sub}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

export function InventoryHeader({
  detail,
  extraAction,
  onCancelled,
  onStale,
}: {
  detail: StockCountDetail;
  /** Например «Продолжить счёт» на «Итоге». */
  extraAction?: ReactNode;
  onCancelled: (detail: StockCountDetail) => void;
  onStale: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOpen = detail.status === "OPEN";

  const cancel = async () => {
    setBusy(true);
    try {
      const { stockCount } = await inventoryApi.cancel(detail.id);
      setConfirmOpen(false);
      toast.success(`Инвентаризация № ${stockCount.number} отменена — в учёт ничего не записано`);
      onCancelled(stockCount);
    } catch (e) {
      setConfirmOpen(false);
      toast.error(explainInventoryError(e, "Не удалось отменить инвентаризацию"));
      if (errorCode(e) === "STOCK_COUNT_NOT_OPEN") onStale();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title={`Инвентаризация № ${detail.number}`}
        sub={stockCountSubline(detail)}
        actions={
          <>
            <a href={actPdfUrl(detail.id)} target="_blank" rel="noopener noreferrer" className={LINK}>
              Акт № {detail.number} (PDF)
            </a>
            <a href={actXlsxUrl(detail.id)} download className={LINK}>
              XLSX
            </a>
            {isOpen && (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className={`${BTN_GHOST} text-rose hover:border-rose-border hover:bg-rose-soft hover:text-rose`}
              >
                Отменить
              </button>
            )}
            {extraAction}
            <StatusPill variant={STATUS_VARIANT[detail.status]} label={STATUS_LABEL[detail.status]} />
          </>
        }
      />
      <InventoryDialog
        open={confirmOpen}
        eyebrow={`Инвентаризация № ${detail.number}`}
        title="Отменить инвентаризацию?"
        busy={busy}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmOpen(false)} disabled={busy} className={BTN_GHOST}>
              Не отменять
            </button>
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={busy}
              className={`inline-flex items-center rounded border border-rose bg-rose px-3 py-1 text-xs font-semibold leading-[1.6] text-surface hover:bg-rose/90 disabled:opacity-60 ${FOCUS}`}
            >
              {busy ? "Отменяю…" : "Отменить инвентаризацию"}
            </button>
          </>
        }
      >
        <p>
          Счёт и решения сохранятся в истории, но в учёт ничего не запишется: ни потеряшек, ни поправок, ни отметок
          «сверено». Продолжить отменённую нельзя — только начать новую.
        </p>
      </InventoryDialog>
    </>
  );
}
