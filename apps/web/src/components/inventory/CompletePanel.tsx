"use client";

/**
 * Правая карточка «Итога» (мокап, экран 2 `.fin`): что произойдёт при
 * завершении. Пока инвентаризация не завершена — в учёт ничего не записано;
 * «Завершить» заблокирована, пока есть расхождения без решения.
 * Непосчитанные позиции завершению не мешают — останутся «не сверены».
 */

import { useState } from "react";

import { toast } from "../ToastProvider";
import { pluralize } from "../../lib/format";
import { actPdfUrl, errorCode, explainInventoryError, inventoryApi } from "./api";
import { ProgressBar } from "./CategoryRail";
import { fmtDayMonth, fmtDayTime, positions, rubWhole, STATUS_LABEL } from "./format";
import { InventoryDialog } from "./InventoryDialog";
import type { CompleteResult, StockCountDetail } from "./types";
import { BTN_GHOST, BTN_PRIMARY, CARD, LINK } from "./ui";

/** Итог завершения одной фразой — для тоста. */
export function completeSummary(number: number, r: CompleteResult): string {
  const parts: string[] = [];
  if (r.lostPositions > 0) parts.push(`в потеряшки — ${positions(r.lostPositions)} · ${r.lostQty} шт`);
  if (r.adjustedPositions > 0) parts.push(`поправлен учёт — ${positions(r.adjustedPositions)}`);
  if (r.foundQty > 0) parts.push(`нашлось — ${r.foundQty} шт`);
  parts.push(`сверено — ${positions(r.verifiedPositions)}`);
  if (r.uncounted > 0) parts.push(`не посчитано — ${r.uncounted}`);
  return `Инвентаризация № ${number} завершена: ${parts.join(", ")}`;
}

function Effect({ tone, title, note }: { tone: "rose" | "slate" | "emerald" | "ink"; title: string; note: string }) {
  const dot = { rose: "bg-rose", slate: "bg-slate", emerald: "bg-emerald", ink: "bg-border-strong" }[tone];
  return (
    <li className="grid grid-cols-[10px_minmax(0,1fr)] gap-2 border-b border-dashed border-border py-1.5 text-xs leading-snug last:border-b-0">
      <span className={`mt-[5px] h-2 w-2 rounded-sm ${dot}`} aria-hidden="true" />
      <span>
        <b className="font-semibold text-ink">{title}</b>
        <small className="block text-[11px] text-ink-3">{note}</small>
      </span>
    </li>
  );
}

