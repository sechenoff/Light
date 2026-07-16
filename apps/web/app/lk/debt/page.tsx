"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkDebtResponse } from "../../../src/lib/lkTypes";
import { formatRub } from "../../../src/lib/format";

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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-ink-2">
              <tr>
                <th className="px-4 py-2">Бронь</th>
                <th className="px-4 py-2">Проект</th>
                <th className="px-4 py-2">Даты</th>
                <th className="px-4 py-2">Счёт</th>
                <th className="px-4 py-2 text-right">Сумма</th>
                <th className="px-4 py-2 text-right">Оплачено</th>
                <th className="px-4 py-2 text-right">Остаток</th>
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
                    <td className="px-4 py-2">{r.projectName || "—"}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {new Date(r.startDate).toLocaleDateString("ru-RU")} –{" "}
                      {new Date(r.endDate).toLocaleDateString("ru-RU")}
                    </td>
                    <td className="px-4 py-2">
                      {r.invoice ? (
                        <span className="mono-num">
                          {r.invoice.number}
                          {r.invoice.dueDate
                            ? ` · до ${new Date(r.invoice.dueDate).toLocaleDateString("ru-RU")}`
                            : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 text-right mono-num">{formatRub(Number(r.finalAmount))}</td>
                    <td className="px-4 py-2 text-right mono-num">{formatRub(Number(r.amountPaid))}</td>
                    <td
                      className={`px-4 py-2 text-right mono-num ${Number(r.amountOutstanding) > 0 ? "text-rose" : ""}`}
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
