"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useLkSession } from "../../src/hooks/useLkSession";
import { lkApi } from "../../src/lib/lkApi";
import { LK_STATUS_LABEL, type LkBookingListItem } from "../../src/lib/lkTypes";
import { formatRub } from "../../src/lib/format";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "доброй ночи";
  if (h < 12) return "доброе утро";
  if (h < 18) return "добрый день";
  return "добрый вечер";
}

/**
 * Число активных (ISSUED) броней — из totalCount ответа /api/lk/bookings,
 * а не из длины страницы. lkApi.bookings() типизирован без totalCount
 * (общий тип списка), поэтому здесь отдельный узкий запрос.
 */
async function fetchIssuedCount(): Promise<number> {
  const res = await fetch("/api/lk/bookings?status=ISSUED", {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { totalCount?: number; items?: unknown[] };
  return body.totalCount ?? body.items?.length ?? 0;
}

export default function LkDashboardPage() {
  const { me } = useLkSession();
  const [recent, setRecent] = useState<LkBookingListItem[] | null>(null);
  const [debtTotal, setDebtTotal] = useState<string | null>(null);
  const [overdueCount, setOverdueCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // lk-active-count: число активных раньше считалось из первой страницы
        // общего списка (≤20) — занижалось. Запрашиваем ISSUED отдельным фильтром
        // и берём totalCount из ответа (полное число по фильтру, а не размер
        // страницы) — иначе счётчик снова упирался бы в limit при >20 бронях.
        const [b, active, d] = await Promise.all([
          lkApi.bookings(),
          fetchIssuedCount(),
          lkApi.debt(),
        ]);
        if (cancelled) return;
        setRecent(b.items.slice(0, 5));
        setActiveCount(active);
        setDebtTotal(d.totalOutstanding);
        setOverdueCount(d.overdueCount);
      } catch {
        // useLkSession redirects if 401
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">{me ? `${greeting()},` : ""}</p>
        <h1 className="text-2xl font-medium">{me ? `${me.client.name} 👋` : "Личный кабинет"}</h1>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link
          href="/lk/debt"
          className="bg-surface-2 border border-border rounded-lg p-4 hover:border-border-bright"
        >
          <p className="eyebrow">Долг</p>
          <p className="mono-num text-2xl mt-1">{debtTotal !== null ? formatRub(Number(debtTotal)) : "—"}</p>
          {overdueCount > 0 && <p className="text-sm text-rose mt-1">{overdueCount} просрочено</p>}
        </Link>
        <Link
          href="/lk/bookings?status=ISSUED"
          className="bg-surface-2 border border-border rounded-lg p-4 hover:border-border-bright"
        >
          <p className="eyebrow">Активные брони</p>
          <p className="mono-num text-2xl mt-1">{activeCount}</p>
        </Link>
        <Link
          href="/lk/stats"
          className="bg-surface-2 border border-border rounded-lg p-4 hover:border-border-bright"
        >
          <p className="eyebrow">Статистика</p>
          <p className="text-sm text-ink-2 mt-1">Топ оборудования + твой типовой набор</p>
        </Link>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Последние заказы</h2>
        {!recent ? (
          <p className="text-ink-2">Загрузка…</p>
        ) : recent.length === 0 ? (
          <p className="text-ink-2">Заказов пока нет.</p>
        ) : (
          <ul className="divide-y divide-border bg-surface-2 border border-border rounded-lg">
            {recent.map((b) => (
              <li key={b.id}>
                <Link href={`/lk/bookings/${b.id}`} className="block p-3 hover:bg-surface">
                  <div className="flex justify-between items-baseline">
                    <span className="font-medium">{b.projectName || b.bookingNo}</span>
                    <span className="mono-num text-sm">{formatRub(Number(b.finalAmount))}</span>
                  </div>
                  <p className="text-xs text-ink-2 mt-1">
                    {new Date(b.startDate).toLocaleDateString("ru-RU")} · {LK_STATUS_LABEL[b.status]} · {b.itemCount} поз.
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