export function CompletePanel({
  detail,
  onCompleted,
  onStale,
}: {
  detail: StockCountDetail;
  onCompleted: (detail: StockCountDetail, result: CompleteResult) => void;
  /** Сервер не согласился (остались решения, уже закрыта) — перечитать. */
  onStale: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { totals, decisionsPlan: plan } = detail;

  const discrepancies = totals.shortagePositions + totals.surplusPositions;
  const decided = Math.max(0, discrepancies - totals.undecided);
  const uncounted = totals.lines - totals.counted;
  const blocked = totals.undecided > 0;
  const today = fmtDayMonth(new Date().toISOString());
  const money = Number(totals.shortageRatePerShift);

  const submit = async () => {
    setBusy(true);
    try {
      const { stockCount, result } = await inventoryApi.complete(detail.id);
      setConfirmOpen(false);
      toast.success(completeSummary(stockCount.number, result), { durationMs: 8000 });
      onCompleted(stockCount, result);
    } catch (e) {
      setConfirmOpen(false);
      toast.error(explainInventoryError(e, "Не удалось завершить инвентаризацию"));
      const code = errorCode(e);
      if (code === "UNDECIDED_LINES" || code === "STOCK_COUNT_NOT_OPEN") onStale();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className={`${CARD} xl:sticky xl:top-3.5`} aria-label="Что произойдёт">
      <div className="border-b border-border px-3.5 py-2.5">
        <h3 className="font-cond text-[15px] font-bold text-ink">Завершить инвентаризацию</h3>
        <p className="text-[11.5px] text-ink-2">пока не завершена — в учёт ничего не записано</p>
      </div>

      <div className="border-b border-border px-3.5 py-2.5">
        <div className="flex items-baseline justify-between text-xs text-ink-2">
          <span>решено расхождений</span>
          <span>
            <b className="mono-num text-[15px] text-ink">{decided}</b> из {discrepancies}
          </span>
        </div>
        <ProgressBar value={decided} total={discrepancies} tone="emerald" />
        {/* Кнопка — сразу под прогрессом, а не в подвале карточки: внизу правой колонки
            её закрывает глобальная плавающая «Сообщить» (1440×900 без прокрутки).
            Последствия всё равно повторяются в диалоге подтверждения. */}
        <div className="mt-2.5">
          <button
            type="button"
            disabled={blocked || busy}
            onClick={() => setConfirmOpen(true)}
            className={`${BTN_PRIMARY} w-full py-1.5`}
          >
            {blocked ? `Завершить — осталось решить ${totals.undecided}` : "Завершить инвентаризацию"}
          </button>
        </div>
      </div>

      <ul className="px-3.5 pb-2 pt-1">
        {plan.lostPositions > 0 && (
          <Effect
            tone="rose"
            title={`В потеряшки — ${positions(plan.lostPositions)} · ${plan.lostQty} шт`}
            note={`источник «инвентаризация № ${detail.number}», причина «не нашли на складе», со следом по броням`}
          />
        )}
        {plan.adjustPositions > 0 && (
          <Effect
            tone="slate"
            title={`Поправки учёта — ${positions(plan.adjustPositions)}`}
            note={`${[
              plan.adjustMinusQty > 0 ? `−${plan.adjustMinusQty} шт` : null,
              plan.adjustPlusQty > 0 ? `+${plan.adjustPlusQty} шт` : null,
            ]
              .filter(Boolean)
              .join(", ")} · каталог изменится, в журнале — кто и почему`}
          />
        )}
        {plan.foundPositions > 0 && (
          <Effect
            tone="emerald"
            title={`Нашлось — ${positions(plan.foundPositions)} · ${plan.foundQty} шт`}
            note="открытые потеряшки закроются как «найдено», позиция вернётся в оборот"
          />
        )}
        <Effect
          tone="ink"
          title={`${positions(totals.counted)} — «сверено ${today}»`}
          note={
            uncounted > 0
              ? `${uncounted} ${pluralize(uncounted, "непосчитанная останется", "непосчитанные останутся", "непосчитанных останутся")} без отметки`
              : "все позиции охвата посчитаны"
          }
        />
      </ul>

      {totals.shortagePositions > 0 && money > 0 && (
        <p className="mx-3.5 mb-2.5 rounded border border-rose-border bg-rose-soft px-2.5 py-1.5 text-xs leading-snug text-rose">
          Если все {totals.shortagePositions}{" "}
          {pluralize(totals.shortagePositions, "недостачу", "недостачи", "недостач")} признать пропажей — из оборота
          выпадает <b className="font-bold">≈ {rubWhole(money)} ₽ за смену</b>
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-border bg-surface-muted px-3.5 py-2.5">
        <p className="text-[11px] leading-snug text-ink-2">
          Всё запишется одной операцией: <b className="text-ink">потеряшки, поправки учёта и акт</b>. До этого можно
          пересчитать любую строку.
        </p>
        <a href={actPdfUrl(detail.id)} target="_blank" rel="noopener noreferrer" className={`${LINK} text-center`}>
          Скачать акт-черновик (PDF)
        </a>
      </div>

      <InventoryDialog
        open={confirmOpen}
        eyebrow={`Инвентаризация № ${detail.number}`}
        title="Завершить и записать в учёт?"
        busy={busy}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmOpen(false)} disabled={busy} className={BTN_GHOST}>
              Отмена
            </button>
            <button type="button" onClick={() => void submit()} disabled={busy} className={BTN_PRIMARY}>
              {busy ? "Записываю…" : "Завершить"}
            </button>
          </>
        }
      >
        <p>Решения применятся одной операцией, отменить её нельзя:</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          {plan.lostPositions > 0 && <li>в потеряшки — {positions(plan.lostPositions)} · {plan.lostQty} шт</li>}
          {plan.adjustPositions > 0 && <li>поправки учёта — {positions(plan.adjustPositions)}</li>}
          {plan.foundPositions > 0 && <li>нашлось — {plan.foundQty} шт</li>}
          <li>отметка «сверено» — {positions(totals.counted)}</li>
        </ul>
        {uncounted > 0 && (
          <p className="mt-2 text-amber">
            {uncounted} {pluralize(uncounted, "позиция не посчитана", "позиции не посчитаны", "позиций не посчитаны")} —
            останутся «не сверены».
          </p>
        )}
      </InventoryDialog>
    </aside>
  );
}

/** Карточка вместо «Завершить» у завершённой / отменённой инвентаризации. */
export function ClosedPanel({ detail }: { detail: StockCountDetail }) {
  const closed = detail.status === "CLOSED";
  return (
    <aside className={`${CARD} xl:sticky xl:top-3.5`} aria-label="Итог инвентаризации">
      <div className="border-b border-border px-3.5 py-2.5">
        <h3 className="font-cond text-[15px] font-bold text-ink">Инвентаризация {STATUS_LABEL[detail.status]}</h3>
        <p className="text-[11.5px] text-ink-2">
          {closed
            ? `${fmtDayTime(detail.closedAt)}${detail.closedByName ? ` · ${detail.closedByName}` : ""}`
            : `${fmtDayTime(detail.cancelledAt)} · в учёт ничего не записано`}
        </p>
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3.5 py-2.5 text-xs text-ink-2">
        <dt>посчитано</dt>
        <dd className="mono-num text-right text-ink">
          {detail.totals.counted} из {detail.totals.lines}
        </dd>
        <dt>сошлось</dt>
        <dd className="mono-num text-right text-emerald">{detail.totals.matched}</dd>
        <dt>недостача</dt>
        <dd className="mono-num text-right text-rose">
          {detail.totals.shortagePositions} поз · {detail.totals.shortageQty} шт
        </dd>
        <dt>излишек</dt>
        <dd className="mono-num text-right text-emerald">
          {detail.totals.surplusPositions} поз · {detail.totals.surplusQty} шт
        </dd>
      </dl>
      <div className="flex flex-wrap gap-3 border-t border-border bg-surface-muted px-3.5 py-2.5">
        <a href={actPdfUrl(detail.id)} target="_blank" rel="noopener noreferrer" className={LINK}>
          Акт № {detail.number} (PDF)
        </a>
      </div>
    </aside>
  );
}
