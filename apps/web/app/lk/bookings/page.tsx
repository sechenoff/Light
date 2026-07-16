"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { lkApi } from "../../../src/lib/lkApi";
import { LK_STATUS_LABEL, type LkBookingListItem, type LkBookingStatus } from "../../../src/lib/lkTypes";
import { formatRub } from "../../../src/lib/format";

// lk-bookings-filter-label-drift: фильтр «Активные» расходился с подписью статуса
// «В работе» для одного и того же ISSUED. Унифицируем на «В работе».
const FILTERS: { label: string; value: LkBookingStatus | "ALL" }[] = [
  { label: "Все", value: "ALL" },
  { label: "В работе", value: "ISSUED" },
  { label: "Подтверждённые", value: "CONFIRMED" },
  { label: "Возвращённые", value: "RETURNED" },
  { label: "Отменённые", value: "CANCELLED" },
];

// Используем общий словарь подписей (дубль удалён).
const STATUS_LABEL = LK_STATUS_LABEL;

function BookingsView() {
  const params = useSearchParams();
  const router = useRouter();
  const statusParam = params.get("status") as LkBookingStatus | null;
  const activeFilter: LkBookingStatus | "ALL" = statusParam ?? "ALL";

  const [items, setItems] = useState<LkBookingListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setCursor(null);
    setLoading(true);
    (async () => {
      try {
        const r = await lkApi.bookings(undefined, activeFilter === "ALL" ? undefined : activeFilter);
        if (cancelled) return;
        setItems(r.items);
        setCursor(r.nextCursor);
      } catch {
        // lkApi redirects on 401
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFilter]);

  function setFilter(value: LkBookingStatus | "ALL") {
    const sp = new URLSearchParams(params.toString());
    if (value === "ALL") {
      sp.delete("status");
    } else {
      sp.set("status", value);
    }
    const qs = sp.toString();
    router.replace(`/lk/bookings${qs ? `?${qs}` : ""}`);
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await lkApi.bookings(cursor, activeFilter === "ALL" ? undefined : activeFilter);
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.nextCursor);
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-medium">Заказы</h1>
      </header>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Фильтр заказов">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            aria-pressed={activeFilter === f.value}
            className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
              activeFilter === f.value
                ? "bg-accent-bright text-surface border-accent-bright"
                : "border-border text-ink-2 hover:bg-surface-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-ink-2">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="text-ink-2">Нет заказов в этой категории.</p>
      ) : (
        <div className="bg-surface-muted border border-border rounded-lg divide-y divide-border">
          {items.map((b) => (
            <Link key={b.id} href={`/lk/bookings/${b.id}`} className="block p-4 hover:bg-surface transition-colors">
              <div className="flex justify-between items-start flex-wrap gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{b.projectName || b.bookingNo}</p>
                  <p className="text-xs text-ink-2 mt-1">
                    {b.bookingNo} · {new Date(b.startDate).toLocaleDateString("ru-RU")}
                    {" — "}
                    {new Date(b.endDate).toLocaleDateString("ru-RU")}
                  </p>
                  <p className="text-xs text-ink-2">
                    {STATUS_LABEL[b.status]} · {b.itemCount} поз.
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="mono-num font-medium">{formatRub(Number(b.finalAmount))}</p>
                  {Number(b.amountOutstanding) > 0 && (
                    <p className="text-xs text-rose mt-1">долг {formatRub(Number(b.amountOutstanding))}</p>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {cursor && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="px-4 py-2 border border-border rounded-md hover:bg-surface-muted disabled:opacity-50 transition-colors"
        >
          {loadingMore ? "Загружаем…" : "Загрузить ещё"}
        </button>
      )}
    </div>
  );
}

export default function LkBookingsPage() {
  return (
    <Suspense fallback={<p className="text-ink-2">Загрузка…</p>}>
      <BookingsView />
    </Suspense>
  );
}
