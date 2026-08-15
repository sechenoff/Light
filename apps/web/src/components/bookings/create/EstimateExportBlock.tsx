"use client";

import { useState } from "react";

import { downloadEstimate, fullEstimatePath, printEstimate } from "../../../lib/estimateExport";

/**
 * Печать и выгрузка сметы прямо из панели «Расчёт» на форме правки.
 *
 * Печатается СОХРАНЁННАЯ смета, а не то, что сейчас в форме. Причина не в
 * удобстве, а в правильности: серверный документ собирается из снапшота и
 * включает транспорт, доборы и реквизиты организации, тогда как расчёт «с
 * экрана» (POST /quote/export) транспорт молча теряет — на брони с двумя
 * машинами это разница в десятки тысяч при валидном на вид PDF.
 *
 * Поэтому при несохранённых правках честно предупреждаем, а не печатаем
 * устаревшее молча.
 */
type Props = {
  bookingId: string;
  /** В форме есть правки, которых нет в сохранённой смете. */
  hasUnsavedChanges: boolean;
};

function IconPrinter() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M6 14h12v8H6z" />
    </svg>
  );
}

function IconFileText() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8" />
    </svg>
  );
}

function IconTable() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </svg>
  );
}

const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded px-2.5 py-2 text-[12.5px] transition-colors disabled:cursor-default disabled:opacity-50";

export function EstimateExportBlock({ bookingId, hasUnsavedChanges }: Props) {
  // Один ключ занятости на весь блок: экспорт быстрый, и параллельные клики по
  // соседним кнопкам — это скорее дубль, чем намерение.
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="eyebrow">Смета</p>

      {hasUnsavedChanges && (
        <p className="rounded border border-amber-border bg-amber-soft px-2 py-1.5 text-[11.5px] leading-snug text-ink-2">
          Есть несохранённые правки — в файл попадёт последнее сохранённое состояние.
          Сохраните изменения, чтобы они попали в смету.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => run("print", () => printEstimate(fullEstimatePath(bookingId, "pdf")))}
          className={`${BTN} bg-accent-bright text-surface hover:bg-accent`}
        >
          <IconPrinter />
          Печать
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run("pdf", () =>
              downloadEstimate(fullEstimatePath(bookingId, "pdf"), `smeta-${bookingId}.pdf`),
            )
          }
          className={`${BTN} border border-border bg-surface text-ink-2 hover:bg-surface-muted hover:text-ink`}
        >
          <IconFileText />
          PDF
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run("xlsx", () =>
              downloadEstimate(fullEstimatePath(bookingId, "xlsx"), `smeta-${bookingId}.xlsx`),
            )
          }
          className={`${BTN} col-span-2 border border-border bg-surface text-ink-2 hover:bg-surface-muted hover:text-ink`}
        >
          <IconTable />
          Excel
        </button>
      </div>

      <p className="text-[11px] leading-snug text-ink-3">
        Оборудование, доборы и транспорт — тот же документ, что уходит заказчику.
      </p>
    </div>
  );
}
