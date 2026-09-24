"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkDebtResponse } from "../../../src/lib/lkTypes";
import { formatRub } from "../../../src/lib/format";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("ru-RU");

export default function LkDebtPage() {
  const [data, setData] = useState<LkDebtResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await lkApi.debt();
        if (!cancelled) setData(r);
      } catch {
        // lkApi redirects on 401
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return <p className="text-ink-2">Загрузка…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-medium">Долг</h1>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-surface-muted border border-border rounded-lg p-4">
          <p className="eyebrow">Общий долг</p>
          <p className="mono-num text-2xl mt-1">{formatRub(Number(data.totalOutstanding))}</p>
        </div>
        <div className="bg-surface-muted border border-border rounded-lg p-4">
          <p className="eyebrow">Просрочено</p>
          <p className={`mono-num text-2xl mt-1 ${data.overdueCount > 0 ? "text-rose" : ""}`}>
            {data.overdueCount}
          </p>
        </div>
      </section>

      {/* lk-debt-by-bookings: строки — брони с остатком (единый источник с админкой),
          счёт (если выставлен) — детализация строки */}
      <section className="bg-surface-muted border border-border rounded-lg overflow-hidden">
        {/* До sm — карточки: семь колонок в 340 px не помещаются, и суммы уходили
            за край. Вся карточка — ссылка на бронь, как в списке заказов. */}
        <ul className="sm:hidden divide-y divide-border">
          {data.bookings.length === 0 ? (
            <li className="px-4 py-6 text-center text-ink-2">Долгов нет 👍</li>
          ) : (
            data.bookings.map((r) => (
              <li key={r.bookingId} className={r.isOverdue ? "bg-rose-soft" : ""}>
                <Link href={`/lk/bookings/${r.bookingId}`} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{r.projectName || r.bookingNo}</p>
                    <p className="text-xs text-ink-2 mt-0.5">
                      {r.bookingNo} ·{" "}
                      <span className="whitespace-nowrap">
                        {fmtDate(r.startDate)} – {fmtDate(r.endDate)}
                      </span>
                    </p>
                    {r.invoice && (
                      <p className="text-xs text-ink-2 mono-num">
                        Счёт {r.invoice.number}
                        {r.invoice.dueDate ? ` · до ${fmtDate(r.invoice.dueDate)}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={`mono-num whitespace-nowrap ${Number(r.amountOutstanding) > 0 ? "text-rose" : ""}`}
                    >
                      {formatRub(Number(r.amountOutstanding))}
                    </p>
                    <p className="text-xs text-ink-2 whitespace-nowrap">из {formatRub(Number(r.finalAmount))}</p>
                  </div>
                </Link>
              </li>
            ))
          )}
        </ul>
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle border-b border-border text-left text-ink-2">
              <tr>
                <th className="px-4 py-2 font-medium whitespace-nowrap">Бронь</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap">Проект</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap hidden lg:table-cell">Даты</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap hidden lg:table-cell">Счёт</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap text-right">Сумма</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap text-right">Оплачено</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap text-right">Остаток</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.bookings.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-ink-2">
                    Долгов нет 👍
                  </td>
                </tr>
              ) : (
                data.bookings.map((r) => (
                  <tr key={r.bookingId} className={r.isOverdue ? "bg-rose-soft" : ""}>
                    {/* lk-debt-link: из строки долга можно открыть саму бронь */}
                    <td className="px-4 py-2">
                      <Link href={`/lk/bookings/${r.bookingId}`} className="text-accent hover:underline">
                        {r.bookingNo}
                      </Link>
                    </td>
                    {/* До lg колонки «Даты» и «Счёт» скрыты — даты уходят подписью под проект */}
                    <td className="px-4 py-2 min-w-[160px]">
                      {r.projectName || "—"}
                      <span className="block text-xs text-ink-2 whitespace-nowrap lg:hidden">
                        {fmtDate(r.startDate)} – {fmtDate(r.endDate)}
                      </span>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap hidden lg:table-cell">
                      {fmtDate(r.startDate)} – {fmtDate(r.endDate)}
                    </td>
                    <td className="px-4 py-2 hidden lg:table-cell">
                      {r.invoice ? (
                        <span className="mono-num">
                          {r.invoice.number}
                          {r.invoice.dueDate ? ` · до ${fmtDate(r.invoice.dueDate)}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 text-right mono-num whitespace-nowrap">{formatRub(Number(r.finalAmount))}</td>
                    <td className="px-4 py-2 text-right mono-num whitespace-nowrap">{formatRub(Number(r.amountPaid))}</td>
                    <td
                      className={`px-4 py-2 text-right mono-num whitespace-nowrap ${Number(r.amountOutstanding) > 0 ? "text-rose" : ""}`}
                    >
                      {formatRub(Number(r.amountOutstanding))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
