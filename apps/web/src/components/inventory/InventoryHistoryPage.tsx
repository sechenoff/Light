"use client";

/**
 * /warehouse/inventory/history — все инвентаризации, новые сверху: №, даты,
 * статус, кто, ключевые итоги и акт. Таблица на десктопе, карточки на
 * телефоне.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { StatusPill } from "../StatusPill";
import { useRequireRole } from "../../hooks/useRequireRole";
import { WarehouseSubnav } from "../warehouse/WarehouseSubnav";
import { actPdfUrl, actXlsxUrl, explainInventoryError, inventoryApi } from "./api";
import { fmtDate, fmtTime, scopeLabel, STATUS_LABEL, STATUS_VARIANT } from "./format";
import { PageHead } from "./InventoryHeader";
import type { StockCountSummary } from "./types";
import { BTN_PRIMARY, CARD, FOCUS, LINK } from "./ui";

function finishedAt(sc: StockCountSummary): string {
  if (sc.status === "CLOSED") return `${fmtDate(sc.closedAt)} ${fmtTime(sc.closedAt)}`;
  if (sc.status === "CANCELLED") return `${fmtDate(sc.cancelledAt)} ${fmtTime(sc.cancelledAt)}`;
  return "идёт";
}

function people(sc: StockCountSummary): string {
  const parts = [`начал ${sc.createdByName}`];
  if (sc.counters.length > 0) parts.push(`считали ${sc.counters.join(", ")}`);
  if (sc.closedByName) parts.push(`завершил ${sc.closedByName}`);
  return parts.join(" · ");
}

/** Итоги переносятся только между сегментами: «сошлось 0» не рвётся по строкам,
 * а разделитель «·» уходит на новую строку вместе со своим сегментом. */
function Totals({ sc }: { sc: StockCountSummary }) {
  const t = sc.totals;
  return (
    <span className="mono-num text-xs text-ink-2">
      <span className="whitespace-nowrap">
        {t.counted} из {t.lines}
      </span>{" "}
      <span className="whitespace-nowrap text-emerald">
        <span className="text-ink-3">· </span>сошлось {t.matched}
      </span>
      {t.shortagePositions > 0 && (
        <>
          {" "}
          <span className="whitespace-nowrap text-rose">
            <span className="text-ink-3">· </span>−{t.shortageQty} шт ({t.shortagePositions} поз)
          </span>
        </>
      )}
      {t.surplusPositions > 0 && (
        <>
          {" "}
          <span className="whitespace-nowrap text-emerald">
            <span className="text-ink-3">· </span>+{t.surplusQty} шт ({t.surplusPositions} поз)
          </span>
        </>
      )}
    </span>
  );
}

function ActLinks({ sc }: { sc: StockCountSummary }) {
  return (
    <span className="flex gap-3 whitespace-nowrap">
      <a href={actPdfUrl(sc.id)} target="_blank" rel="noopener noreferrer" className={LINK}>
        Акт (PDF)
      </a>
      <a href={actXlsxUrl(sc.id)} download className={LINK}>
        XLSX
      </a>
    </span>
  );
}

export function InventoryHistoryPage() {
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN", "WAREHOUSE"]);
  const [items, setItems] = useState<StockCountSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { items: data } = await inventoryApi.list();
      setItems(data);
    } catch (e) {
      setError(explainInventoryError(e, "Не удалось загрузить историю инвентаризаций"));
    }
  }, []);

  useEffect(() => {
    if (authorized) void load();
  }, [authorized, load]);

  if (authLoading) return <p className="p-6 text-sm text-ink-3">Проверка доступа…</p>;
  if (!authorized) return null;

  const open = items?.find((i) => i.status === "OPEN");

  return (
    <div className="mx-auto w-full max-w-[1240px] p-4 lg:p-6">
      <PageHead title="История инвентаризаций" sub="все пересчёты склада — с итогами и актами" />
      <div className="mt-3">
        <WarehouseSubnav active="history" badges={open ? { inventory: `№ ${open.number} · идёт` } : undefined} />
      </div>

      {error && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-sm text-rose">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className={`rounded-sm text-xs font-semibold underline ${FOCUS}`}>
            Повторить
          </button>
        </div>
      )}

      {items == null && !error ? (
        <div aria-busy="true" aria-label="Загрузка истории" className={`${CARD} mt-4`}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-4 last:border-b-0">
              <span className="h-4 w-16 animate-pulse rounded bg-surface-subtle" />
              <span className="h-4 flex-1 animate-pulse rounded bg-surface-subtle" />
            </div>
          ))}
        </div>
      ) : items && items.length === 0 ? (
        <div className={`${CARD} mt-4 px-4 py-10 text-center`}>
          <p className="text-sm font-medium text-ink-2">Инвентаризаций ещё не было</p>
          <p className="mt-1 text-[13px] text-ink-3">Первая пересчитает склад и покажет, что пропало и как</p>
          <Link href="/warehouse/inventory" className={`${BTN_PRIMARY} mt-4`}>
            Начать инвентаризацию
          </Link>
        </div>
      ) : (
        items && (
          <>
            <div className={`${CARD} mt-4 hidden md:block`}>
              <table className="w-full text-left">
                <thead className="border-b border-border bg-surface-muted">
                  <tr>
                    {["№", "Начата", "Завершена", "Статус", "Охват и люди", "Итоги", "Акт"].map((h) => (
                      <th key={h} scope="col" className="eyebrow whitespace-nowrap px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((sc) => (
                    <tr key={sc.id} className="border-b border-border align-top last:border-b-0 hover:bg-surface-muted">
                      <td className="px-3 py-2.5">
                        <Link href={`/warehouse/inventory/${sc.id}`} className={`${LINK} text-[13px]`}>
                          № {sc.number}
                        </Link>
                      </td>
                      <td className="mono-num whitespace-nowrap px-3 py-2.5 text-xs text-ink-2">
                        {fmtDate(sc.startedAt)} {fmtTime(sc.startedAt)}
                      </td>
                      <td className="mono-num whitespace-nowrap px-3 py-2.5 text-xs text-ink-2">{finishedAt(sc)}</td>
                      <td className="px-3 py-2.5">
                        <StatusPill variant={STATUS_VARIANT[sc.status]} label={STATUS_LABEL[sc.status]} />
                      </td>
                      <td className="px-3 py-2.5 text-xs text-ink-2">
                        <span className="block text-ink">{scopeLabel(sc.categories)}</span>
                        <span className="block text-ink-3">{people(sc)}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Totals sc={sc} />
                      </td>
                      <td className="px-3 py-2.5">
                        <ActLinks sc={sc} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="mt-4 space-y-2.5 md:hidden">
              {items.map((sc) => (
                <li key={sc.id} className={`${CARD} space-y-1.5 px-3.5 py-3`}>
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/warehouse/inventory/${sc.id}`} className={`${LINK} text-sm`}>
                      Инвентаризация № {sc.number}
                    </Link>
                    <StatusPill variant={STATUS_VARIANT[sc.status]} label={STATUS_LABEL[sc.status]} />
                  </div>
                  <p className="mono-num text-xs text-ink-2">
                    {fmtDate(sc.startedAt)} {fmtTime(sc.startedAt)} → {finishedAt(sc)}
                  </p>
                  <p className="text-xs text-ink-2">
                    {scopeLabel(sc.categories)} · <span className="text-ink-3">{people(sc)}</span>
                  </p>
                  <Totals sc={sc} />
                  <ActLinks sc={sc} />
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </div>
  );
}
