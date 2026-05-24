import type { LkStatsResponse } from "../../lib/lkTypes";
import { pluralize } from "../../lib/format";

export function TypicalKitGrid({
  items,
  sampleSize,
}: {
  items: LkStatsResponse["typicalKit"];
  sampleSize: number;
}) {
  if (sampleSize < 3) {
    return (
      <p className="text-ink-2">
        «Типовой набор» появится после нескольких заказов — пока в выборке{" "}
        {sampleSize} {pluralize(sampleSize, "бронь", "брони", "броней")}.
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-ink-2">
        Пока нет позиций, которые встречаются достаточно часто.
      </p>
    );
  }

  const byCat = new Map<string, LkStatsResponse["typicalKit"]>();
  for (const it of items) {
    const arr = byCat.get(it.category) ?? [];
    arr.push(it);
    byCat.set(it.category, arr);
  }

  return (
    <div className="space-y-4">
      {[...byCat.entries()].map(([cat, list]) => (
        <div key={cat}>
          <p className="eyebrow mb-2">{cat}</p>
          <div className="flex flex-wrap gap-2">
            {list.map((it) => (
              <span
                key={it.equipmentId}
                className="px-3 py-1.5 text-sm rounded-md bg-accent-soft text-accent border border-accent-border"
                title={`${Math.round(it.frequency * 100)}% последних броней`}
              >
                {it.name}{" "}
                <span className="opacity-70">· {Math.round(it.frequency * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-ink-3">
        Выборка: {sampleSize} последних {pluralize(sampleSize, "заказ", "заказа", "заказов")}.
      </p>
    </div>
  );
}
