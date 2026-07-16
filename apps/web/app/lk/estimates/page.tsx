"use client";
import { useEffect, useState } from "react";
import { lkApi } from "../../../src/lib/lkApi";
import type { LkEstimateListItem } from "../../../src/lib/lkTypes";
import { formatRub } from "../../../src/lib/format";

export default function LkEstimatesPage() {
  const [items, setItems] = useState<LkEstimateListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await lkApi.estimates();
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
  }, []);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await lkApi.estimates(cursor);
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
        <h1 className="text-2xl font-medium">Сметы</h1>
      </header>

      {loading ? (
        <p className="text-ink-2">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="text-ink-2">Подтверждённых смет пока нет.</p>
      ) : (
        <div className="bg-surface-muted border border-border rounded-lg divide-y divide-border">
          {items.map((e) => (
            <div key={e.bookingId} className="p-4 flex justify-between items-baseline gap-4">
              <div>
                <p className="font-medium">{e.projectName || e.bookingNo}</p>
                <p className="text-xs text-ink-2 mt-1">
                  {e.bookingNo} · {new Date(e.issuedAt).toLocaleDateString("ru-RU")}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="mono-num">{formatRub(Number(e.totalAfterDiscount))}</p>
                <a
                  href={e.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-accent-bright underline"
                >
                  Скачать PDF
                </a>
              </div>
            </div>
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
