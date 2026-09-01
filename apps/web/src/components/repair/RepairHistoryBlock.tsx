"use client";

/**
 * «Раньше чинили» — история ремонтов этой же позиции за 12 месяцев.
 *
 * Блок отвечает на вопрос, которого в системе не было вообще: чинить дальше
 * или списывать. Итог выводится в СМЕНАХ АРЕНДЫ, а не в процентах от
 * стоимости прибора: закупочных цен в базе нет, и выводить их из ставки
 * аренды нельзя — получилось бы уверенное враньё.
 *
 * Суммы видит только руководитель: у техника денег на экране нет нигде.
 */

import { formatRub, pluralize } from "../../lib/format";
import { RepairIcon } from "./RepairRiskBadge";
import { formatDayMonth } from "./types";

export interface RepairHistoryItem {
  id: string;
  /** ISO. */
  closedAt: string | null;
  reason: string;
  outcome: "CLOSED" | "WROTE_OFF";
  /** Decimal-строка: запчасти карточки + связанные расходы. */
  cost: string;
}

export interface RepairHistory {
  count: number;
  totalCost: string;
  /** «5.3» — во сколько смен аренды обошлись прошлые ремонты. null = ставки нет. */
  shiftsEquivalent: string | null;
  /** Считая текущий ремонт, позицию чинят третий раз и больше. */
  repeated: boolean;
  items: RepairHistoryItem[];
}

/** «5.3» → «5,3»: в русском тексте точка в дробях читается как обрыв строки. */
function ru(n: string): string {
  return n.replace(".", ",");
}

export function RepairHistoryBlock({
  history,
  currentReason,
  currentCost,
  showMoney,
}: {
  history: RepairHistory;
  /** Текущая поломка дописывается последней строкой — чтобы был виден весь ряд. */
  currentReason: string;
  currentCost: string;
  /** Деньги — только руководителю. */
  showMoney: boolean;
}) {
  const cols = showMoney
    ? "grid-cols-[62px_minmax(0,1fr)_84px]"
    : "grid-cols-[62px_minmax(0,1fr)]";

  // Считая текущий ремонт: «чиним третий раз» должно быть видно на третьем
  // заходе, а не на четвёртом. `history.count` — только прошлые, поэтому +1.
  const totalTimes = history.count + 1;

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
      <div className="border-b border-border px-3.5 py-2.5 last:border-b-0">
        <div className="mb-2 flex items-center gap-1.5">
          <span className="eyebrow inline-flex items-center gap-1.5">
            <RepairIcon name="hist" />
            {history.count === 0
              ? "Эту позицию чиним впервые за год"
              : `Раньше чинили: ${history.count} ${pluralize(history.count, "раз", "раза", "раз")}`}
          </span>
        </div>

        <div className="flex flex-col">
          {history.items.map((it) => (
            <div
              key={it.id}
              className={`grid ${cols} items-baseline gap-2 border-b border-dashed border-border py-1 text-xs last:border-b-0`}
            >
              <span className="mono-num text-[11.5px] text-ink-2">
                {formatDayMonth(it.closedAt)}
              </span>
              <span className="min-w-0">
                {it.reason}
                {it.outcome === "WROTE_OFF" && (
                  <span className="ml-1.5 whitespace-nowrap rounded border border-border bg-surface px-1.5 text-[10px] font-semibold uppercase leading-[1.7] tracking-wide text-ink-3">
                    списана
                  </span>
                )}
              </span>
              {showMoney && (
                <span className="mono-num text-right font-semibold">{formatRub(it.cost)}</span>
              )}
            </div>
          ))}

          {/* Текущая поломка — тем же рядом, приглушённо: она ещё не история. */}
          <div
            className={`grid ${cols} items-baseline gap-2 border-t border-border py-1 text-xs ${
              history.items.length === 0 ? "border-t-0" : ""
            }`}
          >
            <span className="mono-num text-[11.5px] text-ink-3">сейчас</span>
            <span className="min-w-0 text-ink-2">{currentReason}</span>
            {showMoney && (
              <span className="mono-num text-right text-ink-2">{formatRub(currentCost)}</span>
            )}
          </div>
        </div>

        {history.repeated && (
          <p className="mt-2 rounded border border-amber-border bg-amber-soft px-2.5 py-1.5 text-xs leading-[1.45] text-amber">
            <b className="font-bold">
              {showMoney && history.count > 0 ? (
                <>
                  За 12 месяцев {history.count}{" "}
                  {pluralize(history.count, "прошлый ремонт", "прошлых ремонта", "прошлых ремонтов")}{" "}
                  на <span className="mono-num">{formatRub(history.totalCost)}</span>
                  {history.shiftsEquivalent
                    ? ` — это ${ru(history.shiftsEquivalent)} ${pluralize(
                        Math.round(Number(history.shiftsEquivalent)),
                        "смена",
                        "смены",
                        "смен",
                      )} аренды этой позиции.`
                    : "."}
                </>
              ) : (
                <>
                  За 12 месяцев позицию чинят {totalTimes}-й раз.
                </>
              )}
            </b>{" "}
            Одно и то же ломается снова — пора решать: чинить дальше или списывать.
          </p>
        )}

        {showMoney && history.count > 0 && !history.repeated && (
          <p className="mt-2 text-[11px] leading-[1.45] text-ink-3">
            Прошлые ремонты: <span className="mono-num">{formatRub(history.totalCost)}</span>
            {history.shiftsEquivalent
              ? ` — ${ru(history.shiftsEquivalent)} ${pluralize(
                  Math.round(Number(history.shiftsEquivalent)),
                  "смена",
                  "смены",
                  "смен",
                )} аренды.`
              : "."}
          </p>
        )}

        {showMoney && history.count > 0 && history.shiftsEquivalent === null && (
          <p className="mt-1 text-[11px] leading-[1.45] text-ink-3">
            Ставка аренды у позиции не задана, поэтому в сменах не пересчитываем — выдуманный
            коэффициент хуже пробела.
          </p>
        )}
      </div>
    </section>
  );
}
